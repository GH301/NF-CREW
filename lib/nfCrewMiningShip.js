"use strict";

// M2: a crew member's own ship.
//
// Three steps, in this order (PLAN.md §5.1):
//   1. createShip   a real inventory ship owned by the crew character, fitted
//                   from the blueprint (modules in their slot flags, drones in
//                   the drone bay), and made that character's active ship
//   2. deployShip   moveShipToSpace(shipID, systemID, spaceState)
//   3. spawnEntity  spawnDynamicInventoryEntity(...) + identity
//
// The ownership is the point: the ship item's owner is the crew character, so
// the entity's ownerID is that character and the client draws the pilot.
//
// Everything the server owns is injected through `deps`, so this file is pure.

const DRONE_BAY_FLAG = 87;
const CARGO_HOLD_FLAG = 5;
// SDE group 53 = projectile/energy/hybrid turrets: the slots that need a loaded charge.
const TURRET_GROUP_ID = 53;
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
// EVE's astronomical unit in the metres this server uses for positions.
const AU_METERS = 149_597_870_700;

function resolveType(deps, typeID, name) {
  if (typeof deps.resolveItemByTypeID === "function") {
    const record = deps.resolveItemByTypeID(Number(typeID));
    if (record) {
      return record;
    }
  }
  return {typeID: Number(typeID), itemName: String(name || "")};
}

/**
 * Create the ship and fit it.
 * request = {characterID, stationID, fit, name}
 * Returns {ok, shipID, problems, granted}.
 */
function createShip(deps, request = {}) {
  const problems = [];
  const granted = {modules: 0, drones: 0, charges: 0};
  const characterID = Number(request.characterID) || 0;
  const fit = request.fit || null;
  if (!characterID) {
    return {ok: false, shipID: 0, problems: ["NO_CHARACTER"], granted};
  }
  if (!fit || !fit.hull || !Number(fit.hull.typeID)) {
    return {ok: false, shipID: 0, problems: ["NO_HULL"], granted};
  }
  if (!deps.itemStore) {
    return {ok: false, shipID: 0, problems: ["NO_ITEM_STORE"], granted};
  }

  const shipType = resolveType(deps, fit.hull.typeID, fit.hull.name);
  // spawnShipInStationHangar is the exported entry (createShipItemForCharacter
  // itself is module-private). Fall back to a plain item grant where the shape
  // differs between server builds.
  const created = typeof deps.itemStore.spawnShipInStationHangar === "function"
    ? deps.itemStore.spawnShipInStationHangar(characterID, Number(request.stationID) || 0, {
      typeID: shipType.typeID,
      name: String(request.name || shipType.name || shipType.itemName || ""),
    })
    : deps.itemStore.grantItemToOwnerLocation(
      characterID,
      Number(request.stationID) || 0,
      Number(deps.itemStore.ITEM_FLAGS && deps.itemStore.ITEM_FLAGS.HANGAR) || 4,
      shipType,
      1,
      {singleton: 1},
    );
  const createdItem = created && created.success === true
    ? (created.data && (created.data.itemID ? created.data : (created.data.items && created.data.items[0])))
    : null;
  if (!created || created.success !== true || !createdItem) {
    return {
      ok: false,
      shipID: 0,
      problems: [`SHIP_CREATE_FAILED:${created && created.errorMsg}`],
      granted,
    };
  }
  const shipID = Number(createdItem.itemID || createdItem.itemId) || 0;
  if (!shipID) {
    return {ok: false, shipID: 0, problems: ["SHIP_CREATE_NO_ITEM_ID"], granted};
  }

  // Cargo-hold charges (crystals/ammo) are not dumped into the hold: the engine only
  // counts a charge as loaded when it sits on the module's own flag, so they are spread
  // one per turret after the turrets exist, and the remainder goes to the hold.
  const pendingCharges = [];
  const turretSlots = [];

  for (const module of Array.isArray(fit.modules) ? fit.modules : []) {
    const type = resolveType(deps, module.typeID, module.name);
    const flagID = Number(module.flagID) || 0;
    const quantity = Math.max(1, Number(module.quantity) || 1);
    // Ammo/crystals arrive as cargo entries (flag 5) in the server's fitData. They are
    // STACKABLE: granting them as singletons with a module state silently failed, which is
    // why an imported battleship had eight pulse lasers and no crystals.
    const isCargoStack = flagID === CARGO_HOLD_FLAG || !isFittingSlotFlag(flagID);
    const resolvedModuleType = resolveType(deps, module.typeID, module.name);
    const moduleCategoryID = Number(resolvedModuleType && resolvedModuleType.categoryID) || 0;
    const moduleGroupID = Number(resolvedModuleType && resolvedModuleType.groupID) || 0;
    if (isCargoStack && moduleCategoryID === CHARGE_CATEGORY_ID) {
      pendingCharges.push({typeID: Number(module.typeID) || 0, quantity: Math.max(1, Number(quantity) || 1)});
      continue;
    }
    const result = deps.itemStore.grantItemToOwnerLocation(
      characterID,
      shipID,
      flagID,
      type,
      quantity,
      // Modules are granted ON ONLINE: activateGenericModule refuses an offline module
      // (MODULE_NOT_ONLINE), and nothing else in this mod onlines them.
      isCargoStack ? {} : {singleton: 1, moduleState: {online: true}},
    );
    if (!result || result.success !== true) {
      problems.push(`MODULE_GRANT_FAILED:${module.name || module.typeID}:${result && result.errorMsg}`);
      continue;
    }
    if (isCargoStack) {
      granted.charges += 1;
    } else {
      granted.modules += 1;
      if (moduleGroupID === TURRET_GROUP_ID) {
        turretSlots.push({flagID, typeID: Number(module.typeID) || 0});
      }
    }
    if (module.charge && Number(module.charge.typeID)) {
      const chargeType = resolveType(deps, module.charge.typeID, module.charge.name);
      const chargeResult = deps.itemStore.grantItemToOwnerLocation(
        characterID,
        shipID,
        flagID,
        chargeType,
        Math.max(1, Number(module.charge.quantity) || 1),
        {},
      );
      if (chargeResult && chargeResult.success === true) {
        granted.charges += 1;
      }
    }
  }

  // One charge per turret, remainder into the cargo hold.
  for (const slot of turretSlots) {
    const matchIndex = pendingCharges.findIndex((charge) => charge.quantity > 0
      && (typeof deps.fitting.isChargeCompatibleWithModule === "function"
        ? deps.fitting.isChargeCompatibleWithModule(slot.typeID, charge.typeID) === true
        : true));
    if (matchIndex < 0) {
      continue;
    }
    const charge = pendingCharges[matchIndex];
    const chargeType = resolveType(deps, charge.typeID, "");
    const loaded = deps.itemStore.grantItemToOwnerLocation(
      characterID,
      shipID,
      slot.flagID,
      chargeType,
      1,
      {},
    );
    if (loaded && loaded.success === true) {
      granted.charges += 1;
      charge.quantity -= 1;
    } else {
      problems.push(`CHARGE_LOAD_FAILED:${charge.typeID}:${loaded && loaded.errorMsg}`);
    }
  }
  for (const charge of pendingCharges) {
    if (charge.quantity <= 0) {
      continue;
    }
    const chargeType = resolveType(deps, charge.typeID, "");
    const stocked = deps.itemStore.grantItemToOwnerLocation(
      characterID,
      shipID,
      CARGO_HOLD_FLAG,
      chargeType,
      charge.quantity,
      {},
    );
    if (stocked && stocked.success === true) {
      granted.charges += 1;
    } else {
      problems.push(`CHARGE_GRANT_FAILED:${charge.typeID}:${stocked && stocked.errorMsg}`);
    }
  }

  for (const drone of Array.isArray(fit.drones) ? fit.drones : []) {
    const type = resolveType(deps, drone.typeID, drone.name);
    const result = deps.itemStore.grantItemToOwnerLocation(
      characterID,
      shipID,
      DRONE_BAY_FLAG,
      type,
      Math.max(1, Number(drone.quantity) || 1),
      {},
    );
    if (!result || result.success !== true) {
      problems.push(`DRONE_GRANT_FAILED:${drone.name || drone.typeID}:${result && result.errorMsg}`);
      continue;
    }
    granted.drones += Number(drone.quantity) || 1;
  }

  if (typeof deps.itemStore.setActiveShipForCharacter === "function") {
    try {
      deps.itemStore.setActiveShipForCharacter(characterID, shipID);
    } catch (error) {
      problems.push(`SET_ACTIVE_SHIP_FAILED:${error && error.message}`);
    }
  }

  return {ok: problems.length === 0, shipID, problems, granted};
}

