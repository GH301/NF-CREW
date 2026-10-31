"use strict";

// 会战/堡垒模式（模块组 515：Siege Module 20280 系列、Bastion Module 33400 系列）。
//
// The crew never decides this on its own — exactly like the doomsday weapon, the player
// turns it on and off (panel button / `/crewmine siege on|off`). The module itself is
// fitted from the blueprint; this module only finds it, tells siege from bastion, and
// drives the engine's own activation path.
//
// Why the effect name matters: `scene.activateGenericModule(session, item, effectName)`
// resolves the effect by NAME on that type. Passing the type's real effect name keeps us
// off the "first activatable effect" fallback, which would be wrong for any hull that
// carries several effects.

const MODE_GROUP_ID = 515;

/** The families in group 515 and the effect each one activates. */
const MODE_KINDS = Object.freeze({
  siege: {
    effectName: "moduleBonusSiegeModule",
    label: "会战模式",
    moduleLabel: "会战装备",
    // §18.6 惩罚清单：面板上直接写出来，玩家点之前就知道会发生什么。
    penalty: ["定身（不能移动/跟随）", "禁止跃迁", "信号半径放大"],
  },
  bastion: {
    effectName: "moduleBonusBastionModule",
    label: "堡垒模式",
    moduleLabel: "堡垒装备",
    penalty: ["定身（不能移动/跟随）", "禁止跃迁", "禁止对接/系泊", "信号半径放大"],
  },
  // 后勤航母（FAX）的 Triage：和会战同一组，效果不同（远程维修/传电大幅强化，但定身）。
  triage: {
    effectName: "moduleBonusTriageModule",
    label: "后勤模式",
    moduleLabel: "后勤装备",
    penalty: ["定身（不能移动/跟随）", "禁止跃迁", "禁止对接/系泊", "信号半径放大", "不能接受远程援助"],
  },
  // 工业核心（旗舰/大型/中型）：同样是组 515，定身 + 禁止跃迁/对接。
  industrialCore: {
    effectName: "moduleBonusIndustrialCore",
    label: "工业核心模式",
    moduleLabel: "工业核心",
    penalty: ["定身（不能移动/跟随）", "禁止跃迁", "禁止对接/系泊", "信号半径放大"],
  },
  // 组驱动兜底：组 515 里没认出来的型号照样能开关，文案退化成通用。
  special515: {
    effectName: "",
    label: "特殊模式",
    moduleLabel: "组 515 特殊装备",
    penalty: ["定身/禁止跃迁等由模块自身决定（未识别型号）"],
  },
});

const MODE_EFFECT_PATTERN = new RegExp(
  Object.values(MODE_KINDS)
    .map((info) => String(info.effectName || "").toLowerCase())
    .filter(Boolean)
    .join("|")
  + "|modulebonussiegemodule|modulebonusbastionmodule|modulebonustriagemodule|modulebonusindustrialcore"
  // 本机 SDE 的 dogmaEffects 里没有 effect name 字段（只有 guid），所以按名字认永远认不出来。
  // 这两个 guid 后缀是引擎自己写进 effectState.guid 的，必须一起认。
  + "|siegemode|triagemode",
  "i",
);

// 组 515 的 dogma effect ID（本机 SDE 实测）。引擎判会战用的也是 effectID
// （superweaponRuntime.js:767，SIEGE_MODULE_EFFECT_ID = 6582），不依赖名字。
// 会战和堡垒虽然共用 guid `effects.SiegeMode`，但 effectID 不同，靠这张表区分。
const MODE_EFFECT_KIND_BY_ID = new Map([
  [6582, "siege"], // Siege Module
  [6658, "bastion"], // Bastion Module
  [6581, "triage"], // Triage Module
  [4575, "industrialCore"], // Industrial Core（Rorqual）
  [8119, "industrialCore"], // Industrial Core（Orca / Porpoise）
]);

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

/** A fitted module of group 515 (siege / bastion). */
function isModeModule(item) {
  return Boolean(item) && Number(item.groupID) === MODE_GROUP_ID;
}

/** Every group-515 module fitted on the ship. Missing fitting API => none. */
function findModeModules(deps, request = {}) {
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
  return items.filter(isModeModule);
}

/** The type's own effect names (SDE casing), used to activate it by name. */
function effectNamesOf(deps, typeID) {
  const fitting = deps && deps.fitting;
  if (!fitting || typeof fitting.getTypeEffectRecords !== "function") {
    return [];
  }
  try {
    return (fitting.getTypeEffectRecords(positive(typeID)) || [])
      .map((record) => String((record && (record.name || record.effectName || record.guid)) || ""))
      .filter(Boolean);
  } catch (_error) {
    return [];
  }
}

/**
 * Which family is this? Read from the type's effects first (canonical English names), then
 * from the item name, then fall back to a generic "special515" so any group-515 module is
 * still switchable (group-driven, not whitelist-driven).
 */
