"use strict";

// behavior 配置的唯一写入口。
//
// 以前 runtime 里有两份几乎一样的写盘循环（命令用一份、面板 API 用一份），类型转换
// 也各写各的——阵型/间距那次 bug 就是从这里来的。现在：写盘、裁剪旧键、类型转换、
// 白名单全在这一个文件里，命令和 API 都走 `createBehaviorWriter()`。

const fs = require("node:fs");
const path = require("node:path");

// 允许从面板/命令修改的键（其余的只能改蓝图文件）。
const WRITABLE = new Set([
  "weaponSalvo",
  // 导弹/鱼雷零伤害表现球（默认开；关掉只是看不到弹体，伤害不变）。
  "missileEntity",
  "npcMode",
  "chaseOutOfRange",
  "followClose",
  "followDistance",
  "crewSpacingMeters",
  "followFormation",
  // 入场方式：cyno（诱导入场，默认）/ warp / instant。出问题时一条命令就能切回跃迁。
  "arrival",
  // 离场方式：jump（诱导跳走，默认）/ warp（老的真跃迁飞离）。
  "departure",
]);

// 数值键的合法区间。
const RANGES = {
  followDistance: [-1, 1000],
  crewSpacingMeters: [0, 5000],
};

// follow = 跟随（所有人同一个间距，不分槽位）；ladder = 阶梯（依次外扩）；ring = 环形（同一圈 + 自写刹车）。
// 0.6.8 起 **停船不再是阵型**：它是独立动作 `/crewmine halt`（runtime.haltCrew）。
const FORMATIONS = new Set(["ladder", "follow", "ring"]);

// 入场方式（0.6.9）：默认诱导入场；偶发问题时切回 warp 就行。
const ARRIVALS = new Set(["cyno", "warp", "instant"]);
// 离场方式（0.6.10）：默认诱导跳走；想要老的跃迁飞离就写 warp。
const DEPARTURES = new Set(["jump", "warp"]);

/**
 * 阵型归一。历史值 `stop` 不再合法 → 回落 `ladder`；
 * `ladder` 只是"归一后的默认阵型"，**不代表会自动跟随**（默认 followMode 是 idle）。
 */
function normalizeFormation(value) {
  const text = String(value == null ? "" : value).trim().toLowerCase();
  return FORMATIONS.has(text) ? text : "ladder";
}

/** 阵型值是否合法（用于把 `stop` 与拼写错误区分开）。 */
function isFormation(value) {
  return FORMATIONS.has(String(value == null ? "" : value).trim().toLowerCase());
}

/** 写盘前删掉 behavior 里已不存在的旧键（老配置会在下一次写入时自愈）。 */
function pruneBehaviorKeys(behavior, knownKeys) {
  if (!behavior || typeof behavior !== "object") {
    return behavior;
  }
  const known = knownKeys || {};
  for (const key of Object.keys(behavior)) {
    if (!Object.prototype.hasOwnProperty.call(known, key)) {
      delete behavior[key];
    }
  }
  return behavior;
}

/**
 * 按 key 做类型转换 + 范围校验。返回 {ok, value} 或 {ok:false, error}。
 * 布尔键接受 true / "true"；数值键接受数字或数字字符串；阵型只接受 ladder / follow / ring。
 */
function coerceValue(key, value) {
  if (key === "arrival") {
    const text = String(value == null ? "" : value).trim().toLowerCase();
    if (!ARRIVALS.has(text)) {
      return {ok: false, error: "BAD_VALUE"};
    }
    return {ok: true, value: text};
  }
  if (key === "departure") {
    const text = String(value == null ? "" : value).trim().toLowerCase();
    if (!DEPARTURES.has(text)) {
      return {ok: false, error: "BAD_VALUE"};
    }
    return {ok: true, value: text};
  }
  if (key === "followFormation") {
    const text = String(value == null ? "" : value).trim().toLowerCase();
    if (!FORMATIONS.has(text)) {
      return {ok: false, error: "BAD_VALUE"};
    }
    return {ok: true, value: text};
  }
  if (RANGES[key]) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return {ok: false, error: "BAD_VALUE"};
    }
    const [min, max] = RANGES[key];
    return {ok: true, value: Math.min(max, Math.max(min, Math.round(parsed)))};
  }
  return {ok: true, value: value === true || value === "true"};
}

/**
 * options = {configsDir, configStore, log, knownKeys, normalizeFormation?}
 * 返回 {persist(key, value, extra), setGlobalBehaviorFlag(key, value), prune(behavior)}
 */
function createBehaviorWriter(options = {}) {
  const configsDir = options.configsDir;
  const configStore = options.configStore;
  const log = typeof options.log === "function" ? options.log : () => {};
  const knownKeys = options.knownKeys || {};
  const read = options.readFileSync || ((file) => fs.readFileSync(file, "utf8"));
  const write = options.writeFileSync || ((file, body) => fs.writeFileSync(file, body, "utf8"));

  function files() {
    try {
      return fs.readdirSync(configsDir).filter((name) => name.toLowerCase().endsWith(".json"));
    } catch (_error) {
      return [];
    }
  }

  /** 把 key（以及 extra 里的字段）写进所有蓝图，然后重载配置。 */
  function persist(key, value, extra = null) {
    let written = 0;
    const errors = [];
    for (const name of files()) {
      const file = path.join(configsDir, name);
      try {
        const data = JSON.parse(read(file));
        data.behavior = data.behavior && typeof data.behavior === "object" ? data.behavior : {};
        data.behavior[key] = value;
        if (extra && typeof extra === "object") {
          Object.assign(data.behavior, extra);
        }
        pruneBehaviorKeys(data.behavior, knownKeys);
        write(file, `${JSON.stringify(data, null, 2)}\n`);
        written += 1;
      } catch (error) {
        errors.push(`${name}:${error && error.message}`);
      }
    }
    if (written > 0 && configStore && typeof configStore.reload === "function") {
      try {
        configStore.reload();
      } catch (_error) {
        /* 下一次 /crewmine config 会再读一次 */
      }
    }
    return {written, errors};
  }

  /** 面板 API：校验 + 转换 + 写盘。 */
  function setGlobalBehaviorFlag(key, value) {
    if (!WRITABLE.has(key)) {
      return {ok: false, error: "UNSUPPORTED_FLAG"};
    }
    const coerced = coerceValue(key, value);
    if (coerced.ok !== true) {
      return {ok: false, error: coerced.error};
    }
    // 新下拉接管后清掉旧 followClose，避免 legacy=true 把 0 又解释成 50 m。
    const extra = key === "followDistance" ? {followClose: false} : null;
    const outcome = persist(key, coerced.value, extra);
    log(`[mode] ${key} = ${coerced.value}（写入 ${outcome.written} 个蓝图` +
      `${outcome.errors.length > 0 ? `，失败 ${outcome.errors.length}` : ""}）`);
    return {
      ok: outcome.errors.length === 0 && outcome.written > 0,
      written: outcome.written,
      errors: outcome.errors,
      value: coerced.value,
    };
  }

  return {persist, setGlobalBehaviorFlag, prune: (behavior) => pruneBehaviorKeys(behavior, knownKeys)};
}

module.exports = {
  WRITABLE,
  RANGES,
  FORMATIONS,
  ARRIVALS,
  DEPARTURES,
  normalizeFormation,
  isFormation,
  coerceValue,
  pruneBehaviorKeys,
  createBehaviorWriter,
};
