"use strict";

// 伤害结算的唯一入口：apply → 记伤害归属 → **打爆时入队 KM**。
//
// 为什么需要这个模块：引擎的契约是「谁施加伤害，谁负责把 KM 入队」——
// `applyWeaponDamageToTarget` 只改血量，`noteKillmailDamage` 只记「谁打了多少」，
// 只有 `recordKillmailFromDestruction` 才真的写一条 KM
// （引擎自己的武器周期就是这么三步，见 space/runtime/weaponCycle.js:325-354）。
//
// 模组为了避免每次激活 0.5-1.1 s 的全船属性重算，改成了自己结算
// （齐射 / 末日 / 立体炸弹），但一开始只补了前两步 —— 于是「船员打爆目标」
// 一律没有 KM：killmails 表的 nextKillID 停在旧值，shipKillCounters 也不涨。
//
// 这里把它们收成一处，四个调用点都走 `applyDamage()`，以后不会再漏第三步。

const DAMAGE_KEYS = ["em", "thermal", "kinetic", "explosive"];

/** 四系伤害向量求和（引擎没有 getAppliedDamageAmount 时的兜底口径）。 */
function sumDamage(damage) {
  const source = damage && typeof damage === "object" ? damage : {};
  return DAMAGE_KEYS.reduce((sum, key) => {
    const value = Number(source[key]);
    return sum + (Number.isFinite(value) && value > 0 ? value : 0);
  }, 0);
}

/**
 * 取四个引擎 API：`deps.runtime` 优先，`runtime.droneInterop` 兜底
 * （引擎把武器结算挂在 droneInterop 上），最后才是 `deps.weaponDogma`。
 * 全是函数缺失时的安全取值 —— 老引擎没有 `recordKillmailFromDestruction` 也能跑。
 */
function api(deps) {
  const runtime = (deps && deps.runtime) || {};
  const interop = runtime.droneInterop || {};
  const dogma = (deps && deps.weaponDogma) || {};
  const pick = (name) => (typeof runtime[name] === "function" ? runtime[name] : null)
    || (typeof interop[name] === "function" ? interop[name] : null)
    || (typeof dogma[name] === "function" ? dogma[name] : null);
  return {
    applyDamage: pick("applyWeaponDamageToTarget"),
    getApplied: pick("getAppliedDamageAmount"),
    noteKillmail: pick("noteKillmailDamage"),
    recordKillmail: pick("recordKillmailFromDestruction"),
    notifyDamage: pick("notifyWeaponDamageMessages"),
  };
}

/**
 * 结算一次伤害。
 *
 * request = {
 *   scene, attacker, target, damage, whenMs, options,
 *   weaponSnapshot, moduleItem, chargeItem,   // 只用于 KM / 伤害归属的元数据
 * }
 * 返回 {applied, destroyed, result, problems}：
 *   applied   实际生效的数值（引擎 getAppliedDamageAmount，缺失时退化成伤害向量求和）
 *   destroyed 目标这一下真的被打爆了（destroyResult.success === true）
 *   result    引擎原始返回值，调用方可继续读 damageResult
 *
 * 只在 destroyed 时调用 recordKillmailFromDestruction —— 没打死就只记伤害归属，
 * 这和引擎 weaponCycle 的判断完全一致（destroyResult.success 才算击杀）。
 */
function applyDamage(deps, request = {}) {
  const ref = api(deps);
  const out = {applied: 0, destroyed: false, result: null, problems: []};
  // 归因：把"打"和"记账"分开。只有 watch tick 会传 steps（名字挂在 combat.engage.volley.*）。
  const mark = (name, startedAt) => {
    if (!request.steps) {
      return;
    }
    request.steps[name] = (request.steps[name] || 0) + (Date.now() - startedAt);
  };
  if (!ref.applyDamage) {
    out.problems.push("NO_DAMAGE_API");
    return out;
  }
  const {scene, attacker, target, damage, whenMs, options} = request;
  if (!scene || !attacker || !target) {
    out.problems.push("BAD_ARGUMENTS");
    return out;
  }
  let result = null;
  const engineAt = Date.now();
  try {
    result = ref.applyDamage(scene, attacker, target, damage, whenMs, options || {});
  } catch (error) {
    out.problems.push(`DAMAGE_FAILED:${error && error.message}`);
    return out;
  }
  mark("combat.engage.volley.dmg", engineAt);
  out.result = result || null;
  const appliedAmount = ref.getApplied
    ? Number(ref.getApplied(result && result.damageResult)) || 0
    : sumDamage(damage);
  out.applied = appliedAmount;

  // 第一层：伤害归属（KM 里的 attackers[] 和 finalDamageDone 都靠它）。
  if (appliedAmount > 0 && ref.noteKillmail) {
    const noteAt = Date.now();
    try {
      ref.noteKillmail(attacker, target, appliedAmount, {
        whenMs,
        weaponSnapshot: request.weaponSnapshot || null,
        moduleItem: request.moduleItem || null,
        chargeItem: request.chargeItem || null,
      });
    } catch (error) {
      out.problems.push(`NOTE_DAMAGE_FAILED:${error && error.message}`);
    }
    mark("combat.engage.volley.note", noteAt);
  }

  // 第二层：真的打爆了才入队 KM。漏掉这一步就是「船员击杀没有 KM」。
  const destroyResult = result && result.destroyResult;
  if (destroyResult && destroyResult.success === true) {
    out.destroyed = true;
    if (ref.recordKillmail) {
      const kmAt = Date.now();
      try {
        ref.recordKillmail(target, destroyResult, {
          attackerEntity: attacker,
          whenMs,
          weaponSnapshot: request.weaponSnapshot || null,
          moduleItem: request.moduleItem || null,
          chargeItem: request.chargeItem || null,
        });
      } catch (error) {
        out.problems.push(`KILLMAIL_FAILED:${error && error.message}`);
      }
      mark("combat.engage.volley.km", kmAt);
    } else {
      // 老引擎没有这个 API：不报错，但留一条痕迹方便排查。
      out.problems.push("NO_KILLMAIL_API");
    }
  }
  return out;
}

module.exports = {
  DAMAGE_KEYS,
  sumDamage,
  api,
  applyDamage,
};