/** Space state for a ship placed behind/beside the leader. */
function buildSpaceState(options = {}) {
  const leader = options.leader || null;
  const baseDistance = Number(options.distanceMeters);
  // No per-ship spread: every crew ship lands at the same point, exactly like a
  // fleet warp; they spread out afterwards through the follow order.
  const distance = Number.isFinite(baseDistance) && baseDistance > 0
    ? baseDistance
    : 0;
  const direction = normalizeVector(leader && leader.direction, {x: 1, y: 0, z: 0});
  const leaderPosition = vectorOf(leader && leader.position);
  const position = {
    x: leaderPosition.x - direction.x * distance,
    y: leaderPosition.y - direction.y * distance,
    z: leaderPosition.z - direction.z * distance,
  };
  return {
    systemID: Number(options.systemID) || 0,
    position,
    velocity: {x: 0, y: 0, z: 0},
    direction,
    targetPoint: position,
    speedFraction: 0,
    mode: "STOP",
    targetEntityID: null,
  };
}

/**
 * Warp a session-less ship in from far away.
 * The engine has a dedicated entry for this (npcs use it): it starts the warp,
 * suppresses the ship's visibility for a moment and acquires it on a later
 * scene tick — which is what makes the client draw a real "warp arrival"
 * (and therefore resolve the pilot) instead of "a ship appeared in place".
 */
function warpIn(deps, request = {}) {
  const shipID = Number(request.shipID) || 0;
  const systemID = Number(request.systemID) || 0;
  if (!shipID || !systemID) {
    return {ok: false, reason: "BAD_WARP_REQUEST"};
  }
  if (!deps.runtime || typeof deps.runtime.startSessionlessWarpIngress !== "function") {
    return {ok: false, reason: "NO_WARP_API"};
  }
  const options = {
    // The engine's own mining NPCs pass exactly this set (miningNpcOperations):
    // without broadcastWarpStartToVisibleSessions the client only sees a ball
    // appear — there is no warp animation at all.
    forceImmediateStart: true,
    broadcastWarpStartToVisibleSessions: true,
    visibilitySuppressMs: 250,
    // Native profile: the ingress duration comes from the ship's real warp
    // profile for that distance. With a fixed duration a 10 AU warp is
    // interpolated over ~2 s, which looks like a teleport near the end.
    useNativeWarpProfile: true,
    // Only used when the native profile is unavailable.
    ingressDurationMs: 2000,
    acquireForRelevantSessions: false,
    ...(request.options || {}),
  };
  let result = null;
  try {
    result = deps.runtime.startSessionlessWarpIngress(systemID, shipID, request.targetPoint, options);
  } catch (error) {
    return {ok: false, reason: `WARP_FAILED:${error && error.message}`};
  }
  if (!result || result.success !== true) {
    return {ok: false, reason: `WARP_REFUSED:${result && result.errorMsg}`};
  }
  return {
    ok: true,
    reason: null,
    completeAtMs: Number(result.data && result.data.ingressCompleteAtMs) || 0,
    data: result.data || null,
  };
}

