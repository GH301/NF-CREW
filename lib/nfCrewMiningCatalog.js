"use strict";

// P0：类型目录（船体 / 模块 / 弹药 / 无人机）—— **一次性索引，落盘缓存**。
//
// 为什么要它：配装台与库存定价需要"某个 typeID 是什么、进哪个槽、吃多少 CPU/PG、
// 用什么弹药"。这些字段分散在 SDE 的 types.jsonl（名称/组/体积）、groups.jsonl
// （组→类别）、typeDogma.jsonl（属性与效果）里，每次现查要扫 150 MB + 27 MB。
// 所以这里一次性扫出需要的部分，写成 `_local/nf-crew/catalog.json`（约 1–3 MB），
// 之后按 SDE 的 buildNumber 判断是否重建（`_sde.jsonl` 变了才重扫）。
//
// 槽位家族用引擎自己的判据（server/src/services/fitting/liveFittingState.js
// getRequiredSlotFamily）：模块带哪个 power 效果就进哪个槽——
//   11 loPower → low，12 hiPower → high，13 medPower → med，
//   2663 rigSlot → rig，3772 subSystem → subsystem，6306 serviceSlot → service。
//
// 索引里**不存价格**：价格 5 分钟一变，查询时由 nfCrewMiningPrices 现查合并。

const fs = require("node:fs");
const path = require("node:path");

const host = require(path.join(__dirname, "nfCrewMiningHost.js"));
const {readLinesSync} = require(path.join(__dirname, "nfCrewMiningSde.js"));

const CACHE_VERSION = 6;
const DEFAULT_CACHE_FILE = path.join(host.LOCAL_DIR, "catalog.json");

// categories.jsonl: 6 Ship / 7 Module / 8 Charge / 18 Drone / 32 Subsystem
const CATEGORY_SHIP = 6;
const CATEGORY_MODULE = 7;
const CATEGORY_CHARGE = 8;
const CATEGORY_DRONE = 18;
const CATEGORY_SUBSYSTEM = 32;
const WANTED_CATEGORIES = new Set([
  CATEGORY_SHIP, CATEGORY_MODULE, CATEGORY_CHARGE, CATEGORY_DRONE, CATEGORY_SUBSYSTEM,
]);

// 槽位家族效果：按优先级排列（一个模块正常只有一个 power 效果）。
const FAMILY_BY_EFFECT = new Map([
  [12, "high"],
  [13, "med"],
  [11, "low"],
  [2663, "rig"],
  [3772, "subsystem"],
  [6306, "service"],
]);
const MODULE_FAMILIES = new Set(["high", "med", "low", "rig", "subsystem", "service", "module"]);

const ATTRIBUTE = Object.freeze({
  // 船的 CPU/PG 输出（配装台要拿它当上限）
  cpuOutput: 48,
  powerOutput: 11,
  // 改装件尺寸：船体和改装件都有，尺寸不一致装不上
  rigSize: 1547,
  subSystemSlots: 1367,
  cpu: 50,
  power: 30,
  lowSlots: 12,
  medSlots: 13,
  hiSlots: 14,
  rigSlots: 1137,
  droneCapacity: 283,
  droneBandwidth: 1271,
  // 无人机自己占用的带宽（属性在无人机上）
  droneBandwidthUsed: 1272,
  // 高槽挂点：炮台位 / 发射器位
  turretSlots: 102,
  launcherSlots: 101,
  // 武器：伤害倍率 + 射速（毫秒）
  damageMultiplier: 64,
  rateOfFire: 51,
  // 弹药四系伤害
  emDamage: 114,
  explosiveDamage: 116,
  kineticDamage: 117,
  thermalDamage: 118,
  // 血量与抗性（resonance，1 = 0% 抗性）
  structureHP: 9,
  armorHP: 265,
  shieldHP: 263,
  armorEm: 267,
  armorExplosive: 268,
  armorKinetic: 269,
  armorThermal: 270,
  shieldEm: 271,
  shieldExplosive: 272,
  shieldKinetic: 273,
  shieldThermal: 274,
  chargeSize: 128,
  chargeGroup1: 604,
  chargeGroup2: 605,
  chargeGroup3: 606,
  chargeGroup4: 609,
  chargeGroup5: 610,
});

