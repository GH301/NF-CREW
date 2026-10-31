"use strict";

// dogma 快照很贵（全船属性图 + 全部修正）。一次交战中「射程判定」和「齐射结算」
// 需要的是同一块模块的同一份快照，没必要建两次。
// 这里做一个短 TTL 的 memo：key = crewID:shipID:moduleTypeID:chargeTypeID。

const TTL_MS = 5000;
const store = new Map();

function keyOf({characterID, shipID, moduleItem, chargeItem}) {
  const typeID = Number(moduleItem && moduleItem.typeID) || 0;
  const chargeTypeID = Number(chargeItem && chargeItem.typeID) || 0;
  return `${Number(characterID) || 0}:${Number(shipID) || 0}:${typeID}:${chargeTypeID}`;
}

function get(request) {
  const key = keyOf(request || {});
  const row = store.get(key);
  if (!row) {
    return null;
  }
  if (Date.now() - row.at > TTL_MS) {
    store.delete(key);
    return null;
  }
  return row.snapshot || null;
}

function set(request, snapshot) {
  if (!snapshot) {
    return snapshot;
  }
  store.set(keyOf(request || {}), {at: Date.now(), snapshot});
  return snapshot;
}

function clear() {
  store.clear();
}

module.exports = {get, set, clear, keyOf, TTL_MS};