// ---- cyno arrival (诱导入场) -------------------------------------------------
// The engine's real cynosural field (server/src/space/runtime/cynosuralField.js)
// needs a session and a fitted cyno generator, and it registers a fleet beacon so
// players can jump to it. A session-less crew ship has neither. So this does what
// evejs-faction-sim does: hand-build the same "cynoField" entity the client knows
// how to draw and hand it to the scene, picture only, no beacon - nobody can jump
// to it. It is the few seconds of picture before the ships jump in. The scene owns
// its lifetime through expiresAtMs, so no cleanup timer is needed here.
const CYNOSURAL_FIELD_TYPE_ID = 21094;
const CYNOSURAL_FIELD_GROUP_ID = 2020;
const CYNOSURAL_FIELD_CATEGORY_ID = 2;
const CYNOSURAL_FIELD_RADIUS_METERS = 250;
const JUMP_IN_FX_GUID = "effects.JumpDriveIn";
const JUMP_IN_FX_MS = 5000;
const JUMP_OUT_FX_GUID = "effects.JumpDriveOut";
const JUMP_OUT_FX_MS = 5000;
// 跳走之后多久才能摘实体：客户端在球被摘掉时会同时停掉特效和音效
// （parklife/fxSequencer.py DoBallRemove），所以必须等特效演完再摘。
const JUMP_OUT_HOLD_MS = JUMP_OUT_FX_MS + 1000;

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/**
 * Where the crew lands when it jumps in on a cyno: a ring around the beacon
 * instead of one point (a jump drive drops you near the field, not inside it).
 * radiusMeters 0 puts everyone on the beacon, which is the old warp landing.
 */
function buildCynoArrivalState(options = {}) {
  const center = vectorOf(options.center && options.center.position ? options.center.position : options.center);
  const direction = normalizeVector(options.center && options.center.direction, {x: 1, y: 0, z: 0});
  const count = Math.max(1, Math.trunc(Number(options.count) || 1));
  const index = Math.max(0, Math.trunc(Number(options.index) || 0));
  const radius = Math.max(0, Number(options.radiusMeters) || 0);
  // Basis across the leader's heading, so the ring stays visible whichever way it points.
  const up = Math.abs(direction.y) > 0.9 ? {x: 1, y: 0, z: 0} : {x: 0, y: 1, z: 0};
  const right = normalizeVector(cross(direction, up), {x: 0, y: 1, z: 0});
  const top = cross(right, direction);
  const angle = (2 * Math.PI * index) / count;
  const offsetX = (right.x * Math.cos(angle) + top.x * Math.sin(angle)) * radius;
  const offsetY = (right.y * Math.cos(angle) + top.y * Math.sin(angle)) * radius;
  const offsetZ = (right.z * Math.cos(angle) + top.z * Math.sin(angle)) * radius;
  const position = {
    x: center.x + offsetX,
    y: center.y + offsetY,
    z: center.z + offsetZ,
  };
  return {
    systemID: Number(options.systemID) || 0,
    position,
    velocity: {x: 0, y: 0, z: 0},
    direction,
    targetPoint: position,
    speedFraction: 0,
    mode: "STOP",
    targetEntityID: null,
  };
}

function cynoFieldMeta(deps, typeID) {
  let record = null;
  try {
    record = deps && typeof deps.resolveItemByTypeID === "function" ? deps.resolveItemByTypeID(typeID) : null;
  } catch (_error) {
    record = null;
  }
  return {
    typeID,
    groupID: Number(record && record.groupID) || CYNOSURAL_FIELD_GROUP_ID,
    categoryID: Number(record && record.categoryID) || CYNOSURAL_FIELD_CATEGORY_ID,
    radius: Math.max(1, Number(record && record.radius) || CYNOSURAL_FIELD_RADIUS_METERS),
    name: String((record && (record.itemName || record.name)) || "Cynosural Field"),
  };
}

/**
 * Light the cyno the crew jumps in on.
 * request = {scene, position, direction, typeID, durationMs, identity:{ownerID, corporationID, allianceID}}
 * Returns {ok, entityID, expiresAtMs} or {ok:false, reason}.
 */
