"use strict";

// 跟队跃迁（方案 A：同 tick 下发、各自对准）。
//
// 设计约束（2026-10-24 定稿）：
// - **不伪造 session**：船员始终是 sessionless 动态实体。引擎 tick 在
//   `entity.session` 为空时会把 warp-start / warp-completion 放进 sharedUpdates
//   （scene/tick.js:2596 → 3105 broadcastMovementUpdates），和 NPC 走同一条广播
//   通道；同时 `beginPilotWarpVisibilityHandoff` 在没有 session 时直接返回
//   （destiny/visibility/warpHandoff.js:56），所以船不会在跃迁开始时被摘球，
//   客户端全程持有同一个 ball，动画连续。
// - **触发点**：包玩家的跃迁命令本身（warpToPoint / warpToEntity），而不是在
//   1 s 轮询里看 pendingWarp。
// - **起跳**：`forceImmediateStart:false`，让每艘船按自己的 agility 对准；把
//   玩家 pendingWarp 的 requestedAtMs 复制过去，使准备条同刻起算。引擎的
//   `evaluatePendingWarp` 是对齐判定（dot≈1 且速度过阈值），到期不跳，所以
//   "同刻起跳"只是近似——这是方案 A 的固有代价。
// - **落地**：不额外补广播。引擎自己的 completion 已经在 sharedUpdates 里，
//   再发一遍会重复 warp-in 特效。
// - **取消**：玩家取消时，仍在"对准"阶段的船员取消并停船；已经进入 warp 的
//   船员放它落地（空中硬停看起来更像 bug）。

const path = require("node:path");

const SERVER_SRC = path.join(__dirname, "..", "..", "..", "server", "src");

let formationModule = null;
let formationTried = false;

/** 引擎的碰撞感知落点算法；拿不到就退回自己排的圆环。 */
function fleetFormation() {
  if (formationTried) {
    return formationModule;
  }
  formationTried = true;
  try {
    formationModule = require(path.join(SERVER_SRC, "services", "fleets", "fleetWarpFormation.js"));
  } catch (_error) {
    formationModule = null;
  }
  return formationModule;
}

// 每个租户一份上下文。deps 是进程级单例（serverDeps 只建一次），所以不能按 deps
// 分组——用账号 key，注册时由 runtime 传入自己的 tenantAccountID。
const contexts = new Map();
// 引擎的 spaceRuntime 是进程级单例，同一个对象只包一次；测试里每个用例自造一个
// 假 runtime 也能各自包上。
const hookedRuntimes = new WeakSet();

/** 会话属于哪个账号：和租户解析同一套规则，取不到就退回注册时的账号。 */
function accountOfSession(deps, session, fallback) {
  const characterID = Number(session && (session.characterID || session.charid)) || 0;
  if (characterID && deps && deps.characterState
    && typeof deps.characterState.peekCharacterRecord === "function") {
    try {
      const record = deps.characterState.peekCharacterRecord(characterID);
      const accountID = Number(record && (record.accountId || record.accountID)) || 0;
      if (accountID) {
        return accountID;
      }
    } catch (_error) {
      /* fall through */
    }
  }
  return Number(fallback) || 0;
}

function contextFor(accountID) {
  const key = Number(accountID) || 0;
  let ctx = contexts.get(key);
  if (!ctx) {
    ctx = {accountID: key, options: {}, seq: 0, group: null};
    contexts.set(key, ctx);
  }
  return ctx;
}

function log(ctx, line) {
  const fn = ctx && ctx.options && ctx.options.log;
  if (typeof fn === "function") {
    fn(line);
  }
}

function nowMs(ctx) {
  const fn = ctx && ctx.options && ctx.options.now;
  return typeof fn === "function" ? Number(fn()) || Date.now() : Date.now();
}

function isEnabled(ctx) {
  const fn = ctx && ctx.options && ctx.options.enabled;
  return typeof fn === "function" ? fn() === true : false;
}

function modeOf(entity) {
  return String((entity && entity.mode) || "").toUpperCase();
}

