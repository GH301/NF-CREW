"use strict";

// M3: following the player.
//
// Same system for now (`runtime.followDynamicEntity`); the gate/transit state
// machine that carries the crew between systems is M6. Keeping the follower
// inside this range is also what keeps it inside the player's compression
// bubble later (PLAN.md §5.3).

const path = require("node:path");

const DEFAULT_RANGE_METERS = 0;

function sceneFor(deps, session) {
  if (!deps.runtime || typeof deps.runtime.getSceneForSession !== "function") {
    return null;
  }
  try {
    return deps.runtime.getSceneForSession(session) || null;
  } catch (_error) {
    return null;
  }
}

/** Start following the player's ship. Returns {ok, rangeMeters, problems}. */
function follow(deps, request = {}) {
  const problems = [];
  const followerShipID = Number(request.followerShipID) || 0;
  const leaderShipID = Number(request.leaderShipID) || 0;
  const rangeMeters = Math.max(0, Number(request.rangeMeters) || DEFAULT_RANGE_METERS);
  if (!followerShipID || !leaderShipID) {
    return {ok: false, problems: ["BAD_FOLLOW_REQUEST"]};
  }
  if (!deps.runtime || typeof deps.runtime.followDynamicEntity !== "function") {
    return {ok: false, problems: ["NO_FOLLOW_API"]};
  }
  const sceneDescriptor = request.sceneDescriptor || Number(request.systemID) || 0;

  // The dispatch only answers true/false, so resolve the two entities first and
  // report exactly which precondition is missing when it refuses.
  const scene = request.scene || sceneFor(deps, request.session);
  const follower = scene && typeof scene.getEntityByID === "function"
    ? scene.getEntityByID(followerShipID)
    : null;
  const target = scene && typeof scene.getEntityByID === "function"
    ? scene.getEntityByID(leaderShipID)
    : null;
  if (!scene) {
    return {ok: false, problems: ["FOLLOW_NO_SCENE"]};
  }
  if (!follower) {
    return {ok: false, problems: [`FOLLOW_NO_FOLLOWER_ENTITY:${followerShipID}`]};
  }
  if (!target) {
    return {ok: false, problems: [`FOLLOW_NO_TARGET_ENTITY:${leaderShipID}`]};
  }
  const diagnostics = {
    mode: String(follower.mode || ""),
    bubble: follower.bubbleID ?? follower.gridID ?? null,
    targetBubble: target.bubbleID ?? target.gridID ?? null,
    pendingDock: follower.pendingDock === true,
  };

  let result = null;
  try {
    // Pass the entity object: the dispatch accepts either, and this cannot fail
    // on a look-up we already did.
    result = deps.runtime.followDynamicEntity(
      sceneDescriptor,
      follower,
      leaderShipID,
      rangeMeters,
      {broadcast: true},
    );
  } catch (error) {
    return {ok: false, problems: [`FOLLOW_FAILED:${error && error.message}`], diagnostics};
  }
  const ok = result === true || Boolean(result && result.success === true);
  if (!ok) {
    problems.push(
      `FOLLOW_REFUSED:${typeof result === "object" ? JSON.stringify(result) : String(result)}` +
      `(mode=${diagnostics.mode} bubble=${diagnostics.bubble}/${diagnostics.targetBubble}` +
      `${diagnostics.pendingDock ? " pendingDock" : ""})`,
    );
    // Falling back to "orbit the player" keeps the crew in the same bubble (and
    // therefore inside the compression range) even when the follow command is
    // refused for a reason we cannot see from here. The request is a surface gap,
    // so the orbit distance carries the same value (the engine adds both radii).
    if (typeof deps.runtime.orbitDynamicEntity === "function") {
      try {
        const orbit = deps.runtime.orbitDynamicEntity(
          sceneDescriptor,
          follower,
          leaderShipID,
          Math.max(0, Math.round(rangeMeters)),
          {broadcast: true},
        );
        if (orbit === true || Boolean(orbit && orbit.success === true)) {
          return {ok: true, rangeMeters, mode: "orbit", problems, diagnostics};
        }
      } catch (error) {
        problems.push(`ORBIT_FALLBACK_FAILED:${error && error.message}`);
      }
    }
    return {ok: false, problems, diagnostics};
  }
  return {ok, rangeMeters, mode: "follow", problems, diagnostics};
}

