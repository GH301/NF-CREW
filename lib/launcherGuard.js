"use strict";
// 本MOD免费开源，仅供本地娱乐，作者从不售卖；花钱买到的说明被骗了，请举报卖家。

// Canonical source for the launcher binding embedded in the faction sim, the three first-party mods it carries and the
// Star Citizen ship mods (tools/dev/guard-targets.js lists them all).
// The official EveJS Launcher hands the server a signed grant in EVEJS_LAUNCHER_GRANT; this checks it. A failed check
// is only logged while the manifest says binding.enforce = "observe" (the default); with "enforce" the mod loads
// but does nothing (no hooks, no sim thread, no panel). Contract: docs/faction-sim-launcher-binding.md (v1, frozen).
// Run `node tools/dev/launcher-guard/sync.js` after editing this file.
//
//   const guard = require("./launcherGuard.js");
//   guard.gate("evejs-faction-sim")   ->  true when this mod must stay inert (blocked); logs once per mod and process
//
// One process can hold several mods that each carry a copy: the grant is checked once, but every mod gets its own
// verdict from its own manifest (binding.enforce) and its own id (grant.mods). The EVEJS_FACTIONSIM_GUARD* switches
// are process-wide on purpose: they act on every mod that uses this file.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const GUARD_VERSION = 1;
const STATE_KEY = Symbol.for("evejs.launcher.guard.v1");
const EXPECTED_TAG = "5c0f2d7e-3b1a-4e86-9a74-0d6f1c28b3e5";
const MOD_ID = "evejs-faction-sim";
const MANIFEST_NAME = "evejs-launcher.mod.json";
const LAUNCHER_ID = "evejs-launcher";
const CANON_PREFIX = "evejs-machine-v1|";

// keyId (first 12 hex of the public key's fingerprint, never a dated label) → base64 of the raw 32-byte Ed25519 key.
// Only ever grows: removing a key kills every mod build that still relies on it. To rotate, the launcher signs with two
// keys for a while: add the new entry, keep this one.
const LAUNCHER_KEYS = Object.freeze({
  "867242e85fc5": "UJXSqYWG/VrWTa03/Ppq3tAgYpOE9VRyQvTyszk5ihg=", // the launcher's signing key (private half stays with its signing service)
});

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

// what is signed: the object without its signature(s), keys sorted, compact
function canonicalSigned(value) {
  const clone = { ...value };
  delete clone.sigs;
  delete clone.sig;
  return JSON.stringify(canonicalize(clone));
}