const FAMILIES = Object.freeze(["hull", "high", "med", "low", "rig", "subsystem", "service", "charge", "drone", "module"]);

function readSdeBuild(sdeDir) {
  try {
    const first = fs.readFileSync(path.join(sdeDir, "_sde.jsonl"), "utf8").split("\n")[0];
    const parsed = JSON.parse(first);
    const build = Number(parsed && parsed.buildNumber);
    if (build > 0) {
      return String(build);
    }
  } catch (_error) {
    /* 老 SDE 没有这个文件：退回目录名 */
  }
  return String(path.basename(sdeDir || ""));
}

function pickName(nameObject) {
  const source = nameObject && typeof nameObject === "object" ? nameObject : {};
  const zh = String(source.zh || "").trim();
  const en = String(source.en || "").trim();
  return {zh: zh || en, en: en || zh};
}

/** groupID -> categoryID（groups.jsonl 只有 800 KB，一次读完）。 */
function readGroupCategories(sdeDir) {
  const table = new Map();
  try {
    readLinesSync(path.join(sdeDir, "groups.jsonl"), (line) => {
      const key = /"_key":\s*(\d+)/u.exec(line);
      const category = /"categoryID":\s*(\d+)/u.exec(line);
      if (!key) {
        return true;
      }
      table.set(Number(key[1]), category ? Number(category[1]) : 0);
      return true;
    });
  } catch (error) {
    throw new Error(`GROUPS_UNREADABLE:${error && error.message}`);
  }
  return table;
}

/** 只解析需要的类别；其余行只做正则，不 JSON.parse（150 MB 才扫得动）。 */
function scanTypes(sdeDir, groupCategory, log) {
  const records = [];
  try {
    readLinesSync(path.join(sdeDir, "types.jsonl"), (line) => {
      const key = /"_key":\s*(\d+)/u.exec(line);
      const group = /"groupID":\s*(\d+)/u.exec(line);
      if (!key || !group) {
        return true;
      }
      const groupID = Number(group[1]);
      const categoryID = groupCategory.get(groupID) || 0;
      if (!WANTED_CATEGORIES.has(categoryID)) {
        return true;
      }
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch (_error) {
        return true;
      }
      const typeID = Number(parsed && parsed._key) || Number(key[1]);
      if (!typeID) {
        return true;
      }
      const name = pickName(parsed.name);
      records.push({
        typeID,
        groupID,
        categoryID,
        name,
        volume: Number(parsed.volume) || 0,
        published: parsed.published !== false,
      });
      return true;
    });
  } catch (error) {
    throw new Error(`TYPES_UNREADABLE:${error && error.message}`);
  }
  if (records.length === 0) {
    log("类型索引为空（types.jsonl 没读到？）");
  }
  return records;
}

/** typeID -> {attrs: Map, effects: Set}，只解析需要的 typeID。 */
function scanDogma(sdeDir, wantedIDs) {
  const result = new Map();
  try {
    readLinesSync(path.join(sdeDir, "typeDogma.jsonl"), (line) => {
      const key = /"_key":\s*(\d+)/u.exec(line);
      if (!key) {
        return true;
      }
      const typeID = Number(key[1]);
      if (!wantedIDs.has(typeID)) {
        return true;
      }
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch (_error) {
        return true;
      }
      const attrs = new Map();
      for (const entry of Array.isArray(parsed.dogmaAttributes) ? parsed.dogmaAttributes : []) {
        const attributeID = Number(entry && entry.attributeID);
        if (attributeID > 0) {
          attrs.set(attributeID, Number(entry.value) || 0);
        }
      }
      const effects = new Set();
      for (const entry of Array.isArray(parsed.dogmaEffects) ? parsed.dogmaEffects : []) {
        const effectID = Number(entry && entry.effectID);
        if (effectID > 0) {
          effects.add(effectID);
        }
      }
      result.set(typeID, {attrs, effects});
      return true;
    });
  } catch (error) {
    throw new Error(`DOGMA_UNREADABLE:${error && error.message}`);
  }
  return result;
}

