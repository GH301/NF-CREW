"use strict";

// 面板 /api/status 与 /crewmine status 共用的状态快照。
//
// 这个模块不持有任何状态：所有数据通过 ctx 注入（见文件底部注释）。原来它长在
// runtime 闭包里、直接摸 20 多个局部函数；搬到这儿以后，面板字段的增减只改这一个文件。

/**
 * ctx 需要提供：
 *   ensureConfigsLoaded()                          ← 首次访问前加载蓝图
 *   sceneFor(session)                              ← 所在场景（可能为 null）
 *   pool()                                         ← 当前池子数组
 *   configForBlueprint(id)                         ← 蓝图配置
 *   holdVolumeOf(entry, config)                    ← {used, capacity}
 *   persistMember(entry)                           ← 写回容量缓存
 *   specialModulesFor(entry, entity)               ← 特殊装备行
 *   crewOffsetFrom(scene, session, entity)         ← 与玩家的距离
 *   npcModeFor(entry)                              ← 该船员是否 NPC 模式
 *   crewWarnings(entry, entity, holdPct)           ← 行内警告
 *   runningModuleCount(entity)                     ← 激活中的模块数
 *   isMining(characterID)                          ← 是否在采
 *   smartbombAvailable(entry, entity)              ← 有没有立体炸弹
 *   configs()                                      ← 全部蓝图（presets）
 *   behavior()                                     ← configs[0].behavior
 *   syncWarpOn() / followSurfaceGap() / crewSpacingMeters() / followFormationMode() / chaseEnabled()
 *   flags()                                        ← {freeFire, fullAuthority, engagementRule, debug}
 *   listSizes()                                    ← {lockBlacklist, grudge, grudgeCorps}
 *   hasCompression()                               ← 是否装了压缩服务
 *   siegeLabel()                                    ← 组 515 的显示名
 */
