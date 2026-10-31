"use strict";

// P1：仓库角色 + 物品转移封装（方案 2：真船物品）。
//
// 仓库 = 一个专用角色（`<玩家主角色名>NFCREW`，建在**模组船员账号**下），固定停在
// 吉他 4-4（站 60003760）。库存船的所有权在"仓库角色 ⇄ 船员角色 ⇄ 玩家角色"之间转移，
// 船里的模块/货舱是内容物，跟着船走（不需要单独搬）。
//
// 命名规则（服务端约束）：3–37 字符、最多 2 个空格、只允许字母/数字/'/-/空格、
// 全局唯一（不分大小写）、不能以 ccp/gm/isd 开头。

const path = require("node:path");

const pool = require(path.join(__dirname, "nfCrewMiningPool.js"));

const WAREHOUSE_STATION_ID = 60003760; // Jita IV - Moon 4 - Caldari Navy Assembly Plant
const WAREHOUSE_SUFFIX = "NFCREW";
const NAME_MAX = 37;
const CANDIDATE_COUNT = 6;
const HANGAR_FLAG = 4;
const SHIP_CATEGORY_ID = 6;

function sanitizeName(raw) {
  const text = String(raw == null ? "" : raw).normalize("NFKC")
    .replace(/[^\p{L}\p{N}' -]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return text;
}

/** `<玩家名截断>NFCREW`；撞名/非法时依次试 -2、-3、-4。 */
function warehouseNameFor(playerName) {
  const clean = sanitizeName(playerName);
  const room = Math.max(1, NAME_MAX - WAREHOUSE_SUFFIX.length);
  const base = (clean || "NFCrew").slice(0, room).trim() || "NFCrew";
  return `${base}${WAREHOUSE_SUFFIX}`;
}

/** `<玩家名截断>NFCREW`；撞名/非法时依次试 -2、-3…，后缀不会被截断掉。 */
function nameCandidates(playerName) {
  const clean = sanitizeName(playerName);
  const base = (clean || "NFCrew").slice(0, Math.max(1, NAME_MAX - WAREHOUSE_SUFFIX.length)).trim() || "NFCrew";
  const out = [];
  const seen = new Set();
  for (let index = 0; index < CANDIDATE_COUNT; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    // 前缀要按后缀长度让位，否则 37 字的名字再加 "-2" 会被 slice 截回同一个名字。
    const headRoom = Math.max(1, NAME_MAX - WAREHOUSE_SUFFIX.length - suffix.length);
    const head = base.slice(0, headRoom).trim() || "NFCrew";
    const name = `${head}${WAREHOUSE_SUFFIX}${suffix}`;
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

function characterExists(deps, characterID) {
  const id = Number(characterID) || 0;
  if (!id) {
    return false;
  }
  try {
    if (deps.characterState && typeof deps.characterState.peekCharacterRecord === "function") {
      return Boolean(deps.characterState.peekCharacterRecord(id));
    }
  } catch (_error) {
    return false;
  }
  return false;
}

function takenNameKeys(deps) {
  const keys = new Set();
  try {
    if (deps.characterName && typeof deps.characterName.getExistingCharacterNameKeys === "function") {
      for (const key of deps.characterName.getExistingCharacterNameKeys()) {
        keys.add(String(key).trim().toLowerCase());
      }
      return keys;
    }
  } catch (_error) {
    /* 退回自己枚举 */
  }
  try {
    const ids = deps.characterState && typeof deps.characterState.listCharacterIDs === "function"
      ? deps.characterState.listCharacterIDs()
      : [];
    for (const value of Array.isArray(ids) ? ids : []) {
      const record = deps.characterState.peekCharacterRecord(Number(value));
      const name = String(record && record.characterName || "").trim().toLowerCase();
      if (name) {
        keys.add(name);
      }
    }
  } catch (_error) {
    /* 拿不到就当没有重名 */
  }
  return keys;
}

/**
 * 名字可用性：先看有没有重名，再问服务端的 validateCharacterName。
 * 注意服务端的 VALIDATION_CODE.VALID 是**数字 1**（不是字符串 "VALID"）——
 * 0.6.21 之前这里按字符串比较，把所有候选都判成不可用，于是报 NAME_UNAVAILABLE。
 */
function nameCheck(deps, taken, name) {
  if (taken.has(String(name).trim().toLowerCase())) {
    return {ok: false, code: "TAKEN"};
  }
  try {
    const module = deps.characterName;
    if (module && typeof module.validateCharacterName === "function") {
      const code = module.validateCharacterName(name);
      const codes = module.VALIDATION_CODE;
      const validCode = codes && Object.prototype.hasOwnProperty.call(codes, "VALID") ? codes.VALID : 1;
      if (code === validCode || code === 1 || String(code).toUpperCase() === "VALID") {
        return {ok: true, code: "VALID"};
      }
      return {ok: false, code: String(code)};
    }
  } catch (error) {
    // 校验器坏了就别挡路：创建时服务端还会再验一次。
    return {ok: true, code: "NO_VALIDATOR"};
  }
  return {ok: true, code: "NO_VALIDATOR"};
}

/** 按名字找**本账号**已有的角色（认领"建过但账本没记上"的仓库角色）。
 *  别人的同名角色绝不能认领——那会把别人的船当库存。accountId 未知时一律不认领。 */
function findCharacterByName(deps, name, accountId) {
  const key = String(name || "").trim().toLowerCase();
  const wanted = Number(accountId) || 0;
  if (!key || !wanted) {
    return 0;
  }
  try {
    const ids = deps.characterState && typeof deps.characterState.listCharacterIDs === "function"
      ? deps.characterState.listCharacterIDs()
      : [];
    for (const value of Array.isArray(ids) ? ids : []) {
      const record = deps.characterState.peekCharacterRecord(Number(value));
      if (!record || String(record.characterName || "").trim().toLowerCase() !== key) {
        continue;
      }
      if (Number(record.accountId) !== wanted) {
        continue;
      }
      return Number(record.characterID || value) || 0;
    }
  } catch (_error) {
    /* 拿不到就当没有 */
  }
  return 0;
}

/**
 * 保证仓库角色存在。已存在且角色记录还在 → 直接返回；否则新建（名字按候选顺序试）。
 * options = {stockStore, playerName, stationID, accountId, log, now}
 */
function ensureWarehouse(deps, options = {}) {
  const stockStore = options.stockStore;
  if (!stockStore) {
    return {ok: false, problem: "NO_STOCK_STORE"};
  }
  const log = options.log || (() => {});
  const now = options.now || (() => Date.now());
  const stationID = Number(options.stationID) || WAREHOUSE_STATION_ID;
  const stock = stockStore.read();
  if (stock.warehouse && characterExists(deps, stock.warehouse.characterID)) {
    return {ok: true, created: false, warehouse: stock.warehouse};
  }
  if (stock.warehouse) {
    log(`[stock] 仓库角色 ${stock.warehouse.characterID}（${stock.warehouse.name}）不见了，重建`);
  }
  const taken = takenNameKeys(deps);
  const rejected = [];
  let problem = null;
  for (const name of nameCandidates(options.playerName)) {
    // 已经有**本账号**的同名角色（上次建到一半、账本丢了）：直接认领，别再建一个。
    const existingID = findCharacterByName(deps, name, options.accountId);
    if (existingID) {
      const warehouse = {characterID: existingID, name, stationID, createdAt: now()};
      stockStore.setWarehouse(warehouse);
      log(`[stock] 认领已有仓库角色：${name}（${existingID}）@ ${stationID}`);
      return {ok: true, created: false, adopted: true, warehouse};
    }
    const check = nameCheck(deps, taken, name);
    if (!check.ok) {
      rejected.push(`${name}:${check.code}`);
      continue;
    }
    try {
      const member = pool.createMember(deps, {
        name,
        stationID,
        blueprintID: "warehouse",
        accountId: options.accountId,
        ownerAccountID: options.accountId,
        nowMs: now(),
      });
      const warehouse = {
        characterID: Number(member.characterID) || 0,
        name: String(member.name || name),
        stationID,
        createdAt: now(),
      };
      stockStore.setWarehouse(warehouse);
      log(`[stock] 仓库角色已建：${warehouse.name}（${warehouse.characterID}）@ ${stationID}`);
      return {ok: true, created: true, warehouse};
    } catch (error) {
      problem = error && error.message;
    }
  }
  return {ok: false, problem: problem || `NAME_UNAVAILABLE${rejected.length ? `(${rejected.join(",")})` : ""}`};
}

function itemOf(deps, itemID) {
  const id = Number(itemID) || 0;
  if (!id) {
    return null;
  }
  try {
    if (deps.itemStore && typeof deps.itemStore.findItemById === "function") {
      return deps.itemStore.findItemById(id);
    }
  } catch (_error) {
    return null;
  }
  return null;
}

function transferShip(deps, request = {}) {
  const shipID = Number(request.shipID) || 0;
  const characterID = Number(request.characterID) || 0;
  const stationID = Number(request.stationID) || 0;
  if (!shipID || !characterID || !stationID) {
    return {ok: false, error: "BAD_TRANSFER_REQUEST"};
  }
  if (!deps.itemStore || typeof deps.itemStore.transferItemToOwnerLocation !== "function") {
    return {ok: false, error: "NO_TRANSFER_API"};
  }
  try {
    // reownContents：连船里的模块/弹药一起过户。不加这个开关时服务端只改船体那一行，
    // 模块仍属于原主人 → 按 owner 过滤的读（详情页、snapshotFit）会看到"没装配的船壳"。
    const result = deps.itemStore.transferItemToOwnerLocation(
      shipID,
      characterID,
      stationID,
      HANGAR_FLAG,
      null,
      {reownContents: true},
    );
    if (result && result.success === true) {
      return {ok: true};
    }
    return {ok: false, error: (result && result.errorMsg) || "TRANSFER_FAILED"};
  } catch (error) {
    return {ok: false, error: `TRANSFER_FAILED:${error && error.message}`};
  }
}

/**
 * 补过户：把一艘船里所有东西的 ownerID 改成新主人（用于修复 0.6.35 之前转过的船）。
 * 只动 owner，不动物品位置/flag，所以装配关系不变。
 */
function reownShipContents(deps, request = {}) {
  const shipID = Number(request.shipID) || 0;
  const characterID = Number(request.characterID) || 0;
  if (!shipID || !characterID) {
    return {ok: false, error: "BAD_REOWN_REQUEST", moved: 0};
  }
  if (!deps.itemStore || typeof deps.itemStore.listContainerItems !== "function"
    || typeof deps.itemStore.transferItemToOwnerLocation !== "function") {
    return {ok: false, error: "NO_ITEM_API", moved: 0};
  }
  let items = [];
  try {
    items = deps.itemStore.listContainerItems(null, shipID) || [];
  } catch (error) {
    return {ok: false, error: `LIST_FAILED:${error && error.message}`, moved: 0};
  }
  let moved = 0;
  const failed = [];
  for (const item of items) {
    if (!item || Number(item.itemID) <= 0) {
      continue;
    }
    if (Number(item.ownerID) === characterID) {
      continue;
    }
    try {
      const result = deps.itemStore.transferItemToOwnerLocation(
        item.itemID,
        characterID,
        shipID,
        Number(item.flagID) || HANGAR_FLAG,
        null,
        {},
      );
      if (result && result.success === true) {
        moved += 1;
      } else {
        failed.push(`${item.itemID}:${(result && result.errorMsg) || "FAILED"}`);
      }
    } catch (error) {
      failed.push(`${item.itemID}:${error && error.message}`);
    }
  }
  return {ok: failed.length === 0, moved, failed};
}

function dockShip(deps, request = {}) {
  const shipID = Number(request.shipID) || 0;
  const stationID = Number(request.stationID) || 0;
  if (!shipID || !stationID) {
    return {ok: false, error: "BAD_DOCK_REQUEST"};
  }
  if (!deps.itemStore || typeof deps.itemStore.dockShipToStation !== "function") {
    return {ok: false, error: "NO_DOCK_API"};
  }
  try {
    const result = deps.itemStore.dockShipToStation(shipID, stationID);
    if (result && result.success === true) {
      return {ok: true};
    }
    return {ok: false, error: (result && result.errorMsg) || "DOCK_FAILED"};
  } catch (error) {
    return {ok: false, error: `DOCK_FAILED:${error && error.message}`};
  }
}

function setActiveShip(deps, request = {}) {
  const shipID = Number(request.shipID) || 0;
  const characterID = Number(request.characterID) || 0;
  if (!shipID || !characterID) {
    return {ok: false, error: "BAD_ACTIVE_REQUEST"};
  }
  if (!deps.itemStore || typeof deps.itemStore.setActiveShipForCharacter !== "function") {
    return {ok: false, error: "NO_ACTIVE_API"};
  }
  try {
    const result = deps.itemStore.setActiveShipForCharacter(characterID, shipID);
    if (result && result.success === true) {
      return {ok: true};
    }
    return {ok: false, error: (result && result.errorMsg) || "ACTIVE_FAILED"};
  } catch (error) {
    return {ok: false, error: `ACTIVE_FAILED:${error && error.message}`};
  }
}

/** 玩家/仓库角色在某个空间站机库里的船（只列装好的：singleton=1）。 */
function hangarShips(deps, request = {}) {
  const characterID = Number(request.characterID) || 0;
  const stationID = Number(request.stationID) || 0;
  if (!characterID || !stationID || !deps.itemStore || typeof deps.itemStore.listContainerItems !== "function") {
    return [];
  }
  let rows = [];
  try {
    rows = deps.itemStore.listContainerItems(characterID, stationID) || [];
  } catch (_error) {
    rows = [];
  }
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && Number(row.categoryID) === SHIP_CATEGORY_ID && Number(row.singleton) === 1)
    .map((row) => ({
      itemID: Number(row.itemID) || 0,
      typeID: Number(row.typeID) || 0,
      name: String(row.itemName || ""),
      locationID: Number(row.locationID) || 0,
      ownerID: Number(row.ownerID) || 0,
    }));
}

module.exports = {
  WAREHOUSE_STATION_ID,
  WAREHOUSE_SUFFIX,
  HANGAR_FLAG,
  SHIP_CATEGORY_ID,
  sanitizeName,
  warehouseNameFor,
  nameCandidates,
  ensureWarehouse,
  characterExists,
  itemOf,
  transferShip,
  reownShipContents,
  dockShip,
  setActiveShip,
  hangarShips,
};
