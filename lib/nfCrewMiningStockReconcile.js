"use strict";

// P1.5：库存对账（账本 vs 物品表，**以物品为准**）。
//
// 为什么需要：账本只是索引，真相在 itemStore。服务端崩溃、玩家手动挪船、船被击毁，
// 都会让账本和实际对不上。对账规则：
//
//   物品不存在              → lost（终态；物品又出现才复活）
//   owner = 仓库角色        → stored（位置不对就停回 4-4）
//   owner = 某船员          → in_use（characterID 跟物品走）
//   owner = 别人（玩家/未知）→ 账本删掉这条（船已经不在库存了，物品不动）
//   reserved 过期           → stored（stockStore.purgeExpired）
//   adopt=true 且给了快照器  → 仓库机库里没上账的船认领为 existing
//
// 全程只读物品 + 改账本；唯一会动物品的情况是「仓库的船停在别处」→ 停回 4-4。

const path = require("node:path");

const {STATES} = require(path.join(__dirname, "nfCrewMiningStock.js"));

/**
 * options = {
 *   stockStore, lookupItem(itemID) → {ownerID, locationID, typeID, itemName}|null,
 *   warehouseCharacterID, stationID, knownCharacterIDs:Set, dockShip?(shipID, stationID) → bool,
 *   adopt?:boolean, snapshotOf?(itemID) → 快照, listWarehouseShips?() → [{itemID,…}], log?
 * }
 * 返回 {ok, checked, lost, stored, inUse, docked, removed, adopted, unchanged, problems[]}
 */
function reconcileStock(options = {}) {
  const stockStore = options.stockStore;
  const lookupItem = options.lookupItem;
  const log = options.log || (() => {});
  const result = {
    ok: false,
    checked: 0,
    lost: 0,
    stored: 0,
    inUse: 0,
    docked: 0,
    removed: 0,
    adopted: 0,
    reowned: 0,
    unchanged: 0,
    problems: [],
  };
  if (!stockStore || typeof lookupItem !== "function") {
    result.problems.push("NO_STOCK_STORE_OR_LOOKUP");
    return result;
  }

  const warehouseCharacterID = Number(options.warehouseCharacterID) || 0;
  const stationID = Number(options.stationID) || 0;
  const known = options.knownCharacterIDs instanceof Set
    ? options.knownCharacterIDs
    : new Set((Array.isArray(options.knownCharacterIDs) ? options.knownCharacterIDs : []).map(Number));
  const dockShip = typeof options.dockShip === "function" ? options.dockShip : null;
  const snapshotOf = typeof options.snapshotOf === "function" ? options.snapshotOf : null;

  stockStore.purgeExpired();
  result.ok = true;

  for (const record of stockStore.list()) {
    result.checked += 1;
    const item = lookupItem(record.itemID);
    if (!item) {
      if (record.state !== STATES.lost) {
        stockStore.markLost(record.id);
        result.lost += 1;
      } else {
        result.unchanged += 1;
      }
      continue;
    }

    const ownerID = Number(item.ownerID) || 0;
    const locationID = Number(item.locationID) || 0;

    if (warehouseCharacterID && ownerID === warehouseCharacterID) {
      if (stationID && locationID !== stationID) {
        if (dockShip) {
          if (dockShip(record.itemID, stationID)) {
            result.docked += 1;
          } else {
            result.problems.push(`${record.id}:DOCK_FAILED`);
          }
        }
      }
      if (record.state !== STATES.stored || record.characterID !== 0) {
        stockStore.markStored(record.id);
      }
      result.stored += 1;
      continue;
    }

    if (known.has(ownerID)) {
      if (record.state !== STATES.inUse || record.characterID !== ownerID) {
        stockStore.markInUse(record.id, ownerID);
      }
      // 顺手补过户：旧版本转移的船，模块还挂在仓库角色名下（详情页会显示"没装备"）。
      if (typeof options.reownShipContents === "function") {
        try {
          const moved = Number(options.reownShipContents(record.itemID, ownerID)) || 0;
          if (moved > 0) {
            result.reowned += moved;
          }
        } catch (_error) {
          result.problems.push(`${record.id}:REOWN_FAILED`);
        }
      }
      result.inUse += 1;
      continue;
    }

    // 船在别人手里（玩家取走 / 被手动挪走）：账本不该再管它，物品不动。
    stockStore.remove(record.id);
    result.removed += 1;
    log(`[stock] ${record.id}（船 ${record.itemID}）owner=${ownerID} 不是仓库/船员，账本移除`);
  }

  if (options.adopt === true && snapshotOf && typeof options.listWarehouseShips === "function") {
    for (const item of options.listWarehouseShips() || []) {
      const itemID = Number(item && item.itemID) || 0;
      if (!itemID || stockStore.findByItemID(itemID)) {
        continue;
      }
      const snapshot = snapshotOf(itemID) || {};
      stockStore.add({
        itemID,
        hullTypeID: Number(snapshot.hullTypeID) || Number(item.typeID) || 0,
        name: String(item.name || item.itemName || itemID),
        source: "existing",
        state: STATES.stored,
        fit: snapshot,
        signature: String(snapshot.signature || ""),
        pricePaid: 0,
        addedAt: 0,
      });
      result.adopted += 1;
    }
  }

  return result;
}

/** 把对账结果写成给人看的两三行。 */
function describeReconcile(result) {
  if (!result || result.ok !== true) {
    return `对账失败：${(result && result.problems || []).join(" ") || "未知"}`;
  }
  const parts = [`检查 ${result.checked} 条`];
  if (result.lost) {
    parts.push(`标记丢失 ${result.lost}`);
  }
  if (result.stored) {
    parts.push(`在库 ${result.stored}`);
  }
  if (result.inUse) {
    parts.push(`在用 ${result.inUse}`);
  }
  if (result.docked) {
    parts.push(`停回 4-4 ${result.docked}`);
  }
  if (result.removed) {
    parts.push(`账本移除 ${result.removed}`);
  }
  if (result.adopted) {
    parts.push(`认领 ${result.adopted}`);
  }
  if (result.reowned) {
    parts.push(`补过户装备 ${result.reowned} 件`);
  }
  const lines = [`对账：${parts.join(" · ")}`];
  if (result.problems.length > 0) {
    lines.push(`问题：${result.problems.slice(0, 6).join("；")}`);
  }
  return lines.join("\n");
}

module.exports = {reconcileStock, describeReconcile};