function isWarping(entity) {
  return Boolean(entity) && (
    modeOf(entity) === "WARP"
    || Boolean(entity.pendingWarp)
    || Boolean(entity.warpState)
  );
}

/** 本池子里在役且实体还在场景里的船员。 */
function summonedCrew(ctx, scene) {
  const poolFn = ctx.options && ctx.options.pool;
  const pool = typeof poolFn === "function" ? poolFn() || [] : [];
  const out = [];
  for (const entry of pool) {
    if (!entry || entry.summoned !== true) {
      continue;
    }
    const shipID = Number(entry.shipID) || 0;
    if (!shipID || typeof scene.getEntityByID !== "function") {
      continue;
    }
    const entity = scene.getEntityByID(shipID);
    if (!entity || !entity.position) {
      continue;
    }
    out.push({
      characterID: Number(entry.characterID) || 0,
      name: String(entry.name || entry.characterID || shipID),
      shipID,
      entity,
    });
  }
  return out;
}

function directionTo(from, to) {
  return {
    x: Number(to && to.x) - Number(from && from.x),
    y: Number(to && to.y) - Number(from && from.y),
    z: Number(to && to.z) - Number(from && from.z),
  };
}

/**
 * 落点：锚点 = 玩家自己的落点；每艘船员按引擎的碰撞感知点阵错开，避免落地
 * 叠在一起、也避免落进玩家的船体里。
 */
function landingPoints(playerEntity, anchor, crew, seq) {
  const points = new Map();
  const followers = crew
    .map((entry) => ({
      characterID: Number(entry.characterID) || 0,
      radius: Number(entry.entity.radius) || 0,
      position: entry.entity.position,
    }))
    .filter((row) => row.characterID > 0)
    .sort((left, right) => left.characterID - right.characterID);
  if (followers.length === 0) {
    return points;
  }
  const formation = fleetFormation();
  if (formation && typeof formation.computeFleetWarpPointLandingPoints === "function") {
    try {
      const computed = formation.computeFleetWarpPointLandingPoints({
        anchorPoint: anchor,
        anchorRadius: Number(playerEntity.radius) || 0,
        warpDirection: directionTo(playerEntity.position, anchor),
        followers,
        // 每条命令换一个旋转相位，阵型不会每次都朝同一侧。
        rotationFraction: (seq * 0.6180339887498949) % 1,
      });
      if (computed instanceof Map && computed.size > 0) {
        for (const [characterID, point] of computed) {
          points.set(Number(characterID), point);
        }
        return points;
      }
    } catch (_error) {
      /* fall through to the ring */
    }
  }
  // 兜底：以玩家半径为基准排一圈。
  const radius = Math.max(150, (Number(playerEntity.radius) || 0) * 2.5);
  followers.forEach((row, index) => {
    const angle = (Math.PI * 2 * index) / followers.length;
    points.set(row.characterID, {
      x: Number(anchor.x) + Math.cos(angle) * radius,
      y: Number(anchor.y),
      z: Number(anchor.z) + Math.sin(angle) * radius,
    });
  });
  return points;
}

