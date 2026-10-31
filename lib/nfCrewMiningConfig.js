"use strict";

// Blueprint config layer: _local/nf-crew/configs/<id>.json
//
// One file = one crew type (PLAN.md §4.1). A config either carries an inline
// fit or points at a client fitting export, which is resolved into an inline
// fit at load time so the runtime only ever sees one shape.
//
// The SDE is injected; tests use a fake.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const host = require(path.join(__dirname, "nfCrewMiningHost.js"));
const {parseFittings, findFitting} = require(path.join(__dirname, "nfCrewMiningFitting.js"));
const {buildInlineFit} = require(path.join(__dirname, "nfCrewMiningBlueprint.js"));

const JOB_MINING = "mining";
const SUPPORTED_JOBS = new Set([JOB_MINING]);
const SKILL_MODES = new Set(["all", "mining-basic"]);

const DRONE_DEFAULTS = Object.freeze({
  launch: "auto",          // auto | always | never
  mode: "mining",          // mining | combat (combat is M12)
  maxActive: 0,            // 0 = every drone in the bay
  recallBeforeWarp: true,
  recallWhenIdle: true,
});
const DRONE_LAUNCH_MODES = new Set(["auto", "always", "never"]);
const DRONE_MODES = new Set(["mining", "combat"]);