/** Where the ship currently is, from the live scene. */
function locate(deps, request = {}) {
  const scene = request.scene || sceneFor(deps, request.session);
  const shipID = Number(request.shipID) || 0;
  const entity = scene && typeof scene.getEntityByID === "function"
    ? scene.getEntityByID(shipID)
    : null;
  return {
    ok: Boolean(entity),
    scene,
    entity,
    sceneDescriptor: (scene && scene.sceneDescriptor) || Number(request.systemID) || 0,
  };
}

/** 稳定槽位：按 characterID 排序，保证同一艘船每次都分到同一个位置。 */
function formationSlotIndex(member, summoned) {
  const ids = (summoned || [])
    .map((entry) => Number(entry.characterID) || 0)
    .filter((id) => id > 0)
    .sort((left, right) => left - right);
  const index = ids.indexOf(Number(member && member.characterID) || 0);
  return index < 0 ? 0 : index;
}

/**
 * 一名船员该保持的“距离”参数：配了表面间距就用它（所有人同值），
 * 否则退回分层环绕（100/200/300/400/500 m）。
 */
/**
 * 一名船员该保持的「表面距离」。
 * 0.6.8 起：有间距就用 `gap + slot × spacing`（走 FOLLOW，无 500 m 下限）；
 * 没间距（未配置）→ 退回调用方给的 baseRange（召回等显式命令用），不再有"分层环绕"。
 */
function formationRangeFor(member, summoned, baseRange, surfaceGap, spacingMeters) {
  if (surfaceGap === null || surfaceGap === undefined) {
    return Math.max(0, Number(baseRange) || 0);
  }
  const slot = formationSlotIndex(member, summoned);
  const spacing = Math.max(0, Number(spacingMeters) || 0);
  return Math.max(0, Math.trunc(Number(surfaceGap) || 0)) + slot * spacing;
}

/**
 * 跟随姿态的“重新下令”器（原 runtime 的 rearmFollow）。
 *
 * 节流状态（谁在什么时候被下过什么距离）在它内部，runtime 不再持有这两个 Map。
 * ctx = {
 *   gap()                     → 表面间距，null = 没配置
 *   formation()               → "idle" | "follow" | "ladder" | "ring"
 *   spacing()                 → 船员之间的表面间距
 *   configFor(blueprintID)    → 蓝图（取 followRangeMeters）
 *   isMiningAtRock(scene, characterID, entity)
 *   isChasing(characterID)
 *   isModeActive(entity)      → 堡垒/会战被引擎钉住
 *   followFn(request)         → 引擎 FOLLOW
 *   surface(entity, other)    → 表面距离
 *   orbitDynamic(scene, entity, targetID, range) / orbitScene(scene, entity, targetID, range)
 *   blockers(entity, playerEntity) → 诊断串
 *   log(line) / now()
 * }
 */
