"use strict";

// Plan B for doomsday weapons: no fuel, no capacitor, cooldown only.
// Damage and radius come from the fitted module's dogma attributes, so the blueprint still
// decides how hard it hits.

const path = require("node:path");
// 统一结算入口（apply → 记归属 → 打爆时入队 KM）。
const damageSettle = require(path.join(__dirname, "nfCrewMiningDamage.js"));

const DOOMSDAY_GROUP_ID = 588;
const ATTR_EM_DAMAGE = 114;
const ATTR_EXPLOSIVE_DAMAGE = 116;
const ATTR_KINETIC_DAMAGE = 117;
const ATTR_THERMAL_DAMAGE = 118;
const ATTR_AOE_RADIUS = 2146;
const ATTR_AOE_RANGE = 2279;
const ATTR_RADIUS = 73;
const ATTR_DURATION = 73;
const ATTR_CONSUMPTION_TYPE = 713;
const ATTR_CONSUMPTION_QUANTITY = 714;

// Mirrors superweaponRuntime: the client times the doomsday animation from these values.
const SUPERWEAPON_FX_META = Object.freeze({
  "effects.SuperWeaponAmarr": {durationMs: 10000, leadInMs: 6000, startActive: false},
  "effects.SuperWeaponCaldari": {durationMs: 10000, leadInMs: 0, startActive: false},
  "effects.SuperWeaponGallente": {durationMs: 10000, leadInMs: 0, startActive: false},
  "effects.SuperWeaponMinmatar": {durationMs: 10000, leadInMs: 3000, startActive: false},
});

// SDE default effect of each doomsday module (needed by activateGenericModule).
const DOOMSDAY_EFFECT_BY_TYPE = new Map([
  [24550, "superWeaponAmarr"],
  [24552, "superWeaponCaldari"],
  [24554, "superWeaponGallente"],
  [23674, "superWeaponMinmatar"],
]);

const FX_BY_RACE_HULL = new Map([
  [11567, "effects.SuperWeaponAmarr"],
  [3764, "effects.SuperWeaponCaldari"],
  [671, "effects.SuperWeaponGallente"],
  [23773, "effects.SuperWeaponMinmatar"],
]);

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/** Find the doomsday module (group 588) in the ship's fitting. */
function findDoomsdayModules(deps, request = {}) {
  const fitting = deps && deps.fitting;
  if (!fitting || typeof fitting.getFittedModuleItems !== "function") {
    return [];
  }
  let items = [];
  try {
    items = fitting.getFittedModuleItems(request.characterID, request.shipID) || [];
  } catch (_error) {
    items = [];
  }
  return items.filter((item) => item && Number(item.groupID) === DOOMSDAY_GROUP_ID);
}

/** Read the module's own damage vector / radius from the SDE dogma attributes. */
function doomsdayProfile(deps, moduleItem) {
  const sde = deps && deps.sde;
  const typeID = positive(moduleItem && moduleItem.typeID);
  const profile = {
    typeID,
    name: String((moduleItem && moduleItem.itemName) || ""),
    moduleID: positive(moduleItem && moduleItem.itemID),
    damage: {em: 0, thermal: 0, kinetic: 0, explosive: 0},
    radiusMeters: 0,
    fxGuid: "",
    fuelTypeID: 0,
    fuelPerActivation: 0,
    effectName: "",
    durationMs: 0,
  };
  if (!sde || typeID <= 0 || typeof sde.loadDogmaAttributes !== "function") {
    return profile;
  }
  let attributes = null;
  try {
    attributes = sde.loadDogmaAttributes([typeID]).get(typeID) || null;
  } catch (_error) {
    attributes = null;
  }
  if (!attributes) {
    return profile;
  }
  const read = (id) => positive(attributes.get(Number(id)));
  profile.damage = {
    em: read(ATTR_EM_DAMAGE),
    thermal: read(ATTR_THERMAL_DAMAGE),
    kinetic: read(ATTR_KINETIC_DAMAGE),
    explosive: read(ATTR_EXPLOSIVE_DAMAGE),
  };
  profile.radiusMeters = read(ATTR_AOE_RADIUS) || read(ATTR_AOE_RANGE) || read(ATTR_RADIUS);
  profile.fuelTypeID = read(ATTR_CONSUMPTION_TYPE);
  profile.fuelPerActivation = read(ATTR_CONSUMPTION_QUANTITY);
  profile.effectName = DOOMSDAY_EFFECT_BY_TYPE.get(typeID) || "";
  profile.durationMs = read(ATTR_DURATION);
  return profile;
}