const BEHAVIOR_DEFAULTS = Object.freeze({
  // P1 master switch: false = player-style (module activation), true = NPC-style
  // (direct settlement, no activation, no ammo/capacitor). Default off so nothing
  // changes until a blueprint opts in.
  npcMode: false,
  // Player-style volley: one shot calculation per weapon type, damage x turret count,
  // capacitor charged per turret. Skips per-module activation (the 0.5-1.1 s stall).
  weaponSalvo: true,
  // 导弹/鱼雷齐射时是否真的发一枚**零伤害**的导弹球（纯表现：客户端靠它播发射动作、
  // 弹道、命中爆炸和声音）。伤害仍是齐射结算，球本身打不出伤害；关掉只是看不到弹体，
  // 开火/伤害/电容全不变。上限 EVEJS_CM_MISSILE_CAP，全局关 EVEJS_CM_MISSILE_FX=0。
  missileEntity: true,
  // 齐射轮转：每拍最多结算几艘船的炮（船多时把成本摊到多拍，避免堵死事件循环）。
  // 设成 ≥ 在役人数就等于不轮转（人人每拍都打）。
  combatSalvoBudgetPerTick: 3,
  // 火力集中（0.6.13，面板「火力集中」/ `/crewmine focus on`）时的**单拍安全阀**（毫秒）。
  // 打开后不再按上面的条数轮转，本拍所有冷却好的船都结算；累计结算超过这个毫秒数，
  // 余下的船顺延到下一拍 —— 防止 24 艘一次把事件循环钉死十几秒。
  // 它不是"艘数上限"，只是想打得更猛就调大（1000–30000）。
  focusFireMaxTickMs: 6000,
  // 追击：目标在射程外时主动靠近（到射程的 70%），目标没了再回环绕。
  // 注意：这个 key 必须出现在 BEHAVIOR_DEFAULTS 里，否则 normalizeBehavior 会把它丢掉，
  // 面板上的「追击」按钮就会永远显示「开」（读到的永远是 undefined → !== false → true）。
  chaseOutOfRange: false,
  // Plan B doomsday: cooldown only (no fuel, no capacitor), area damage in meters.
  doomsdayCooldownMs: 300000,
  doomsdayRadiusMeters: 300000,
  compressOnCycle: true,
  // M9: defensive modules. Hardeners stay on; boosters pulse on these ratios.
  capBoosterThreshold: 0.3,
  shieldBoosterThreshold: 0.6,
  // 迟滞：护盾回到 90% 才关（60% 开 → 90% 关；配合 Defense 的"充电中"锁存）。
  shieldBoosterStopThreshold: 0.9,
  // 回血：装甲维修器的启动阈值（装甲低于这个比例才修）。
  armorRepairerThreshold: 0.7,
  // 迟滞：装甲修到 95% 才关。
  armorRepairerStopThreshold: 0.95,
  // PLAN §17 P3：抗性常开。增强器的抗性在建船/复活时并入被动快照（影子 effect + 一次重算），
  // 不再真的激活模块 —— 不扣电、不逐门重算。改成 false 回到"激活并保持"的旧行为。
  passiveHardeners: true,
  // 遥修走「齐射式」结算（治疗量 x 模块数，不再逐模块激活）；false = 回退旧路径。
  remoteRepairSalvo: true,
  // 遥修（docs/archive/遥修实现计划书.md §六）：低于 start 开修、高于 stop 停；电容传输双向门槛。
  remoteRepairStartPercent: 0.8,
  remoteRepairStopPercent: 0.95,
  remoteCapTransferStartPercent: 0.5,
  remoteCapTransferSelfMinPercent: 0.6,
  remoteCapFloorPercent: 0.2,
  // PLAN §18/§20 方案 A：特殊模块（组 515）激活前自动补燃料（锶包合物/重水），
  // 由引擎照常扣除。false = 玩家自己备燃料（缺燃料会 NO_FUEL）。
  specialFuelAutoSupply: true,
  // Propulsion (MWD / afterburner): off by default; only used for long transfers.
  propulsionEnabled: true,
  propulsionFarMeters: 20000,
  // Hysteresis for the drive: on outside 30 km, off inside 15 km.
  propulsionOnMeters: 30000,
  propulsionOffMeters: 15000,
  propulsionCapThreshold: 0.15,
  // Free fire (/crewmine attack all): only pick NPC ships this close.
  freeFireRangeMeters: 60000,
  // M5: how often the automatic compress+deliver pass runs.
  serviceIntervalMs: 15000,
  followRangeMeters: 1000,
  // O1：回充器/修甲用 repeat=1 常驻循环（激活一次，引擎自己转）；关掉回到每轮重激活。
  defenseRepeatModules: true,
  // O2：每个 tick 最多激活几个防御模块（其余排队到下一 tick）。
  defenseMaxActivations: 1,
  // O3：同一系统两次“大模块激活”的最小间隔（堡垒/会战/后勤/工业核心/末日）。
  largeActivationGapMs: 2500,
  // O4：service tick 轮转，每次只处理 1 艘（false = 回到一次处理全部）。
  serviceRotate: true,
  // O5：没有候选目标后，多久内不重扫场景。
  scanCooldownMs: 2000,
  // 跟随间距（面板「跟随」下拉）：**表面间距**（模型到模型）0..1000。
  // 0 = 模型相切（合法值）；-1 = 不保持间距，退回分层环绕。
  followDistance: -1,
  // 船员彼此之间的表面间距：第 i 艘船的站位 = followDistance + i * 本值。
  // 0 = 所有船挤在同一个半径上（引擎不控制方位，容易重叠）。
  crewSpacingMeters: 100,
  // 跟随阵型：
  //   "follow" 跟随——所有人都和玩家保持同一个间距，用引擎 FOLLOW（不分槽位、不递增）
  //   "ladder" 阶梯——每人站位依次外扩，用引擎 FOLLOW（稳，但离玩家距离各不同）
  //   "ring"   环形——所有人停在同一圈上，250 ms 闭环刹车（距离一致，轻微抖动）
  followFormation: "ladder",
  // 旧字段：true 等价 followDistance=50（兼容已有配置）。
  followClose: false,
  // Warp to the player only past this gap (in-belt jumps keep the crew mining).
  // How far from the PLAYER a rock may be to be picked (the crew will fly to it).
  mineSearchRadiusMeters: 150000,
  // Module engagement range: farther than this, the ship first flies to the rock.
  mineEngageRangeMeters: 15000,
  deliverStopPercent: 80,
  deliverResumePercent: 70,
  drones: DRONE_DEFAULTS,
  // 老写法（0.6.9 起只作兼容）：false = 直接出现在你旁边（= arrival:"instant"）。
  // 入场方式请用下面的 arrival；warpIn:true 不再强制跃迁（默认已是诱导入场）。
  warpIn: true,
  warpInAu: 2,
  // 入场方式（2026-10-27 用户定：默认诱导入场，和 evejs-faction-sim 的会战舰队一样）：
  //   "cyno"    诱导入场：先在你旁边点亮一个诱导力场，leadMs 之后船员跳进来（默认）
  //   "warp"    从远处跃迁进场（老默认：客户端画真跃迁；想看跃迁就改成这个）
  //   "instant" 直接出现在你旁边（等于老的 warpIn=false）
  // 这个字段优先；没写时按 warpIn 推（false → instant，其余 → cyno）。
  arrival: "cyno",
  // 诱导力场点亮后多久船跳进来（毫秒）。会战舰队用的也是 4 秒。
  cynoLeadMs: 4000,
  // 诱导力场保留多久（毫秒）；到点由场景自己清掉，不用模组收尾。
  cynoDurationMs: 60000,
  // 跳进来的船在力场周围散开的半径（米）；0 = 全部落在力场上（老的跃迁落点）。
  cynoRadiusMeters: 2000,
  // 力场用的物品类型（默认 21094 Cynosural Field）。
  cynoTypeID: 21094,
  // 离场方式（解散时）：
  //   "jump" 诱导跳走（默认）：播一次 JumpDriveOut，6 秒后摘实体（和入场同一套设定）
  //   "warp" 真跃迁飞离（老行为）
  departure: "jump",
  // Optional (see patches/fleet-warp-sync.md): crew warps together with the player.
  // Off by default — a synchronised warp made the client drop the crew ship model.
  syncWarp: false,
});

