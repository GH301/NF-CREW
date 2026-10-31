"use strict";

// PR-3: one runtime per player account, created on first use.
//
// Kept out of loader.js on purpose: requiring the loader patches Module._load
// for the whole process, so the routing has to be testable on its own.
//
// The router owns nothing but the map. Everything tenant-specific (manifest,
// paths, crew account) comes from the registry.

const DEFAULT_MAX_RUNTIMES = 64;

function positiveInt(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

function createRuntimeRouter(options = {}) {
  const createRuntime = options.createRuntime;
  const registry = options.registry;
  const deps = options.deps || {};
  const log = options.log || (() => {});
  const maxRuntimes = positiveInt(options.maxRuntimes) || DEFAULT_MAX_RUNTIMES;
  const runtimes = new Map();

  if (typeof createRuntime !== "function") {
    throw new Error("NF_CREW_MINING_ROUTER_NEEDS_FACTORY");
  }
  if (!registry || typeof registry.ensure !== "function" || typeof registry.pathsFor !== "function") {
    throw new Error("NF_CREW_MINING_ROUTER_NEEDS_REGISTRY");
  }

  /** The runtime serving `accountID`, created on first ask. */
  function get(accountID) {
    const key = positiveInt(accountID);
    const cached = runtimes.get(key);
    if (cached) {
      return cached;
    }
    if (runtimes.size >= maxRuntimes) {
      throw new Error(`NF_CREW_MINING_TOO_MANY_RUNTIMES:${maxRuntimes}`);
    }
    const {tenant} = registry.ensure(key);
    const paths = registry.pathsFor(key);
    const runtime = createRuntime({
      tenant,
      configsDir: paths.configsDir,
      stateFile: paths.stateFile,
      // PR-4: the panel token that identifies this account's UI.
      panelToken: typeof registry.tokenFor === "function" ? registry.tokenFor(key) : "",
      deps,
      log: (message) => log(`[acct ${key}] ${message}`),
    });
    runtimes.set(key, runtime);
    log(`租户 ${key} 的运行时已就绪（船员账号 ${tenant && tenant.crewAccountID}）`);
    return runtime;
  }

  return {
    get,
    has(accountID) {
      return runtimes.has(positiveInt(accountID));
    },
    size() {
      return runtimes.size;
    },
    keys() {
      return [...runtimes.keys()];
    },
    pathsFor(accountID) {
      return registry.pathsFor(positiveInt(accountID));
    },
    /** Test/restart hook: forget every runtime (their timers keep running). */
    reset() {
      runtimes.clear();
    },
    maxRuntimes,
  };
}

module.exports = {createRuntimeRouter, DEFAULT_MAX_RUNTIMES};
