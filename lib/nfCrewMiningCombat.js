"use strict";

// M9 slice 1: directed attack. The crew locks a target the player names and activates
// its turret modules on it — the same primitives mining already uses
// (requestModuleTargetLock / activateGenericModule / deactivateGenericModule).
//
// Deliberately NOT implemented here: target discovery (that is slice 2, "guard").

const path = require("node:path");
// 距离/坐标统一走 geometry（以前这个文件里也有一份 surfaceDistance）。
const geometry = require(path.join(__dirname, "nfCrewMiningGeometry.js"));

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

const CHARGE_CATEGORY_ID = 8;
const FITTING_SLOT_RANGES = [[11, 34], [92, 99], [125, 132], [164, 171]];

function isFittingSlotFlag(flagID) {
  const flag = Number(flagID);
  if (!Number.isFinite(flag)) {
    return false;
  }
  return FITTING_SLOT_RANGES.some(([start, end]) => flag >= start && flag <= end);
}

/** Position of a scene entity: the engine keeps it on `entity.position`. */
function positionOf(entity) {
  return geometry.positionOf(entity);
}

/**
 * Surface distance between two scene entities (metres).
 *
 * The engine stores coordinates in `entity.position`, not on `entity.x`: reading the wrong
 * field made every distance 0, so the propulsion rule (`> 20 km`) never fired and the
 * weapon-range guard never blocked anything.
 */
function surfaceDistance(left, right) {
  // 任一实体缺失 = 无穷远（这个模块的“够不够得着”依赖这个语义）。
  return geometry.surfaceDistanceOrInfinite(left, right);
}

/**
 * 船上在线、并且能开火的武器模块。
 * 炮台族（laser/hybrid/projectile/precursor）与沃顿走炮台循环；
 * 导弹族（含鱼雷/巡航/HAM/火箭/破舱者）也算武器，但**齐射里按导弹模型结算**
 * （伤害与射程都从导弹快照里取，不发导弹实体，见 nfCrewMiningSalvo.js）。
 * 炸弹/节日发射器不参与：炸弹需要投放坐标而不是锁定目标，节日弹本来不造成伤害。
 */
function weaponModules(deps, request = {}) {
  const fitting = deps && deps.fitting;
  const dogma = deps && deps.weaponDogma;
  const characterID = positive(request.characterID);
  const shipID = positive(request.shipID);
  const problems = [];
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
    if (!moduleItem) {
      continue;
    }
    // A charge (ammo/crystal) is never a module, whatever list it arrives in.
    if (Number(moduleItem.categoryID) === CHARGE_CATEGORY_ID) {
      continue;
    }
    if (typeof fitting.isModuleOnline === "function" && !fitting.isModuleOnline(moduleItem)) {
      continue;
    }
    let family = null;
    try {
      family = dogma && typeof dogma.resolveWeaponFamily === "function"
        ? dogma.resolveWeaponFamily(moduleItem, null)
        : null;
    } catch (_error) {
      family = null;
    }
    const isTurret = dogma && typeof dogma.isTurretCycleWeaponFamily === "function"
      ? dogma.isTurretCycleWeaponFamily(family)
      : false;
    const isMissile = dogma && typeof dogma.isMissileWeaponFamily === "function"
      ? dogma.isMissileWeaponFamily(family)
      : family === "missileLauncher";
    if (!isTurret && !isMissile) {
      continue;
    }
    let rangeMeters = 0;
    try {
      const records = typeof fitting.getTypeEffectRecords === "function"
        ? fitting.getTypeEffectRecords(positive(moduleItem.typeID)) || []
        : [];
      for (const record of records) {
        const optimal = Number(record && record.optimalRange) || 0;
        if (optimal > rangeMeters) {
          rangeMeters = optimal;
        }
      }
    } catch (_error) {
      rangeMeters = 0;
    }
    // 导弹的射程不是 optimalRange（那是 0），实际射程在齐射时按快照算，
    // 这里把 rangeMeters 留 0 表示「未知」，交给射程判定那一步处理。
    modules.push({moduleItem, family, isMissile, rangeMeters: isMissile ? 0 : rangeMeters});
  }
  if (modules.length === 0) {
    problems.push("NO_WEAPON_MODULE_ONLINE");
  }
  return {ok: modules.length > 0, modules, problems};
}

