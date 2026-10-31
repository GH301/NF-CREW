"use strict";

// The pilot pool (PLAN.md §4.2, §4.3).
//
// A crew member costs two very different things:
//   * a character record + skills + corporation — expensive, kept forever
//   * a fitted ship + an entity — cheap, rebuilt every summon
// This module owns the first half: naming, the record shape the server accepts,
// and the reuse rules. Everything that touches the server goes through `deps`,
// so the pool can be unit-tested without a game server.

const crypto = require("node:crypto");
const path = require("node:path");

// Same shape npcMiningWing has used successfully in game (its fleet record
// builder) — the smallest record the server's own normalizer accepts.
const DEFAULT_CREW_ACCOUNT_ID = 9_000_001;
// Legacy alias: the single-account era read this directly. New code passes an
// explicit accountId — each tenant files its crew under its own synthetic account.
const ACCOUNT_ID = DEFAULT_CREW_ACCOUNT_ID;
const DEFAULT_STATION_ID = 60003760;
const DEFAULT_SYSTEM_ID = 30000142;
const DEFAULT_TYPE_ID = 1373;
const DEFAULT_CORPORATION_ID = 1000009;
const DESCRIPTION = "NPC crew member (managed by the nf-crew MOD).";

const GIVEN_NAMES = [
  "Kaelen", "Mira", "Riven", "Sora", "Dalen", "Iris", "Tomas", "Nadia", "Cato", "Vera",
  "Emil", "Lena", "Osric", "Talia", "Bren", "Sable", "Ivar", "Juno", "Roan", "Elise",
  "Anton", "Freya", "Hale", "Ines", "Joss", "Kira", "Lucan", "Mirae", "Nils", "Oriel",
];
const FAMILY_NAMES = [
  "Voss", "Sato", "Aker", "Brandt", "Corvin", "Delacour", "Eriksen", "Falk", "Grieve", "Holt",
  "Iversen", "Jelen", "Karr", "Lund", "Marek", "Nakamura", "Okafor", "Pell", "Quill", "Rask",
  "Sandoval", "Thane", "Ulrich", "Vale", "Weiss", "Xu", "Yarrow", "Zorin", "Askew", "Bishop",
];