function spawnCynoField(deps, request = {}) {
  const scene = request.scene
    || (deps && deps.runtime && typeof deps.runtime.getSceneForSession === "function" && request.session
      ? deps.runtime.getSceneForSession(request.session)
      : null);
  if (!scene || typeof scene.spawnDynamicEntity !== "function") {
    return {ok: false, reason: "NO_SCENE"};
  }
  const allocate = deps && typeof deps.allocateEntityID === "function" ? deps.allocateEntityID : null;
  if (!allocate) {
    return {ok: false, reason: "NO_ENTITY_ID"};
  }
  let entityID = 0;
  try {
    entityID = Number(allocate()) || 0;
  } catch (error) {
    return {ok: false, reason: `ENTITY_ID_FAILED:${error && error.message}`};
  }
  if (!entityID) {
    return {ok: false, reason: "ENTITY_ID_FAILED"};
  }
  // 没有锚点（玩家实体不在场景里）就不点灯：力场会落在星系原点，看不到还占地儿。
  if (!request.position) {
    return {ok: false, reason: "NO_POSITION"};
  }
  const position = vectorOf(request.position);
  const meta = cynoFieldMeta(deps, Math.trunc(Number(request.typeID)) || CYNOSURAL_FIELD_TYPE_ID);
  const durationMs = Math.max(1000, Math.trunc(Number(request.durationMs)) || 60000);
  const nowMs = typeof scene.getCurrentSimTimeMs === "function"
    ? Number(scene.getCurrentSimTimeMs()) || 0
    : Date.now();
  const identity = request.identity || {};
  const entity = {
    kind: "cynoField",
    itemID: entityID,
    typeID: meta.typeID,
    groupID: meta.groupID,
    categoryID: meta.categoryID,
    ownerID: Number(identity.ownerID) || 0,
    corporationID: Number(identity.corporationID) || 0,
    allianceID: Number(identity.allianceID) || 0,
    itemName: meta.name,
    position,
    velocity: {x: 0, y: 0, z: 0},
    direction: normalizeVector(request.direction, {x: 1, y: 0, z: 0}),
    targetPoint: {...position},
    radius: meta.radius,
    mode: "STOP",
    createdAtMs: nowMs,
    expiresAtMs: nowMs + durationMs,
    // Marks it as this mod's picture, not a jumpable beacon (also handy in a bug report).
    nfCrewCyno: true,
  };
  let result = null;
  try {
    result = scene.spawnDynamicEntity(entity, {broadcast: true});
  } catch (error) {
    return {ok: false, reason: `CYNOSURAL_SPAWN_FAILED:${error && error.message}`};
  }
  if (!result || result.success === false) {
    return {ok: false, reason: `CYNOSURAL_SPAWN_REFUSED:${result && result.errorMsg}`};
  }
  return {ok: true, entityID, expiresAtMs: entity.expiresAtMs, name: meta.name};
}

/**
 * The jump-in picture on a ship that has just appeared. evejs-faction-sim plays
 * the same guid on its jump arrivals; presentation only, nothing changes state.
 */
function jumpInFx(deps, request = {}) {
  const scene = request.scene
    || (deps && deps.runtime && typeof deps.runtime.getSceneForSession === "function" && request.session
      ? deps.runtime.getSceneForSession(request.session)
      : null);
  if (!scene || typeof scene.broadcastSpecialFx !== "function") {
    return {ok: false, reason: "NO_FX_API"};
  }
  const shipID = Number(request.shipID) || 0;
  const entity = request.entity
    || (shipID && typeof scene.getEntityByID === "function" ? scene.getEntityByID(shipID) : null);
  if (!entity) {
    return {ok: false, reason: "ENTITY_NOT_FOUND"};
  }
  const durationMs = Math.max(1, Math.trunc(Number(request.durationMs)) || JUMP_IN_FX_MS);
  try {
    scene.broadcastSpecialFx(
      Number(entity.itemID) || shipID,
      String(request.guid || JUMP_IN_FX_GUID),
      {start: true, active: false, duration: durationMs},
      entity,
    );
  } catch (error) {
    return {ok: false, reason: `FX_FAILED:${error && error.message}`};
  }
  return {ok: true, durationMs};
}

/**
 * Where a jump-out points when nobody named a system: the client turns the
 * effect toward graphicInfo[0] (Jump.py JumpDriveOut.Start), and only a
 * *different* system gives it a direction - pointing at our own system draws
 * nothing. Same rule evejs-faction-sim uses.
 */
function pickJumpDestination(scene, systemID) {
  const statics = scene && Array.isArray(scene.staticEntities) ? scene.staticEntities : [];
  const neighbours = statics
    .map((entity) => Math.trunc(Number(entity && entity.destinationSolarSystemID) || 0))
    .filter((id) => id > 0 && id !== Number(systemID));
  if (neighbours.length > 0) {
    return neighbours[0];
  }
  // A system without gates (a wormhole) still jumps "somewhere".
  return Number(systemID) === 30000142 ? 30000144 : 30000142;
}

/**
 * 跳离的画面（解散时用）：和 evejs-faction-sim 让旗舰跳离同一个 guid。
 * 只做表现，不搬船；调用方等 JUMP_OUT_HOLD_MS 之后再摘实体。
 * request = {scene, session, systemID, shipID, entity, targetSystemID, durationMs}
 */
function jumpOutFx(deps, request = {}) {
  const scene = request.scene
    || (deps && deps.runtime && typeof deps.runtime.getSceneForSession === "function" && request.session
      ? deps.runtime.getSceneForSession(request.session)
      : null);
  if (!scene || typeof scene.broadcastSpecialFx !== "function") {
    return {ok: false, reason: "NO_FX_API"};
  }
  const shipID = Number(request.shipID) || 0;
  const entity = request.entity
    || (shipID && typeof scene.getEntityByID === "function" ? scene.getEntityByID(shipID) : null);
  if (!entity) {
    return {ok: false, reason: "ENTITY_NOT_FOUND"};
  }
  const destination = Math.trunc(Number(request.targetSystemID))
    || pickJumpDestination(scene, Number(request.systemID) || Number(scene.systemID) || 0);
  const durationMs = Math.max(1, Math.trunc(Number(request.durationMs)) || JUMP_OUT_FX_MS);
  try {
    scene.broadcastSpecialFx(
      Number(entity.itemID) || shipID,
      String(request.guid || JUMP_OUT_FX_GUID),
      {
        start: true,
        active: false,
        duration: durationMs,
        // 「跳到哪个星系」：客户端靠它决定特效的方向。
        graphicInfo: {type: "tuple", items: [destination]},
      },
      entity,
    );
  } catch (error) {
    return {ok: false, reason: `FX_FAILED:${error && error.message}`};
  }
  return {
    ok: true,
    durationMs,
    destinationSystemID: destination,
    holdMs: Math.max(JUMP_OUT_FX_MS, durationMs) + 1000,
  };
}