/**
 * 用「带修正的快照」算这条船的有效射程（炮台 optimalRange + falloff / 导弹 approxRange）。
 * `weaponModules` 返回的 rangeMeters 是 effect record 里的基础值，吃不到会战/后勤对射程的加成，
 * 所以射程判定要用这个函数的结果。
 */
function effectiveRangeMeters(deps, request = {}) {
  const dogma = deps && deps.weaponDogma;
  const view = deps && deps.dogmaView;
  const modules = Array.isArray(request.modules) ? request.modules : [];
  if (!dogma || typeof dogma.buildWeaponModuleSnapshot !== "function" || modules.length === 0) {
    return {ok: false, rangeMeters: 0, isMissile: false, reason: "NO_SNAPSHOT_API"};
  }
  const representative = modules.reduce(
    (best, row) => ((Number(row && row.rangeMeters) || 0) > (Number(best && best.rangeMeters) || 0) ? row : best),
    modules[0],
  );
  const moduleItem = representative && representative.moduleItem;
  if (!moduleItem) {
    return {ok: false, rangeMeters: 0, isMissile: false, reason: "NO_MODULE"};
  }
  const fitting = deps.fitting;
  const itemStore = deps.itemStore;
  let shipItem = null;
  try {
    shipItem = itemStore && typeof itemStore.findShipItemById === "function"
      ? itemStore.findShipItemById(request.shipID)
      : null;
  } catch (_error) {
    shipItem = null;
  }
  if (!shipItem) {
    return {ok: false, rangeMeters: 0, isMissile: false, reason: "NO_SHIP_ITEM"};
  }
  let fittedItems = [];
  try {
    fittedItems = fitting && typeof fitting.getFittedModuleItems === "function"
      ? fitting.getFittedModuleItems(request.characterID, request.shipID) || []
      : [];
  } catch (_error) {
    fittedItems = [];
  }
  let chargeItem = null;
  try {
    const flagID = Number(moduleItem.flagID) || 0;
    chargeItem = fitting && typeof fitting.getLoadedChargeByFlag === "function" && flagID > 0
      ? fitting.getLoadedChargeByFlag(request.characterID, request.shipID, flagID)
      : null;
  } catch (_error) {
    chargeItem = null;
  }
  let activeModuleContexts = null;
  try {
    if (view && typeof view.getEntityRuntimeActiveModuleContexts === "function" && request.attackerEntity) {
      activeModuleContexts = view.getEntityRuntimeActiveModuleContexts(request.attackerEntity, {
        excludeModuleID: Number(moduleItem.itemID) || 0,
      });
    }
  } catch (_error) {
    activeModuleContexts = null;
  }
  const snapshotCache = require(path.join(__dirname, "nfCrewMiningSnapshotCache.js"));
  const cacheRequest = {characterID: request.characterID, shipID: request.shipID, moduleItem, chargeItem};
  let snapshot = snapshotCache.get(cacheRequest);
  if (snapshot) {
    const optimalCached = Number(snapshot.optimalRange) || 0;
    const falloffCached = Number(snapshot.falloff) || 0;
    const isMissileCached = Boolean(representative.isMissile)
      || /missileLauncher|vortonProjector|breacherPod/i.test(String(snapshot.family || ""));
    const missileRangeCached = Number(snapshot.approxRange) || 0
      || (Number(snapshot.maxVelocity) || 0) * ((Number(snapshot.flightTimeMs) || 0) / 1000);
    const rangeCached = isMissileCached ? missileRangeCached : optimalCached + falloffCached;
    return {ok: rangeCached > 0, rangeMeters: rangeCached, isMissile: isMissileCached, snapshot, cached: true};
  }
  try {
    snapshot = dogma.buildWeaponModuleSnapshot({
      characterID: positive(request.characterID),
      shipItem,
      moduleItem,
      chargeItem,
      fittedItems,
      ...(Array.isArray(activeModuleContexts) && activeModuleContexts.length > 0
        ? {activeModuleContexts}
        : {}),
    });
  } catch (_error) {
    snapshot = null;
  }
  if (!snapshot) {
    return {ok: false, rangeMeters: 0, isMissile: Boolean(representative.isMissile), reason: "NO_SNAPSHOT"};
  }
  snapshotCache.set(cacheRequest, snapshot);
  const isMissile = Boolean(representative.isMissile)
    || /missileLauncher|vortonProjector|breacherPod/i.test(String(snapshot.family || ""));
  const optimal = Number(snapshot.optimalRange) || 0;
  const falloff = Number(snapshot.falloff) || 0;
  const missileRange = Number(snapshot.approxRange) || 0
    || (Number(snapshot.maxVelocity) || 0) * ((Number(snapshot.flightTimeMs) || 0) / 1000);
  const rangeMeters = isMissile ? missileRange : optimal + falloff;
  return {ok: rangeMeters > 0, rangeMeters, isMissile, snapshot};
}