function modeKindOf(deps, moduleItem) {
  const effectNames = effectNamesOf(deps, moduleItem && moduleItem.typeID);
  const effectText = effectNames.join(" ").toLowerCase();
  const itemText = String(moduleItem && (moduleItem.itemName || moduleItem.typeName || moduleItem.name) || "").toLowerCase();
  const pick = (kind) => {
    const known = MODE_KINDS[kind];
    const exact = effectNames.find((name) => name.toLowerCase() === known.effectName.toLowerCase());
    return {
      kind,
      effectName: exact || known.effectName,
      label: known.label,
      moduleLabel: known.moduleLabel,
      penalty: [...known.penalty],
    };
  };
  if (effectText.includes("bastion") || itemText.includes("bastion") || itemText.includes("堡垒")) {
    return pick("bastion");
  }
  if (effectText.includes("triage") || itemText.includes("triage")
    || itemText.includes("后勤") || itemText.includes("紧急修复")) {
    return pick("triage");
  }
  if (effectText.includes("industrialcore") || itemText.includes("industrial core")
    || itemText.includes("工业核心")) {
    return pick("industrialCore");
  }
  if (effectText.includes("siege") || itemText.includes("siege")
    || itemText.includes("会战") || itemText.includes("攻城")) {
    return pick("siege");
  }
  // 组 515 的未知型号：仍然可开关，效果名用类型自己声明的那条（引擎激活要靠它）。
  const generic = pick("special515");
  generic.effectName = effectNames.find((name) => /^modulebonus/i.test(name)) || effectNames[0] || "";
  return generic;
}

/** The active mode effect on this entity, if any (siege and bastion both count). */
function activeModeEffectOf(entity) {
  if (!entity || !(entity.activeModuleEffects instanceof Map)) {
    return null;
  }
  for (const effectState of entity.activeModuleEffects.values()) {
    if (!effectState) {
      continue;
    }
    if (effectState.bastionModuleEffect === true) {
      return effectState;
    }
    // 名字可能为空（本机 SDE 没有 effect name），所以先按 effectID 认。
    if (MODE_EFFECT_KIND_BY_ID.has(Number(effectState.effectID) || 0)) {
      return effectState;
    }
    const text = `${effectState.effectName || ""} ${effectState.guid || ""}`;
    if (MODE_EFFECT_PATTERN.test(text)) {
      return effectState;
    }
  }
  return null;
}

/** Is this ship currently in siege/bastion mode? */
function isModeActive(entity) {
  return Boolean(activeModeEffectOf(entity));
}

/** Which one is running: siege / bastion / triage / industrialCore / special515 / "" (none). */
function activeModeKindOf(entity) {
  const effectState = activeModeEffectOf(entity);
  if (!effectState) {
    return "";
  }
  // 1) 引擎给堡垒打的标记最可靠。
  if (effectState.bastionModuleEffect === true) {
    return "bastion";
  }
  // 2) effectID：会战/堡垒/后勤/工业核心各有自己的 effectID（名字可能为空，ID 不会）。
  const byID = MODE_EFFECT_KIND_BY_ID.get(Number(effectState.effectID) || 0);
  if (byID) {
    return byID;
  }
  // 3) guid：会战与堡垒共用 effects.SiegeMode（堡垒上面已按标记分走），后勤是 TriageMode。
  const guid = String(effectState.guid || "").toLowerCase();
  if (guid.includes("triagemode")) {
    return "triage";
  }
  if (guid.includes("siegemode")) {
    return "siege";
  }
  // 4) 名字兜底（有的路径会带 SDE 名字）。
  const text = `${effectState.effectName || ""}`.toLowerCase();
  if (text.includes("modulebonussiegemodule")) {
    return "siege";
  }
  if (text.includes("modulebonusbastionmodule")) {
    return "bastion";
  }
  if (text.includes("modulebonustriagemodule")) {
    return "triage";
  }
  if (text.includes("modulebonusindustrialcore")) {
    return "industrialCore";
  }
  return "special515";
}

/**
 * Turn the mode on. Idempotent: an already-active module is not re-activated (the engine
 * would answer MODULE_ALREADY_ACTIVE anyway).
 */
function activateMode(request = {}) {
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
  if (activeModeEffectOf(entity)) {
    return {ok: true, alreadyActive: true};
  }
  const view = Number(moduleItem.locationID) === Number(entity.itemID)
    ? moduleItem
    : {...moduleItem, locationID: Number(entity.itemID)};
  let result = null;
  try {
    result = scene.activateGenericModule(session, view, String(request.effectName || "") || null, {});
  } catch (error) {
    return {ok: false, reason: `ACTIVATION_FAILED:${error && error.message}`};
  }
  if (!result || result.success !== true) {
    return {ok: false, reason: String((result && result.errorMsg) || "ACTIVATION_FAILED")};
  }
  return {ok: true, alreadyActive: false};
}

/** Turn the mode off (the engine owns the cycle/cooldown rules). */
function deactivateMode(request = {}) {
  const scene = request.scene;
  const session = request.session;
  const entity = request.entity;
  if (!entity) {
    return {ok: false, reason: "NO_SHIP"};
  }
  const state = activeModeEffectOf(entity);
  if (!state) {
    return {ok: true, alreadyOff: true};
  }
  if (!scene || typeof scene.deactivateGenericModule !== "function") {
    return {ok: false, reason: "NO_DEACTIVATION_API"};
  }
  const moduleID = positive(state.moduleID) || positive(request.moduleID);
  if (!moduleID) {
    return {ok: false, reason: "NO_MODULE_ID"};
  }
  try {
    scene.deactivateGenericModule(session, moduleID, {reason: "manual", deferUntilCycle: false});
  } catch (error) {
    return {ok: false, reason: `DEACTIVATION_FAILED:${error && error.message}`};
  }
  return {ok: true, alreadyOff: false};
}

module.exports = {
  MODE_GROUP_ID,
  MODE_KINDS,
  MODE_EFFECT_PATTERN,
  isModeModule,
  findModeModules,
  modeKindOf,
  activeModeEffectOf,
  isModeActive,
  activeModeKindOf,
  activateMode,
  deactivateMode,
  effectNamesOf,
};
