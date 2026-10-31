"use strict";

// Blueprint = "which ship, fitted with what" plus the preflight that decides
// whether it is worth spawning (PLAN.md §4.1, §4.1.1).
//
// Everything here is pure: the SDE object is injected, so tests run on a fake.

const path = require("node:path");

const {resolveSlot} = require(path.join(__dirname, "nfCrewMiningFitting.js"));

// Groups whose members can actually extract ore/ice/gas. "Mining Laser Upgrade"
// and rigs mention mining but are not tools, hence the exclusion list.
const MINING_GROUP_PATTERN = /strip miner|mining laser|^miner|ice harvester|gas cloud harvester|deep core|mining drone|excavator/i;
const NON_TOOL_GROUP_PATTERN = /upgrade|enhancer|rig\b|implant|blueprint|charge|ammo|crystal/i;
// Modules that need a loaded charge to run (heuristic: the "Modulated" family).
const CHARGE_GROUP_PATTERN = /modulated/i;

function isMiningToolName(groupName) {
  const name = String(groupName || "");
  return MINING_GROUP_PATTERN.test(name) && !NON_TOOL_GROUP_PATTERN.test(name);
}

const SHIP_CATEGORY_ID = 6;
const MODULE_CATEGORY_ID = 7;
const DRONE_CATEGORY_ID = 18;

// Flags that hold goods rather than fitted modules.
const CARGO_FLAGS = new Set([5, 90, 133, 134, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145,
  146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157]);

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function attributeOf(attributeMap, attributeID) {
  if (!attributeMap || !attributeMap.has(attributeID)) {
    return 0;
  }
  return number(attributeMap.get(attributeID));
}

/**
 * Turn one parsed client fitting into an inline blueprint.
 * Returns {ok, fit, problems, unresolved}.
 */
function buildInlineFit(fitting, sde) {
  const problems = [];
  const unresolved = [];
  if (!fitting) {
    return {ok: false, fit: null, problems: ["NO_FITTING"], unresolved};
  }

  const names = [fitting.shipType];
  for (const entry of fitting.hardware) {
    if (entry.type) {
      names.push(entry.type);
    }
    if (entry.charge && entry.charge.type) {
      names.push(entry.charge.type);
    }
  }
  const {resolved, missing} = sde.resolveNames(names);
  for (const name of missing) {
    unresolved.push(name);
  }

  const hullRecord = resolved.get(sde.normalizeName(fitting.shipType || ""));
  if (!hullRecord) {
    problems.push(`HULL_NOT_RESOLVED:${fitting.shipType || "(empty)"}`);
  }

  const modules = [];
  const drones = [];
  const cargo = [];
  for (const entry of fitting.hardware) {
    const flagID = entry.slotFlagID === null || entry.slotFlagID === undefined ? null : entry.slotFlagID;
    if (!flagID) {
      problems.push(`SLOT_UNRESOLVED:${entry.slot || "(empty)"}`);
      continue;
    }
    const record = resolved.get(sde.normalizeName(entry.type || ""));
    if (!record) {
      problems.push(`TYPE_NOT_RESOLVED:${entry.type || "(empty)"}`);
      continue;
    }
    const base = {
      slot: entry.slot,
      flagID,
      typeID: record.typeID,
      name: entry.type,
      quantity: Math.max(1, number(entry.qty, 1)),
    };
    if (entry.charge && entry.charge.type) {
      const chargeRecord = resolved.get(sde.normalizeName(entry.charge.type));
      if (chargeRecord) {
        base.charge = {
          typeID: chargeRecord.typeID,
          name: entry.charge.type,
          quantity: Math.max(1, number(entry.charge.qty, 1)),
        };
      } else {
        unresolved.push(entry.charge.type);
      }
    }
    if (flagID === 87) {
      drones.push(base);
    } else if (CARGO_FLAGS.has(flagID)) {
      cargo.push(base);
    } else {
      modules.push(base);
    }
  }

  const fit = {
    source: "inline",
    hull: hullRecord
      ? {typeID: hullRecord.typeID, name: fitting.shipType}
      : {typeID: 0, name: fitting.shipType},
    modules,
    drones,
    cargo,
  };
  return {ok: problems.length === 0, fit, problems, unresolved: [...new Set(unresolved)]};
}