// ---- 配装快照 / 签名（P1 库存用）-------------------------------------------
// 库存账本要能：① 按蓝图匹配库存里的船（签名）；② 显示这艘船装了什么（快照）。

const SLOT_RANGES = Object.freeze({
  low: [11, 18],
  med: [19, 26],
  high: [27, 34],
  rig: [92, 99],
  subsystem: [125, 132],
});

function slotFamilyOfFlag(flagID) {
  const flag = Number(flagID) || 0;
  for (const [family, [start, end]] of Object.entries(SLOT_RANGES)) {
    if (flag >= start && flag <= end) {
      return family;
    }
  }
  return "";
}

/** 船体 + 模块 typeID 的稳定签名（无人机/弹药不参与匹配，符合计价口径）。 */
function fitSignature(hullTypeID, moduleTypeIDs) {
  const hull = Number(hullTypeID) || 0;
  const modules = [...new Set((Array.isArray(moduleTypeIDs) ? moduleTypeIDs : []).map(Number).filter((id) => id > 0))]
    .sort((a, b) => a - b);
  return `${hull}|${modules.join(",")}`;
}

/** 蓝图 fit 的签名（用于"召唤时找匹配的库存船"）。 */
function blueprintSignature(fit) {
  const hullTypeID = Number(fit && fit.hull && fit.hull.typeID) || 0;
  const modules = (Array.isArray(fit && fit.modules) ? fit.modules : []).map((module) => Number(module && module.typeID));
  return fitSignature(hullTypeID, modules);
}

/** 蓝图 fit → 账本里的快照（不用读游戏物品）。 */
function snapshotFromBlueprint(fit) {
  const modules = {high: [], med: [], low: [], rig: [], subsystem: []};
  const drones = [];
  const cargo = [];
  const charges = [];
  for (const module of Array.isArray(fit && fit.modules) ? fit.modules : []) {
    const typeID = Number(module && module.typeID) || 0;
    if (!typeID) {
      continue;
    }
    const flag = Number(module.flagID) || 0;
    const quantity = Math.max(1, Number(module.quantity) || 1);
    const family = slotFamilyOfFlag(flag);
    if (family) {
      const entry = {flagID: flag, typeID, quantity};
      if (module.charge && Number(module.charge.typeID)) {
        entry.charge = Number(module.charge.typeID);
        entry.chargeQuantity = Math.max(1, Number(module.charge.quantity) || 1);
      }
      modules[family].push(entry);
    } else if (flag !== DRONE_BAY_FLAG) {
      cargo.push({typeID, quantity});
    }
  }
  for (const drone of Array.isArray(fit && fit.drones) ? fit.drones : []) {
    const typeID = Number(drone && drone.typeID) || 0;
    if (typeID) {
      drones.push({typeID, quantity: Math.max(1, Number(drone.quantity) || 1)});
    }
  }
  return {
    hullTypeID: Number(fit && fit.hull && fit.hull.typeID) || 0,
    modules,
    drones,
    cargo,
    charges,
    signature: blueprintSignature(fit),
  };
}

/** 真船 → 快照（按物品的 flagID 归类；弹药按炮位 flag 归到模块上）。 */
function snapshotFit(deps, request = {}) {
  const characterID = Number(request.characterID) || 0;
  const shipID = Number(request.shipID) || 0;
  const shipItem = deps && deps.itemStore && typeof deps.itemStore.findItemById === "function"
    ? deps.itemStore.findItemById(shipID)
    : null;
  let rows = [];
  try {
    rows = deps && deps.itemStore && typeof deps.itemStore.listContainerItems === "function"
      ? deps.itemStore.listContainerItems(characterID, shipID) || []
      : [];
  } catch (_error) {
    rows = [];
  }
  const modules = {high: [], med: [], low: [], rig: [], subsystem: []};
  const drones = [];
  const cargo = [];
  const charges = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const typeID = Number(row && row.typeID) || 0;
    if (!typeID) {
      continue;
    }
    const flag = Number(row && row.flagID) || 0;
    const quantity = Math.max(1, Number(row && row.quantity) || Number(row && row.stacksize) || 1);
    const categoryID = Number(row && row.categoryID) || 0;
    if (flag === DRONE_BAY_FLAG) {
      drones.push({typeID, quantity});
      continue;
    }
    if (flag === CARGO_HOLD_FLAG) {
      if (categoryID !== 8) {
        cargo.push({typeID, quantity});
      }
      continue;
    }
    const family = slotFamilyOfFlag(flag);
    if (!family) {
      continue;
    }
    if (categoryID === 8) {
      charges.set(flag, {typeID, quantity});
      continue;
    }
    modules[family].push({flagID: flag, typeID, quantity});
  }
  for (const family of Object.keys(modules)) {
    for (const module of modules[family]) {
      const charge = charges.get(module.flagID);
      if (charge) {
        module.charge = charge.typeID;
        module.chargeQuantity = charge.quantity;
      }
    }
  }
  const moduleTypeIDs = Object.values(modules).flat().map((module) => module.typeID);
  return {
    hullTypeID: Number(shipItem && shipItem.typeID) || 0,
    modules,
    drones,
    cargo,
    charges: [...charges.entries()].map(([flagID, charge]) => ({flagID, ...charge})),
    signature: fitSignature(Number(shipItem && shipItem.typeID) || 0, moduleTypeIDs),
  };
}

