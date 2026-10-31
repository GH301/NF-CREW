"use strict";

// 攻击类与辅助类主动装备（PLAN §20 的 B / C 两类）。
//
// 用户口径（2026-10-20）：
//   A 回血类（护盾/装甲/注电）走"血量阈值自动" —— 那是 `nfCrewMiningDefense.js` 的事；
//   B 只做**立体炸弹**（隐形、微跃迁不做）；
//   C EWAR / 吸电 / 中和 / 指挥脉冲 **船员自己用**；遥修（远程维修/传电）暂时搁置。
//
// 全部走引擎自己的 `activateGenericModule`：EWAR 的 hostileModuleState、吸电/中和的电容、
// 立体炸弹的范围伤害、指挥脉冲的舰队 buff 都由引擎按 SDE 数据结算，我们只负责
// "什么时候、对谁"这两个决定。这与 §18 的取舍一致（不复制引擎逻辑）。
//
// 组 ID 来自本机 SDE 的 groups.jsonl（category 7 = 装备）。

const FAMILY_SMARTBOMB = "smartbomb";
const FAMILY_WEB = "web";
const FAMILY_SCRAM = "scram";
const FAMILY_NEUT = "neut";
const FAMILY_NOS = "nos";
const FAMILY_ECM = "ecm";
const FAMILY_SENSOR_DAMP = "sensorDamp";
const FAMILY_TRACKING_DISRUPT = "trackingDisrupt";
const FAMILY_PAINTER = "painter";
const FAMILY_COMMAND_BURST = "commandBurst";

/**
 * groupID -> family. `mode` says how the family is driven:
 *   target = needs an enemy target (EWAR / 吸电 / 中和)
 *   self   = no target: 立体炸弹（范围）、指挥脉冲（舰队 buff）
 */
const FAMILIES = Object.freeze({
  [FAMILY_SMARTBOMB]: {groups: [72], mode: "self", label: "立体炸弹", area: true},
  [FAMILY_WEB]: {groups: [65, 1672], mode: "target", label: "停滞缠绕"},
  [FAMILY_SCRAM]: {groups: [52], mode: "target", label: "跃迁扰乱"},
  [FAMILY_NEUT]: {groups: [71], mode: "target", label: "能量中和"},
  [FAMILY_NOS]: {groups: [68], mode: "target", label: "掠能器"},
  [FAMILY_ECM]: {groups: [201], mode: "target", label: "ECM"},
  [FAMILY_SENSOR_DAMP]: {groups: [208], mode: "target", label: "感应抑阻"},
  [FAMILY_TRACKING_DISRUPT]: {groups: [291], mode: "target", label: "武器扰断"},
  [FAMILY_PAINTER]: {groups: [379], mode: "target", label: "目标标记"},
  [FAMILY_COMMAND_BURST]: {groups: [1770, 842], mode: "self", label: "指挥脉冲"},
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

function familyOf(moduleItem) {
  return GROUP_TO_FAMILY.get(Number(moduleItem && moduleItem.groupID) || 0) || "";
}

function familySpec(family) {
  return FAMILIES[family] || null;
}

function isTargetFamily(family) {
  const spec = familySpec(family);
  return Boolean(spec && spec.mode === "target");
}

/** 装有主动装备的模块（带 family）。 */
function findActiveModules(deps, request = {}) {
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
  const result = [];
  for (const moduleItem of items) {
    const family = familyOf(moduleItem);
    if (!family) {
      continue;
    }
    if (typeof fitting.isModuleOnline === "function" && !fitting.isModuleOnline(moduleItem)) {
      continue;
    }
    result.push({moduleItem, family, spec: familySpec(family)});
  }
  return result;
}

/** 模块的最远作用距离（米）。0 = 未知，调用方不该用它来拒绝。 */
function rangeMetersFor(deps, moduleItem) {
  const fitting = deps && deps.fitting;
  const typeID = positive(moduleItem && moduleItem.typeID);
  if (!fitting || !typeID || typeof fitting.getTypeEffectRecords !== "function") {
    return 0;
  }
  let best = 0;
  try {
    for (const record of fitting.getTypeEffectRecords(typeID) || []) {
      const optimal = Number(record && record.optimalRange) || 0;
      if (optimal > best) {
        best = optimal;
      }
    }
  } catch (_error) {
    return 0;
  }
  return best;
}

function effectStateFor(entity, moduleID) {
  const effects = entity && entity.activeModuleEffects;
  if (!(effects instanceof Map)) {
    return null;
  }
  return effects.get(positive(moduleID)) || null;
}

function isActive(entity, moduleID) {
  return Boolean(effectStateFor(entity, moduleID));
}

/** 激活一个模块（target 类要 targetID；self 类不要）。 */
function activate(request = {}) {
  const scene = request.scene;
  const session = request.session;
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
  const options = positive(request.targetID) ? {targetID: positive(request.targetID)} : {};
  let result = null;
  try {
    result = scene.activateGenericModule(session, view, String(request.effectName || "") || null, options);
  } catch (error) {
    return {ok: false, reason: `ACTIVATION_FAILED:${error && error.message}`};
  }
  if (!result || result.success !== true) {
    return {ok: false, reason: String((result && result.errorMsg) || "ACTIVATION_FAILED")};
  }
  return {ok: true};
}

function deactivate(request = {}) {
  const scene = request.scene;
  const session = request.session;
  const entity = request.entity;
  const moduleID = positive(request.moduleID);
  if (!scene || typeof scene.deactivateGenericModule !== "function") {
    return {ok: false, reason: "NO_DEACTIVATION_API"};
  }
  if (!entity || !moduleID) {
    return {ok: false, reason: "BAD_REQUEST"};
  }
  if (!isActive(entity, moduleID)) {
    return {ok: true, alreadyOff: true};
  }
  try {
    scene.deactivateGenericModule(session, moduleID, {reason: "manual", deferUntilCycle: false});
  } catch (error) {
    return {ok: false, reason: `DEACTIVATION_FAILED:${error && error.message}`};
  }
  return {ok: true};
}

module.exports = {
  FAMILIES,
  FAMILY_SMARTBOMB,
  FAMILY_WEB,
  FAMILY_SCRAM,
  FAMILY_NEUT,
  FAMILY_NOS,
  FAMILY_ECM,
  FAMILY_SENSOR_DAMP,
  FAMILY_TRACKING_DISRUPT,
  FAMILY_PAINTER,
  FAMILY_COMMAND_BURST,
  GROUP_TO_FAMILY,
  familyOf,
  familySpec,
  isTargetFamily,
  findActiveModules,
  rangeMetersFor,
  effectStateFor,
  isActive,
  activate,
  deactivate,
};