/**
 * Preflight a blueprint against the SDE.
 *
 * The authority for CPU/PG is the engine at fit time (M2); this is a fast
 * offline estimate using the hull's base output plus the two management skills
 * a "skills: all" crew is assumed to have.
 */
function checkFit(fit, sde, options = {}) {
  const assumedSkills = options.skills || "all";
  const problems = [];
  const warnings = [];
  const stats = {
    cpu: {used: 0, max: 0},
    pg: {used: 0, max: 0},
    calibration: {used: 0, max: 0},
    droneBay: {used: 0, max: 0},
    slots: {},
  };

  if (!fit || !fit.hull || !number(fit.hull.typeID)) {
    return {ok: false, problems: ["NO_HULL"], warnings, stats, mining: false};
  }

  const hullTypeID = number(fit.hull.typeID);
  const modules = Array.isArray(fit.modules) ? fit.modules : [];
  const drones = Array.isArray(fit.drones) ? fit.drones : [];
  const typeIDs = [hullTypeID, ...modules.map((entry) => number(entry.typeID)),
    ...drones.map((entry) => number(entry.typeID))];

  const dogma = sde.loadDogmaAttributes(typeIDs);
  const records = sde.loadTypeRecords(typeIDs);
  const hullRecord = records.get(hullTypeID) || null;
  const hullAttributes = dogma.get(hullTypeID) || null;
  const attributes = sde.attributeIDs || {};

  // Groups must be loaded before the category check: types.jsonl carries no
  // categoryID, the type's group does.
  const groupIDs = new Set();
  for (const typeID of typeIDs) {
    const record = records.get(typeID);
    if (record && number(record.groupID)) {
      groupIDs.add(number(record.groupID));
    }
  }
  const groups = sde.loadGroupNames(groupIDs);
  const categoryOf = (typeID) => {
    if (typeof sde.categoryOf === "function") {
      return number(sde.categoryOf(typeID));
    }
    const record = records.get(number(typeID));
    return record ? number(record.categoryID) : 0;
  };
  const groupNameOf = (typeID) => {
    const record = records.get(typeID);
    const group = record ? groups.get(number(record.groupID)) : null;
    return group ? group.english || group.chinese || "" : "";
  };

  if (!hullRecord) {
    problems.push(`HULL_UNKNOWN:${hullTypeID}`);
  } else if (categoryOf(hullTypeID) !== SHIP_CATEGORY_ID) {
    problems.push(`HULL_NOT_A_SHIP:${categoryOf(hullTypeID)}`);
  }

  // Slots: count one per module, compare with the hull's own slot counts.
  const slotLimits = {
    hi: attributeOf(hullAttributes, attributes.hiSlots),
    med: attributeOf(hullAttributes, attributes.medSlots),
    low: attributeOf(hullAttributes, attributes.lowSlots),
    rig: attributeOf(hullAttributes, attributes.rigSlots),
  };
  const slotUsed = {hi: 0, med: 0, low: 0, rig: 0};
  const seenFlags = new Map();
  for (const entry of modules) {
    const flagID = number(entry.flagID);
    const quantity = Math.max(1, number(entry.quantity, 1));
    if (seenFlags.has(flagID)) {
      problems.push(`SLOT_USED_TWICE:${flagID}`);
    }
    seenFlags.set(flagID, entry);
    const family = flagID >= 27 && flagID <= 34
      ? "hi"
      : flagID >= 19 && flagID <= 26
        ? "med"
        : flagID >= 11 && flagID <= 18
          ? "low"
          : flagID >= 92 && flagID <= 99
            ? "rig"
            : null;
    if (!family) {
      problems.push(`UNSUPPORTED_SLOT_FLAG:${flagID}`);
      continue;
    }
    slotUsed[family] += quantity;
    const moduleAttributes = dogma.get(number(entry.typeID)) || null;
    stats.cpu.used += attributeOf(moduleAttributes, attributes.cpu) * quantity;
    stats.pg.used += attributeOf(moduleAttributes, attributes.power) * quantity;
    if (family === "rig") {
      stats.calibration.used += attributeOf(moduleAttributes, attributes.upgradeCost) * quantity;
    }
  }
  for (const family of ["hi", "med", "low", "rig"]) {
    const max = slotLimits[family];
    const used = slotUsed[family];
    stats.slots[family] = {used, max};
    if (max > 0 && used > max) {
      problems.push(`SLOT_OVERFLOW:${family}:${used}>${max}`);
    }
  }

  // CPU / PG: hull output × management skills (all skills = both at V → +25%).
  const skillFactor = assumedSkills === "all" ? 1.25 : 1;
  stats.cpu.max = Math.round(attributeOf(hullAttributes, attributes.cpuOutput) * skillFactor);
  stats.pg.max = Math.round(attributeOf(hullAttributes, attributes.powerOutput) * skillFactor);
  if (stats.cpu.max > 0 && stats.cpu.used > stats.cpu.max) {
    problems.push(`CPU_OVERFLOW:${Math.round(stats.cpu.used)}>${stats.cpu.max}`);
  }
  if (stats.pg.max > 0 && stats.pg.used > stats.pg.max) {
    problems.push(`PG_OVERFLOW:${Math.round(stats.pg.used)}>${stats.pg.max}`);
  }

  stats.calibration.max = attributeOf(hullAttributes, attributes.upgradeCapacity);
  if (stats.calibration.max > 0 && stats.calibration.used > stats.calibration.max) {
    problems.push(`CALIBRATION_OVERFLOW:${stats.calibration.used}>${stats.calibration.max}`);
  }

  // Drone bay volume (m³) and bandwidth.
  stats.droneBay.max = attributeOf(hullAttributes, attributes.droneCapacity);
  let bandwidthUsed = 0;
  for (const drone of drones) {
    const record = records.get(number(drone.typeID));
    const quantity = Math.max(1, number(drone.quantity, 1));
    stats.droneBay.used += (record ? number(record.volume) : 0) * quantity;
  }
  if (stats.droneBay.max > 0 && stats.droneBay.used > stats.droneBay.max) {
    problems.push(`DRONE_BAY_OVERFLOW:${round(stats.droneBay.used)}>${stats.droneBay.max}`);
  }
  const droneBandwidthMax = attributeOf(hullAttributes, attributes.droneBandwidth);
  if (droneBandwidthMax > 0) {
    stats.droneBandwidth = {used: bandwidthUsed, max: droneBandwidthMax};
  }

  // Can it actually mine?
  const miningModules = modules.filter((entry) => isMiningToolName(groupNameOf(number(entry.typeID))));
  const miningDrones = drones.filter((entry) => isMiningToolName(groupNameOf(number(entry.typeID))));
  const mining = miningModules.length > 0 || miningDrones.length > 0;
  if (!mining) {
    problems.push("NO_MINING_CAPABILITY");
  }

  // Charged modules without a charge (the client does not export charges).
  for (const entry of modules) {
    const groupName = groupNameOf(number(entry.typeID));
    if (CHARGE_GROUP_PATTERN.test(groupName) && !entry.charge) {
      warnings.push(`NEEDS_CHARGE:${entry.name || entry.typeID}`);
    }
  }
  for (const entry of drones) {
    if (categoryOf(number(entry.typeID)) !== DRONE_CATEGORY_ID) {
      warnings.push(`NOT_A_DRONE:${entry.name || entry.typeID}`);
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    warnings,
    mining,
    stats,
    hull: hullRecord
      ? {typeID: hullTypeID, english: hullRecord.english, chinese: hullRecord.chinese}
      : {typeID: hullTypeID, english: "", chinese: ""},
    groupNames: Object.fromEntries(
      [...groups.entries()].map(([groupID, group]) => [groupID, group.english || group.chinese]),
    ),
  };
}

function round(value) {
  return Math.round(number(value) * 100) / 100;
}

module.exports = {
  buildInlineFit,
  checkFit,
  isMiningToolName,
  MINING_GROUP_PATTERN,
  NON_TOOL_GROUP_PATTERN,
  CHARGE_GROUP_PATTERN,
  SHIP_CATEGORY_ID,
  MODULE_CATEGORY_ID,
  DRONE_CATEGORY_ID,
  CARGO_FLAGS,
};
