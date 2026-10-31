"use strict";

// Tenant registry: one entry per player account (PR-1).
//
// The mod used to be single-tenant: one pool, one configs dir, one panel, one
// `serviceSession`. Everything that belongs to "a player" now hangs off a
// tenant record here, so N runtimes can coexist without sharing anything.
//
//   _local/gameStore/nf-crew/tenants.json          the registry
//   _local/gameStore/nf-crew/t/<account>/state.json   the crew pool
//   _local/nf-crew/t/<account>/configs/*.json        the blueprints
//
// A crew member is a real character record; `crewAccountID` is the synthetic
// account those characters are filed under. It is NOT a login account — the
// engine tolerates account ids that have no row in data/accounts (the old
// hardcoded 9000001 never existed there either, see docs/spike-multitenant.md).

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const host = require(path.join(__dirname, "nfCrewMiningHost.js"));

const SCHEMA_VERSION = 1;
const DEFAULT_CREW_ACCOUNT_ID = 9_000_001;
// A sane upper bound: one synthetic account per player, not per crew member.
const MAX_TENANTS = 512;

function positiveInt(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

/** accountID 0 means "unknown" and gets its own shared bucket, never a crash. */
function accountKey(accountID) {
  return String(positiveInt(accountID) || 0);
}

function emptyRegistry() {
  return {version: SCHEMA_VERSION, nextCrewAccountID: DEFAULT_CREW_ACCOUNT_ID, tenants: {}};
}

function normalizeTenant(accountID, raw) {
  return {
    accountID,
    crewAccountID: positiveInt(raw && raw.crewAccountID),
    createdAtMs: Number(raw && raw.createdAtMs) || 0,
    label: String((raw && raw.label) || ""),
    // PR-4: the panel token. Empty on a v1 registry; provisioned on demand.
    token: String((raw && raw.token) || ""),
  };
}

function newToken() {
  return crypto.randomBytes(16).toString("hex");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (!a.length || a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/** Accept only the shape we understand; unknown keys are dropped. */
function normalizeRegistry(raw) {
  const problems = [];
  const registry = emptyRegistry();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {registry, problems: ["NOT_AN_OBJECT"]};
  }
  if (Number(raw.version) !== SCHEMA_VERSION) {
    problems.push(`UNKNOWN_VERSION:${raw.version}`);
  }
  const tenants = raw.tenants && typeof raw.tenants === "object" ? raw.tenants : {};
  for (const [key, value] of Object.entries(tenants)) {
    const accountID = positiveInt(key);
    if (!accountID) {
      problems.push(`BAD_TENANT_KEY:${key}`);
      continue;
    }
    const tenant = normalizeTenant(accountID, value);
    if (!tenant.crewAccountID) {
      problems.push(`TENANT_WITHOUT_CREW_ACCOUNT:${accountID}`);
      continue;
    }
    registry.tenants[String(accountID)] = tenant;
  }
  registry.nextCrewAccountID =
    positiveInt(raw.nextCrewAccountID) || highestCrewAccount(registry) || DEFAULT_CREW_ACCOUNT_ID;
  return {registry, problems};
}

function highestCrewAccount(registry) {
  let highest = 0;
  for (const tenant of Object.values(registry.tenants)) {
    if (positiveInt(tenant.crewAccountID) > highest) {
      highest = positiveInt(tenant.crewAccountID);
    }
  }
  return highest;
}

function loadRegistry(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {registry: emptyRegistry(), problems: []};
    }
    return {registry: emptyRegistry(), problems: [`UNREADABLE:${error && error.message}`]};
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {registry: emptyRegistry(), problems: [`BAD_JSON:${error && error.message}`]};
  }
  return normalizeRegistry(raw);
}

/**
 * Atomic write. The temp name must be unique per writer: two tenants saving at
 * the same moment used to collide on a fixed `${file}.tmp` (State.js had the
 * same flaw).
 */
function saveRegistry(file, registry) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, file);
  } finally {
    try {
      if (fs.existsSync(temporary)) {
        fs.unlinkSync(temporary);
      }
    } catch (_error) {
      /* the rename already moved it, or the directory is gone */
    }
  }
  return registry;
}

/** Copy the shipped blueprints into a new tenant's config dir (once). */
function seedConfigs(configsDir, sourceDir, log) {
  try {
    const existing = fs.readdirSync(configsDir).filter((name) => name.toLowerCase().endsWith(".json"));
    if (existing.length > 0) {
      return 0;
    }
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      log(`租户蓝图目录不可读：${configsDir}（${error && error.message}）`);
      return 0;
    }
  }
  let copied = 0;
  try {
    const names = fs.readdirSync(sourceDir).filter((name) => name.toLowerCase().endsWith(".json"));
    fs.mkdirSync(configsDir, {recursive: true});
    for (const name of names) {
      fs.copyFileSync(path.join(sourceDir, name), path.join(configsDir, name));
      copied += 1;
    }
  } catch (error) {
    log(`租户蓝图模板复制失败：${error && error.message}`);
  }
  return copied;
}

