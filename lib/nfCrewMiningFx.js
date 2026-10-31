"use strict";

// S6：统一的模块特效广播。
//
// 以前每个"结算类"功能都自己拼一遍 `scene.broadcastSpecialFx(shipID, guid, {...})`：
// `nfCrewMiningRuntime.js` 里有遥修齐射、导弹齐射、模式变形各处一份，参数顺序和默认值
// 全靠手抄，改一个字段要改四处。这里收成一个函数，行为与原来逐字节一致：
//   - 只做广播，不碰任何服务端状态（结算由调用方负责）；
//   - `scene.broadcastSpecialFx` 不存在时安静返回 false（老场景/测试桩）；
//   - 抛异常也不往上冒（表现层失败不能影响结算）。
//
// 用法：broadcastModuleFx(scene, entity, {guid, moduleID, moduleTypeID, targetID, ...})
// 其中 `entity` 是"这条特效挂在哪艘船上"（通常就是发技能的船员船）。

/**
 * @returns {boolean} 真的发出去了才返回 true
 */
function broadcastModuleFx(scene, entity, options = {}) {
  if (!scene || typeof scene.broadcastSpecialFx !== "function" || !entity) {
    return false;
  }
  const guid = String(options.guid || "");
  if (!guid) {
    return false;
  }
  const shipID = Number(entity.itemID) || Number(options.shipID) || 0;
  if (!shipID) {
    return false;
  }
  // 只透传引擎认识的字段；未给的保持 undefined，让它走引擎自己的默认值。
  const payload = {
    moduleID: options.moduleID === undefined ? null : Number(options.moduleID) || null,
    moduleTypeID: options.moduleTypeID === undefined ? null : Number(options.moduleTypeID) || null,
    targetID: options.targetID === undefined ? null : Number(options.targetID) || null,
    start: options.start !== false,
    active: options.active !== false,
    duration: options.duration === undefined ? undefined : Number(options.duration) || 0,
    repeat: options.repeat === undefined ? 1 : options.repeat,
    ...(options.isOffensive === undefined ? {} : {isOffensive: options.isOffensive === true}),
    ...(options.graphicInfo === undefined ? {} : {graphicInfo: options.graphicInfo}),
    ...(options.chargeTypeID === undefined ? {} : {chargeTypeID: Number(options.chargeTypeID) || 0}),
    ...(options.startTime === undefined ? {} : {startTime: options.startTime}),
  };
  try {
    scene.broadcastSpecialFx(shipID, guid, payload, options.visibilityEntity === undefined ? entity : options.visibilityEntity);
    return true;
  } catch (_error) {
    return false;
  }
}

/** 一帧 stop（取消上面那帧）。 */
function broadcastModuleFxStop(scene, entity, options = {}) {
  return broadcastModuleFx(scene, entity, {...options, start: false, active: false});
}

module.exports = {broadcastModuleFx, broadcastModuleFxStop};
