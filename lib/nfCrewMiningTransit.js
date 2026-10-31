"use strict";

// M6: cross-system follow.
//
// The crew ships are session-less entities whose location lives in their ship
// item (`spaceState.systemID`). Crossing a gate is therefore: drop the entity
// from the old system's scene, move the item into the new system with a space
// state next to the player, then materialise it there (with the usual warp-in).
// Reference: npcMiningWing._moveWingAcrossGate.

function positive(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

/**
 * Where a ship should appear when it "comes through the gate": next to the
 * destination-side stargate that leads back to the system it left.
 */
function gateArrivalPoint(request = {}) {
  const scene = request.scene;
  const fromSystemID = positive(request.fromSystemID);
  const leader = request.leader || null;
  const statics = Array.isArray(scene && scene.staticEntities) ? scene.staticEntities : [];
  const gates = statics.filter((entity) => {
    const kind = String((entity && entity.kind) || "").toLowerCase();
    return kind === "gate" || kind === "stargate" || kind.includes("gate");
  });
  if (gates.length === 0) {
    return null;
  }
  const backGate = gates.find((entity) => {
    const destination = positive(
      entity && (entity.destinationSolarSystemID || entity.destinationID || entity.targetSystemID),
    );
    return destination > 0 && destination === fromSystemID;
  });
  const gate = backGate || gates[0];
  const gatePosition = gate && gate.position;
  if (!gatePosition) {
    return null;
  }
  const playerPosition = (leader && leader.position) || null;
  const dx = (playerPosition ? Number(playerPosition.x) - Number(gatePosition.x) : 1) || 1;
  const dy = playerPosition ? Number(playerPosition.y) - Number(gatePosition.y) : 0;
  const dz = playerPosition ? Number(playerPosition.z) - Number(gatePosition.z) : 0;
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  const offset = 0;
  return {
    position: {
      x: Number(gatePosition.x) + (dx / length) * offset,
      y: Number(gatePosition.y) + (dy / length) * offset,
      z: Number(gatePosition.z) + (dz / length) * offset,
    },
    gateID: positive(gate.itemID),
    viaBackGate: Boolean(backGate),
  };
}

/** Which summoned members are NOT in `systemID` yet. */
function planTransit(request = {}) {
  const members = Array.isArray(request.members) ? request.members : [];
  const systemID = positive(request.systemID);
  const systemOf = typeof request.systemOf === "function" ? request.systemOf : () => 0;
  const relocate = [];
  const stay = [];
  for (const member of members) {
    if (!member || !positive(member.shipID)) {
      continue;
    }
    const shipSystemID = positive(systemOf(member.shipID));
    if (!shipSystemID || shipSystemID === systemID) {
      stay.push(member);
      continue;
    }
    relocate.push({member, fromSystemID: shipSystemID});
  }
  return {relocate, stay, systemID};
}

/** System the crew member's ship item currently sits in. */
function shipSystemOf(deps, shipID) {
  try {
    const ship = deps.itemStore && typeof deps.itemStore.findShipItemById === "function"
      ? deps.itemStore.findShipItemById(positive(shipID))
      : null;
    const state = ship && ship.spaceState;
    return positive(state && state.systemID);
  } catch (_error) {
    return 0;
  }
}

/**
 * Move one crew ship from its current system into `toSystemID`, next to the
 * player, and materialise it there.
 */
function relocate(deps, request = {}) {
  const shipID = positive(request.shipID);
  const fromSystemID = positive(request.fromSystemID);
  const toSystemID = positive(request.toSystemID);
  const index = Math.max(0, Math.trunc(Number(request.index) || 0));
  if (!shipID || !fromSystemID || !toSystemID || fromSystemID === toSystemID) {
    return {ok: false, reason: "BAD_TRANSIT_REQUEST"};
  }
  const {ship, follow, mining} = deps;
  if (!ship || typeof ship.buildSpaceState !== "function" || typeof ship.ensureEntity !== "function") {
    return {ok: false, reason: "NO_SHIP_MODULE"};
  }
  // 1) drop the old entity (ignore "not there")
  try {
    const runtime = deps.runtime;
    const oldScene = runtime && typeof runtime.ensureScene === "function"
      ? runtime.ensureScene(fromSystemID)
      : null;
    if (oldScene && typeof oldScene.getEntityByID === "function" && oldScene.getEntityByID(shipID)) {
      // allowSessionOwned：船员船挂的是模组自己的无头 session，引擎默认会拒绝摘除。
      oldScene.removeDynamicEntity(shipID, {
        broadcast: true,
        persistSpaceState: false,
        allowSessionOwned: true,
      });
    }
  } catch (_error) {
    /* the old scene may already be gone */
  }
  // 2) move the ship item into the new system. Preferred: next to the
  // destination-side stargate, so it reads as "came through the gate".
  const gatePoint = gateArrivalPoint({
    scene: request.scene || null,
    fromSystemID,
    leader: request.leader || null,
  });
  const arrival = gatePoint
    ? {
      systemID: toSystemID,
      position: gatePoint.position,
      velocity: {x: 0, y: 0, z: 0},
      direction: {x: 1, y: 0, z: 0},
      targetPoint: gatePoint.position,
      speedFraction: 0,
      mode: "STOP",
      targetEntityID: null,
    }
    : ship.buildSpaceState({
      systemID: toSystemID,
      leader: request.leader || null,
      index,
    });
  try {
    const moved = deps.itemStore.moveShipToSpace(shipID, toSystemID, arrival);
    if (!moved || moved.success !== true) {
      return {ok: false, reason: `MOVE_REFUSED:${moved && moved.errorMsg}`};
    }
  } catch (error) {
    return {ok: false, reason: `MOVE_FAILED:${error && error.message}`};
  }
  // 3) materialise + warp in + follow
  const revived = ship.ensureEntity(deps, {
    session: request.session,
    scene: null,
    systemID: toSystemID,
    shipID,
    characterID: request.characterID,
    // No leader here: the ship already sits at the gate and must not be moved
    // again by ensureEntity's "2 AU behind the player" placement.
    leader: null,
  });
  if (revived.ok && gatePoint && request.leader && typeof ship.warpIn === "function") {
    const target = ship.buildSpaceState({
      systemID: toSystemID,
      leader: request.leader,
      index,
    });
    const warp = ship.warpIn(deps, {
      systemID: toSystemID,
      shipID,
      targetPoint: target.position,
    });
    if (warp && warp.ok) {
      revived.warped = true;
      revived.warpCompleteAtMs = warp.completeAtMs || 0;
    }
  }
  if (!revived.ok) {
    return {ok: false, reason: `SPAWN_FAILED:${revived.reason}`};
  }
  let followed = null;
  if (follow && typeof follow.follow === "function" && request.leader) {
    followed = follow.follow(deps, {
      session: request.session,
      systemID: toSystemID,
      followerShipID: shipID,
      leaderShipID: positive(request.leaderID),
      rangeMeters: Number(request.followRangeMeters) || 0,
    });
  }
  return {
    ok: true,
    warped: revived.warped === true,
    warpCompleteAtMs: revived.warpCompleteAtMs || 0,
    following: Boolean(followed && followed.ok),
  };
}

module.exports = {positive, planTransit, shipSystemOf, gateArrivalPoint, relocate};
