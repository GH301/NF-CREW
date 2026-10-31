"use strict";

const path = require("node:path");
// 距离公式统一放在 geometry 里；这个模块只保留对外同名导出。
const geometry = require(path.join(__dirname, "nfCrewMiningGeometry.js"));

// M4: the mining drive — how a crew ship actually fills its own hold.
//
// Everything here is injected (`deps`), so the decision logic is testable:
//   deps.fitting        liveFittingState (fitted modules, online state, effects)
//   deps.miningDogma    isMiningEffectRecord
//   deps.miningState    miningRuntimeState (mineable asteroids of the scene)
//
// The native cycle does the work: `scene.activateGenericModule(session, module,
// effectName, {targetID})` starts a repeating mining cycle that grants ore into
// the *entity's* character hold (entity.characterID = the crew member), which is
// exactly what compression (§5.3) and delivery (§5.4) expect.

function positive(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

function vectorOf(value) {
  return {
    x: Number(value && value.x) || 0,
    y: Number(value && value.y) || 0,
    z: Number(value && value.z) || 0,
  };
}

/** Surface distance between two entities (centre distance minus both radii). */
function surfaceDistance(left, right) {
  return geometry.surfaceDistance(left, right);
}

/**
 * The session a module activation needs. It inherits the player's session (so
 * scene look-ups resolve) but points at the crew member's own character/ship —
 * the same shape npcMiningWing uses in game.
 */
function moduleSessionFor(playerSession, characterID, entity) {
  const character = positive(characterID);
  // 船员船自带 session（NPC 仇恨需要它）时，指令必须用同一个 session：
  // 引擎会拒绝来自"别的飞行员"的 stop/orbit/goto，表现为解散不消失、跟随不动。
  const ownSession = entity && entity.session;
  if (ownSession && positive(ownSession.characterID) === character && character > 0) {
    return ownSession;
  }
  const base = playerSession && typeof playerSession === "object" ? playerSession : {};
  const session = Object.create(base);
  const space = base._space && typeof base._space === "object" ? base._space : {};
  session.characterID = character;
  session.charid = character;
  session.characterId = character;
  session.shipID = positive(entity && entity.itemID);
  session._space = {
    ...space,
    systemID: positive(entity && entity.systemID) || positive(space.systemID),
    shipID: session.shipID,
    sceneKey: (entity && entity.sceneKey) || space.sceneKey,
    sceneKind: (entity && entity.sceneKind) || space.sceneKind,
    instanceID: (entity && entity.instanceID) || space.instanceID,
    sceneDescriptor: (entity && entity.sceneDescriptor) || space.sceneDescriptor,
  };
  session.__nfPseudoCrew = true;
  return session;
}

/**
 * Nearest asteroid worth mining, measured from `sourceEntity` (the player, so
 * the crew mines next to you). Returns {entity, distance} or null.
 */
/**
 * Is this entity an asteroid, and how much ore is left?
 *   {remaining: number|null}  → rock, null = state unknown (treat as mineable)
 *   null                      → not an asteroid, or known empty
 *
 * IMPORTANT: `ensureSceneMiningState` snapshots the scene once and caches it, so
 * `getMineableState` answers null for asteroids that appeared later (e.g. after
 * warping to another belt). Treat "unknown" as mineable — the activation itself
 * will refuse an empty rock.
 */
function rockOre(entity, request = {}) {
  const scene = request.scene;
  const miningState = request.miningState || null;
  if (!entity) {
    return null;
  }
  const isRock = miningState && typeof miningState.isMineableStaticEntity === "function"
    ? miningState.isMineableStaticEntity(entity) === true
    : String(entity.kind || "").toLowerCase() === "asteroid";
  if (!isRock) {
    return null;
  }
  let state = null;
  if (miningState && typeof miningState.getMineableState === "function") {
    try {
      state = miningState.getMineableState(scene, positive(entity.itemID));
    } catch (_error) {
      state = null;
    }
  }
  if (state && Number(state.remainingQuantity) <= 0) {
    return null;
  }
  return {remaining: state ? Number(state.remainingQuantity) : null};
}

function pickRock(request = {}) {
  const scan = scanRocks(request);
  return pickFromScan(scan, request, {allowFarther: false}).rock;
}

/**
 * P0.2：一次扫描同时给出「选哪块」和「为什么没选到」。
 * 以前 pickRock 扫一遍、失败后 rockInventory 再扫一遍，11 名船员就是 22 份全表扫描。
 * 半径内没有矿时它会返回最近的一块并标记 beyondRadius，由调用方决定要不要去。
 */
function pickRockDetailed(request = {}) {
  const scan = scanRocks(request);
  return {...pickFromScan(scan, request, {allowFarther: true}), inventory: scan.summary, rows: scan.rows};
}

/**
 * M2：选矿扫描的「静态判定」缓存。
 *
 * 一次全表扫描里最贵的是「这块 static 是不是矿」（`isMineableStaticEntity` +
 * `getMineableState`），而这与「从哪艘船量距离」无关。24 条船同时换矿时原来每人都要
 * 扫一遍全表，现在同一场景 2 秒内只扫一次。
 *
 * 只缓存「哪些 itemID 是矿 + 当拍的 remaining」这一半：
 *   - 矿采空时引擎会 `scene.removeStaticEntity()` 把实体摘掉，所以每拍用
 *     `scene.getEntityByID` 现取实体（拿不到 = 这块没了）；
 *   - `remaining` 每秒都在掉，缓存 2 秒会把刚采空的矿又选一遍，所以 remaining 也现取
 *     （`getMineableState` 是 O(1) 的 Map 查找，便宜）。
 */
const ROCK_SCAN_TTL_MS = 2000;
const scanBases = new WeakMap();

function scanBaseFor(scene, miningState) {
  const list = Array.isArray(scene.staticEntities) ? scene.staticEntities : [];
  const cached = scanBases.get(scene) || null;
  if (
    cached
    && Date.now() - cached.at <= ROCK_SCAN_TTL_MS
    && cached.statics === list.length
  ) {
    return cached;
  }
  const entries = [];
  for (const entity of list) {
    const itemID = positive(entity && entity.itemID);
    if (!itemID) {
      continue;
    }
    const isRock = miningState && typeof miningState.isMineableStaticEntity === "function"
      ? miningState.isMineableStaticEntity(entity) === true
      : String(entity.kind || "").toLowerCase() === "asteroid";
    if (!isRock) {
      continue;
    }
    // 只记「这块 static 是矿」；矿量（remaining）不缓存 —— 引擎在每次结算时会
    // 用新对象替换 state（updateMineableState 里 cache.set），缓存旧对象会读不到掉量。
    entries.push({itemID, entity});
  }
  const base = {at: Date.now(), statics: list.length, entries};
  scanBases.set(scene, base);
  return base;
}

/** 测试用：丢掉扫描缓存。 */
function clearScanCache() {
  scanBases.clear?.();
}

/**
 * The single pass both pickRock and rockInventory are built on.
 * rows 只包含「还可能有矿」的静态实体（rockOre 已经排除采空的）。
 */
function scanRocks(request = {}) {
  const scene = request.scene;
  const source = request.sourceEntity;
  const maxDistance = Number(request.maxDistanceMeters) || 0;
  const miningState = request.miningState || null;
  const summary = {
    statics: 0,
    rocks: 0,
    mineable: 0,
    unknown: 0,
    inRange: 0,
    nearestMineableMeters: null,
    nearestItemID: 0,
  };
  const rows = [];
  if (!scene || !source || !Array.isArray(scene.staticEntities)) {
    return {rows, summary};
  }
  const base = scanBaseFor(scene, miningState);
  summary.statics = base.statics;
  const lookup = typeof scene.getEntityByID === "function"
    ? (id) => scene.getEntityByID(id)
    : null;
  for (const entry of base.entries) {
    const {itemID} = entry;
    // 被采空摘掉的矿：有 getEntityByID 就以它为准（测试里的假场景没有这个 API，
    // 那就沿用缓存里的实体引用）。
    const entity = lookup ? lookup(itemID) : entry.entity;
    if (!entity) {
      continue;
    }
    // 实时矿量：`getMineableState` 是 O(1) 的 Map 查找（扫描缓存省下的是"整张 static 表
    // 逐个判定是不是矿"，不是这个查找）。
    let remaining = null;
    if (miningState && typeof miningState.getMineableState === "function") {
      const state = miningState.getMineableState(scene, itemID);
      remaining = state ? Number(state.remainingQuantity) : null;
      if (remaining !== null && Number.isFinite(remaining) && remaining <= 0) {
        continue;
      }
    }
    const distance = surfaceDistance(source, entity);
    if (maxDistance > 0 && distance <= maxDistance) {
      summary.inRange += 1;
    }
    if (summary.nearestMineableMeters === null || distance < summary.nearestMineableMeters) {
      summary.nearestMineableMeters = distance;
      summary.nearestItemID = itemID;
    }
    rows.push({entity, distance, remaining, itemID});
  }
  summary.rocks = rows.length;
  for (const row of rows) {
    if (row.remaining === null) {
      summary.unknown += 1;
    } else {
      summary.mineable += 1;
    }
  }
  return {rows, summary};
}

/**
 * 选矿：距离最近的「还没被别人认领」的那块；全都认领了就共享最近的一块。
 * `allowFarther` 时才退而给半径外最近的一块（标记 beyondRadius）。
 */
function pickFromScan(scan, request = {}, options = {}) {
  const maxDistance = Number(request.maxDistanceMeters) || 0;
  const exclude = request.excludeIDs instanceof Set
    ? request.excludeIDs
    : new Set(Array.isArray(request.excludeIDs) ? request.excludeIDs.map(positive) : []);
  const rows = Array.isArray(scan && scan.rows) ? scan.rows : [];
  const byDistance = (left, right) => left.distance - right.distance
    || positive(left.entity.itemID) - positive(right.entity.itemID);
  const inRange = maxDistance > 0 ? rows.filter((row) => row.distance <= maxDistance) : rows.slice();
  const free = inRange.filter((row) => !exclude.has(positive(row.itemID))).sort(byDistance);
  if (free.length > 0) {
    return {rock: {entity: free[0].entity, distance: free[0].distance}, beyondRadius: false};
  }
  // 射程内没有空闲矿：**先去更远的未认领矿**，而不是几个人挤同一块。
  // （watch tick 用 allowFarther=true；命令路径 allowFarther=false 时保持旧行为。）
  if (options.allowFarther === true) {
    const freeAnywhere = rows.filter((row) => !exclude.has(positive(row.itemID))).sort(byDistance);
    if (freeAnywhere.length > 0) {
      const row = freeAnywhere[0];
      return {
        rock: {entity: row.entity, distance: row.distance},
        beyondRadius: maxDistance > 0 && row.distance > maxDistance,
      };
    }
  }
  // 所有矿都被认领了：才退回"共用最近那一块"。
  const shared = (maxDistance > 0 ? inRange : rows).filter((row) => exclude.has(positive(row.itemID))).sort(byDistance);
  if (shared.length > 0) {
    return {rock: {entity: shared[0].entity, distance: shared[0].distance}, beyondRadius: false};
  }
  if (options.allowFarther !== true) {
    return {rock: null, beyondRadius: false};
  }
  const farther = rows.slice().sort(byDistance)[0] || null;
  if (!farther) {
    return {rock: null, beyondRadius: false};
  }
  return {rock: {entity: farther.entity, distance: farther.distance}, beyondRadius: true};
}

/** Highest module range of the resolved modules (metres), 0 when unknown. */
function moduleRange(modules) {
  let best = 0;
  for (const entry of Array.isArray(modules) ? modules : []) {
    const range = Number(entry && entry.rangeMeters);
    if (Number.isFinite(range) && range > best) {
      best = range;
    }
  }
  return best;
}

/**
 * What the scene actually offers: how many static entities there are, how many
 * still hold ore, and how far the nearest one with ore is. Used to explain
 * "no rock in range" instead of guessing.
 * P0.2：与 pickRock/scanRocks 共用同一份扫描（不再单独扫一遍）。
 */
function rockInventory(request = {}) {
  return scanRocks(request).summary;
}

/** Mining modules on the ship that are online. */
const CHARGE_CATEGORY_ID = 8;
// Slots that hold a fitted module (same ranges the server uses).
const FITTING_SLOT_RANGES = [[11, 34], [92, 99], [125, 132], [164, 171]];

function isFittingSlotFlag(flagID) {
  const flag = Number(flagID);
  if (!Number.isFinite(flag)) {
    return false;
  }
  return FITTING_SLOT_RANGES.some(([start, end]) => flag >= start && flag <= end);
}

function miningModules(deps, request = {}) {
  const fitting = deps && deps.fitting;
  const dogma = deps && deps.miningDogma;
  const characterID = positive(request.characterID);
  const shipID = positive(request.shipID);
  const problems = [];
  if (!fitting || typeof fitting.getFittedModuleItems !== "function") {
    return {ok: false, modules: [], problems: ["NO_FITTING_API"]};
  }
  let items = [];
  try {
    items = fitting.getFittedModuleItems(characterID, shipID) || [];
  } catch (error) {
    items = [];
  }
  if (items.length === 0) {
    // In game `getFittedModuleItems` answered 0 while the ship clearly held ten
    // fitted rows, so fall back to the container listing (owner + ship id) and
    // apply the same filter: a fitting slot flag and not a charge.
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
    if (typeof fitting.isModuleOnline === "function" && !fitting.isModuleOnline(moduleItem)) {
      problems.push(`MODULE_OFFLINE:${positive(moduleItem && moduleItem.itemID)}`);
      continue;
    }
    let effects = [];
    try {
      effects = typeof fitting.getTypeEffectRecords === "function"
        ? fitting.getTypeEffectRecords(positive(moduleItem && moduleItem.typeID)) || []
        : [];
    } catch (_error) {
      effects = [];
    }
    const effectRecord = dogma && typeof dogma.isMiningEffectRecord === "function"
      ? effects.find((record) => dogma.isMiningEffectRecord(record, moduleItem))
      : null;
    if (!effectRecord) {
      continue;
    }
    // The real max range (skills, rigs, bursts) comes from the dogma snapshot.
    let rangeMeters = 0;
    if (deps && deps.buildMiningSnapshot) {
      try {
        const snapshot = deps.buildMiningSnapshot({characterID, shipID, moduleItem, effectRecord, fittedItems: items});
        rangeMeters = Math.max(0, Number(snapshot && snapshot.maxRangeMeters) || 0);
      } catch (_error) {
        rangeMeters = 0;
      }
    }
    modules.push({moduleItem, effectRecord, rangeMeters});
  }
  if (modules.length === 0) {
    problems.push("NO_MINING_MODULE_ONLINE");
  }
  return {ok: modules.length > 0, modules, problems};
}

/**
 * A mining module refuses to activate until the rock is locked
 * (activateGenericModule → TARGET_NOT_LOCKED), so lock first. The lock itself
 * takes time, and the engine tells us how long in data.lockDurationMs.
 */
function ensureTargetLock(request = {}) {
  const scene = request.scene;
  const entity = request.entity;
  const rock = request.rock;
  if (!scene || !entity || !rock) {
    return {ok: false, locked: false, reason: "BAD_LOCK_REQUEST"};
  }
  const targetID = positive(rock.itemID);
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
  let result = null;
  try {
    result = scene.requestModuleTargetLock(entity, rock, {suppressTargetNotice: true});
  } catch (error) {
    return {ok: false, locked: false, reason: `LOCK_FAILED:${error && error.message}`};
  }
  if (!result || result.success !== true) {
    return {ok: false, locked: false, reason: `LOCK_REFUSED:${(result && result.errorMsg) || "UNKNOWN"}`};
  }
  const pending = Boolean(result.data && result.data.pending === true);
  const lockDurationMs = Math.max(0, Number(result.data && result.data.lockDurationMs) || 0);
  return {ok: true, locked: !pending, lockDurationMs};
}

/** Activate every mining module on the rock (re-targeting when needed). */
function activateOnRock(request = {}) {
  const scene = request.scene;
  const session = request.session;
  const entity = request.entity;
  const rock = request.rock;
  const modules = Array.isArray(request.modules) ? request.modules : [];
  // P0.1：一次最多「新开」几门。引擎每次激活都要重算全船属性（0.5–1.1 s），
  // 三门挤在一个 tick 里就是 2–3 s 的冻结；这里只开一门，其余交给下一 tick。
  const rawLimit = Number(request.maxNewActivations);
  const maxNewActivations = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.floor(rawLimit)
    : Number.MAX_SAFE_INTEGER;
  const activated = [];
  const errors = [];
  const effectStates = [];
  const remaining = [];
  let started = 0;
  if (!scene || typeof scene.activateGenericModule !== "function") {
    return {ok: false, activated, errors: ["NO_ACTIVATION_API"], effectStates, remaining, started};
  }
  if (!entity || !rock) {
    return {ok: false, activated, errors: ["BAD_TARGET"], effectStates, remaining, started};
  }
  const effects = entity.activeModuleEffects instanceof Map ? entity.activeModuleEffects : null;
  for (const entry of modules) {
    const moduleID = positive(entry.moduleItem && entry.moduleItem.itemID);
    if (!moduleID) {
      continue;
    }
    const existing = effects ? effects.get(moduleID) : null;
    if (existing && positive(existing.targetID) === positive(rock.itemID)) {
      activated.push(moduleID);
    // Record what the engine actually stored: remainingCycles === 1 means the
    // module runs ONE cycle and stops; null means it repeats.
    if (effects) {
      const state = effects.get(moduleID) || null;
      if (state) {
        effectStates.push({
          moduleID,
          remainingCycles: state.remainingCycles,
          durationMs: state.durationMs,
          targetID: state.targetID,
          miningEffect: state.miningEffect,
        });
      }
    }
      continue;
    }
    if (started >= maxNewActivations) {
      remaining.push({moduleItem: entry.moduleItem, effectRecord: entry.effectRecord, moduleID});
      continue;
    }
    if (existing && typeof scene.deactivateGenericModule === "function") {
      try {
        scene.deactivateGenericModule(session, moduleID, {reason: "target", deferUntilCycle: false});
      } catch (_error) {
        /* re-target below will report the failure if it matters */
      }
    }
    started += 1;
    let result = null;
    try {
      result = scene.activateGenericModule(
        session,
        entry.moduleItem,
        entry.effectRecord && entry.effectRecord.name,
        {targetID: rock.itemID},
      );
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
  return {ok: activated.length > 0, activated, errors, effectStates, remaining, started};
}

/** Stop every mining module of the ship. */
function stopMining(request = {}) {
  const scene = request.scene;
  const session = request.session;
  const entity = request.entity;
  if (!scene || !entity || !(entity.activeModuleEffects instanceof Map)) {
    return {ok: true, stopped: 0, problems: []};
  }
  let stopped = 0;
  for (const moduleID of [...entity.activeModuleEffects.keys()]) {
    try {
      scene.deactivateGenericModule(session, moduleID, {reason: "npc", deferUntilCycle: false});
      stopped += 1;
    } catch (_error) {
      /* best effort */
    }
  }
  return {ok: true, stopped, problems: []};
}

module.exports = {
  positive,
  surfaceDistance,
  moduleSessionFor,
  rockOre,
  pickRock,
  pickRockDetailed,
  pickFromScan,
  scanRocks,
  rockInventory,
  clearScanCache,
  miningModules,
  moduleRange,
  ensureTargetLock,
  activateOnRock,
  stopMining,
};
