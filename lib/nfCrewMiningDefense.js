"use strict";

// M9: automatic defensive modules. Active tanking is what keeps the crew alive while the
// commander fights, and none of it is a weapon, so it lives in its own module.
//
// Group IDs come from the SDE (groups.jsonl):
//   40  Shield Booster        (pulse: shield below threshold)
//   1156 Ancillary Shield Booster (same, uses charges)
//   76  Capacitor Booster     (pulse: capacitor below threshold, needs a loaded charge)
//   62  Armor Repair Unit     (pulse: armor below threshold)
//   1199 Ancillary Armor Repairer (same, uses charges)
//   77  Shield Hardener       (always on)
//   328 Armor Hardener        (always on)
//   213 Tracking Computer     (always on — 无弹药也能用，和增强器同一套)
//
// Healing is deliberately threshold-driven, not "always on": the user's rule is 回血装备走
// 血量激活. Leaving a repairer running at full HP only burns capacitor.

const path = require("node:path");

// S2：自修结算复用遥修那套"直接写层值"的纯函数（applyRepairToEntity）。
const remoteSalvo = require(path.join(__dirname, "nfCrewMiningRemoteSalvo.js"));

// S2：可以走"一次算量 + 写层值"的模块。电容回充暂不纳入（它的加成属性名和遥修的
// powerTransferAmount 不是同一个，需要单独核对 SDE，先保持真激活）。
const SELF_SETTLE_KINDS = new Set(["shieldBooster", "armorRepairer"]);

/**
 * S2：给**自己**修一次，不激活模块。
 *
 * 为什么：每次 `activateGenericModule` 引擎都要重建全船属性（0.5–1.1 s），24 条船被打
 * 的时候是同时开一堆；而修甲/回盾的本质只是"一个数写进层值"。
 *
 * 需要的注入（runtime 提供）：
 *   attributeSnapshotFor(moduleItem) → {[attributeID]: value} | null
 *   attributeIdFor(key)             → attributeID（shield/armor/capNeed/duration）
 *   payCapacitor(capNeed)           → bool
 *   settleState                     → Map<`${crewKey}:${moduleID}`, nextAtMs>
 *   broadcastSettleFx(kind, moduleItem, durationMs)
 *
 * 返回 {ok, reason}：`ok: false` 时调用方退回原来的真激活路径，行为不比现在差。
 */
