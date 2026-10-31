"use strict";

// 遥修：护盾 / 装甲 / 船体远程维修 + 远程电容传输。
// 计划书：docs/archive/遥修实现计划书.md（P0–P3）。
//
// 全部**按组识别**（组 ID 来自本机 SDE 的 groups.jsonl）：
//   41   Remote Shield Booster          (+1697 辅助型)   → 护盾遥修
//   325  Remote Armor Repairer          (+1698 辅助型)   → 装甲遥修
//   585  Remote Hull Repairer                            → 船体遥修
//   67   Remote Capacitor Transmitter                    → 电容传输
//
// 激活走引擎自己的 `activateGenericModule(session, module, effect, {targetID})`：
// 引擎负责锁定校验、射程、`disallowAssistance`（堡垒/会战收不到遥修）、
// `maxGroupActive` 上限和每周期结算（assistanceModuleRuntime）。这里只决定
// 「修谁、什么时候停、谁来修」。

const FAMILY_SHIELD = "remoteShield";
const FAMILY_ARMOR = "remoteArmor";
const FAMILY_HULL = "remoteHull";
const FAMILY_CAPACITOR = "remoteCapacitor";

const FAMILIES = Object.freeze({
  [FAMILY_SHIELD]: {groups: [41, 1697], label: "护盾遥修", layer: "shield", moduleLabel: "远程护盾回充"},
  [FAMILY_ARMOR]: {groups: [325, 1698], label: "装甲遥修", layer: "armor", moduleLabel: "远程装甲维修"},
  [FAMILY_HULL]: {groups: [585], label: "船体遥修", layer: "structure", moduleLabel: "远程船体维修"},
  [FAMILY_CAPACITOR]: {groups: [67], label: "电容传输", layer: "capacitor", moduleLabel: "远程电容传输"},
});

const GROUP_TO_FAMILY = new Map();
for (const [family, spec] of Object.entries(FAMILIES)) {
  for (const groupID of spec.groups) {
    GROUP_TO_FAMILY.set(Number(groupID), family);
  }
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return null;
  }
  return Math.min(Math.max(number, 0), 1);
}

function familyOf(moduleItem) {
  return GROUP_TO_FAMILY.get(Number(moduleItem && moduleItem.groupID) || 0) || "";
}

function familySpec(family) {
  return FAMILIES[family] || null;
}

/** 装了遥修模块的条目：[{moduleItem, family, spec}]。 */
function findRemoteModules(deps, request = {}) {
  const fitting = deps && deps.fitting;
  if (!fitting || typeof fitting.getFittedModuleItems !== "function") {
    return [];
  }
  let items = [];
  try {
    items = fitting.getFittedModuleItems(positive(request.characterID), positive(request.shipID)) || [];
  } catch (_error) {
    items = [];
  }
  const rows = [];
  for (const moduleItem of items) {
    const family = familyOf(moduleItem);
    if (!family) {
      continue;
    }
    if (typeof fitting.isModuleOnline === "function" && !fitting.isModuleOnline(moduleItem)) {
      continue;
    }
    rows.push({moduleItem, family, spec: familySpec(family)});
  }
  return rows;
}

/** 这一层还剩多少（0..1）。血量口径与 buildCrewDetail 的 health 完全一致。 */
function healthOf(entity) {
  const state = (entity && entity.conditionState) || {};
  const shield = clamp01(state.shieldCharge);
  const armorDamage = clamp01(state.armorDamage);
  const structureDamage = clamp01(state.structureDamage);
  const capacitor = clamp01(entity && entity.capacitorChargeRatio);
  return {
    shield: {
      ratio: shield === null ? 1 : shield,
      cur: Math.round((Number(entity && entity.shieldCapacity) || 0) * (shield === null ? 1 : shield)),
      max: Math.round(Number(entity && entity.shieldCapacity) || 0),
    },
    armor: {
      ratio: armorDamage === null ? 1 : 1 - armorDamage,
      cur: Math.round((Number(entity && entity.armorHP) || 0) * (armorDamage === null ? 1 : 1 - armorDamage)),
      max: Math.round(Number(entity && entity.armorHP) || 0),
    },
    structure: {
      ratio: structureDamage === null ? 1 : 1 - structureDamage,
      cur: Math.round((Number(entity && entity.structureHP) || 0) * (structureDamage === null ? 1 : 1 - structureDamage)),
      max: Math.round(Number(entity && entity.structureHP) || 0),
    },
    capacitor: {
      ratio: capacitor === null ? 1 : capacitor,
      cur: 0,
      max: 0,
    },
  };
}