/**
 * A ship the crew may shoot at on its own: a native NPC ship (rats), never the
 * player, never another crew ship, never a structure.
 */
function isHostileShip(entity, excludeIDs, accept) {
  if (!entity || !entity.itemID) {
    return false;
  }
  if (excludeIDs && excludeIDs.has(positive(entity.itemID))) {
    return false;
  }
  if (entity.kind !== "ship") {
    return false;
  }
  // Native NPC ships carry this flag (server/src/space/npc/npcEquipment.js).
  if (entity.nativeNpc === true) {
    return true;
  }
  // Player ships only when a policy explicitly allows them (war opponents).
  // No accept => NPCs only, which is the default and cannot friendly-fire.
  return typeof accept === "function" && accept(entity) === true;
}

/** Nearest hostile ship to `sourceEntity`, within `maxMeters`. */
function nearestHostile(request = {}) {
  const scene = request.scene;
  const source = request.sourceEntity;
  const excludeIDs = request.excludeIDs instanceof Set ? request.excludeIDs : new Set();
  const maxMeters = Number(request.maxMeters) || 0;
  if (!scene || !source) {
    return null;
  }
  // 调用方可以传一份已经取好的候选集：全场景扫描很贵（实测 8 条船各扫一遍
  // 就能吃掉 watch tick 的大头），所以按拍共享一份，别让每艘船各扫一次。
  let candidates = [];
  if (Array.isArray(request.candidates)) {
    candidates = request.candidates;
  } else {
    try {
      candidates = typeof scene.getDynamicEntities === "function"
        ? scene.getDynamicEntities() || []
        : (scene.dynamicEntities instanceof Map ? [...scene.dynamicEntities.values()] : []);
    } catch (_error) {
      candidates = [];
    }
  }
  let best = null;
  for (const entity of candidates) {
    if (!isHostileShip(entity, excludeIDs, request.accept)) {
      continue;
    }
    if (entity.mode && String(entity.mode).toUpperCase() === "WARP") {
      continue;
    }
    const distance = surfaceDistance(source, entity);
    if (maxMeters > 0 && distance > maxMeters) {
      continue;
    }
    if (!best || distance < best.distance) {
      best = {entity, distance};
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Candidate-set target model (plan S1 = R1 + R2 + R3)
//
// The old model was a single priority chain: commander target, else the nearest
// hostile. That made one refused lock retry forever (P1), let the crew shoot its own
// ships (P2) and switched free fire off as soon as the player locked anything (P3).
// The model below builds a *set* of legal candidates every tick and picks one:
//   1. focus fire   — only when the commander's shots are actually landing
//   2. retaliation  — whoever damaged us (defend/war only)
//   3. sticky       — keep the current target unless another is clearly closer
//   4. nearest
// ---------------------------------------------------------------------------

const GROUP_CAPSULE_ID = 29;
// 670 / 33328 are the two capsule hulls. groupID is the canonical check, exactly as
// the engine's npcBehaviorLoop.isCapsuleEntity does it.
const CAPSULE_TYPE_IDS = new Set([670, 33328]);

/** A capsule ("蛋"): never a legal target, whatever the order (R3). */
function isCapsuleEntity(entity) {
  if (!entity || entity.kind !== "ship") {
    return false;
  }
  if (Number(entity.groupID) === GROUP_CAPSULE_ID) {
    return true;
  }
  const typeID = positive(entity.typeID);
  return typeID > 0 && CAPSULE_TYPE_IDS.has(typeID);
}

/** Blacklist entries may be `{untilMs}` or a bare timestamp. */
function blacklistUntil(blacklist, targetID) {
  if (!(blacklist instanceof Map)) {
    return 0;
  }
  const record = blacklist.get(positive(targetID));
  if (record == null) {
    return 0;
  }
  return Number(typeof record === "object" ? record.untilMs : record) || 0;
}

/** R2: is this target still blacklisted for that crew? */
function isBlacklisted(blacklist, targetID, nowMs) {
  const until = blacklistUntil(blacklist, targetID);
  return until > 0 && until > nowMs;
}

/**
 * Every legal target around `sourceEntity` (R1 candidate set + R3 gates):
 * kind ship, not a capsule, not ours, not blacklisted, not warping, within range,
 * and hostile under the engagement rule. Sorted by distance, capped.
 */
function scanCandidates(request = {}) {
  const scene = request.scene;
  const source = request.sourceEntity;
  const excludeIDs = request.excludeIDs instanceof Set ? request.excludeIDs : new Set();
  const blacklist = request.blacklist instanceof Map ? request.blacklist : null;
  const nowMs = Number.isFinite(Number(request.nowMs)) ? Number(request.nowMs) : Date.now();
  const maxMeters = Number(request.maxMeters) || 0;
  const maxCandidates = Math.max(1, Number(request.maxCandidates) || 8);
  const result = {candidates: [], capsules: [], excluded: [], truncated: 0};
  if (!scene || !source) {
    return result;
  }
  let rows = [];
  if (Array.isArray(request.candidates)) {
    // 调用方每拍取一份场景快照传进来：每条船各扫一次全场景是实测过的坑
    // （wakeNpcsNearCrew 同款）。目标频繁切换、粘不住的时候这里会被调 N 次。
    rows = request.candidates;
  } else {
    try {
      rows = typeof scene.getDynamicEntities === "function"
        ? scene.getDynamicEntities() || []
        : (scene.dynamicEntities instanceof Map ? [...scene.dynamicEntities.values()] : []);
    } catch (_error) {
      rows = [];
    }
  }
  for (const entity of rows) {
    const targetID = positive(entity && entity.itemID);
    if (!targetID || !entity) {
      continue;
    }
    if (entity.kind !== "ship") {
      continue;
    }
    // R3: capsules are reported once by the caller and never enter the set.
    if (isCapsuleEntity(entity)) {
      result.capsules.push(targetID);
      continue;
    }
    // R3: our own ships / the player's ship / other crew ships are not targets.
    if (excludeIDs.has(targetID)) {
      result.excluded.push(targetID);
      continue;
    }
    if (isBlacklisted(blacklist, targetID, nowMs)) {
      continue;
    }
    if (String(entity.mode || "").toUpperCase() === "WARP") {
      continue;
    }
    if (!isHostileShip(entity, excludeIDs, request.accept)) {
      continue;
    }
    const distance = surfaceDistance(source, entity);
    if (maxMeters > 0 && distance > maxMeters) {
      continue;
    }
    result.candidates.push({entity, id: targetID, distance});
  }
  result.candidates.sort((left, right) => left.distance - right.distance);
  if (result.candidates.length > maxCandidates) {
    result.truncated = result.candidates.length - maxCandidates;
    result.candidates.length = maxCandidates;
  }
  return result;
}

/**
 * R1: choose one target for one crew ship from the candidate set.
 *
 * @param {object} request
 *   scene, sourceEntity                  — where the crew ship is
 *   excludeIDs                          — our own ships (Set of itemIDs)
 *   blacklist                           — Map(targetID -> {untilMs}) for this crew
 *   commanderTarget                     — what the player has open fire on (0 = none)
 *   focus                               — the commander's shots are landing (集火)
 *   currentTarget                       — what this crew is shooting now (sticky)
 *   priorityTargetIDs                   — retaliation records (defend/war)
 *   accept                              — engagement-rule predicate (war opponents)
 *   maxMeters / maxCandidates / stickiness / nowMs
 * @returns {{targetID:number, entity:object|null, distance:number|null, reason:string,
 *            candidates:number[], capsules:number[], excluded:number[]}}
 */
function pickTargetFor(request = {}) {
  const scene = request.scene;
  const source = request.sourceEntity;
  const nowMs = Number.isFinite(Number(request.nowMs)) ? Number(request.nowMs) : Date.now();
  const excludeIDs = request.excludeIDs instanceof Set ? request.excludeIDs : new Set();
  const blacklist = request.blacklist instanceof Map ? request.blacklist : null;
  const accept = typeof request.accept === "function" ? request.accept : null;
  const stickiness = Math.max(1, Number(request.stickiness) || 1.25);
  const scan = scanCandidates({...request, nowMs, accept});
  const byID = new Map(scan.candidates.map((row) => [row.id, row]));

  const candidateFor = (rawID, explicitOrder = false) => {
    const id = positive(rawID);
    if (!id) {
      return null;
    }
    const listed = byID.get(id);
    if (listed) {
      return listed;
    }
    // An explicit order may point outside the free-fire radius (the player is shooting
    // something 200 km away): distance is not a gate for it, the other rules still are.
    if (excludeIDs.has(id) || isBlacklisted(blacklist, id, nowMs)) {
      return null;
    }
    let entity = null;
    try {
      entity = scene && typeof scene.getEntityByID === "function" ? scene.getEntityByID(id) : null;
    } catch (_error) {
      entity = null;
    }
    // A deployed structure is never part of the free-fire candidate set (see
    // scanCandidates), but an explicit commander order may name one: a weaponless
    // command ship can only point the crew with a projected module, and the only thing
    // it can project that at is a structure. Everything else below still applies.
    const structureOrder = explicitOrder === true && entity && entity.kind === "structure";
    if (!entity || (entity.kind !== "ship" && !structureOrder) || isCapsuleEntity(entity)) {
      return null;
    }
    if (String(entity.mode || "").toUpperCase() === "WARP") {
      return null;
    }
    // The commander's own order is NOT filtered by the engagement rule: he already
    // decided, and hurting that target is exactly what fills the grudge list (S2/B).
    // Our own ships / capsules / blacklisted targets are still refused above.
    if (!explicitOrder && !isHostileShip(entity, excludeIDs, accept)) {
      return null;
    }
    return {entity, id, distance: surfaceDistance(source, entity)};
  };

  const build = (picked, reason) => ({
    targetID: picked ? picked.id : 0,
    entity: picked ? picked.entity : null,
    distance: picked ? picked.distance : null,
    reason,
    candidates: scan.candidates.map((row) => row.id),
    capsules: scan.capsules,
    excluded: scan.excluded,
  });

  // 1. Focus fire. The commander target alone is NOT an order — only a target he is
  //    actually damaging is (R1/P3).
  const focusTarget = request.focus === true ? candidateFor(request.commanderTarget, true) : null;
  if (focusTarget) {
    return build(focusTarget, "focus");
  }

  // 2. Whoever shot us. Beats plain distance (defend/war only, caller decides).
  for (const id of Array.isArray(request.priorityTargetIDs) ? request.priorityTargetIDs : []) {
    const priority = candidateFor(id);
    if (priority) {
      return build(priority, "retaliation");
    }
  }

  const current = candidateFor(request.currentTarget);
  const maxMeters = Number(request.maxMeters) || 0;

  // 3. Sticky: do not flip between two targets of nearly the same distance. Never
  //    stick to a target that drifted out of range (the set itself is range-gated).
  if (current && (maxMeters <= 0 || current.distance <= maxMeters)) {
    const nearest = scan.candidates.length > 0 ? scan.candidates[0].distance : current.distance;
    if (current.distance <= nearest * stickiness) {
      return build(current, "sticky");
    }
  }

  // 4. Nearest legal candidate.
  if (scan.candidates.length > 0) {
    return build(scan.candidates[0], "nearest");
  }

  // 5. Nothing in range: still obey an explicit order that is legal but far away.
  const commanderCandidate = candidateFor(request.commanderTarget, true);
  if (commanderCandidate) {
    return build(commanderCandidate, "commander");
  }
  return build(null, "none");
}

/** Lock the target if it is not locked yet. Mirrors the mining lock helper. */
function ensureTargetLock(request = {}) {
  const scene = request.scene;
  const entity = request.entity;
  const target = request.target;
  if (!scene || !entity || !target) {
    return {ok: false, locked: false, reason: "BAD_LOCK_REQUEST"};
  }
  const targetID = positive(target.itemID);
  let targets = [];
  if (typeof scene.getTargetsForEntity === "function") {
    try {
      targets = scene.getTargetsForEntity(entity) || [];
    } catch (_error) {
      targets = [];
    }
  }
  if ((Array.isArray(targets) ? targets : []).some((id) => positive(id) === targetID)) {
    return {ok: true, locked: true, lockDurationMs: 0};
  }
  if (typeof scene.requestModuleTargetLock !== "function") {
    return {ok: false, locked: false, reason: "NO_LOCK_API"};
  }
  const nowMs = Number.isFinite(Number(request.nowMs)) ? Number(request.nowMs) : undefined;
  let result = null;
  try {
    result = scene.requestModuleTargetLock(entity, target, {suppressTargetNotice: true});
  } catch (error) {
    return {ok: false, locked: false, reason: `LOCK_FAILED:${error && error.message}`};
  }
  if (!result || result.success !== true) {
    return {ok: false, locked: false, reason: `LOCK_REFUSED:${(result && result.errorMsg) || "UNKNOWN"}`};
  }
  const pending = Boolean(result.data && result.data.pending === true);
  if (!pending) {
    return {ok: true, locked: true, lockDurationMs: Math.max(0, Number(result.data && result.data.lockDurationMs) || 0)};
  }
  // 秒锁（2026-10-25 用户要求）：船员的锁定槽只有 1 个，等自然锁完要 9–13 秒
  // （时长 = (40e6 / scanResolution) / ln(...)²），等待期间每拍重试既慢又费。
  // 这里用引擎**自己的**两个方法拼出来，不改引擎文件、不 monkey-patch：
  //   1) finalizeTargetLock 立刻完成；
  //   2) 槽被占（TARGET_LOCK_LIMIT_REACHED）→ removeLockedTarget 放掉旧锁再完成。
  if (request.instant === true && typeof scene.finalizeTargetLock === "function") {
    const options = {suppressTargetNotice: true};
    if (nowMs !== undefined) {
      options.nowMs = nowMs;
    }
    let finished = null;
    try {
      finished = scene.finalizeTargetLock(entity, target, options);
    } catch (_error) {
      finished = null;
    }
    if (finished && finished.success === true) {
      return {ok: true, locked: true, lockDurationMs: 0, instant: true};
    }
    const limitHit = String((finished && finished.errorMsg) || "").includes("TARGET_LOCK_LIMIT_REACHED");
    if (limitHit && typeof scene.removeLockedTarget === "function") {
      // 只放"不是这个目标"的锁：船员只有一个槽，换目标必须先把旧槽腾出来。
      const held = typeof scene.getTargetsForEntity === "function" ? scene.getTargetsForEntity(entity) || [] : [];
      for (const id of Array.isArray(held) ? held : []) {
        const heldID = positive(id);
        if (!heldID || heldID === targetID) {
          continue;
        }
        try {
          scene.removeLockedTarget(entity, heldID, {reason: "retarget", notifySelf: false});
        } catch (_error) {
          /* 放不掉就让引擎的常规流程接手 */
        }
      }
      let retried = null;
      try {
        retried = scene.finalizeTargetLock(entity, target, options);
      } catch (_error) {
        retried = null;
      }
      if (retried && retried.success === true) {
        return {ok: true, locked: true, lockDurationMs: 0, instant: true, releasedOldLock: true};
      }
    }
  }
  return {ok: true, locked: !pending, lockDurationMs: Math.max(0, Number(result.data && result.data.lockDurationMs) || 0)};
}

/**
 * Load ammo from the ship's cargo into turrets that have none.
 *
 * The engine only counts a charge as "loaded" when it sits in the ship container with the
 * SAME flagID as the module (`liveFittingState.getLoadedChargeByFlag`). Imported fittings
 * carry their ammo in the cargo hold, so before firing we move a compatible stack onto the
 * module's own flag. Returns how many turrets got loaded and why any failed.
 */
// 模块上次用的弹药型号：moduleItemID -> typeID（初次装填后一直用它，不再扫货舱）。
const ammoMemo = new Map();

function ensureAmmoLoaded(deps, request = {}) {
  const fitting = deps && deps.fitting;
  const itemStore = deps && deps.itemStore;
  const characterID = positive(request.characterID);
  const shipID = positive(request.shipID);
  const modules = Array.isArray(request.modules) ? request.modules : [];
  const result = {ok: true, loaded: 0, already: 0, problems: []};
  if (!fitting || typeof fitting.getLoadedChargeByFlag !== "function" || !itemStore) {
    return {ok: false, loaded: 0, already: 0, problems: ["NO_AMMO_API"]};
  }
  const empty = [];
  for (const entry of modules) {
    const moduleItem = entry && entry.moduleItem;
    const flagID = Number(moduleItem && moduleItem.flagID) || 0;
    if (!flagID) {
      continue;
    }
    let charge = null;
    try {
      charge = fitting.getLoadedChargeByFlag(characterID, shipID, flagID);
    } catch (_error) {
      charge = null;
    }
    if (charge) {
      result.already += 1;
      continue;
    }
    empty.push(entry);
  }
  if (empty.length === 0) {
    return result;
  }
  // 快速路径：这块模块以前装过弹药 → 直接按那个型号补 1 发（不扫货舱、不找堆）。
  const stillEmpty = [];
  for (const entry of empty) {
    const moduleItem = entry && entry.moduleItem;
    const moduleID = Number(moduleItem && moduleItem.itemID) || 0;
    const typeID = Number(ammoMemo.get(moduleID)) || 0;
    const flagID = Number(moduleItem && moduleItem.flagID) || 0;
    if (!typeID || !flagID) {
      stillEmpty.push(entry);
      continue;
    }
    let typeRecord = null;
    try {
      typeRecord = deps.resolveItemByTypeID ? deps.resolveItemByTypeID(typeID) : null;
    } catch (_error) {
      typeRecord = null;
    }
    if (!typeRecord || typeof itemStore.grantItemToOwnerLocation !== "function") {
      stillEmpty.push(entry);
      continue;
    }
    let granted = null;
    try {
      granted = itemStore.grantItemToOwnerLocation(characterID, shipID, flagID, typeRecord, 1, {});
    } catch (_error) {
      granted = null;
    }
    if (granted && granted.success === true) {
      result.loaded += 1;
      result.remembered = (Number(result.remembered) || 0) + 1;
      continue;
    }
    stillEmpty.push(entry);
  }
  if (stillEmpty.length === 0) {
    return result;
  }
  let cargo = [];
  try {
    cargo = itemStore.listContainerItems(characterID, shipID) || [];
  } catch (_error) {
    cargo = [];
  }
  // Charges still sitting in a cargo flag (5 = cargo hold, 4 = ?; anything that is not a
  // fitting slot is "not loaded").
  const loose = cargo.filter((item) => {
    const categoryID = Number(item && item.categoryID) || 0;
    const flagID = Number(item && item.flagID) || 0;
    return categoryID === CHARGE_CATEGORY_ID && !isFittingSlotFlag(flagID) && positive(item.itemID);
  });
  const compatible = typeof fitting.isChargeCompatibleWithModule === "function"
    ? (moduleTypeID, chargeTypeID) => {
      try {
        return fitting.isChargeCompatibleWithModule(moduleTypeID, chargeTypeID) === true;
      } catch (_error) {
        return false;
      }
    }
    : () => true;
  // Available charges per stack: a single stack must feed several turrets, so each move takes
  // one charge and the stack shrinks instead of being consumed by the first turret.
  const available = loose.map((item) => ({
    item,
    remaining: Math.max(1, Number(item.quantity) || 1),
  }));
  const splitSupported = typeof itemStore.moveItemToLocation === "function";
  for (const entry of empty) {
    const moduleItem = entry && entry.moduleItem;
    const flagID = Number(moduleItem && moduleItem.flagID) || 0;
    const typeID = Number(moduleItem && moduleItem.typeID) || 0;
    const candidate = available.find((slot) => slot.remaining > 0
      && compatible(typeID, Number(slot.item.typeID) || 0));
    if (!candidate) {
      result.problems.push(`NO_AMMO_IN_CARGO:${typeID}`);
      continue;
    }
    const item = candidate.item;
    try {
      const moved = splitSupported
        // One charge onto this turret's own flag; the rest of the stack stays in cargo.
        ? itemStore.moveItemToLocation(item.itemID, shipID, flagID, 1)
        : itemStore.updateInventoryItem(item.itemID, (row) => ({...row, flagID}));
      if (!moved || moved.success === false) {
        result.problems.push(`LOAD_FAILED:${item.itemID}:${(moved && moved.errorMsg) || "UNKNOWN"}`);
        continue;
      }
      // 记住这块模块用的是什么弹药：下一轮直接从记忆补，不再扫货舱。
      const moduleID = Number(moduleItem && moduleItem.itemID) || 0;
      if (moduleID && Number(item.typeID) > 0) {
        ammoMemo.set(moduleID, Number(item.typeID));
      }
      if (splitSupported) {
        candidate.remaining -= 1;
        result.loaded += 1;
      } else {
        // Whole-stack move: this stack is gone from cargo, count what it carried.
        result.loaded += Math.max(1, Number(item.quantity) || 1);
        candidate.remaining = 0;
      }
    } catch (error) {
      result.problems.push(`LOAD_FAILED:${item.itemID}:${error && error.message}`);
    }
  }
  return result;
}

/** Activate every turret on the target (re-targeting when it is already firing elsewhere). */
function activateOnTarget(request = {}) {
  const scene = request.scene;
  const session = request.session;
  const entity = request.entity;
  const target = request.target;
  const modules = Array.isArray(request.modules) ? request.modules : [];
  const activated = [];
  const errors = [];
  if (!scene || typeof scene.activateGenericModule !== "function") {
    return {ok: false, activated, errors: ["NO_ACTIVATION_API"]};
  }
  if (!entity || !target) {
    return {ok: false, activated, errors: ["BAD_TARGET"]};
  }
  const targetID = positive(target.itemID);
  const effects = entity.activeModuleEffects instanceof Map ? entity.activeModuleEffects : null;
  for (const entry of modules) {
    const moduleID = positive(entry.moduleItem && entry.moduleItem.itemID);
    if (!moduleID) {
      continue;
    }
    const existing = effects ? effects.get(moduleID) : null;
    if (existing && positive(existing.targetID) === targetID) {
      activated.push(moduleID);
      continue;
    }
    if (existing && typeof scene.deactivateGenericModule === "function") {
      try {
        scene.deactivateGenericModule(session, moduleID, {reason: "retarget", deferUntilCycle: false});
      } catch (_error) {
        /* the activation below reports the real failure */
      }
    }
    let result = null;
    try {
      const weaponItem = (Number(entry.moduleItem.locationID) === Number(entity.itemID))
        ? entry.moduleItem
        : {...entry.moduleItem, locationID: Number(entity.itemID)};
      result = scene.activateGenericModule(session, weaponItem, null, {targetID});
    } catch (error) {
      errors.push(`MODULE_${moduleID}:${error && error.message}`);
      continue;
    }
    if (!result || result.success !== true) {
      errors.push(`MODULE_${moduleID}:${(result && result.errorMsg) || "ACTIVATION_FAILED"}`);
      continue;
    }
    activated.push(moduleID);
  }
  return {ok: activated.length > 0, activated, errors};
}

/** Stop every active module of the ship (weapons included). */
function stopCombat(request = {}) {
  const scene = request.scene;
  const session = request.session;
  const entity = request.entity;
  if (!scene || !entity || !(entity.activeModuleEffects instanceof Map)) {
    return {ok: true, stopped: 0};
  }
  let stopped = 0;
  for (const moduleID of [...entity.activeModuleEffects.keys()]) {
    // P3 抗性常开：增强器是"影子"被动状态，不是交火中的模块。停火不该把它摘掉，
    // 否则会白丢一次抗性（还要再重算一遍）。
    const effectState = entity.activeModuleEffects.get(moduleID);
    if (effectState && effectState.passiveHardener === true) {
      continue;
    }
    // P1：模式（组 515）/遥修/指挥脉冲不是武器，停火不该把它们关掉。
    // 以前这里一次全关，下一秒各子系统又去重开，引擎回 MODULE_REACTIVATING —— 
    // Triage、遥修、指挥脉冲因此一直打不开，每次尝试还各扣一次燃料。
    if (effectState && effectState.nfKeepOnStop === true) {
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
  __clearAmmoMemo: () => ammoMemo.clear(),
  effectiveRangeMeters,
  positive,
  positionOf,
  isHostileShip,
  nearestHostile,
  // S1 target model (R1/R2/R3).
  isCapsuleEntity,
  isBlacklisted,
  blacklistUntil,
  scanCandidates,
  pickTargetFor,
  GROUP_CAPSULE_ID,
  surfaceDistance,
  isFittingSlotFlag,
  weaponModules,
  ensureAmmoLoaded,
  ensureTargetLock,
  activateOnTarget,
  stopCombat,
};
