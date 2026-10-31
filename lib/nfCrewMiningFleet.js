"use strict";

// M3: put a crew member into the player's fleet (and a wing/squad if asked).
//
// The rule from PLAN.md §5.1: the mod never creates a fleet — the crew joins the
// one the player already commands. Every server call goes through `deps`.

const ROLE_MEMBER = 1;

/** Session-shaped object for a character that never logs in. */
function standInFor(member) {
  const characterID = Number(member && member.characterID) || 0;
  return {
    charid: characterID,
    characterID,
    characterId: characterID,
    characterName: String((member && member.name) || ""),
    languageID: "ZH",
    crewStandIn: true,
  };
}

function playerCharacterOf(session) {
  return Number(session && (session.characterID || session.charid)) || 0;
}

function fleetOf(deps, characterID) {
  if (!deps.fleetRuntime || typeof deps.fleetRuntime.getFleetForCharacter !== "function") {
    return null;
  }
  try {
    return deps.fleetRuntime.getFleetForCharacter(characterID) || null;
  } catch (_error) {
    return null;
  }
}

function fleetIDOf(fleet) {
  return Number(fleet && (fleet.fleetID || fleet.fleetid)) || 0;
}

/**
 * Join the player's fleet.
 * Returns {ok, fleetID, problems, alreadyInFleet}.
 */
function join(deps, request = {}) {
  const problems = [];
  const playerSession = request.playerSession;
  const playerCharacterID = playerCharacterOf(playerSession);
  const member = request.member;
  if (!playerCharacterID) {
    return {ok: false, fleetID: 0, problems: ["NO_PLAYER_SESSION"]};
  }
  if (!member || !Number(member.characterID)) {
    return {ok: false, fleetID: 0, problems: ["NO_MEMBER"]};
  }
  // PR-5: never pull another player's crew out of its fleet. The pool is per tenant,
  // but a character can be adopted/invited across accounts, so check the owner.
  const owner = Number(request.ownerAccountID) || 0;
  const memberOwner = Number(member.ownerAccountID) || 0;
  if (owner && memberOwner && owner !== memberOwner) {
    return {ok: false, fleetID: 0, problems: [`FOREIGN_CREW:${member.characterID}:${memberOwner}`]};
  }
  if (!deps.fleetRuntime) {
    return {ok: false, fleetID: 0, problems: ["NO_FLEET_RUNTIME"]};
  }
  const playerFleet = fleetOf(deps, playerCharacterID);
  const fleetID = fleetIDOf(playerFleet);
  if (!fleetID) {
    return {ok: false, fleetID: 0, problems: ["NO_PLAYER_FLEET"]};
  }
  const currentFleetID = fleetIDOf(fleetOf(deps, member.characterID));
  if (currentFleetID === fleetID) {
    return {ok: true, fleetID, problems, alreadyInFleet: true};
  }
  if (currentFleetID) {
    try {
      deps.fleetRuntime.forceLeaveFleet(standInFor(member));
    } catch (error) {
      problems.push(`LEAVE_OLD_FLEET_FAILED:${error && error.message}`);
    }
  }

  const standIn = standInFor(member);
  try {
    deps.fleetRuntime.inviteCharacter(playerSession, fleetID, member.characterID, null, null, undefined, {
      inviterCharID: playerCharacterID,
    });
  } catch (error) {
    return {ok: false, fleetID, problems: [...problems, `INVITE_FAILED:${error && error.message}`]};
  }
  try {
    deps.fleetRuntime.acceptInvite(standIn, fleetID, request.shipTypeID || null);
  } catch (error) {
    return {ok: false, fleetID, problems: [...problems, `ACCEPT_FAILED:${error && error.message}`]};
  }
  const joinedFleetID = fleetIDOf(fleetOf(deps, member.characterID));
  if (joinedFleetID !== fleetID) {
    problems.push(`JOIN_NOT_CONFIRMED:${joinedFleetID}`);
    return {ok: false, fleetID, problems};
  }
  return {ok: problems.length === 0, fleetID, problems, alreadyInFleet: false};
}