/**
 * The tenant a session belongs to: the engine account behind its character.
 * Falls back to the character id so a single-player / offline run still works.
 */
function resolveAccountID(session, deps) {
  if (!session) {
    return 0;
  }
  const characterID = positiveInt(session.characterID || session.charid || session.characterId);
  const characterState = deps && deps.characterState;
  if (characterID && characterState && typeof characterState.peekCharacterRecord === "function") {
    try {
      const record = characterState.peekCharacterRecord(characterID);
      const accountID = positiveInt(record && (record.accountId || record.accountID));
      if (accountID) {
        return accountID;
      }
    } catch (_error) {
      /* fall through to the character id */
    }
  }
  return characterID;
}

function createTenantRegistry(options = {}) {
  const file = options.file || host.TENANTS_FILE;
  const log = options.log || (() => {});
  const now = options.now || (() => Date.now());
  const seedDir = options.seedConfigsDir || host.CONFIGS_DIR;
  // Injectable so tests never touch the real workspace layout.
  const resolvePaths = options.pathsFor || host.tenantPaths;

  let loaded = loadRegistry(file);
  if (loaded.problems.length > 0) {
    log(`租户注册表有问题（${file}）：${loaded.problems.join(" · ")}；已按空表继续`);
  }
  let registry = loaded.registry;

  function persist() {
    saveRegistry(file, registry);
  }

  function get(accountID) {
    return registry.tenants[accountKey(accountID)] || null;
  }

  function list() {
    return Object.values(registry.tenants).sort((left, right) => left.accountID - right.accountID);
  }

  function usedCrewAccounts() {
    const used = new Set();
    for (const tenant of Object.values(registry.tenants)) {
      if (tenant.crewAccountID) {
        used.add(tenant.crewAccountID);
      }
    }
    return used;
  }

  /** Create (or return) the tenant for an account. Idempotent. */
  function ensure(accountID) {
    const key = accountKey(accountID);
    const existing = registry.tenants[key];
    if (existing) {
      return {tenant: existing, created: false};
    }
    if (Object.keys(registry.tenants).length >= MAX_TENANTS) {
      throw new Error(`NF_CREW_MINING_TOO_MANY_TENANTS:${MAX_TENANTS}`);
    }
    const used = usedCrewAccounts();
    let crewAccountID = positiveInt(registry.nextCrewAccountID) || DEFAULT_CREW_ACCOUNT_ID;
    while (used.has(crewAccountID)) {
      crewAccountID += 1;
    }
    if (crewAccountID >= DEFAULT_CREW_ACCOUNT_ID + MAX_TENANTS) {
      throw new Error(`NF_CREW_MINING_CREW_ACCOUNT_EXHAUSTED:${crewAccountID}`);
    }
    const tenant = {
      accountID: Number(key),
      crewAccountID,
      createdAtMs: now(),
      label: "",
      token: newToken(),
    };
    registry.tenants[key] = tenant;
    registry.nextCrewAccountID = crewAccountID + 1;
    persist();
    const paths = resolvePaths(tenant.accountID);
    host.ensureDir(paths.stateDir);
    host.ensureDir(paths.configsDir);
    const copied = seedConfigs(paths.configsDir, seedDir, log);
    log(`租户 ${tenant.accountID} 已创建：船员账号 ${crewAccountID}，蓝图 ${copied} 份`);
    return {tenant, created: true};
  }

  return {
    get problems() {
      return loaded.problems;
    },
    file,
    get,
    list,
    ensure,
    has(accountID) {
      return Boolean(get(accountID));
    },
    pathsFor(accountID) {
      return resolvePaths(accountID);
    },
    /** The panel token of an account, created on first ask (v1 registries have none). */
    tokenFor(accountID) {
      const tenant = get(accountID);
      if (!tenant) {
        return "";
      }
      if (!tenant.token) {
        tenant.token = newToken();
        persist();
      }
      return tenant.token;
    },
    /** Reverse lookup used by the panel: token -> tenant, or null. */
    byToken(token) {
      const wanted = String(token || "");
      if (!wanted) {
        return null;
      }
      for (const tenant of Object.values(registry.tenants)) {
        if (safeEqual(tenant.token, wanted)) {
          return tenant;
        }
      }
      return null;
    },
    resolveAccountID(session, deps) {
      return resolveAccountID(session, deps);
    },
    registry() {
      return registry;
    },
    reload() {
      loaded = loadRegistry(file);
      registry = loaded.registry;
      return registry;
    },
    save: persist,
    /** Test hook: the account id the crew of this tenant is filed under. */
    crewAccountIDFor(accountID) {
      const tenant = get(accountID);
      return tenant ? tenant.crewAccountID : 0;
    },
  };
}

module.exports = {
  SCHEMA_VERSION,
  DEFAULT_CREW_ACCOUNT_ID,
  MAX_TENANTS,
  emptyRegistry,
  normalizeRegistry,
  loadRegistry,
  saveRegistry,
  resolveAccountID,
  createTenantRegistry,
};
