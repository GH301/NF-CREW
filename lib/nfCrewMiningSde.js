"use strict";

// SDE access for nf-crew.
//
// The static data the server ships is what we resolve names against:
//   types.jsonl        one record per type; `name` is a MULTI-LANGUAGE object
//                      ({de,en,es,fr,ja,ko,ru,zh}) and `description` is one too
//                      — reading the first "zh" on a line yields the wrong text.
//   typeDogma.jsonl    {"_key": typeID, "dogmaAttributes": [{attributeID, value}]}
//   groups.jsonl       group names (used to recognise mining modules/drones)
//
// types.jsonl is ~150 MB, so lookups stream the file once and cache the answers
// in _local/nf-crew/typecache.json. Nothing else is written.

const fs = require("node:fs");
const path = require("node:path");

const {readJson, writeJson} = require(path.join(__dirname, "nfCrewMiningHost.js"));

const CACHE_VERSION = 1;
const CHUNK_BYTES = 4 * 1024 * 1024;

// Dogma attribute IDs (SDE dogmaAttributes: `"name"` is a plain string).
const ATTRIBUTES = Object.freeze({
  cpuOutput: 48,
  powerOutput: 11,
  cpu: 50,
  power: 30,
  hiSlots: 14,
  medSlots: 13,
  lowSlots: 12,
  rigSlots: 1137,
  upgradeCapacity: 1132,
  upgradeCost: 1153,
  droneCapacity: 283,
  droneBandwidth: 1271,
});

/** Normalise a type name for matching: trim, NFKC, collapse spaces, lowercase. */
function normalizeName(value) {
  return String(value == null ? "" : value)
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

/**
 * Stream a (large) file synchronously, calling onLine for every complete line.
 * Chunked reads keep peak memory near CHUNK_BYTES instead of the whole file.
 */
function readLinesSync(file, onLine) {
  const handle = fs.openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let carry = "";
    for (;;) {
      const read = fs.readSync(handle, buffer, 0, CHUNK_BYTES, null);
      if (read <= 0) {
        break;
      }
      const text = carry + buffer.toString("utf8", 0, read);
      const lines = text.split("\n");
      carry = lines.pop();
      for (const line of lines) {
        if (line.length > 0 && onLine(line) === false) {
          return;
        }
      }
    }
    if (carry.length > 0) {
      onLine(carry);
    }
  } finally {
    fs.closeSync(handle);
  }
}

function parseTypeRecord(line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch (_error) {
    return null;
  }
  if (!record || typeof record !== "object") {
    return null;
  }
  const nameObject = record.name && typeof record.name === "object" ? record.name : null;
  return {
    typeID: Number(record._key) || 0,
    name: nameObject || {},
    groupID: Number(record.groupID) || 0,
    categoryID: Number(record.categoryID) || 0,
    volume: Number(record.volume) || 0,
    published: record.published !== false,
    english: nameObject ? String(nameObject.en || "") : "",
    chinese: nameObject ? String(nameObject.zh || "") : "",
  };
}

function typeIDOfLine(line) {
  const match = /"_key":\s*(\d+)/u.exec(line);
  return match ? Number(match[1]) : 0;
}