function vectorOf(value) {
  const x = Number(value && value.x);
  const y = Number(value && value.y);
  const z = Number(value && value.z);
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    z: Number.isFinite(z) ? z : 0,
  };
}

function normalizeVector(value, fallback) {
  const vector = vectorOf(value || fallback);
  const length = Math.sqrt(vector.x ** 2 + vector.y ** 2 + vector.z ** 2);
  if (!(length > 0)) {
    return {...fallback};
  }
  return {x: vector.x / length, y: vector.y / length, z: vector.z / length};
}

/** Put the ship in space at the given system. */
function deployShip(deps, request = {}) {
  if (!deps.itemStore || typeof deps.itemStore.moveShipToSpace !== "function") {
    return {ok: false, problems: ["NO_MOVE_SHIP_TO_SPACE"]};
  }
  const shipID = Number(request.shipID) || 0;
  const systemID = Number(request.systemID) || 0;
  if (!shipID || !systemID) {
    return {ok: false, problems: ["BAD_DEPLOY_REQUEST"]};
  }
  const spaceState = request.spaceState || buildSpaceState({systemID});
  const result = deps.itemStore.moveShipToSpace(shipID, systemID, spaceState);
  if (!result || result.success !== true) {
    return {ok: false, problems: [`MOVE_TO_SPACE_FAILED:${result && result.errorMsg}`]};
  }
  return {ok: true, problems: [], spaceState};
}

/** Materialise the ship in the scene and stamp the crew identity on it. */
/**
 * Recompute the ship's passive derived state from its fitted modules: armor/shield/
 * capacitor pools, mass, agility, signature, max velocity.
 *
 * The engine only does this for player ships, when a module is fitted
 * (services/chat/commands/fitModule.js -> refreshShipDerivedState). A sessionless crew
 * ship is never fitted through that path, so its plates, rigs, damage controls and
 * passive hardeners had NO effect on the entity — armor stayed at the bare hull value.
 */
function applyDerivedState(deps, {scene, entity} = {}) {
  if (!scene || !entity) {
    return {ok: false, reason: "NO_SCENE_OR_ENTITY"};
  }
  if (typeof scene.refreshShipEntityDerivedState !== "function") {
    return {ok: false, reason: "NO_REFRESH_API"};
  }
  try {
    scene.refreshShipEntityDerivedState(entity, {broadcast: true});
    return {ok: true};
  } catch (error) {
    return {ok: false, reason: `REFRESH_FAILED:${error && error.message}`};
  }
}

function spawnEntity(deps, request = {}) {
  const shipID = Number(request.shipID) || 0;
  const systemID = Number(request.systemID) || 0;
  const characterID = Number(request.characterID) || 0;
  if (!deps.runtime || typeof deps.runtime.spawnDynamicInventoryEntity !== "function") {
    return {ok: false, problems: ["NO_SPACE_RUNTIME"]};
  }
  if (!shipID || !systemID) {
    return {ok: false, problems: ["BAD_SPAWN_REQUEST"]};
  }
  const sceneDescriptor = request.sceneDescriptor || systemID;
  const result = deps.runtime.spawnDynamicInventoryEntity(sceneDescriptor, shipID, {
    sceneDescriptor,
    broadcast: true,
    broadcastOptions: {freshAcquire: true},
  });
  if (!result || result.success !== true) {
    return {ok: false, problems: [`SPAWN_FAILED:${result && result.errorMsg}`]};
  }
  const entity = (result.data && result.data.entity) || null;
  const problems = [];
  if (entity && characterID) {
    // The client reads the pilot from the slim item's ownerID (which comes from
    // the ship item, i.e. the crew character); these two keep the server-side
    // readers — compression ownership, mining yield, burst gate — on the same
    // identity.
    entity.characterID = characterID;
    entity.pilotCharacterID = characterID;
  } else if (!entity) {
    problems.push("SPAWN_NO_ENTITY");
  }

  // Re-broadcast the slim item: a hull published while the client is already in
  // the system keeps whatever pilot it resolved then, so without this the pilot
  // only appears after the client re-enters the system.
  let republished = false;
  let republishProblem = null;
  const warnings = [];
  const scene = request.scene
    || (typeof deps.runtime.getSceneForSession === "function" && request.session
      ? deps.runtime.getSceneForSession(request.session)
      : null);
  const republish = republishShip(deps, {scene, shipID});
  republished = republish.ok;
  if (!republish.ok) {
    republishProblem = republish.reason;
    warnings.push(`REPUBLISH_REFUSED:${republish.reason}`);
  }
  // The entity must be modelled from its fit, not from the bare hull: this is what
  // makes an armor plate / rig actually add armor once the crew ship exists.
  const derived = applyDerivedState(deps, {scene, entity});
  if (!derived.ok) {
    warnings.push(`DERIVED_STATE:${derived.reason}`);
  }
  // The entity existing is what matters; a failed re-broadcast only means the
  // client may need a system change before it draws the pilot.
  return {ok: problems.length === 0, problems, warnings, entity, republished, republishProblem, derived: derived.ok};
}

/**
 * Re-send a ship's slim item so a client already in the system re-resolves its
 * pilot. Ships are NOT "inventory backed" entities (isInventoryBackedDynamicEntity
 * excludes kind === "ship"), so the scene's refreshInventoryBackedEntityPresentation
 * always answers DYNAMIC_ENTITY_NOT_FOUND — the ship path is refresh the slim
 * payload fields, then broadcast the slim item.
 */