function settleSelfRepair(entry, moduleItem, request = {}) {
  const entity = request.entity;
  const moduleID = positive(moduleItem && moduleItem.itemID);
  if (!entity || !moduleID) {
    return {ok: false, reason: "BAD_REQUEST"};
  }
  const attributesFor = request.attributeSnapshotFor;
  const attributeIdFor = request.attributeIdFor;
  const state = request.settleState;
  if (typeof attributesFor !== "function" || typeof attributeIdFor !== "function" || !(state instanceof Map)) {
    return {ok: false, reason: "NO_SETTLE_DEPS"};
  }
  const nowMs = Number(request.nowMs) || Date.now();
  const gateKey = `${request.crewKey || 0}:${moduleID}`;
  const nextAt = Number(state.get(gateKey)) || 0;
  if (nowMs < nextAt) {
    return {ok: false, reason: "COOLDOWN", nextAtMs: nextAt};
  }
  const attributes = attributesFor(moduleItem);
  if (!attributes) {
    return {ok: false, reason: "NO_ATTR"};
  }
  const amountKey = entry.kind === "shieldBooster" ? "shield" : "armor";
  const amount = Math.max(0, Number(attributes[attributeIdFor(amountKey)]) || 0);
  if (amount <= 0) {
    return {ok: false, reason: "NO_AMOUNT"};
  }
  const capNeed = Math.max(0, Number(attributes[attributeIdFor("capNeed")]) || 0);
  if (capNeed > 0 && typeof request.payCapacitor === "function" && request.payCapacitor(capNeed) !== true) {
    return {ok: false, reason: "NO_CAPACITOR"};
  }
  const durationMs = Math.max(1000, Number(attributes[attributeIdFor("duration")]) || 0);
  const applied = remoteSalvo.applyRepairToEntity(entity, {
    shield: entry.kind === "shieldBooster" ? amount : 0,
    armor: entry.kind === "armorRepairer" ? amount : 0,
  });
  state.set(gateKey, nowMs + durationMs);
  if (typeof request.broadcastSettleFx === "function") {
    try {
      request.broadcastSettleFx(entry.kind, moduleItem, durationMs);
    } catch (_error) {
      /* 表现层失败不影响结算 */
    }
  }
  return {ok: true, applied, amount, durationMs, nextAtMs: nowMs + durationMs};
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

const GROUP_SHIELD_BOOSTER = 40;
const GROUP_ANCILLARY_SHIELD_BOOSTER = 1156;
const GROUP_CAPACITOR_BOOSTER = 76;
const GROUP_SHIELD_HARDENER = 77;
const GROUP_ARMOR_HARDENER = 328;
// 索敌计算机（213）/ 导弹制导计算机（1396）：不需要弹药，靠脚本才更强 —— 按「常开」处理。
const GROUP_TRACKING_COMPUTER = 213;
const GROUP_MISSILE_GUIDANCE_COMPUTER = 1396;
const GROUP_ARMOR_REPAIRER = 62;
const GROUP_ANCILLARY_ARMOR_REPAIRER = 1199;
// Propulsion: 46 = Propulsion Module (the group the SDE gives most MWDs),
// 475 = Microwarpdrive (the dedicated group on newer data).
const GROUP_PROPULSION = 46;
const GROUP_MICROWARPDRIVE = 475;

const KIND_BY_GROUP = new Map([
  [GROUP_SHIELD_BOOSTER, "shieldBooster"],
  [GROUP_ANCILLARY_SHIELD_BOOSTER, "shieldBooster"],
  [GROUP_CAPACITOR_BOOSTER, "capBooster"],
  [GROUP_ARMOR_REPAIRER, "armorRepairer"],
  [GROUP_ANCILLARY_ARMOR_REPAIRER, "armorRepairer"],
  [GROUP_SHIELD_HARDENER, "hardener"],
  [GROUP_ARMOR_HARDENER, "hardener"],
  [GROUP_TRACKING_COMPUTER, "hardener"],
  [GROUP_MISSILE_GUIDANCE_COMPUTER, "guidanceComputer"],
  [GROUP_PROPULSION, "propulsion"],
  [GROUP_MICROWARPDRIVE, "propulsion"],
]);

const CHARGE_CATEGORY_ID = 8;
const FITTING_SLOT_RANGES = [[11, 34], [92, 99], [125, 132], [164, 171]];

function isFittingSlotFlag(flagID) {
  const flag = Number(flagID);
  if (!Number.isFinite(flag)) {
    return false;
  }
  return FITTING_SLOT_RANGES.some(([start, end]) => flag >= start && flag <= end);
}

/** Capacitor charge as a 0..1 ratio (the engine keeps it on the entity). */
function capRatioOf(entity) {
  const ratio = Number(entity && entity.capacitorChargeRatio);
  return Number.isFinite(ratio) ? Math.min(Math.max(ratio, 0), 1) : 1;
}

/** Shield charge as a 0..1 ratio (1 = full shield). */
function shieldRatioOf(entity) {
  const state = entity && entity.conditionState;
  const ratio = Number(state && state.shieldCharge);
  return Number.isFinite(ratio) ? Math.min(Math.max(ratio, 0), 1) : 1;
}

/**
 * Armor as a 0..1 ratio (1 = intact). The engine keeps damage as a ratio on
 * `conditionState.armorDamage`, so the readable "how much armor is left" is 1 - damage.
 */
function armorRatioOf(entity) {
  const state = entity && entity.conditionState;
  const damage = Number(state && state.armorDamage);
  if (!Number.isFinite(damage)) {
    return 1;
  }
  return Math.min(Math.max(1 - damage, 0), 1);
}

/** Fitted defensive modules with their kind. */
function defenseModules(deps, request = {}) {  const fitting = deps && deps.fitting;
  const characterID = positive(request.characterID);
  const shipID = positive(request.shipID);
  if (!fitting || typeof fitting.getFittedModuleItems !== "function") {
    return {ok: false, modules: [], problems: ["NO_FITTING_API"]};
  }
  let items = [];
  try {
    items = fitting.getFittedModuleItems(characterID, shipID) || [];
  } catch (_error) {
    items = [];
  }
  if (items.length === 0) {
    try {
      const raw = deps.itemStore && typeof deps.itemStore.listContainerItems === "function"
        ? deps.itemStore.listContainerItems(characterID, shipID) || []
        : [];
      items = raw.filter((item) => isFittingSlotFlag(item && item.flagID)
        && Number(item && item.categoryID) !== CHARGE_CATEGORY_ID);
    } catch (_error) {
      items = [];
    }
  }
  const modules = [];
  for (const moduleItem of items) {
    if (!moduleItem || Number(moduleItem.categoryID) === CHARGE_CATEGORY_ID) {
      continue;
    }
    if (typeof fitting.isModuleOnline === "function" && !fitting.isModuleOnline(moduleItem)) {
      continue;
    }
    const kind = KIND_BY_GROUP.get(Number(moduleItem.groupID) || 0) || null;
    if (!kind) {
      continue;
    }
    modules.push({moduleItem, kind});
  }
  return {ok: modules.length > 0, modules, problems: modules.length > 0 ? [] : ["NO_DEFENSE_MODULE_ONLINE"]};
}

function isActive(entity, moduleID) {
  const effects = entity && entity.activeModuleEffects;
  return effects instanceof Map && effects.has(positive(moduleID));
}

// ---- PLAN §17 P3：抗性常开（把增强器并入被动快照，不激活模块）------------------
//
// 增强器（组 77 护盾 / 328 装甲）只有"激活着"才有抗性，激活一次引擎要重算全船属性
// （0.5–1.1 s），而且持续吃电。P3 的做法是：给模块写一条**影子 effect state**
// （isGeneric，带 SDE 的 effectRecord），然后让引擎重算一次被动属性 —— 引擎的
// `collectEntityActiveShipAttributeModifierEntries` 会把这些 modifier（含叠加惩罚）
// 展开进 `passiveDerivedState`。之后不扣电、不占模块状态、不再逐门重算。
const RESIST_ATTRIBUTE_IDS = new Set([267, 268, 269, 270, 271, 272, 273, 274]);

function effectRecordsOf(deps, typeID) {
  const fitting = deps && deps.fitting;
  const id = positive(typeID);
  if (!fitting || !id || typeof fitting.getTypeEffectRecords !== "function") {
    return [];
  }
  try {
    return fitting.getTypeEffectRecords(id) || [];
  } catch (_error) {
    return [];
  }
}

/** 这一族的"激活效果"：优先选真能改抗性的那条。 */
function hardenerEffectRecord(deps, moduleItem) {
  const records = effectRecordsOf(deps, moduleItem && moduleItem.typeID);
  if (records.length === 0) {
    return null;
  }
  const touchesResist = (record) => (Array.isArray(record && record.modifierInfo) ? record.modifierInfo : [])
    .some((row) => row
      && RESIST_ATTRIBUTE_IDS.has(Number(row.modifiedAttributeID))
      && /itemID|shipID/i.test(String(row.domain || "")));
  return records.find(touchesResist)
    || records.find((record) => positive(record && record.durationAttributeID) > 0)
    || records[0]
    || null;
}

/** 装了增强器的条目（kind === "hardener"）。 */
function hardenerEntries(deps, request = {}) {
  return defenseModules(deps, request).modules.filter((entry) => entry.kind === "hardener");
}

/**
 * 给一艘船写/刷新"抗性常开"的影子状态；有变化才让引擎重算一次。
 * 幂等：已经写过就跳过；真的激活着的模块不覆盖。
 */
function applyPassiveHardeners(scene, entity, modules, options = {}) {
  if (!entity) {
    return {ok: false, applied: 0, refreshed: false};
  }
  if (!(entity.activeModuleEffects instanceof Map)) {
    entity.activeModuleEffects = new Map();
  }
  let applied = 0;
  for (const entry of Array.isArray(modules) ? modules : []) {
    const moduleItem = entry && entry.moduleItem;
    const moduleID = positive(moduleItem && moduleItem.itemID);
    if (!moduleID) {
      continue;
    }
    const existing = entity.activeModuleEffects.get(moduleID);
    if (existing) {
      // 已经是我们写的（幂等），或者玩家/引擎真在跑它（别覆盖）。
      continue;
    }
    const record = hardenerEffectRecord(options.deps || {}, moduleItem);
    if (!record) {
      continue;
    }
    entity.activeModuleEffects.set(moduleID, {
      moduleID,
      moduleFlagID: positive(moduleItem.flagID),
      typeID: positive(moduleItem.typeID),
      isGeneric: true,
      effectID: Number(record.effectID) || 0,
      effectName: String(record.name || ""),
      effectRecord: record,
      effectNameLower: String(record.name || "").toLowerCase(),
      activatedAtMs: Number(options.nowMs) || Date.now(),
      deactivatedAtMs: 0,
      passiveHardener: true,
      // 影子状态必须让引擎觉得"这一轮还没到期"，否则 scene/tick.js:701 的
      // `getEffectCycleBoundaryMs(effectState, now)` 会拿 now 当边界（没有 startedAtMs /
      // nextCycleAtMs 时它回退到 fallbackNow），于是**每个 tick 都被当成 cycle 结束**，
      // 引擎在收尾分支里把这条效应删掉 —— 表现出来就是 mod 每 2 秒重新写一次、每次都触发
      // 一次 800–1050 ms 的全船属性重算（crew.log 里的 `[defense] 抗性常开：2 个增强器并入快照`）。
      // 隐形模块用的是同一招：durationMs = -1、nextCycleAtMs = MAX_SAFE_INTEGER
      // （scene/modules.js:2785）。这样这条效应永远不会到期，只作为被动修正存在。
      startedAtMs: Number(options.nowMs) || Date.now(),
      durationMs: -1,
      nextCycleAtMs: Number.MAX_SAFE_INTEGER,
      repeat: 0,
      deactivateAtMs: 0,
      stopReason: null,
    });
    applied += 1;
  }
  let refreshed = false;
  if (applied > 0 && scene && typeof scene.refreshShipEntityDerivedState === "function") {
    try {
      scene.refreshShipEntityDerivedState(entity, {broadcast: true});
      refreshed = true;
    } catch (_error) {
      /* 重算失败不影响影子状态：下一次 refresh/ensure 会再来一次 */
    }
  }
  return {ok: true, applied, refreshed};
}

/** 撤回影子状态（关掉常开模式或解散时用），随后重算一次。 */
function stopPassiveHardeners(scene, entity) {
  if (!entity || !(entity.activeModuleEffects instanceof Map)) {
    return {ok: true, removed: 0};
  }
  let removed = 0;
  for (const [moduleID, state] of [...entity.activeModuleEffects]) {
    if (state && state.passiveHardener === true) {
      entity.activeModuleEffects.delete(moduleID);
      removed += 1;
    }
  }
  if (removed > 0 && scene && typeof scene.refreshShipEntityDerivedState === "function") {
    try {
      scene.refreshShipEntityDerivedState(entity, {broadcast: true});
    } catch (_error) {
      /* best effort */
    }
  }
  return {ok: true, removed};
}

/**
 * One pass of defensive management.
 *   hardener     -> activate and keep it running
 *   capBooster   -> activate when capacitor is below `capBoosterThreshold`
 *   shieldBooster-> activate when shield is below `shieldBoosterThreshold`
 */
// The engine throttles re-activation of a module it just switched; hammering it every
// second produced dozens of MODULE_REACTIVATING "failures". Keep a short per-module
// cooldown instead.
const ACTIVATION_COOLDOWN_MS = 2500;
const lastAttemptAt = new Map();

// A5/A7：回充器/修甲是短周期脉冲模块（回充 4 s、修甲 15 s）。"running" 只在周期内为 true，
// 周期一结束就退回“低于启动阈值才开”，于是永远充/修不到停止阈值。
// 这里给每艘船每块模块记一个“充电中”锁存：一旦因低于启动阈值触发，就一直重激活到
// 达到停止阈值（90% / 95%）才清掉。
const chargeLatches = new Set();

function latchKey(moduleID, entity) {
  return `${Number(entity && entity.itemID) || 0}:${Number(moduleID) || 0}`;
}

/**
 * PR-5: the cooldown used to be keyed by moduleID alone, which is a global item id —
 * fine for one player, a cross-ship stall when two crews share the process. Key it by
 * the character driving the module.
 */
function throttleKey(moduleID, entity, request) {
  const characterID = Number(
    (request && (request.characterID || (request.member && request.member.characterID)))
    || (entity && (entity.characterID || entity.pilotCharacterID)),
  ) || 0;
  return characterID ? `${characterID}:${moduleID}` : `0:${moduleID}`;
}

function manageDefense(request = {}) {
  const scene = request.scene;
  const session = request.session;
  const entity = request.entity;
  const modules = Array.isArray(request.modules) ? request.modules : [];
  // Propulsion (MWD / afterburner) is opt-in: it blooms the signature radius and drains the
  // capacitor, so it only runs on long transfers with a healthy capacitor.
  const propulsionEnabled = request.propulsionEnabled === true;
  // Hysteresis: switch on well outside, switch off well inside, so a ship hovering at the
  // threshold cannot flap the drive every tick.
  const legacyFarMeters = Number.isFinite(Number(request.propulsionFarMeters))
    ? Number(request.propulsionFarMeters)
    : 20000;
  const propulsionOnMeters = Number.isFinite(Number(request.propulsionOnMeters))
    ? Number(request.propulsionOnMeters)
    : Math.max(legacyFarMeters, 30000);
  const propulsionOffMeters = Number.isFinite(Number(request.propulsionOffMeters))
    ? Number(request.propulsionOffMeters)
    : Math.min(propulsionOnMeters * 0.5, 15000);
  const propulsionCapThreshold = Number.isFinite(Number(request.propulsionCapThreshold))
    ? Number(request.propulsionCapThreshold)
    : 0.15;
  // A distance of hundreds of millions of km means the coordinate spaces did not match;
  // such a reading must never drive a decision.
  const rawDistance = Number(request.distanceToLeader);
  const distanceToLeader = Number.isFinite(rawDistance) && rawDistance >= 0 && rawDistance < 1e9
    ? rawDistance
    : Number.NaN;
  const distanceUsable = Number.isFinite(distanceToLeader);
  const capThreshold = Number.isFinite(Number(request.capBoosterThreshold))
    ? Number(request.capBoosterThreshold)
    : 0.3;
  const shieldThreshold = Number.isFinite(Number(request.shieldBoosterThreshold))
    ? Number(request.shieldBoosterThreshold)
    : 0.6;
  // 回血装备走血量激活（用户口径）：装甲低于阈值才修，修满就停（省电）。
  const armorThreshold = Number.isFinite(Number(request.armorRepairerThreshold))
    ? Number(request.armorRepairerThreshold)
    : 0.7;
  // 迟滞：低于 start 才开，高于 stop 才关。没有它就会在阈值附近每 6~10 秒开合一次
  // （日志实证：护盾 67% 开 → 63% 关 → 67% 开）。
  const shieldStop = Number.isFinite(Number(request.shieldBoosterStopThreshold))
    ? Number(request.shieldBoosterStopThreshold)
    : Math.min(0.9, shieldThreshold + 0.2);
  const armorStop = Number.isFinite(Number(request.armorRepairerStopThreshold))
    ? Number(request.armorRepairerStopThreshold)
    : Math.min(0.95, armorThreshold + 0.2);
  // ratios 是**决策时**的读数，日志要打这个，不能打动作之后的值。
  // O2：同一 tick 最多激活几个模块（默认 1），其余排队到下一 tick，避免多个 1 s 级
  // 激活叠在同一帧。O1：回充器/修甲用 repeat=1 常驻循环，只在 threshold 处停。
  // O2：同一 tick 最多激活几个模块。0 = 不限制（单测/旧调用方），runtime 会显式传 1。
  const maxActivations = Math.max(0, Number(request.maxActivations) || 0);
  const repeatModules = request.defenseRepeatModules !== false;
  const result = {
    ok: true,
    activated: [],
    stopped: [],
    skipped: [],
    throttled: [],
    queued: [],
    errors: [],
    ratios: {},
  };
  if (!scene || !entity || typeof scene.activateGenericModule !== "function") {
    return {ok: false, activated: [], stopped: [], skipped: [], errors: ["NO_ACTIVATION_API"]};
  }
  const cap = capRatioOf(entity);
  const shield = shieldRatioOf(entity);
  const armor = armorRatioOf(entity);
  result.ratios = {cap, shield, armor, shieldStop, armorStop};
  let activatedCount = 0;
  for (const entry of modules) {
    const moduleItem = entry && entry.moduleItem;
    const moduleID = positive(moduleItem && moduleItem.itemID);
    if (!moduleID) {
      continue;
    }
    const running = isActive(entity, moduleID);
    let want = false;
    if (entry.kind === "hardener") {
      // P3 抗性常开：增强器已经以影子状态并入被动快照，不再激活（不扣电、不重算）。
      // 关掉常开模式（passiveHardeners=false）时回到"激活并保持"。
      want = request.passiveHardeners !== true;
    } else if (entry.kind === "capBooster") {
      want = cap < capThreshold;
    } else if (entry.kind === "shieldBooster") {
      const key = latchKey(moduleID, entity);
      const latched = chargeLatches.has(key);
      want = running || latched ? shield < shieldStop : shield < shieldThreshold;
      if (want) {
        chargeLatches.add(key);
      } else {
        chargeLatches.delete(key);
      }
    } else if (entry.kind === "armorRepairer") {
      const key = latchKey(moduleID, entity);
      const latched = chargeLatches.has(key);
      want = running || latched ? armor < armorStop : armor < armorThreshold;
      if (want) {
        chargeLatches.add(key);
      } else {
        chargeLatches.delete(key);
      }
    } else if (entry.kind === "guidanceComputer") {
      // 制导/索敌计算机：不需要目标、没有阈值，装上就常开（脚本由 runDefenseFor 先装填）。
      want = true;
    } else if (entry.kind === "propulsion") {
      // Only for long transfers: an MWD blooms the signature radius and eats capacitor,
      // so it stays off in a fight and off when already close.
      // Unknown distance: keep whatever state the drive is in, never toggle on a guess.
      if (!distanceUsable) {
        want = running;
      } else {
        const threshold = running ? propulsionOffMeters : propulsionOnMeters;
        want = propulsionEnabled && cap > propulsionCapThreshold && distanceToLeader > threshold;
      }
    }
    if (!want) {
      const canStop = entry.kind === "propulsion"
        ? typeof scene.deactivatePropulsionModule === "function"
          || typeof scene.deactivateGenericModule === "function"
        : typeof scene.deactivateGenericModule === "function";
      if (running && entry.kind !== "hardener" && canStop) {
        try {
          // Propulsion has a dedicated shutdown: the generic one drops the effect without
          // recomputing ship attributes, which left the MWD bonus (speed, mass, signature)
          // stuck on the ship after the module was switched off.
          const usePropulsionShutdown = entry.kind === "propulsion"
            && typeof scene.deactivatePropulsionModule === "function";
        if (usePropulsionShutdown) {
          scene.deactivatePropulsionModule(session, moduleID, {reason: "pilot", deferUntilCycle: false});
        } else {
          scene.deactivateGenericModule(session, moduleID, {reason: "npc", deferUntilCycle: false});
        }
          lastAttemptAt.set(throttleKey(moduleID, entity, request), Number(request.nowMs) || Date.now());
          result.stopped.push(moduleID);
        } catch (_error) {
          /* the next pass retries */
        }
      } else {
        result.skipped.push(moduleID);
      }
      continue;
    }
    // S2：自修走"算一次、写层值"，不激活模块（省掉每次 0.5–1.1 s 的全船属性重算）。
    // 任何一环失败（没属性快照 / 电容不足）就退回下面的真激活路径，行为不比现在差。
    if (request.settle === true && SELF_SETTLE_KINDS.has(entry.kind) && !running) {
      const settled = settleSelfRepair(entry, moduleItem, request);
      if (settled.ok === true) {
        result.activated.push(moduleID);
        activatedCount += 1;
        result.settled = (result.settled || 0) + 1;
        continue;
      }
      if (settled.reason === "COOLDOWN") {
        result.skipped.push(moduleID);
        continue;
      }
    }
    if (running) {
      result.skipped.push(moduleID);
      continue;
    }
    if (maxActivations > 0 && activatedCount >= maxActivations) {
      // O2：这一 tick 的激活预算用完了，剩下的交给下一 tick，避免同帧叠加。
      result.queued.push(moduleID);
      continue;
    }
    // The engine refuses a module whose item.locationID is not the ship entity
    // (`MODULE_NOT_FOUND`). Imported ships can carry stale locations, so the copy handed
    // to the engine is normalised to the entity this ship really is right now.
    const engineItem = (Number(moduleItem.locationID) === Number(entity.itemID))
      ? moduleItem
      : {...moduleItem, locationID: Number(entity.itemID)};
    // Only a module that was JUST switched off is in engine cooldown: otherwise activate.
    const nowMs = Number(request.nowMs) || Date.now();
    if (nowMs - (lastAttemptAt.get(throttleKey(moduleID, entity, request)) || 0) < ACTIVATION_COOLDOWN_MS) {
      result.throttled.push(moduleID);
      continue;
    }
    try {
      // Propulsion has its own entry point: the generic one accepts the call but does
      // not apply the speed bonus. Hardeners/boosters stay on the generic path.
      const effectName = entry.kind === "propulsion" ? (entry.effectName || null) : null;
      const usePropulsionPath = entry.kind === "propulsion"
        && typeof scene.activatePropulsionModule === "function";
      const repeatNow = entry.kind === "guidanceComputer"
        || (repeatModules && (entry.kind === "shieldBooster" || entry.kind === "armorRepairer"));
      const activation = usePropulsionPath
        ? scene.activatePropulsionModule(session, engineItem, effectName, {})
        : scene.activateGenericModule(session, engineItem, effectName,
          repeatNow ? {repeat: 1} : {});
      if (activation && activation.success === true) {
        result.activated.push(moduleID);
        activatedCount += 1;
      } else {
        const errorMsg = (activation && activation.errorMsg) || "ACTIVATION_FAILED";
        if (errorMsg === "MODULE_REACTIVATING") {
          result.throttled.push(moduleID);
        } else {
          result.errors.push(`MODULE_${moduleID}:${errorMsg}`);
        }
      }
    } catch (error) {
      result.errors.push(`MODULE_${moduleID}:${error && error.message}`);
    }
  }
  return result;
}

/** Turn every defensive module off (used on ceasefire / retreat). */
function stopDefense(request = {}) {
  const scene = request.scene;
  const session = request.session;
  const entity = request.entity;
  const modules = Array.isArray(request.modules) ? request.modules : [];
  let stopped = 0;
  if (!scene || !entity || typeof scene.deactivateGenericModule !== "function") {
    return {ok: true, stopped};
  }
  for (const entry of modules) {
    const moduleID = positive(entry && entry.moduleItem && entry.moduleItem.itemID);
    if (!moduleID || !isActive(entity, moduleID)) {
      continue;
    }
    // 抗性常开是影子状态，不是「真在跑的模块」：停装备时不能摘掉它，
    // 否则下一次防御 tick 又加回来 —— 每 2.5 秒一次全船重算（0.5~1.1 s）就是这么来的。
    const state = entity.activeModuleEffects.get(moduleID);
    if (state && state.passiveHardener === true) {
      continue;
    }
    try {
      scene.deactivateGenericModule(session, moduleID, {reason: "npc", deferUntilCycle: false});
      stopped += 1;
    } catch (_error) {
      /* best effort */
    }
  }
  return {ok: true, stopped};
}

module.exports = {
  GROUP_PROPULSION,
  GROUP_MICROWARPDRIVE,
  GROUP_SHIELD_BOOSTER,
  GROUP_ANCILLARY_SHIELD_BOOSTER,
  GROUP_CAPACITOR_BOOSTER,
  GROUP_SHIELD_HARDENER,
  GROUP_ARMOR_HARDENER,
  GROUP_TRACKING_COMPUTER,
  GROUP_MISSILE_GUIDANCE_COMPUTER,
  GROUP_ARMOR_REPAIRER,
  GROUP_ANCILLARY_ARMOR_REPAIRER,
  RESIST_ATTRIBUTE_IDS,
  capRatioOf,
  shieldRatioOf,
  armorRatioOf,
  defenseModules,
  hardenerEntries,
  hardenerEffectRecord,
  applyPassiveHardeners,
  stopPassiveHardeners,
  manageDefense,
  stopDefense,
  // S2：自修结算（供 runtime 与单测直接调用）
  settleSelfRepair,
  // S2：这个模块现在是不是"正在修"（锁存中）。结算不产生 effectState，
  // 所以 runtime 的"要不要进来处理"预检必须问它，否则一过启动阈值就被挡掉。
  isModuleLatched: (moduleID, entity) => chargeLatches.has(latchKey(moduleID, entity)),
  // Test hook (PR-5): the cooldown key must include the driving character.
  __throttleKey: throttleKey,
  // Test hook (A5/A7): the "charging" latches are per-process state.
  __resetChargeLatches: () => chargeLatches.clear(),
  // Test hook: module activation cooldowns are per-process too.
  __resetThrottle: () => lastAttemptAt.clear(),
};
