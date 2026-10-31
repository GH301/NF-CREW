"use strict";

// Browser control panel (PR-4): ONE http server, one binding per player account.
//
//   GET  /                 the page
//   GET  /api/whoami       {"ok":true,"accountID":69}
//   POST /api/login        {"token":"…"} -> {"ok":true,"accountID":69}
//   GET  /api/status       this account's crews
//   GET  /api/stream       SSE, one frame every 2 s, this account only
//   POST /api/cmd          {"text":"mine all"}
//
// Identity comes from a token: `x-cm-token` header, `?token=` query, or the
// `cmToken` cookie. No matching token => 401. The single exception is the legacy
// binding (a runtime built without a tenant), which keeps working token-free from
// loopback so EVEJS_CM_TENANT_MODE=0 behaves exactly like the old panel.

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const HOST = "127.0.0.1";
const PORT = 8741;
const PAGE = path.join(__dirname, "..", "web", "index.html");
// 面板拆成 html/css/js 三个文件：这两个是静态资源，和 index.html 一样在鉴权之前取。
const ASSETS = new Map([
  ["/panel.css", {file: path.join(__dirname, "..", "web", "panel.css"), type: "text/css; charset=utf-8"}],
  ["/app.js", {file: path.join(__dirname, "..", "web", "app.js"), type: "application/javascript; charset=utf-8"}],
]);
// 日志清理：与 loader 用的是同一份实现。
const logRetention = require(path.join(__dirname, "nfCrewMiningLogRetention.js"));
const MAX_BODY = 8192;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 240;