function totalDamage(damage) {
  return ["em", "thermal", "kinetic", "explosive"]
    .reduce((sum, key) => sum + (Number(damage && damage[key]) || 0), 0);
}

/**
 * Ships a doomsday may hit, within radius of the titan.
 *
 * Native NPC ships are always eligible. Everything else (player ships, including
 * a war-declared opponent) needs an explicit policy: `accept` is the same
 * predicate the turrets already use (nfCrewMiningCombat.isHostileShip). Without
 * it this used to drop every player ship, so a crew whose turrets were firing at
 * a war target could never point its doomsday at it.
 */
function hostilesInRange(scene, sourceEntity, radiusMeters, excludeIDs, accept) {
  if (!scene || !sourceEntity) {
    return [];
  }
  let candidates = [];
  try {
    candidates = typeof scene.getDynamicEntities === "function"
      ? scene.getDynamicEntities() || []
      : [];
  } catch (_error) {
    candidates = [];
  }
  const result = [];
  for (const entity of candidates) {
    if (!entity || entity.kind !== "ship") {
      continue;
    }
    const isNativeNpc = entity.nativeNpc === true;
    const isAccepted = typeof accept === "function" && accept(entity) === true;
    if (!isNativeNpc && !isAccepted) {
      continue;
    }
    const id = positive(entity.itemID);
    if (!id || (excludeIDs && excludeIDs.has(id))) {
      continue;
    }
    if (String(entity.mode || "").toUpperCase() === "WARP") {
      continue;
    }
    const other = entity.position || {};
    const self = sourceEntity.position || {};
    const distance = Math.hypot(
      (Number(other.x) || 0) - (Number(self.x) || 0),
      (Number(other.y) || 0) - (Number(self.y) || 0),
      (Number(other.z) || 0) - (Number(self.z) || 0),
    );
    if (radiusMeters > 0 && distance > radiusMeters) {
      continue;
    }
    result.push({entity, distance});
  }
  result.sort((left, right) => left.distance - right.distance);
  return result;
}

/**
 * Fire one doomsday: every eligible ship in radius takes the module's damage
 * vector. No fuel, no capacitor (Plan B), and the FX guid is broadcast once,
 * aimed at the target it actually damaged.
 *
 * request.accept            same eligibility predicate the turrets use; without
 *                           it only native NPC ships are eligible.
 * request.preferredTargetID the target the crew is already shooting, hoisted to
 *                           the front so the beam lands on it (and not on whatever
 *                           happens to be nearest).
 */