function beginGroup(ctx, deps, session, pending, result) {
  const sceneFor = ctx.options && ctx.options.sceneFor;
  const scene = typeof sceneFor === "function" ? sceneFor(session) : null;
  if (!scene || typeof scene.getEntityByID !== "function") {
    return;
  }
  const systemID = Number(scene.systemID) || 0;
  const playerShipID = Number(session && session._space && session._space.shipID) || 0;
  const playerEntity = playerShipID ? scene.getEntityByID(playerShipID) : null;
  if (!playerEntity || !playerEntity.position) {
    return;
  }
  const anchor = (pending && (pending.targetPoint || pending.rawDestination)) || null;
  if (!anchor) {
    return;
  }
  const crew = summonedCrew(ctx, scene);
  if (crew.length === 0) {
    return;
  }
  const seq = (ctx.seq += 1);
  const points = landingPoints(playerEntity, anchor, crew, seq);
  const requestedAtMs = Number(pending.requestedAtMs) || nowMs(ctx);
  const warpSpeedAU = Number(pending.warpSpeedAU) || 0;
  const group = {
    seq,
    atMs: nowMs(ctx),
    systemID,
    playerShipID,
    scene,
    session,
    shipIDs: new Set(),
    names: new Map(),
  };

  let issued = 0;
  for (const entry of crew) {
    const point = points.get(entry.characterID);
    const entity = entry.entity;
    if (!point || !entity) {
      continue;
    }
    if (isWarping(entity) && !entity.pendingWarp) {
      // 已经在飞了（上一段跃迁还没落地）：这一轮不抢它的控制权。
      log(ctx, `[warpfollow] ${entry.name} 跃迁中，跳过本轮对准`);
      continue;
    }
    const stopMining = ctx.options && ctx.options.stopMining;
    if (typeof stopMining === "function") {
      try {
        stopMining(scene, session, entry, entity);
      } catch (_error) {
        /* best effort：挖矿状态不影响跃迁本身 */
      }
    }
    const warpOptions = {forceImmediateStart: false};
    if (warpSpeedAU > 0) {
      warpOptions.warpSpeedAU = warpSpeedAU;
    }
    let warp = null;
    try {
      warp = deps.runtime.warpDynamicEntityToPoint(systemID, entity, point, warpOptions);
    } catch (error) {
      log(ctx, `[warpfollow] ${entry.name} 对准异常 ${error && error.message}`);
      continue;
    }
    if (!warp || warp.success !== true) {
      log(ctx, `[warpfollow] ${entry.name} 对准失败 ${warp && warp.errorMsg ? warp.errorMsg : ""}`);
      continue;
    }
    if (entity.pendingWarp && Number.isFinite(requestedAtMs)) {
      // 和玩家同一时刻起算准备条（激活仍由各自的对齐决定）。
      entity.pendingWarp.requestedAtMs = requestedAtMs;
    }
    entity.__nfWarpSeq = seq;
    group.shipIDs.add(Number(entry.shipID));
    group.names.set(Number(entry.shipID), entry.name);
    issued += 1;
  }

  if (issued === 0) {
    return;
  }
  ctx.group = group;
  log(ctx, `[warpfollow] 玩家开始准备跃迁 seq=${seq} · ${issued} 艘同刻对准`
    + `（requestedAt=${Math.round(requestedAtMs)} warpSpeed=${warpSpeedAU || "-"}AU/s` +
    `${pending.stopDistance ? ` stop=${Math.round(Number(pending.stopDistance))}m` : ""}）`);
  return group;
}

/** 观察真实玩家会话的跃迁命令。 */
function observe(ctx, deps, session, result) {
  if (!result || result.success !== true || result.redundant === true) {
    return;
  }
  if (!session || !session._space) {
    return;
  }
  if (session.__nfPseudoCrew === true) {
    return;
  }
  if (!isEnabled(ctx)) {
    return;
  }
  const pending = result.data;
  if (!pending || typeof pending !== "object") {
    return;
  }
  beginGroup(ctx, deps, session, pending, result);
}

function resolveContext(deps, session) {
  const accountID = accountOfSession(deps, session, 0);
  const exact = contexts.get(accountID);
  if (exact) {
    return exact;
  }
  // 单租户（或测试里没给 characterState）时只有一个上下文，直接用。
  return contexts.size === 1 ? contexts.values().next().value : null;
}

/**
 * 包玩家会话的跃迁命令。只做"看一眼"，不改变引擎返回值；船员命令由
 * warpDynamicEntityToPoint 走 sessionless 通道。
 */
