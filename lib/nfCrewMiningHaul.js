"use strict";

// M5: hauling — compress the crew's ore and hand it to the player's industrial
// command ship, then repeat.
//
// Contract (verified M0):
//   deps.compression.Handle_CompressItemInSpace([itemID, facilityBallID], session)
//     → compresses the stack in place (quantity kept, volume /100); it enforces
//       ownership, "same fleet", the facility type list and the surface range.
//   deps.itemStore.transferItemToOwnerLocation(itemID, ownerID, locationID, flagID,
//     quantity, options) → moves the stack across owners (crew → player's ship).
//
// Order matters: compress first (so 1 m³ of ore hold takes 100 m³ of ore), then
// move. Delivery is a stop/resume hysteresis so it does not flap at the edge.

const DRONE_BAY_FLAG = 87;
// Fitting slots: low/med/hi (11-34), rigs (92-99), subsystems (125-132),
// services (164-171). Anything there is part of the hull, not cargo.
const FITTING_SLOT_RANGES = [[11, 34], [92, 99], [125, 132], [164, 171]];

// Charges live in the hold too (crystals for the turrets), but they are not cargo the
// crew may hand over: an early version delivered the battleship's ammo as ore.
const CHARGE_CATEGORY_ID = 8;
// 只把「矿物」交出去：飞船货舱 flag 5 + 小行星分类 25（矿/冰矿/压缩矿/月矿都在这一族）。
// 之前燃料舱(133)、舰队机库(155) 等特殊舱位也被当成货舱，燃料（锶包合物）被当矿石交付，
// 目标矿舱拒绝（REFUSED），日志里就是「交付 1 组 … REFUSED」。
const CARGO_HOLD_FLAG = 5;
const ORE_HOLD_FLAG = 134;
const ORE_CATEGORY_ID = 25;

function isHoldCargoFlag(flagID) {
  const flag = Number(flagID);
  if (!Number.isFinite(flag)) {
    return false;
  }
  // 只认普通货舱(5) 与矿石舱(134)；燃料舱(133)/舰队机库(155)/无人机舱(87) 都不是矿石舱位。
  return flag === CARGO_HOLD_FLAG || flag === ORE_HOLD_FLAG;
}

/** 这个堆叠是矿物吗（分类 25）。类型记录缺失时放行，避免误杀。 */
function isOreStack(deps, item) {
  const direct = Number(item && item.categoryID) || 0;
  if (direct > 0) {
    return direct === ORE_CATEGORY_ID;
  }
  const typeID = positive(item && item.typeID);
  const resolve = deps && deps.resolveItemByTypeID;
  if (!typeID || typeof resolve !== "function") {
    return true;
  }
  let record = null;
  try {
    record = resolve(typeID);
  } catch (_error) {
    record = null;
  }
  const categoryID = Number(record && record.categoryID) || 0;
  return categoryID === 0 || categoryID === ORE_CATEGORY_ID;
}