function republishShip(deps, request = {}) {
  const scene = request.scene;
  const shipID = Number(request.shipID) || 0;
  if (!scene || typeof scene.getEntityByID !== "function") {
    return {ok: false, reason: "NO_SCENE"};
  }
  const entity = scene.getEntityByID(shipID);
  if (!entity) {
    return {ok: false, reason: "ENTITY_NOT_FOUND"};
  }
  if (deps.runtime && typeof deps.runtime.refreshEntitiesForSlimPayload === "function") {
    try {
      deps.runtime.refreshEntitiesForSlimPayload([entity]);
    } catch (error) {
      return {ok: false, reason: `REFRESH_FAILED:${error && error.message}`};
    }
  }
  if (typeof scene.broadcastSlimItemChanges !== "function") {
    return {ok: false, reason: "NO_BROADCAST_API"};
  }
  try {
    scene.broadcastSlimItemChanges([entity]);
  } catch (error) {
    return {ok: false, reason: `BROADCAST_FAILED:${error && error.message}`};
  }
  return {ok: true, reason: null};
}

/**
 * Make sure the ship is materialized in the scene, re-spawning it from its item
 * when it is not (e.g. after a server restart). Used by recall.
 */
function ensureEntity(deps, request = {}) {
  const shipID = Number(request.shipID) || 0;
  const characterID = Number(request.characterID) || 0;
  const scene = request.scene
    || (typeof deps.runtime.getSceneForSession === "function" && request.session
      ? deps.runtime.getSceneForSession(request.session)
      : null);
  if (!scene) {
    return {ok: false, created: false, reason: "NO_SCENE"};
  }
  const existing = typeof scene.getEntityByID === "function" ? scene.getEntityByID(shipID) : null;
  if (existing) {
    // A ship that survived a scene rebuild still needs its fit applied.
    const derived = applyDerivedState(deps, {scene, entity: existing});
    return {
      ok: true,
      created: false,
      entity: existing,
      derived: derived.ok,
      warnings: derived.ok ? [] : [`DERIVED_STATE:${derived.reason}`],
    };
  }
  // Re-materialize from a distance and warp in, so a recall after a restart looks
  // like an arrival instead of a ship popping into existence.
  if (request.leader && Number(request.systemID)) {
    try {
      deps.itemStore.moveShipToSpace(
        shipID,
        Number(request.systemID),
        buildSpaceState({
          systemID: Number(request.systemID),
          leader: request.leader,
          distanceMeters: Math.round(AU_METERS * Math.max(0.5, Number(request.warpFromAu) || 2)),
        }),
      );
    } catch (_error) {
      /* fall through: the ship keeps its stored position */
    }
  }
  const spawned = spawnEntity(deps, {
    shipID,
    systemID: request.systemID,
    characterID,
    sceneDescriptor: request.sceneDescriptor || (scene && scene.sceneDescriptor),
    scene,
    session: request.session,
  });
  if (!spawned.ok || !spawned.entity) {
    return {ok: false, created: false, reason: spawned.problems.join(" · ") || "RESPAWN_FAILED"};
  }
  let warp = null;
  if (request.leader && Number(request.systemID)) {
    warp = warpIn(deps, {
      systemID: Number(request.systemID),
      sceneDescriptor: request.sceneDescriptor || (scene && scene.sceneDescriptor),
      shipID,
      targetPoint: buildSpaceState({systemID: Number(request.systemID), leader: request.leader}).position,
    });
  }
  return {
    ok: true,
    created: true,
    entity: spawned.entity,
    // Same fields as the "already exists" branch, so /crewmine refresh can report the
    // derived-state result for a hull it had to re-materialise as well.
    derived: spawned.derived === true,
    warnings: spawned.warnings || [],
    republished: spawned.republished,
    republishProblem: spawned.republishProblem,
    warped: Boolean(warp && warp.ok),
    warpCompleteAtMs: warp && warp.ok ? warp.completeAtMs : 0,
  };
}

/** What the ship actually contains (used to verify M2 in game). */
function describeShip(deps, request = {}) {
  const characterID = Number(request.characterID) || 0;
  const shipID = Number(request.shipID) || 0;
  if (!deps.itemStore || typeof deps.itemStore.listContainerItems !== "function") {
    return {ok: false, problems: ["NO_ITEM_STORE"], items: []};
  }
  try {
    const items = deps.itemStore.listContainerItems(characterID, shipID) || [];
    return {ok: true, problems: [], items};
  } catch (error) {
    return {ok: false, problems: [`LIST_FAILED:${error && error.message}`], items: []};
  }
}