function familyOf(record, dogma) {
  if (record.categoryID === CATEGORY_SHIP) {
    return "hull";
  }
  if (record.categoryID === CATEGORY_CHARGE) {
    return "charge";
  }
  if (record.categoryID === CATEGORY_DRONE) {
    return "drone";
  }
  if (record.categoryID === CATEGORY_SUBSYSTEM) {
    return "subsystem";
  }
  const effects = dogma ? dogma.effects : null;
  if (effects) {
    // 一个模块只该有一个 power 效果；有多个时按 高 > 中 > 低 取第一个命中的。
    for (const [effectID, family] of FAMILY_BY_EFFECT) {
      if (effects.has(effectID)) {
        return family;
      }
    }
  }
  return "module";
}

function compactEntry(record, dogma) {
  const attrs = dogma ? dogma.attrs : null;
  const attr = (id) => (attrs ? Number(attrs.get(id)) || 0 : 0);
  const entry = {
    n: record.name.zh || record.name.en,
    g: record.groupID,
    c: record.categoryID,
    f: familyOf(record, dogma),
  };
  if (record.name.en && record.name.en !== entry.n) {
    entry.e = record.name.en;
  }
  if (record.volume > 0) {
    entry.v = record.volume;
  }
  const cpu = attr(ATTRIBUTE.cpu);
  const power = attr(ATTRIBUTE.power);
  if (cpu > 0) {
    entry.cpu = cpu;
  }
  if (power > 0) {
    entry.pg = power;
  }
  if (record.categoryID === CATEGORY_SHIP) {
    const slots = {
      hi: attr(ATTRIBUTE.hiSlots),
      me: attr(ATTRIBUTE.medSlots),
      lo: attr(ATTRIBUTE.lowSlots),
      rig: attr(ATTRIBUTE.rigSlots),
      dc: attr(ATTRIBUTE.droneCapacity),
      db: attr(ATTRIBUTE.droneBandwidth),
    };
    for (const [key, value] of Object.entries(slots)) {
      if (value > 0) {
        entry[key] = value;
      }
    }
    const cpuOut = attr(ATTRIBUTE.cpuOutput);
    const pgOut = attr(ATTRIBUTE.powerOutput);
    if (cpuOut > 0) {
      entry.cpuOut = cpuOut;
    }
    if (pgOut > 0) {
      entry.pgOut = pgOut;
    }
    const rigSize = attr(ATTRIBUTE.rigSize);
    if (rigSize > 0) {
      entry.rs = rigSize;
    }
    const subSlots = attr(ATTRIBUTE.subSystemSlots);
    if (subSlots > 0) {
      entry.sub = subSlots;
    }
    // 高槽挂点 + 血量/抗性（估算 EHP 用）
    const turretSlots = attr(ATTRIBUTE.turretSlots);
    if (turretSlots > 0) {
      entry.turret = turretSlots;
    }
    const launcherSlots = attr(ATTRIBUTE.launcherSlots);
    if (launcherSlots > 0) {
      entry.launcher = launcherSlots;
    }
    const hp = {
      h: attr(ATTRIBUTE.structureHP),
      a: attr(ATTRIBUTE.armorHP),
      s: attr(ATTRIBUTE.shieldHP),
    };
    if (hp.h > 0 || hp.a > 0 || hp.s > 0) {
      entry.hp = hp;
      entry.res = {
        a: [attr(ATTRIBUTE.armorEm), attr(ATTRIBUTE.armorExplosive), attr(ATTRIBUTE.armorKinetic), attr(ATTRIBUTE.armorThermal)],
        s: [attr(ATTRIBUTE.shieldEm), attr(ATTRIBUTE.shieldExplosive), attr(ATTRIBUTE.shieldKinetic), attr(ATTRIBUTE.shieldThermal)],
      };
    }
  }
  if (record.categoryID === CATEGORY_CHARGE) {
    const size = attr(ATTRIBUTE.chargeSize);
    if (size > 0) {
      entry.cs = size;
    }
    const damage = [
      attr(ATTRIBUTE.emDamage),
      attr(ATTRIBUTE.explosiveDamage),
      attr(ATTRIBUTE.kineticDamage),
      attr(ATTRIBUTE.thermalDamage),
    ];
    if (damage.some((value) => value > 0)) {
      entry.d = damage;
    }
  }
  if (record.categoryID === CATEGORY_MODULE) {
    const groups = [];
    for (const key of ["chargeGroup1", "chargeGroup2", "chargeGroup3", "chargeGroup4", "chargeGroup5"]) {
      const groupID = attr(ATTRIBUTE[key]);
      if (groupID > 0) {
        groups.push(groupID);
      }
    }
    if (groups.length > 0) {
      entry.cg = groups;
    }
    const chargeSize = attr(ATTRIBUTE.chargeSize);
    if (chargeSize > 0) {
      entry.cs = chargeSize;
    }
    const rigSize = attr(ATTRIBUTE.rigSize);
    if (rigSize > 0) {
      entry.rs = rigSize;
    }
    // 炮台/发射器：Weapon Upgrades + Advanced Weapon Upgrades 会再减 25% CPU/PG。
    const effects = dogma ? dogma.effects : null;
    if (effects && (effects.has(40) || effects.has(42))) {
      entry.w = true;
      if (effects.has(42)) {
        entry.wt = true;   // 炮台，占炮台挂点
      }
      if (effects.has(40)) {
        entry.wl = true;   // 发射器，占发射器挂点
      }
      const damageMultiplier = attr(ATTRIBUTE.damageMultiplier);
      if (damageMultiplier > 0) {
        entry.dm = damageMultiplier;
      }
      const rateOfFire = attr(ATTRIBUTE.rateOfFire);
      if (rateOfFire > 0) {
        entry.rof = rateOfFire;
      }
    }
  }
  if (record.categoryID === CATEGORY_DRONE) {
    const bandwidth = attr(ATTRIBUTE.droneBandwidthUsed);
    if (bandwidth > 0) {
      entry.bw = bandwidth;
    }
  }
  return entry;
}

