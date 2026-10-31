"use strict";

// 方案 A：特殊模块（组 515）的**燃料补给**。
// 计划书：docs/修复计划书-燃料弹药回血.md 的 F1。
//
// 引擎事实（已查证）：
//   激活时扣一次：`scene/modules.js:2444`
//   **每个周期边界再扣一次**：`scene/tick.js:1474-1481`，扣不到就静默关模块（reason: fuel）
//   所以补料必须按「能装几轮」补满，而不是补一次。
//
// 燃料舱：船的 `specialFuelBayCapacity`（属性 1549）> 0 才有，flag = **133**，
// 且该舱只收 Ice Product 组（423）—— 锶包合物 16275 / 重水 16272 都在组里。
// 没有燃料舱的船（普通挖矿船）回落到货舱 flag 5。

const FUEL_ATTRIBUTE_TYPE = 713;      // consumptionType
const FUEL_ATTRIBUTE_QUANTITY = 714;  // consumptionQuantity
const FUEL_BAY_FLAG = 133;            // ship special fuel bay
const CARGO_HOLD_FLAG = 5;
const FUEL_BAY_ATTRIBUTE_ID = 1549;   // specialFuelBayCapacity
const MAX_GRANT_PER_CALL = 1250;      // 单次写入上限：大数量拆开写，避免一次卡住 itemStore

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function sdeOf(deps) {
  const sde = deps && deps.sde;
  return sde && typeof sde.loadDogmaAttributes === "function" ? sde : null;
}

/** 读模块某一侧的 dogma 数值（sde.loadDogmaAttributes 返回 Map 或普通对象）。 */
function dogmaValue(deps, typeID, attributeID) {
  const sde = sdeOf(deps);
  const id = positive(typeID);
  if (!sde || !id) {
    return 0;
  }
  let map = null;
  try {
    map = sde.loadDogmaAttributes([id]);
  } catch (_error) {
    return 0;
  }
  if (!map) {
    return 0;
  }
  const row = typeof map.get === "function" ? map.get(id) : map[id];
  if (!row) {
    return 0;
  }
  const raw = typeof row.get === "function" ? row.get(attributeID) : row[attributeID];
  const value = raw && typeof raw === "object" ? (raw.value ?? raw.defaultValue) : raw;
  return positive(value);
}

/** 这个模块每次激活/每轮要吃什么、吃多少；不要燃料返回 null。 */
const fuelNeedCache = new Map(); // typeID -> {typeID, quantity} | null（SDE 静态数据，按型号缓存）
function fuelNeedFor(deps, moduleItem) {
  const typeID = positive(moduleItem && moduleItem.typeID);
  if (!typeID || !sdeOf(deps)) {
    return null;
  }
  if (fuelNeedCache.has(typeID)) {
    return fuelNeedCache.get(typeID);
  }
  const fuelTypeID = dogmaValue(deps, typeID, FUEL_ATTRIBUTE_TYPE);
  const quantity = dogmaValue(deps, typeID, FUEL_ATTRIBUTE_QUANTITY);
  const need = !fuelTypeID || !quantity ? null : {typeID: fuelTypeID, quantity};
  fuelNeedCache.set(typeID, need);
  return need;
}

/** 船的燃料舱容量（属性 1549）；0 = 没有燃料舱。 */
function fuelBayCapacityOf(entity) {
  if (!entity) {
    return 0;
  }
  const direct = finite(entity.specialFuelBayCapacity);
  if (direct > 0) {
    return direct;
  }
  const attributes = entity.passiveDerivedState && entity.passiveDerivedState.attributes;
  const value = finite(attributes && attributes[FUEL_BAY_ATTRIBUTE_ID]);
  return value > 0 ? value : 0;
}

/** 燃料该放哪个舱：有燃料舱就 133，没有才回落货舱 5。 */
function fuelStorageFlagFor(entity) {
  return fuelBayCapacityOf(entity) > 0 ? FUEL_BAY_FLAG : CARGO_HOLD_FLAG;
}

/** 指定舱位里现有多少单位这种燃料。 */
function fuelInStorage(deps, request = {}) {
  const itemStore = deps && deps.itemStore;
  const fuelTypeID = positive(request.fuelTypeID);
  const characterID = positive(request.characterID);
  const shipID = positive(request.shipID);
  const flagID = positive(request.flagID);
  if (!itemStore || typeof itemStore.listContainerItems !== "function" || !fuelTypeID) {
    return 0;
  }
  let items = [];
  try {
    items = itemStore.listContainerItems(characterID, shipID) || [];
  } catch (_error) {
    items = [];
  }
  let total = 0;
  for (const item of items) {
    if (!item || positive(item.typeID) !== fuelTypeID) {
      continue;
    }
    if (flagID > 0 && positive(item.flagID) !== flagID) {
      continue;
    }
    total += Math.max(0, Number(item.quantity) || 0);
  }
  return total;
}

/** 兼容旧名：全舱合计（不区分 flag）。 */
function fuelInCargo(deps, request = {}) {
  return fuelInStorage(deps, {...request, flagID: 0});
}

function typeVolumeOf(deps, typeID) {
  const record = typeof (deps && deps.resolveItemByTypeID) === "function"
    ? deps.resolveItemByTypeID(typeID)
    : null;
  return {record, volume: Math.max(0, finite(record && record.volume))};
}

/**
 * 补燃料。按"燃料舱能装几轮"补满，而不是补一轮。
 * 返回：{ok, skipped, reason, typeID, perCycle, perCycleVolume, targetCycles,
 *        cyclesLeft, cyclesMax, bayFlag, granted, volume, have, want}
 */