function createSde(options = {}) {
  const sdeDir = options.sdeDir;
  const cacheFile = options.cacheFile || null;
  const aliasFile = options.aliasFile || null;
  const log = options.log || (() => {});

  if (!sdeDir) {
    throw new Error("NF_CREW_MINING_SDE_MISSING");
  }

  // aliases.json: names the SDE does not know (mod ships, translation gaps).
  // Shape: {"aliases": {"驯鹿级": 12345, "★长尾蜥级": 67890}} or a bare map.
  const aliasMap = new Map();
  if (aliasFile) {
    const raw = readJson(aliasFile, null);
    const source = raw && typeof raw === "object" && raw.aliases ? raw.aliases : raw;
    for (const [name, value] of Object.entries(source && typeof source === "object" ? source : {})) {
      const typeID = Number(value);
      if (name && Number.isFinite(typeID) && typeID > 0) {
        aliasMap.set(normalizeName(name), Math.trunc(typeID));
      }
    }
  }

  const cache = (() => {
    const cached = cacheFile ? readJson(cacheFile, null) : null;
    if (!cached || cached.version !== CACHE_VERSION || !cached.names) {
      return {version: CACHE_VERSION, names: {}};
    }
    return {version: CACHE_VERSION, names: cached.names || {}};
  })();

  const records = new Map(); // typeID -> record
  const dogmaCache = new Map(); // typeID -> Map(attributeID -> value)
  const groupCache = new Map(); // groupID -> {english, chinese, categoryID}

  function saveCache() {
    if (!cacheFile) {
      return;
    }
    try {
      writeJson(cacheFile, cache);
    } catch (error) {
      log(`typecache write failed: ${error && error.message}`);
    }
  }

  /** Stream an SDE file, never throwing: a missing/broken table is reported. */
  function scan(file, onLine) {
    try {
      readLinesSync(file, onLine);
    } catch (error) {
      log(`SDE 读取失败（${path.basename(file)}）：${error && error.message}`);
    }
  }

  /**
   * Resolve type names (any SDE language, or a bare typeID) to
   * {typeID, english, chinese}. Returns {resolved, missing} where resolved is
   * keyed by normalizeName(input).
   */
  function resolveNames(inputs) {
    const wanted = new Map(); // normalized -> original
    for (const input of inputs) {
      const text = String(input == null ? "" : input).trim();
      if (!text) {
        continue;
      }
      const key = normalizeName(text);
      if (!wanted.has(key)) {
        wanted.set(key, text);
      }
    }

    const resolved = new Map();
    const pending = new Map(); // normalized -> original
    for (const [key, original] of wanted) {
      if (/^\d+$/u.test(key) && Number(key) > 0) {
        resolved.set(key, {typeID: Number(key), english: "", chinese: "", via: "typeID"});
        continue;
      }
      const hit = cache.names[key];
      if (hit && hit.typeID) {
        resolved.set(key, {...hit, via: "cache"});
        continue;
      }
      const aliasTypeID = aliasMap.get(key);
      if (aliasTypeID) {
        resolved.set(key, {typeID: aliasTypeID, english: "", chinese: original, via: "alias"});
        continue;
      }
      pending.set(key, original);
    }

    if (pending.size > 0) {
      scan(path.join(sdeDir, "types.jsonl"), (line) => {
        if (pending.size === 0 || line.indexOf('"name"') < 0) {
          return true;
        }
        const record = parseTypeRecord(line);
        if (!record || !record.typeID) {
          return true;
        }
        records.set(record.typeID, record);
        for (const language of Object.values(record.name)) {
          const key = normalizeName(language);
          if (!key || !pending.has(key)) {
            continue;
          }
          pending.delete(key);
          const entry = {
            typeID: record.typeID,
            english: record.english,
            chinese: record.chinese,
          };
          resolved.set(key, {...entry, via: "sde"});
          cache.names[key] = entry;
        }
        return pending.size > 0;
      });
      if ([...resolved.values()].some((entry) => entry.via === "sde")) {
        saveCache();
      }
    }

    const missing = [...pending.values()];
    return {resolved, missing};
  }

  /** Type records (volume/group/category/name) for typeIDs not seen yet. */
  function loadTypeRecords(typeIDs) {
    const wanted = new Set(
      [...typeIDs].map(Number).filter((id) => id > 0 && !records.has(id)),
    );
    if (wanted.size === 0) {
      return records;
    }
    scan(path.join(sdeDir, "types.jsonl"), (line) => {
      const typeID = typeIDOfLine(line);
      if (!wanted.has(typeID)) {
        return true;
      }
      const record = parseTypeRecord(line);
      if (record && record.typeID) {
        records.set(record.typeID, record);
        wanted.delete(record.typeID);
      }
      return wanted.size > 0;
    });
    return records;
  }

  /** Map(typeID -> Map(attributeID -> value)) from typeDogma.jsonl (cached). */
  function loadDogmaAttributes(typeIDs) {
    const wanted = new Set(
      [...typeIDs].map(Number).filter((id) => id > 0 && !dogmaCache.has(id)),
    );
    if (wanted.size > 0) {
      scan(path.join(sdeDir, "typeDogma.jsonl"), (line) => {
        const typeID = typeIDOfLine(line);
        if (!wanted.has(typeID)) {
          return true;
        }
        const attributes = new Map();
        const pattern = /"attributeID":\s*(\d+),\s*"value":\s*(-?[0-9.eE+]+)/gu;
        let match = pattern.exec(line);
        while (match) {
          attributes.set(Number(match[1]), Number(match[2]));
          match = pattern.exec(line);
        }
        dogmaCache.set(typeID, attributes);
        wanted.delete(typeID);
        return wanted.size > 0;
      });
    }
    const result = new Map();
    for (const typeID of typeIDs) {
      const id = Number(typeID);
      if (dogmaCache.has(id)) {
        result.set(id, dogmaCache.get(id));
      }
    }
    return result;
  }

  /** Map(groupID -> {english, chinese, categoryID}) from groups.jsonl (cached). */
  function loadGroupNames(groupIDs) {
    const wanted = new Set(
      [...groupIDs].map(Number).filter((id) => id > 0 && !groupCache.has(id)),
    );
    if (wanted.size > 0) {
      scan(path.join(sdeDir, "groups.jsonl"), (line) => {
        const groupID = typeIDOfLine(line);
        if (!wanted.has(groupID)) {
          return true;
        }
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch (_error) {
          return true;
        }
        const nameObject = parsed && parsed.name && typeof parsed.name === "object" ? parsed.name : {};
        groupCache.set(groupID, {
          english: String(nameObject.en || ""),
          chinese: String(nameObject.zh || ""),
          categoryID: Number(parsed && parsed.categoryID) || 0,
        });
        wanted.delete(groupID);
        return wanted.size > 0;
      });
    }
    const result = new Map();
    for (const groupID of groupIDs) {
      const id = Number(groupID);
      if (groupCache.has(id)) {
        result.set(id, groupCache.get(id));
      }
    }
    return result;
  }

  /** Resolved category for a type (types.jsonl has no categoryID; the group does). */
  function categoryOf(typeID) {
    const record = records.get(Number(typeID));
    if (!record) {
      return 0;
    }
    if (number(record.categoryID) > 0) {
      return number(record.categoryID);
    }
    const group = groupCache.get(number(record.groupID));
    return group ? number(group.categoryID) : 0;
  }

  return {
    sdeDir,
    attributeIDs: ATTRIBUTES,
    resolveNames,
    loadTypeRecords,
    loadDogmaAttributes,
    loadGroupNames,
    categoryOf,
    getRecord: (typeID) => records.get(Number(typeID)) || null,
    normalizeName,
    flushCache: saveCache,
  };
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

module.exports = {
  createSde,
  readLinesSync,
  normalizeName,
  parseTypeRecord,
  ATTRIBUTES,
};