function fireDoomsday(deps, request = {}) {
  // 结算统一走 nfCrewMiningDamage：apply → 记伤害归属 → 打爆时入队 KM。
  // 以前只做到前两步，于是末日打死人也不产生击杀报告。
  const scene = request.scene;
  const attacker = request.attacker;
  const moduleItem = request.moduleItem;
  const profile = request.profile || doomsdayProfile(deps, moduleItem);
  const radius = positive(request.radiusMeters) || profile.radiusMeters || 300000;
  const result = {
    ok: false,
    targets: 0,
    applied: 0,
    radiusMeters: radius,
    damage: profile.damage,
    problems: [],
  };
  if (!scene || !attacker || !moduleItem) {
    result.problems.push("BAD_ARGUMENTS");
    return result;
  }
  if (totalDamage(profile.damage) <= 0) {
    result.problems.push("NO_DAMAGE_ATTRIBUTES");
    return result;
  }
  if (!damageSettle.api(deps).applyDamage) {
    result.problems.push("NO_DAMAGE_API");
    return result;
  }
  const exclude = request.excludeIDs instanceof Set ? request.excludeIDs : new Set();
  exclude.add(positive(attacker.itemID));
  const targets = hostilesInRange(scene, attacker, radius, exclude, request.accept);
  const preferredTargetID = positive(request.preferredTargetID);
  if (preferredTargetID > 0) {
    const preferredIndex = targets.findIndex(
      (entry) => positive(entry.entity && entry.entity.itemID) === preferredTargetID,
    );
    if (preferredIndex > 0) {
      const [preferredEntry] = targets.splice(preferredIndex, 1);
      targets.unshift(preferredEntry);
    }
  }
  for (const entry of targets) {
    const settled = damageSettle.applyDamage(deps, {
      scene,
      attacker,
      target: entry.entity,
      damage: profile.damage,
      whenMs: request.nowMs || Date.now(),
      options: {
        damageSource: "superweapon_doomsday",
        superweaponFamily: "doomsday",
      },
      moduleItem,
    });
    result.applied += settled.applied;
    result.targets += 1;
  }
  const guid = String(profile.fxGuid || "").trim();
  const firstTarget = targets.length > 0 ? targets[0].entity : null;
  const firstTargetID = Number(firstTarget && firstTarget.itemID) || 0;
  // 没有目标就不要广播特效：客户端 superWeapon.Start 会拿到 targetBall=None，
  // 然后 GetVectorAt 抛 AttributeError，玩家看到的就是"发射失败、没动画"。
  if (guid && firstTargetID > 0) {
    const meta = SUPERWEAPON_FX_META[guid] || {durationMs: 10000, leadInMs: 0, startActive: false};
    // 引擎的 effectState 必须带 superweaponEffect/superweaponFamily/primaryTargetID，
    // 否则 resolveSuperweaponFxTargetID 返回 0，客户端拿不到末日动画的目标。
    const effectState = {
      guid,
      moduleID: profile.moduleID || 0,
      typeID: profile.typeID || 0,
      superweaponEffect: true,
      superweaponFamily: "doomsday",
      superweaponPrimaryTargetID: firstTargetID,
      superweaponFxDurationMs: meta.durationMs,
      superweaponFxLeadInMs: meta.leadInMs,
      superweaponFxStartActive: meta.startActive === true,
    };
    const fxApi = deps && deps.superweaponRuntime;
    let sent = false;
    // 引擎的广播会补上 isOffensive / FILETIME startTime / 历史时间轴参数；
    // 少了这些客户端会直接丢掉这条末日特效。
    if (fxApi && typeof fxApi.broadcastSuperweaponFxForTesting === "function") {
      try {
        sent = fxApi.broadcastSuperweaponFxForTesting(
          scene,
          attacker,
          effectState,
          firstTargetID,
          Number(request.nowMs) || Date.now(),
        ) !== false;
      } catch (_error) {
        sent = false;
      }
    }
    if (!sent && typeof scene.broadcastSpecialFx === "function") {
      try {
        scene.broadcastSpecialFx(attacker.itemID, guid, {
          moduleID: effectState.moduleID || null,
          moduleTypeID: effectState.typeID || null,
          targetID: firstTargetID,
          isOffensive: true,
          start: true,
          active: true,
          duration: effectState.superweaponFxDurationMs,
        }, attacker);
        sent = true;
      } catch (_error) {
        sent = false;
      }
    }
    if (!sent) {
      result.problems.push("FX_FAILED");
    }
  }
  result.firstTargetID = firstTargetID;
  result.ok = result.targets > 0;
  if (!result.ok) {
    result.problems.push("NO_TARGET_IN_RANGE");
  }
  return result;
}

/**
 * 末日候选目标（半径内的合法目标，排除自己）。
 * accept 与炮台同源：null 时只打原生 NPC；传入策略时，策略放行的玩家船（宣战目标）
 * 也可以被选中。
 */
function findDoomsdayTargets(scene, sourceEntity, radiusMeters, accept) {
  const radius = positive(radiusMeters) || 300000;
  const exclude = new Set([positive(sourceEntity && sourceEntity.itemID)]);
  return hostilesInRange(scene, sourceEntity, radius, exclude, accept);
}

/**
 * 客户端靠船体上的 entitySuperWeapon* 属性识别"这艘船装着末日武器"：
 * 有这组属性才会开舱门、演聚能、演散热（NPC 就是这么做的）。
 * 末日是装配里的模块，所以这里把模块数据映射成船体属性。
 */
function applySuperweaponEntityAttributes(entity, profile) {
  if (!entity || !profile) {
    return 0;
  }
  const attributes = entity.passiveDerivedState && typeof entity.passiveDerivedState.attributes === "object"
    ? entity.passiveDerivedState.attributes
    : (entity.passiveDerivedState = {...(entity.passiveDerivedState || {}), attributes: {}}).attributes;
  const damage = profile.damage || {};
  const values = {
    2009: positive(profile.durationMs) || 300000,
    2010: positive(damage.em),
    2011: positive(damage.kinetic),
    2012: positive(damage.thermal),
    2013: positive(damage.explosive),
    2046: positive(profile.radiusMeters) || 300000,
    2047: 0,
    2048: 0,
    2049: positive(entity.signatureRadius) || 0,
  };
  let written = 0;
  for (const [id, value] of Object.entries(values)) {
    if (value === undefined || value === null) {
      continue;
    }
    attributes[String(id)] = value;
    written += 1;
  }
  return written;
}

module.exports = {
  applySuperweaponEntityAttributes,
  findDoomsdayTargets,
  DOOMSDAY_GROUP_ID,
  findDoomsdayModules,
  doomsdayProfile,
  hostilesInRange,
  fireDoomsday,
  FX_BY_RACE_HULL,
};
