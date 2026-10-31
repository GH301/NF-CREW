"use strict";

// 导弹/鱼雷齐射的**纯表现**实体球。
//
// 背景：齐射以前只发一条 deployment 特效（MissileDeployment / TorpedoDeployment），
// 但客户端要靠 `AddBalls2 + LaunchMissile` 收到一枚 kind === "missile" 的球，才会
// 播发射动作、弹道、命中爆炸和声音（environment/spaceObject/missile.py）。没有球，
// 特效没有可以挂的弹体，玩家基本看不到导弹。
//
// 做法和 evejs-faction-sim 的会战开火（lib/bridge/theatreFire.js `launch()`）同一条路：
//   1. 照常走服务端的 `scene.launchMissile`：目标校验、发射位、半径、飞行预算、
//      广播 AddBalls + LaunchMissile，全是上游的；
//   2. 快照用引擎自己的"纯表现"族 `festivalLauncher`（命中连
//      applyWeaponDamageToTarget 都不进、也不发伤害提示/不记无人机仇恨），
//      外加 `rawShotDamage` 全 0、`damageMultiplier` 0 作第二道保险；
//      所以这根球**打不出伤害、不记 KM、不拉仇恨**；
//   3. 伤害仍然由 `nfCrewMiningSalvo` 的齐射结算负责，本模块只管画面。
//
// 三个必须记住的点：
//   - 不要改传进来的 snapshot（它有 5 秒缓存，是共享对象）——`buildCosmeticSnapshot`
//     永远返回新对象；
//   - `flightTimeMs` 至少覆盖 距离/速度，否则 `expiresAtMs` 先到，球在半路消失
//     （missileEntity 的 "timeout-before-impact"），看不到命中爆炸；
//   - 一个球带全组 `launchModules`：客户端会按 moduleID 让每门发射器开火，
//     服务端只花一个实体（和 faction-sim 每船每周期一发同一个口径）。
//
// 上限：每场景同时最多 `EVEJS_CM_MISSILE_CAP`（默认 24，0 = 不限）枚在飞。
// 为什么必须自己加：evejs-perf-fix 的 missilecap 只拦「没有 session 且 npcEntityType」
// 的 NPC 对 NPC 导弹；船员船挂的是无头 session，不在它的保护范围内。
// 全局关：`EVEJS_CM_MISSILE_FX=0`；单租户关：蓝图 `behavior.missileEntity = false`。

const DEFAULTS = Object.freeze({cap: 24});
const CAP_ENV = "EVEJS_CM_MISSILE_CAP";
const ENABLED_ENV = "EVEJS_CM_MISSILE_FX";
// 目标可能在飞，飞行预算留 25% + 2 秒余量（faction-sim 用的是 1.2 倍 + 2 秒）。
const FLIGHT_MARGIN_FACTOR = 1.25;
const FLIGHT_MARGIN_MS = 2000;

// scene → Set<missile entity>（在飞的真实球）
const liveByScene = new WeakMap();

const stats = {
  launched: 0,
  failed: 0,
  capped: 0,
  disabled: 0,
  pruned: 0,
  lastError: null,
};

function envInt(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
}

/** 全局开关：只有显式写 "0" 才关，其余（没设、空串、1）都算开。 */
function enabled() {
  return String(process.env[ENABLED_ENV] || "").trim() !== "0";
}

function cap() {
  return envInt(CAP_ENV, DEFAULTS.cap);
}

/**
 * 给 launchMissile 用的"零伤害 + 够长飞行时间"快照。
 * **永远返回新对象**：`snapshot` 来自 nfCrewMiningSnapshotCache，是共享的，
 * 直接改它会把之后所有齐射的伤害一起清零。
 *
 * `family` 改成 "festivalLauncher"：引擎给"纯表现弹"留的分支
 * （missileEntity.applyMissileImpactDamage / notifyWeaponDamageMessages）。
 * 命中时它连 applyWeaponDamageToTarget 都不进，也不会发 0 伤害的伤害提示、
 * 不会给无人机记仇恨——比"伤害全 0"更干净（零伤害是第二道保险）。
 *
 * @param {object} snapshot 齐射用的武器快照（buildWeaponModuleSnapshot 的返回值）
 * @param {number} distanceMeters 发射时与目标的表面距离
 * @returns {object} 新快照
 */
function buildCosmeticSnapshot(snapshot, distanceMeters) {
  const source = snapshot && typeof snapshot === "object" ? snapshot : {};
  const speed = Math.max(1, Number(source.maxVelocity) || 0);
  const meters = Math.max(0, Number(distanceMeters) || 0);
  const flightMs = Math.max(
    Number(source.flightTimeMs) || 0,
    (meters / speed) * 1000 * FLIGHT_MARGIN_FACTOR + FLIGHT_MARGIN_MS,
  );
  // 先取整再算射程，两个字段才对得上（否则差 1 米，测试和日志会互相打脸）。
  const roundedFlightMs = Math.round(flightMs);
  return {
    ...source,
    // 引擎自己的"纯表现"族：命中不结算伤害、不发伤害提示、不记仇恨。
    family: "festivalLauncher",
    // 第二道保险：即使有别的路径读 rawShotDamage，也只会拿到 0。
    rawShotDamage: {em: 0, thermal: 0, kinetic: 0, explosive: 0},
    damageMultiplier: 0,
    flightTimeMs: roundedFlightMs,
    // 射程只是快照的自述字段；真正会不会飞由 skipRangeCheck 决定。
    approxRange: Math.round(speed * (roundedFlightMs / 1000)),
  };
}

