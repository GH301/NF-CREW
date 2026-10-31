"use strict";

// 遥修「齐射式」结算（路线 A）：治疗量 × 模块数，直接写目标的条件状态。
//
// 为什么：逐模块/逐目标激活会让引擎每次重建全船属性（0.5–1.1 s）。
// 武器已经走这条路（salvo），遥修照同一形态：选 1 个目标、算 1 次治疗量、按模块数乘。
//
// 引擎语义（server/src/services/dogma/dogmaService/layerDamageValues.js）：
//   shieldCharge  : 0..1 **剩余比例**
//   armorDamage   : 0..1 **损伤比例**
//   damage        : 0..1 **船体损伤比例**
// 所以治疗 = 护盾加比例、装甲/船体减损伤比例，都要夹在 [0,1]。
//
// 本文件只做纯计算 + 层值写入，不碰 scene/广播（由 runtime 负责），方便单测。

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.min(1, Math.max(0, number));
}

/**
 * 把一次治疗量写进实体的条件状态。
 * 返回实际生效的数值（被 100% 截断后），方便上层做「修满了就停」的判定。
 */
function applyRepairToEntity(entity, healing = {}) {
  const result = {shield: 0, armor: 0, hull: 0, capped: false};
  if (!entity) {
    return result;
  }
  if (!entity.conditionState || typeof entity.conditionState !== "object") {
    entity.conditionState = {};
  }
  const state = entity.conditionState;

  const shieldCapacity = Number(entity.shieldCapacity) || 0;
  const shieldAmount = Number(healing.shield) || 0;
  if (shieldAmount > 0 && shieldCapacity > 0) {
    const before = clamp01(state.shieldCharge === undefined ? 1 : state.shieldCharge);
    const after = Math.min(1, before + shieldAmount / shieldCapacity);
    state.shieldCharge = after;
    result.shield = Math.round((after - before) * shieldCapacity);
    if (after >= 1) {
      result.capped = true;
    }
  }

  const armorHP = Number(entity.armorHP) || 0;
  const armorAmount = Number(healing.armor) || 0;
  if (armorAmount > 0 && armorHP > 0) {
    const before = clamp01(state.armorDamage === undefined ? 0 : state.armorDamage);
    const lost = before * armorHP;
    const healed = Math.min(lost, armorAmount);
    const after = clamp01((lost - healed) / armorHP);
    state.armorDamage = after;
    result.armor = Math.round(healed);
    if (after <= 0) {
      result.capped = true;
    }
  }

  const structureHP = Number(entity.structureHP) || Number(entity.hullHP) || 0;
  const hullAmount = Number(healing.hull) || 0;
  if (hullAmount > 0 && structureHP > 0) {
    const before = clamp01(state.damage === undefined ? 0 : state.damage);
    const lost = before * structureHP;
    const healed = Math.min(lost, hullAmount);
    const after = clamp01((lost - healed) / structureHP);
    state.damage = after;
    result.hull = Math.round(healed);
    if (after <= 0) {
      result.capped = true;
    }
  }

  return result;
}

/** 电容：0..1 比例，按容量换算。 */
function applyCapacitorToEntity(entity, amount) {
  const capacity = Number(entity && entity.capacitorCapacity) || 0;
  const wanted = Number(amount) || 0;
  if (!entity || capacity <= 0 || wanted <= 0) {
    return 0;
  }
  const before = clamp01(entity.capacitorChargeRatio === undefined ? 1 : entity.capacitorChargeRatio);
  const after = Math.min(1, before + wanted / capacity);
  entity.capacitorChargeRatio = after;
  return Math.round((after - before) * capacity);
}

/** 目标缺多少（用来排版「谁最需要」）：取四层里缺口最大的一层，返回 0..1。 */
function deficitOf(entity) {
  if (!entity) {
    return 0;
  }
  const state = entity.conditionState || {};
  const shield = 1 - clamp01(state.shieldCharge === undefined ? 1 : state.shieldCharge);
  const armor = clamp01(state.armorDamage === undefined ? 0 : state.armorDamage);
  const hull = clamp01(state.damage === undefined ? 0 : state.damage);
  return Math.max(shield, armor, hull);
}

module.exports = {
  clamp01,
  applyRepairToEntity,
  applyCapacitorToEntity,
  deficitOf,
};
