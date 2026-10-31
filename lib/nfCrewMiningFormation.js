"use strict";

// B 模式：环形槽位 + 自写刹车。
//
// 引擎没有“停在某个点”的指令：GOTO 没有到达判定（全速朝点飞，到了就沿原朝向
// 继续飞），FOLLOW/ORBIT 都只能对着一个**实体**。所以要点跟随就必须自己闭环：
//   - 每 250 ms 重算一次槽位点（玩家位置 + 环形偏移）
//   - 距离 > 死区 → gotoPoint(槽位) + setSpeedFraction(按剩余距离算出的速度)
//   - 距离 <= 死区 → setSpeedFraction(0)，不再下发方向
// 速度上限按“一个 tick 不冲过死区”来压，这是防抖的关键。
//
// 这个模块只做纯计算，所有引擎调用留在 runtime 里，方便单测。

const path = require("node:path");
const geometry = require(path.join(__dirname, "nfCrewMiningGeometry.js"));

const DEFAULT_TICK_MS = 250;
const DEFAULT_DEADBAND_METERS = 20;
// 相邻两艘船的表面间隙低于这个值，说明这个环放不下这么多人，应退回阶梯。
const MIN_NEIGHBOUR_GAP_METERS = 30;

function finite(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

/** 表面间距 → 环的中心半径（引擎所有距离都是中心到中心）。 */
function ringCenterRadius(surfaceGap, playerRadius, selfRadius) {
  return Math.max(0, finite(surfaceGap))
    + Math.max(0, finite(playerRadius))
    + Math.max(0, finite(selfRadius));
}

function slotAngle(index, count, rotation = 0) {
  const total = Math.max(1, Math.trunc(finite(count, 1)));
  const slot = clamp(Math.trunc(finite(index, 0)), 0, total - 1);
  return (Math.PI * 2 * slot) / total + finite(rotation);
}

/** 槽位点：玩家位置（可选带速度前馈）在水平面上偏移 ringRadius。 */
function slotPoint(playerPosition, centerRadius, angle, lead = null) {
  const base = playerPosition || {x: 0, y: 0, z: 0};
  const ahead = lead
    ? {x: finite(lead.x), y: finite(lead.y), z: finite(lead.z)}
    : {x: 0, y: 0, z: 0};
  return {
    x: finite(base.x) + ahead.x + Math.cos(angle) * centerRadius,
    y: finite(base.y) + ahead.y,
    z: finite(base.z) + ahead.z + Math.sin(angle) * centerRadius,
  };
}

/** 同一环上相邻两艘的表面间隙（同半径、均匀分布时是常数）。 */
function neighbourGap(centerRadius, count, radiusA, radiusB) {
  const total = Math.max(1, Math.trunc(finite(count, 1)));
  if (total <= 1) {
    return Infinity;
  }
  const chord = 2 * Math.max(0, finite(centerRadius)) * Math.sin(Math.PI / total);
  return chord - (Math.max(0, finite(radiusA)) + Math.max(0, finite(radiusB)));
}

/**
 * 逼近速度：一个 tick 最多走完剩余距离，接近时按 1.5 s 到位收敛。
 * 返回 speedFraction（0..1）；0 表示该刹车。
 */
function approachFraction(distance, deadband, maxVelocity, tickMs = DEFAULT_TICK_MS) {
  const remaining = Math.max(0, finite(distance) - Math.max(0, finite(deadband)));
  if (remaining <= 0) {
    return 0;
  }
  const peak = Math.max(1, finite(maxVelocity, 1));
  const dt = Math.max(0.05, finite(tickMs, DEFAULT_TICK_MS) / 1000);
  const arriveIn = Math.max(0.2, Math.min(1.5, dt * 4));
  const speed = Math.min(peak, remaining / arriveIn, remaining / dt);
  return clamp(speed / peak, 0.02, 1);
}

function distanceBetween(left, right) {
  return geometry.centreDistance(left, right);
}

/**
 * 算一轮环形站位。
 * input = {
 *   player: {position, radius, velocity},
 *   crew: [{characterID, shipID, position, radius, maxVelocity}],
 *   surfaceGap, rotation, tickMs, deadband, leadSeconds
 * }
 * 返回 {ok, reason?, slots:[{characterID, shipID, point, distance, fraction, action}]}
 */
function planRingStep(input = {}) {
  const crew = Array.isArray(input.crew) ? input.crew.filter(Boolean) : [];
  if (crew.length === 0) {
    return {ok: false, reason: "NO_CREW", slots: []};
  }
  const player = input.player;
  if (!player || !player.position) {
    return {ok: false, reason: "NO_PLAYER", slots: []};
  }
  const surfaceGap = Math.max(0, finite(input.surfaceGap));
  const tickMs = Math.max(50, finite(input.tickMs, DEFAULT_TICK_MS));
  const deadband = Math.max(1, finite(input.deadband, DEFAULT_DEADBAND_METERS));
  const rotation = finite(input.rotation);
  const leadSeconds = Math.max(0, finite(input.leadSeconds));

  const lead = player.velocity
    ? {
      x: finite(player.velocity.x) * leadSeconds,
      y: finite(player.velocity.y) * leadSeconds,
      z: finite(player.velocity.z) * leadSeconds,
    }
    : null;

  const slots = [];
  let tightest = Infinity;
  // 人太多 / 船太大时，固定半径上相邻两艘会重叠。这时把环整体放大到"相邻刚好
  // 留出 MIN_NEIGHBOUR_GAP"的最小半径——保持环形（大家同一圈），只是不再等于 X。
  let minimumRadius = 0;
  if (crew.length > 1) {
    const widest = crew.reduce((max, member) => Math.max(max, finite(member && member.radius)), 0);
    minimumRadius = (MIN_NEIGHBOUR_GAP_METERS + (2 * widest)) / (2 * Math.sin(Math.PI / crew.length));
  }
  for (let index = 0; index < crew.length; index += 1) {
    const member = crew[index];
    const naturalRadius = ringCenterRadius(surfaceGap, player.radius, member.radius);
    const centerRadius = Math.max(naturalRadius, minimumRadius);
    const angle = slotAngle(index, crew.length, rotation);
    const point = slotPoint(player.position, centerRadius, angle, lead);
    const distance = distanceBetween(member.position, point);
    const fraction = approachFraction(distance, deadband, member.maxVelocity, tickMs);
    slots.push({
      characterID: Number(member.characterID) || 0,
      shipID: Number(member.shipID) || 0,
      point,
      centerRadius,
      distance,
      fraction,
      action: fraction > 0 ? "goto" : "stop",
    });
    if (crew.length > 1) {
      const other = crew[(index + 1) % crew.length];
      tightest = Math.min(tightest, neighbourGap(centerRadius, crew.length, member.radius, other && other.radius));
    }
  }

  return {
    ok: true,
    // extended = 为了不重叠把环放大了（此时离玩家的距离大于 X）。
    extended: minimumRadius > 0 && minimumRadius > ringCenterRadius(surfaceGap, player.radius, 0),
    tightestGap: Number.isFinite(tightest) ? Math.round(tightest) : null,
    slots,
  };
}

/**
 * 环形模式的执行器：每 250 ms 把所有在役船员推向自己的槽位。
 *
 * 控制器自己持有“上次下发的方向/速度/位置”，runtime 不再需要 ringState 之类的 Map。
 * ctx = {
 *   formationMode()                       → "ladder" | "ring"
 *   surfaceGap()                          → 表面间距（null = 没配置）
 *   pool()                                → 池子数组
 *   sceneFor(session)                     → 场景
 *   isBusy(scene, entity, characterID)    → true = 这艘船现在不归环形管
 *   shareSession(session, characterID, entity) → 能直接喂给 scene.* 的 session
 *   goto(scene, callSession, point) / setSpeed(scene, callSession, fraction)
 *   now() / log()
 * }
 */
function createRingController(ctx) {
  const state = new Map(); // characterID -> {fraction, at, point}
  let warnAt = 0;
  const now = typeof ctx.now === "function" ? ctx.now : () => Date.now();
  const log = typeof ctx.log === "function" ? ctx.log : () => {};

  function tick(session) {
    if (ctx.formationMode() !== "ring") {
      if (state.size > 0) {
        state.clear();
      }
      return;
    }
    if (!session) {
      return;
    }
    const scene = ctx.sceneFor(session);
    if (!scene || typeof scene.getEntityByID !== "function") {
      return;
    }
    const playerEntity = scene.getEntityByID(Number(session._space && session._space.shipID) || 0);
    if (!playerEntity || !playerEntity.position) {
      return;
    }
    const gap = ctx.surfaceGap();
    if (gap === null) {
      return; // 环形必须有一个基准间距（followDistance）
    }
    const crew = [];
    for (const entry of ctx.pool() || []) {
      if (!entry || entry.summoned !== true) {
        continue;
      }
      const entity = scene.getEntityByID(entry.shipID);
      if (!entity || !entity.position) {
        continue;
      }
      const characterID = Number(entry.characterID) || 0;
      if (ctx.isBusy(scene, entity, characterID)) {
        continue; // 跃迁中 / 挖矿 / 追击 / 堡垒模式：不抢控制权
      }
      crew.push({
        characterID,
        shipID: Number(entry.shipID) || 0,
        position: entity.position,
        radius: entity.radius,
        maxVelocity: entity.maxVelocity,
        entity,
      });
    }
    if (crew.length === 0) {
      return;
    }
    let plan = null;
    try {
      plan = planRingStep({
        player: playerEntity,
        crew,
        surfaceGap: gap,
        tickMs: DEFAULT_TICK_MS,
        deadband: DEFAULT_DEADBAND_METERS,
        leadSeconds: 0.5,
      });
    } catch (error) {
      log(`[ring] 规划失败 ${error && error.message}`);
      return;
    }
    if (!plan || plan.ok !== true) {
      return;
    }
    if (plan.extended && now() - warnAt > 30000) {
      warnAt = now();
      log(`[ring] 人太多/船太大，环半径临时放大到 ${Math.round(plan.slots[0].centerRadius)} m`
        + `（相邻 ${plan.tightestGap} m）`);
    }
    for (const slot of plan.slots) {
      applySlot(scene, session, crew, slot);
    }
  }

  function applySlot(scene, session, crew, slot) {
    const member = crew.find((row) => row.shipID === slot.shipID);
    if (!member) {
      return;
    }
    const entity = member.entity;
    const callSession = ctx.shareSession(session, member.characterID, entity);
    const prev = state.get(member.characterID) || {fraction: -1, at: 0, point: null};
    if (slot.action === "stop") {
      if (prev.fraction !== 0) {
        try {
          ctx.setSpeed(scene, callSession, 0);
        } catch (_error) {
          /* 停不下来下一拍再试 */
        }
        state.set(member.characterID, {fraction: 0, at: now(), point: slot.point});
      }
      return;
    }
    const moved = !prev.point || distanceBetween(prev.point, slot.point) > 15;
    const changed = Math.abs(Number(prev.fraction) - slot.fraction) > 0.1;
    if (!moved && !changed && now() - (Number(prev.at) || 0) < 1000) {
      return;
    }
    try {
      // 顺序很重要：mode=STOP 或 speed=0 时 gotoPoint 会把速度重置成 1，
      // 所以先下方向，再用 setSpeedFraction 把速度压回来。
      ctx.goto(scene, callSession, slot.point);
      ctx.setSpeed(scene, callSession, slot.fraction);
      state.set(member.characterID, {fraction: slot.fraction, at: now(), point: slot.point});
    } catch (error) {
      log(`[ring] 下发失败 ${error && error.message}`);
    }
  }

  function reset() {
    state.clear();
  }

  return {tick, reset};
}

module.exports = {
  DEFAULT_TICK_MS,
  DEFAULT_DEADBAND_METERS,
  MIN_NEIGHBOUR_GAP_METERS,
  ringCenterRadius,
  slotAngle,
  slotPoint,
  neighbourGap,
  approachFraction,
  distanceBetween,
  planRingStep,
  createRingController,
};
