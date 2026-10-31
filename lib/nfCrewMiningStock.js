"use strict";

// P1：库存账本（方案 2 = 真船物品 + 账本索引）。
//
// 账本只记"有哪些船、现在什么状态、多少钱买的"；**真相在物品表**（itemStore）。
// 对账时以物品为准：物品没了 → lost；owner/location 不对 → 按物品改写。
//
// 状态机：
//   stored   在库（仓库角色名下、停 4-4）
//   reserved 占位（最多 60 s，防两个客户端同时召唤同一艘）
//   in_use   船员在用（角色名下、在太空或停靠）
//   lost     丢失（被击毁；终态）
//
// 方案：不绑 itemID，只存「配装签名 + 数量」；召唤时按签名在库存里现找。

const LEDGER_VERSION = 1;
const RESERVE_TTL_MS = 60 * 1000;
const STATES = Object.freeze({
  stored: "stored",
  reserved: "reserved",
  inUse: "in_use",
  lost: "lost",
});
const STATE_VALUES = new Set(Object.values(STATES));
const SOURCES = new Set(["bought", "existing", "custom"]);

function emptyStock() {
  return {version: LEDGER_VERSION, enabled: false, warehouse: null, ships: [], plans: [], seq: 0, spent: 0, refunded: 0};
}

function normalizeWarehouse(raw) {
  const characterID = Number(raw && raw.characterID) || 0;
  if (!characterID) {
    return null;
  }
  return {
    characterID,
    name: String(raw && raw.name || ""),
    stationID: Number(raw && raw.stationID) || 0,
    createdAt: Number(raw && raw.createdAt) || 0,
  };
}

function normalizeShip(raw, fallbackID) {
  const itemID = Number(raw && raw.itemID) || 0;
  if (!itemID) {
    return null;
  }
  return {
    id: String(raw.id || fallbackID || ""),
    itemID,
    hullTypeID: Number(raw.hullTypeID) || 0,
    name: String(raw.name || ""),
    source: SOURCES.has(raw.source) ? raw.source : "existing",
    state: STATE_VALUES.has(raw.state) ? raw.state : STATES.stored,
    characterID: Number(raw.characterID) || 0,
    fit: raw.fit && typeof raw.fit === "object" ? raw.fit : null,
    signature: String(raw.signature || ""),
    pricePaid: Math.max(0, Math.round(Number(raw.pricePaid) || 0)),
    priceBasis: String(raw.priceBasis || ""),
    addedAt: Number(raw.addedAt) || 0,
    lostAt: Number(raw.lostAt) || 0,
    reserveToken: String(raw.reserveToken || ""),
    reserveUntil: Number(raw.reserveUntil) || 0,
  };
}

function normalizeStock(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const byItem = new Map();
  for (const entry of Array.isArray(source.ships) ? source.ships : []) {
    const ship = normalizeShip(entry, `s-${byItem.size + 1}`);
    // 不变量：一个 itemID 只能有一条账本（重复的丢掉后面的）。
    if (ship && !byItem.has(ship.itemID)) {
      byItem.set(ship.itemID, ship);
    }
  }
  const ships = [...byItem.values()].map((ship, index) => ({...ship, id: ship.id || `s-${index + 1}`}));
  const plans = (Array.isArray(source.plans) ? source.plans : [])
    .filter((plan) => plan && String(plan.name || "").trim())
    .map((plan) => ({
      id: String(plan.id || ""),
      name: String(plan.name),
      items: Array.isArray(plan.items) ? plan.items : [],
      createdAt: Number(plan.createdAt) || 0,
    }));
  const seq = Math.max(Number(source.seq) || 0, ships.length);
  return {
    version: LEDGER_VERSION,
    // 默认**关**：升级后老玩家照旧凭空造；`/crewmine stock on` 才切到库存。
    enabled: source.enabled === true,
    warehouse: normalizeWarehouse(source.warehouse),
    ships,
    plans,
    seq,
    // 累计：订货花掉多少、卖出退回多少（面板/命令展示用，不做账本对账依据）
    spent: Math.max(0, Math.round(Number(source.spent) || 0)),
    refunded: Math.max(0, Math.round(Number(source.refunded) || 0)),
  };
}