function createRearmer(ctx) {
  const lastAt = new Map();      // characterID -> ms
  const lastRange = new Map();   // characterID -> 上次下发的距离
  const log = typeof ctx.log === "function" ? ctx.log : () => {};
  const now = typeof ctx.now === "function" ? ctx.now : () => Date.now();

  function rearm(scene, session, summoned, playerEntity) {
    if (!scene || !playerEntity || typeof scene.getEntityByID !== "function") {
      return;
    }
    const playerShipID = Number(playerEntity.itemID) || 0;
    if (!playerShipID) {
      return;
    }
    const formationMode = typeof ctx.formation === "function" ? String(ctx.formation()) : "ladder";
    // 0.6.8：**没有默认行动** —— idle 一条指令都不下发（召唤落地后静止等命令）。
    // 环形由 250 ms 的环形控制器接管，这里也不能发，否则两条指令互相抢 entity.mode。
    // 0.6.12：follow（跟随）和 ladder（阶梯）都走引擎 FOLLOW，区别只在站位怎么算：
    //   跟随 = 所有人同一个 gap（不递增）；阶梯 = gap + 序号 × spacing。
    if (formationMode !== "ladder" && formationMode !== "follow") {
      return;
    }
    const isFollow = formationMode === "follow";
    const gap = ctx.gap();
    if (gap === null) {
      // 跟随/阶梯都必须有基准间距；没设就什么都不做，不静默降级成别的行为。
      warnMissingGap(isFollow);
      return;
    }
    const spacing = Math.max(0, Number(ctx.spacing()) || 0);
    for (const entry of summoned) {
      const characterID = Number(entry.characterID);
      const entity = scene.getEntityByID(entry.shipID);
      if (!entity) {
        continue;
      }
      const mode = String(entity.mode || "").toUpperCase();
      if (mode === "WARP") {
        continue; // in flight: follow is issued when it lands
      }
      if (ctx.isMiningAtRock(scene, characterID, entity)) {
        continue; // holding at the rock on purpose
      }
      // 正在追击（打不到所以主动靠近）：不要把它拉回玩家环，否则会来回拉扯。
      if (ctx.isChasing(characterID)) {
        continue;
      }
      // 会战/堡垒模式下船被引擎钉住，任何跟随指令都会被拒 —— 不要每秒撞一次。
      if (ctx.isModeActive(entity)) {
        continue;
      }
      const slot = formationSlotIndex(entry, summoned);
      // 跟随：所有人同一个间距；阶梯：按序号依次外扩。
      const standoff = isFollow ? gap : gap + slot * spacing;
      const inFollow = mode === "FOLLOW" && Number(entity.targetEntityID) === playerShipID;
      if (inFollow && lastRange.get(characterID) === standoff) {
        continue;
      }
      if (now() - (Number(lastAt.get(characterID)) || 0) < 5000) {
        continue;
      }
      lastAt.set(characterID, now());
      lastRange.set(characterID, standoff);
      // 引擎 FOLLOW：desiredRange = followRange + r1 + r2，**没有 500 m 下限**，
      // 所以 gap < 500 会真的生效（旧的"分层环绕"走 ORBIT 才会被抬到 500，已随 idle 一起移除）。
      const followed = ctx.followFn({
        session,
        scene,
        systemID: Number(scene.systemID) || 0,
        followerShipID: entry.shipID,
        leaderShipID: playerShipID,
        rangeMeters: standoff,
      });
      const actual = entity.position && playerEntity.position
        ? Math.round(ctx.surface(entity, playerEntity))
        : null;
      log(`[follow] ${entry.name} 保持表面距 ${standoff}m（${isFollow ? "跟随" : `第 ${slot + 1} 位`}，`
        + `当前 ${actual === null ? "?" : `${actual}m`}）`
        + ` → ${followed.ok ? "ok" : followed.problems.join(" ")}`);
    }
  }

  // 跟随/阶梯缺间距时提示一次（60 s 内不重复），别每秒刷屏。
  let missingGapWarnAt = 0;
  function warnMissingGap(isFollow) {
    if (now() - missingGapWarnAt < 60000) {
      return;
    }
    missingGapWarnAt = now();
    log(`[follow] ${isFollow ? "跟随" : "阶梯"}阵型缺少间距（未设置 followDistance）→ 不下发跟随；`
      + "先 /crewmine follow <米> 或面板设置间距");
  }
  /** 追击结束/返回环绕时清掉节流，让下一拍立刻重新下令。 */
  function forget(characterID) {
    lastAt.delete(Number(characterID));
    lastRange.delete(Number(characterID));
  }

  function clear() {
    lastAt.clear();
    lastRange.clear();
  }

  return {rearm, forget, clear};
}

module.exports = {
  DEFAULT_RANGE_METERS,
  follow,
  locate,
  sceneFor,
  formationSlotIndex,
  formationRangeFor,
  createRearmer,
};