const DEFAULT_LIMITS = Object.freeze({
  serviceIntervalMs: [5000, 300000],
  // R6: 0 (or negative) put every ship on top of the player and the status line then
  // reported "0 km". 200 m is the smallest distance that still reads as a formation.
  followRangeMeters: [200, 60000],
  mineSearchRadiusMeters: [1000, 500000],
  mineEngageRangeMeters: [2000, 60000],
  doomsdayCooldownMs: [60000, 3600000],
  doomsdayRadiusMeters: [1000, 2000000],
  // O2/O3/O5：防御/大模块/扫描的节流参数。
  defenseMaxActivations: [1, 8],
  largeActivationGapMs: [0, 60000],
  scanCooldownMs: [0, 30000],
  combatSalvoBudgetPerTick: [1, 16],
  focusFireMaxTickMs: [1000, 30000],
  followDistance: [-1, 1000],
  crewSpacingMeters: [0, 5000],
  // 诱导入场（cyno）：点灯到跳入的等待、力场存活时间、落点散开半径、力场物品类型。
  cynoLeadMs: [0, 30000],
  cynoDurationMs: [1000, 600000],
  cynoRadiusMeters: [0, 50000],
  cynoTypeID: [0, 10000000],
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clampNumber(value, fallback, [min, max]) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function normalizeDrones(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const launch = String(source.launch || DRONE_DEFAULTS.launch).toLowerCase();
  const mode = String(source.mode || DRONE_DEFAULTS.mode).toLowerCase();
  return {
    launch: DRONE_LAUNCH_MODES.has(launch) ? launch : DRONE_DEFAULTS.launch,
    mode: DRONE_MODES.has(mode) ? mode : DRONE_DEFAULTS.mode,
    maxActive: Math.min(50, Math.max(0, Math.trunc(Number(source.maxActive) || 0))),
    recallBeforeWarp: source.recallBeforeWarp === undefined
      ? DRONE_DEFAULTS.recallBeforeWarp
      : source.recallBeforeWarp === true,
    recallWhenIdle: source.recallWhenIdle === undefined
      ? DRONE_DEFAULTS.recallWhenIdle
      : source.recallWhenIdle === true,
  };
}

// Flags that must stay booleans; the numeric clamp branch would turn true into 1.
const BOOLEAN_BEHAVIOR_KEYS = new Set([
  "npcMode",
  "weaponSalvo",
  "missileEntity",
  "syncWarp",
  "propulsionEnabled",
  "passiveHardeners",
  "remoteRepairSalvo",
  "specialFuelAutoSupply",
  "chaseOutOfRange",
  "autoMineOnSpawn",
  // O1/O4
  "defenseRepeatModules",
  "serviceRotate",
  "followClose",
]);

// How a summoned crew ship enters the scene. See BEHAVIOR_DEFAULTS.arrival.
const ARRIVAL_MODES = new Set(["warp", "cyno", "instant"]);
// How a disbanded crew ship leaves. See BEHAVIOR_DEFAULTS.departure.
const DEPARTURE_MODES = new Set(["jump", "warp"]);

function normalizeDeparture(raw, fallback) {
  const text = String(raw == null ? "" : raw).trim().toLowerCase();
  if (DEPARTURE_MODES.has(text)) {
    return text;
  }
  const fallbackText = String(fallback == null ? "" : fallback).trim().toLowerCase();
  return DEPARTURE_MODES.has(fallbackText) ? fallbackText : "jump";
}

// `arrival` is the new spelling; `warpIn:false` is the old one and still means
// "appear next to me" when arrival is absent. An explicit arrival always wins.
// (A config that only says warpIn:true does NOT force a warp any more: the default
// is the cyno arrival now, so ask for warp with arrival:"warp".)
function normalizeArrival(raw, warpIn, fallback) {
  const text = String(raw == null ? "" : raw).trim().toLowerCase();
  if (ARRIVAL_MODES.has(text)) {
    return text;
  }
  if (warpIn === false) {
    return "instant";
  }
  const fallbackText = String(fallback == null ? "" : fallback).trim().toLowerCase();
  return ARRIVAL_MODES.has(fallbackText) ? fallbackText : "cyno";
}

function normalizeBehavior(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const behavior = {};
  for (const [key, fallback] of Object.entries(BEHAVIOR_DEFAULTS)) {
    if (key === "drones") {
      behavior.drones = normalizeDrones(source.drones);
      continue;
    }
    if (key === "compressOnCycle") {
      behavior[key] = source[key] === undefined ? fallback : source[key] === true;
      continue;
    }
    if (BOOLEAN_BEHAVIOR_KEYS.has(key)) {
      behavior[key] = source[key] === undefined ? fallback === true : source[key] === true;
      continue;
    }
    if (key === "followFormation") {
      const text = String(source[key] == null ? "" : source[key]).trim().toLowerCase();
      // follow=跟随 / ladder=阶梯 / ring=环形 / stop=停船（其余一律回落到阶梯）。
      behavior[key] = text === "ring" ? "ring" : text === "follow" ? "follow" : text === "stop" ? "stop" : "ladder";
      continue;
    }
    if (key === "arrival") {
      behavior.arrival = normalizeArrival(source.arrival, source.warpIn, fallback);
      continue;
    }
    if (key === "departure") {
      behavior.departure = normalizeDeparture(source.departure, fallback);
      continue;
    }
    if (key === "warpIn") {
      behavior.warpIn = source.warpIn === undefined ? fallback : source.warpIn === true;
      continue;
    }
    if (key === "warpInAu") {
      behavior.warpInAu = clampNumber(source.warpInAu, fallback, [0.1, 50]);
      continue;
    }
    const limits = DEFAULT_LIMITS[key];
    behavior[key] = limits
      ? clampNumber(source[key], fallback, limits)
      : clampNumber(source[key], fallback, [0, 100]);
  }
  if (behavior.deliverResumePercent >= behavior.deliverStopPercent) {
    behavior.deliverResumePercent = Math.max(0, behavior.deliverStopPercent - 10);
  }
  return behavior;
}

function slugify(value) {
  const text = String(value == null ? "" : value).normalize("NFKC");
  const ascii = text
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 60);
  if (ascii) {
    return ascii;
  }
  // Pure-CJK (or symbol-only) names still need a stable, filename-safe id.
  if (!text.trim()) {
    return "";
  }
  const hash = crypto.createHash("sha1").update(text).digest("hex").slice(0, 8);
  return `crew-${hash}`;
}

function normalizeCorporation(value) {
  if (value === undefined || value === null || value === "") {
    return "auto";
  }
  if (typeof value === "number" || /^\d+$/u.test(String(value).trim())) {
    const numeric = Math.trunc(Number(value));
    return numeric > 0 ? numeric : "auto";
  }
  const text = String(value).trim().toLowerCase();
  return text === "none" || text === "auto" ? text : "auto";
}

/**
 * Validate one raw config. Returns {config, problems, warnings}; config is the
 * normalised form (set to null when a structural problem makes it unusable).
 */
function validateConfig(raw, context = {}) {
  const sde = context.sde;
  const problems = [];
  const warnings = [];
  if (!isPlainObject(raw)) {
    return {config: null, problems: ["NOT_AN_OBJECT"], warnings};
  }

  const id = slugify(raw.id);
  if (!id) {
    problems.push("MISSING_ID");
  }
  const count = Number(raw.count);
  if (!Number.isInteger(count) || count < 1) {
    problems.push("BAD_COUNT");
  } else if (count > 30) {
    problems.push("COUNT_TOO_HIGH");
  }

  const job = raw.job === undefined ? JOB_MINING : String(raw.job);
  if (!SUPPORTED_JOBS.has(job)) {
    problems.push(`UNSUPPORTED_JOB:${job}`);
  }
  const skills = raw.skills === undefined ? "all" : String(raw.skills);
  if (!SKILL_MODES.has(skills)) {
    problems.push(`UNKNOWN_SKILLS:${skills}`);
  }
  for (const key of ["wing", "squad"]) {
    if (raw[key] !== undefined && raw[key] !== null && typeof raw[key] !== "string") {
      problems.push(`BAD_${key.toUpperCase()}`);
    }
  }

  // ── fit ────────────────────────────────────────────────────────────────────
  let fit = null;
  if (!isPlainObject(raw.fit)) {
    problems.push("MISSING_FIT");
  } else if (raw.fit.source === "client-xml") {
    const resolved = resolveClientXmlFit(raw.fit, context);
    fit = resolved.fit;
    problems.push(...resolved.problems);
    warnings.push(...resolved.warnings);
  } else if (raw.fit.source === "inline") {
    fit = normalizeInlineFit(raw.fit, problems);
  } else if (raw.fit.hull || raw.fit.modules) {
    // Bare inline form without an explicit source.
    fit = normalizeInlineFit(raw.fit, problems);
  } else {
    problems.push("UNKNOWN_FIT_SOURCE");
  }

  // ── charges (the client never exports them) ────────────────────────────────
  const charges = [];
  if (raw.charges !== undefined) {
    if (!Array.isArray(raw.charges)) {
      problems.push("BAD_CHARGES");
    } else if (sde) {
      const names = raw.charges.map((entry) => (isPlainObject(entry) ? entry.type : entry)).filter(Boolean);
      const {resolved, missing} = sde.resolveNames(names);
      for (const name of missing) {
        problems.push(`CHARGE_NOT_RESOLVED:${name}`);
      }
      for (const entry of raw.charges) {
        const type = isPlainObject(entry) ? entry.type : entry;
        const record = resolved.get(sde.normalizeName(type || ""));
        charges.push({
          typeID: record ? record.typeID : 0,
          name: type,
          quantity: Math.max(1, Number(isPlainObject(entry) ? entry.quantity : 1) || 1),
        });
      }
    }
  }

  const config = problems.length === 0
    ? {
      id,
      name: String(raw.name || id),
      enabled: raw.enabled !== false,
      count,
      job,
      skills,
      corporation: normalizeCorporation(raw.corporation),
      wing: raw.wing === undefined ? null : raw.wing,
      squad: raw.squad === undefined ? null : raw.squad,
      autoMineOnSpawn: raw.autoMineOnSpawn === true,
      fit,
      charges,
      behavior: normalizeBehavior(raw.behavior),
      sourceFile: context.file || null,
    }
    : null;

  return {config, problems, warnings};
}

function normalizeInlineFit(raw, problems) {
  const hull = isPlainObject(raw.hull) ? raw.hull : null;
  const typeID = hull ? Number(hull.typeID) : 0;
  if (!typeID) {
    problems.push("MISSING_HULL_TYPE_ID");
  }
  const modules = [];
  for (const entry of Array.isArray(raw.modules) ? raw.modules : []) {
    if (!isPlainObject(entry)) {
      problems.push("BAD_MODULE_ENTRY");
      continue;
    }
    const flagID = Number(entry.flagID);
    const moduleTypeID = Number(entry.typeID);
    if (!flagID) {
      problems.push(`MODULE_WITHOUT_SLOT:${entry.name || moduleTypeID || "?"}`);
      continue;
    }
    if (!moduleTypeID) {
      problems.push(`MODULE_WITHOUT_TYPE:${entry.name || flagID}`);
      continue;
    }
    const module = {
      slot: String(entry.slot || ""),
      flagID,
      typeID: moduleTypeID,
      name: String(entry.name || ""),
      quantity: Math.max(1, Number(entry.quantity) || 1),
    };
    if (isPlainObject(entry.charge) && Number(entry.charge.typeID)) {
      module.charge = {
        typeID: Number(entry.charge.typeID),
        name: String(entry.charge.name || ""),
        quantity: Math.max(1, Number(entry.charge.quantity) || 1),
      };
    }
    modules.push(module);
  }
  const drones = [];
  for (const entry of Array.isArray(raw.drones) ? raw.drones : []) {
    if (!isPlainObject(entry)) {
      problems.push("BAD_DRONE_ENTRY");
      continue;
    }
    const droneTypeID = Number(entry.typeID);
    if (!droneTypeID) {
      problems.push(`DRONE_WITHOUT_TYPE:${entry.name || "?"}`);
      continue;
    }
    drones.push({
      slot: String(entry.slot || "drone bay"),
      flagID: Number(entry.flagID) || 87,
      typeID: droneTypeID,
      name: String(entry.name || ""),
      quantity: Math.max(1, Number(entry.quantity) || 1),
    });
  }
  if (modules.length === 0 && drones.length === 0) {
    problems.push("EMPTY_FIT");
  }
  return {
    source: "inline",
    hull: {typeID, name: String((hull && hull.name) || "")},
    modules,
    drones,
  };
}

function resolveClientXmlFit(raw, context = {}) {
  const problems = [];
  const warnings = [];
  const file = String(raw.file || "");
  const name = String(raw.name || "");
  if (!file) {
    return {fit: null, problems: ["FIT_FILE_MISSING"], warnings};
  }
  if (!name) {
    return {fit: null, problems: ["FIT_NAME_MISSING"], warnings};
  }
  const fullPath = context.findFittingFile
    ? context.findFittingFile(file)
    : host.findFittingFile(file, raw.dir || null);
  if (!fullPath) {
    return {fit: null, problems: [`FIT_FILE_NOT_FOUND:${file}`], warnings};
  }
  let text;
  try {
    text = fs.readFileSync(fullPath, "utf8");
  } catch (error) {
    return {fit: null, problems: [`FIT_FILE_UNREADABLE:${error && error.message}`], warnings};
  }
  const {fittings} = parseFittings(text);
  const matches = fittings.filter((fitting) => fitting.name === name);
  if (matches.length === 0) {
    return {fit: null, problems: [`FITTING_NOT_FOUND:${name}`], warnings};
  }
  if (matches.length > 1) {
    return {fit: null, problems: [`FITTING_AMBIGUOUS:${name}:${matches.length}`], warnings};
  }
  const built = buildInlineFit(matches[0], context.sde);
  problems.push(...built.problems);
  warnings.push(...(built.unresolved.length > 0 ? [`UNRESOLVED_NAMES:${built.unresolved.join(",")}`] : []));
  return {fit: built.fit, problems, warnings};
}

/** Read every config file; unchanged files are reused through the mtime cache. */
function loadConfigs(state, context = {}) {
  const configsDir = context.configsDir || host.CONFIGS_DIR;
  const previous = state.cache instanceof Map ? state.cache : new Map();
  const next = new Map();
  const configs = [];
  const rejected = [];
  const errors = [];

  let files = [];
  try {
    files = fs.readdirSync(configsDir).filter((name) => name.toLowerCase().endsWith(".json")).sort();
  } catch (error) {
    errors.push(`CONFIGS_DIR_UNREADABLE:${error && error.message}`);
  }

  for (const fileName of files) {
    const fullPath = path.join(configsDir, fileName);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch (error) {
      errors.push(`CONFIG_UNREADABLE:${fileName}:${error && error.message}`);
      continue;
    }
    const fingerprint = `${stat.mtimeMs}:${stat.size}`;
    const cached = previous.get(fullPath);
    if (cached && cached.fingerprint === fingerprint) {
      next.set(fullPath, cached);
      applyResult(cached.result);
      continue;
    }
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(fullPath, "utf8"));
    } catch (error) {
      const result = {config: null, problems: [`BAD_JSON:${error && error.message}`], warnings: []};
      next.set(fullPath, {fingerprint, result});
      applyResult(result);
      continue;
    }
    const result = validateConfig(raw, {...context, file: fileName});
    next.set(fullPath, {fingerprint, result});
    applyResult(result);
  }

  state.cache = next;
  state.configs = configs;
  state.rejected = rejected;
  state.errors = errors;
  return {configs, rejected, errors};

  function applyResult(result) {
    if (result.config) {
      if (configs.some((entry) => entry.id === result.config.id)) {
        rejected.push({config: null, problems: [`DUPLICATE_ID:${result.config.id}`], warnings: result.warnings});
        return;
      }
      configs.push(result.config);
      return;
    }
    rejected.push(result);
  }
}

function createConfigStore(context = {}) {
  const state = {cache: new Map(), configs: [], rejected: [], errors: []};
  return {
    reload() {
      return loadConfigs(state, context);
    },
    get() {
      return {configs: state.configs, rejected: state.rejected, errors: state.errors};
    },
    state,
  };
}

module.exports = {
  JOB_MINING,
  SUPPORTED_JOBS,
  SKILL_MODES,
  BEHAVIOR_DEFAULTS,
  DRONE_DEFAULTS,
  DRONE_LAUNCH_MODES,
  DRONE_MODES,
  validateConfig,
  loadConfigs,
  createConfigStore,
  normalizeBehavior,
  normalizeDrones,
  normalizeInlineFit,
  resolveClientXmlFit,
  slugify,
};
