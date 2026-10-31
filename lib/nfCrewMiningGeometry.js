"use strict";

// 场景实体的位置/距离。
//
// 以前 `surfaceDistance` 在 mining / combat / salvo 各写了一份，而且“实体缺失”时
// 的表现各不相同（0 / Infinity / 到原点的距离）。调用方依赖的正是这些差异，所以这里
// 保留三个**名字明确**的变体，而不是强行统一成一个——只是把重复的勾股/半径计算收进来。

/** 纯坐标对象 → {x,y,z}；缺失按 0 处理。 */
function vectorOf(value) {
  return {
    x: Number(value && value.x) || 0,
    y: Number(value && value.y) || 0,
    z: Number(value && value.z) || 0,
  };
}

/** 实体 → 坐标：优先 `entity.position`，其次把实体本身当坐标用。 */
function positionOf(entity) {
  return vectorOf((entity && entity.position) || entity || {});
}

function radiusOf(entity) {
  return Math.max(0, Number(entity && entity.radius) || 0);
}

function centreDistance(left, right) {
  const a = vectorOf(left);
  const b = vectorOf(right);
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt((dx * dx) + (dy * dy) + (dz * dz));
}

/** 表面距离（中心距 - 两个半径），实体缺失按 0 坐标算。mining 的老语义。 */
function surfaceDistance(left, right) {
  const centre = centreDistance(left && left.position, right && right.position);
  return Math.max(0, centre - (radiusOf(left) + radiusOf(right)));
}

/** 任一实体缺失就当作“无穷远”（用于“够不够得着”的判断）。combat 的老语义。 */
function surfaceDistanceOrInfinite(left, right) {
  if (!left || !right) {
    return Number.POSITIVE_INFINITY;
  }
  const centre = centreDistance(positionOf(left), positionOf(right));
  return Math.max(0, centre - (radiusOf(left) + radiusOf(right)));
}

/** 任一方没有 `position` 字段就返回 0（“贴着”）。salvo 的老语义。 */
function surfaceDistanceOrZero(left, right) {
  if (!left || !right || !left.position || !right.position) {
    return 0;
  }
  const centre = centreDistance(left.position, right.position);
  return Math.max(0, centre - (radiusOf(left) + radiusOf(right)));
}

module.exports = {
  vectorOf,
  positionOf,
  radiusOf,
  centreDistance,
  surfaceDistance,
  surfaceDistanceOrInfinite,
  surfaceDistanceOrZero,
};