function wingsOf(deps, fleetID) {
  if (!deps.fleetRuntime || typeof deps.fleetRuntime.getWings !== "function") {
    return [];
  }
  let wings = null;
  try {
    wings = deps.fleetRuntime.getWings(fleetID);
  } catch (_error) {
    return [];
  }
  if (!wings) {
    return [];
  }
  return Array.isArray(wings) ? wings : [...wings.values()];
}

function findByName(collection, name) {
  const wanted = String(name || "").trim().toLowerCase();
  if (!wanted) {
    return null;
  }
  return collection.find((entry) => String((entry && (entry.name || entry.wingName || entry.squadName)) || "")
    .trim()
    .toLowerCase() === wanted) || null;
}

/**
 * Put the member into a named wing/squad, creating it on the player's behalf
 * when it does not exist yet. Blank names keep the default placement.
 * Returns {ok, wingID, squadID, problems}.
 */
function place(deps, request = {}) {
  const problems = [];
  const playerSession = request.playerSession;
  const fleetID = Number(request.fleetID) || 0;
  const characterID = Number(request.characterID) || 0;
  const wingName = String(request.wing || "").trim();
  const squadName = String(request.squad || "").trim();
  if (!fleetID || !characterID) {
    return {ok: false, wingID: null, squadID: null, problems: ["BAD_PLACE_REQUEST"]};
  }
  if (!deps.fleetRuntime) {
    return {ok: false, wingID: null, squadID: null, problems: ["NO_FLEET_RUNTIME"]};
  }
  if (!wingName && !squadName) {
    return {ok: true, wingID: null, squadID: null, problems};
  }

  let wings = wingsOf(deps, fleetID);
  let wing = findByName(wings, wingName);
  if (!wing && wingName && typeof deps.fleetRuntime.createWing === "function") {
    try {
      const created = deps.fleetRuntime.createWing(playerSession, fleetID, wingName);
      if (created) {
        wings = wingsOf(deps, fleetID);
        wing = findByName(wings, wingName) || created;
      }
    } catch (error) {
      problems.push(`CREATE_WING_FAILED:${error && error.message}`);
    }
  }
  const wingID = Number(wing && (wing.wingID || wing.wingid)) || null;

  let squadID = null;
  if (squadName) {
    const squads = wing && wing.squads
      ? (Array.isArray(wing.squads) ? wing.squads : [...wing.squads.values()])
      : [];
    let squad = findByName(squads, squadName);
    if (!squad && wingID && typeof deps.fleetRuntime.createSquad === "function") {
      try {
        const created = deps.fleetRuntime.createSquad(playerSession, fleetID, wingID, squadName);
        squad = created || null;
      } catch (error) {
        problems.push(`CREATE_SQUAD_FAILED:${error && error.message}`);
      }
    }
    squadID = Number(squad && (squad.squadID || squad.squadid)) || null;
  }

  if (wingID && typeof deps.fleetRuntime.moveMember === "function") {
    try {
      deps.fleetRuntime.moveMember(playerSession, fleetID, characterID, wingID, squadID, ROLE_MEMBER);
    } catch (error) {
      problems.push(`MOVE_MEMBER_FAILED:${error && error.message}`);
    }
  }
  return {ok: problems.length === 0, wingID, squadID, problems};
}

/** Remove the member from whatever fleet they are in. */
function leave(deps, request = {}) {
  const member = request.member;
  if (!deps.fleetRuntime || !member || !Number(member.characterID)) {
    return {ok: false, problems: ["BAD_LEAVE_REQUEST"]};
  }
  if (!fleetIDOf(fleetOf(deps, member.characterID))) {
    return {ok: true, problems: [], alreadyOut: true};
  }
  try {
    deps.fleetRuntime.forceLeaveFleet(standInFor(member));
  } catch (error) {
    return {ok: false, problems: [`LEAVE_FAILED:${error && error.message}`]};
  }
  const still = fleetIDOf(fleetOf(deps, member.characterID));
  return {ok: still === 0, problems: still ? [`LEAVE_NOT_CONFIRMED:${still}`] : []};
}

module.exports = {
  ROLE_MEMBER,
  standInFor,
  playerCharacterOf,
  fleetOf,
  fleetIDOf,
  join,
  place,
  leave,
  wingsOf,
  findByName,
};