function register(deps, options = {}) {
  if (!deps || !deps.runtime) {
    return {ok: false, reason: "NO_RUNTIME"};
  }
  const ctx = contextFor(options.accountID);
  ctx.options = options;
  ctx.deps = deps;
  if (hookedRuntimes.has(deps.runtime)) {
    return {ok: true, already: true};
  }
  for (const name of ["warpToPoint", "warpToEntity"]) {
    const original = deps.runtime[name];
    if (typeof original !== "function") {
      continue;
    }
    deps.runtime[name] = function nfCrewWarpHook(...args) {
      const result = original.apply(this, args);
      try {
        const session = args[0];
        const target = resolveContext(deps, session);
        if (target) {
          observe(target, deps, session, result);
        }
      } catch (error) {
        log(contexts.size === 1 ? contexts.values().next().value : null,
          `[warpfollow] 钩子异常 ${error && error.message}`);
      }
      return result;
    };
  }
  hookedRuntimes.add(deps.runtime);
  return {ok: true, installed: true};
}

function cancelCrew(ctx, deps, scene, entity, reason) {
  const name = (ctx.group && ctx.group.names.get(Number(entity.itemID))) || entity.itemID;
  entity.pendingWarp = null;
  entity.warpState = null;
  entity.sessionlessWarpIngress = null;
  entity.mode = "STOP";
  entity.speedFraction = 0;
  entity.velocity = {x: 0, y: 0, z: 0};
  entity.targetPoint = entity.position
    ? {x: entity.position.x, y: entity.position.y, z: entity.position.z}
    : {x: 0, y: 0, z: 0};
  entity.__nfWarpSeq = 0;
  try {
    if (typeof deps.runtime.stopDynamicEntity === "function") {
      // 先把 warp 字段清掉，stopShipEntity 才会走普通停止分支并广播 Stop 包
      // （它对"已起跳的 warp"是拒绝中止的）。
      deps.runtime.stopDynamicEntity(Number(scene.systemID) || 0, entity, {});
    }
  } catch (_error) {
    /* 停止失败不影响状态清理 */
  }
  log(ctx, `[warpfollow] ${name} 取消（${reason}）`);
}

/**
 * 每秒由 miningWatchTick 调用一次：玩家取消时收尾，并把整队的落地记一条日志。
 * 返回 {aligning, flying} 供调试面板使用。
 */
function tick(deps, scene, session) {
  const ctx = resolveContext(deps, session);
  const group = ctx && ctx.group;
  if (!group) {
    return {};
  }
  if (group.scene !== scene || !scene || typeof scene.getEntityByID !== "function") {
    ctx.group = null;
    return {};
  }
  const playerEntity = group.playerShipID ? scene.getEntityByID(group.playerShipID) : null;
  const playerWarping = isWarping(playerEntity);
  let aligning = 0;
  let flying = 0;
  let landed = 0;
  const toCancel = [];
  for (const shipID of group.shipIDs) {
    const entity = scene.getEntityByID(shipID);
    if (!entity) {
      continue;
    }
    if (!isWarping(entity)) {
      if (entity.__nfWarpSeq === group.seq) {
        entity.__nfWarpSeq = 0;
        landed += 1;
      }
      continue;
    }
    if (entity.pendingWarp) {
      aligning += 1;
      if (!playerWarping) {
        toCancel.push(entity);
      }
      continue;
    }
    // 已起跳：即使玩家取消也让它落地，空中硬停更像 bug。
    flying += 1;
  }
  for (const entity of toCancel) {
    cancelCrew(ctx, deps, scene, entity, "玩家取消跃迁");
    aligning -= 1;
  }
  if (!playerWarping && aligning === 0 && flying === 0) {
    log(ctx, `[warpfollow] seq=${group.seq} 结束（落地 ${landed} 艘）`);
    ctx.group = null;
  }
  return {aligning, flying, landed};
}

/** 玩家掉线/换船时外部可以强制收尾。 */
function reset(deps, accountID) {
  const ctx = contexts.get(Number(accountID) || 0);
  if (ctx) {
    ctx.group = null;
  }
}

function isActive() {
  for (const ctx of contexts.values()) {
    if (ctx.group) {
      return true;
    }
  }
  return false;
}

function __resetForTests() {
  formationTried = false;
  formationModule = null;
  contexts.clear();
}

module.exports = {
  register,
  tick,
  reset,
  isActive,
  __resetForTests,
};