function layerRatio(health, layer) {
  const row = health && health[layer];
  const ratio = Number(row && row.ratio);
  return Number.isFinite(ratio) ? ratio : 1;
}

/**
 * 挑目标（docs §4.2）：
 *   候选 = 白名单内、该层低于 start、在射程内、没被别人认领
 *   排序 = 该层百分比最低 → 距离最近 → 玩家优先（同分时）
 */
/**
 * 所有够格的候选（按「该层最低 → 距离最近 → 玩家优先」排好序）。
 * 与 pickTarget 同一套过滤规则，只是返回整个列表，供多模块分配使用。
 */
function pickTargets(request = {}) {
  const family = String(request.family || "");
  const spec = familySpec(family);
  if (!spec) {
    return [];
  }
  const layer = spec.layer;
  const startPercent = Number.isFinite(Number(request.startPercent)) ? Number(request.startPercent) : 0.8;
  const limit = Number.isFinite(Number(request.limit)) && Number(request.limit) > 0
    ? Math.floor(Number(request.limit))
    : Number.MAX_SAFE_INTEGER;
  const candidates = Array.isArray(request.candidates) ? request.candidates : [];
  const claimed = request.claimed instanceof Set ? request.claimed : new Set();
  const rows = [];
  for (const candidate of candidates) {
    if (!candidate || !candidate.entity) {
      continue;
    }
    const entity = candidate.entity;
    if (entity.itemID && Number(entity.itemID) === Number(request.selfShipID)) {
      continue;
    }
    if (String(entity.mode || "").toUpperCase() === "WARP") {
      continue;
    }
    if (candidate.inSiege === true) {
      continue;
    }
    const key = `${family}:${Number(entity.itemID)}`;
    if (claimed.has(key)) {
      continue;
    }
    const range = Number(candidate.rangeMeters) || 0;
    const distance = Number(candidate.distanceMeters);
    if (range > 0 && Number.isFinite(distance) && distance > range) {
      continue;
    }
    const ratio = layerRatio(candidate.health || healthOf(entity), layer);
    if (ratio >= startPercent) {
      continue;
    }
    rows.push({...candidate, ratio});
  }
  rows.sort((left, right) => {
    const epsilon = 1e-6;
    if (Math.abs(left.ratio - right.ratio) > epsilon) {
      return left.ratio - right.ratio;
    }
    if (left.isPlayer !== right.isPlayer) {
      return left.isPlayer === true ? -1 : 1;
    }
    const dl = Number.isFinite(Number(left.distanceMeters)) ? Number(left.distanceMeters) : Number.MAX_SAFE_INTEGER;
    const dr = Number.isFinite(Number(right.distanceMeters)) ? Number(right.distanceMeters) : Number.MAX_SAFE_INTEGER;
    return dl - dr;
  });
  return rows.slice(0, Math.min(limit, rows.length));
}