function positive(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

/** 0..100 fill percentage of a hold. */
function fillPercent(usedVolume, capacityVolume) {
  const capacity = Number(capacityVolume);
  if (!Number.isFinite(capacity) || capacity <= 0) {
    return 0;
  }
  const used = Math.max(0, Number(usedVolume) || 0);
  return Math.min(100, (used / capacity) * 100);
}

/**
 * When to hand the ore over.
 *   - default: fill the hold, then deliver at `stopPercent` and keep going until
 *     it drops to `resumePercent` (80/70),
 *   - `force`: the player pressed "collect ore", so deliver now.
 */
function shouldDeliver(state = {}) {
  if (state.force === true) {
    return true;
  }
  const percent = Number(state.percent) || 0;
  const stopPercent = Number(state.stopPercent) || 80;
  const resumePercent = Number(state.resumePercent) || 70;
  if (state.delivering === true) {
    return percent > resumePercent;
  }
  return percent >= stopPercent;
}

/** Compressible stacks currently in a hold. */
function holdStacks(deps, request = {}) {
  const itemStore = deps && deps.itemStore;
  const locationID = positive(request.locationID);
  const ownerID = positive(request.ownerID);
  if (!itemStore || !locationID) {
    return [];
  }
  let items = [];
  try {
    items = typeof itemStore.listContainerItems === "function"
      ? itemStore.listContainerItems(ownerID, locationID)
      : [];
  } catch (_error) {
    items = [];
  }
  return (Array.isArray(items) ? items : []).filter((item) => {
    const itemOwner = positive(item && (item.ownerID || item.ownerId));
    if (ownerID && itemOwner && itemOwner !== ownerID) {
      return false;
    }
    if (positive(item && item.itemID) <= 0) {
      return false;
    }
    // NEVER move fitted modules, rigs, services, subsystems or drones: an early
    // version delivered those too and stripped the ship bare. Charges (turret crystals,
    // cap booster fuel) are excluded as well — they are weapons, not ore.
    if (Number(item && item.categoryID) === CHARGE_CATEGORY_ID) {
      return false;
    }
    if (!isHoldCargoFlag(item && item.flagID)) {
      return false;
    }
    return isOreStack(deps, item);
  }).map((item) => {
    // `volume` is PER UNIT (compressed ore is 0.16 m³/unit), so the stack size
    // has to be applied — treating it as the whole stack made every hold look
    // 25% full and the delivery threshold never triggered.
    const quantity = Math.max(1, Number(item.quantity ?? item.stacksize) || 1);
    const unitVolume = Number(item.volume) || 0;
    return {...item, quantity, totalVolume: unitVolume * quantity};
  });
}

/** Compress every stack in the crew hold. Returns counts and problems. */
function compressHold(deps, request = {}) {
  const compression = deps && deps.compression;
  const session = request.session;
  const facilityBallID = positive(request.facilityBallID);
  const stacks = holdStacks(deps, request);
  const result = {compressed: 0, failed: 0, problems: [], attempts: [], volumeBefore: 0, volumeAfter: 0};
  if (!compression || typeof compression.Handle_CompressItemInSpace !== "function") {
    result.problems.push("NO_COMPRESSION_API");
    return result;
  }
  if (!facilityBallID) {
    result.problems.push("NO_FACILITY");
    return result;
  }
  for (const stack of stacks) {
    const itemID = positive(stack.itemID);
    const before = Number(stack.volume) || 0;
    let outcome = null;
    try {
      outcome = compression.Handle_CompressItemInSpace([itemID, facilityBallID], session);
    } catch (error) {
      result.problems.push(`${itemID}:THREW:${error && error.message}`);
      result.failed += 1;
      continue;
    }
    // The engine answers with a tuple: [srcItemID, srcTypeID, qty, outItemID,
    // outTypeID, outQty]. `{}` / `true` are accepted too, but a tuple means
    // SUCCESS — treating it as failure is what reported "压缩 0 组" before.
    const ok = outcome === true
      || (Array.isArray(outcome) && outcome.length >= 6)
      || Boolean(outcome && (outcome.success === true || outcome.compressed === true));
    result.attempts.push({itemID, flagID: Number(stack.flagID) || 0, ok, raw: JSON.stringify(outcome)});
    if (ok) {
      result.compressed += 1;
      result.volumeBefore += before;
      result.volumeAfter += before / 100;
    } else {
      result.failed += 1;
      result.problems.push(`${itemID}:${(outcome && (outcome.errorMsg || outcome.reason)) || "REFUSED"}`);
    }
  }
  return result;
}

/**
 * Move every stack from the crew hold into the player's ore hold.
 * `transferItemToOwnerLocation` is used because the owner changes.
 */
function deliverHold(deps, request = {}) {
  const itemStore = deps && deps.itemStore;
  const target = request.target || {};
  const stacks = holdStacks(deps, request);
  const result = {moved: 0, failed: 0, problems: [], attempts: []};
  if (!itemStore || typeof itemStore.transferItemToOwnerLocation !== "function") {
    result.problems.push("NO_TRANSFER_API");
    return result;
  }
  const ownerID = positive(target.ownerID);
  const locationID = positive(target.locationID);
  const flagID = positive(target.flagID);
  if (!ownerID || !locationID || !flagID) {
    result.problems.push("BAD_TARGET");
    return result;
  }
  for (const stack of stacks) {
    const itemID = positive(stack.itemID);
    let outcome = null;
    try {
      outcome = itemStore.transferItemToOwnerLocation(
        itemID,
        ownerID,
        locationID,
        flagID,
        null,
        {},
      );
    } catch (error) {
      result.problems.push(`${itemID}:THREW:${error && error.message}`);
      result.failed += 1;
      continue;
    }
    const ok = outcome === true || Boolean(outcome && outcome.success === true);
    result.attempts.push({itemID, flagID: Number(stack.flagID) || 0, ok, raw: JSON.stringify(outcome)});
    if (ok) {
      result.moved += 1;
      // Tell the client's inventory window, otherwise the ore is in the item
      // table but the open window does not show it until a refresh.
      if (typeof deps.notifyInventory === "function") {
        try {
          // 操作用会话可能是无头会话（sendNotification 是空函数）：优先用调用方给的
          // 玩家真实会话，否则通知会被吞掉、矿石要进站/重登才看得到。
          deps.notifyInventory(request.notifySession || request.session || null, itemID, target);
        } catch (_error) {
          /* notification is best effort */
        }
      }
    } else {
      result.failed += 1;
      // P0.4: 裸 "REFUSED" 查不出是哪一组被拒（原矿/压缩矿/晶体/无人机），
      // 现在把 typeID、源槽位、数量和引擎给的原因一起带上。
      const reason = (outcome && (outcome.errorMsg || outcome.reason)) || "REFUSED";
      const typeID = positive(stack && stack.typeID);
      const quantity = Math.max(0, Number(stack && stack.quantity) || 0);
      result.problems.push(
        `${itemID}:${reason}(type=${typeID},flag=${Number(stack && stack.flagID) || 0},qty=${quantity})`,
      );
    }
  }
  return result;
}

/**
 * Deliver to the first target that accepts the whole hold: the ore hold is
 * preferred, the cargo hold is the fallback (a full ore hold must not stall the
 * crew forever).
 */
function deliverToAnyTarget(deps, request = {}) {
  const targets = Array.isArray(request.targets) ? request.targets.filter(Boolean) : [];
  const problems = [];
  const targetAttempts = [];
  for (const target of targets) {
    const result = deliverHold(deps, {...request, target});
    targetAttempts.push({target, result});
    if (result.moved > 0 && result.failed === 0) {
      return {...result, target, targetAttempts, problems: [...problems, ...result.problems]};
    }
    problems.push(...result.problems.map((problem) => `${target.label || target.flagID}:${problem}`));
  }
  const last = targetAttempts.length > 0 ? targetAttempts[targetAttempts.length - 1].result : {moved: 0, failed: 0, problems: [], attempts: []};
  return {...last, target: null, targetAttempts, problems: [...problems, ...last.problems]};
}

/** Compress then deliver: one hauling pass for a single ship. */
function serviceShip(deps, request = {}) {
  const compressed = compressHold(deps, request);
  const delivered = arriveOrDeliver(deps, request);
  return {
    ok: delivered.moved > 0 || compressed.compressed > 0,
    compressed,
    delivered,
    problems: [...compressed.problems, ...delivered.problems],
  };
}

function arriveOrDeliver(deps, request) {
  return Array.isArray(request.targets)
    ? deliverToAnyTarget(deps, request)
    : deliverHold(deps, request);
}

module.exports = {
  CARGO_HOLD_FLAG,
  ORE_HOLD_FLAG,
  ORE_CATEGORY_ID,
  isOreStack,
  fillPercent,
  shouldDeliver,
  holdStacks,
  compressHold,
  deliverHold,
  deliverToAnyTarget,
  serviceShip,
};
