"use strict";

// Paths and tiny IO helpers for nf-crew.
//
// Everything the mod reads or writes lives in one of two places:
//   <workspace>/_local/nf-crew/            our own data (configs, cache)
//   <workspace>/_local/gameStore/nf-crew/  persistent state (PLAN.md §2)
// The client's exported fittings are read from our own fittings dir first and
// from Documents\EVE\fittings second, never written.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MOD_DIR = path.resolve(__dirname, "..");
const WORKSPACE = path.resolve(MOD_DIR, "..", "..");
const SERVER_DIR = path.join(WORKSPACE, "server", "src");
const LOCAL_DIR = path.join(WORKSPACE, "_local", "nf-crew");
const GAMESTORE_LOCAL_DIR = path.join(WORKSPACE, "_local", "gameStore", "nf-crew");
const CONFIGS_DIR = path.join(LOCAL_DIR, "configs");
const OWN_FITTINGS_DIR = path.join(LOCAL_DIR, "fittings");
const DOCUMENTS_FITTINGS_DIR = path.join(os.homedir(), "Documents", "EVE", "fittings");
const STATE_FILE = path.join(GAMESTORE_LOCAL_DIR, "state.json");
const TYPE_CACHE_FILE = path.join(LOCAL_DIR, "typecache.json");
const ALIASES_FILE = path.join(LOCAL_DIR, "aliases.json");

// Per-tenant layout (PR-1). `<accountID>` is the player's engine account id;
// "0" is the shared bucket used when a session cannot be resolved.
const TENANTS_FILE = path.join(GAMESTORE_LOCAL_DIR, "tenants.json");
const TENANT_STATE_ROOT = path.join(GAMESTORE_LOCAL_DIR, "t");
const TENANT_CONFIGS_ROOT = path.join(LOCAL_DIR, "t");

/** Where one tenant's pool, blueprints and log live. Never returns null. */
function tenantPaths(accountID) {
  const numeric = Number(accountID);
  const key = String(Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0);
  const stateDir = path.join(TENANT_STATE_ROOT, key);
  return {
    accountID: key,
    stateDir,
    stateFile: path.join(stateDir, "state.json"),
    logFile: path.join(stateDir, "logs", "crew.log"),
    configsDir: path.join(TENANT_CONFIGS_ROOT, key, "configs"),
  };
}

function findSdeDir() {
  const base = path.join(WORKSPACE, "_local", "sde");
  let entries = [];
  try {
    entries = fs.readdirSync(base);
  } catch (_error) {
    return null;
  }
  for (const name of entries) {
    const candidate = path.join(base, name);
    try {
      if (fs.existsSync(path.join(candidate, "types.jsonl"))) {
        return candidate;
      }
    } catch (_error) {
      /* skip unreadable candidate */
    }
  }
  return null;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_error) {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, {recursive: true});
  return dir;
}

/** Candidate directories for a client fitting file, in priority order. */
function fittingsSearchDirs(extraDir = null) {
  const dirs = [];
  for (const dir of [extraDir, OWN_FITTINGS_DIR, DOCUMENTS_FITTINGS_DIR]) {
    if (dir && dirs.indexOf(dir) < 0) {
      dirs.push(dir);
    }
  }
  return dirs;
}

/** Resolve a fitting file name across the search dirs; returns the full path or null. */
function findFittingFile(fileName, extraDir = null) {
  if (!fileName) {
    return null;
  }
  if (path.isAbsolute(fileName)) {
    return fs.existsSync(fileName) ? fileName : null;
  }
  for (const dir of fittingsSearchDirs(extraDir)) {
    const candidate = path.join(dir, fileName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

module.exports = {
  MOD_DIR,
  WORKSPACE,
  SERVER_DIR,
  LOCAL_DIR,
  GAMESTORE_LOCAL_DIR,
  CONFIGS_DIR,
  OWN_FITTINGS_DIR,
  DOCUMENTS_FITTINGS_DIR,
  STATE_FILE,
  TYPE_CACHE_FILE,
  ALIASES_FILE,
  TENANTS_FILE,
  TENANT_STATE_ROOT,
  TENANT_CONFIGS_ROOT,
  tenantPaths,
  findSdeDir,
  readJson,
  writeJson,
  ensureDir,
  fittingsSearchDirs,
  findFittingFile,
};