function pickTarget(request = {}) {
  const family = String(request.family || "");
  const spec = familySpec(family);
  if (!spec) {
    return null;
  }
  const layer = spec.layer;
  const startPercent = Number.isFinite(Number(request.startPercent)) ? Number(request.startPercent) : 0.8;
  const candidates = Array.isArray(request.candidates) ? request.candidates : [];
  const claimed = request.claimed instanceof Set ? request.claimed : new Set();
  let best = null;
  for (const candidate of candidates) {
    if (!candidate || !candidate.entity) {
      continue;
    }
    const entity = candidate.entity;
    if (entity.itemID && Number(entity.itemID) === Number(request.selfShipID)) {
      continue; // 不自修（本地维修是 Defense.js 的事）
    }
    if (String(entity.mode || "").toUpperCase() === "WARP") {
      continue;
    }
    if (candidate.inSiege === true) {
      continue; // 堡垒/会战收不到遥修，引擎也会拒
    }
    const key = `${family}:${Number(entity.itemID)}`;
    if (claimed.has(key)) {
      continue;
    }
    const range = Number(candidate.rangeMeters) || 0;
    const distance = Number(candidate.distanceMeters);
    if (range > 0 && Number.isFinite(distance) && distance > range) {
      continue;
    }
    const ratio = layerRatio(candidate.health || healthOf(entity), layer);
    if (ratio >= startPercent) {
      continue;
    }
    if (!best) {
      best = {candidate, ratio, distance: Number.isFinite(distance) ? distance : Number.MAX_SAFE_INTEGER};
      continue;
    }
    const epsilon = 1e-6;
    if (ratio < best.ratio - epsilon) {
      best = {candidate, ratio, distance: Number.isFinite(distance) ? distance : Number.MAX_SAFE_INTEGER};
    } else if (Math.abs(ratio - best.ratio) <= epsilon) {
      if (candidate.isPlayer === true && best.candidate.isPlayer !== true) {
        best = {candidate, ratio, distance: Number.isFinite(distance) ? distance : Number.MAX_SAFE_INTEGER};
      } else if (candidate.isPlayer === best.candidate.isPlayer) {
        const distance = Number.isFinite(Number(candidate.distanceMeters)) ? Number(candidate.distanceMeters) : Number.MAX_SAFE_INTEGER;
        if (distance < best.distance) {
          best = {candidate, ratio, distance};
        }
      }
    }
  }
  return best ? {...best.candidate, ratio: best.ratio} : null;
}

function activate(request = {}) {
  const scene = request.scene;
  const entity = request.entity;
  const moduleItem = request.moduleItem;
  if (!scene || typeof scene.activateGenericModule !== "function") {
    return {ok: false, reason: "NO_ACTIVATION_API"};
  }
  if (!entity || !moduleItem) {
    return {ok: false, reason: "NO_SHIP_OR_MODULE"};
  }
  const view = Number(moduleItem.locationID) === Number(entity.itemID)
    ? moduleItem
    : {...moduleItem, locationID: Number(entity.itemID)};
  let result = null;
  try {
    result = scene.activateGenericModule(request.session, view, String(request.effectName || "") || null, {
      targetID: positive(request.targetID),
    });
  } catch (error) {
    return {ok: false, reason: `ACTIVATION_FAILED:${error && error.message}`};
  }
  if (!result || result.success !== true) {
    return {ok: false, reason: String((result && result.errorMsg) || "ACTIVATION_FAILED")};
  }
  return {ok: true};
}

function effectStateOf(entity, moduleID) {
  const effects = entity && entity.activeModuleEffects;
  if (!(effects instanceof Map)) {
    return null;
  }
  return effects.get(positive(moduleID)) || null;
}

function isActive(entity, moduleID) {
  return Boolean(effectStateOf(entity, moduleID));
}

function deactivate(request = {}) {
  const scene = request.scene;
  const moduleID = positive(request.moduleID);
  if (!scene || typeof scene.deactivateGenericModule !== "function" || !moduleID) {
    return {ok: false, reason: "NO_DEACTIVATION_API"};
  }
  if (!isActive(request.entity, moduleID)) {
    return {ok: true, alreadyOff: true};
  }
  try {
    scene.deactivateGenericModule(request.session, moduleID, {reason: "npc", deferUntilCycle: false});
  } catch (error) {
    return {ok: false, reason: `DEACTIVATION_FAILED:${error && error.message}`};
  }
  return {ok: true};
}

module.exports = {
  FAMILY_SHIELD,
  FAMILY_ARMOR,
  FAMILY_HULL,
  FAMILY_CAPACITOR,
  FAMILIES,
  GROUP_TO_FAMILY,
  familyOf,
  familySpec,
  findRemoteModules,
  healthOf,
  layerRatio,
  pickTarget,
  pickTargets,
  activate,
  deactivate,
  effectStateOf,
  isActive,
};
