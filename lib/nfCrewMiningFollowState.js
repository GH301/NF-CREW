"use strict";

// 跟随/阵型的"当前指令"（0.6.8 起）。
//
// 这是队形相关行为的**唯一权威来源**：命令与面板写这里，`rearm`（跟随）和环形控制器读这里。
// 蓝图里的 `followFormation` / `followDistance` / `crewSpacingMeters` 不再驱动行为
// （用户 2026-10-25 定：蓝图不驱动，移动与站位是两套独立系统）。
//
// 语义：
//   idle   —— 召唤后的默认值。**不下发任何移动/站位指令**（"没有默认行动"）。
//   follow —— 跟随：所有船都和玩家保持同一个表面距 `gap`（**不**按槽位递增）。
//             走引擎 FOLLOW，**没有 500 m 下限**，所以 gap < 500 也会真的生效。
//             `spacing`（每艘递增）不参与这个模式。
//   ladder —— 阶梯：离玩家 `gap`（表面距），相邻两艘再 +`spacing` 逐级外扩。
//             同样走引擎 FOLLOW。
//   ring   —— 环形：自写闭环，环的表面间距 = `gap`；`gap` 未配置时不动并说明原因。
//
// 跃迁（fleetWarp）是独立系统，不受这里的 mode 影响。

const MODES = new Set(["idle", "ladder", "follow", "ring"]);

const DEFAULTS = {
  mode: "idle",
  // -1 = 未配置（不是 0：0 是合法值，表示表面相切）
  gap: -1,
  spacing: 100,
};

const GAP_MAX_METERS = 5000;
const SPACING_MAX_METERS = 5000;

function normalizeMode(value, fallback = DEFAULTS.mode) {
  const text = String(value == null ? "" : value).trim().toLowerCase();
  if (MODES.has(text)) {
    return text;
  }
  // 历史值 "stop" 是"停船"，已从阵型里摘出去 → 回到 idle（不动），由调用方提示改用 /crewmine halt。
  return fallback;
}

/** -1 = 未配置；其余限制在 0..5000（米）。非数字 → -1。 */
function normalizeGap(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return DEFAULTS.gap;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULTS.gap;
  }
  if (numeric < 0) {
    return -1;
  }
  return Math.min(GAP_MAX_METERS, Math.round(numeric));
}

function normalizeSpacing(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return DEFAULTS.spacing;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULTS.spacing;
  }
  return Math.min(SPACING_MAX_METERS, Math.max(0, Math.round(numeric)));
}

/** 把任意来源（state.json / 命令 / 面板）规整成合法状态。缺字段回落默认值。 */
function normalize(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    mode: normalizeMode(source.mode),
    gap: normalizeGap(source.gap),
    spacing: normalizeSpacing(source.spacing),
  };
}

/** gap 是否已配置（follow / ladder / ring 都需要它才动）。 */
function gapConfigured(state) {
  const gap = normalizeGap(state && state.gap);
  return gap >= 0;
}

/** 环形需要 gap > 0：0 会让环退化成一个点。 */
function ringReady(state) {
  const gap = normalizeGap(state && state.gap);
  return gap > 0;
}

/**
 * 这个模式现在能不能动：跟随/阶梯只要 gap >= 0，环形还要 > 0。
 * idle 永远不会动（"没有默认行动"）。
 */
function modeReady(state) {
  const mode = normalizeMode(state && state.mode);
  if (mode === "ring") {
    return ringReady(state);
  }
  if (mode === "follow" || mode === "ladder") {
    return gapConfigured(state);
  }
  return false;
}

/**
 * 跟随模式里每艘船该保持的表面距：**所有人同一个值**（gap），不按槽位递增。
 * gap 未配置时返回 0（调用方应先判 modeReady，不会真的下发）。
 */
function followStandoff(state) {
  return Math.max(0, normalizeGap(state && state.gap));
}

/**
 * 阶梯里第 index 艘应保持的表面距：gap + index * spacing。
 * 用引擎 FOLLOW（无下限），所以不需要像旧的 ORBIT 分支那样压到 500。
 */
function ladderStandoff(state, index) {
  const gap = Math.max(0, normalizeGap(state && state.gap));
  const spacing = normalizeSpacing(state && state.spacing);
  const slot = Math.max(0, Math.trunc(Number(index) || 0));
  return gap + slot * spacing;
}

module.exports = {
  MODES,
  DEFAULTS,
  GAP_MAX_METERS,
  SPACING_MAX_METERS,
  normalizeMode,
  normalizeGap,
  normalizeSpacing,
  normalize,
  gapConfigured,
  ringReady,
  modeReady,
  followStandoff,
  ladderStandoff,
};
