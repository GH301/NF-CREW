"use strict";

// P0：价格服务（库存系统的地基）。
//
// 口径（2026-10-28 用户定）：
//   - 成交价 = **当前市场卖价 × 0.8**（吉他 30000142 的最低卖价 best_ask_price），现查；
//   - 不用历史价、不用均价；
//   - 没有卖价的物品按 **100 ISK**（不拒绝订购）。
//
// 数据源：externalservices/market-server/data/generated/market.sqlite
//   system_seed_summaries(solar_system_id, type_id, best_ask_price, ...)
//
// 明确**不用** seed_buy_orders / seed_stock（"吉他市场补丁"灌进去的那两张）：
// 实测部分物品价格错 4 个数量级（矿枪买单价 6.51 亿），不能拿来定价。
//
// 只读打开；库缺失/损坏时整体降级成"全部 100 ISK"，只记一次日志，不影响服务器。

const fs = require("node:fs");
const path = require("node:path");

const host = require(path.join(__dirname, "nfCrewMiningHost.js"));

const DEFAULT_SYSTEM_ID = 30000142; // 吉他
const DEFAULT_DISCOUNT = 0.8;
const DEFAULT_FALLBACK_ISK = 100;
const DEFAULT_REFRESH_MS = 5 * 60 * 1000;

function roundIsk(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return DEFAULT_FALLBACK_ISK;
  }
  return Math.max(1, Math.round(number));
}

function defaultDbFile() {
  return path.join(host.WORKSPACE, "externalservices", "market-server", "data", "generated", "market.sqlite");
}

function defaultOpenDatabase(dbFile) {
  // better-sqlite3 只装在 server/node_modules 里（模组自身没有依赖）。
  const modulePath = path.join(host.WORKSPACE, "server", "node_modules", "better-sqlite3");
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const Database = require(modulePath);
  return new Database(dbFile, {readonly: true, fileMustExist: true});
}

/**
 * options = {dbFile, openDatabase, now, log, systemID, discount, fallbackISK, refreshMs}
 * 返回 {priceOf(typeID), quote(items), refresh(force), stats()}
 */
function createPriceBook(options = {}) {
  const log = options.log || (() => {});
  const now = options.now || (() => Date.now());
  const systemID = Number(options.systemID) || DEFAULT_SYSTEM_ID;
  const discount = Number.isFinite(Number(options.discount)) ? Number(options.discount) : DEFAULT_DISCOUNT;
  const fallbackISK = Number.isFinite(Number(options.fallbackISK)) ? Number(options.fallbackISK) : DEFAULT_FALLBACK_ISK;
  const refreshMs = Number.isFinite(Number(options.refreshMs))
    ? Math.max(0, Number(options.refreshMs))
    : DEFAULT_REFRESH_MS;
  const dbFile = options.dbFile || defaultDbFile();
  const openDatabase = options.openDatabase || defaultOpenDatabase;
  // 注入自定义 opener 时（测试/调试）不检查文件是否存在。
  const checkFile = !options.openDatabase;

  const asks = new Map(); // typeID -> best ask
  let lastAt = 0;
  let lastError = null;
  let loaded = false;
  let warned = false;

  function warnOnce(message) {
    if (warned) {
      return;
    }
    warned = true;
    log(`[price] ${message}`);
  }

  function load() {
    asks.clear();
    lastError = null;
    let db = null;
    try {
      if (checkFile && !fs.existsSync(dbFile)) {
        throw new Error(`NO_DB ${dbFile}`);
      }
      db = openDatabase(dbFile);
      const rows = db.prepare(
        "select type_id, best_ask_price from system_seed_summaries "
        + "where solar_system_id = ? and best_ask_price > 0",
      ).all(systemID);
      for (const row of Array.isArray(rows) ? rows : []) {
        const typeID = Number(row && row.type_id);
        const ask = Number(row && row.best_ask_price);
        if (typeID > 0 && Number.isFinite(ask) && ask > 0) {
          asks.set(typeID, ask);
        }
      }
      loaded = true;
    } catch (error) {
      loaded = false;
      lastError = error && (error.message || String(error));
      warnOnce(`价格库读不了（${lastError}），所有物品按 ${fallbackISK} ISK 计`);
    } finally {
      try {
        if (db) {
          db.close();
        }
      } catch (_closeError) {
        /* 关不掉不影响结果 */
      }
    }
    lastAt = now();
    return {ok: loaded, count: asks.size, at: lastAt, error: lastError};
  }

  /** 5 分钟一次；force=true 立即重读。 */
  function refresh(force = false) {
    if (!force && loaded && now() - lastAt < refreshMs) {
      return {ok: loaded, count: asks.size, at: lastAt, error: lastError, cached: true};
    }
    return load();
  }

  /** 单件成交价：{typeID, ask, price, source: "ask80"|"fallback"} */
  function priceOf(typeID) {
    refresh(false);
    const id = Number(typeID) || 0;
    const ask = asks.get(id) || 0;
    if (!(ask > 0)) {
      return {typeID: id, ask: 0, price: fallbackISK, source: "fallback"};
    }
    return {typeID: id, ask, price: roundIsk(ask * discount), source: "ask80"};
  }

  /** 多件合计：items = [{typeID, qty}] */
  function quote(items) {
    const rows = (Array.isArray(items) ? items : []).map((item) => {
      const qty = Math.max(1, Math.trunc(Number(item && item.qty)) || 1);
      const unit = priceOf(item && item.typeID);
      return {...unit, qty, total: unit.price * qty};
    });
    return {
      items: rows,
      total: rows.reduce((sum, row) => sum + row.total, 0),
      fallbackCount: rows.filter((row) => row.source === "fallback").length,
      ok: loaded,
    };
  }

  function stats() {
    return {
      ok: loaded,
      count: asks.size,
      at: lastAt,
      error: lastError,
      dbFile,
      systemID,
      discount,
      fallbackISK,
      refreshMs,
    };
  }

  return {priceOf, quote, refresh, stats, dbFile};
}

module.exports = {
  createPriceBook,
  roundIsk,
  defaultDbFile,
  DEFAULT_SYSTEM_ID,
  DEFAULT_DISCOUNT,
  DEFAULT_FALLBACK_ISK,
  DEFAULT_REFRESH_MS,
};