function buildIndex(options = {}) {
  const sdeDir = options.sdeDir;
  const log = options.log || (() => {});
  const now = options.now || (() => Date.now());
  if (!sdeDir) {
    throw new Error("NF_CREW_CATALOG_NO_SDE");
  }
  const sdeBuild = options.sdeBuild || readSdeBuild(sdeDir);
  const groupCategory = readGroupCategories(sdeDir);
  const records = scanTypes(sdeDir, groupCategory, log);
  const wanted = new Set(records.map((record) => record.typeID));
  const dogma = scanDogma(sdeDir, wanted);
  const types = {};
  const counts = {hull: 0, high: 0, med: 0, low: 0, rig: 0, subsystem: 0, service: 0, module: 0, charge: 0, drone: 0};
  for (const record of records) {
    if (!record.published) {
      continue;
    }
    const entry = compactEntry(record, dogma.get(record.typeID));
    types[record.typeID] = entry;
    if (Object.prototype.hasOwnProperty.call(counts, entry.f)) {
      counts[entry.f] += 1;
    }
  }
  return {version: CACHE_VERSION, sdeBuild, builtAt: now(), counts, types};
}

/**
 * options = {sdeDir, sdeBuild, cacheFile, log, now}
 * 返回 {status(), build(force), get(typeID), all(), ships(), modules(family), chargesFor(moduleTypeID), counts()}
 */