/**
 * options = {stateStore, now, log}
 * 每次写盘都走 stateStore.update（唯一写入口），读的时候重新规整。
 */
function createStockStore(options = {}) {
  const stateStore = options.stateStore;
  if (!stateStore || typeof stateStore.get !== "function" || typeof stateStore.update !== "function") {
    throw new Error("NF_CREW_STOCK_NO_STATE_STORE");
  }
  const now = options.now || (() => Date.now());
  const log = options.log || (() => {});

  function read() {
    let state = null;
    try {
      state = stateStore.get();
    } catch (_error) {
      state = null;
    }
    return normalizeStock(state && state.stock);
  }

  function commit(mutator) {
    let result = null;
    stateStore.update((state) => {
      const current = normalizeStock(state && state.stock);
      const next = mutator(current) || current;
      result = normalizeStock(next);
      return {...state, stock: result};
    });
    return result || read();
  }

  function nextID(stock) {
    const seq = (Number(stock.seq) || 0) + 1;
    return {id: `s-${seq}`, seq};
  }

  return {
    read,
    commit,

    setEnabled(enabled) {
      return commit((stock) => ({...stock, enabled: enabled === true}));
    },

    setWarehouse(warehouse) {
      return commit((stock) => ({...stock, warehouse: normalizeWarehouse(warehouse)}));
    },

    /** 新增一艘：自动分配 id（s-1、s-2…）。 */
    add(entry) {
      let added = null;
      commit((stock) => {
        const id = nextID(stock);
        added = normalizeShip({...entry, id: id.id}, id.id);
        return {...stock, seq: id.seq, ships: [...stock.ships, added]};
      });
      return added;
    },

    get(id) {
      const wanted = String(id || "");
      return read().ships.find((ship) => ship.id === wanted) || null;
    },

    findByItemID(itemID) {
      const wanted = Number(itemID) || 0;
      return read().ships.find((ship) => ship.itemID === wanted) || null;
    },

    list(filter = {}) {
      const state = filter && filter.state;
      return read().ships.filter((ship) => (state ? ship.state === state : true));
    },

    update(id, patch) {
      const wanted = String(id || "");
      let updated = null;
      commit((stock) => ({
        ...stock,
        ships: stock.ships.map((ship) => {
          if (ship.id !== wanted) {
            return ship;
          }
          updated = normalizeShip({...ship, ...patch, id: ship.id, itemID: ship.itemID}, ship.id);
          return updated;
        }),
      }));
      return updated;
    },

    remove(id) {
      const wanted = String(id || "");
      let removed = null;
      commit((stock) => {
        removed = stock.ships.find((ship) => ship.id === wanted) || null;
        return {...stock, ships: stock.ships.filter((ship) => ship.id !== wanted)};
      });
      return removed;
    },

    /** 过期占位自动放回在库。 */
    purgeExpired() {
      const at = now();
      let changed = 0;
      commit((stock) => ({
        ...stock,
        ships: stock.ships.map((ship) => {
          if (ship.state === STATES.reserved && (!ship.reserveUntil || ship.reserveUntil <= at)) {
            changed += 1;
            return {...ship, state: STATES.stored, reserveToken: "", reserveUntil: 0};
          }
          return ship;
        }),
      }));
      return changed;
    },

    /**
     * 批量占位（整批校验：要么全占上，要么一个都不占）。
     * 返回 {ok, problem, token, items}
     */
    reserve(ids, token) {
      const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(String))];
      if (wanted.length === 0) {
        return {ok: false, problem: "NO_IDS"};
      }
      this.purgeExpired();
      const stock = read();
      const picks = [];
      for (const id of wanted) {
        const ship = stock.ships.find((row) => row.id === id);
        if (!ship) {
          return {ok: false, problem: `NOT_FOUND:${id}`};
        }
        if (ship.state !== STATES.stored) {
          return {ok: false, problem: `NOT_AVAILABLE:${id}:${ship.state}`};
        }
        picks.push(ship);
      }
      const until = now() + RESERVE_TTL_MS;
      commit((current) => ({
        ...current,
        ships: current.ships.map((ship) => (wanted.includes(ship.id)
          ? {...ship, state: STATES.reserved, reserveToken: token, reserveUntil: until}
          : ship)),
      }));
      return {ok: true, token, items: picks};
    },

    /** 释放某个令牌占着的所有船（失败回滚用）。 */
    release(token) {
      const wanted = String(token || "");
      if (!wanted) {
        return 0;
      }
      let count = 0;
      commit((stock) => ({
        ...stock,
        ships: stock.ships.map((ship) => {
          if (ship.state === STATES.reserved && ship.reserveToken === wanted) {
            count += 1;
            return {...ship, state: STATES.stored, reserveToken: "", reserveUntil: 0};
          }
          return ship;
        }),
      }));
      return count;
    },

    markInUse(id, characterID) {
      return this.update(id, {
        state: STATES.inUse,
        characterID: Number(characterID) || 0,
        reserveToken: "",
        reserveUntil: 0,
      });
    },

    markStored(id) {
      return this.update(id, {state: STATES.stored, characterID: 0, reserveToken: "", reserveUntil: 0});
    },

    markLost(id) {
      return this.update(id, {state: STATES.lost, characterID: 0, lostAt: now(), reserveToken: "", reserveUntil: 0});
    },

    // ---- 召唤方案（P2）：存「配装签名 + 数量」，不绑 itemID ----

    plans() {
      return read().plans;
    },

    getPlan(id) {
      const wanted = String(id || "");
      return read().plans.find((plan) => plan.id === wanted) || null;
    },

    addPlan({name, items}) {
      const cleanName = String(name || "").trim().slice(0, 40);
      if (!cleanName) {
        return null;
      }
      const rows = (Array.isArray(items) ? items : [])
        .map((item) => ({
          signature: String(item && item.signature || ""),
          hullTypeID: Number(item && item.hullTypeID) || 0,
          name: String(item && item.name || ""),
          count: Math.max(1, Math.trunc(Number(item && item.count) || 1)),
        }))
        .filter((item) => item.signature);
      if (rows.length === 0) {
        return null;
      }
      let created = null;
      commit((stock) => {
        let seq = 1;
        const taken = new Set(stock.plans.map((plan) => plan.id));
        while (taken.has(`p-${seq}`)) {
          seq += 1;
        }
        created = {id: `p-${seq}`, name: cleanName, items: rows, createdAt: now()};
        return {...stock, plans: [...stock.plans, created]};
      });
      return created;
    },

    removePlan(id) {
      const wanted = String(id || "");
      let removed = null;
      commit((stock) => {
        removed = stock.plans.find((plan) => plan.id === wanted) || null;
        return {...stock, plans: stock.plans.filter((plan) => plan.id !== wanted)};
      });
      return removed;
    },

    // ---- 累计花费（P4）----

    addSpent(amount) {
      const value = Math.max(0, Math.round(Number(amount) || 0));
      if (!value) {
        return this.read().spent;
      }
      return commit((stock) => ({...stock, spent: stock.spent + value})).spent;
    },

    addRefunded(amount) {
      const value = Math.max(0, Math.round(Number(amount) || 0));
      if (!value) {
        return this.read().refunded;
      }
      return commit((stock) => ({...stock, refunded: stock.refunded + value})).refunded;
    },

    stats() {
      const stock = read();
      const counts = {stored: 0, reserved: 0, in_use: 0, lost: 0};
      for (const ship of stock.ships) {
        if (counts[ship.state] !== undefined) {
          counts[ship.state] += 1;
        }
      }
      return {
        enabled: stock.enabled,
        warehouse: stock.warehouse,
        total: stock.ships.length,
        counts,
        plans: stock.plans.length,
        spent: stock.spent,
        refunded: stock.refunded,
      };
    },
  };
}

module.exports = {
  createStockStore,
  normalizeStock,
  emptyStock,
  STATES,
  STATE_VALUES,
  SOURCES,
  RESERVE_TTL_MS,
  LEDGER_VERSION,
};
