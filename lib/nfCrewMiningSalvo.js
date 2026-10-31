"use strict";

const path = require("node:path");
const geometry = require(path.join(__dirname, "nfCrewMiningGeometry.js"));
// 统一结算入口（apply → 记归属 → 打爆时入队 KM）。
const damageSettle = require(path.join(__dirname, "nfCrewMiningDamage.js"));
// 导弹/鱼雷的**零伤害**表现球（客户端靠它播发射/弹道/命中爆炸，伤害仍走齐射）。
const missileFx = require(path.join(__dirname, "nfCrewMiningMissileFx.js"));

// Player-style weapon settlement, aggregated: ONE shot calculation per weapon type, damage
// multiplied by the number of identical turrets, capacitor charged for every turret.
//
// Why: the engine's activation path recomputes the whole ship's derived attributes per module
// (measured 0.5-1.1 s), so activating eight turrets blocks the event loop for about a second
// per ship. This module keeps the player mechanics (lock, cycle time, charges, capacitor) but
// settles the volley in one go.

const DAMAGE_KEYS = ["em", "thermal", "kinetic", "explosive"];
// 与射程判定共用同一份 dogma 快照（避免一次交战建两次）。
const snapshotCache = require(path.join(__dirname, "nfCrewMiningSnapshotCache.js"));

/**
 * The engine exposes weapon settlement under `runtime.droneInterop` (that is where
 * resolveTurretShot / applyWeaponDamageToTarget / noteKillmailDamage live), while the
 * snapshot builder is exported by combat/weaponDogma. Accept both spellings.
 */
function engineApi(deps) {
  const runtime = (deps && deps.runtime) || {};
  const interop = runtime.droneInterop || {};
  const dogm = (deps && deps.weaponDogma) || {};
  const pick = (name) => (typeof runtime[name] === "function" ? runtime[name] : null)
    || (typeof interop[name] === "function" ? interop[name] : null)
    || (typeof dogm[name] === "function" ? dogm[name] : null);
  return {
    buildWeaponModuleSnapshot: pick("buildWeaponModuleSnapshot"),
    resolveTurretShot: pick("resolveTurretShot"),
    applyWeaponDamageToTarget: pick("applyWeaponDamageToTarget"),
    noteKillmailDamage: pick("noteKillmailDamage"),
    getAppliedDamageAmount: pick("getAppliedDamageAmount"),
    notifyWeaponDamageMessages: pick("notifyWeaponDamageMessages"),
    resolveWeaponSpecialFxGUID: pick("resolveWeaponSpecialFxGUID"),
    resolveWeaponFamily: pick("resolveWeaponFamily"),
    // 导弹：射程估算 + 命中后的实际伤害（含爆风半径/速度衰减）。
    missileSolver: (deps && deps.missileSolver) || null,
  };
}

/** 面杀伤武器（导弹族 / 沃顿 / 破舱者）：按导弹模型结算，不走炮台命中率。 */
function isAreaWeaponFamily(family) {
  const name = String(family || "");
  return name === "missileLauncher"
    || name === "vortonProjector"
    || name === "breacherPodLauncher"
    || name === "bombLauncher";
}