function createCatalog(options = {}) {
  const log = options.log || (() => {});
  const now = options.now || (() => Date.now());
  const cacheFile = options.cacheFile || DEFAULT_CACHE_FILE;
  const sdeDir = options.sdeDir;
  const sdeBuild = options.sdeBuild || (sdeDir ? readSdeBuild(sdeDir) : "");

  let index = null; // {version, sdeBuild, builtAt, counts, types}
  let lastError = null;

  function readCache() {
    try {
      const raw = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      if (!raw || raw.version !== CACHE_VERSION || !raw.types) {
        return null;
      }
      if (sdeBuild && raw.sdeBuild !== sdeBuild) {
        return null; // SDE 换了：重建
      }
      return raw;
    } catch (_error) {
      return null;
    }
  }

  function writeCache(value) {
    try {
      fs.mkdirSync(path.dirname(cacheFile), {recursive: true});
      fs.writeFileSync(cacheFile, JSON.stringify(value), "utf8");
      return true;
    } catch (error) {
      lastError = `WRITE_FAILED:${error && error.message}`;
      log(`[catalog] 写缓存失败：${lastError}`);
      return false;
    }
  }

  /** 首次访问时加载：缓存可用就读缓存，否则扫 SDE 重建。 */
  function ensure(force = false) {
    if (index && !force) {
      return index;
    }
    if (!force) {
      const cached = readCache();
      if (cached) {
        index = cached;
        return index;
      }
    }
    const startedAt = now();
    index = buildIndex({sdeDir, sdeBuild, log, now});
    const ms = now() - startedAt;
    log(`[catalog] 索引重建：${Object.keys(index.types).length} 个类型，${ms} ms（SDE ${index.sdeBuild}）`);
    writeCache(index);
    return index;
  }

  function status() {
    try {
      ensure(false);
    } catch (error) {
      return {ok: false, error: error && error.message, cacheFile, sdeBuild};
    }
    return {
      ok: true,
      cacheFile,
      sdeBuild: index.sdeBuild,
      builtAt: index.builtAt,
      counts: {...index.counts},
      total: Object.keys(index.types).length,
      error: lastError,
    };
  }

  function build(force = false) {
    try {
      ensure(force === true);
      return {ok: true, ...status()};
    } catch (error) {
      return {ok: false, error: error && error.message};
    }
  }

  function get(typeID) {
    const id = Number(typeID) || 0;
    if (!id) {
      return null;
    }
    try {
      ensure(false);
    } catch (_error) {
      return null;
    }
    return index.types[id] || null;
  }

  function all() {
    try {
      ensure(false);
    } catch (_error) {
      return [];
    }
    return Object.entries(index.types).map(([typeID, entry]) => ({typeID: Number(typeID), ...entry}));
  }

  function ships() {
    return all().filter((entry) => entry.f === "hull").sort((a, b) => a.n.localeCompare(b.n));
  }

  function modules(family) {
    const wanted = String(family || "").toLowerCase();
    return all()
      .filter((entry) => (wanted ? entry.f === wanted : MODULE_FAMILIES.has(entry.f)))
      .sort((a, b) => a.n.localeCompare(b.n));
  }

  /** 某门炮能装哪些弹药：组的交集 + 尺寸一致。 */
  function chargesFor(moduleTypeID) {
    const module = get(moduleTypeID);
    if (!module || !Array.isArray(module.cg) || module.cg.length === 0) {
      return [];
    }
    const groups = new Set(module.cg.map(Number));
    const size = Number(module.cs) || 0;
    return all()
      .filter((entry) => entry.f === "charge" && groups.has(Number(entry.g)))
      .filter((entry) => !size || !entry.cs || Number(entry.cs) === size)
      .sort((a, b) => a.n.localeCompare(b.n));
  }

  return {status, build, get, all, ships, modules, chargesFor};
}

module.exports = {
  createCatalog,
  buildIndex,
  readSdeBuild,
  familyOf,
  FAMILIES,
  CACHE_VERSION,
  ATTRIBUTE,
  CATEGORY_SHIP,
  CATEGORY_MODULE,
  CATEGORY_CHARGE,
  CATEGORY_DRONE,
};
