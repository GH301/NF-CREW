"use strict";

// Persistent state: _local/gameStore/nf-crew/state.json
//
// Holds the pilot pool (PLAN.md §4.2/§4.3). The pool is the expensive half of a
// crew member — a real character record plus all skills — so it survives
// "disband": only the ship and the entity are thrown away, the person stays and
// is reused by the next summon.

const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_VERSION = 2;
// v1 was one pool for the whole process. A v1 file still loads; the tenant and
// owner fields stay 0 until tools/migrate-tenants.js stamps them.
const LEGACY_VERSIONS = new Set([1]);

function emptyState() {
  return {
    version: SCHEMA_VERSION,
    tenant: {accountID: 0},
    pool: [],
    settings: {follow: true, compress: true, followPlan: null},
  };
}

function positiveInt(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

/** Accept only the shape we understand; unknown fields are dropped. */
function normalizeState(raw) {
  const problems = [];
  const state = emptyState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {state, problems: ["NOT_AN_OBJECT"], legacy: false};
  }
  const version = Number(raw.version) || 0;
  const legacy = LEGACY_VERSIONS.has(version);
  if (!legacy && version !== SCHEMA_VERSION) {
    problems.push(`UNKNOWN_VERSION:${raw.version}`);
  }
  const tenantAccountID = positiveInt(raw.tenant && raw.tenant.accountID);
  if (tenantAccountID) {
    state.tenant = {accountID: tenantAccountID};
  }
  for (const entry of Array.isArray(raw.pool) ? raw.pool : []) {
    const characterID = positiveInt(entry && entry.characterID);
    if (!characterID) {
      problems.push("POOL_ENTRY_WITHOUT_CHARACTER");
      continue;
    }
    state.pool.push({
      characterID,
      name: String((entry && entry.name) || ""),
      blueprintID: String((entry && entry.blueprintID) || ""),
      corporationID: positiveInt(entry && entry.corporationID),
      skillsSeeded: (entry && entry.skillsSeeded) === true,
      source: String((entry && entry.source) || "blueprint"),
      shipID: positiveInt(entry && entry.shipID),
      hangarLocationID: positiveInt(entry && entry.hangarLocationID),
      summoned: (entry && entry.summoned) === true,
      createdAtMs: Number(entry && entry.createdAtMs) || 0,
      releasedAtMs: Number(entry && entry.releasedAtMs) || 0,
      // Measured once per ship: rebuilding the dogma hold snapshot costs 500-1100 ms, so
      // the value is kept on the member instead of being recomputed on every start.
      holdCapacity: Number(entry && entry.holdCapacity) || 0,
      // Which player account owns this crew member. 0 = unclaimed (v1 data that
      // has not been migrated yet); it is reusable only inside its own file.
      ownerAccountID: positiveInt(entry && entry.ownerAccountID),
      // PLAN §18.5: 特殊装备开关（堡垒 / 会战）跟着船员走，重启后按这里重放。
      // 旧存档没有这一项 → 两个都关，行为与改造前一致。
      special: {
        bastion: (entry && entry.special && entry.special.bastion) === true,
        siege: (entry && entry.special && entry.special.siege) === true,
        smartbomb: (entry && entry.special && entry.special.smartbomb) === true,
        // 组 515 其余型号（后勤 Triage / 工业核心 / 未识别型号）：组驱动，读写都保留。
        triage: (entry && entry.special && entry.special.triage) === true,
        industrialCore: (entry && entry.special && entry.special.industrialCore) === true,
        special515: (entry && entry.special && entry.special.special515) === true,
      },
    });
  }
  if (raw.settings && typeof raw.settings === "object") {
    // followPlan = 0.6.8 的"跟随/阵型当前指令"（{mode, gap, spacing}）。
    // 注意 `follow` 是更早的布尔开关（"是否跟随"），两者不同名、互不影响。
    const plan = raw.settings.followPlan;
    state.settings = {
      follow: raw.settings.follow !== false,
      compress: raw.settings.compress !== false,
      followPlan: plan && typeof plan === "object" ? plan : null,
    };
  }
  // 库存账本（0.6.17 起存在 state.json 里）。以前这里把它当"未知字段"丢掉，
  // 于是每次重启/新实例加载后账本都是空的，下一次写盘就把船和花费全清了。
  if (raw.stock && typeof raw.stock === "object" && !Array.isArray(raw.stock)) {
    state.stock = raw.stock;
  }
  return {state, problems, legacy};
}

function load(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {state: emptyState(), problems: []};
    }
    return {state: emptyState(), problems: [`UNREADABLE:${error && error.message}`]};
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {state: emptyState(), problems: [`BAD_JSON:${error && error.message}`]};
  }
  return normalizeState(raw);
}

function save(file, state) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  // Unique temp name: two writers (two tenants, or the panel and the game loop)
  // would otherwise collide on `state.json.tmp` and publish a half-written file.
  const temporary = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, file);
  } finally {
    try {
      if (fs.existsSync(temporary)) {
        fs.unlinkSync(temporary);
      }
    } catch (_error) {
      /* renamed away, or the directory vanished */
    }
  }
  return state;
}

/** 文件指纹：mtime + 大小。用来发现"别的实例刚写过盘"。 */
function fileSignature(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch (_error) {
    return "";
  }
}

function createStateStore(options = {}) {
  const file = options.file;
  const log = options.log || (() => {});
  const accountID = positiveInt(options.accountID);
  if (!file) {
    throw new Error("NF_CREW_MINING_STATE_FILE_MISSING");
  }
  let loaded = load(file);
  if (loaded.problems.length > 0) {
    log(`状态文件有问题（${file}）：${loaded.problems.join(" · ")}；已按空状态继续`);
  }
  if (loaded.legacy) {
    log(`状态文件是 v1，已按 v2 读取（${file}）；跑 tools/migrate-tenants.js 落盘归属`);
  }
  let state = loaded.state;
  let signature = fileSignature(file);
  const applyTenant = (value) => {
    if (!accountID) {
      return value;
    }
    const owner = positiveInt(value.tenant && value.tenant.accountID);
    if (owner && owner !== accountID) {
      log(`状态文件归属不符：文件属于 ${owner}，当前租户 ${accountID}（${file}）`);
    }
    return {...value, tenant: {accountID}};
  };
  state = applyTenant(state);

  return {
    get problems() {
      return loaded.problems;
    },
    get() {
      return state;
    },
    /** Mutate through a function and persist immediately.
     *  写之前先看文件有没有被别的实例改过——有就重新加载，避免"旧实例整份覆盖新数据"
     *  （真实事故：仓库账本被一次旧快照覆盖，船还在、账本空了）。 */
    update(mutator) {
      const onDisk = fileSignature(file);
      if (onDisk && onDisk !== signature) {
        log(`状态文件已被其它实例改过，先重新加载再写（${file}）`);
        loaded = load(file);
        state = applyTenant(loaded.state);
      }
      const next = mutator(state) || state;
      state = next;
      try {
        save(file, state);
      } catch (error) {
        log(`状态保存失败：${error && error.message}`);
      }
      signature = fileSignature(file);
      return state;
    },
    reload() {
      loaded = load(file);
      state = applyTenant(loaded.state);
      signature = fileSignature(file);
      return state;
    },
    file,
  };
}

module.exports = {
  SCHEMA_VERSION,
  emptyState,
  normalizeState,
  load,
  save,
  createStateStore,
};