/** 两个实体表面之间的距离（和 combat 同一套公式；这里保持“缺位置 = 0”的老语义）。 */
function surfaceDistance(left, right) {
  return geometry.surfaceDistanceOrZero(left, right);
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function cloneDamage(source) {
  const output = {};
  for (const key of DAMAGE_KEYS) {
    const value = Number(source && source[key]);
    output[key] = Number.isFinite(value) && value > 0 ? value : 0;
  }
  return output;
}

function scaleDamage(damage, factor) {
  const output = {};
  for (const key of DAMAGE_KEYS) {
    output[key] = (Number(damage && damage[key]) || 0) * factor;
  }
  return output;
}

/** Group the resolved weapon modules by type so one turret represents its identical siblings. */
function groupByType(modules) {
  const groups = new Map();
  for (const entry of Array.isArray(modules) ? modules : []) {
    const moduleItem = entry && entry.moduleItem;
    const typeID = positive(moduleItem && moduleItem.typeID);
    if (!typeID) {
      continue;
    }
    if (!groups.has(typeID)) {
      groups.set(typeID, {typeID, members: [], rangeMeters: 0});
    }
    const group = groups.get(typeID);
    group.members.push(entry);
    group.rangeMeters = Math.max(group.rangeMeters, Number(entry.rangeMeters) || 0);
  }
  return [...groups.values()];
}

/** Build the engine snapshot for one representative turret of a group. */
function buildSnapshot(deps, request) {
  const api = engineApi(deps);
  const fitting = deps && deps.fitting;
  const itemStore = deps && deps.itemStore;
  if (!api.buildWeaponModuleSnapshot) {
    return {snapshot: null, reason: "NO_SNAPSHOT_API"};
  }
  const moduleItem = request.moduleItem;
  const flagID = Number(moduleItem && moduleItem.flagID) || 0;
  let shipItem = null;
  try {
    shipItem = itemStore && typeof itemStore.findShipItemById === "function"
      ? itemStore.findShipItemById(request.shipID)
      : null;
  } catch (_error) {
    shipItem = null;
  }
  if (!shipItem) {
    return {snapshot: null, reason: "NO_SHIP_ITEM"};
  }
  let fittedItems = [];
  try {
    fittedItems = typeof fitting.getFittedModuleItems === "function"
      ? fitting.getFittedModuleItems(request.characterID, request.shipID) || []
      : [];
  } catch (_error) {
    fittedItems = [];
  }
  let chargeItem = null;
  try {
    chargeItem = typeof fitting.getLoadedChargeByFlag === "function" && flagID > 0
      ? fitting.getLoadedChargeByFlag(request.characterID, request.shipID, flagID)
      : null;
  } catch (_error) {
    chargeItem = null;
  }
  let skillMap = null;
  try {
    const skills = deps.skillState;
    skillMap = skills && typeof skills.getCachedCharacterSkillMap === "function"
      ? skills.getCachedCharacterSkillMap(request.characterID)
      : null;
  } catch (_error) {
    skillMap = null;
  }
  // 关键：把「船上正在生效的模块」一起交给 dogma。
  // 会战/后勤/工业核心（组 515）对导弹射程、伤害的加成都是通过激活上下文施加的，
  // 不传这个参数就会算成「没吃加成」（用户实测：开着会战 61 km，mod 只算出 24 km）。
  let activeModuleContexts = null;
  const view = deps && deps.dogmaView;
  try {
    if (view && typeof view.getEntityRuntimeActiveModuleContexts === "function" && request.attackerEntity) {
      activeModuleContexts = view.getEntityRuntimeActiveModuleContexts(request.attackerEntity, {
        excludeModuleID: Number(moduleItem && moduleItem.itemID) || 0,
      });
    }
  } catch (_error) {
    activeModuleContexts = null;
  }
  const cacheRequest = {characterID: request.characterID, shipID: request.shipID, moduleItem, chargeItem};
  const cached = snapshotCache.get(cacheRequest);
  if (cached) {
    return {snapshot: cached, reason: null, chargeItem, cached: true};
  }
  const snapshot = api.buildWeaponModuleSnapshot({
    characterID: request.characterID,
    shipItem,
    moduleItem,
    chargeItem,
    fittedItems,
    skillMap,
    ...(Array.isArray(activeModuleContexts) && activeModuleContexts.length > 0
      ? {activeModuleContexts}
      : {}),
  });
  if (snapshot) {
    snapshotCache.set(cacheRequest, snapshot);
  }
  return {snapshot: snapshot || null, reason: snapshot ? null : "NO_SNAPSHOT", chargeItem};
}

/**
 * Fire one volley: every turret type fires once, damage is multiplied by the turret count and
 * the capacitor is charged for every turret.
 */
function fireVolley(deps, request = {}) {
  const api = engineApi(deps);
  const scene = request.scene;
  const attacker = request.attacker;
  const target = request.target;
  const groups = groupByType(request.modules);
  const nowMs = Number(request.nowMs) || Date.now();
  // 归因：齐射结算内部三步（快照 / 判定 / 结算）。名字挂在 combat.engage.volley.* 下，
  // 会出现在 `[perf] watch tick … combat=(…)` 的括号里。只在 watch tick 里传 steps 才有。
  const metrics = request.steps || null;
  const mark = (name, startedAt) => {
    if (!metrics) {
      return;
    }
    metrics[name] = (metrics[name] || 0) + (Date.now() - startedAt);
  };
  const result = {
    ok: false,
    groups: groups.length,
    turrets: 0,
    applied: 0,
    capacitor: 0,
    damage: {em: 0, thermal: 0, kinetic: 0, explosive: 0},
    problems: [],
    cycleMs: 0,
    fx: 0,
    // 这一轮实际发出去的零伤害导弹球（每组一枚）；missiles 是"算了几发"。
    launches: 0,
    // 这一轮要广播的发射特效（导弹/鱼雷各一组）：客户端靠它播发射动画。
    fxGroups: [],
    hit: false,
    // 这一轮判定为未命中的武器组数。全 miss 时 turrets 会是 0 且 problems 为空，
    // 上层原本只能写成"齐射失败（未知）"——那其实是打空了，不是故障。
    missed: 0,
    // 导弹/鱼雷这类面杀伤武器的发数，以及因为射程外主动放弃的组数。
    missiles: 0,
    outOfRange: 0,
    // 这一轮武器的最大射程（追击时用来决定靠近到多远）与目标距离（日志用）。
    rangeMeters: 0,
    distanceMeters: 0,
  };
  if (!api.resolveTurretShot || !api.applyWeaponDamageToTarget || !scene || !attacker || !target) {
    result.problems.push("BAD_ARGUMENTS");
    return result;
  }
  for (const group of groups) {
    const first = group.members[0];
    const count = group.members.length;
    const snapshotAt = Date.now();
    const built = buildSnapshot(deps, {
      characterID: request.characterID,
      shipID: request.shipID,
      moduleItem: first.moduleItem,
      attackerEntity: attacker,
    });
    mark("combat.engage.volley.snapshot", snapshotAt);
    const snapshot = built.snapshot;
    if (!snapshot) {
      result.problems.push(`SNAPSHOT_FAILED:${built.reason}`);
      continue;
    }
    result.cycleMs = Math.max(result.cycleMs, Number(snapshot.rateOfFire) || 0);
    result.rangeMeters = Math.max(Number(result.rangeMeters) || 0, Number(group.rangeMeters) || 0);
    const groupFamily = String(
      snapshot.family
        || (api.resolveWeaponFamily
          ? api.resolveWeaponFamily(first.moduleItem, built.chargeItem || null)
          : "")
        || "",
    );
    if (isAreaWeaponFamily(groupFamily)) {
      // 导弹/鱼雷：不发实体，直接用快照算这一轮伤害。
      // 射程按 maxVelocity × flightTime 估算，超了就不放（用户要求：射程外不开火）。
      const solver = api.missileSolver;
      const range = solver && typeof solver.estimateMissileEffectiveRange === "function"
        ? Number(solver.estimateMissileEffectiveRange(snapshot)) || 0
        : Number(snapshot.approxRange) || 0;
      result.rangeMeters = Math.max(Number(result.rangeMeters) || 0, range);
      const distance = surfaceDistance(attacker, target);
      result.distanceMeters = Math.max(Number(result.distanceMeters) || 0, distance);
      if (range > 0 && distance > range) {
        result.outOfRange += 1;
        result.problems.push(`OUT_OF_RANGE:${group.typeID}`);
        continue;
      }
      // 纯表现：这一组发一枚零伤害的导弹球。
      // 客户端只有在 AddBalls + LaunchMissile 收到 kind === "missile" 的球时才会播
      // 发射动作、弹道、命中爆炸和声音；只发 deployment 特效没有弹体可挂，等于看不见。
      // 伤害仍是下面的齐射结算——球命中时 applyWeaponDamageToTarget 收到全 0 会提前返回
      // （没有伤害、没有 KM、没有仇恨）。一个球带全组 launchModules：客户端仍让每门
      // 发射器开火，服务端只花一个实体。
      // **必须在伤害结算之前发**：这一轮如果把目标打爆了，launchMissile 会因为目标已死
      // 而拒发，致命那一发反而没有弹体。
      // 只有 missileLauncher 走这条：vorton 不是导弹，breacher/bomb 有各自的实体。
      if (groupFamily === "missileLauncher") {
        const launched = missileFx.launch(deps, {
          scene,
          attacker,
          target,
          snapshot: missileFx.buildCosmeticSnapshot(snapshot, distance),
          enabled: request.missileFx !== false,
          chargeItem: built.chargeItem || null,
          moduleItem: first.moduleItem,
          launchModules: group.members
            .map((member) => Number(member.moduleItem && member.moduleItem.itemID) || 0)
            .filter((itemID) => itemID > 0),
          // 引擎的计时是**模拟时间**，不是墙钟（nowMs 可能是 Date.now()）。
          launchTimeMs: scene && typeof scene.getCurrentSimTimeMs === "function"
            ? Number(scene.getCurrentSimTimeMs()) || 0
            : nowMs,
        });
        if (launched.ok) {
          result.launches += 1;
        } else if (launched.reason !== "DISABLED" && launched.reason !== "NO_API") {
          // 只是少一段画面，不能把一次命中判成失败（下面 result.ok 会忽略它）。
          result.problems.push(`MISSILE_FX:${launched.reason}`);
        }
      }
      let perShot = null;
      if (solver && typeof solver.resolveMissileAppliedDamage === "function") {
        try {
          const resolved = solver.resolveMissileAppliedDamage(snapshot, target);
          perShot = resolved && resolved.appliedDamage ? resolved.appliedDamage : null;
        } catch (_error) {
          perShot = null;
        }
      }
      if (!perShot) {
        // 没有结算器时退化成「满伤害」：宁可打得狠一点，也不要完全不开火。
        perShot = snapshot.rawShotDamage || snapshot.damage || null;
        if (!perShot) {
          result.problems.push(`MISSILE_NO_DAMAGE:${group.typeID}`);
          continue;
        }
        result.problems.push(`MISSILE_NO_SOLVER:${group.typeID}`);
      }
      const volley = scaleDamage(cloneDamage(perShot), count);
      // 统一结算：apply → 记伤害归属 → 打爆时入队 KM（漏了第三步就没有击杀报告）。
      const missileApplyAt = Date.now();
      const settled = damageSettle.applyDamage(deps, {
        scene,
        attacker,
        target,
        damage: volley,
        whenMs: nowMs,
        weaponSnapshot: snapshot,
        moduleItem: first.moduleItem,
        chargeItem: built.chargeItem || null,
        steps: metrics,
      });
      mark("combat.engage.volley.apply", missileApplyAt);
      result.hit = true;
      result.applied += settled.applied;
      for (const key of DAMAGE_KEYS) {
        result.damage[key] += volley[key];
      }
      result.turrets += count;
      result.missiles += count;
      result.capacitor += (Number(snapshot.capNeed) || 0) * count;
      // 发射器特效（MissileDeployment / TorpedoDeployment）：每门发射器一条，
      // 由上层用引擎的 buildMissileDeploymentSpecialFxOptions 广播。
      const fxGuid = typeof api.resolveWeaponSpecialFxGUID === "function"
        ? String(api.resolveWeaponSpecialFxGUID({
            family: groupFamily,
            moduleItem: first.moduleItem,
            chargeItem: built.chargeItem || null,
          }) || "")
        : "";
      if (fxGuid) {
        result.fxGroups.push({
          guid: fxGuid,
          moduleItem: first.moduleItem,
          modules: group.members.map((member) => member.moduleItem),
          chargeTypeID: Number(built.chargeItem && built.chargeItem.typeID) || null,
        });
        result.fx += 1;
      }
      continue;
    }
    const shotAt = Date.now();
    const shot = api.resolveTurretShot({
      attackerEntity: attacker,
      targetEntity: target,
      weaponSnapshot: snapshot,
    });
    mark("combat.engage.volley.resolve", shotAt);
    if (!shot || shot.hit !== true) {
      result.missed += 1;
      continue;
    }
    result.hit = true;
    const volley = scaleDamage(cloneDamage(shot.shotDamage), count);
    // 统一结算：apply → 记伤害归属 → 打爆时入队 KM（漏了第三步就没有击杀报告）。
    const applyAt = Date.now();
    const settled = damageSettle.applyDamage(deps, {
      scene,
      attacker,
      target,
      damage: volley,
      whenMs: nowMs,
      weaponSnapshot: snapshot,
      moduleItem: first.moduleItem,
      chargeItem: null,
      steps: metrics,
    });
    mark("combat.engage.volley.apply", applyAt);
    const appliedAmount = settled.applied;
    if (api.notifyWeaponDamageMessages) {
      try {
        api.notifyWeaponDamageMessages(attacker, target, first.moduleItem, shot.shotDamage, appliedAmount);
      } catch (_error) {
        /* cosmetic only */
      }
    }
    result.applied += appliedAmount;
    for (const key of DAMAGE_KEYS) {
      result.damage[key] += volley[key];
    }
    result.turrets += count;
    result.capacitor += (Number(snapshot.capNeed) || 0) * count;
    // One muzzle flash per turret, even though only one shot was calculated. The engine
    // resolves the FX guid from the weapon family + module + charge, not from the snapshot.
    if (scene && typeof scene.broadcastSpecialFx === "function") {
      let guid = String(snapshot.effectGUID || snapshot.specialFxGuid || "").trim();
      if (!guid && api.resolveWeaponSpecialFxGUID) {
        try {
          const family = api.resolveWeaponFamily
            ? api.resolveWeaponFamily(first.moduleItem, built.chargeItem || null)
            : null;
          guid = String(api.resolveWeaponSpecialFxGUID({
            family,
            moduleItem: first.moduleItem,
            chargeItem: built.chargeItem || null,
            activationEffect: null,
          }) || "").trim();
        } catch (_error) {
          guid = "";
        }
      }
      if (guid) {
        for (const member of group.members) {
          try {
            scene.broadcastSpecialFx(
              attacker.itemID,
              guid,
              {
                moduleID: Number(member.moduleItem && member.moduleItem.itemID) || null,
                moduleTypeID: group.typeID,
                targetID: Number(target.itemID) || null,
                start: true,
                active: true,
                duration: Number(snapshot.chargeDurationMs) || Number(snapshot.rateOfFire) || 0,
              },
              attacker,
            );
            result.fx += 1;
          } catch (_error) {
            /* FX are best effort */
          }
        }
      } else {
        result.problems.push(`NO_FX_GUID:${group.typeID}`);
      }
    }
  }
  if (result.capacitor > 0 && deps.entityCapacitor && typeof deps.entityCapacitor.consumeEntityCapacitor === "function") {
    try {
      const before = typeof deps.entityCapacitor.getEntityCapacitorAmount === "function"
        ? deps.entityCapacitor.getEntityCapacitorAmount(attacker)
        : 0;
      const paid = deps.entityCapacitor.consumeEntityCapacitor(attacker, result.capacitor) !== false;
      if (!paid) {
        result.problems.push("NOT_ENOUGH_CAPACITOR");
      } else if (before > 0) {
        result.capacitorPaidRatio = (Number(attacker.capacitorChargeRatio) || 0);
      }
    } catch (error) {
      result.problems.push(`CAPACITOR_FAILED:${error && error.message}`);
    }
  }
  // NO_FX_GUID / MISSILE_FX 只是表现层缺一条特效或一枚弹体，不影响这一轮是否真的
  // 打中，不该把一次命中判成失败；SNAPSHOT_FAILED 同理属于"这组炮没参与"。
  result.ok = result.turrets > 0 &&
    result.problems.filter(
      (item) => !item.startsWith("SNAPSHOT")
        && !item.startsWith("NO_FX_GUID")
        && !item.startsWith("MISSILE_FX")
        && !item.startsWith("OUT_OF_RANGE")
        && !item.startsWith("MISSILE_NO_SOLVER"),
    ).length === 0;
  return result;
}

module.exports = {
  fireVolley,
  __clearSnapshotCache: () => snapshotCache.clear(),
  groupByType,
  scaleDamage,
  cloneDamage,
};