// Node takes no raw Ed25519 key: wrap the 32 bytes in an SPKI header
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
function keyFromRaw(base64) {
  const raw = Buffer.from(String(base64), "base64");
  if (raw.length !== 32) throw new Error("public key is not 32 bytes");
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

function versionParts(text) {
  const parts = String(text || "").trim().split(".");
  if (!parts.length || parts.some((part) => !/^\d+$/.test(part))) return null;
  return parts.map(Number);
}

function isOlderThan(version, minimum) {
  const a = versionParts(version);
  const b = versionParts(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

function defaultMachineSource(platform) {
  if (platform === "win32") {
    try {
      const out = require("node:child_process").execFileSync(
        "reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
        { encoding: "utf8", windowsHide: true, timeout: 3000, stdio: ["ignore", "pipe", "ignore"] },
      );
      const match = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(out);
      if (match) return match[1].trim().toLowerCase();
    } catch (_) {
      // falls through to the host name
    }
  }
  return require("node:os").hostname().trim().toLowerCase();
}

// Verifies one signed object (grant or valve token) against the key table. Any one good signature is enough; a keyId
// the table does not know fails that entry only, so the launcher can rotate keys by signing with two.
function verifySigned(value, entries, keys) {
  if (!entries.length) return { ok: false, reason: "no signature" };
  const data = Buffer.from(canonicalSigned(value), "utf8");
  let reason = "signature check failed";
  for (const entry of entries) {
    const keyId = String((entry && entry.keyId) || "").trim();
    const publicKey = keys[keyId];
    if (!publicKey) { reason = `signing key not in the built-in table: ${keyId}`; continue; }
    const sig = Buffer.from(String((entry && entry.sig) || ""), "base64");
    if (sig.length !== 64) { reason = "signature is not 64 bytes"; continue; }
    let key;
    try { key = keyFromRaw(publicKey); } catch (_) { reason = "built-in public key is malformed"; continue; }
    let good = false;
    try { good = crypto.verify(null, data, key, sig); } catch (_) { good = false; }
    if (good) return { ok: true, keyId };
  }
  return { ok: false, reason };
}

// options (tests): env, keys, now(), manifest ({binding}), platform, machineSource(), modId
function createGuard(options = {}) {
  const env = options.env || process.env;
  const keys = options.keys || LAUNCHER_KEYS;
  const now = options.now || (() => Date.now());
  const modId = options.modId || MOD_ID;
  const platform = options.platform || process.platform;
  let cachedHash = null;

  function machineHash() {
    if (cachedHash === null) {
      const source = options.machineSource ? options.machineSource() : defaultMachineSource(platform);
      cachedHash = crypto.createHash("sha256").update(CANON_PREFIX + String(source).trim().toLowerCase()).digest("hex").slice(0, 32);
    }
    return cachedHash;
  }

  function verify(id = modId) {
    if (env.EVEJS_FACTIONSIM_GUARD === "0") return { ok: true, reason: "guard off (dev)", overridden: true };
    const raw = env.EVEJS_LAUNCHER_GRANT;
    if (!raw) return { ok: false, reason: "EVEJS_LAUNCHER_GRANT is not set", missing: true };
    let grant;
    try { grant = JSON.parse(raw); } catch (_) { return { ok: false, reason: "grant is not valid JSON" }; }
    if (!grant || typeof grant !== "object" || Array.isArray(grant)) return { ok: false, reason: "grant is not an object" };
    // the contract is frozen at v1: only the number is checked, unknown fields are ignored
    if (Number(grant.v) !== 1) return { ok: false, reason: `grant contract version is not 1: ${grant.v}` };
    if (grant.launcher !== LAUNCHER_ID) return { ok: false, reason: "grant is not from the official launcher" };
    if (Array.isArray(grant.mods) && grant.mods.indexOf(id) === -1) return { ok: false, reason: "grant does not cover this mod" };
    const sigs = Array.isArray(grant.sigs) ? grant.sigs : [];
    const signed = verifySigned(grant, sigs, keys);
    if (!signed.ok) return { ok: false, reason: signed.reason };
    // from here on the fields can be trusted (they are inside the signature)
    const info = {
      launcherVersion: typeof grant.launcherVersion === "string" ? grant.launcherVersion : "",
      installId: typeof grant.installId === "string" ? grant.installId : "",
      bootId: typeof grant.bootId === "string" ? grant.bootId : "",
    };
    const expires = Date.parse(String(grant.expiresAt || ""));
    if (!Number.isFinite(expires)) return { ok: false, reason: "expiresAt cannot be read", ...info };
    if (now() > expires) return { ok: false, reason: "grant has expired", ...info };
    if (grant.machineHash && String(grant.machineHash) !== machineHash()) {
      // a machine id drifts (reinstall, new NIC, VM): only a hard setting refuses
      if (env.EVEJS_FACTIONSIM_GUARD_HARD_MACHINE === "1") return { ok: false, reason: "machineHash does not match", machineMismatch: true, machineHash: machineHash(), ...info };
      return { ok: true, reason: "machineHash does not match (soft check, allowed)", machineMismatch: true, machineHash: machineHash(), ...info };
    }
    return { ok: true, reason: "", ...info };
  }

  // The escape valve is a signed token: {"mode":"observe","expiresAt":…,"keyId":…,"sig":…}; the signature covers the
  // object without "sig". A bare string, a forged or an expired token counts as not set.
  function valve() {
    const raw = env.EVEJS_FACTIONSIM_GUARD_MODE;
    if (!raw) return { mode: "" };
    let token;
    try { token = JSON.parse(raw); } catch (_) { return { mode: "", ignored: "not a signed token" }; }
    if (!token || typeof token !== "object" || token.mode !== "observe") return { mode: "", ignored: "not a signed observe token" };
    const expires = Date.parse(String(token.expiresAt || ""));
    if (!Number.isFinite(expires) || now() > expires) return { mode: "", ignored: "token expired" };
    const signed = verifySigned(token, [{ keyId: token.keyId, sig: token.sig }], keys);
    return signed.ok ? { mode: "observe" } : { mode: "", ignored: signed.reason };
  }

  // verify() says whether the grant is good; posture() says whether that matters
  function posture(manifest = options.manifest, id = modId) {
    const binding = (manifest && manifest.binding) || {};
    const declared = binding.enforce === "enforce" ? "enforce" : "observe";
    const result = verify(id);
    const token = valve();
    const tooOld = isOlderThan(result.launcherVersion, binding.minLauncherVersion);
    const forced = token.mode === "observe" || tooOld;
    const mode = forced ? "observe" : declared;
    return {
      ok: result.ok,
      reason: result.reason,
      result,
      declared,
      posture: mode,
      blocked: !result.ok && mode === "enforce",
      valveIgnored: token.ignored || "",
      tooOld,
    };
  }

  // the panel token the launcher hands down is taken only from an authorized instance
  function launcherPanelToken(decision) {
    const value = String(env.EVEJS_FACTIONSIM_PANEL_TOKEN || "");
    return decision && decision.ok && !decision.blocked && /^[0-9a-f]{24,64}$/.test(value) ? value : null;
  }

  return { verify, valve, posture, machineHash, launcherPanelToken };
}

// ---- the process-wide instance (what the mods call) ------------------------------------------------------------

// the manifest of the mod a copy of this file sits in: the nearest one above it (lib/ → mod, or parts/<part>/lib → mod)
function findManifest(start) {
  let dir = start;
  for (let depth = 0; depth < 5; depth += 1) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_NAME), "utf8"));
      if (manifest && typeof manifest.id === "string" && manifest.id) return manifest;
    } catch (_) {
      // not here
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function logFile() {
  let root;
  try {
    root = require("./repoRoot.js")(__dirname);
  } catch (_) {
    root = path.resolve(__dirname, "..", "..", "..");
  }
  return path.join(root, "server", "logs", "evejs-mods.log");
}

function append(message) {
  try {
    const target = logFile();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${new Date().toISOString()} [launcher-guard] ${message}\n`, "utf8");
  } catch (_) {
    // a read-only install must not fail on a log line
  }
}

// forked children and worker threads load the mods too; the world process says it, the others stay quiet unless blocked
function isWorldProcess() {
  if (!require("node:worker_threads").isMainThread) return false;
  const label = path.basename(String(process.argv[1] || "node")).toLowerCase();
  return label === "server" || /^index\.js$/.test(label);
}

function stop(message) {
  const error = new Error(message);
  append(error.message);
  const timer = setTimeout(() => process.exit(1), 350);
  if (timer && typeof timer.unref === "function") timer.unref();
  process.nextTick(() => { throw error; });
}

function describe(decision, extra) {
  const result = decision.result;
  return JSON.stringify({
    guard: decision.ok ? "ok" : "denied",
    posture: decision.posture,
    blocked: decision.blocked,
    reason: decision.reason,
    launcherVersion: result.launcherVersion || undefined,
    installId: result.installId || undefined,
    bootId: result.bootId || undefined,
    machineHash: result.machineHash || undefined,
    machineMismatch: result.machineMismatch || undefined,
    overridden: result.overridden || undefined,
    valveIgnored: decision.valveIgnored || undefined,
    tooOld: decision.tooOld || undefined,
    ...extra,
  });
}

function createState() {
  const guard = createGuard();
  const participants = new Map(); // mod id → the names that joined for it (a mod's parts join under their own names)
  const decisions = new Map();    // mod id → its verdict, made once
  const reported = new Set();
  let state = null;
  state = Object.freeze({
    tag: EXPECTED_TAG,
    version: GUARD_VERSION,
    // the verdict for the mod whose copy of this file sits in `dir`; `id` is the caller's name, used when no manifest is found
    decide(dir, id) {
      const manifest = findManifest(dir || __dirname);
      const modId = (manifest && manifest.id) || String(id || MOD_ID);
      let decision = decisions.get(modId);
      if (!decision) {
        decision = { ...guard.posture(manifest, modId), modId };
        decisions.set(modId, decision);
      }
      return decision;
    },
    join(modId, id) {
      const name = String(id || "").trim();
      if (!name) throw new Error("launcher guard participant id is required");
      if (!participants.has(modId)) participants.set(modId, new Set());
      participants.get(modId).add(name);
      return name;
    },
    report(decision, blockedHere) {
      if (reported.has(decision.modId)) return;
      if (!decision.ok || decision.blocked || decision.result.overridden || decision.valveIgnored || decision.result.machineMismatch) {
        if (isWorldProcess() || blockedHere) {
          reported.add(decision.modId);
          append(describe(decision, { mod: decision.modId, participants: Array.from(participants.get(decision.modId) || []) }));
        }
      }
    },
    panelToken(dir) {
      return guard.launcherPanelToken(state.decide(dir));
    },
    verify() {
      return globalThis[STATE_KEY] === state && typeof state.decide === "function";
    },
  });
  return state;
}

function validState(state) {
  if (!state || state.version !== GUARD_VERSION || state.tag !== EXPECTED_TAG) return false;
  if (typeof state.decide !== "function" || typeof state.join !== "function" || typeof state.verify !== "function") return false;
  try {
    return state.verify() === true;
  } catch (_) {
    return false;
  }
}

// one state per thread, shared by every copy of this file; a copy that finds something else there is not trusted
function shared() {
  let state = globalThis[STATE_KEY];
  if (state === undefined) {
    state = createState();
    Object.defineProperty(globalThis, STATE_KEY, { configurable: false, enumerable: false, value: state, writable: false });
  } else if (!validState(state)) {
    // the slot was replaced: count as blocked under any posture and say why
    append("launcher guard state failed its integrity check");
    return null;
  }
  return state;
}

// true = this mod stays inert
function gate(id) {
  const state = shared();
  if (!state) return true;
  const decision = state.decide(__dirname, id);
  state.join(decision.modId, id);
  state.report(decision, decision.blocked);
  if (!decision.ok && process.env.EVEJS_FACTIONSIM_GUARD_STRICT === "1") {
    stop(`launcher guard: ${decision.reason}`);
    throw new Error(`launcher guard: ${decision.reason}`);
  }
  return decision.blocked;
}

function panelToken() {
  const state = shared();
  return state ? state.panelToken(__dirname) : null;
}

module.exports = { gate, panelToken, createGuard, LAUNCHER_KEYS, canonicalSigned, isOlderThan, GUARD_VERSION, EXPECTED_TAG };