function createStatusBuilder(ctx) {
  function build(session) {
    if (typeof ctx.ensureConfigsLoaded === "function") {
      ctx.ensureConfigsLoaded();
    }
    const scene = session ? ctx.sceneFor(session) : null;
    const entries = [];
    for (const entry of (ctx.pool() || [])) {
      if (entry.summoned !== true) {
        continue;
      }
      const entity = scene && typeof scene.getEntityByID === "function" ? scene.getEntityByID(entry.shipID) : null;
      const config = ctx.configForBlueprint(entry.blueprintID) || null;
      // Cheap path: used volume from the item stacks, capacity from the cached snapshot.
      // holdVolume 每次会重建 dogma 快照（500–1100 ms），这里只允许冷缓存时才付这个代价。
      const hold = ctx.holdVolumeOf(entry, config);
      const used = Number(hold.used) || 0;
      const capacity = Number(hold.capacity) || 0;
      // 第一次解析出来的容量写回池子：船/装配不变时，之后每次 status 都跳过快照。
      if (capacity > 0 && Number(entry.holdCapacity) !== capacity) {
        entry.holdCapacity = capacity;
        try {
          ctx.persistMember(entry);
        } catch (_error) {
          /* best effort: 本次进程内缓存仍然有效 */
        }
      }
      const capPctEntry = entity ? Math.round((Number(entity.capacitorChargeRatio) || 0) * 100) : null;
      const holdPctEntry = capacity > 0 ? Math.round(used * 100 / capacity) : 0;
      const specialList = ctx.specialModulesFor(entry, entity);
      // 组 515 全族（会战/堡垒/后勤/工业核心/未识别）都算"模式装备"；末日与立体炸弹另算。
      const MODE_ROW_IDS = ["bastion", "siege", "triage", "industrialCore", "special515"];
      const modeEntry = specialList.find((row) => MODE_ROW_IDS.includes(row.id))
        || specialList.find((row) => row.id === "remoteRep")
        || null;
      const siege = modeEntry
        ? {
          kind: modeEntry.id,
          label: modeEntry.name,
          moduleName: modeEntry.moduleName,
          active: modeEntry.on === true,
          wanted: modeEntry.wanted === true,
          // 引擎重激活锁还没到期：面板显示「重激活中 Ns」并禁用点击。
          pending: modeEntry.pending === true,
          cooldownRemainingMs: Number(modeEntry.cooldownRemainingMs) || 0,
          hasEntity: Boolean(entity),
          // 诊断透传：按钮不对时，看这两个字段就能分清是"识别错"还是"真没开"。
          activeKind: String(modeEntry.activeKind || ""),
          activeEffectIds: Array.isArray(modeEntry.activeEffectIds) ? modeEntry.activeEffectIds : [],
        }
        : null;
      entries.push({
        name: entry.name,
        capPct: capPctEntry,
        holdPct: holdPctEntry,
        offset: ctx.crewOffsetFrom(scene, session, entity),
        npcMode: ctx.npcModeFor(entry),
        warnings: ctx.crewWarnings(entry, entity, holdPctEntry),
        characterID: Number(entry.characterID) || 0,
        shipID: Number(entry.shipID) || 0,
        mode: String((entity && entity.mode) || "无实体"),
        used,
        capacity,
        compress: ctx.hasCompression()
          && String((config && config.behavior && config.behavior.compressOnCycle) || true) !== "false",
        active: ctx.runningModuleCount(entity) > 0,
        mining: ctx.isMining(Number(entry.characterID)),
        siege,
        smartbomb: ctx.smartbombAvailable(entry, entity),
        hullName: String((config && config.fit && config.fit.hull && config.fit.hull.name) || ""),
      });
    }

    // 玩家货舱摘要保留字段形状但不再计算（deps.holdVolume 每次 500–1100 ms）。
    const hold = {used: 0, capacity: 0, compressAvailable: undefined, compressReason: null};
    const siegeActive = entries.filter((row) => row.siege && row.siege.active).length;
    const specialKinds = new Set();
    for (const row of entries) {
      if (row.siege && row.siege.kind) {
        specialKinds.add(row.siege.kind);
      }
    }
    for (const row of entries) {
      if (row.smartbomb) {
        specialKinds.add("smartbomb");
      }
    }
    const flags = ctx.flags();
    const sizes = ctx.listSizes();
    const behavior = ctx.behavior();
    const followGap = ctx.followSurfaceGap();
    return {
      entries,
      hold,
      siege: {
        available: entries.filter((row) => row.siege).length,
        active: siegeActive,
        kinds: [...specialKinds],
        label: ctx.siegeLabel(),
      },
      presets: (ctx.configs() || []).map((config) => ({id: config.id, name: config.name || config.id})),
      syncWarp: ctx.syncWarpOn(),
      weaponSalvo: behavior.weaponSalvo !== false,
      // 导弹/鱼雷零伤害表现球（behavior.missileEntity，默认开）。
      missileEntity: behavior.missileEntity !== false,
      // F1 注入已移除；字段保留只为老面板不报错。
      fleetWarpInject: false,
      followClose: behavior.followClose === true,
      followDistance: followGap === null ? -1 : followGap,
      followSurfaceDistance: true,
      crewSpacingMeters: ctx.crewSpacingMeters(),
      followFormation: ctx.followFormationMode(),
      // 0.6.8：为什么"现在不动"（面板要显示出来，别让用户以为是 bug）
      // idle 一律显示"静止"——哪怕间距已经设好，只要没下 formation 命令就不会动。
      followReason: ctx.followFormationMode() === "idle"
        ? "静止（等待命令）"
        : (followGap === null
          ? `${ctx.followFormationMode() === "ring" ? "环形" : (ctx.followFormationMode() === "follow" ? "跟随" : "阶梯")}缺少间距 → 不动`
          : ""),
      chaseOutOfRange: ctx.chaseEnabled(),
      // 火力集中（0.6.13）：面板按钮只认这个字段（刷新/换客户端也能对上）。
      focusFire: flags.focusFire === true,
      npcModeDefault: behavior.npcMode === true,
      debug: flags.debug,
      freeFire: flags.freeFire,
      fullAuthority: flags.fullAuthority,
      engagementRule: flags.engagementRule,
      lockBlacklist: sizes.lockBlacklist,
      grudge: sizes.grudge,
      grudgeCorps: sizes.grudgeCorps,
      followRangeMeters: Number(behavior.followRangeMeters) || 0,
    };
  }

  return {build};
}

module.exports = {createStatusBuilder};