const bindings = new Map();
let server = null;
let actualPort = PORT;
let lastLog = () => {};
const rate = new Map();
let readyPromise = Promise.resolve();
let markReady = null;

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (!a.length || a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function send(res, code, type, body) {
  res.writeHead(code, {"Content-Type": type, "Cache-Control": "no-store"});
  res.end(body);
}

function json(res, code, value) {
  return send(res, code, "application/json; charset=utf-8", JSON.stringify(value));
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error("BODY_TOO_LARGE"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function parseBody(body) {
  try {
    const value = JSON.parse(body || "{}");
    return value && typeof value === "object" ? value : {};
  } catch (_error) {
    return null;
  }
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) {
    return true; // same-origin navigation, or a non-browser client
  }
  try {
    const host = new URL(String(origin)).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch (_error) {
    return false;
  }
}

function tokenOf(req, url) {
  const header = req.headers["x-cm-token"];
  if (header) {
    return String(header);
  }
  const query = url.searchParams.get("token");
  if (query) {
    return String(query);
  }
  const cookie = req.headers.cookie;
  if (cookie) {
    for (const part of String(cookie).split(";")) {
      const [name, ...rest] = part.split("=");
      if (name && name.trim() === "cmToken") {
        return decodeURIComponent(rest.join("=").trim());
      }
    }
  }
  return "";
}

function bindingByToken(token) {
  const wanted = String(token || "");
  if (!wanted) {
    return null;
  }
  for (const binding of bindings.values()) {
    if (binding.token && safeEqual(binding.token, wanted)) {
      return binding;
    }
  }
  return null;
}

function isLoopback(req) {
  const remote = req.socket && req.socket.remoteAddress;
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

function authenticate(req, url) {
  const token = tokenOf(req, url);
  if (token) {
    // A presented token must be valid: never downgrade to the legacy binding.
    return bindingByToken(token);
  }
  const legacy = bindings.get("default");
  if (legacy && isLoopback(req)) {
    return legacy;
  }
  return null;
}

function rateLimited(binding, req) {
  const key = `${binding.key}:${(req.socket && req.socket.remoteAddress) || "?"}`;
  const now = Date.now();
  const entry = rate.get(key);
  if (!entry || now > entry.resetAt) {
    rate.set(key, {count: 1, resetAt: now + RATE_WINDOW_MS});
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_MAX;
}

function crewLogTail(file, offset) {
  let size = 0;
  let text = "";
  if (!file || !fs.existsSync(file)) {
    return {offset: 0, text};
  }
  size = fs.statSync(file).size;
  const startAt = offset > 0 && offset <= size ? offset : Math.max(0, size - 64 * 1024);
  const length = size - startAt;
  if (length > 0) {
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, startAt);
      text = buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  }
  return {offset: size, text};
}

async function handle(req, res) {
  let url;
  try {
    url = new URL(req.url, `http://${HOST}:${actualPort}`);
  } catch (_error) {
    return json(res, 400, {ok: false, error: "bad url"});
  }
  try {
    if (!originAllowed(req)) {
      return json(res, 403, {ok: false, error: "BAD_ORIGIN"});
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = fs.existsSync(PAGE) ? fs.readFileSync(PAGE) : "<h1>nf-crew: web/index.html missing</h1>";
      return send(res, 200, "text/html; charset=utf-8", html);
    }
    const asset = ASSETS.get(url.pathname);
    if (req.method === "GET" && asset) {
      const body = fs.existsSync(asset.file)
        ? fs.readFileSync(asset.file)
        : `/* nf-crew: ${path.basename(asset.file)} missing */`;
      return send(res, 200, asset.type, body);
    }
    if (req.method === "POST" && url.pathname === "/api/login") {
      const payload = parseBody(await readBody(req, 1024));
      if (!payload) {
        return json(res, 400, {ok: false, error: "bad json"});
      }
      const binding = bindingByToken(payload.token);
      if (!binding) {
        return json(res, 401, {ok: false, error: "BAD_TOKEN"});
      }
      return json(res, 200, {ok: true, accountID: binding.accountID});
    }

    const binding = authenticate(req, url);
    if (!binding) {
      return json(res, 401, {ok: false, error: "UNAUTHORIZED"});
    }
    if (rateLimited(binding, req)) {
      return json(res, 429, {ok: false, error: "TOO_MANY_REQUESTS"});
    }
    const cb = binding.callbacks;

    if (req.method === "GET" && url.pathname === "/api/whoami") {
      return json(res, 200, {ok: true, accountID: binding.accountID, legacy: binding.legacy === true});
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      return json(res, 200, cb.getStatus());
    }
    if (req.method === "GET" && url.pathname === "/api/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      const push = () => {
        try {
          res.write(`data: ${JSON.stringify(cb.getStatus())}\n\n`);
        } catch (_error) {
          /* client went away */
        }
      };
      push();
      const timer = setInterval(push, 2000);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
      req.on("close", () => clearInterval(timer));
      return undefined;
    }
    if (req.method === "POST" && url.pathname === "/api/mode") {
      const payload = parseBody(await readBody(req, 4096));
      if (!payload) {
        return json(res, 400, {ok: false, error: "bad json"});
      }
      if (typeof cb.setMode !== "function") {
        return json(res, 501, {ok: false, error: "MODE_NOT_WIRED"});
      }
      try {
        return json(res, 200, cb.setMode(payload));
      } catch (error) {
        return json(res, 500, {ok: false, error: error && error.message});
      }
    }
    if (req.method === "POST" && url.pathname === "/api/special") {
      // PLAN §18.4: {characterID, module: "bastion"|"siege"|"doomsday"|"all", on}
      const payload = parseBody(await readBody(req, 4096));
      if (!payload) {
        return json(res, 400, {ok: false, error: "bad json"});
      }
      if (typeof cb.setSpecial !== "function") {
        return json(res, 501, {ok: false, error: "SPECIAL_NOT_WIRED"});
      }
      try {
        return json(res, 200, cb.setSpecial(payload));
      } catch (error) {
        return json(res, 500, {ok: false, error: error && error.message});
      }
    }
    if (req.method === "POST" && url.pathname === "/api/debug") {
      const payload = parseBody(await readBody(req, 1024));
      if (!payload) {
        return json(res, 400, {ok: false, error: "bad json"});
      }
      const on = payload.on === true || payload.on === "true";
      if (typeof cb.setDebug !== "function") {
        return json(res, 501, {ok: false, error: "DEBUG_NOT_WIRED"});
      }
      try {
        return json(res, 200, {ok: true, debug: cb.setDebug(on)});
      } catch (error) {
        return json(res, 500, {ok: false, error: error && error.message});
      }
    }
    if (req.method === "GET" && url.pathname === "/api/crew") {
      const characterID = Number(url.searchParams.get("characterID")) || 0;
      if (!characterID) {
        return json(res, 400, {ok: false, problems: ["NO_CHARACTER_ID"]});
      }
      if (typeof cb.crewDetail !== "function") {
        return json(res, 501, {ok: false, problems: ["DETAIL_NOT_WIRED"]});
      }
      try {
        return json(res, 200, cb.crewDetail(characterID));
      } catch (error) {
        return json(res, 500, {ok: false, problems: [String(error && error.message)]});
      }
    }
    // 清理超过 N 天的日志（默认 3 天，可用 ?days= 覆盖）。
    if (req.method === "POST" && url.pathname === "/api/log/prune") {
      const days = Math.max(1, Number(url.searchParams.get("days")) || 3);
      try {
        const file = String(cb.crewLogFile || "");
        const dir = path.dirname(file);
        const result = logRetention.pruneByAge({dir, file, retentionDays: days});
        return json(res, 200, {ok: true, days, removedLines: result.removedLines, deletedFiles: result.deletedFiles});
      } catch (error) {
        return json(res, 500, {ok: false, error: error && error.message});
      }
    }
    // 清空所有日志：内容清零 + 删掉轮转文件。
    if (req.method === "POST" && url.pathname === "/api/log/clear") {
      try {
        const file = String(cb.crewLogFile || "");
        const dir = path.dirname(file);
        let deletedFiles = 0;
        let clearedBytes = 0;
        if (file && fs.existsSync(file)) {
          clearedBytes = fs.statSync(file).size;
          fs.writeFileSync(file, "", "utf8");
        }
        for (const entry of logRetention.listRotated(dir, path.basename(file))) {
          try {
            fs.unlinkSync(entry.full);
            deletedFiles += 1;
          } catch (_error) {
            /* best effort */
          }
        }
        return json(res, 200, {ok: true, clearedBytes, deletedFiles});
      } catch (error) {
        return json(res, 500, {ok: false, error: error && error.message});
      }
    }
    // 删除一个蓝图（configs/*.json）。
    // 追击开关 / 返回环绕：{on:true|false} 或 {action:"return"}。
    if (req.method === "POST" && url.pathname === "/api/chase") {
      const payload = parseBody(await readBody(req, 4096)) || {};
      if (String(payload.action || "") === "return") {
        if (typeof cb.returnOrbit !== "function") {
          return json(res, 501, {ok: false, error: "RETURN_ORBIT_NOT_WIRED"});
        }
        try {
          return json(res, 200, cb.returnOrbit());
        } catch (error) {
          return json(res, 500, {ok: false, error: error && error.message});
        }
      }
      if (typeof cb.setChase !== "function") {
        return json(res, 501, {ok: false, error: "CHASE_NOT_WIRED"});
      }
      try {
        return json(res, 200, cb.setChase(payload.on === true));
      } catch (error) {
        return json(res, 500, {ok: false, error: error && error.message});
      }
    }
    if (req.method === "POST" && url.pathname === "/api/config/delete") {
      const payload = parseBody(await readBody(req, 4096));
      if (!payload) {
        return json(res, 400, {ok: false, error: "bad json"});
      }
      if (typeof cb.deletePreset !== "function") {
        return json(res, 501, {ok: false, error: "CONFIG_DELETE_NOT_WIRED"});
      }
      try {
        return json(res, 200, cb.deletePreset(payload));
      } catch (error) {
        return json(res, 500, {ok: false, error: error && error.message});
      }
    }
    if (req.method === "GET" && url.pathname === "/api/log") {
      const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
      try {
        return json(res, 200, crewLogTail(cb.crewLogFile, offset));
      } catch (error) {
        return json(res, 500, {ok: false, error: error && error.message});
      }
    }
    if (req.method === "GET" && url.pathname === "/api/fittings") {
      return json(res, 200, cb.listFittings());
    }
    if (req.method === "POST" && url.pathname === "/api/import") {
      const payload = parseBody(await readBody(req));
      if (!payload) {
        return json(res, 400, {ok: false, error: "bad json"});
      }
      const file = String(payload.file || "");
      const fittingID = Number(payload.fittingID) || 0;
      const id = String(payload.id || "");
      const count = Number(payload.count) || 1;
      if (!id || (!file && !(fittingID > 0))) {
        return json(res, 400, {ok: false, error: "need file or fittingID, and id"});
      }
      try {
        const reply = fittingID > 0 && typeof cb.importServerFitting === "function"
          ? cb.importServerFitting(fittingID, id, {id, count})
          : cb.importFitting(file, id, {id, count});
        if (typeof cb.log === "function") {
          cb.log(`[web] import ${fittingID > 0 ? `fitting ${fittingID}` : file} -> ${id} (${count})`);
        }
        return json(res, 200, {ok: true, reply: String(reply && reply.lines ? reply.lines.join("\n") : reply)});
      } catch (error) {
        return json(res, 500, {ok: false, error: error && error.message});
      }
    }
    if (req.method === "POST" && url.pathname === "/api/cmd") {
      const payload = parseBody(await readBody(req, 4096));
      if (!payload) {
        return json(res, 400, {ok: false, error: "bad json"});
      }
      const text = String(payload.text || "").trim();
      if (!text) {
        return json(res, 400, {ok: false, error: "empty command"});
      }
      try {
        const reply = await cb.runCommand(text, typeof cb.sessionOf === "function" ? cb.sessionOf() : null);
        if (typeof cb.log === "function") {
          cb.log(`[web] ${text} -> ${String(reply).slice(0, 120)}`);
        }
        return json(res, 200, {ok: true, reply: String(reply)});
      } catch (error) {
        if (typeof cb.log === "function") {
          cb.log(`[web] ${text} failed: ${error && error.message}`);
        }
        return json(res, 500, {ok: false, error: error && error.message});
      }
    }
    // ---- P2 库存面板 --------------------------------------------------------
    if (req.method === "GET" && url.pathname === "/api/stock") {
      if (typeof cb.stockView !== "function") {
        return json(res, 501, {ok: false, error: "STOCK_NOT_WIRED"});
      }
      try {
        return json(res, 200, cb.stockView({
          offset: Number(url.searchParams.get("offset")) || 0,
          limit: Number(url.searchParams.get("limit")) || 20,
        }));
      } catch (error) {
        return json(res, 500, {ok: false, error: error && error.message});
      }
    }
    if (req.method === "GET" && url.pathname === "/api/stock/hangar") {
      if (typeof cb.stockHangar !== "function") {
        return json(res, 501, {ok: false, error: "STOCK_NOT_WIRED"});
      }
      try {
        return json(res, 200, cb.stockHangar());
      } catch (error) {
        return json(res, 500, {ok: false, error: error && error.message});
      }
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/stock/")) {
      const action = url.pathname.slice("/api/stock/".length);
      const handler = {
        buy: cb.stockBuy,
        deposit: cb.stockDeposit,
        withdraw: cb.stockWithdraw,
        sell: cb.stockSell,
        rebuy: cb.stockRebuy,
        summon: cb.stockSummon,
        plan: cb.stockPlan,
        reconcile: cb.stockReconcile,
      }[action];
      if (typeof handler !== "function") {
        return json(res, 501, {ok: false, error: "STOCK_NOT_WIRED"});
      }
      // deposit 也要读 body（面板要传选中的 itemID），body 为空时按 {} 处理。
      let payload = {};
      try {
        payload = parseBody(await readBody(req, 16384)) || {};
      } catch (_error) {
        payload = {};
      }
      try {
        const result = (await handler(payload)) || {ok: false, lines: ["没有返回"]};
        if (typeof cb.log === "function") {
          cb.log(`[web] stock ${action} -> ${String((result.lines || []).join(" | ")).slice(0, 160)}`);
        }
        return json(res, 200, result);
      } catch (error) {
        if (typeof cb.log === "function") {
          cb.log(`[web] stock ${action} failed: ${error && error.message}`);
        }
        return json(res, 500, {ok: false, error: error && error.message});
      }
    }
    // ---- P3 配装台 ----------------------------------------------------------
    if (req.method === "GET" && url.pathname === "/api/fit/catalog") {
      if (typeof cb.fitCatalog !== "function") {
        return json(res, 501, {ok: false, error: "FIT_NOT_WIRED"});
      }
      try {
        return json(res, 200, cb.fitCatalog({
          family: url.searchParams.get("family") || "",
          query: url.searchParams.get("query") || "",
        }));
      } catch (error) {
        return json(res, 500, {ok: false, error: error && error.message});
      }
    }
    if (req.method === "GET" && url.pathname === "/api/fit/charges") {
      if (typeof cb.fitCharges !== "function") {
        return json(res, 501, {ok: false, error: "FIT_NOT_WIRED"});
      }
      try {
        return json(res, 200, cb.fitCharges(Number(url.searchParams.get("moduleTypeID")) || 0));
      } catch (error) {
        return json(res, 500, {ok: false, error: error && error.message});
      }
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/fit/")) {
      const action = url.pathname.slice("/api/fit/".length);
      const handler = {quote: cb.fitQuote, order: cb.fitOrder, save: cb.fitSave}[action];
      if (typeof handler !== "function") {
        return json(res, 501, {ok: false, error: "FIT_NOT_WIRED"});
      }
      const payload = parseBody(await readBody(req, 32768)) || {};
      try {
        const result = (await handler(payload)) || {ok: false, lines: ["没有返回"]};
        if (typeof cb.log === "function") {
          cb.log(`[web] fit ${action} -> ${String((result.lines || []).join(" | ")).slice(0, 160)}`);
        }
        return json(res, 200, result);
      } catch (error) {
        return json(res, 500, {ok: false, error: error && error.message});
      }
    }
    return json(res, 404, {ok: false, error: "not found"});
  } catch (error) {
    if (error && error.message === "BODY_TOO_LARGE") {
      return json(res, 413, {ok: false, error: "BODY_TOO_LARGE"});
    }
    return json(res, 500, {ok: false, error: error && error.message});
  }
}

function boot(options) {
  const requested = options.port !== undefined ? Number(options.port) : Number(process.env.NFCREW_PANEL_PORT || PORT);
  readyPromise = new Promise((resolve) => {
    markReady = resolve;
  });
  server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      try {
        json(res, 500, {ok: false, error: error && error.message});
      } catch (_writeError) {
        /* socket already gone */
      }
    });
  });
  server.on("error", (error) => {
    lastLog(`[web] server error: ${error && error.message}`);
    if (markReady) {
      markReady();
      markReady = null;
    }
  });
  server.listen(Number.isFinite(requested) && requested >= 0 ? requested : PORT, HOST, () => {
    actualPort = server.address().port;
    lastLog(`[web] 控制面板：http://${HOST}:${actualPort}/ — 每个账号用自己的令牌登录`);
    if (markReady) {
      markReady();
      markReady = null;
    }
  });
  if (typeof server.unref === "function") {
    server.unref();
  }
  return server;
}