function positive(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

function hashCode(text) {
  return crypto.createHash("sha1").update(String(text)).digest().readUInt32BE(0);
}

/** 名字唯一化：池里/游戏库里已有的名字（大小写不敏感）就加后缀，避免出现两个同名船员。 */
function uniqueMemberName(deps, baseName) {
  const wanted = String(baseName || "").trim();
  if (!wanted) {
    return wanted;
  }
  const taken = new Set();
  try {
    if (deps.characterName && typeof deps.characterName.getExistingCharacterNameKeys === "function") {
      for (const key of deps.characterName.getExistingCharacterNameKeys()) {
        taken.add(String(key).trim().toLowerCase());
      }
    }
  } catch (_error) {
    /* 没有校验器就只按传入名字用 */
  }
  let candidate = wanted;
  let index = 2;
  while (taken.has(candidate.toLowerCase()) && index <= 50) {
    candidate = `${wanted} ${index}`;
    index += 1;
  }
  return candidate;
}

/** Deterministic, player-like name for a character id (no randomness). */
function characterNameFor(characterID) {
  const seed = hashCode(`nf-crew:${positive(characterID)}`);
  const given = GIVEN_NAMES[seed % GIVEN_NAMES.length];
  const family = FAMILY_NAMES[Math.floor(seed / GIVEN_NAMES.length) % FAMILY_NAMES.length];
  return `${given} ${family}`;
}

/** The game's file time: 100 ns ticks since 1601-01-01, as a decimal string. */
function fileTimeNow(nowMs) {
  const numeric = Number(nowMs);
  const ms = Number.isFinite(numeric) ? Math.trunc(numeric) : Date.now();
  return (BigInt(ms) * 10000n + 116444736000000000n).toString();
}

function systemIdentity(worldData, systemID) {
  const requested = positive(systemID) || DEFAULT_SYSTEM_ID;
  let system = null;
  try {
    system = worldData && typeof worldData.getSolarSystemByID === "function"
      ? worldData.getSolarSystemByID(requested)
      : null;
  } catch (_error) {
    system = null;
  }
  if (!system || typeof system !== "object") {
    return {solarSystemID: requested, constellationID: 0, regionID: 0};
  }
  return {
    solarSystemID: positive(system.solarSystemID || system.solarsystemid) || requested,
    constellationID: positive(system.constellationID || system.constellationid),
    regionID: positive(system.regionID || system.regionid),
  };
}

function bloodlineProfile(creation, bloodlineID = 0) {
  const fallback = {
    bloodlineID: 1,
    raceID: 1,
    corporationID: DEFAULT_CORPORATION_ID,
    typeID: DEFAULT_TYPE_ID,
  };
  try {
    if (creation && typeof creation.resolveCharacterCreationBloodlineProfile === "function") {
      const profile = creation.resolveCharacterCreationBloodlineProfile(bloodlineID, {});
      if (profile && typeof profile === "object") {
        return {
          bloodlineID: positive(profile.bloodlineID) || fallback.bloodlineID,
          raceID: positive(profile.raceID) || fallback.raceID,
          corporationID: positive(profile.corporationID) || fallback.corporationID,
          typeID: positive(profile.typeID) || fallback.typeID,
        };
      }
    }
  } catch (_error) {
    /* a missing creation table must not stop a record from being written */
  }
  return fallback;
}

function schoolIDFor(creation, raceID) {
  try {
    if (creation && typeof creation.resolveCharacterCreationSchoolIDForRace === "function") {
      return positive(creation.resolveCharacterCreationSchoolIDForRace(0, raceID, 11)) || 11;
    }
  } catch (_error) {
    /* fall through to the default school */
  }
  return 11;
}

/**
 * Build one character record (field list mirrors what works in game).
 * options = {characterID, name, stationID, systemID, worldData, creation, bloodlineID, nowMs}
 */
function buildRecord(options = {}) {
  const characterID = positive(options.characterID);
  if (!characterID) {
    return null;
  }
  const stationID = positive(options.stationID) || DEFAULT_STATION_ID;
  const system = systemIdentity(options.worldData, options.systemID);
  const profile = bloodlineProfile(options.creation, options.bloodlineID);
  const schoolID = schoolIDFor(options.creation, profile.raceID);
  const now = fileTimeNow(options.nowMs);
  const name = String(options.name || characterNameFor(characterID));
  // A crew member can start life inside the player's corporation.
  const corporationID = positive(options.corporationID) || profile.corporationID;
  const allianceID = positive(options.allianceID);

  return {
    accountId: positive(options.accountId) || DEFAULT_CREW_ACCOUNT_ID,
    characterID,
    characterName: name,
    gender: 1,
    bloodlineID: profile.bloodlineID,
    ancestryID: profile.bloodlineID,
    raceID: profile.raceID,
    typeID: profile.typeID,
    corporationID,
    schoolID,
    allianceID,
    stationID,
    homeStationID: stationID,
    cloneStationID: stationID,
    solarSystemID: system.solarSystemID,
    constellationID: system.constellationID,
    regionID: system.regionID,
    createDateTime: now,
    startDateTime: now,
    logoffDate: now,
    deletePrepareDateTime: null,
    lockTypeID: null,
    securityRating: 0,
    title: "",
    description: DESCRIPTION,
    balance: 0,
    aurBalance: 0,
    plexBalance: 0,
    balanceChange: 0,
    walletJournal: [],
    plexVaultTransactions: [],
    skillPoints: 0,
    bounty: 0,
    employmentHistory: [{corporationID, startDate: now, deleted: 0}],
    standingData: {char: [], corp: [], npc: []},
    characterAttributes: {
      charisma: 20,
      intelligence: 20,
      memory: 20,
      perception: 20,
      willpower: 20,
    },
    freeSkillPoints: 0,
    skillHistory: [],
    boosters: [],
    implants: [],
    jumpClones: [],
    finishedSkills: [],
    appearanceInfo: null,
    portraitInfo: null,
    paperDollState: 2,
  };
}

/**
 * How many of the requested crew can come from the pool and how many need a new
 * character.
 *
 * 规则（2026-10-24 定稿）：
 *   - **在役 = 占用**：`summoned === true` 的人永远不参与，绝不为了凑数去拆正在飞的船；
 *   - 优先同蓝图，其次**跨蓝图借调**（角色只是驾驶员，换蓝图 = 换船/换装，调用方负责
 *     把 `blueprintID` 重贴成目标蓝图）；
 *   - 只有空闲角色不够时才新建。
 *
 * 返回 {reuse, create, borrowed}：borrowed 是 reuse 里蓝图不同的那些，供调用方记日志/重贴。
 */
function selectForSpawn({pool, blueprintID, count, ownerAccountID}) {
  const wanted = Math.max(0, Math.trunc(Number(count) || 0));
  const owner = positive(ownerAccountID);
  const available = (Array.isArray(pool) ? pool : [])
    .filter((entry) => entry && entry.summoned !== true)
    // An entry without an owner predates the tenant split; it belongs to whoever
    // owns the file it was read from, so it stays reusable.
    .filter((entry) => !owner || !positive(entry.ownerAccountID) || positive(entry.ownerAccountID) === owner)
    .sort((left, right) => {
      const leftSame = left.blueprintID === blueprintID ? 0 : 1;
      const rightSame = right.blueprintID === blueprintID ? 0 : 1;
      // 同蓝图优先，其次最早释放/最早创建，保证同一个位置永远落到同一个人。
      return leftSame - rightSame
        || (left.releasedAtMs || 0) - (right.releasedAtMs || 0)
        || (left.createdAtMs || 0) - (right.createdAtMs || 0)
        || left.characterID - right.characterID;
    });
  const reuse = available.slice(0, wanted);
  return {
    reuse,
    create: Math.max(0, wanted - reuse.length),
    borrowed: reuse.filter((entry) => entry.blueprintID !== blueprintID),
  };
}

function markSummoned(entry, {shipID, hangarLocationID, nowMs}) {
  entry.summoned = true;
  entry.shipID = positive(shipID);
  entry.hangarLocationID = positive(hangarLocationID);
  entry.releasedAtMs = 0;
  entry.summonedAtMs = Number(nowMs) || Date.now();
  return entry;
}

function markReleased(entry, {nowMs, hangarLocationID}) {
  entry.summoned = false;
  entry.shipID = 0;
  if (positive(hangarLocationID)) {
    entry.hangarLocationID = positive(hangarLocationID);
  }
  entry.releasedAtMs = Number(nowMs) || Date.now();
  return entry;
}

/** What `pool clear` has to remove (PLAN.md §4.3). */
function planPurge(pool) {
  const entries = (Array.isArray(pool) ? pool : []).filter(Boolean);
  return {
    characterIDs: entries.map((entry) => positive(entry.characterID)).filter(Boolean),
    shipIDs: entries.map((entry) => positive(entry.shipID)).filter(Boolean),
    entries,
  };
}

function newPoolEntry({characterID, name, blueprintID, corporationID, nowMs, skillsSeeded, ownerAccountID}) {
  return {
    characterID: positive(characterID),
    name: String(name || characterNameFor(characterID)),
    blueprintID: String(blueprintID || ""),
    corporationID: positive(corporationID),
    ownerAccountID: positive(ownerAccountID),
    skillsSeeded: skillsSeeded === true,
    source: "blueprint",
    shipID: 0,
    hangarLocationID: 0,
    summoned: false,
    createdAtMs: Number(nowMs) || Date.now(),
    releasedAtMs: 0,
    // PLAN §18.5：特殊装备开关（堡垒 / 会战），默认都关。
    special: {
      bastion: false,
      siege: false,
      smartbomb: false,
      triage: false,
      industrialCore: false,
      special515: false,
    },
  };
}

/**
 * Create one pool member through the injected server deps.
 * deps = {identityAllocator, characterState, skillsSeed?, worldData, creation?, log?}
 */
function createMember(deps, request = {}) {
  const log = (deps && deps.log) || (() => {});
  const allocate = deps && deps.identityAllocator && deps.identityAllocator.reserveCharacterID;
  if (typeof allocate !== "function") {
    throw new Error("NF_CREW_MINING_NO_IDENTITY_ALLOCATOR");
  }
  const characterID = positive(allocate.call(deps.identityAllocator));
  if (!characterID) {
    throw new Error("NF_CREW_MINING_CHARACTER_ID_ALLOCATION_FAILED");
  }
  const record = buildRecord({
    characterID,
    accountId: request.accountId,
    // 仓库角色要自定义名字（<玩家名>NFCREW）；普通船员仍用确定性随机名。
    // 统一再做一次唯一化：同名船员会让日志/按名字下命令都分不清。
    name: uniqueMemberName(deps, request.name || characterNameFor(characterID)),
    stationID: request.stationID,
    systemID: request.systemID,
    worldData: deps.worldData,
    creation: deps.creation,
    bloodlineID: request.bloodlineID,
    corporationID: request.corporationID,
    allianceID: request.allianceID,
    nowMs: request.nowMs,
  });
  if (!record) {
    throw new Error("NF_CREW_MINING_RECORD_BUILD_FAILED");
  }
  // writeCharacterRecord(charId, record, options) — the id is the FIRST
  // argument; passing only the record makes the store JSON.parse(undefined).
  const written = deps.characterState && typeof deps.characterState.writeCharacterRecord === "function"
    ? deps.characterState.writeCharacterRecord(characterID, record)
    : {success: false, errorMsg: "NO_CHARACTER_STATE"};
  // writeCharacterRecord reports {success, errorMsg} — never a boolean.
  if (!written || written.success !== true) {
    throw new Error(`NF_CREW_MINING_CHARACTER_WRITE_FAILED:${written && written.errorMsg}`);
  }

  let skillsSeeded = false;
  if (typeof deps.skillsSeed === "function") {
    try {
      deps.skillsSeed(characterID);
      skillsSeeded = true;
    } catch (error) {
      log(`全技能播种失败 char=${characterID}: ${error && error.message}`);
    }
  } else {
    log(`没有 skillsSeed 依赖，角色 ${characterID} 将没有技能`);
  }

  // Put the character into the requested corporation properly: the affiliation
  // API also writes the employment history and the membership start date.
  const problems = [];
  const corporationID = positive(request.corporationID);
  const allianceID = positive(request.allianceID);
  if (corporationID) {
    try {
      if (deps.corporations && typeof deps.corporations.setCharacterAffiliation === "function") {
        const result = deps.corporations.setCharacterAffiliation(characterID, corporationID, allianceID || null);
        if (result && result.success === false) {
          problems.push(`AFFILIATION_FAILED:${result.errorMsg}`);
        }
      }
    } catch (error) {
      problems.push(`AFFILIATION_FAILED:${error && error.message}`);
    }
    try {
      if (deps.corporationRuntime && typeof deps.corporationRuntime.ensureCharacterMemberState === "function") {
        deps.corporationRuntime.ensureCharacterMemberState(corporationID, characterID);
        if (typeof deps.corporationRuntime.syncMemberStateToCharacterRecord === "function") {
          deps.corporationRuntime.syncMemberStateToCharacterRecord(corporationID, characterID);
        }
      }
    } catch (error) {
      problems.push(`CORP_MEMBER_STATE_FAILED:${error && error.message}`);
    }
  }

  let verified = null;
  try {
    verified = deps.characterState && typeof deps.characterState.peekCharacterRecord === "function"
      ? deps.characterState.peekCharacterRecord(characterID)
      : null;
  } catch (_error) {
    verified = null;
  }
  if (!verified) {
    log(`角色 ${characterID} 写盘后复核失败（继续，召唤时会再验一次）`);
  }

  if (problems.length > 0) {
    log(`角色 ${characterID} 军团设置问题：${problems.join(" · ")}`);
  }

  return newPoolEntry({
    characterID,
    name: record.characterName,
    blueprintID: request.blueprintID,
    corporationID: record.corporationID,
    nowMs: request.nowMs,
    skillsSeeded,
    ownerAccountID: request.ownerAccountID,
  });
}

/**
 * Remove every pooled character through the injected deps.
 * deps = {characterState, ships?: {removeShip(shipID)}, log?}
 */
function purgeMembers(deps, plan) {
  const log = (deps && deps.log) || (() => {});
  const removed = [];
  const leftovers = [];
  for (const shipID of plan.shipIDs) {
    try {
      if (deps.ships && typeof deps.ships.removeShip === "function") {
        deps.ships.removeShip(shipID);
      }
    } catch (error) {
      leftovers.push(`ship ${shipID}: ${error && error.message}`);
    }
  }
  for (const characterID of plan.characterIDs) {
    try {
      const result = deps.characterState && typeof deps.characterState.removeCharacterRecord === "function"
        ? deps.characterState.removeCharacterRecord(characterID)
        : {success: false, errorMsg: "NO_CHARACTER_STATE"};
      if (result && result.success === true) {
        removed.push(characterID);
      } else {
        leftovers.push(`character ${characterID}: ${result && result.errorMsg}`);
      }
    } catch (error) {
      leftovers.push(`character ${characterID}: ${error && error.message}`);
    }
  }
  if (leftovers.length > 0) {
    log(`pool clear 残留：${leftovers.join(" · ")}`);
  }
  return {removed, leftovers};
}

module.exports = {
  ACCOUNT_ID,
  DEFAULT_CREW_ACCOUNT_ID,
  DEFAULT_STATION_ID,
  DEFAULT_SYSTEM_ID,
  DEFAULT_CORPORATION_ID,
  DESCRIPTION,
  GIVEN_NAMES,
  FAMILY_NAMES,
  characterNameFor,
  uniqueMemberName,
  fileTimeNow,
  buildRecord,
  selectForSpawn,
  markSummoned,
  markReleased,
  planPurge,
  newPoolEntry,
  createMember,
  purgeMembers,
};