function liveSet(scene) {
  let set = liveByScene.get(scene);
  if (!set) {
    set = new Set();
    liveByScene.set(scene, set);
  }
  return set;
}

/** 把已经被服务端摘掉的球从计数里清掉（否则上限会被幽灵占着）。 */
function prune(scene, set) {
  const dynamic = scene && scene.dynamicEntities;
  if (!(dynamic instanceof Map)) {
    return set;
  }
  for (const entity of set) {
    if (!entity || entity.removed === true || dynamic.get(entity.itemID) !== entity) {
      set.delete(entity);
      stats.pruned += 1;
    }
  }
  return set;
}

/**
 * 发一枚零伤害的表现球。
 *
 * request = {
 *   scene, attacker, target, snapshot,        // snapshot 必须是 buildCosmeticSnapshot 的结果
 *   chargeItem, moduleItem, launchModules,    // 和引擎武器周期同一套参数
 *   launchTimeMs,                             // **模拟时间**（scene.getCurrentSimTimeMs）
 *   enabled,                                  // false = 本租户关掉（behavior.missileEntity）
 * }
 * 返回 {ok, entityID, impactAtMs} 或 {ok:false, reason}。
 * 失败只会少一段画面，调用方不应该把它当成"这一轮没开火"。
 */
function launch(deps, request = {}) {
  if (request.enabled === false || !enabled()) {
    stats.disabled += 1;
    return {ok: false, reason: "DISABLED"};
  }
  const scene = request.scene;
  if (!scene || typeof scene.launchMissile !== "function") {
    // 老引擎/测试桩：没有这个 API 就安静地当没有画面。
    return {ok: false, reason: "NO_API"};
  }
  const attacker = request.attacker;
  const target = request.target;
  const snapshot = request.snapshot;
  if (!attacker || !target || !snapshot || typeof snapshot !== "object") {
    return {ok: false, reason: "BAD_ARGUMENTS"};
  }
  const set = liveSet(scene);
  prune(scene, set);
  const limit = cap();
  if (limit > 0 && set.size >= limit) {
    stats.capped += 1;
    return {ok: false, reason: "CAP"};
  }
  const launchTimeMs = Number(request.launchTimeMs) || 0;
  // chargeItem 的 groupID 决定客户端把球渲染成什么模型（导弹/鱼雷）。
  // 库存物品一般带着；缺了就用快照里的 chargeGroupID 补上（并且不改调用方的对象）。
  const chargeItem = request.chargeItem && typeof request.chargeItem === "object"
    ? {...request.chargeItem}
    : null;
  if (
    chargeItem
    && !(Number(chargeItem.groupID) > 0)
    && Number(snapshot.chargeGroupID) > 0
  ) {
    chargeItem.groupID = Number(snapshot.chargeGroupID);
  }
  let result = null;
  try {
    result = scene.launchMissile(attacker, Number(target.itemID) || 0, snapshot, {
      launchTimeMs,
      chargeItem,
      moduleItem: request.moduleItem || null,
      launchModules: Array.isArray(request.launchModules) && request.launchModules.length > 0
        ? request.launchModules
        : undefined,
      // 射程已经由齐射那一步用 estimateMissileEffectiveRange 判过；
      // 这里再拦一次只会让"差 1 米"的球不放，反而更难看。
      skipRangeCheck: true,
    });
  } catch (error) {
    stats.failed += 1;
    stats.lastError = error && error.message ? error.message : String(error);
    return {ok: false, reason: `LAUNCH_FAILED:${stats.lastError}`};
  }
  const entity = result && result.success === true && result.data ? result.data.entity : null;
  if (!entity || entity.kind !== "missile") {
    stats.failed += 1;
    return {ok: false, reason: `LAUNCH_REFUSED:${(result && result.errorMsg) || "NO_ENTITY"}`};
  }
  set.add(entity);
  stats.launched += 1;
  return {
    ok: true,
    entityID: Number(entity.itemID) || 0,
    impactAtMs: Number(entity.impactAtMs) || 0,
    inFlight: set.size,
  };
}

/** 场景没了（解散/召回/切场景）：把计数丢掉，免得 WeakMap 里留幽灵。 */
function forget(scene) {
  if (scene) {
    liveByScene.delete(scene);
  }
}

/** 在飞球数（诊断/测试用）。 */
function inFlight(scene) {
  const set = scene ? liveByScene.get(scene) : null;
  return set ? prune(scene, set).size : 0;
}

function statsSnapshot() {
  return {...stats, cap: cap(), enabled: enabled()};
}

/** 测试用：清空统计（WeakMap 里的球不受影响，换 scene 即可）。 */
function __reset() {
  for (const key of Object.keys(stats)) {
    stats[key] = key === "lastError" ? null : 0;
  }
}

module.exports = {
  DEFAULTS,
  CAP_ENV,
  ENABLED_ENV,
  buildCosmeticSnapshot,
  launch,
  forget,
  inFlight,
  enabled,
  cap,
  stats: statsSnapshot,
  __reset,
};