/**
 * Under `node --test` every test file is its own process: booting :8741 there would
 * be a port fight with no benefit. A caller that really wants a server passes an
 * explicit `port` (0 = ephemeral), which opts back in.
 */
function shouldBoot(options) {
  return options.port !== undefined || !process.env.NODE_TEST_CONTEXT;
}

/**
 * Register one account's callbacks and boot the shared server on first use.
 * `callbacks` may also be passed flat (old shape) for the legacy runtime.
 */
function start(options = {}) {
  const tenant = options.tenant || null;
  const accountID = tenant ? Number(tenant.accountID) || 0 : 0;
  const key = tenant ? String(accountID) : "default";
  const callbacks = options.callbacks || options;
  if (typeof options.log === "function") {
    lastLog = options.log;
  } else if (typeof callbacks.log === "function") {
    lastLog = callbacks.log;
  }
  bindings.set(key, {
    key,
    accountID,
    tenant,
    callbacks,
    token: String(options.token || ""),
    legacy: !tenant,
  });
  if (!server && shouldBoot(options)) {
    boot(options);
  }
  return server;
}

/** Test/restart hook. */
function stop() {
  for (const binding of bindings.values()) {
    if (binding.token) {
      // nothing to release today; kept for symmetry
    }
  }
  bindings.clear();
  rate.clear();
  if (server) {
    try {
      server.close();
    } catch (_error) {
      /* already closed */
    }
    server = null;
  }
  return true;
}

function address() {
  const listening = server && typeof server.address === "function" ? server.address() : null;
  return {host: HOST, port: listening && typeof listening === "object" ? listening.port : actualPort};
}

/** Resolves once the server is accepting connections (tests await this). */
function ready() {
  return readyPromise;
}

function has(accountID) {
  return bindings.has(String(accountID));
}

module.exports = {start, stop, address, ready, has, HOST, PORT};