function ensureFuel(deps, request = {}) {
  const base = {
    ok: true,
    skipped: false,
    needsFuel: true, // false = 该模块本身不消耗燃料（堡垒等），调用方应直接跳过
    reason: null,
    typeID: 0,
    perCycle: 0,
    perCycleVolume: 0,
    targetCycles: 0,
    cyclesLeft: 0,
    cyclesMax: 0,
    bayFlag: 0,
    granted: 0,
    volume: 0,
    have: 0,
    want: 0,
  };
  if (!sdeOf(deps)) {
    // 以前这里会静默 skipped，症状是"启动失败：NO_FUEL" —— 不允许再发生。
    return {...base, ok: false, reason: "NO_SDE"};
  }
  const need = fuelNeedFor(deps, request.moduleItem);
  if (!need) {
    // 堡垒（33400/94010）这类模块没有 713/714：不是“燃料空了”，而是**不需要燃料**。
    // 以前这里返回 skipped + cyclesLeft=0，调用方把 cyclesLeft<=0 当成“燃料已空”，
    // 于是每 10 秒刷一条“燃料已空（补料失败）”。用 needsFuel=false 明确区分。
    return {...base, needsFuel: false, skipped: true, reason: "NO_FUEL_REQUIRED"};
  }
  const perCycle = need.quantity;
  const {record: typeRecord, volume: unitVolume} = typeVolumeOf(deps, need.typeID);
  if (!typeRecord) {
    return {...base, ok: false, reason: `UNKNOWN_FUEL_TYPE:${need.typeID}`, typeID: need.typeID, perCycle};
  }
  const perCycleVolume = unitVolume * perCycle;
  const entity = request.entity || null;
  const bayCapacity = fuelBayCapacityOf(entity);
  const bayFlag = fuelStorageFlagFor(entity);
  let cyclesMax = 0;
  if (bayCapacity > 0 && perCycleVolume > 0) {
    cyclesMax = Math.floor(bayCapacity / perCycleVolume);
  }
  const requestedCycles = positive(request.targetCycles) || positive(request.cycles) || 0;
  // 目标轮数：优先用调用方给的，其次按燃料舱容量补满，都没有就 1 轮。
  let targetCycles = requestedCycles;
  if (targetCycles <= 0) {
    targetCycles = cyclesMax > 0 ? cyclesMax : 1;
  }
  if (cyclesMax > 0) {
    targetCycles = Math.min(targetCycles, cyclesMax);
  }
  const want = perCycle * Math.max(1, targetCycles);
  const have = fuelInStorage(deps, {
    characterID: request.characterID,
    shipID: request.shipID,
    fuelTypeID: need.typeID,
    flagID: bayFlag,
  });
  const result = {
    ...base,
    typeID: need.typeID,
    perCycle,
    perCycleVolume: Math.round(perCycleVolume * 100) / 100,
    targetCycles: Math.max(1, targetCycles),
    cyclesMax,
    cyclesLeft: perCycle > 0 ? Math.floor(have / perCycle) : 0,
    bayFlag,
    have,
    want,
  };
  // 调用方可以要求「低于最小需求才补」（minimumCycles=1 → 仓里不足一轮就不管）：
  // 战斗模块一轮吃 250，仓里还有 8 轮时没必要每 15 秒检查一次并补满。
  const minimumCycles = Math.max(0, Number(request.minimumCycles) || 0);
  if (minimumCycles > 0) {
    const minimum = perCycle * minimumCycles;
    result.minimum = minimum;
    if (have >= minimum) {
      return {...result, skipped: true, reason: "ABOVE_MINIMUM"};
    }
  }
  if (have >= want) {
    return result;
  }
  const itemStore = deps && deps.itemStore;
  if (!itemStore || typeof itemStore.grantItemToOwnerLocation !== "function") {
    return {...result, ok: false, reason: "NO_ITEM_STORE"};
  }
  let remaining = want - have;
  let granted = 0;
  while (remaining > 0) {
    const chunk = Math.min(MAX_GRANT_PER_CALL, remaining);
    let grantedResult = null;
    try {
      grantedResult = itemStore.grantItemToOwnerLocation(
        positive(request.characterID),
        positive(request.shipID),
        bayFlag,
        typeRecord,
        chunk,
        {},
      );
    } catch (error) {
      return {...result, ok: false, reason: `GRANT_FAILED:${error && error.message}`, granted};
    }
    if (!grantedResult || grantedResult.success !== true) {
      return {
        ...result,
        ok: false,
        reason: `GRANT_FAILED:${(grantedResult && grantedResult.errorMsg) || "UNKNOWN"}`,
        granted,
      };
    }
    granted += chunk;
    remaining -= chunk;
  }
  return {
    ...result,
    granted,
    have: have + granted,
    cyclesLeft: perCycle > 0 ? Math.floor((have + granted) / perCycle) : 0,
    volume: Math.round(granted * unitVolume * 100) / 100,
  };
}

module.exports = {
  CARGO_HOLD_FLAG,
  FUEL_BAY_FLAG,
  FUEL_BAY_ATTRIBUTE_ID,
  FUEL_ATTRIBUTE_TYPE,
  FUEL_ATTRIBUTE_QUANTITY,
  dogmaValue,
  fuelNeedFor,
  fuelBayCapacityOf,
  fuelStorageFlagFor,
  fuelInStorage,
  fuelInCargo,
  ensureFuel,
};