/** Take the ship out of the scene (recall / disband). */
function removeEntity(deps, request = {}) {
  const shipID = Number(request.shipID) || 0;
  if (!shipID) {
    return {ok: false, problems: ["BAD_REMOVE_REQUEST"]};
  }
  if (!deps.runtime || typeof deps.runtime.getSceneForSession !== "function" || !request.session) {
    return {ok: false, skipped: true, problems: ["NO_SCENE"]};
  }
  let scene = null;
  try {
    scene = deps.runtime.getSceneForSession(request.session);
  } catch (error) {
    return {ok: false, problems: [`SCENE_FAILED:${error && error.message}`]};
  }
  if (!scene || typeof scene.removeDynamicEntity !== "function") {
    return {ok: false, skipped: true, problems: ["NO_REMOVE_API"]};
  }
  let present = null;
  try {
    present = typeof scene.getEntityByID === "function" ? scene.getEntityByID(shipID) : null;
  } catch (_error) {
    present = null;
  }
  if (!present) {
    return {ok: true, skipped: true, problems: []};
  }
  let result = null;
  try {
    // allowSessionOwned：船员船挂的是模组自己的无头 session（B 试验），
    // 引擎默认会以「这艘船归某个客户端所有」为由拒绝摘除。
    result = scene.removeDynamicEntity(shipID, {
      broadcast: true,
      persistSpaceState: false,
      allowSessionOwned: true,
    });
  } catch (error) {
    return {ok: false, problems: [`REMOVE_ENTITY_FAILED:${error && error.message}`]};
  }
  const ok = result === true || Boolean(result && result.success === true);
  return {ok, skipped: false, problems: ok ? [] : ["REMOVE_ENTITY_REFUSED"]};
}

/** Delete the ship item itself (disband). */
function removeShipItem(deps, request = {}) {
  const shipID = Number(request.shipID) || 0;
  if (!shipID) {
    return {ok: false, problems: ["BAD_REMOVE_REQUEST"]};
  }
  if (!deps.itemStore) {
    return {ok: false, problems: ["NO_ITEM_STORE"]};
  }
  if (typeof deps.itemStore.removeInventoryItem !== "function") {
    return {ok: false, problems: ["NO_REMOVE_API"]};
  }
  try {
    const result = deps.itemStore.removeInventoryItem(shipID);
    if (result === true || (result && result.success === true)) {
      return {ok: true, problems: []};
    }
    return {ok: false, problems: [`REMOVE_SHIP_FAILED:${result && result.errorMsg}`]};
  } catch (error) {
    return {ok: false, problems: [`REMOVE_SHIP_FAILED:${error && error.message}`]};
  }
}

/** Warp an entity away (used by disband so it leaves instead of blinking out). */
function warpOut(deps, request = {}) {
  const shipID = Number(request.shipID) || 0;
  const systemID = Number(request.systemID) || 0;
  if (!shipID || !systemID) {
    return {ok: false, reason: "BAD_WARP_REQUEST"};
  }
  if (!deps.runtime
    || (typeof deps.runtime.startSessionlessWarpIngress !== "function"
      && typeof deps.runtime.warpDynamicEntityToPoint !== "function")) {
    return {ok: false, reason: "NO_WARP_API"};
  }
  const scene = request.scene
    || (typeof deps.runtime.getSceneForSession === "function" && request.session
      ? deps.runtime.getSceneForSession(request.session)
      : null);
  const entity = scene && typeof scene.getEntityByID === "function" ? scene.getEntityByID(shipID) : null;
  if (!entity) {
    return {ok: false, reason: "ENTITY_NOT_FOUND"};
  }
  let targetPoint = request.targetPoint || null;
  if (!targetPoint) {
    const position = vectorOf(entity.position);
    const direction = normalizeVector(entity.direction, {x: 1, y: 0, z: 0});
    const distance = Number(request.distanceMeters) > 0 ? Number(request.distanceMeters) : AU_METERS;
    targetPoint = {
      x: position.x + direction.x * distance,
      y: position.y + direction.y * distance,
      z: position.z + direction.z * distance,
    };
  }
  let result = null;
  const warpOptions = {
    forceImmediateStart: true,
    broadcastWarpStartToVisibleSessions: true,
    visibilitySuppressMs: 250,
    useNativeWarpProfile: true,
    ingressDurationMs: 2500,
    acquireForRelevantSessions: false,
  };
  try {
    // Same entry as the arrival: it broadcasts the warp start, so the client
    // plays the departure instead of the ship blinking out.
    if (typeof deps.runtime.startSessionlessWarpIngress === "function") {
      result = deps.runtime.startSessionlessWarpIngress(systemID, entity, targetPoint, warpOptions);
    } else {
      result = deps.runtime.warpDynamicEntityToPoint(systemID, entity, targetPoint, warpOptions);
    }
  } catch (error) {
    return {ok: false, reason: `WARP_OUT_FAILED:${error && error.message}`};
  }
  if (!result || result.success !== true) {
    return {ok: false, reason: `WARP_OUT_REFUSED:${result && result.errorMsg}`};
  }
  return {
    ok: true,
    reason: null,
    targetPoint,
    completeAtMs: Number(result.data && result.data.ingressCompleteAtMs) || 0,
  };
}

module.exports = {
  DRONE_BAY_FLAG,
  AU_METERS,
  CYNOSURAL_FIELD_TYPE_ID,
  JUMP_IN_FX_GUID,
  JUMP_IN_FX_MS,
  JUMP_OUT_FX_GUID,
  JUMP_OUT_FX_MS,
  JUMP_OUT_HOLD_MS,
  createShip,
  deployShip,
  spawnEntity,
  ensureEntity,
  republishShip,
  // Exposed for the derived-state regression test (armor plates etc.).
  applyDerivedState,
  warpIn,
  warpOut,
  // Cyno arrival: the field, the jump-in picture, and the ring the crew lands on.
  spawnCynoField,
  jumpInFx,
  jumpOutFx,
  pickJumpDestination,
  buildCynoArrivalState,
  // P1 库存：配装快照与签名、槽位家族
  fitSignature,
  blueprintSignature,
  snapshotFromBlueprint,
  snapshotFit,
  slotFamilyOfFlag,
  SLOT_RANGES,
  buildSpaceState,
  describeShip,
  removeEntity,
  removeShipItem,
  normalizeVector,
  vectorOf,
};
