"use strict";

// Runtime shared by the in-game command and tools/check-configs.js.
//
// One instance owns: the SDE resolver, the config directory, the state file and
// the pilot pool. Server-side pieces (character records, skills, ships) are
// injected through `deps`, so the whole thing also runs in a plain node process
// (that is how the CLI works and how the tests drive it).

const fs = require("node:fs");
const path = require("node:path");

const host = require(path.join(__dirname, "nfCrewMiningHost.js"));
const {createSde} = require(path.join(__dirname, "nfCrewMiningSde.js"));
const {createPriceBook} = require(path.join(__dirname, "nfCrewMiningPrices.js"));
const {createCatalog} = require(path.join(__dirname, "nfCrewMiningCatalog.js"));
const stockModule = require(path.join(__dirname, "nfCrewMiningStock.js"));
const stockReconcile = require(path.join(__dirname, "nfCrewMiningStockReconcile.js"));
const warehouseModule = require(path.join(__dirname, "nfCrewMiningWarehouse.js"));
const {parseFittings} = require(path.join(__dirname, "nfCrewMiningFitting.js"));
const {buildInlineFit, checkFit} = require(path.join(__dirname, "nfCrewMiningBlueprint.js"));
const configs = require(path.join(__dirname, "nfCrewMiningConfig.js"));
const {createStateStore} = require(path.join(__dirname, "nfCrewMiningState.js"));
const pool = require(path.join(__dirname, "nfCrewMiningPool.js"));
const ship = require(path.join(__dirname, "nfCrewMiningShip.js"));
const fleet = require(path.join(__dirname, "nfCrewMiningFleet.js"));
const follow = require(path.join(__dirname, "nfCrewMiningFollow.js"));
const mining = require(path.join(__dirname, "nfCrewMining.js"));
const combat = require(path.join(__dirname, "nfCrewMiningCombat.js"));
const salvo = require(path.join(__dirname, "nfCrewMiningSalvo.js"));
// F1：舰队跃迁 mod 注入（pseudo session），默认关闭。
const fleetWarp = require(path.join(__dirname, "nfCrewMiningFleetWarp.js"));
// behavior 配置的唯一写入口（命令 + 面板 API 共用）。
const behaviorConfig = require(path.join(__dirname, "nfCrewMiningBehavior.js"));
// 状态快照（面板/status 命令共用）。
const status = require(path.join(__dirname, "nfCrewMiningStatus.js"));
// 模组版本：面板据此判断"服务端重启了没有"。
const MOD_VERSION = (() => {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "evejs-launcher.mod.json"), "utf8"));
    return String(manifest.version || "");
  } catch (_error) {
    return "";
  }
})();
// B 模式：环形槽位 + 自写刹车（纯计算在模块里，引擎调用在下面）。
const formation = require(path.join(__dirname, "nfCrewMiningFormation.js"));
// 跟随/阵型的"当前指令"（0.6.8）：唯一权威来源，蓝图里的 follow* 字段不再驱动行为。
const followStateModule = require(path.join(__dirname, "nfCrewMiningFollowState.js"));
const special = require(path.join(__dirname, "nfCrewMiningSpecial.js"));
// Named `modeModule`: several functions below have a local `mode` (the ship's flight mode).
const modeModule = require(path.join(__dirname, "nfCrewMiningMode.js"));
// PLAN §20 B/C：立体炸弹、EWAR、吸电/中和、指挥脉冲。
const activeModules = require(path.join(__dirname, "nfCrewMiningActive.js"));
// 方案 A：特殊模块的燃料自动补给（组 515 的会战/后勤/工业核心都要燃料）。
const fuelModule = require(path.join(__dirname, "nfCrewMiningFuel.js"));
// 遥修（护盾/装甲/船体远程维修 + 电容传输），按组识别。
const remoteAssist = require(path.join(__dirname, "nfCrewMiningRemoteAssist.js"));
// PLAN §18.29 路线 A：遥修的「齐射式」结算（写层值，不激活模块）。
const remoteSalvo = require(path.join(__dirname, "nfCrewMiningRemoteSalvo.js"));
// 与武器齐射共用同一份 dogma 快照缓存（key = crew:ship:moduleType:chargeType）。
const snapshotCache = require(path.join(__dirname, "nfCrewMiningSnapshotCache.js"));
// S6：统一的模块特效广播（遥修/齐射/模式变形都该走它）。
const fxBroadcast = require(path.join(__dirname, "nfCrewMiningFx.js"));
// 统一结算入口（apply → 记归属 → 打爆时入队 KM）：齐射 / 末日 / 立体炸弹共用。
const damageSettle = require(path.join(__dirname, "nfCrewMiningDamage.js"));
const defense = require(path.join(__dirname, "nfCrewMiningDefense.js"));
const haul = require(path.join(__dirname, "nfCrewMiningHaul.js"));
const transit = require(path.join(__dirname, "nfCrewMiningTransit.js"));

const USAGE = [
  "NFCrew · 船员编队 /crewmine（采矿 / 战斗 / 后勤 / 特殊装备）",
  "  check                     配装预检（不生成任何东西）",
  "  list [文件]               列出配装文件与条目",
  '  import <文件> "<名字>"    从客户端装配生成一条配置（--id --count）',
  "  config                    显示配置/状态文件路径",
  "  pool list                 驾驶员池",
  "  pool scan                 找出池外的本 mod 角色（崩溃残留等）",
  "  pool adopt <角色ID>       把池外角色收进池里复用",
  "  pool clear confirm        彻底清除角色记录（不可恢复）",
  "  spawn <id> [数量]         召唤：造人 + 建船 + 入队 + 编队 + 跟随",
  "  recall all|<名字>         召回：回到你身边待命（不改变舰队关系）",
  "  fleet join all|<名字>     把他们加入你的舰队（需要你已有舰队）",
  "  disband all|<名字> confirm 解散：实体与船消失、退队，角色保留",
  "  corp sync                 把池里的人重新结算到当前军团设置",
  "  mine all|<名字> [off]     下令采矿（用船上在线采矿模块采最近的小行星）；off = 停止采矿",
  "  deliver all|<名字>        压缩并交付到你的矿舱（矿舱满则改投货舱）",
  "  stop all|<名字>           停火：关闭所有已激活模块并清除目标",
  "  attack [full|off]         自由开火；full 额外授权末日武器自动发射（全权开火）",
  "  focus on|off              火力集中：解除每拍 3 艘的齐射轮转（全部船一起结算，人多会卡）",
  "  special <名字|all> <bastion|siege|triage|core|smartbomb|doomsday> on|off",
  "                            特殊装备开关：组 515 全族（会战/堡垒/后勤/工业核心）、立体炸弹、末日",
  "                            组 515 的燃料（锶包合物/重水）由模组自动补给，玩家不用管",
  "  special                   看谁有特殊装备、现在什么状态、启动后有哪些惩罚",
  "  siege on|off [all|<名字>] 特殊装备的旧写法（等价 special <选择器> all on|off）",
  "  modules [all|<名字>]      手动跑一次装备管理（增强器/注电器/推进器/装甲维修）并回报",
  "  refresh [all|<名字>]      按装配重算船的被动属性（装甲板/改装件/质量），老船用",
  "  debug [all|<名字>]        诊断：距离/射程/模块在线/接近指令结果",
  "  aggrodebug [all|<名字>]   诊断：NPC 仇恨/锁定相关（排查怪不打船员用）",
  "  rebuild [all|<名字>]      按装配重建船的派生属性（老船属性不对时用）",
  "  status [json]             当前状态快照（json = 给外部程序读的机器格式）",
  "  syncwarp on|off           跟队跃迁：你按跃迁时船员同一拍开始对准",
  "  formation follow|ladder|ring 跟随阵型：跟随（同一间距）/ 阶梯（依次外扩）/ 环形（同一圈，自写刹车）",
  "  price <typeID|名字> [数量] 查价：吉他最低卖价 × 0.8（没有卖价的物品按 100 ISK）",
  "  catalog [build|ships|high|med|low|rig|charge|drone]  类型索引（船体/模块/弹药），一次生成后走缓存",
  "  stock on|off              开关库存：开启后召唤改为「从库存取船」（默认关）",
  "  stock [status|list]       库存列表（逐艘：ID | 名字 | 船 | 状态 | 价格）",
  "  stock buy <配装> [数量]   按 80% 卖价订货入库（船体+模块计价，无人机/弹药不计价）",
  "  stock deposit [ID…]       把你在吉他 4-4 机库里的船转入（不给 ID = 全部非在开的）",
  "  stock withdraw <ID…>      取出到吉他 4-4 机库",
  "  stock sell <ID…>          卖出（只对购入的船，按实付价退）",
  "  stock migrate             把不在役的老船员船搬进库存",
  "  stock reconcile [adopt]   对账：按物品表修正账本；adopt = 认领仓库机库里没上账的船",
  "  stock backup              复制一份账本（物品库要一起备）",
  "",
  "非 GM 角色：客户端会吞掉不认识的 /命令 —— 用 !crewmine <参数> 代替（如 !crewmine ui）。",
  "  ui                        打开浏览器控制面板（带本账号 token）",
].join("\n");

function round(value) {
  return Math.round(Number(value) || 0);
}

function toPositiveInt(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

function createRuntime(options = {}) {
  const rawLog = options.log || (() => {});
  // 调试日志开关：默认只写"事件级"日志（命令结果、库存/仓库/错误）。
  // 高频诊断（每拍 tick、选矿、跟随、战斗/防御、诱导、性能、逐条命令回显）只在调试模式写，
  // 否则 crew.log 一天能涨几十 MB、真正的错误反而被淹掉。
  let loggingDebug = options.debug === true || process.env.EVEJS_CM_DEBUG === "1";
  const VERBOSE_TAGS = new Set([
    "[tick]", "[haul]", "[mine]", "[follow]", "[defense]", "[combat]", "[cyno]", "[perf]", "[ring]", "[lock]",
  ]);
  const log = (...args) => {
    if (!loggingDebug) {
      const text = args.map((value) => (typeof value === "string" ? value : String(value))).join(" ");
      const tags = text.match(/\[[a-z]+\]/gu);
      if (tags && tags.some((tag) => VERBOSE_TAGS.has(tag))) {
        return;
      }
    }
    rawLog(...args);
  };
  // PR-2: one runtime serves exactly one player account. Without a tenant this
  // stays the old single-tenant runtime, so every existing caller keeps working.
  const tenantAccountID = toPositiveInt(options.tenant && options.tenant.accountID);
  const crewAccountID = toPositiveInt(
    options.crewAccountID !== undefined
      ? options.crewAccountID
      : (options.tenant && options.tenant.crewAccountID),
  );
  const sdeDir = options.sdeDir || host.findSdeDir();
  if (!sdeDir) {
    throw new Error("NF_CREW_MINING_SDE_MISSING");
  }
  const sde = options.sde || createSde({
    sdeDir,
    cacheFile: options.typeCacheFile || host.TYPE_CACHE_FILE,
    aliasFile: options.aliasFile || host.ALIASES_FILE,
    log,
  });
  // P0：价格与类型目录。懒加载——只有 price/catalog 命令或将来的库存/配装台用到时才
  // 读市场库、扫 SDE（扫一次后走 catalog.json 缓存）。
  let priceBook = options.priceBook || null;
  let catalogIndex = options.catalog || null;
  function priceService() {
    if (!priceBook) {
      priceBook = createPriceBook({
        log,
        now,
        dbFile: options.marketDbFile,
      });
    }
    return priceBook;
  }
  function catalogService() {
    if (!catalogIndex) {
      catalogIndex = createCatalog({
        sdeDir,
        log,
        now,
        cacheFile: options.catalogFile || undefined,
      });
    }
    return catalogIndex;
  }
  // P1：库存账本。默认**关闭**（老玩家不受影响），`/crewmine stock on` 打开并迁移。
  let stockStore = options.stockStore || null;
  function stockService() {
    if (!stockStore) {
      stockStore = stockModule.createStockStore({stateStore, now, log});
    }
    return stockStore;
  }
  function stockEnabled() {
    try {
      return stockService().read().enabled === true;
    } catch (_error) {
      return false;
    }
  }
  const configsDir = options.configsDir || host.CONFIGS_DIR;
  const configStore = configs.createConfigStore({configsDir, sde});
  // 唯一写盘入口：命令和面板 API 都走它（类型转换/白名单/裁剪旧键都在模块里）。
  const behaviorWriter = behaviorConfig.createBehaviorWriter({
    configsDir,
    configStore,
    log,
    knownKeys: configs.BEHAVIOR_DEFAULTS,
  });
  // Load the blueprints up front: the store starts empty, so `<behavior>` values (npcMode,
  // weaponSalvo, formation…) only exist after a reload. Without this the first command after
  // a restart would still run on defaults.
  try {
    configStore.reload();
  } catch (_error) {
    /* a broken config directory must not stop the runtime from starting */
  }
  const stateFile = options.stateFile || host.STATE_FILE;
  const stateStore = createStateStore({file: stateFile, log, accountID: tenantAccountID});
  const deps = options.deps || {};
  const now = options.now || (() => Date.now());

  // ---- tenant scoping (PR-2) -------------------------------------------------
  // Every call that used to mean "whoever is logged in" goes through these two.
  function tenantSessions() {
    if (!tenantAccountID) {
      return null; // no tenant: keep the legacy fallback for the single-player path
    }
    if (typeof deps.sessionsFor === "function") {
      try {
        const list = deps.sessionsFor(tenantAccountID);
        if (Array.isArray(list)) {
          return list;
        }
      } catch (_error) {
        /* fall through to "no sessions" — never to another tenant's session */
      }
    }
    return [];
  }

  /** The account our crew characters are filed under (9000001 in the legacy path). */
  function crewAccount() {
    return crewAccountID || pool.ACCOUNT_ID;
  }

  // Deferred work (follow after a warp-in). Timers never keep the process alive
  // and never throw into the server loop.
  const timers = new Set();
  // Every timer callback goes through this wrapper: an exception inside a timer is an
  // uncaughtException and kills the whole server process (it happened twice).
  function guardTimer(label, run) {
    return () => {
      try {
        run();
      } catch (error) {
        try {
          log(`[guard] ${label} 异常：${error && error.message}`);
        } catch (_logError) {
          /* logging must never throw either */
        }
      }
    };
  }

  function scheduleAfter(delayMs, run) {
    const timer = setTimeout(guardTimer("scheduleAfter", () => {
      timers.delete(timer);
      run();
    }), Math.max(0, Math.trunc(Number(delayMs)) || 0));
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    timers.add(timer);
    return timer;
  }
  function clearTimers() {
    for (const timer of timers) {
      clearTimeout(timer);
    }
    timers.clear();
  }

  function preflight(config) {
    return checkFit(config.fit, sde, {skills: config.skills});
  }

  function checkReport() {
    const result = configStore.reload();
    const lines = [];
    for (const error of result.errors) {
      lines.push(`配置目录：${error}`);
    }
    if (result.configs.length === 0 && result.rejected.length === 0) {
      lines.push(`没有配装文件：${configsDir}`);
      return {ok: true, lines};
    }
    let failures = 0;
    for (const config of result.configs) {
      const check = preflight(config);
      const head = `${config.enabled ? "✔" : "○"} ${config.id} · ${config.name} · ${config.count} 人`;
      lines.push(head);
      lines.push(
        `   CPU ${round(check.stats.cpu.used)}/${check.stats.cpu.max}` +
        ` · PG ${round(check.stats.pg.used)}/${check.stats.pg.max}` +
        ` · hi ${check.stats.slots.hi.used}/${check.stats.slots.hi.max}` +
        ` · low ${check.stats.slots.low.used}/${check.stats.slots.low.max}` +
        ` · rig ${check.stats.slots.rig.used}/${check.stats.slots.rig.max}` +
        ` · 无人机舱 ${check.stats.droneBay.used}/${check.stats.droneBay.max} m³`,
      );
      if (!check.ok) {
        failures += 1;
        lines.push(`   ✘ ${check.problems.join(" · ")}`);
      }
      for (const warning of check.warnings) {
        lines.push(`   ⚠ ${warning}`);
      }
    }
    for (const rejected of result.rejected) {
      failures += 1;
      lines.push(`✘ (被拒) ${rejected.problems.join(" · ")}`);
    }
    lines.push(failures === 0 ? "结果：全部通过" : `结果：${failures} 项有问题`);
    return {ok: failures === 0, lines};
  }

  function readFittingFile(fileName) {
    const fullPath = host.findFittingFile(fileName);
    if (!fullPath) {
      return null;
    }
    return {fullPath, text: fs.readFileSync(fullPath, "utf8")};
  }

  function listFittings(fileArg) {
    const lines = [];
    if (!fileArg) {
      let total = 0;
      for (const dir of host.fittingsSearchDirs()) {
        let files = [];
        try {
          files = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".xml"));
        } catch (_error) {
          continue;
        }
        if (files.length === 0) {
          continue;
        }
        lines.push(`目录 ${dir}`);
        for (const fileName of files) {
          const read = readFittingFile(path.join(dir, fileName));
          if (!read) {
            continue;
          }
          const count = parseFittings(read.text).fittings.length;
          total += count;
          lines.push(`  ${fileName}  ${count} 条`);
        }
      }
      lines.push(`合计 ${total} 条配装`);
      return lines;
    }
    const read = readFittingFile(fileArg);
    if (!read) {
      return [`找不到配装文件：${fileArg}`];
    }
    const {fittings} = parseFittings(read.text);
    lines.push(`${path.basename(read.fullPath)}：${fittings.length} 条`);
    // One pass over the SDE for every name in the file.
    const names = [];
    for (const fitting of fittings) {
      names.push(fitting.shipType);
      for (const entry of fitting.hardware) {
        names.push(entry.type);
      }
    }
    const primed = sde.resolveNames(names.filter(Boolean));
    if (primed.missing.length > 0) {
      lines.push(`未解析的名字 ${primed.missing.length} 个：${primed.missing.slice(0, 6).join(" · ")}`);
    }
    let index = 0;
    let mining = 0;
    for (const fitting of fittings) {
      index += 1;
      const built = buildInlineFit(fitting, sde);
      let verdict;
      if (!built.ok) {
        verdict = `✘ ${built.problems.join(" ")}`;
      } else {
        const check = checkFit(built.fit, sde);
        if (check.ok) {
          mining += 1;
          verdict = "✔ 可采矿";
        } else {
          verdict = `✘ ${check.problems.join(" ")}`;
        }
      }
      lines.push(`  ${index}. ${fitting.name} · ${fitting.shipType} · ${verdict}`);
    }
    lines.push(`可采矿 ${mining} / ${fittings.length}`);
    return lines;
  }

  function importFitting(fileArg, nameArg, importOptions = {}) {
    if (!fileArg || !nameArg) {
      return {ok: false, lines: ['用法：import <文件> "<名字>" [--id <id>] [--count N]']};
    }
    const read = readFittingFile(fileArg);
    if (!read) {
      return {ok: false, lines: [`找不到配装文件：${fileArg}`]};
    }
    const {fittings} = parseFittings(read.text);
    const matches = fittings.filter((fitting) => fitting.name === nameArg);
    if (matches.length === 0) {
      return {ok: false, lines: [`文件里没有名为 ${nameArg} 的配装（共 ${fittings.length} 条）`]};
    }
    if (matches.length > 1) {
      return {ok: false, lines: [`文件里有 ${matches.length} 条同名配装 ${nameArg}`]};
    }
    const built = buildInlineFit(matches[0], sde);
    if (!built.ok) {
      return {ok: false, lines: [`装配无法解析：${built.problems.join(" ")}`]};
    }
    const id = configs.slugify(importOptions.id || nameArg) || `crew-${Date.now().toString(36)}`;
    const raw = {
      id,
      name: nameArg,
      enabled: true,
      count: Math.max(1, Number(importOptions.count) || 1),
      job: "mining",
      skills: "all",
      autoMineOnSpawn: false,
      fit: built.fit,
      charges: [],
      behavior: {...configs.BEHAVIOR_DEFAULTS},
    };
    const validated = configs.validateConfig(raw, {sde, file: `${id}.json`});
    if (!validated.config) {
      return {ok: false, lines: [`生成的配置被拒：${validated.problems.join(" · ")}`]};
    }
    const check = preflight(validated.config);
    if (!check.ok) {
      return {ok: false, lines: [`预检未通过，未写入：${check.problems.join(" · ")}`]};
    }
    const target = path.join(configsDir, `${id}.json`);
    host.writeJson(target, validated.config);
    const lines = [
      `已生成 ${target}`,
      `   ${validated.config.fit.hull.name} · ${validated.config.fit.modules.length} 模块 · ` +
      `${validated.config.fit.drones.reduce((sum, entry) => sum + entry.quantity, 0)} 无人机`,
      `   CPU ${round(check.stats.cpu.used)}/${check.stats.cpu.max} · PG ${round(check.stats.pg.used)}/${check.stats.pg.max}` +
      ` · 无人机舱 ${check.stats.droneBay.used}/${check.stats.droneBay.max} m³`,
    ];
    for (const warning of check.warnings) {
      lines.push(`   ⚠ ${warning}`);
    }
    return {ok: true, lines};
  }

  function poolList() {
    const entries = stateStore.get().pool || [];
    if (entries.length === 0) {
      return ["驾驶员池是空的"];
    }
    const lines = [`驾驶员池 ${entries.length} 人`];
    for (const entry of entries) {
      lines.push(
        `  ${entry.name || entry.characterID} · ${entry.blueprintID || "?"} · ` +
        `${entry.summoned ? `在役 (ship ${entry.shipID})` : "待用"}` +
        `${entry.skillsSeeded ? "" : " · ⚠ 无技能"}`,
      );
    }
    return lines;
  }

  function poolClear(confirm) {
    const entries = stateStore.get().pool || [];
    if (entries.length === 0) {
      return {ok: true, lines: ["驾驶员池是空的，无需清理"]};
    }
    if (confirm !== true) {
      return {ok: false, lines: [`将删除 ${entries.length} 个角色记录（不可恢复）。确认请输入 /crewmine pool clear confirm`]};
    }
    const plan = pool.planPurge(entries);
    if (!deps.characterState) {
      return {ok: false, lines: ["缺少服务端依赖，无法清理（在游戏里执行）"]};
    }
    const result = pool.purgeMembers(deps, plan);
    stateStore.update((state) => ({...state, pool: []}));
    const lines = [`已删除 ${result.removed.length} / ${entries.length} 个角色`];
    if (result.leftovers.length > 0) {
      lines.push(`残留：${result.leftovers.slice(0, 6).join(" · ")}`);
    }
    return {ok: result.leftovers.length === 0, lines};
  }

  function describe() {
    return [
      `配装目录 ${configsDir}`,
      `状态文件 ${stateStore.file}`,
      `类型缓存 ${host.TYPE_CACHE_FILE}`,
      `别名文件 ${host.ALIASES_FILE}`,
      `SDE ${sdeDir}`,
    ];
  }

  // 状态快照的字段组装搬到了 status 模块；这里只把依赖注入进去（都是闭包里的函数/变量）。
  const statusBuilder = status.createStatusBuilder({
    ensureConfigsLoaded,
    sceneFor: (session) => follow.sceneFor(deps, session),
    pool: () => stateStore.get().pool || [],
    configForBlueprint,
    holdVolumeOf: (entry, config) => holdVolumeOf(deps, {
      characterID: entry.characterID,
      shipID: entry.shipID,
      config,
      capacityHint: entry.holdCapacity,
    }),
    persistMember,
    specialModulesFor,
    crewOffsetFrom,
    npcModeFor,
    crewWarnings,
    runningModuleCount,
    isMining: (characterID) => miningWanted.has(Number(characterID)),
    smartbombAvailable,
    configs: () => configStore.get().configs || [],
    behavior: configs_behavior,
    syncWarpOn,
    followSurfaceGap,
    crewSpacingMeters,
    followFormationMode,
    chaseEnabled,
    flags: () => ({freeFire, fullAuthority, focusFire, engagementRule, debug: debugMode}),
    listSizes: () => ({
      lockBlacklist: blacklistSize(),
      grudge: grudgeCount(),
      grudgeCorps: grudgeCorpCount(),
    }),
    hasCompression: () => Boolean(deps.compression),
    siegeLabel: () => modeModule.MODE_KINDS.siege.label,
  });

  /** Run a step that must return an {ok, ...} shape; never throws, never null. */
  function safeCall(label, run) {
    try {
      const value = run();
      if (!value || typeof value !== "object") {
        return {ok: false, problems: [`${label}:EMPTY_RESULT`]};
      }
      return value;
    } catch (error) {
      return {ok: false, problems: [`${label}:${error && error.message}`]};
    }
  }

  function persistMember(member) {
    if (!(stateStore.get().pool || []).some((entry) => entry.summoned === true)) {
      stopServiceLoop();
    }
    stateStore.update((current) => {
      const byID = new Map((current.pool || []).map((entry) => [entry.characterID, entry]));
      byID.set(member.characterID, member);
      return {...current, pool: [...byID.values()]};
    });
  }

  /**
   * M2/M3: summon crew — pool member, their own fitted ship, in space next to the
   * player. Fleet join and formation arrive in M3, mining in M4.
   */
  /**
   * Rebuild the ship of a crew whose hull was destroyed. Keeps the same character, needs
   * no pool slot, and puts the new hull back next to the player.
   */
  /**
   * 诊断：直接调用引擎的判定函数，逐条打印 NPC 为什么(不)打这艘船员船。
   * 把猜测换成证据：分类、可见范围、跃迁/隐身、友军判定、无敌标记。
   */
  function aggroDebug(selector, context = {}) {
    const lines = [];
    const session = context.session || null;
    const scene = follow.sceneFor(deps, session);
    if (!scene) {
      return ["没有场景（先回太空里）"];
    }
    const behavior = deps.npcBehaviorLoop;
    const testing = behavior && behavior.__testing;
    if (!testing) {
      return ["引擎没有暴露 npcBehaviorLoop.__testing，无法诊断"];
    }
    const wanted = String(selector || "all").trim().toLowerCase();
    const pool = (stateStore.get().pool || []).filter((entry) => {
      if (wanted === "all") {
        return entry.summoned === true;
      }
      return String(entry.name || "").toLowerCase() === wanted;
    });
    if (pool.length === 0) {
      return ["没有匹配的船员"];
    }
    for (const entry of pool) {
      const entity = typeof scene.getEntityByID === "function" ? scene.getEntityByID(entry.shipID) : null;
      if (!entity) {
        lines.push(`${entry.name}：实体不在场景里`);
        continue;
      }
      const actorClass = testing.resolveCombatActorClass(entity);
      lines.push(`${entry.name}：分类=${actorClass}` +
        ` session=${entity.session && entity.session.characterID ? entity.session.characterID : "无"}` +
        ` bubble=${entity.bubbleID || "无"} system=${entity.systemID || "无"}`);
      const npc = combat.nearestHostile({
        scene,
        sourceEntity: entity,
        excludeIDs: new Set((stateStore.get().pool || []).map((row) => Number(row.shipID)).filter(Boolean)),
        maxMeters: 200000,
      });
      if (!npc || !npc.entity) {
        lines.push(`  ${entry.name}：200 km 内没有敌对 NPC，无法测试`);
        continue;
      }
      const npcEntity = npc.entity;
      const distance = Math.round(Number(npc.distance) || 0);
      const gates = {
        可见范围: testing.isTargetWithinEntityVisibilityScope(npcEntity, entity),
        友军判定: testing.isFriendlyCombatTarget(npcEntity, entity),
        合法目标: testing.isValidCombatTarget(npcEntity, entity, {}),
      };
      lines.push(`  最近 NPC=${npcEntity.itemID}（${distance} m）` +
        ` NPC分类=${testing.resolveCombatActorClass(npcEntity)}`);
      for (const [label, value] of Object.entries(gates)) {
        lines.push(`  ${label}=${value}`);
      }
      let invulnerable = "未知";
      try {
        const control = require(path.join(host.SERVER_DIR, "space", "npc", "npcControlState.js"));
        invulnerable = control.isCharacterInvulnerable(Number(entry.characterID) || 0) ? "是" : "否";
      } catch (_error) {
        invulnerable = "读取失败";
      }
      lines.push(`  角色无敌标记=${invulnerable}`);
    }
    return lines;
  }

  const lastNpcWakeAt = new Map();

  /**
   * NPC 控制器默认由"有玩家在场"的事件唤醒。船员船不是真正的会话，所以即使判定
   * 全部通过，怪也可能处于休眠状态：这里主动唤醒船员附近的控制器。
   */
  function wakeNpcsNearCrew(scene, session) {
    const svc = deps.npcService;
    if (!scene || !svc || typeof svc.wakeNpcController !== "function") {
      return 0;
    }
    const pool = (stateStore.get().pool || []).filter((entry) => entry.summoned === true);
    if (pool.length === 0) {
      return 0;
    }
    const exclude = new Set(pool.map((entry) => Number(entry.shipID)).filter(Boolean));
    const playerShipID = Number(session && session._space && session._space.shipID) || 0;
    if (playerShipID) {
      exclude.add(playerShipID);
    }
    let woke = 0;
    // 每拍只取一次场景快照（dynamicEntitiesFor 有 500 ms 缓存）。以前这里每条船各扫一遍
    // 全场景，8 条船就是 8 次 —— 实测这是 combat 段耗时的大头，而节流只挡住了"唤醒"，
    // 没挡住扫描。
    const wakeCandidates = dynamicEntitiesFor(scene);
    for (const entry of pool) {
      const entity = typeof scene.getEntityByID === "function" ? scene.getEntityByID(entry.shipID) : null;
      if (!entity) {
        continue;
      }
      let picked = null;
      try {
        picked = combat.nearestHostile({
          scene,
          sourceEntity: entity,
          excludeIDs: exclude,
          maxMeters: 40000,
          candidates: wakeCandidates,
        });
      } catch (_error) {
        picked = null;
      }
      if (!picked || !picked.entity) {
        continue;
      }
      const npcID = Number(picked.entity.itemID) || 0;
      if (!npcID) {
        continue;
      }
      const at = Number(lastNpcWakeAt.get(npcID)) || 0;
      if (now() - at < 30000) {
        continue;
      }
      lastNpcWakeAt.set(npcID, now());
      try {
        svc.wakeNpcController(npcID, now());
        woke += 1;
      } catch (_error) {
        /* 引擎拒绝唤醒时忽略 */
      }
    }
    if (woke > 0 && debugMode) {
      log(`[aggro] 唤醒附近 NPC 控制器 ${woke} 个`);
    }
    return woke;
  }

  function rebuildCrew(selector, context = {}) {
    const lines = [];
    const session = context.session || null;
    const systemID = Number(session && session._space && session._space.systemID) || 0;
    const playerShipID = Number(session && session._space && session._space.shipID) || 0;
    if (!systemID || !playerShipID) {
      return {ok: false, lines: ["请在太空里重建（当前没有所在星系/飞船）"]};
    }
    const wanted = String(selector || "all").trim().toLowerCase();
    const pool = stateStore.get().pool || [];
    const targets = pool.filter((entry) => {
      if (wanted === "all") {
        return entry.destroyed === true;
      }
      return String(entry.name || "").toLowerCase() === wanted;
    });
    if (targets.length === 0) {
      return {ok: false, lines: [wanted === "all" ? "没有需要重建的船员" : `没找到船员：${selector}`]};
    }
    if (!deps.itemStore || !deps.runtime) {
      return {ok: false, lines: ["缺少服务端依赖，重建只能在游戏里执行"]};
    }
    const scene = follow.sceneFor(deps, session);
    const leader = playerShipID && scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(playerShipID)
      : null;
    let rebuilt = 0;
    for (const entry of targets) {
      const config = configForBlueprint(entry.blueprintID);
      if (!config || !config.fit) {
        lines.push(`${entry.name}：蓝图 ${entry.blueprintID} 不存在，无法重建`);
        continue;
      }
      const created = ship.createShip(deps, {
        characterID: entry.characterID,
        stationID: stationIDFor(session),
        fit: config.fit,
        name: config.name || entry.name,
      });
      if (!created.ok) {
        lines.push(`${entry.name}：建船失败 ${created.problems.join(" ")}`);
        continue;
      }
      const spaceState = ship.buildSpaceState({systemID, leader, index: 0});
      const moved = ship.deployShip(deps, {shipID: created.shipID, systemID, spaceState});
      if (!moved.ok) {
        lines.push(`${entry.name}：送上天失败 ${moved.problems.join(" ")}`);
        continue;
      }
      const entity = ship.spawnEntity(deps, {
        shipID: created.shipID,
        systemID,
        characterID: entry.characterID,
        sceneDescriptor: scene && scene.sceneDescriptor,
        scene,
        session,
      });
      if (!entity.ok) {
        lines.push(`${entry.name}：生成实体失败 ${entity.problems.join(" ")}`);
        continue;
      }
      // S3/R5: a rebuilt hull needs the doomsday hull attributes too, otherwise the
      // client draws a plain ship (no bay doors, no charge animation).
      applyDoomsdayPresence(scene, {...entry, shipID: created.shipID}, entity.entity);
      stateStore.update((state) => ({
        ...state,
        pool: (state.pool || []).map((row) => (Number(row.characterID) === Number(entry.characterID)
          ? {...row, shipID: created.shipID, summoned: true, destroyed: false}
          : row)),
      }));
      destroyedWarned.delete(Number(entry.characterID) || 0);
      rebuilt += 1;
      lines.push(`${entry.name}：已重建并在你附近（船 ${created.shipID}）`);
    }
    if (rebuilt > 0) {
      log(`[crew] 重建 ${rebuilt} 艘：${targets.map((entry) => entry.name).join("、")}`);
    }
    return {ok: rebuilt > 0, lines};
  }

  function spawnCrew(blueprintID, count, context = {}) {
    const lines = [];
    const config = (configStore.get().configs || []).find((entry) => entry.id === blueprintID);
    if (!config) {
      configStore.reload();
    }
    const resolved = (configStore.get().configs || []).find((entry) => entry.id === blueprintID);
    if (!resolved) {
      return {ok: false, lines: [`没有这条配装：${blueprintID}（先 /crewmine check）`]};
    }
    if (!deps.itemStore || !deps.runtime) {
      return {ok: false, lines: ["缺少服务端依赖（itemStore / space runtime），召唤只能在游戏里执行"]};
    }
    // 面板缓存的 serviceSession 可能是"还在站里"的快照：缺 _space 就换成本账号的在线会话。
    const requestedSession = (context && context.session) || null;
    const session = requestedSession && Number(requestedSession._space && requestedSession._space.systemID) > 0
      ? requestedSession
      : (resolvePlayerSession() || requestedSession);
    const systemID = Number(session && session._space && session._space.systemID) || 0;
    const playerShipID = Number(session && session._space && session._space.shipID) || 0;
    if (!systemID || !playerShipID) {
      return {
        ok: false,
        lines: [
          "没拿到你的在太空会话（没有所在星系/飞船）。",
          "在游戏里按一下 /crewmine status 或移动一下让模组看到你，再回来召唤。",
        ],
      };
    }

    const wanted = Math.max(1, Math.min(30, Math.trunc(Number(count) || resolved.count || 1)));
    const affiliation = resolveAffiliation(resolved, session);
    const state = stateStore.get();
    const selection = pool.selectForSpawn({
      pool: state.pool || [],
      blueprintID: resolved.id,
      count: wanted,
    });
    const members = [...selection.reuse];
    for (let index = 0; index < selection.create; index += 1) {
      try {
        const member = pool.createMember(deps, {
          blueprintID: resolved.id,
          stationID: stationIDFor(session),
          systemID,
          corporationID: affiliation.corporationID,
          allianceID: affiliation.allianceID,
        });
        members.push(member);
        // Persist right away: a failure later must never orphan a character that
        // already exists in the game store.
        persistMember(member);
      } catch (error) {
        lines.push(`建角色失败：${error && error.message}`);
      }
    }
    if (members.length === 0) {
      return {ok: false, lines: lines.length > 0 ? lines : ["没有可召唤的船员"]};
    }

    const scene = typeof deps.runtime.getSceneForSession === "function"
      ? deps.runtime.getSceneForSession(session)
      : null;
    const leader = scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(playerShipID)
      : null;

    // 借调：`selectForSpawn` 只会返回空闲角色，跨蓝图借来的那些要重贴成目标蓝图，
    // 否则面板显示的还是旧船名、跟随距离也用旧蓝图的配置。
    const borrowed = members.filter((member) => String(member.blueprintID || "") !== String(resolved.id));
    for (const member of borrowed) {
      member.blueprintID = resolved.id;
      member.holdCapacity = 0; // 旧船的货舱缓存对新船无效
      member.mining = false;
    }
    if (borrowed.length > 0) {
      lines.push(`借调 ${borrowed.length} 名其它蓝图的空闲角色（重贴为 ${resolved.id}，角色保留）`);
    }

    const arrival = resolveArrivalMode(resolved.behavior);
    const cynoLeadMs = Math.max(0, Math.trunc(Number(resolved.behavior.cynoLeadMs)) || 0);
    const cynoDurationMs = Math.max(1000, Math.trunc(Number(resolved.behavior.cynoDurationMs)) || 60000);
    // 诱导入场（arrival: "cyno"）：先在你旁边点亮诱导力场，leadMs 之后船员才跳进来。
    // 点灯失败（测试桩 / 老场景 / 没有实体 ID 分配器）不阻止召唤：船员直接跳入。
    let cynoField = null;
    if (arrival === "cyno") {
      // 同星系里还亮着的旧力场先收掉，免得两个灯叠在一起。
      for (const entry of [...litCynoFields.values()]) {
        if (Number(entry.systemID) === systemID) {
          removeCynoField(entry, "新的召唤");
        }
      }
      const cyno = ship.spawnCynoField(deps, {
        scene,
        session,
        position: leader && leader.position,
        direction: leader && leader.direction,
        typeID: resolved.behavior.cynoTypeID,
        durationMs: cynoDurationMs,
        identity: {
          ownerID: Number(leader && (leader.ownerID || leader.characterID)) || 0,
          corporationID: Number(leader && leader.corporationID) || 0,
          allianceID: Number(leader && leader.allianceID) || 0,
        },
      });
      if (!cyno.ok) {
        lines.push(`诱导力场没点亮（${cyno.reason}），船员改为直接跳入`);
      } else {
        cynoField = {entityID: cyno.entityID, scene, systemID};
        litCynoFields.set(Number(cyno.entityID), cynoField);
        // 到点自己摘：cynoField 不是库存实体，场景的过期索引不收它。
        scheduleAfter(cynoDurationMs + 250, () => removeCynoField(cynoField, "到点"));
      }
    }
    // 跟随**不是默认行为**（0.6.8）：召唤只负责把船造出来、编入舰队。
    //   idle   → 什么都不发（落地后静止等命令）
    //   follow → 只在间距已配置时发 FOLLOW（所有人同一个间距）
    //   ladder → 只在间距已配置时发 FOLLOW（按序号依次外扩）
    //   ring   → 由 250 ms 环形控制器接管，这里不发（否则两条指令抢 entity.mode）
    const spawnMode = followFormationMode();
    const spawnGap = followSurfaceGap();
    const autoFollow = (spawnMode === "ladder" || spawnMode === "follow") && spawnGap !== null;

    // P1：库存开启时，召唤 = 从库存取船（按蓝图配装签名匹配），不再凭空造船。
    let stockPlan = null;
    if (stockEnabled()) {
      const prepared = prepareStockPlan({
        config: resolved,
        members,
        session,
        stockIDs: context && context.stockIDs,
      });
      if (!prepared.ok) {
        return {ok: false, lines: [...lines, ...prepared.lines]};
      }
      stockPlan = prepared.plan;
    }

    let deployed = 0;
    const spawned = [];
    for (const [index, member] of members.entries()) {
      let takenStock = null;
      try {
      const created = stockPlan
        ? takeStockShip(stockPlan, member)
        : ship.createShip(deps, {
          characterID: member.characterID,
          stationID: stationIDFor(session),
          fit: resolved.fit,
          name: `${resolved.name} ${index + 1}`,
        });
      if (created.fromStock) {
        takenStock = created.fromStock;
      }
      if (!created.ok) {
        lines.push(`${member.name}：${stockPlan ? "取库存船失败" : "建船失败"} ${created.problems.join(" ")}`);
        if (takenStock) {
          returnStockShip(takenStock);
        }
        continue;
      }
      // 船落在哪：
      //   warp    出生点在 2 AU 外，再跃迁进来（客户端画真跃迁，顺便解析驾驶员）
      //   cyno    落在诱导力场周围的一圈上（跳入不需要"从远处飞过来"）
      //   instant 直接落在你旁边
      const warpEnabled = arrival === "warp";
      const warpAu = Math.max(0.1, Number(resolved.behavior.warpInAu) || 2);
      const spawnDistance = warpEnabled ? Math.round(ship.AU_METERS * warpAu) : 0;
      const spaceState = arrival === "cyno"
        ? ship.buildCynoArrivalState({
          systemID,
          center: leader,
          index,
          count: members.length,
          radiusMeters: resolved.behavior.cynoRadiusMeters,
        })
        : ship.buildSpaceState({systemID, leader, index, distanceMeters: spawnDistance || undefined});
      const moved = ship.deployShip(deps, {shipID: created.shipID, systemID, spaceState});
      if (!moved.ok) {
        lines.push(`${member.name}：送上天失败 ${moved.problems.join(" ")}`);
        if (takenStock) {
          returnStockShip(takenStock);
        }
        continue;
      }
      // 船已经进了太空：账本记「在用」，之后解散会回库而不是删船。
      if (created.fromStock) {
        stockService().markInUse(created.fromStock.id, member.characterID);
      }
      // 实体出现之后的所有事：末日属性、跳入特效（cyno）、跃迁进场（warp）、
      // 入队编队、跟随、状态行。deferred=true 表示命令早已返回（跳入在定时器里落地），
      // 这些行改写到日志。
      const finish = (entity, deferred) => {
        const say = deferred ? (text) => log(`[cyno] ${text}`) : (text) => lines.push(text);
        // 装着末日的船：补上引擎只给玩家/NPC 写的那组属性，客户端才会开舱门、演聚能。
        applyDoomsdayPresence(scene, member, entity.entity);
        if (!entity.republished && entity.republishProblem) {
          say(`${member.name}：重播未成功（${entity.republishProblem}），客户端可能要在换星系后才显示驾驶员`);
        }
        if (arrival === "cyno") {
          // 跳入的画面：和 evejs-faction-sim 的旗舰跳入同一个 guid（只做表现）。
          const fx = ship.jumpInFx(deps, {scene, shipID: created.shipID, entity: entity.entity});
          if (!fx.ok) {
            log(`[cyno] ${member.name}：跳入特效没播出去（${fx.reason}）`);
          }
        }
        let warp = null;
        let arrivalMs = 0;
        if (warpEnabled) {
          const arrivalPoint = ship.buildSpaceState({systemID, leader, index});
          warp = ship.warpIn(deps, {
            systemID,
            sceneDescriptor: scene && scene.sceneDescriptor,
            shipID: created.shipID,
            targetPoint: arrivalPoint.position,
          });
          if (warp.ok) {
            arrivalMs = Math.max(1200, warp.completeAtMs - now());
          } else {
            say(`${member.name}：跃迁进场失败（${warp.reason}），改为直接出现`);
          }
        }
        pool.markSummoned(member, {shipID: created.shipID, hangarLocationID: stationIDFor(session)});

        // M3: fleet, formation, follow.
        const joined = fleet.join(deps, {
          playerSession: session,
          member,
          ownerAccountID: tenantAccountID,
          shipTypeID: resolved.fit.hull.typeID,
        });
        let formation = null;
        if (!joined.ok) {
          const hint = joined.problems.includes("NO_PLAYER_FLEET")
            ? "（请先在舰队窗口创建舰队，再召唤）"
            : "";
          say(`${member.name}：入队失败 ${joined.problems.join(" ")}${hint}`);
        } else {
          formation = fleet.place(deps, {
            playerSession: session,
            fleetID: joined.fleetID,
            characterID: member.characterID,
            wing: resolved.wing,
            squad: resolved.squad,
          });
          if (!formation.ok) {
            say(`${member.name}：编队问题 ${formation.problems.join(" ")}`);
          }
        }
        const followRequest = {
          sceneDescriptor: scene && scene.sceneDescriptor,
          systemID,
          session,
          scene,
          followerShipID: created.shipID,
          leaderShipID: playerShipID,
          rangeMeters: spawnGap === null ? 0 : spawnGap,
        };
        let following = null;
        let followDeferred = false;
        if (autoFollow) {
          if (warp && warp.ok && arrivalMs > 0) {
            followDeferred = true;
            scheduleAfter(arrivalMs + 300, () => follow.follow(deps, followRequest));
          } else {
            following = follow.follow(deps, followRequest);
          }
        }
        if (following && !following.ok) {
          say(`${member.name}：跟随失败 ${following.problems.join(" ")}`);
        }
        const contents = ship.describeShip(deps, {characterID: member.characterID, shipID: created.shipID});
        const line =
          `${member.name}（${member.characterID}）· 船 ${created.shipID} · ` +
          `装 ${created.granted.modules} 件 · 无人机 ${created.granted.drones} 架` +
          ` · 军团 ${member.corporationID || "—"}` +
          ` · ${joined.ok ? "入队✓" : "未入队"}` +
          `${formation && formation.wingID ? ` · 编队 ${formation.wingID}/${formation.squadID || "-"}` : ""}` +
          ` · ${following && following.ok ? `跟随✓${following.rangeMeters < 1000 ? `${Math.round(following.rangeMeters)}m` : `${Math.round(following.rangeMeters / 1000)}km`}${following.mode === "orbit" ? "(orbit)" : ""}` : followDeferred ? `跃迁 ${warpAu} AU / ${(spawnDistance / 1e9).toFixed(1)}e9 m（${Math.round(arrivalMs / 100) / 10}s 后跟随）` : "跟随—"}` +
          ` · 重播${entity.republished ? "✓" : "—"}` +
          `${contents.ok ? ` · 舱内 ${contents.items.length} 行` : ""}`;
        if (deferred) {
          log(`[cyno] ${line}`);
        } else {
          lines.push(line);
        }
        // 跳入/原地出现没有"真跃迁"顺带解析驾驶员，落地 1.5 秒后再补一次船信息，
        // 客户端据此把驾驶员头像解析出来；跃迁那条路本来就会解析，不用补。
        if (arrival !== "warp") {
          scheduleAfter(1500, () => {
            const again = ship.republishShip(deps, {scene, shipID: created.shipID});
            if (!again.ok && again.reason !== "ENTITY_NOT_FOUND") {
              log(`[arrival] ${member.name}：补发船信息失败（${again.reason}）`);
            }
          });
        }
      };

      if (arrival === "cyno") {
        // 诱导期间船在太空里但不在场景里（和跃迁进场"正在跃迁"的那段时间同性质），
        // leadMs 到点才生成实体 + 播跳入特效，身份/入队/编队跟着实体一起出现。
        pool.markSummoned(member, {shipID: created.shipID, hangarLocationID: stationIDFor(session)});
        scheduleAfter(cynoLeadMs, () => {
          // 这 4 秒里可能已经被 disband（船删了）或 recall（实体已经救回来了），
          // 两种情况都不能再生成一次实体。
          const itemAlive = deps.itemStore && typeof deps.itemStore.findItemById === "function"
            ? Boolean(deps.itemStore.findItemById(created.shipID))
            : true;
          if (!itemAlive) {
            log(`[cyno] ${member.name}：船 ${created.shipID} 已经不在（诱导期间被解散），不再跳入`);
            return;
          }
          const present = scene && typeof scene.getEntityByID === "function"
            ? scene.getEntityByID(created.shipID)
            : null;
          if (present) {
            // 4 秒内被 recall/refresh 救回来，已经在场景里了：只补一次跳入特效。
            ship.jumpInFx(deps, {scene, shipID: created.shipID, entity: present});
            log(`[cyno] ${member.name}：实体已经在场景里，只补跳入特效`);
            return;
          }
          const entity = ship.spawnEntity(deps, {
            shipID: created.shipID,
            systemID,
            characterID: member.characterID,
            sceneDescriptor: scene && scene.sceneDescriptor,
            scene,
            session,
          });
          if (!entity.ok) {
            log(`[cyno] ${member.name}：跳入失败 ${entity.problems.join(" ")}（船 ${created.shipID} 还在太空，召回/refresh 会重建）`);
            return;
          }
          finish(entity, true);
        });
        deployed += 1;
        spawned.push(member);
        lines.push(
          `${member.name}（${member.characterID}）· 船 ${created.shipID} · ` +
          `装 ${created.granted.modules} 件 · 无人机 ${created.granted.drones} 架` +
          ` · 诱导力场已点亮，${Math.round(cynoLeadMs / 100) / 10}s 后跳入`,
        );
        continue;
      }

      const entity = ship.spawnEntity(deps, {
        shipID: created.shipID,
        systemID,
        characterID: member.characterID,
        sceneDescriptor: scene && scene.sceneDescriptor,
        scene,
        session,
      });
      if (!entity.ok) {
        lines.push(`${member.name}：生成实体失败 ${entity.problems.join(" ")}`);
        continue;
      }
      deployed += 1;
      spawned.push(member);
      finish(entity, false);
      } catch (error) {
        // A throw half-way through one member must not abort the whole command,
        // and the character record already exists: keep it in the pool.
        lines.push(`${member.name}：召唤步骤异常（${error && error.message}），角色已保留在池中`);
        if (takenStock) {
          const current = stockService().get(takenStock.id);
          if (current && current.state === stockModule.STATES.reserved) {
            returnStockShip(takenStock);
          }
        }
      }
    }
    // 没用上的占位放回「在库」。
    if (stockPlan) {
      stockService().release(stockPlan.token);
    }

    // 一个人都没跳进来（建船全失败）：灯也别挂着。
    if (cynoField && deployed === 0) {
      removeCynoField(cynoField, "没人跳进来");
    }

    stateStore.update((current) => {
      const byID = new Map((current.pool || []).map((entry) => [entry.characterID, entry]));
      for (const member of members) {
        byID.set(member.characterID, member);
      }
      return {...current, pool: [...byID.values()]};
    });

    lines.unshift(
      `召唤 ${resolved.name}：${deployed} / ${members.length} 人${arrival === "cyno"
        ? `（诱导力场已点亮，${Math.round(cynoLeadMs / 100) / 10} 秒后跳入）`
        : "就位"}` +
      `（星系 ${systemID} · 军团 ${affiliation.corporationID || "血统默认"}）`,
    );
    return {ok: deployed > 0, lines};
  }

  /**
   * 入场方式（config.js 已把 arrival 归一化成 warp/cyno/instant）。
   * 老写法兜底：warpIn=false 等于 instant；其余等于 warp。
   */
  function resolveArrivalMode(behavior) {
    const text = String((behavior && behavior.arrival) || "").trim().toLowerCase();
    if (text === "cyno" || text === "instant" || text === "warp") {
      return text;
    }
    return behavior && behavior.warpIn === false ? "instant" : "warp";
  }

  /** 离场方式（解散时）：jump 诱导跳走 / warp 真跃迁飞离。默认跳走。 */
  function resolveDepartureMode(config) {
    const text = String((config && config.behavior && config.behavior.departure) || "").trim().toLowerCase();
    return text === "warp" ? "warp" : "jump";
  }

  // 手上亮着的诱导力场。场景不会自己收非库存实体（cynoField 不进过期索引，
  // 第一版就是信了 expiresAtMs，结果灯亮着不走），所以必须自己定时摘。
  const litCynoFields = new Map(); // entityID -> {entityID, scene, systemID}

  function removeCynoField(entry, why) {
    const entityID = Number(entry && entry.entityID) || 0;
    if (!entityID) {
      return false;
    }
    litCynoFields.delete(entityID);
    const scene = entry.scene;
    if (!scene || typeof scene.removeDynamicEntity !== "function") {
      return false;
    }
    try {
      scene.removeDynamicEntity(entityID, {broadcast: true});
      return true;
    } catch (error) {
      log(`[cyno] 力场 ${entityID} 收不掉（${error && error.message}）${why ? `：${why}` : ""}`);
      return false;
    }
  }

  /**
   * Which corporation a new crew member starts in:
   *   "auto"    the player's own corporation (and its alliance)
   *   "none"    keep the bloodline starter corporation
   *   <number>  that corporation, preferring its own alliance
   */
  function resolveAffiliation(config, session) {
    const playerCharacterID = Number(session && session.characterID) || 0;
    let record = null;
    try {
      record = playerCharacterID && deps.characterState
        && typeof deps.characterState.peekCharacterRecord === "function"
        ? deps.characterState.peekCharacterRecord(playerCharacterID)
        : null;
    } catch (_error) {
      record = null;
    }
    const playerCorporationID = Number(record && record.corporationID) || 0;
    let playerAllianceID = Number(record && record.allianceID) || 0;
    const setting = config && config.corporation !== undefined ? config.corporation : "auto";
    if (setting === "none") {
      return {corporationID: 0, allianceID: 0, source: "none"};
    }
    if (setting === "auto" || !Number(setting)) {
      return {
        corporationID: playerCorporationID,
        allianceID: playerAllianceID,
        source: "player",
      };
    }
    const corporationID = Math.trunc(Number(setting)) || 0;
    if (corporationID !== playerCorporationID && deps.corporations
      && typeof deps.corporations.getCorporationRecord === "function") {
      try {
        const corp = deps.corporations.getCorporationRecord(corporationID);
        playerAllianceID = Number(corp && corp.allianceID) || 0;
      } catch (_error) {
        /* keep the player's alliance as a fallback */
      }
    }
    return {corporationID, allianceID: playerAllianceID, source: "configured"};
  }

  // Last approach command result per character, so /crewmine debug can show it.
  const lastApproach = new Map();

  /**
   * Diagnostics: what the drive actually sees for each summoned crew member.
   * Added because in-game "no mining" is otherwise invisible.
   */
  function debugCrew(selector, context = {}) {
    const session = context.session || null;
    const systemID = currentSystemID(session);
    const playerShipID = Number(session && session._space && session._space.shipID) || 0;
    const selected = selectMembers(selector, context);
    const pool = stateStore.get().pool || [];
    const lines = [
      `诊断 · 星系 ${systemID || "—"} · 你的船 ${playerShipID || "—"} · 本星系在役 ${selected.members.length} 人` +
      `${selected.skipped > 0 ? `（跳过 ${selected.skipped} 人）` : ""}`,
    ];
    const configsList = configStore.get().configs || [];
    for (const config of configsList) {
      lines.push(
        `配装 ${config.id}：arrival=${resolveArrivalMode(config.behavior)}` +
        `（warpIn=${config.behavior.warpIn} warpInAu=${config.behavior.warpInAu}` +
        ` cynoLeadMs=${config.behavior.cynoLeadMs} cynoRadiusMeters=${config.behavior.cynoRadiusMeters}）` +
        ` departure=${resolveDepartureMode(config)}` +
        ` 选矿=${Math.round(config.behavior.mineSearchRadiusMeters / 1000)}km` +
        ` 射程=${Math.round(config.behavior.mineEngageRangeMeters / 1000)}km`,
      );
    }
    const scene = follow.sceneFor(deps, session);
    const playerEntity = playerShipID ? follow.locate(deps, {session, shipID: playerShipID}).entity : null;
    for (const member of selected.members) {
      const entity = scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(member.shipID)
        : null;
      const config = configForBlueprint(member.blueprintID);
      const head = `${member.name} (${member.characterID}) · 船 ${member.shipID} · ` +
        `配装 ${member.blueprintID || "?"}`;
      if (!entity) {
        lines.push(`${head} · 实体✗（不在场景）`);
        continue;
      }
      const distanceToPlayer = playerEntity ? Math.round(mining.surfaceDistance(playerEntity, entity) / 1000) : null;
      const rock = mining.pickRock({
        scene,
        // Measure from the CREW ship: that is what the module range applies to.
        sourceEntity: entity,
        maxDistanceMeters: config ? config.behavior.mineSearchRadiusMeters : 150000,
        miningState: deps.miningState,
      });
      const modules = mining.miningModules(deps, {characterID: member.characterID, shipID: member.shipID});
      const range = mining.moduleRange(modules.modules);
      const active = entity.activeModuleEffects instanceof Map
        ? [...entity.activeModuleEffects.entries()].map(([id, effect]) => `${id}→${effect && effect.targetID}`)
        : [];
      const approach = lastApproach.get(Number(member.characterID)) || null;
      lines.push(
        `${head} · mode=${entity.mode || "?"} · 距你 ${distanceToPlayer == null ? "—" : `${distanceToPlayer} km`}`,
      );
      lines.push(
        `  目标 ${rock ? `${rock.entity.itemID}（船员面距 ${Math.round(rock.distance / 1000)} km` +
          `${playerEntity ? ` · 你面距 ${Math.round(mining.surfaceDistance(playerEntity, rock.entity) / 1000)} km` : ""}）` : "无"}` +
        ` · 射程 ${range > 0 ? `${Math.round(range / 1000)} km` : "未知→15 km"}`,
      );
      lines.push(
        `  模块 ${modules.modules.length} 个可用` +
        `${modules.problems.length > 0 ? ` · ${modules.problems.join(" ")}` : ""}` +
        ` · 已激活 ${active.length > 0 ? active.join(", ") : "无"}`,
      );
      try {
        const rawItems = deps.itemStore && typeof deps.itemStore.listContainerItems === "function"
          ? deps.itemStore.listContainerItems(member.characterID, member.shipID) || []
          : [];
        const detail = rawItems.slice(0, 6).map((item) => {
          const state = item && item.moduleState;
          return `${item.itemID}/t${item.typeID}/f${item.flagID}${state ? `/on${state.online === true ? 1 : 0}` : "/noState"}`;
        });
        lines.push(`  舱内 ${rawItems.length} 行${detail.length > 0 ? `：${detail.join(" ")}` : ""}`);
      } catch (_error) {
        lines.push("  舱内明细读取失败");
      }
      const inventory = mining.rockInventory({
        scene,
        sourceEntity: playerEntity || entity,
        miningState: deps.miningState,
        maxDistanceMeters: config ? config.behavior.mineSearchRadiusMeters : 150000,
      });
      const hold = holdVolumeOf(deps, {characterID: member.characterID, shipID: member.shipID, config});
      lines.push(
        `  占用 ${Math.round(hold.used)} / ${Math.round(hold.capacity) || "?"} m³` +
        ` · 阈值 ${Number(config && config.behavior.deliverStopPercent) || 80}%`,
      );
      lines.push(
        `  场景静态实体 ${inventory.statics} 个 · 小行星 ${inventory.rocks} 个` +
        `（有矿 ${inventory.mineable} · 状态未知 ${inventory.unknown}） · ` +
        `半径内 ${inventory.inRange} 个 · 最近的 ` +
        `${inventory.nearestMineableMeters == null ? "无" : `${Math.round(inventory.nearestMineableMeters / 1000)} km`}`,
      );
      lines.push(
        `  接近指令 ${approach ? `${approach.at} · ${approach.result}` : "未下发"}`,
      );
    }
    if (lastRetarget) {
      lines.push(
        `自动重新选矿：${lastRetarget.at} · ${lastRetarget.name} · ` +
        `当时目标 ${lastRetarget.targets} 个 · ${lastRetarget.lines.join(" | ")}`,
      );
    }
    lines.push(
      lastService
        ? `服务循环：最近一次 ${lastService.at} · ${lastService.ok ? "有动作" : "无动作"}` +
          `${lastService.error ? ` · 错误 ${lastService.error}` : ""}` +
          `${lastService.lines.length > 0 ? ` · ${lastService.lines.join(" | ")}` : ""}`
        : "服务循环：还没跑过（mine all 之后每 15 秒一次）",
    );
    const summoned = pool.filter((entry) => entry.summoned === true).length;
    lines.push(`池 ${pool.length} 人，在役 ${summoned} 人`);
    return {ok: true, lines};
  }

  // M9: which target each crew ship is shooting at (characterID -> itemID), and which
  // ships mirror the commander's own target instead of a fixed one.
  const combatTargets = new Map();
  // O5：没有候选目标后的扫描冷却（per crew），避免每秒全场景重扫。
  const scanCooldownUntil = new Map();
  const combatFollowers = new Set();

  /** Whatever the commander is attacking right now (his active module target, else lock). */
  function commanderTargetID(scene, session) {
    try {
      const shipID = Number(session && session._space && session._space.shipID) || 0;
      const entity = shipID && scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(shipID)
        : null;
      if (!entity) {
        return 0;
      }
      if (entity.activeModuleEffects instanceof Map) {
        for (const state of entity.activeModuleEffects.values()) {
          const targetID = combat.positive(state && state.targetID);
          if (targetID) {
            return targetID;
          }
        }
      }
      // Deliberately NOT falling back to the lock list: a locked target the commander has
      // not opened fire on is not an order. Only active weapon effects count.
    } catch (_error) {
      return 0;
    }
    return 0;
  }

  // Cached per crew ship: which defensive modules it carries.
  const defensePlans = new Map();
  // Debug mode: only the log verbosity changes. It must never alter what the crew does.
  let debugMode = false;
  const moduleLogAt = new Map();
  // One warning per crew until the situation changes: the defense scan runs every tick,
  // so an unconditional line produced one message every 10 s per ship.
  const defenseEmptyWarned = new Set();
  const defenseNoEntityWarned = new Set();
  // Debug behaviour trace: last activity label per crew ship.
  const crewBehaviorSeen = new Map();

  function defenseModulesFor(member) {
    const crewID = Number(member && member.characterID) || 0;
    if (!crewID) {
      return [];
    }
    // Only a NON-empty plan is cached: when the fit was not readable yet (ship still
    // being built, store not flushed) an empty cache would stick forever.
    const cached = defensePlans.get(crewID);
    if (Array.isArray(cached) && cached.length > 0) {
      return cached;
    }
    const plan = defense.defenseModules(deps, {characterID: crewID, shipID: member.shipID});
    const modules = Array.isArray(plan.modules) ? plan.modules : [];
    // Propulsion must go through activatePropulsionModule with the right effect name,
    // otherwise the engine registers an effect with no speed semantics (the UI lights up
    // but the ship does not gain the MWD/AB bonus).
    for (const entry of modules) {
      if (entry.kind !== "propulsion" || entry.effectName) {
        continue;
      }
      const typeID = Number(entry.moduleItem && entry.moduleItem.typeID) || 0;
      if (typeID <= 0) {
        continue;
      }
      let massAddition = 0;
      try {
        const dogma = sde.loadDogmaAttributes([typeID]).get(typeID);
        massAddition = dogma && typeof dogma.get === "function" ? Number(dogma.get(796)) || 0 : 0;
      } catch (_error) {
        massAddition = 0;
      }
      entry.effectName = massAddition > 0 ? "moduleBonusMicrowarpdrive" : "moduleBonusAfterburner";
    }
    if (modules.length > 0) {
      defensePlans.set(crewID, modules);
    } else {
      defensePlans.delete(crewID);
    }
    return modules;
  }

  /** Keep hardeners on and boosters pulsing while this ship is in combat. */
  /** 交火/工作意义上的"在跑模块"数（常开的抗性影子状态不算）。 */
  function runningModuleCount(entity) {
    const effects = entity && entity.activeModuleEffects;
    if (!(effects instanceof Map) || effects.size === 0) {
      return 0;
    }
    let count = 0;
    for (const state of effects.values()) {
      if (state && state.passiveHardener === true) {
        continue;
      }
      count += 1;
    }
    return count;
  }

  /**
   * O2：在进入 manageDefense 之前先做一次廉价预判——没有模块需要开/关就直接跳过，
   * 省掉每 2 秒一次的空转（真正贵的是激活，不是判断）。
   */
  function defenseNeedsAttention(modules, entity, behavior, distanceToLeader) {
    const shield = Number(defense.shieldRatioOf(entity)) || 0;
    const armor = Number(defense.armorRatioOf(entity)) || 0;
    const cap = Number(defense.capRatioOf(entity)) || 0;
    const shieldStart = Number(behavior.shieldBoosterThreshold) || 0.6;
    const shieldStop = Number(behavior.shieldBoosterStopThreshold) || 0.9;
    const armorStart = Number(behavior.armorRepairerThreshold) || 0.7;
    const armorStop = Number(behavior.armorRepairerStopThreshold) || 0.95;
    const capStart = Number(behavior.capBoosterThreshold) || 0.3;
    const farMeters = Number(behavior.propulsionFarMeters) || 20000;
    const offMeters = Number(behavior.propulsionOffMeters) || 15000;
    const capFloor = Number(behavior.propulsionCapThreshold) || 0.15;
    const effects = entity && entity.activeModuleEffects instanceof Map ? entity.activeModuleEffects : null;
    for (const entry of modules) {
      const moduleItem = entry && entry.moduleItem;
      const moduleID = Number(moduleItem && moduleItem.itemID) || 0;
      const running = Boolean(effects && moduleID && effects.has(moduleID));
      // S2：结算不产生 effectState（模块从不激活），所以"正在修"要另外问一句锁存，
      // 否则血量一超过启动阈值就被这个预检挡在门外 —— 表现就是"刚过 60% 就停了"。
      const settlingKind = entry.kind === "shieldBooster" || entry.kind === "armorRepairer";
      const engaged = running || (settlingKind
        && typeof defense.isModuleLatched === "function"
        && defense.isModuleLatched(moduleID, entity) === true);
      if (entry.kind === "shieldBooster" && (engaged ? shield < shieldStop : shield < shieldStart)) {
        return true;
      }
      // 关掉“抗性常开”时才需要真激活增强器；常开模式走影子状态，不需要动。
      if (entry.kind === "hardener" && behavior.passiveHardeners === false) {
        return true;
      }
      if (entry.kind === "armorRepairer" && (engaged ? armor < armorStop : armor < armorStart)) {
        return true;
      }
      if (entry.kind === "capBooster" && cap < capStart) {
        return true;
      }
      if (entry.kind === "guidanceComputer" && !running) {
        return true;
      }
      if (entry.kind === "propulsion") {
        if (behavior.propulsionEnabled === false) {
          if (running) {
            return true; // 需要关掉
          }
          continue;
        }
        if (running) {
          // 和 manageDefense 同一条判定：距离近到阈值内或电容低，都该关。
          if (!(distanceToLeader > offMeters && cap > capFloor)) {
            return true;
          }
        } else if (distanceToLeader > farMeters && cap > capFloor) {
          return true;
        }
      }
    }
    return false;
  }

  function runDefenseFor(scene, session, member, entity) {
    // 归因用：一进来就挂一张空表，早退时留下的也是"已经花掉的时间"（见调用点的慢日志）。
    const breakdown = {};
    const markDefense = (name, startedAt) => {
      breakdown[name] = (breakdown[name] || 0) + (Date.now() - startedAt);
    };
    defenseBreakdown.set(Number(member && member.characterID) || 0, breakdown);
    const passInfo = {};
    defensePassInfo.set(Number(member && member.characterID) || 0, passInfo);
    // Nothing may be activated while the hull is in warp: the engine rejects it and the
    // attempts only produce noise.
    if (entity && String(entity.mode || "").toUpperCase() === "WARP") {
      if (debugMode) {
        const key = Number(member.characterID) || 0;
        const now = Date.now();
        if (now - (moduleLogAt.get(key) || 0) > 10000) {
          moduleLogAt.set(key, now);
          log(`[defense] ${member.name} 正在跃迁，跳过装备管理`);
        }
      }
      return null;
    }
    const modulesStartedAt = Date.now();
    const modules = defenseModulesFor(member);
    markDefense("modules", modulesStartedAt);
    if (modules.length === 0) {
      const key = Number(member.characterID) || 0;
      if (debugMode && !defenseEmptyWarned.has(key)) {
        defenseEmptyWarned.add(key);
        log(`[defense] ${member.name} 装配里没有防御类装备（增强器/注电器/回充器/推进器），不再重复提示`);
      }
      return null;
    }
    // Modules showed up again: allow a fresh warning if they disappear later.
    defenseEmptyWarned.delete(Number(member.characterID) || 0);
    if (!entity) {
      const key = Number(member.characterID) || 0;
      if (debugMode && !defenseNoEntityWarned.has(key)) {
        defenseNoEntityWarned.add(key);
        log(`[defense] ${member.name} 船不在场景里，跳过装备管理（不再重复提示）`);
      }
      return null;
    }
    defenseNoEntityWarned.delete(Number(member.characterID) || 0);
    const ammoStartedAt = Date.now();
    for (const entry of modules.filter((item) => item.kind === "capBooster")) {
      combat.ensureAmmoLoaded(deps, {
        characterID: Number(member.characterID) || 0,
        shipID: member.shipID,
        modules: [entry],
      });
    }
    markDefense("ammo", ammoStartedAt);
    const behavior = configs_behavior();
    // PLAN §17 P3：增强器"抗性常开"——把影子 effect 写进实体再让引擎重算一次，
    // 之后不激活、不扣电、不再逐门重算。幂等：已经写好就什么都不做。
    const hardenStartedAt = Date.now();
    if (behavior.passiveHardeners !== false) {
      const hardeners = modules.filter((entry) => entry.kind === "hardener");
      passInfo.hardeners = hardeners.length;
      if (hardeners.length > 0) {
        const passive = defense.applyPassiveHardeners(scene, entity, hardeners, {
          deps,
          nowMs: now(),
        });
        passInfo.applied = Number(passive.applied) || 0;
        passInfo.refreshed = passive.refreshed === true;
        // 这行只在"影子状态又不在、重新写了一遍"时出现 —— 正是判断抗性常开会不会被引擎
        // 反复抹掉的信号（每次都会跟着一次 0.7–1.5 s 的 refreshShipEntityDerivedState）。
        // 之前它被 debugMode 挡住了，现在放开（按 2 s 节流，量可控）。
        if (passive.refreshed) {
          log(`[defense] ${member.name} 抗性常开：${passive.applied} 个增强器并入快照`);
        }
      }
    }
    markDefense("harden", hardenStartedAt);
    let distanceToLeader = 0;
    try {
      const leaderShipID = Number(session && session._space && session._space.shipID) || 0;
      const leader = leaderShipID ? scene.getEntityByID(leaderShipID) : null;
      if (leader) {
        distanceToLeader = combat.surfaceDistance(entity, leader);
      }
    } catch (_error) {
      distanceToLeader = 0;
    }
    // O2：没有模块需要开/关时直接返回，省掉一次无意义的 manageDefense。
    const attentionStartedAt = Date.now();
    const needsAttention = defenseNeedsAttention(modules, entity, behavior, distanceToLeader);
    markDefense("attention", attentionStartedAt);
    passInfo.needed = needsAttention === true;
    if (!needsAttention) {
      return null;
    }
    const manageStartedAt = Date.now();
    const result = defense.manageDefense({
      scene,
      session: mining.moduleSessionFor(session, Number(member.characterID) || 0, entity),
      entity,
      modules,
      distanceToLeader,
      propulsionEnabled: behavior.propulsionEnabled !== false,
      propulsionFarMeters: behavior.propulsionFarMeters,
      propulsionOnMeters: behavior.propulsionOnMeters,
      propulsionOffMeters: behavior.propulsionOffMeters,
      propulsionCapThreshold: behavior.propulsionCapThreshold,
      capBoosterThreshold: behavior.capBoosterThreshold,
      shieldBoosterThreshold: behavior.shieldBoosterThreshold,
      shieldBoosterStopThreshold: behavior.shieldBoosterStopThreshold,
      armorRepairerThreshold: behavior.armorRepairerThreshold,
      armorRepairerStopThreshold: behavior.armorRepairerStopThreshold,
      // O1：回充器/修甲用 repeat=1 常驻循环；O2：每 tick 最多 1 次激活。
      defenseRepeatModules: behavior.defenseRepeatModules !== false,
      maxActivations: Number(behavior.defenseMaxActivations) || 1,
      // P3：增强器已并入被动快照，manageDefense 不再激活它们。
      passiveHardeners: behavior.passiveHardeners !== false,
      // S2：修甲/回盾走"算一次、写层值"，不再逐模块激活（省掉每次 0.5–1.1 s 重算）。
      settle: behavior.defenseSettlement !== false,
      crewKey: Number(member.characterID) || 0,
      nowMs: now(),
      settleState: defenseSettleState,
      attributeSnapshotFor: (moduleItem) => remoteAttributeSnapshotFor(member, entity, moduleItem),
      attributeIdFor: (key) => remoteAttributeId(key),
      payCapacitor: (capNeed) => payRemoteCapacitor(entity, capNeed),
      broadcastSettleFx: (kind, moduleItem, durationMs) => {
        const guid = kind === "shieldBooster" ? "effects.ShieldBoosting" : "effects.ArmorRepair";
        fxBroadcast.broadcastModuleFx(scene, entity, {
          guid,
          moduleID: Number(moduleItem && moduleItem.itemID) || null,
          moduleTypeID: Number(moduleItem && moduleItem.typeID) || null,
          duration: durationMs,
          repeat: 0,
        });
      },
    });
    markDefense("manage", manageStartedAt);
    if (result) {
      passInfo.activated = Array.isArray(result.activated) ? result.activated.length : 0;
      passInfo.stopped = Array.isArray(result.stopped) ? result.stopped.length : 0;
    }
    // Defensive/propulsion state changes are logged: without this the only way to know a
    // hardener or an MWD switched was to guess.
    try {
      // Equipment logging exists for debugging only: with debug off the crew stays silent.
      if (debugMode && result && (result.activated.length > 0 || result.stopped.length > 0 || result.errors.length > 0)) {
        const kindOf = new Map(modules.map((entry) => [Number(entry.moduleItem && entry.moduleItem.itemID) || 0, entry.kind]));
        // 决策值（当时为什么开/关）与当前值（现在多少）分开：以前只打当前值，
        // 于是出现"护盾 67% < 60%"这种自相矛盾的日志。
        const decision = (result && result.ratios) || {};
        const capPct = Math.round((Number(entity && entity.capacitorChargeRatio) || 0) * 100);
        const shieldPct = Math.round((Number(decision.shield) || 0) * 100);
        const shieldNowPct = Math.round((Number(entity && entity.conditionState && entity.conditionState.shieldCharge) || 0) * 100);
        const armorPct = Math.round((Number(decision.armor) || 0) * 100);
        const farMeters = Number(behavior.propulsionFarMeters) || 20000;
        const capFloor = Number(behavior.propulsionCapThreshold) || 0.15;
        const boostFloor = Number(behavior.shieldBoosterThreshold) || 0.6;
        // Every state change states WHY, not just what: a bare "推进器开" leaves the
        // reader guessing whether it was distance, capacitor or a hardener.
        const reasonFor = (id, verb) => {
          const kind = kindOf.get(id) || "module";
          const km = Number.isFinite(Number(distanceToLeader)) ? Math.round(distanceToLeader / 1000) : null;
          if (kind === "propulsion") {
            if (verb === "开") {
              return `推进器开（距离 ${km === null ? "未知" : km + "km"} > ${Math.round(farMeters / 1000)}km，电容 ${capPct}% > ${Math.round(capFloor * 100)}%）`;
            }
            const why = [];
            if (km !== null && distanceToLeader <= farMeters) why.push(`距离 ${km}km ≤ ${Math.round(farMeters / 1000)}km`);
            if (capPct <= Math.round(capFloor * 100)) why.push(`电容 ${capPct}% ≤ ${Math.round(capFloor * 100)}%`);
            if (why.length === 0) why.push("调试模式已关且蓝图未启用");
            return `推进器关（${why.join("，")}）`;
          }
          if (kind === "capBooster") {
            return verb === "开"
              ? `电容注电器开（电容 ${capPct}% < ${Math.round((Number(behavior.capBoosterThreshold) || 0.3) * 100)}%）`
              : `电容注电器关（电容 ${capPct}% 已回充）`;
          }
          if (kind === "shieldBooster") {
            const stopFloor = Math.round((Number(decision.shieldStop) || 0.9) * 100);
            return verb === "开"
              ? `护盾回充器开（护盾 ${shieldPct}% < ${Math.round(boostFloor * 100)}%）`
              : `护盾回充器关（护盾 ${shieldPct}% ≥ ${stopFloor}%，现在 ${shieldNowPct}%）`;
          }
          if (kind === "armorRepairer") {
            const repairFloor = Math.round((Number(behavior.armorRepairerThreshold) || 0.7) * 100);
            const stopFloor = Math.round((Number(decision.armorStop) || 0.95) * 100);
            return verb === "开"
              ? `装甲维修器开（装甲 ${armorPct}% < ${repairFloor}%）`
              : `装甲维修器关（装甲 ${armorPct}% ≥ ${stopFloor}%）`;
          }
          return verb === "开" ? "增强器开（常开）" : "增强器关（停火）";
        };
        const parts = [];
        for (const id of result.activated) {
          parts.push(reasonFor(id, "开"));
        }
        for (const id of result.stopped) {
          parts.push(reasonFor(id, "关"));
        }
        if (parts.length > 0) {
          log(`[defense] ${member.name} ${parts.join(" · ")} · 距离=${Math.round(distanceToLeader / 1000)}km 电容=${capPct}%`);
        }
        if (debugMode && result.skipped.length > 0) {
          const key = Number(member.characterID) || 0;
          const now = Date.now();
          if (now - (moduleLogAt.get(key) || 0) > 10000) {
            moduleLogAt.set(key, now);
            // 只报"真的有原因"的模块；没有原因的（只是没到阈值）不再每 10 秒写一行。
            const reasons = modules.map((entry) => {
              if (entry.kind !== "propulsion") {
                return "";
              }
              const off = [];
              if (behavior.propulsionEnabled === false) off.push("蓝图 propulsionEnabled=false");
              if (distanceToLeader <= farMeters) off.push(`距离 ${Math.round(distanceToLeader / 1000)}km ≤ ${Math.round(farMeters / 1000)}km`);
              if (capPct <= Math.round(capFloor * 100)) off.push(`电容 ${capPct}% ≤ ${Math.round(capFloor * 100)}%`);
              return off.length ? "推进器：不启用（" + off.join("，") + "）" : "";
            }).filter(Boolean);
            if (reasons.length > 0) {
              log(`[defense] ${member.name} ${reasons.join(" | ")} · 距离=${Math.round(distanceToLeader / 1000)}km 电容=${capPct}%`);
            }
          }
        }
        for (const error of result.errors) {
          log(`[defense] ${member.name} 模块失败 ${error}`);
        }
      }
    } catch (_error) {
      /* logging must never break the loop */
    }
    return result;
  }

  /**
   * Lock + open fire with one crew ship on one target. Idempotent: a ship already firing
   * at that target costs nothing, a ship firing elsewhere is re-targeted.
   */
  function engageMember(scene, session, member, targetID, steps) {
    const crewID = Number(member && member.characterID) || 0;
    const entity = scene && typeof scene.getEntityByID === "function" ? scene.getEntityByID(member && member.shipID) : null;
    if (!entity) {
      return {ok: false, reason: "船不在场景里"};
    }
    if (String(entity.mode || "").toUpperCase() === "WARP") {
      return {ok: false, reason: "正在跃迁"};
    }
    const target = scene.getEntityByID(targetID);
    if (!target) {
      return {ok: false, reason: "目标 " + targetID + " 不在当前星系"};
    }
    const weaponsAt = Date.now();
    const resolved = combat.weaponModules(deps, {characterID: crewID, shipID: member.shipID});
    engagePhaseEnd(steps, "combat.engage.weapons", weaponsAt);
    if (!resolved.ok) {
      // P3：没武器的船不必每次跑完整武器流程（以前每 10 秒一条 NO_WEAPON_MODULE_ONLINE）。
      // 记在缓存里，交给调用方决定要不要继续；吸电/中和现在会自己挑目标。
      noWeaponShips.set(crewID, now());
      // 每 60 秒最多解释一次「为什么不开火」，并列出装了什么。
      // 后勤船（只带遥修/指挥脉冲）没必要每分钟说一遍：10 分钟一次就够。
      const loggedAt = Number(noWeaponLoggedAt.get(crewID)) || 0;
      const supportOnly = isSupportShip(member);
      const diagnoseEveryMs = supportOnly ? 600000 : 60000;
      if (now() - loggedAt >= diagnoseEveryMs) {
        noWeaponLoggedAt.set(crewID, now());
        log(`[combat] ${member.name} ` + (supportOnly ? "是后勤船（只带遥修/指挥脉冲），不参与开火：" : "没有可用的武器：")
          + describeFittingForNoWeapon(member));
      }
      return {ok: false, reason: resolved.problems.join(" · "), noWeapons: true};
    }
    noWeaponShips.delete(crewID);
    noWeaponLoggedAt.delete(crewID);
    // Imported fittings keep their ammo in the cargo hold; the engine only counts a charge
    // as loaded when it sits on the module's own flag, so move a compatible stack first.
    // This scans the whole hold, so it runs at most every 10 s per ship.
    let ammo = {loaded: 0, already: resolved.modules.length, problems: []};
    const ammoAt = Date.now();
    if (now() - (lastAmmoCheckAt.get(crewID) || 0) >= 10000) {
      lastAmmoCheckAt.set(crewID, now());
      ammo = combat.ensureAmmoLoaded(deps, {characterID: crewID, shipID: member.shipID, modules: resolved.modules});
    }
    engagePhaseEnd(steps, "combat.engage.ammo", ammoAt);
    if (ammo.loaded > 0) {
      log("[combat] " + member.name + " 从货舱装填弹药 " + ammo.loaded + " 门");
    }
    if (ammo.problems.length > 0 && ammo.loaded === 0 && ammo.already === 0) {
      return {ok: false, reason: "没有可用弹药（" + ammo.problems.join(" · ") + "）"};
    }
    const rangeAt = Date.now();
    const baseRange = resolved.modules.reduce((best, entry) => Math.max(best, Number(entry && entry.rangeMeters) || 0), 0);
    // 基础射程（effect record）吃不到会战/后勤对射程的加成，所以再用带修正的快照算一次；
    // 结果按 (crewID, 30 秒) 缓存，避免每次交战都跑一遍 dogma。
    let range = baseRange;
    const effAt = Number(effectiveRangeAt.get(crewID)) || 0;
    const effCached = effectiveRangeCache.get(crewID);
    if (!effCached || now() - effAt >= 30000) {
      const eff = combat.effectiveRangeMeters(deps, {
        characterID: crewID,
        shipID: member.shipID,
        modules: resolved.modules,
        attackerEntity: entity,
      });
      if (eff && eff.ok && Number(eff.rangeMeters) > 0) {
        effectiveRangeCache.set(crewID, Number(eff.rangeMeters));
        effectiveRangeAt.set(crewID, now());
        range = Math.max(baseRange, Number(eff.rangeMeters));
      }
    } else {
      range = Math.max(baseRange, Number(effCached) || 0);
    }
    engagePhaseEnd(steps, "combat.engage.range", rangeAt);
    const distance = combat.surfaceDistance(entity, target);
    // 带导弹的船不能按炮台的射程一刀切：导弹射程通常远得多，交给齐射逐组判定。
    const hasMissiles = resolved.modules.some((entry) => entry && entry.isMissile === true);
    if (!hasMissiles && range > 0 && distance > range) {
      return {
        ok: false,
        // outOfRange 让上层决定要不要追近（面板「追击」开着时 startChase 会用 rangeMeters）。
        outOfRange: true,
        rangeMeters: range,
        reason: "目标在射程外（" + Math.round(distance / 1000) + " km > " + Math.round(range / 1000) + " km）",
        distance,
      };
    }
    const lock = combat.ensureTargetLock({scene, entity, target, instant: instantLockEnabled()});
    if (!lock.ok) {
      return {ok: false, reason: "锁定失败（" + lock.reason + "）"};
    }
    if (!lock.locked) {
      combatTargets.set(crewID, targetID);
      if (debugMode) {
        log(`[combat] ${member.name} 锁定中 ${targetID}（${Math.round(lock.lockDurationMs / 1000)} 秒）`);
      }
      return {ok: true, pending: true, reason: "锁定中（" + Math.round(lock.lockDurationMs / 1000) + " 秒）", distance};
    }
    // Player-style volley: one calculation per weapon type, damage x turret count, capacitor
    // charged per turret. Falls back to per-module activation when disabled.
    const behaviorNow = configs_behavior();
    // Volley settlement needs the engine damage APIs; on a build without them fall back to
    // per-module activation instead of silently not firing.
    const salvoInterop = (deps && deps.runtime && deps.runtime.droneInterop) || {};
    const salvoApiReady = Boolean(deps
      && deps.weaponDogma && typeof deps.weaponDogma.buildWeaponModuleSnapshot === "function"
      && typeof salvoInterop.resolveTurretShot === "function"
      && typeof salvoInterop.applyWeaponDamageToTarget === "function");
    const salvoEnabled = behaviorNow.weaponSalvo !== false && salvoApiReady;
    if (salvoEnabled) {
      const nextAt = Number(salvoNextAt.get(crewID)) || 0;
      if (now() < nextAt) {
        return {ok: true, activated: 0, pending: true, reason: "冷却中", distance};
      }
      // P0：电容不够就别结算。以前是算完 8 门伤害、发完特效，再报 NOT_ENOUGH_CAPACITOR——
      // 实测一场 8 舰战斗里 70% 的齐射都是这种白算，直接把事件循环占满。
      // 开销用上一轮的真实值（还没打过就放行一次，用它学出成本）。
      const capCost = Number(salvoCapCost.get(crewID)) || 0;
      const capNow = capacitorAmountOf(entity);
      if (capCost > 0 && capNow !== null && capNow < capCost) {
        const loggedAt = Number(capShortLoggedAt.get(crewID)) || 0;
        if (now() - loggedAt >= 10000) {
          capShortLoggedAt.set(crewID, now());
          log(`[combat] ${member.name} 电容不足（${Math.round(capNow)} < ${Math.round(capCost)}），等回充再打`);
        }
        return {ok: true, activated: 0, pending: true, reason: "电容不足", distance};
      }
      // P1：齐射按船轮转，把一拍内的结算量摊到多拍（预算见 configs）。
      if (!salvoTurnFor(crewID)) {
        return {ok: true, activated: 0, pending: true, reason: "轮转中", distance};
      }
      const isNewTarget = Number(combatTargets.get(crewID)) !== Number(targetID);
      if (isNewTarget) {
        const info = describeTarget(scene, entity, targetID);
        log(`[combat] ${member.name} 锁定 ${info ? info.name : targetID}` +
          `${info && info.hullName && info.hullName !== info.name ? "（" + info.hullName + "）" : ""}` +
          `${info && info.distance != null ? " · " + Math.round(info.distance / 1000) + " km" : ""}`);
      }
      const volleyAt = Date.now();
      const volley = salvo.fireVolley(deps, {
        scene,
        characterID: crewID,
        shipID: member.shipID,
        attacker: entity,
        target,
        modules: resolved.modules,
        nowMs: now(),
        // 导弹/鱼雷齐射是否发一枚零伤害的表现球（蓝图 behavior.missileEntity，默认开）。
        missileFx: behaviorNow.missileEntity !== false,
        steps,
      });
      // 火力集中：把这一轮真实耗时记进"本拍已用"，安全阀按它来判断要不要顺延。
      if (focusFire) {
        focusTickSpentMs += Math.max(0, Date.now() - volleyAt);
      }
      engagePhaseEnd(steps, "combat.engage.volley", volleyAt);
      const cycle = Math.max(1000, Number(volley.cycleMs) || 0);
      salvoNextAt.set(crewID, now() + cycle);
      // 记下这一轮的实际电容开销，下一轮开打前用它做预检。
      if (Number(volley.capacitor) > 0) {
        salvoCapCost.set(crewID, Number(volley.capacitor));
      }
      if (Number(volley.fx) > 0) {
        broadcastVolleyFx(scene, entity, targetID, volley);
      }
      if (Number(volley.applied) > 0) {
        // S2/R4: 击伤即入名单 — the man we just hurt (and his corporation) becomes hostile.
        noteGrudgeHit(target, session);
      }
      if (Number(volley.missiles) > 0 || Number(volley.outOfRange) > 0) {
        // 导弹现在有零伤害的实体球（画面），但伤害仍是齐射结算；日志里同时报"算了几发"和"发了几枚"。
        const at = Number(volleyLoggedAt.get(crewID)) || 0;
        if (now() - at >= 10000) {
          volleyLoggedAt.set(crewID, now());
          log(`[combat] ${member.name} 齐射 ${volley.turrets} 门`
            + (Number(volley.missiles) > 0
              ? `（导弹 ${volley.missiles} 发${Number(volley.launches) > 0 ? "，已发射" : ""}）`
              : "")
            + ` · ${Math.round(volley.applied)} 伤害`
            + (Number(volley.outOfRange) > 0
              ? ` · 射程外 ${volley.outOfRange} 组（目标 ${Math.round((Number(volley.distanceMeters) || 0) / 1000)} km > 武器 ${Math.round((Number(volley.rangeMeters) || 0) / 1000)} km）`
              : ""));
        }
      } else if (debugMode) {
        log(`[combat] ${member.name} 齐射 ${volley.turrets} 门 · ${Math.round(volley.applied)} 伤害` +
          ` · 电容 ${Math.round(volley.capacitor)}` +
          `${volley.problems.length > 0 ? " · " + volley.problems.join(",") : ""}`);
      }
      if (!volley.ok) {
        // 全部炮组都判定未命中不算故障：turret 0 门、problems 为空，以前这里只能
        // 写"齐射失败（未知）"，把一次正常打空记成了异常。
        const outOfRangeOnly = volley.turrets === 0 && Number(volley.outOfRange) > 0;
        const reason = volley.turrets === 0 && Number(volley.missed) > 0
          ? "齐射未命中（全部打空）"
          : volley.turrets === 0 && Number(volley.outOfRange) > 0
            ? `目标在射程外（${Math.round((Number(volley.distanceMeters) || 0) / 1000)} km > 武器 ${Math.round((Number(volley.rangeMeters) || 0) / 1000)} km，${volley.outOfRange} 组未开火）`
            : `齐射失败（${volley.problems.join(" · ") || "未知"}）`;
        return {
          ok: false,
          reason,
          distance,
          outOfRange: outOfRangeOnly,
          rangeMeters: Number(volley.rangeMeters) || 0,
        };
      }
      combatTargets.set(crewID, targetID);
      return {ok: true, activated: volley.turrets, distance, salvos: 1};
    }
    const result = combat.activateOnTarget({
      scene,
      session: mining.moduleSessionFor(session, crewID, entity),
      entity,
      target,
      modules: resolved.modules,
    });
    if (!result.ok) {
      return {ok: false, reason: "开火失败（" + result.errors.join(" · ") + "）", distance};
    }
    combatTargets.set(crewID, targetID);
    if (debugMode) {
      log(`[combat] ${member.name} 锁定 ${targetID}`);
      log(`[combat] ${member.name} 攻击 ${targetID}（${result.activated.length} 个武器，${Math.round(distance / 1000)}km）`);
    }
    // 刚开火时顺手把装备也管一下 —— 但必须走闸门，否则每船每拍都能跑一遍（实测 combat 1–4 s）。
    maybeRunDefenseFor(scene, session, member, entity);
    return {ok: true, activated: result.activated.length, distance};
  }

  /** Stop shooting with one crew ship (keeps the commander-follow flag). */
  function disengageMember(scene, session, member) {
    const crewID = Number(member && member.characterID) || 0;
    const entity = scene && typeof scene.getEntityByID === "function" ? scene.getEntityByID(member && member.shipID) : null;
    if (entity) {
      combat.stopCombat({
        scene,
        session: mining.moduleSessionFor(session, crewID, entity),
        entity,
      });
    }
    combatTargets.delete(crewID);
    if (entity) {
      defense.stopDefense({
        scene,
        session: mining.moduleSessionFor(session, crewID, entity),
        entity,
        modules: defenseModulesFor(member),
      });
    }
  }

  /** /crewmine stop [all|<名字>] — ceasefire, leave commander-follow mode. */
  function stopCrew(selector, context = {}) {
    // Remember what he was shooting at: the stop holds until he locks something else.
    const session = context.session || null;
    const scene = follow.sceneFor(deps, session);
    log("[combat] stop 请求 选择=" + (selector || "all"));
    const selected = selectMembers(selector, context);
    if (selected.members.length === 0) {
      return {
        ok: false,
        lines: selected.problems.length > 0
          ? selected.problems
          : ["本星系没有在役船员" + (selected.skipped > 0 ? "（另有 " + selected.skipped + " 人在别处）" : "")],
      };
    }
    const lines = [];
    freeFire = false;
    fullAuthority = false;
    try {
      combatPausedTarget = commanderTargetID(scene, session) || combatPausedTarget;
    } catch (_error) {
      /* best effort */
    }
    for (const member of selected.members) {
      const crewID = Number(member.characterID) || 0;
      combatFollowers.delete(crewID);
      disengageMember(scene, session, member);
      log("[combat] " + member.name + " 停火");
      lines.push(member.name + "：已停火");
    }
    return {ok: true, lines};
  }

  /**
   * Watch tick (every second): mirror the commander and drop dead targets.
   *   follow mode -> target = commanderTargetID(); switched target => stop old, engage new
   *   fixed mode  -> target must still exist, otherwise ceasefire
   */
  // The crew mirrors the commander: whatever he locks and fires at, they lock and fire.
  // `combatPausedTarget` remembers the target he had when /crewmine stop was issued, so
  // an explicit stop holds until he picks a DIFFERENT target.
  let combatPausedTarget = 0;
  // Performance guards: every engine module activation recomputes the whole ship's
  // derived attributes (500-1100 ms measured), so the mod must not toggle modules or
  // rescan inventories every second.
  const lastDefenseAt = new Map();
  // 最近一次 runDefenseFor 的内部耗时（crewID → {阶段: ms}）。只给归因日志用：
  // 单船一次就要 0.9–1.8 s，得知道是"读装配/补弹药/抗性常开/判定/真激活"里的哪一步。
  const defenseBreakdown = new Map();
  // 同一次 runDefenseFor 的"做了什么"（不是耗时）：用来判断抗性常开的影子状态到底有没有被
  // 反复写入 —— 写了就会调 refreshShipEntityDerivedState（实测 0.7–1.5 s）。
  const defensePassInfo = new Map();
  // S2：自修结算的节流表（`crewID:moduleID` → 下一次可以修的墙钟），按模块 duration 排。
  const defenseSettleState = new Map();
  const lastAmmoCheckAt = new Map();
  // Volley cooldown per crew ship (player-style settlement, one shot per weapon type).
  const salvoNextAt = new Map();
  // 上一轮齐射的真实电容开销：用来在下一轮之前先判断“打不打得起”（P0 预检）。
  const salvoCapCost = new Map();
  const capShortLoggedAt = new Map();
  // 齐射轮转：每拍只结算预算内的船，光标循环前进（P1）。
  const salvoCursor = {at: 0, offset: 0};
  // 火力集中（0.6.13）：本拍已经花在结算上的毫秒数 + 安全阀日志节流。
  const FOCUS_FIRE_DEFAULT_CAP_MS = 6000;
  let focusTickAt = 0;
  let focusTickSpentMs = 0;
  let focusDeferTick = -1;
  let focusDeferLoggedAt = 0;

  /** 船上电容的绝对值（GJ）；拿不到就返回 null（退回“不预检”）。 */
  function capacitorAmountOf(entity) {
    try {
      if (deps.entityCapacitor && typeof deps.entityCapacitor.getEntityCapacitorAmount === "function") {
        const amount = Number(deps.entityCapacitor.getEntityCapacitorAmount(entity));
        return Number.isFinite(amount) ? amount : null;
      }
    } catch (_error) {
      return null;
    }
    return null;
  }

  /**
   * 这一拍轮到这艘船结算齐射吗？
   *
   * 普通模式：预算 = behavior.combatSalvoBudgetPerTick（默认 3，按船轮转）；船数 ≤ 预算时人人每拍都打。
   *
   * 火力集中（/crewmine focus on 或面板「火力集中」）：**不再轮转**，本拍所有冷却好的船都放行；
   * 只保留一个"单拍安全阀" focusFireMaxTickMs（默认 6000 ms）—— 一拍内累计结算超过它，
   * 余下的船顺延到下一拍。安全阀不是"3 艘"那种条数限制，人多时它会先触发，防止一次把
   * 事件循环钉死十几秒（24 艘 × ~0.6 s ≈ 14 s，服务器会整体膨胀）。
   */
  function salvoTurnFor(crewID) {
    if (focusFire) {
      const tick = Math.floor(now() / 1000);
      if (focusTickAt !== tick) {
        focusTickAt = tick;
        focusTickSpentMs = 0;
      }
      const cap = Math.max(
        1000,
        Number(configs_behavior().focusFireMaxTickMs) || FOCUS_FIRE_DEFAULT_CAP_MS,
      );
      if (focusTickSpentMs >= cap) {
        if (focusDeferTick !== tick && now() - focusDeferLoggedAt >= 30000) {
          focusDeferTick = tick;
          focusDeferLoggedAt = now();
          log(`[combat] 火力集中：本拍结算已用 ${Math.round(focusTickSpentMs)} ms`
            + `（安全阀 ${cap} ms），余下船员的齐射顺延到下一拍`);
        }
        return false;
      }
      return true;
    }
    const summoned = (stateStore.get().pool || []).filter((entry) => entry.summoned === true);
    const count = summoned.length;
    if (count <= 1) {
      return true;
    }
    const budget = Math.min(count, Math.max(1, Math.round(Number(configs_behavior().combatSalvoBudgetPerTick) || 3)));
    if (budget >= count) {
      return true;
    }
    const tick = Math.floor(now() / 1000);
    if (salvoCursor.at !== tick) {
      salvoCursor.at = tick;
      salvoCursor.offset = (salvoCursor.offset + budget) % count;
    }
    const ids = summoned.map((entry) => Number(entry.characterID) || 0).sort((left, right) => left - right);
    const index = ids.indexOf(Number(crewID));
    if (index < 0) {
      return true;
    }
    return ((index - salvoCursor.offset + count) % count) < budget;
  }

  // 导弹齐射日志的节流（没有实体/特效，只能靠日志确认开火）。
  const volleyLoggedAt = new Map();
  const targetMissingSince = new Map();
  const pendingCombatTarget = new Map();
  // /crewmine attack all: shoot nearby native NPC ships without being told which.
  let freeFire = false;
  // 火力集中（0.6.13）：打开后**不再按 3 艘/拍轮转**，本拍所有冷却好的船一起结算。
  // 只保留一个"单拍安全阀"（focusFireMaxTickMs，默认 6000 ms），防止把事件循环钉死十几秒。
  // runtime 级状态（和 freeFire 一样，不落盘：重启后回到关闭）。
  let focusFire = false;
  // 全权开火：在自由开火之上，把末日武器也交给船员自己决定何时放。
  let fullAuthority = false;
  // 交战规则：npc（默认，只打原生 NPC）/ defend（+ 反击）/ war（+ 宣战目标）
  let engagementRule = "npc";
  const ENGAGEMENT_RULES = new Set(["npc", "defend", "war"]);

  /** Debug only: report a crew ship's activity transitions (follow / mine / deliver / fight). */
  function logCrewBehavior(scene, session, member, entity) {
    if (!debugMode || !entity) {
      return;
    }
    const crewID = Number(member.characterID) || 0;
    const effects = entity.activeModuleEffects instanceof Map ? entity.activeModuleEffects : null;
    const targetID = combatTargets.get(crewID) || 0;
    const activeCount = effects ? effects.size : 0;
    let label = String(entity.mode || "无实体");
    if (targetID) {
      label += `/交战:${targetID}`;
    } else if (activeCount > 0) {
      label += `/模块运行:${activeCount}`;
    } else if (miningWanted.has(crewID)) {
      label += "/待采矿";
    }
    const previous = crewBehaviorSeen.get(crewID) || "";
    if (label !== previous) {
      crewBehaviorSeen.set(crewID, label);
      log(`[behave] ${member.name} ${previous || "—"} → ${label}`);
    }
  }

  const destroyedWarned = new Set();
  const materializeLogged = new Set();

  /** Human-readable target info for logs and the detail pane. */
  function describeTarget(scene, sourceEntity, targetID) {
    const id = Number(targetID) || 0;
    if (!id) {
      return null;
    }
    const entity = scene && typeof scene.getEntityByID === "function" ? scene.getEntityByID(id) : null;
    if (!entity) {
      return {id, name: `#${id}`, hullName: "", distance: null, kind: "无实体"};
    }
    let hullName = String(entity.itemName || "");
    if (!hullName) {
      try {
        const record = entity.typeID && typeof sde.loadTypeRecords === "function"
          ? sde.loadTypeRecords([Number(entity.typeID)]).get(Number(entity.typeID))
          : null;
        const named = record && record.name;
        hullName = String(named && (named.en || named) || "");
      } catch (_error) {
        hullName = "";
      }
    }
    let distance = null;
    const a = sourceEntity && sourceEntity.position;
    const b = entity.position;
    if (a && b) {
      distance = Math.hypot((Number(a.x) || 0) - (Number(b.x) || 0), (Number(a.y) || 0) - (Number(b.y) || 0), (Number(a.z) || 0) - (Number(b.z) || 0));
    }
    return {
      id,
      name: String(entity.itemName || hullName || `#${id}`),
      hullName,
      distance,
      kind: entity.nativeNpc === true ? "npc" : String(entity.kind || ""),
    };
  }

  /** Flag a crew whose ship no longer exists so the panel and commands can act on it. */
  function markDestroyed(characterID) {
    const wanted = Number(characterID) || 0;
    if (!wanted) {
      return;
    }
    stateStore.update((state) => ({
      ...state,
      pool: (state.pool || []).map((entry) => (Number(entry.characterID) === wanted
        ? {...entry, destroyed: true, summoned: false}
        : entry)),
    }));
  }

  function markAlive(characterID) {
    const wanted = Number(characterID) || 0;
    const entry = (stateStore.get().pool || []).find((row) => Number(row.characterID) === wanted);
    if (!entry || entry.destroyed !== true) {
      return;
    }
    stateStore.update((state) => ({
      ...state,
      pool: (state.pool || []).map((row) => (Number(row.characterID) === wanted
        ? {...row, destroyed: false}
        : row)),
    }));
  }

  /** 把"为什么下不了指令"变成可读的诊断串。 */
  function movementBlockersFor(entity, targetEntity = null) {
    if (!entity) {
      return "no-entity";
    }
    const restrictions = deps.shipActionRestrictions;
    const parts = [];
    if (restrictions && typeof restrictions.isShipMovementLockedByRuntime === "function") {
      try {
        parts.push(`movementLocked=${restrictions.isShipMovementLockedByRuntime(entity, now())}`);
      } catch (_error) {
        parts.push("movementLocked=?");
      }
    }
    const engine = deps.destinyMovementEngine;
    if (engine) {
      const inspect = (name, fn) => {
        if (typeof fn !== "function") {
          return;
        }
        try {
          parts.push(`${name}=${fn()}`);
        } catch (error) {
          parts.push(`${name}=err(${error && error.message})`);
        }
      };
      inspect("invalidCmd", () => engine.isInvalidDestinyFollowOrbitCommand(entity, targetEntity, 3000));
      inspect("diffBubble", () => engine.isDifferentDestinyFollowOrbitBubble(entity, targetEntity));
      inspect("moribund", () => engine.isEntityMoribundForDestinyFollowOrbit(entity));
    }
    parts.push(`mode=${entity.mode || "?"}`);
    parts.push(`tether=${entity.tetheredToStructureID || entity.structureTetherID || 0}`);
    return parts.join(" ");
  }

  /** 清掉旧版本塞进去的假末日效果状态（缺字段会让引擎 tick 抛错）。 */
  function clearFakeDoomsdayEffects(entity) {
    if (!entity || !(entity.activeModuleEffects instanceof Map)) {
      return 0;
    }
    let removed = 0;
    for (const [moduleID, state] of [...entity.activeModuleEffects.entries()]) {
      if (state && state.superweaponEffect === true && state.superweaponDamageApplied === true
        && String(state.effectName || "") === "moduleBonusSuperweapon") {
        entity.activeModuleEffects.delete(moduleID);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * 船员船的"身份"维护。
   *
   * 历史契约是**绝不注入 session**：注入后引擎把它当有驾驶员的船，
   * orbit/goto/stop 曾被守卫拒绝（不跟随、不离场、解散不消失）。
   *
   * 现在做一个**可一键回退的试验**（B 的最小可行形态）：只挂一个**无头 session**，
   * 唯一目的是让引擎的 `resolveCombatActorClass()` 返回 "player"
   * （`space/npc/npcBehaviorLoop.js:1534`，它只看 `entity.session.characterID`），
   * 这样海盗 NPC 才会把船员当目标。
   *
   * 三条红线（都写在这里，别再改）：
   *   1. **不注册进 `scene.sessions`** —— 否则断线/切场景的清理会清目标、放无人机、
   *      甚至把船从场景摘掉（`space/runtime/scene/sessions.js:1489-1512`）；
   *   2. **不继承玩家的 socket / sendNotification** —— 引擎发来的包一律吞掉，
   *      绝不能带着船员的 moduleID 打到玩家客户端；
   *   3. **可回退**：`options.crewHeadlessSession === false`（或把
   *      `CREW_HEADLESS_SESSION` 改 false）下一拍就会把 session 删掉。
   */
  const CREW_HEADLESS_SESSION = options.crewHeadlessSession !== false;

  function buildCrewHeadlessSession(entity) {
    const characterID = Number(entity && entity.characterID) || 0;
    const shipID = Number(entity && entity.itemID) || 0;
    if (!characterID || !shipID) {
      return null;
    }
    const session = {
      characterID,
      charID: characterID,
      charid: characterID,
      characterId: characterID,
      shipID,
      shipid: shipID,
      clientID: `nf-crew-headless:${characterID}`,
      clientid: `nf-crew-headless:${characterID}`,
      __nfCrewHeadless: true,
      // 船员没有客户端：所有通知吞掉（这是红线 2）。
      sendNotification: () => 0,
      // 没有 socket；引擎里按 `typeof x === "function"` / 真值判断的地方会自然跳过。
      socket: null,
      _space: {
        systemID: Number(entity.systemID) || 0,
        shipID,
        sceneKey: entity.sceneKey || null,
        sceneKind: entity.sceneKind || null,
        instanceID: entity.instanceID || null,
        sceneDescriptor: entity.sceneDescriptor || null,
        simFileTime: 0,
        simTimeMs: 0,
      },
    };
    return session;
  }

  /** 哪些船已经打印过「补上限」日志（避免被反复置 0 时刷屏）。 */
  const healthBackfillLogged = new Set();
  /**
   * typeID -> 船体 hp（0 = 查过但没有）。
   * 必须缓存：`loadDogmaAttributes()` 对"查不到"的类型**每次都会重扫 typeDogma.jsonl**，
   * 而这个函数每秒会被每艘船员船调一次。
   */
  const hullHpByType = new Map();

  /**
   * 船体上限从哪里补：实体字段（hullHP / structureHP）→ SDE 的 `hp` 属性（ID 9）。
   * 面板的 crewDetail 早就用同一个口径兜过底，这里把同一套取值复用给实体本身。
   */
  function hullStructureHP(entity) {
    const direct = Number(entity && (entity.hullHP || entity.structureHP)) || 0;
    if (direct > 0) {
      return direct;
    }
    const typeID = Number(entity && entity.typeID) || 0;
    if (!typeID || !sde || typeof sde.loadDogmaAttributes !== "function") {
      return 0;
    }
    if (hullHpByType.has(typeID)) {
      return hullHpByType.get(typeID);
    }
    let value = 0;
    try {
      const attributes = sde.loadDogmaAttributes([typeID]).get(typeID);
      const raw = attributes && typeof attributes.get === "function"
        ? Number(attributes.get(9))
        : 0;
      value = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0;
    } catch (_error) {
      value = 0;
    }
    hullHpByType.set(typeID, value);
    return value;
  }

  /**
   * 船员船的「血量上限」自愈（2026-10-25）。
   *
   * 模组用 spawnDynamicInventoryEntity 造出来的实体可能没有 structureHP（=0），而引擎的
   * 销毁判定**硬要求** `maxLayers.structure > 0`（space/combat/damage.js:465）：
   *   上限是 0 → `destroyed` 永远 false；同时 conditionState.damage 被强制写成 1
   *   （面板显示「结构 0%」）；护盾/装甲打光之后 `hasDamageableHealth()` 又变 false
   *   （damage.js:143）→ 之后任何伤害都被静默丢弃。
   *   真机表现就是「血量全 0、不爆炸、也再打不动」。
   *
   * 面板以前只补了显示（crewDetail 里同一段兜底），这里把上限补回实体本身。
   * 幂等：只在 structureHP <= 0 时动作，正常船一个字节都不改。
   * 顺带把被派生状态重算写坏的 >1 装甲损伤比例夹回 1（否则修甲要先把 4 倍缺口填平）。
   */
  function ensureHealthLayers(entity) {
    if (!entity || entity.kind !== "ship") {
      return entity;
    }
    if (!(Number(entity.structureHP) > 0)) {
      const hullHP = hullStructureHP(entity);
      if (hullHP > 0) {
        entity.structureHP = hullHP;
        const key = Number(entity.itemID) || 0;
        if (!healthBackfillLogged.has(key)) {
          healthBackfillLogged.add(key);
          log(`[health] ${entity.itemName || entity.name || key} 船体上限缺省（structureHP=0）→ 补 ${hullHP}`
            + "；引擎的 destroyed 判定需要它，缺了这艘船会打不死");
        }
      }
    }
    const state = entity.conditionState;
    if (state && Number(state.armorDamage) > 1) {
      state.armorDamage = 1;
    }
    return entity;
  }

  /** 已经收尾过的船（itemID），避免重复处理与重复日志。 */
  /** 已经收尾过的船（itemID），避免重复处理与重复日志。 */
  const deadShipFinalized = new Set();

  /**
   * 兜底收尾：引擎判定已死、却还留在场景里的船员船。
   *
   * 正常情况**不需要这里** —— 装上 `击杀船员产生KM补丁`（改 `shipDestruction.js` 一处分支）后，
   * 引擎第一次销毁就成功：一次就死、只出一个残骸、KM 由引擎自己写。
   *
   * 但补丁没装/被引擎升级冲掉时，引擎会走到 `destroyDynamicInventoryEntity()`
   * （那个接口只收 container/wreck/drone，船一律 `DYNAMIC_ENTITY_NOT_FOUND`），
   * 结果是「残骸建了、装配搬走了、船摘不掉」，下一发再刷一个残骸。
   * 这个函数就是那种情况下的安全网：至少不留 0 血的幽灵船（代价是这一艘没有 KM）。
   * 只在装配已被引擎搬空时动手，避免白丢一套装备。
   */
  function finalizeDeadCrewShip(scene, entry, entity) {
    if (!scene || !entity || entity.kind !== "ship") {
      return false;
    }
    const crewID = Number(entry && entry.characterID) || 0;
    const shipID = Number(entity.itemID) || 0;
    if (!crewID || !shipID || deadShipFinalized.has(shipID)) {
      return false;
    }
    const damage = Number(entity.conditionState && entity.conditionState.damage);
    if (!(damage >= 1)) {
      return false;
    }
    const fitted = deps.fitting && typeof deps.fitting.getFittedModuleItems === "function"
      ? deps.fitting.getFittedModuleItems(crewID, shipID) || []
      : [];
    if (fitted.length > 0) {
      return false;
    }
    const remover = typeof scene.removeDynamicEntity === "function"
      ? scene.removeDynamicEntity.bind(scene)
      : null;
    if (!remover) {
      return false;
    }
    const terminalEffectID = Number(deps.explosionEffectID) || 3; // 3 = 引擎的爆炸特效
    let removed = null;
    try {
      // allowSessionOwned：这艘船的 session 是我们自己挂的无头壳，不是真客户端。
      removed = remover(shipID, {allowSessionOwned: true, terminalDestructionEffectID: terminalEffectID});
    } catch (error) {
      removed = {success: false, errorMsg: error && error.message};
    }
    const ok = removed === true || Boolean(removed && removed.success === true);
    if (!ok) {
      logCombatOnce(crewID, shipID, "dead-finalize",
        `[crew] ${entry.name} 血量归零但摘不掉：${(removed && removed.errorMsg) || "REMOVE_REFUSED"}`
        + "（下一拍再试；装 击杀船员产生KM补丁 可以从根上避免）");
      return false;
    }
    deadShipFinalized.add(shipID);
    ship.removeShipItem(deps, {shipID});
    markDestroyed(crewID);
    log(`[crew] ${entry.name} 血量归零，兜底收尾（摘实体 + 删船，这一艘没有 KM）；`
      + "装 `击杀船员产生KM补丁` 后引擎会自己正常结算（有 KM）。"
      + `/crewmine rebuild ${entry.name} 可以重造`);
    return true;
  }

  function syncCrewIdentity(entity) {
    if (!entity) {
      return entity;
    }
    // 每一拍顺带走一次血量上限自愈（只补缺失的，正常船不动）。
    ensureHealthLayers(entity);
    clearFakeDoomsdayEffects(entity);
    if (CREW_HEADLESS_SESSION) {
      // 旧版本注入的 session 先清掉（它带着 __nfCrewSession 标记）。
      if (entity.__nfCrewSession === true) {
        try {
          delete entity.session;
        } catch (_error) {
          entity.session = undefined;
        }
      }
      const current = entity.session;
      if (current && current.__nfCrewHeadless === true) {
        // 位置/星系可能变了：只刷新 _space，不换对象（引擎可能拿着旧引用）。
        const space = current._space || (current._space = {});
        space.systemID = Number(entity.systemID) || space.systemID || 0;
        space.shipID = Number(entity.itemID) || space.shipID || 0;
        space.sceneKey = entity.sceneKey || space.sceneKey;
      } else if (!current) {
        const session = buildCrewHeadlessSession(entity);
        if (session) {
          entity.session = session;
        }
      }
      // 别人（真玩家会话）挂的 session 不动。
      delete entity.__nfCrewSession;
      return entity;
    }
    if (entity.__nfCrewSession === true
      || (entity.session && entity.session.__nfCrewHeadless === true)) {
      try {
        delete entity.session;
      } catch (_error) {
        entity.session = undefined;
      }
      delete entity.__nfCrewSession;
    }
    return entity;
  }

  /**
   * 临时诊断：记录每一次模块激活的调用方，用来对比"玩家手动激活"与"我们/NPC 激活"
   * 在 session 上有什么不同（重点是 socket、真实角色）。只读日志，不改行为。
   */
  function instrumentSceneActivation(scene) {
    // F5：这只是早期排查 socket 差异的诊断日志，debug 关掉时不该每次激活写一行。
    if (!debugMode) {
      return scene;
    }
    if (!scene || typeof scene.activateGenericModule !== "function" || scene.__nfActivatePatched === true) {
      return scene;
    }
    const original = scene.activateGenericModule.bind(scene);
    scene.activateGenericModule = (callSession, moduleItem, effectName, options) => {
      try {
        const pseudo = callSession && callSession.__nfPseudoCrew === true;
        const socket = Boolean(callSession && callSession.socket);
        const char = Number(callSession && (callSession.characterID || callSession.charid)) || 0;
        log(`[activate] caller=${pseudo ? "crew" : "player"} socket=${socket ? "yes" : "no"}` +
          ` char=${char} effect=${String(effectName || "-")}` +
          ` module=${Number(moduleItem && moduleItem.itemID) || 0}` +
          ` type=${Number(moduleItem && moduleItem.typeID) || 0}` +
          ` target=${Number(options && options.targetID) || 0}`);
      } catch (_error) {
        /* 诊断日志不允许影响激活 */
      }
      return original(callSession, moduleItem, effectName, options);
    };
    scene.__nfActivatePatched = true;
    return scene;
  }

  // ---- 反击启发式（defend/war）------------------------------------------------
  // 引擎没有"谁打了我"的记录：炮台伤害走模块内解构调用，晚绑定钩子抓不到。
  // 所以退回启发式：这一 tick 血量掉了 + 附近有非友方玩家船 → 认定其为攻击者，
  // 记仇 8 秒。代价是可能误判（旁边恰好有路人），因此只在非 npc 规则下启用。
  const RETALIATION_MS = 8000;
  const retaliation = new Map();   // crewID -> {targetID, untilMs}
  const crewHealthSeen = new Map(); // crewID -> 上次的总血量

  function totalHealth(entity) {
    if (!entity) {
      return 0;
    }
    return (Number(entity.shieldCharge ?? entity.shieldHP) || 0)
      + (Number(entity.armorHP) || 0)
      + (Number(entity.structureHP) || 0);
  }

  function maybeRecordRetaliation(scene, member, entity, exclude) {
    const crewID = Number(member && member.characterID) || 0;
    if (!crewID || !entity) {
      return;
    }
    const health = totalHealth(entity);
    const previous = crewHealthSeen.get(crewID);
    crewHealthSeen.set(crewID, health);
    if (previous === undefined || health >= previous - 1) {
      return; // 没掉血
    }
    let candidates = [];
    try {
      candidates = dynamicEntitiesFor(scene);
    } catch (_error) {
      candidates = [];
    }
    let best = null;
    for (const candidate of candidates) {
      if (!candidate || candidate.kind !== "ship" || candidate.nativeNpc === true) {
        continue;
      }
      const id = Number(candidate.itemID) || 0;
      if (!id || id === Number(entity.itemID) || (exclude && exclude.has(id))) {
        continue;
      }
      const distance = combat.surfaceDistance(entity, candidate);
      if (!best || distance < best.distance) {
        best = {candidate, distance};
      }
    }
    if (!best) {
      return;
    }
    retaliation.set(crewID, {targetID: Number(best.candidate.itemID) || 0, untilMs: now() + RETALIATION_MS});
    log(`[combat] ${member.name} 正在掉血 → 反击 ${Number(best.candidate.itemID) || 0}（${RETALIATION_MS / 1000} 秒内有效）`);
  }

  /** 这一 tick 该不该优先打"打了我的人"；0 = 没有。 */
  function retaliationTargetFor(member, scene) {
    const crewID = Number(member && member.characterID) || 0;
    const record = retaliation.get(crewID);
    if (!record) {
      return 0;
    }
    if (now() > record.untilMs) {
      retaliation.delete(crewID);
      return 0;
    }
    const entity = scene && typeof scene.getEntityByID === "function" ? scene.getEntityByID(record.targetID) : null;
    if (!entity) {
      retaliation.delete(crewID);
      return 0;
    }
    // war 规则下仍然要求合法战争关系；defend 才是"谁打我我打谁"。
    if (engagementRule === "war" && !isWarOpponent(crewID, entity)) {
      return 0;
    }
    return record.targetID;
  }

  // ---- S1 / R2: target blacklist -------------------------------------------------
  // A target the engine refuses to lock (TETHERED / SELF / gone) was retried every
  // 2.5 s forever: 179 LOCK_REFUSED lines in one log. TTL 45 s per (crew, target).
  const BLACKLIST_TTL_MS = 45000;
  const lockBlacklist = new Map();        // crewID -> Map(targetID -> {untilMs, reason})
  const combatLogAt = new Map();          // `${crew}:${target}:${reason}` -> ms (10 s dedupe)
  const capsuleWarned = new Set();        // capsule ids already reported (logged once)
  const commanderHealthSeen = new Map();  // targetID -> {hp, damagedAtMs, observable}

  /** The live blacklist of one crew ship, expired entries pruned. */
  function blacklistFor(crewID, atMs) {
    const key = Number(crewID) || 0;
    let rows = lockBlacklist.get(key);
    if (!rows) {
      rows = new Map();
      lockBlacklist.set(key, rows);
    }
    for (const [targetID, record] of [...rows]) {
      if (!record || Number(record.untilMs) <= atMs) {
        rows.delete(targetID);
      }
    }
    return rows;
  }

  function blacklistAdd(crewID, targetID, reason) {
    const id = Number(targetID) || 0;
    if (!id) {
      return;
    }
    blacklistFor(crewID, now()).set(id, {
      untilMs: now() + BLACKLIST_TTL_MS,
      reason: String(reason || ""),
    });
  }

  /** How many (crew, target) pairs are blacklisted right now, for `/crewmine status`. */
  function blacklistSize() {
    const at = now();
    let total = 0;
    for (const rows of lockBlacklist.values()) {
      for (const [targetID, record] of [...rows]) {
        if (!record || Number(record.untilMs) <= at) {
          rows.delete(targetID);
        } else {
          total += 1;
        }
      }
    }
    return total;
  }

  /** Reasons that will not fix themselves next tick: worth a blacklist entry. */
  function isPermanentLockFailure(reason) {
    return /TETHERED|TARGET_SELF|TARGET_NOT_FOUND|NOT_FOUND|不在当前星系/i.test(String(reason || ""));
  }

  /** One line per (crew, target, reason) every 10 s — the log had 8 086 [combat] lines. */
  function logCombatOnce(crewID, targetID, reason, message) {
    const key = `${Number(crewID) || 0}:${Number(targetID) || 0}:${String(reason || "")}`;
    const at = now();
    if (at - (Number(combatLogAt.get(key)) || 0) < 10000) {
      return;
    }
    // Reasons carry distances ("射程外（53 km > 30 km）"), so keys are not bounded by the
    // pool size: on a long run keep the newest few hundred and drop the oldest.
    if (combatLogAt.size > 512) {
      let drop = combatLogAt.size - 256;
      for (const oldKey of combatLogAt.keys()) {
        combatLogAt.delete(oldKey);
        drop -= 1;
        if (drop <= 0) {
          break;
        }
      }
    }
    combatLogAt.set(key, at);
    log(message);
  }

  /**
   * R1: has the commander's target lost HP in the last 2 s? That is the only evidence
   * that his shots are landing; a bare lock must not pull the whole squad off its own
   * targets (P3).
   */
  function noteCommanderTargetHealth(scene, targetID) {
    const id = Number(targetID) || 0;
    if (!id) {
      return;
    }
    const entity = scene && typeof scene.getEntityByID === "function" ? scene.getEntityByID(id) : null;
    if (!entity) {
      commanderHealthSeen.delete(id);
      return;
    }
    const hp = totalHealth(entity);
    const previous = commanderHealthSeen.get(id);
    if (!previous) {
      commanderHealthSeen.set(id, {hp, damagedAtMs: null, observable: hp > 0});
      return;
    }
    if (hp > 0) {
      previous.observable = true;
    }
    if (previous.observable && hp < previous.hp - 0.5) {
      previous.damagedAtMs = now();
    }
    previous.hp = hp;
  }

  /** null = the target's HP is not observable; true/false = a reading exists. */
  function commanderDamageObserved(targetID) {
    const record = commanderHealthSeen.get(Number(targetID) || 0);
    if (!record || record.observable !== true) {
      return null;
    }
    if (record.damagedAtMs == null) {
      return false;
    }
    return now() - Number(record.damagedAtMs) <= 2000;
  }

  // ---- S2 / R4: grudge list (敌人名单) -----------------------------------------
  // A player character we damaged — or whose ship we destroyed — is an enemy for two
  // minutes, and by decision B being on this list overrides the engagement rule: under
  // `attack npc` the crew may still shoot him. 军团扩散: his whole corporation joins
  // him, with three hard exclusions that cannot be turned off:
  //   1. NPC corporations never spread (half the server sits in one)
  //   2. a corporation with more than GRUDGE_CORP_MAX_MEMBERS only grudges the man himself
  //   3. our own characters / corporation / alliance / fleet are never on the list
  const GRUDGE_TTL_MS = 120000;
  const GRUDGE_CORP_MAX_MEMBERS = 200;
  const grudgeCharacters = new Map();   // characterID -> {untilMs, name, corpID}
  const grudgeCorps = new Map();        // corporationID -> {untilMs, members}
  const grudgeSpreadRefused = new Set();// corporations already reported as "not spreadable"
  const corpCache = new Map();          // characterID -> {corporationID, allianceID, atMs}
  const lastTargetSeen = new Map();     // crewID -> {itemID, characterID, name}

  /** The character behind a ship entity (crew ships carry both fields). */
  function characterIDOf(entity) {
    return Number(entity && (entity.characterID || entity.pilotCharacterID)) || 0;
  }

  /** corporation / alliance of a character, cached for 10 s (table reads are not free). */
  function affiliationOf(characterID) {
    const id = Number(characterID) || 0;
    if (!id) {
      return {corporationID: 0, allianceID: 0};
    }
    const cached = corpCache.get(id);
    if (cached && now() - cached.atMs < 10000) {
      return cached;
    }
    let corporationID = 0;
    try {
      if (deps.corporations && typeof deps.corporations.getCharacterCorporationIDForAuthority === "function") {
        corporationID = Number(deps.corporations.getCharacterCorporationIDForAuthority(id)) || 0;
      }
      if (!corporationID && deps.characterState
        && typeof deps.characterState.peekCharacterRecord === "function") {
        const record = deps.characterState.peekCharacterRecord(id);
        corporationID = Number(record && record.corporationID) || 0;
      }
    } catch (_error) {
      corporationID = 0;
    }
    let allianceID = 0;
    try {
      const record = corporationID && deps.corporations
        && typeof deps.corporations.getCorporationRecord === "function"
        ? deps.corporations.getCorporationRecord(corporationID)
        : null;
      allianceID = Number(record && record.allianceID) || 0;
    } catch (_error) {
      allianceID = 0;
    }
    const row = {corporationID, allianceID, atMs: now()};
    if (corpCache.size > 1024) {
      corpCache.clear();
    }
    corpCache.set(id, row);
    return row;
  }

  /**
   * Is this structure a legal "go shoot that" order from the commander?
   *
   * The crew's target model is ships-only (see combat.scanCandidates), so a structure can
   * never arrive by free fire or by the engagement rule. It can only arrive as the
   * commander's explicit order, which commanderTargetID() derives from an ACTIVE module
   * effect on the target — the weaponless-command-ship path (Monitor + target painter).
   * Friendly structures are refused: painting your own Fortizar must not turn the crew's
   * guns on it. Unknown ownership (0) is left to the engine's own crimewatch rules.
   */
  function isCommandedStructureTarget(entity, session) {
    if (!entity || entity.kind !== "structure") {
      return false;
    }
    const ownerCorpID = Number(entity.ownerID || entity.corporationID) || 0;
    const ownerAllianceID = Number(entity.allianceID) || 0;
    const commanderID = Number(session && session.characterID) || 0;
    if (!commanderID) {
      return false;
    }
    const own = affiliationOf(commanderID);
    if (ownerCorpID && Number(own.corporationID) && ownerCorpID === Number(own.corporationID)) {
      return false;
    }
    if (
      ownerAllianceID &&
      Number(own.allianceID) &&
      ownerAllianceID === Number(own.allianceID)
    ) {
      return false;
    }
    return true;
  }

  function corporationMembersOf(corporationID) {
    const corpID = Number(corporationID) || 0;
    if (!corpID) {
      return [];
    }
    const pick = (list) => (Array.isArray(list) ? list : [])
      .map((value) => Number(value && (value.characterID ?? value)) || 0)
      .filter(Boolean);
    try {
      if (deps.corporations && typeof deps.corporations.getCharacterIDsInCorporation === "function") {
        return pick(deps.corporations.getCharacterIDsInCorporation(corpID));
      }
      if (deps.corporationRuntime && typeof deps.corporationRuntime.listCorporationMembers === "function") {
        return pick(deps.corporationRuntime.listCorporationMembers(corpID));
      }
    } catch (_error) {
      return [];
    }
    return [];
  }

  /**
   * Our own side: the player, every crew member, the corporations and alliances they
   * belong to, and everybody in the player's fleet. Cached for a second — the check runs
   * per candidate and must not read tables on every tick.
   */
  let ownSideCache = {key: "", atMs: 0, side: null};
  function ownSide(session) {
    const playerID = Number(session && session.characterID) || 0;
    const key = String(playerID);
    if (ownSideCache.side && ownSideCache.key === key && now() - ownSideCache.atMs < 1000) {
      return ownSideCache.side;
    }
    const characters = new Set();
    if (playerID) {
      characters.add(playerID);
    }
    for (const entry of stateStore.get().pool || []) {
      const id = Number(entry && entry.characterID) || 0;
      if (id) {
        characters.add(id);
      }
    }
    const corporations = new Set();
    const alliances = new Set();
    for (const id of characters) {
      const row = affiliationOf(id);
      if (row.corporationID) {
        corporations.add(row.corporationID);
      }
      if (row.allianceID) {
        alliances.add(row.allianceID);
      }
    }
    // Same fleet, even across corporations.
    const fleets = new Set();
    try {
      const fleetRuntime = deps.fleetRuntime;
      if (fleetRuntime && typeof fleetRuntime.getFleetForCharacter === "function") {
        for (const id of characters) {
          const record = fleetRuntime.getFleetForCharacter(id);
          const fleetID = Number(record && (record.fleetID || record.id)) || 0;
          if (fleetID) {
            fleets.add(fleetID);
          }
        }
      }
    } catch (_error) {
      /* no fleet lookup: corp/alliance exclusion still applies */
    }
    const side = {characters, corporations, alliances, fleets};
    ownSideCache = {key, atMs: now(), side};
    return side;
  }

  /** Hard exclusion — never a legal grudge target, whatever the order says. */
  function isOwnSide(characterID, session) {
    const id = Number(characterID) || 0;
    if (!id) {
      return true; // no owner: never shoot it on a grudge
    }
    const side = ownSide(session);
    if (side.characters.has(id)) {
      return true;
    }
    if (side.fleets.size > 0) {
      try {
        const fleetRuntime = deps.fleetRuntime;
        const record = fleetRuntime && typeof fleetRuntime.getFleetForCharacter === "function"
          ? fleetRuntime.getFleetForCharacter(id)
          : null;
        const fleetID = Number(record && (record.fleetID || record.id)) || 0;
        if (fleetID && side.fleets.has(fleetID)) {
          return true;
        }
      } catch (_error) {
        /* fall through to corp/alliance */
      }
    }
    const row = affiliationOf(id);
    if (!row.corporationID) {
      return false;
    }
    return side.corporations.has(row.corporationID)
      || (row.allianceID > 0 && side.alliances.has(row.allianceID));
  }

  function grudgeAdd(characterID, extra = {}) {
    const id = Number(characterID) || 0;
    if (!id) {
      return false;
    }
    const previous = grudgeCharacters.get(id);
    grudgeCharacters.set(id, {
      untilMs: now() + GRUDGE_TTL_MS,
      name: String(extra.name || (previous && previous.name) || `#${id}`),
      corpID: Number(extra.corpID) || Number(previous && previous.corpID) || 0,
    });
    return true;
  }

  /**
   * R4: record one player character (and, by 军团扩散, his corporation).
   * Returns how many characters were added to the list.
   */
  function grudgeCharacter(characterID, options = {}) {
    const id = Number(characterID) || 0;
    if (!id) {
      return 0;
    }
    const session = options.session || null;
    if (isOwnSide(id, session)) {
      return 0;
    }
    const row = affiliationOf(id);
    if (!grudgeAdd(id, {name: options.name, corpID: row.corporationID})) {
      return 0;
    }
    if (options.spread === false || !row.corporationID) {
      return 1;
    }
    const live = grudgeCorps.get(row.corporationID);
    if (live && Number(live.untilMs) > now()) {
      grudgeCorps.set(row.corporationID, {untilMs: now() + GRUDGE_TTL_MS, members: live.members});
      return 1;
    }
    return 1 + spreadGrudgeCorp(row.corporationID, session);
  }

  /** 军团扩散, with the three hard exclusions. Returns how many mates were added. */
  function spreadGrudgeCorp(corporationID, session) {
    const corpID = Number(corporationID) || 0;
    if (!corpID) {
      return 0;
    }
    // Exclusion 3 first: never spread into our own corporation.
    if (ownSide(session).corporations.has(corpID)) {
      return 0;
    }
    // Exclusion 1: NPC corporations (a huge share of the server) stay personal.
    const corps = deps.corporations;
    let npc = false;
    try {
      npc = Boolean(corps && typeof corps.isNpcCorporationID === "function" && corps.isNpcCorporationID(corpID));
    } catch (_error) {
      npc = false;
    }
    if (npc) {
      if (!grudgeSpreadRefused.has(corpID)) {
        grudgeSpreadRefused.add(corpID);
        log(`[combat] 仇人军团 ${corpID} 是 NPC 军团，只记本人（不扩散）`);
      }
      return 0;
    }
    const members = corporationMembersOf(corpID);
    // Exclusion 2: an oversized corporation is almost certainly shared housing, not a squad.
    if (members.length > GRUDGE_CORP_MAX_MEMBERS) {
      if (!grudgeSpreadRefused.has(corpID)) {
        grudgeSpreadRefused.add(corpID);
        log(`[combat] 仇人军团 ${corpID} 有 ${members.length} 人（> ${GRUDGE_CORP_MAX_MEMBERS}），只记本人（不扩散）`);
      }
      return 0;
    }
    let added = 0;
    for (const memberID of members) {
      if (isOwnSide(memberID, session)) {
        continue;
      }
      if (grudgeAdd(memberID, {corpID})) {
        added += 1;
      }
    }
    if (added > 0) {
      grudgeCorps.set(corpID, {untilMs: now() + GRUDGE_TTL_MS, members: added});
      log(`[combat] 仇人名单：军团 ${corpID} 扩散 ${added} 人（${Math.round(GRUDGE_TTL_MS / 1000)} 秒）`);
    }
    return added;
  }

  /** Is this ship a grudged enemy right now? (B: no engagement rule needed.) */
  function isGrudged(candidate, session) {
    const id = characterIDOf(candidate);
    if (!id) {
      return false;
    }
    const record = grudgeCharacters.get(id);
    if (!record) {
      return false;
    }
    if (Number(record.untilMs) <= now() || isOwnSide(id, session)) {
      grudgeCharacters.delete(id);
      return false;
    }
    return true;
  }

  /** S2 hook for the shot itself: whoever we hurt is an enemy for two minutes. */
  function noteGrudgeHit(target, session) {
    if (!target || target.nativeNpc === true) {
      return;
    }
    const id = characterIDOf(target);
    if (!id) {
      return;
    }
    grudgeCharacter(id, {session, name: String(target.itemName || target.name || "")});
  }

  function pruneGrudges() {
    const at = now();
    for (const [id, record] of [...grudgeCharacters]) {
      if (!record || Number(record.untilMs) <= at) {
        grudgeCharacters.delete(id);
      }
    }
    for (const [corpID, record] of [...grudgeCorps]) {
      if (!record || Number(record.untilMs) <= at) {
        grudgeCorps.delete(corpID);
      }
    }
    return grudgeCharacters.size;
  }

  function grudgeCount() {
    return pruneGrudges();
  }

  function grudgeCorpCount() {
    pruneGrudges();
    return grudgeCorps.size;
  }

  const noTargetLoggedAt = new Map();
  // 带修正的有效射程缓存（30 秒），避免每次交战都重建快照。
  const effectiveRangeCache = new Map();
  const effectiveRangeAt = new Map();
  // 追击：打不到（射程外）时靠近目标，目标没了再回环绕玩家。
  const chaseTargets = new Map(); // crewID -> targetID
  const chaseIssuedAt = new Map(); // crewID -> 上次下发追击指令的时间
  const chaseLoggedAt = new Map();
  const CHASE_REISSUE_MS = 5000;

  function chaseEnabled() {
    return configs_behavior().chaseOutOfRange !== false;
  }

  /** 打不到就靠近：把船挂到目标上（orbit 到 70% 射程），由 rearmFollow 暂时不要拉回来。 */
  function startChase(scene, member, entity, crewID, targetID, rangeMeters) {
    const target = Number(targetID) || 0;
    if (!chaseEnabled() || !scene || !entity || !target) {
      return false;
    }
    chaseTargets.set(crewID, target);
    const at = Number(chaseIssuedAt.get(crewID)) || 0;
    if (now() - at < CHASE_REISSUE_MS) {
      return true;
    }
    chaseIssuedAt.set(crewID, now());
    const closeTo = Math.max(1000, Math.round((Number(rangeMeters) || 0) * 0.7));
    let ok = false;
    const runtimeApi = deps && deps.runtime;
    try {
      if (runtimeApi && typeof runtimeApi.orbitDynamicEntity === "function") {
        const result = runtimeApi.orbitDynamicEntity(
          Number(scene.systemID) || 0,
          entity,
          target,
          closeTo,
          {broadcast: true},
        );
        ok = result === true || Boolean(result && result.success === true);
      }
      if (!ok && typeof scene.orbitShipEntity === "function") {
        const result = scene.orbitShipEntity(entity, target, closeTo, {broadcast: true});
        ok = result === true || Boolean(result && result.success === true);
      }
    } catch (_error) {
      ok = false;
    }
    const logged = Number(chaseLoggedAt.get(crewID)) || 0;
    if (now() - logged >= 30000) {
      chaseLoggedAt.set(crewID, now());
      log(`[combat] ${member.name} 追近目标 ${target}（靠近到 ${Math.round(closeTo / 1000)} km，射程 ${Math.round(Number(rangeMeters) / 1000)} km）`
        + (ok ? "" : " · 追击指令被拒（会继续重试）"));
    }
    return ok;
  }

  /** 目标没了/停火：结束追击，下一次 rearmFollow 会把船拉回玩家环。 */
  function stopChase(crewID, member) {
    if (!chaseTargets.has(crewID)) {
      return false;
    }
    chaseTargets.delete(crewID);
    chaseIssuedAt.delete(crewID);
    rearmer.forget(crewID);
    if (member) {
      log(`[combat] ${member.name} 追击结束，返回环绕`);
    }
    return true;
  }

  /** 面板「返回环绕」：所有船员立刻结束追击并重新环绕玩家。 */
  function returnToOrbit() {
    let cleared = 0;
    for (const crewID of [...chaseTargets.keys()]) {
      const member = (stateStore.get().pool || []).find((row) => Number(row.characterID) === crewID) || null;
      if (stopChase(crewID, member)) {
        cleared += 1;
      }
    }
    // 清掉节流，让 rearmFollow 下一个 tick 就重新下发环绕。
    rearmer.clear();
    log(`[combat] 返回环绕：${cleared} 名船员结束追击`);
    return {ok: true, cleared};
  }

  /** 自由开火但没有目标：把原因（搜索半径 / 交战规则 / 最近的敌对多远）说清楚。 */
  function explainNoCombatTarget(scene, member, entity, crewID, searchMeters, excludeIDs) {
    const at = Number(noTargetLoggedAt.get(crewID)) || 0;
    if (now() - at < 60000) {
      return;
    }
    noTargetLoggedAt.set(crewID, now());
    const ruleNames = {npc: "只打 NPC", defend: "挨打还手", war: "只打宣战"};
    const ruleText = ruleNames[String(engagementRule)] || String(engagementRule);
    let nearest = null;
    try {
      // 不限制射程扫一遍，只为了报告最近的候选有多远。
      const scan = combat.scanCandidates({
        scene,
        sourceEntity: entity,
        excludeIDs: excludeIDs instanceof Set ? excludeIDs : new Set(),
        blacklist: blacklistFor(crewID, now()),
        maxMeters: 0,
        maxCandidates: 3,
        nowMs: now(),
      });
      const rows = Array.isArray(scan && scan.candidates) ? scan.candidates : [];
      if (rows.length > 0) {
        nearest = rows.reduce(
          (best, row) => (best === null || Number(row.distance) < best ? Number(row.distance) : best),
          null,
        );
      }
    } catch (_error) {
      nearest = null;
    }
    const parts = [
      "搜索半径 " + Math.round(Number(searchMeters) / 1000) + " km",
      "交战规则 " + ruleText,
    ];
    if (nearest === null) {
      parts.push("附近没有任何候选敌对");
    } else if (nearest > Number(searchMeters)) {
      parts.push("最近的候选在 " + Math.round(nearest / 1000) + " km（在搜索半径之外，不会主动去打）");
    } else {
      parts.push("最近的候选在 " + Math.round(nearest / 1000) + " km");
    }
    log(`[combat] ${member.name} 自由开火已开，但这一轮没有可打的目标：${parts.join(" · ")}`);
  }

  function syncCombat(scene, session, steps) {
    // steps 只在 watch tick 里传：combat.pre / .pick / .engage 用于归因（"." 不计入 accounted）。
    const phaseAt = () => Date.now();
    const phaseEnd = (name, startedAt) => {
      if (!steps) {
        return;
      }
      steps[name] = (steps[name] || 0) + (Date.now() - startedAt);
    };
    if (!scene) {
      return;
    }
    const pool = (stateStore.get().pool || []).filter((entry) => entry.summoned === true);
    if (pool.length === 0) {
      return;
    }
    // 每拍一份**新鲜**的场景快照：选目标（scanCandidates）共用，别每条船各扫一遍。
    // 注意不能用 dynamicEntitiesFor（500 ms 缓存）：P4 要求目标被击毁后**下一拍**就换，
    // 缓存会让新目标晚半秒才可见。
    const proAt = phaseAt();
    let sceneRows = [];
    try {
      sceneRows = typeof scene.getDynamicEntities === "function" ? scene.getDynamicEntities() || [] : [];
    } catch (_error) {
      sceneRows = [];
    }
    const commanderTarget = commanderTargetID(scene, session);
    // R1: focus fire needs evidence that the commander's shots are landing, not just a lock.
    noteCommanderTargetHealth(scene, commanderTarget);
    const commanderDamage = commanderTarget ? commanderDamageObserved(commanderTarget) : null;
    // nf-crew: a deployed structure never enters the free-fire candidate set (the crew
    // shoots ships), so a weaponless command ship — a Monitor with a target painter — has
    // exactly one way to point the crew at one: activate a projected module on it. That
    // activation is already the explicit order (commanderTargetID only reads ACTIVE module
    // effects), and "his shots are landing" has no meaning for a structure, so it does not
    // get to veto the order either. Own corp/alliance structures are refused.
    const commanderTargetEntity = commanderTarget && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(commanderTarget)
      : null;
    const commanderStructureOrder = isCommandedStructureTarget(commanderTargetEntity, session);
    // R1/P3: a commander lock no longer switches the crew's own target search off.
    const freeFireActive = freeFire;
    const focusActive = Boolean(commanderTarget)
      && (commanderDamage !== false || commanderStructureOrder);
    if (commanderTarget && combatPausedTarget && commanderTarget !== combatPausedTarget) {
      log(`[combat] 指挥官锁定新目标 ${commanderTarget}，恢复自动交战`);
      combatPausedTarget = 0;
    }
    const paused = Boolean(combatPausedTarget) && commanderTarget === combatPausedTarget;
    phaseEnd("combat.prologue", proAt);

    // PR-6: this set and this lookup do not change inside one tick. Rebuilding them per
    // crew member was O(n²) — 30 crew meant ~900 Set inserts plus 30 config reads a tick.
    const freeFireExclude = new Set();
    for (const entry of (stateStore.get().pool || [])) {
      const shipID = Number(entry && entry.shipID) || 0;
      if (shipID) {
        freeFireExclude.add(shipID);
      }
    }
    freeFireExclude.add(Number(session && session._space && session._space.shipID) || 0);
    const freeFireRange = Number(configs_behavior().freeFireRangeMeters) || 60000;

    const loopAt = phaseAt();
    for (const member of pool) {
      const crewID = Number(member.characterID) || 0;
      const lookupAt = phaseAt();
      const entity = typeof scene.getEntityByID === "function" ? scene.getEntityByID(member.shipID) : null;
      phaseEnd("combat.lookup", lookupAt);
      const preAt = phaseAt();
      syncCrewIdentity(entity);
      if (!entity) {
        combatTargets.delete(crewID);
        phaseEnd("combat.pre", preAt);
        continue;
      }
      // 引擎判定已死、却还挂在场景里的船（无头 session 的副作用）：模组补最后一脚。
      if (finalizeDeadCrewShip(scene, member, entity)) {
        combatTargets.delete(crewID);
        phaseEnd("combat.pre", preAt);
        continue;
      }
      phaseEnd("combat.pre", preAt);
      // 搜索半径按船员船自己的锁定距离（maxTargetRange / 属性 76），而不是固定 60 km：
      // 锁不到的目标选出来也打不了，只会白扫 + 刷“锁不上”。
      const lockRange = lockRangeOf(entity);
      const searchRange = lockRange > 0 ? lockRange : freeFireRange;
      const current = combatTargets.get(crewID) || 0;
      // Is the ship behind the current target still there? A target that vanished must be
      // identified after it is gone (S2: refresh the grudge on a kill).
      // 单独计时：这是每条船每拍的第二次 getEntityByID，实测它就是"缝隙"里的黑洞。
      const curAt = phaseAt();
      const currentEntity = current && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(current)
        : null;
      phaseEnd("combat.current", curAt);
      const acceptsWarTargets = engagementRule !== "npc";
      let targetForMember = 0;
      let pickReason = "";
      const pickAt = phaseAt();
      if (freeFireActive) {
        // R1 (P3/P4): build the candidate set — scan + retaliation + the commander's
        // target — and pick one, instead of stopping at the first non-empty branch.
        let revenge = 0;
        if (acceptsWarTargets) {
          // 先看"谁打了我"：比重新扫最近的敌人更准。
          revenge = retaliationTargetFor(member, scene);
          maybeRecordRetaliation(scene, member, entity, freeFireExclude);
        }
        const stickyBlacklist = blacklistFor(crewID, now());
        // C1：当前目标还能打就沿用，不要每个 tick 全场景重扫（实测 combat 段 2.9 s）。
        // 但必须和 pickTargetFor 用同一套"合法目标"口径（交战规则 + 仇人优先级），
        // 否则会一直咬着一个已经不该打的目标。
        const stickyLegal = currentEntity
          && (currentEntity.nativeNpc === true
            || (acceptsWarTargets && isWarOpponent(crewID, currentEntity)));
        const canStick = !focusActive
          && !revenge
          && current > 0
          && currentEntity
          && stickyLegal
          && currentEntity.kind === "ship"
          && !combat.isCapsuleEntity(currentEntity)
          && !freeFireExclude.has(Number(current))
          && String(currentEntity.mode || "").toUpperCase() !== "WARP"
          && mining.surfaceDistance(entity, currentEntity) <= searchRange
          && !stickyBlacklist.has(Number(current))
          // 仇人/军团扩散会改变"谁最近可打"：这类目标不沿用，仍交给 pickTargetFor。
          && !isGrudged(currentEntity, session);
        const cooldownUntil = Number(scanCooldownUntil.get(crewID)) || 0;
        // O5：没有候选之后 2 s 内不重扫；集火/复仇/指挥官目标变化不受冷却限制。
        const cooling = !canStick && !revenge && !focusActive && now() < cooldownUntil;
        const picked = canStick
          ? {targetID: Number(current) || 0, reason: "sticky", capsules: [], candidates: [Number(current) || 0]}
          : cooling
            ? {targetID: 0, reason: "cooldown", capsules: [], candidates: []}
            : combat.pickTargetFor({
          scene,
          sourceEntity: entity,
          crewID,
          excludeIDs: freeFireExclude,
          blacklist: blacklistFor(crewID, now()),
          maxMeters: searchRange,
          // 共用本拍的场景快照（不传就会每条船各扫一次全场景）。
          candidates: sceneRows,
          // 交战规则：npc = 只有原生 NPC；war = 加上与我们宣战的角色。
          // S2/B: 仇人名单凌驾于交战规则之上（名单里的人不需要宣战关系）。
          accept: (candidate) => isGrudged(candidate, session)
            || (acceptsWarTargets && isWarOpponent(crewID, candidate)),
          commanderTarget,
          focus: focusActive,
          currentTarget: current,
          priorityTargetIDs: revenge ? [revenge] : [],
          stickiness: 1.25,
          maxCandidates: 8,
          // The runtime's clock, not Date.now(): the blacklist TTL is compared against it.
          nowMs: now(),
        });
        // R3: a capsule is logged once, never retried.
        for (const capsuleID of picked.capsules) {
          if (capsuleWarned.has(capsuleID)) {
            continue;
          }
          capsuleWarned.add(capsuleID);
          log(`[combat] 跳过胶囊 ${capsuleID}（打蛋会吃击杀权与声望惩罚）`);
        }
        targetForMember = Number(picked.targetID) || 0;
        pickReason = String(picked.reason || "");
        if (targetForMember > 0) {
          scanCooldownUntil.delete(crewID);
        } else if (!canStick && !cooling) {
          scanCooldownUntil.set(crewID, now() + (Number(configs_behavior().scanCooldownMs) || 2000));
        }
        if (!targetForMember && !cooling) {
          // 以前这里完全静默：自由开火开着、却没有任何日志，看起来像没反应。
          explainNoCombatTarget(scene, member, entity, crewID, searchRange, freeFireExclude);
        }
      } else {
        // 听令 only: without free fire the crew shoots exactly what the player shoots.
        // A3：指挥官锁的可能是不在当前场景的实体（跨星系/已消失），先校验再下令，
        // 否则每 45 秒都会白锁一次并刷一条“不在当前星系”。
        // 建筑：只有“指挥官正用模块指着它”且不是自家军团/联盟的建筑才算命令。
        const commanderEntity = commanderTargetEntity;
        const structureOrderRefused = commanderEntity
          && commanderEntity.kind === "structure"
          && isCommandedStructureTarget(commanderEntity, session) !== true;
        targetForMember = commanderEntity && !structureOrderRefused ? commanderTarget : 0;
        pickReason = commanderEntity ? "order" : "order-missing";
      }
      phaseEnd("combat.pick", pickAt);
      // pick 与 engage 之间：目标切换/停火判定 + disengageMember（会关模块 → 又一次全船属性重算）。
      // 目标在 110↔108 之间反复切换时，这一段每条船每拍都可能跑。
      const switchAt = phaseAt();
      // R3: whatever the source (order or scan), our own ship / a fleet mate / a capsule
      // is never engaged — this is the TARGET_SELF path.
      if (targetForMember && freeFireExclude.has(Number(targetForMember))) {
        logCombatOnce(crewID, targetForMember, "excluded",
          `[combat] ${member.name} 的目标 ${targetForMember} 是友军/自己的船，已排除`);
        targetForMember = 0;
      }
      if (targetForMember && combat.isCapsuleEntity(
        typeof scene.getEntityByID === "function" ? scene.getEntityByID(targetForMember) : null,
      )) {
        logCombatOnce(crewID, targetForMember, "capsule",
          `[combat] ${member.name} 的目标 ${targetForMember} 是胶囊，已跳过`);
        targetForMember = 0;
      }
      if (paused || !targetForMember) {
        // Lose the target for a moment (lock re-acquire, click) and the crew used to stop and
        // restart every module: stick to the current target for a few seconds instead.
        const stillThere = currentEntity;
        const missingAt = Number(targetMissingSince.get(crewID)) || 0;
        if (!paused && current && stillThere) {
          if (!missingAt) {
            targetMissingSince.set(crewID, now());
            continue;
          }
          if (now() - missingAt < 3000) {
            continue;
          }
        }
        targetMissingSince.delete(crewID);
        stopChase(crewID, member);
        if (current) {
          disengageMember(scene, session, member);
          const why = paused
            ? "已停火（等待新目标）"
            : freeFireActive ? "附近没有可攻击的目标，停火" : "指挥官没有目标，停火";
          logCombatOnce(crewID, current, why, `[combat] ${member.name} ${why}`);
        }
        continue;
      }
      targetMissingSince.delete(crewID);
      // A destroyed target needs no debounce: take the next one at once (P4).
      const currentGone = Boolean(current) && !currentEntity;
      if (currentGone) {
        const seen = lastTargetSeen.get(crewID);
        if (seen && Number(seen.itemID) === Number(current) && seen.characterID) {
          // S2/R4: the ship we were shooting is gone (击毁 or 跳走) — refresh the grudge
          // so his corporation stays hostile for another two minutes.
          grudgeCharacter(seen.characterID, {session, name: seen.name});
        }
        lastTargetSeen.delete(crewID);
      }
      if (current !== targetForMember) {
        // Debounce the switch: only commit when the new target survives two ticks.
        // Focus fire is an explicit player order, so it takes effect at once.
        const pending = Number(pendingCombatTarget.get(crewID)) || 0;
        const urgent = pickReason === "focus";
        if (!currentGone && !urgent && pending !== targetForMember) {
          pendingCombatTarget.set(crewID, targetForMember);
          if (current) {
            continue;
          }
        }
      }
      pendingCombatTarget.delete(crewID);
      if (current !== targetForMember) {
        // 换目标：**不要** disengageMember（那会 stopCombat + stopDefense，即把武器和防御
        // 模块全关掉）。实测这一段就是 combat.switch：单拍 1.8–4.0 s，因为每次开关模块都是
        // 引擎的一次全船属性重算，而下一拍 engageMember/防御段还要把它们全部开回来。
        // 防御模块（增强器/制导计算机）本来就是"对自己"的，与打谁无关，更没理由关。
        // 只清掉模组的旧目标记账，engageMember 成功后会自己 set 新目标。
        combatTargets.delete(crewID);
        if (current) {
          log(`[combat] ${member.name} 目标变为 ${targetForMember}，切换`);
        }
      }
      // Remember who this crew is shooting, so a kill can still be attributed after the
      // entity is gone (S2/R4 refreshes the grudge on 击毁).
      const engagedEntity = typeof scene.getEntityByID === "function" ? scene.getEntityByID(targetForMember) : null;
      if (engagedEntity) {
        lastTargetSeen.set(crewID, {
          itemID: Number(targetForMember),
          characterID: characterIDOf(engagedEntity),
          name: String(engagedEntity.itemName || ""),
        });
      }
      // P3：这条船已知没武器 → 跳过整个武器交战流程（吸电/中和会自己挑目标）。
      const noWeaponAt = Number(noWeaponShips.get(crewID)) || 0;
      const skipForNoWeapon = noWeaponAt > 0 && now() - noWeaponAt < NO_WEAPON_TTL_MS;
      const engageAt = phaseAt();
      phaseEnd("combat.switch", switchAt);
      const result = skipForNoWeapon
        ? {ok: false, reason: "NO_WEAPON_MODULE_ONLINE", cached: true}
        : engageMember(scene, session, member, targetForMember, steps);
      phaseEnd("combat.engage", engageAt);
      // 走唯一闸门（节流与预算都在里面）：这一拍可能已经在 engageMember 里用掉了预算。
      const defenseAt = phaseAt();
      maybeRunDefenseFor(scene, session, member, entity);
      phaseEnd("combat.defense", defenseAt);
      if (!result.ok && (result.cached === true || result.noWeapons === true)) {
        // 没武器 / 后勤船：不刷「无法攻击」、不进黑名单；原因由 diagnose 行说一次就够。
        continue;
      }
      const tailAt = phaseAt();
      if (!result.ok && result.outOfRange === true) {
        // 打不到：按配置追近（默认开）。
        startChase(scene, member, entity, crewID, targetForMember, result.rangeMeters);
      } else if (result.ok || result.pending === true) {
        // 已经在打了（或锁定中）：如果之前是追击过来的，继续保持贴身，别被拉回玩家环。
      } else {
        stopChase(crewID, member);
      }
      if (!result.ok) {
        const reason = String(result.reason || "");
        if (isPermanentLockFailure(reason)) {
          // R2/P1: TETHERED / SELF / gone would otherwise be retried every tick forever.
          blacklistAdd(crewID, targetForMember, reason);
          combatTargets.delete(crewID);
          logCombatOnce(crewID, targetForMember, reason,
            `[combat] ${member.name} 锁不上 ${targetForMember}（${reason}），` +
            `${Math.round(BLACKLIST_TTL_MS / 1000)} 秒内不再尝试`);
        } else {
          logCombatOnce(crewID, targetForMember, reason,
            `[combat] ${member.name} 无法攻击 ${targetForMember}：${reason}`);
        }
      }
      phaseEnd("combat.tail", tailAt);
    }
    phaseEnd("combat.loop", loopAt);
  }
  /**
   * M4: make the crew mine. Each ship activates its own online mining modules
   * on the nearest asteroid to *the player*, so the ore lands in the crew
   * member's own hold.
   */
  /** `/crewmine mine <名字> off`：停止采矿（关模块 + 清目标 + 退出采矿名单）。 */
  function stopMiningCrew(selector, context = {}) {
    const session = context.session || null;
    const scene = follow.sceneFor(deps, session);
    const selected = selectMembers(selector, context);
    if (selected.members.length === 0) {
      return {
        ok: false,
        lines: selected.problems.length > 0
          ? selected.problems
          : ["本星系没有在役船员" + (selected.skipped > 0 ? "（另有 " + selected.skipped + " 人在别处）" : "")],
      };
    }
    const lines = [];
    for (const member of selected.members) {
      const crewID = Number(member.characterID) || 0;
      miningWanted.delete(crewID);
      miningPending.delete(crewID);
      disengageMember(scene, session, member);
      log("[mine] " + member.name + " 停止采矿");
      lines.push(member.name + "：已停止采矿");
    }
    return {ok: true, lines};
  }

  /**
   * P0.1：把换矿时没轮到的模块在后续 tick 里一门一门开起来。
   * 必须在 watch tick（1 s）里跑 —— 服务循环 15 s 一次，太慢。
   * 目标没了 / 模块一直开不起来（超距、离线、没晶体）就放弃，交给现有的重选逻辑。
   */
  function continuePendingMining(scene, session, entry, entity) {
    const crewID = Number(entry && entry.characterID) || 0;
    const pending = miningPending.get(crewID);
    if (!pending || !entity || !scene) {
      return;
    }
    const rock = typeof scene.getEntityByID === "function" ? scene.getEntityByID(pending.rockID) : null;
    if (!rock || !mining.rockOre(rock, {scene, miningState: deps.miningState})) {
      miningPending.delete(crewID);
      logCombatOnce(crewID, pending.rockID, "mine:pending:gone",
        `[mine] ${entry.name} 续开中止：目标矿不在了`);
      return;
    }
    const effects = entity.activeModuleEffects instanceof Map ? entity.activeModuleEffects : null;
    const still = (pending.modules || []).filter((row) => {
      const moduleID = Number(row && row.moduleItem && row.moduleItem.itemID) || 0;
      return moduleID > 0 && !(effects && effects.has(moduleID));
    });
    if (still.length === 0) {
      miningPending.delete(crewID);
      return;
    }
    pending.modules = still;
    const next = still[0];
    const moduleID = Number(next.moduleItem && next.moduleItem.itemID) || 0;
    let result = null;
    try {
      result = scene.activateGenericModule(
        mining.moduleSessionFor(session, crewID, entity),
        next.moduleItem,
        next.effectRecord && next.effectRecord.name,
        {targetID: pending.rockID},
      );
    } catch (error) {
      result = {success: false, errorMsg: error && error.message};
    }
    if (result && result.success === true) {
      pending.attempts = 0;
      pending.modules = still.filter((row) => (Number(row.moduleItem && row.moduleItem.itemID) || 0) !== moduleID);
      if (pending.modules.length === 0) {
        miningPending.delete(crewID);
      }
      return;
    }
    pending.attempts = Number(pending.attempts || 0) + 1;
    if (pending.attempts >= MINING_PENDING_MAX_ATTEMPTS) {
      miningPending.delete(crewID);
      logCombatOnce(crewID, pending.rockID, "mine:pending:fail",
        `[mine] ${entry.name} 续开放弃：${(result && result.errorMsg) || "未知"}（还剩 ${still.length} 门）`);
    }
  }

  function mineCrew(selector, context = {}) {
    const session = context.session || null;
    const systemID = currentSystemID(session);
    const playerShipID = Number(session && session._space && session._space.shipID) || 0;
    if (!systemID || !playerShipID) {
      return {ok: false, lines: ["请在太空里下令采矿（当前没有所在星系/飞船）"]};
    }
    const selected = selectMembers(selector, context);
    if (selected.members.length === 0) {
      return {
        ok: false,
        lines: selected.problems.length > 0
          ? selected.problems
          : [`本星系没有在役船员${selected.skipped > 0 ? `（另有 ${selected.skipped} 人在别处）` : ""}`],
      };
    }
    const lines = [];
    let miningCount = 0;
    let scene = follow.sceneFor(deps, session);
    const playerEntity = follow.locate(deps, {session, shipID: playerShipID}).entity || null;
    // 先把已经失效的占位清掉（矿采空 / 人已经停采），否则会挡住别人选矿。
    if (scene) {
      pruneRockClaims(scene);
    }
    // Spread the crew over different rocks: rocks already being mined (or claimed
    // earlier in this command) are skipped so eight miners do not drill one rock.
    const claimed = new Set();
    for (const member of selected.members) {
      const existing = scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(member.shipID)
        : null;
      if (existing && existing.activeModuleEffects instanceof Map) {
        for (const effect of existing.activeModuleEffects.values()) {
          const targetID = Number(effect && effect.targetID) || 0;
          if (targetID) {
            claimed.add(targetID);
          }
        }
      }
    }
    // M5：批量下令（一次点多人）时按 crewID 散列错峰，避免整队同拍开挖 →
    // 同拍采空 → 同拍重选。单人下令不错峰（玩家点了就要立刻动）。
    const isBatch = selected.members.length > 1;
    for (const member of selected.members) {
      const crewID = Number(member.characterID);
      if (chainActive.has(crewID)) {
        lines.push(`${member.name}：上一条采矿指令仍在执行`);
        continue;
      }
      if (isBatch && !staggerPending.has(crewID)) {
        const delayMs = staggerDelayFor(crewID);
        if (delayMs > 0) {
          staggerPending.add(crewID);
          scheduleAfter(delayMs, () => {
            staggerPending.delete(crewID);
            try {
              mineCrew(member.name, {session});
            } catch (_error) {
              /* 下一拍 watch/service 会再排 */
            }
          });
          lines.push(`${member.name}：错峰 ${Math.round(delayMs / 1000)} s 后开始选矿`);
          continue;
        }
      }
      const config = configForBlueprint(member.blueprintID);
      let maxDistance = config ? config.behavior.mineSearchRadiusMeters : 30000;
      const revived = ship.ensureEntity(deps, {
        session,
        scene,
        systemID,
        shipID: member.shipID,
        characterID: member.characterID,
        leader: playerEntity,
      });
      if (!revived.ok) {
        lines.push(`${member.name}：无法就位（${revived.reason}）`);
        continue;
      }
      scene = revived.scene || scene || follow.sceneFor(deps, session);
      const entity = scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(member.shipID)
        : null;
      if (!entity) {
        lines.push(`${member.name}：船不在场景里`);
        continue;
      }
      // 采矿搜索同样受锁定距离约束：锁不到的矿选出来也锁不上。
      const lockRange = lockRangeOf(entity);
      if (lockRange > 0) {
        maxDistance = Math.min(maxDistance, lockRange);
      }
      // S3/R5: a ship revived from its item after a restart has no doomsday attributes.
      applyDoomsdayPresence(scene, member, entity);
      let rock = null;
      const committed = activeRock.get(crewID);
      if (committed) {
        const committedEntity = typeof scene.getEntityByID === "function" ? scene.getEntityByID(committed) : null;
        if (committedEntity && mining.rockOre(committedEntity, {scene, miningState: deps.miningState})) {
          // 继续挖原来那块：占用表可能因为重启/懒清理丢了，这里补回来（幂等）。
          claimRock(scene, crewID, committed);
          rock = {entity: committedEntity, distance: mining.surfaceDistance(entity, committedEntity)};
        } else {
          activeRock.delete(crewID);
          releaseRockClaim(crewID);
        }
      }
      log(`[mine] ${member.name} 选矿 start used=${Math.round(holdVolumeOf(deps, {characterID: member.characterID, shipID: member.shipID}).used)}`);
      // P0.2：一次扫描同时给出「选中哪块」和「为什么没有」——以前失败时 rockInventory
      // 会把同一张静态实体表再扫一遍（11 名船员就是 22 份）。
      if (!rock) {
        const scanned = mining.pickRockDetailed({
          scene,
          // 以**自己这条船**为基准：以前用玩家船，全队「最近的一块」永远是同一个点。
          sourceEntity: entity || playerEntity,
          maxDistanceMeters: maxDistance,
          miningState: deps.miningState,
          // 本批已经选过的 + 别人已经认领的，都要排掉；否则重选/错峰这种
          // 「一人一次」的调用会各自从头挑最近的一块，整队又挤回同一块矿。
          excludeIDs: new Set([...claimed, ...rockClaimsByOthers(scene, crewID)]),
        });
        const inventory = scanned.inventory || {};
        const nearestKm = inventory.nearestMineableMeters == null
          ? null
          : Math.round(inventory.nearestMineableMeters / 1000);
        if (scanned.rock && scanned.beyondRadius) {
          // 半径内没有：只要有矿且不超过 2000 km，就去更远的那块，别原地空转。
          if (nearestKm != null && nearestKm * 1000 <= 2000000) {
            rock = scanned.rock;
            lines.push(
              `${member.name}：${Math.round(maxDistance / 1000)} km 内没有矿，改去 ${nearestKm} km 处的 ` +
              `${rock.entity.itemID}`,
            );
          }
        } else if (scanned.rock) {
          rock = scanned.rock;
        }
        if (!rock) {
          lines.push(
            `${member.name}：没有可采小行星（场景静态实体 ${inventory.statics || 0} 个，` +
            `其中小行星 ${inventory.rocks || 0} 个（有矿 ${inventory.mineable || 0} · 状态未知 ${inventory.unknown || 0} · ` +
            `已采空 ${Math.max(0, (inventory.rocks || 0) - (inventory.mineable || 0) - (inventory.unknown || 0))}），` +
            `${Math.round(maxDistance / 1000)} km 内 ${inventory.inRange || 0} 个` +
            `${nearestKm == null ? "" : `，最近的在 ${nearestKm} km`}）`,
          );
          continue;
        }
      }
      claimed.add(rock.entity.itemID);
      activeRock.set(crewID, Number(rock.entity.itemID) || 0);
      // 选中就占用（不是等模块开起来）：飞过去要十几秒，这段时间别人也得看得见。
      claimRock(scene, crewID, rock.entity.itemID);
      log(`[mine] ${member.name} 目标=${rock.entity.itemID} 船员面距=${Math.round((rock.distance || 0) / 1000)}km`);
      const resolved = mining.miningModules(deps, {characterID: member.characterID, shipID: member.shipID});
      if (!resolved.ok) {
        lines.push(`${member.name}：${resolved.problems.join(" · ")}`);
        continue;
      }
      const moduleSession = mining.moduleSessionFor(session, member.characterID, entity);
      log(`[mine] ${member.name} 模块=${resolved.modules.length} 射程=${Math.round((mining.moduleRange(resolved.modules) || 0) / 1000)}km`);
      // Rocks may be picked up to `mineSearchRadiusMeters` away, but a module only
      // reaches `mineEngageRangeMeters`: fly to the rock first, then lock+activate.
      // Hold at the module's own max range minus 1 km — far enough to stay put,
      // close enough that activation is guaranteed. Once the modules are running
      // the approach chain stops, so a burst that changes the range later does
      // not make the crew drift.
      const moduleRangeMeters = mining.moduleRange(resolved.modules);
      const engageRange = Math.max(2000, moduleRangeMeters > 0 ? moduleRangeMeters : (Number(config && config.behavior.mineEngageRangeMeters) || 15000));
      // 停在射程的 80%（留 20% 余量）：以前是 -1km，船稍微漂一点就 OUT_OF_RANGE，
      // 然后被"保持 N km"反复拉回、永远进不了射程。
      const holdDistance = Math.max(1500, Math.round(engageRange * 0.8));
      const tryActivate = () => {
        const current = scene && typeof scene.getEntityByID === "function"
          ? scene.getEntityByID(member.shipID)
          : null;
        if (!current) {
          return {ok: false, reason: "船不在场景里"};
        }
        if (String(current.mode || "").toUpperCase() === "WARP") {
          return {ok: false, reason: "WARPING"};
        }
        const distance = mining.surfaceDistance(current, rock.entity);
        if (distance > engageRange) {
          return {ok: false, reason: "OUT_OF_RANGE", distance};
        }
        const lock = mining.ensureTargetLock({scene, entity: current, rock: rock.entity});
        if (!lock.ok) {
          return {ok: false, reason: lock.reason};
        }
        if (!lock.locked) {
          return {ok: false, reason: "LOCKING", lockDurationMs: lock.lockDurationMs};
        }
        const result = mining.activateOnRock({
          scene,
          session: mining.moduleSessionFor(session, member.characterID, current),
          entity: current,
          rock: rock.entity,
          modules: resolved.modules,
          // P0.1：这个 tick 只新开一门，其余交给 watch tick（1 s）续开。
          maxNewActivations: 1,
        });
        if (result.ok) {
          const remaining = Array.isArray(result.remaining) ? result.remaining : [];
          if (remaining.length > 0) {
            miningPending.set(crewID, {
              rockID: Number(rock.entity.itemID) || 0,
              modules: remaining,
              attempts: 0,
            });
            log(`[mine] ${member.name} 激活 ${result.started || 0} 门 · 剩 ${remaining.length} 门下一 tick 续开`
              + `（一次只开一门，避免同 tick 冻结）`);
          } else {
            miningPending.delete(crewID);
          }
        }
        return result.ok
          ? {ok: true, activated: result.activated, errors: result.errors, distance}
          : {ok: false, reason: result.errors.join(" · "), distance};
      };
      const approach = () => {
        // The crew must SIT at the rock: following the player left them 28 km away
        // (beyond the 24 km module range) and the engine stopped the cycle. Warp
        // to a point `holdDistance` from the rock, then they simply stay there.
        try {
          const rockPos = (rock.entity && rock.entity.position) || null;
          const shipPos = (entity && entity.position) || null;
          if (rockPos && shipPos && deps.runtime && typeof deps.runtime.warpDynamicEntityToPoint === "function") {
            const dx = Number(rockPos.x) - Number(shipPos.x);
            const dy = Number(rockPos.y) - Number(shipPos.y);
            const dz = Number(rockPos.z) - Number(shipPos.z);
            const length = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
            const point = {
              x: Number(rockPos.x) - (dx / length) * holdDistance,
              y: Number(rockPos.y) - (dy / length) * holdDistance,
              z: Number(rockPos.z) - (dz / length) * holdDistance,
            };
            const warp = deps.runtime.warpDynamicEntityToPoint(systemID, member.shipID, point, {});
            lastApproach.set(Number(member.characterID), {
              at: new Date().toISOString().slice(11, 19),
              result: warp && warp.success === true ? "warp ok" : JSON.stringify(warp || null),
            });
            if (warp && warp.success === true) {
              log(`${member.name}：跃迁至矿旁（表面保持 ${Math.round(holdDistance / 1000)} km）`);
              return warp;
            }
            log(`${member.name}：跃迁到矿旁失败（${JSON.stringify((warp && (warp.errorMsg || warp.success)) || null)}），改用跟随`);
          }
        } catch (error) {
          lastApproach.set(Number(member.characterID), {
            at: new Date().toISOString().slice(11, 19),
            result: `warp threw: ${error && error.message}`,
          });
        }
        // Fallback: keep-at-range on the rock.
        let result = null;
        try {
          if (deps.runtime && typeof deps.runtime.followDynamicEntity === "function") {
            result = deps.runtime.followDynamicEntity(
              systemID,
              member.shipID,
              rock.entity.itemID,
              holdDistance,
              {broadcast: true},
            );
          } else {
            result = {success: false, errorMsg: "NO_FOLLOW_API"};
          }
        } catch (error) {
          result = {success: false, errorMsg: `THREW:${error && error.message}`};
        }
        lastApproach.set(Number(member.characterID), {
          at: new Date().toISOString().slice(11, 19),
          result: result === true ? "ok" : JSON.stringify(result && (result.errorMsg || result.success === true ? result.success === true ? "ok" : result.errorMsg : result)),
        });
        log(`${member.name}：保持 ${Math.round(holdDistance / 1000)} km 指令 → ${result === true ? "ok" : JSON.stringify(result)}`);
        return result;
      };
      const first = tryActivate();
      if (first.ok) {
        miningCount += 1;
        lines.push(
          `${member.name}：采矿中 · ${first.activated.length} 个模块` +
          ` · 目标 ${rock.entity.itemID}（${Math.round(first.distance / 1000)} km）` +
          `${first.errors.length > 0 ? ` · 部分失败 ${first.errors.join(" · ")}` : ""}`,
        );
        continue;
      }
      if (first.reason === "OUT_OF_RANGE" || first.reason === "WARPING") {
        chainActive.add(crewID);
        // Fly to the rock and keep retrying. Every attempt re-issues the approach
        // (the first command is refused while the ship is still warping in), and
        // the chain ends the moment the modules are running.
        const firstApproach = approach();
        const approachOk = firstApproach === true
          || Boolean(firstApproach && firstApproach.success === true);
        const retry = (attempt) => {
          const result = tryActivate();
          if (result.ok) {
            chainActive.delete(crewID);
            log(`${member.name}：抵达 ${Math.round(result.distance / 1000)} km，${result.activated.length} 个模块开始采矿` +
            ` · effectState=${JSON.stringify(result.effectStates || [])}`);
            return;
          }
          if (result.reason === "LOCKING") {
            // The lock takes time: wait for it, then activate. Treating this as a
            // terminal error was why the modules never started in game.
            const waitMs = Math.max(1000, Number(result.lockDurationMs) || 5000) + 500;
            log(`${member.name}：锁定中 ${Math.round(waitMs / 100) / 10}s（第 ${attempt} 次）`);
            if (attempt < 30) {
              scheduleAfter(waitMs, () => retry(attempt + 1));
            }
            return;
          }
          if (result.reason === "OUT_OF_RANGE" || result.reason === "WARPING") {
            if (attempt < 30) {
              const step = approach();
              if (attempt % 3 === 0) {
                log(`${member.name}：接近中（第 ${attempt} 次，${Math.round((result.distance || 0) / 1000)} km）` +
                  ` 指令=${step === true ? "ok" : JSON.stringify(step && step.errorMsg || step)}`);
              }
              scheduleAfter(4000, () => retry(attempt + 1));
            } else {
              chainActive.delete(crewID);
              log(`${member.name}：放弃接近（仍在 ${Math.round((result.distance || 0) / 1000)} km）`);
            }
            return;
          }
          log(`${member.name}：采矿未开始（${result.reason}）`);
        };
        scheduleAfter(4000, () => retry(1));
        miningCount += 1;
        lines.push(
          `${member.name}：${first.reason === "WARPING" ? "跃迁中，落地后前往目标" : `前往目标（${Math.round(first.distance / 1000)} km）`}` +
          ` · 保持 ${Math.round(holdDistance / 1000)} km（射程 ${Math.round(engageRange / 1000)} km） · 目标 ${rock.entity.itemID}` +
          `${approachOk ? "" : ` · 接近指令被拒(${(firstApproach && firstApproach.errorMsg) || "false"})`}`,
        );
        continue;
      }
      if (first.reason === "LOCKING") {
        const waitMs = Math.max(1000, Number(first.lockDurationMs) || 5000) + 500;
        scheduleAfter(waitMs, () => {
          const result = tryActivate();
          log(`${member.name}：锁定后激活 ${result.ok ? `成功 ${result.activated.length} 个模块` : `失败 ${result.reason}`}`);
        });
        miningCount += 1;
        lines.push(
          `${member.name}：锁定中（${Math.round(waitMs / 100) / 10}s 后开始采矿）` +
          ` · 目标 ${rock.entity.itemID}（${Math.round(rock.distance / 1000)} km）`,
        );
        continue;
      }
      lines.push(`${member.name}：采矿启动失败 ${first.reason}`);
    }
    lines.unshift(`采矿 ${miningCount} / ${selected.members.length} 人（星系 ${systemID}）`);
    if (miningCount > 0) {
      for (const member of selected.members) {
        const crewID = Number(member.characterID);
        miningWanted.add(crewID);
        // Persist the intent: miningWanted lives in memory and dies with a restart.
        member.mining = true;
        persistMember(member);
      }
      startServiceLoop(session);
    }
    return {ok: miningCount > 0, lines};
  }

  // Per-character "currently delivering" flag (M5 hysteresis).
  const haulState = new Map();
  // Per-character "player holds are full" marker (manual resume by design).
  const waitingForSpace = new Map();
  // M5: the automatic service loop (compress + deliver) while mining.
  let serviceTimer = null;
  let serviceSession = null;
  // Restore "this crew was told to mine" from the pool (survives restarts).
  function restoreMiningIntent() {
    for (const entry of (stateStore.get().pool || [])) {
      if (entry.summoned === true && entry.mining === true) {
        miningWanted.add(Number(entry.characterID));
      }
    }
  }
  // Last service-loop outcome, surfaced by /crewmine debug (the loop's own log
  // goes to the server console, which the player never sees).
  let lastService = null;
  // O4：service tick 轮转游标（每次只处理 1 艘，避免 3–4 s 的单帧尖峰）。
  let serviceCursor = 0;
  // Outcome of the last automatic re-target attempt (surfaced by /crewmine debug).
  let lastRetarget = null;
  // 1 s sampler: remembers the module effect state so a disappearance can be
  // explained by its last stopReason instead of guessed.
  const miningWatch = new Map();
  // ---- M3：重选队列 -----------------------------------------------------------
  // service tick（15–30 s）只入队；真正的 mineCrew 在 1 s 的 watch tick 里出队，
  // 每拍一个**时间预算**，避免 24 条船同时换矿把单帧顶到几秒。
  const miningRetargetQueue = new Map(); // crewID -> {at, attempts}
  const RETARGET_BUDGET_MS = 300;
  const RETARGET_MAX_AGE_MS = 60000;
  const RETARGET_MAX_ATTEMPTS = 3;

  // ---- M5：批量下令的错峰窗口 ------------------------------------------------
  // 同一批船如果同拍开挖，它们的 cycle 时长一样，之后会一直同拍采空、同拍重选。
  // 按 crewID 散列到 0–17 s（约一个采矿 cycle）里，把这条同步链打断。
  const STAGGER_WINDOW_MS = 17000;
  const staggerPending = new Set();

  function staggerDelayFor(crewID) {
    const id = Number(crewID) || 0;
    if (!id) {
      return 0;
    }
    // 一个便宜的整数散列，保证同一 crewID 每次都落在同一个位置。
    const mixed = Math.imul(id ^ 0x9e3779b9, 2654435761) >>> 0;
    return mixed % STAGGER_WINDOW_MS;
  }

  /** 入队（幂等：已经在队列里的只刷新时间，不重复插）。返回 true = 新入队。 */
  function enqueueRetarget(entry) {
    const crewID = Number(entry && entry.characterID) || 0;
    if (!crewID) {
      return false;
    }
    if (miningRetargetQueue.has(crewID)) {
      return false;
    }
    miningRetargetQueue.set(crewID, {at: now(), attempts: 0});
    return true;
  }

  /**
   * 出队执行，最多花 `RETARGET_BUDGET_MS`，但**每拍至少处理 1 条**（否则队列会饿死）。
   * 出队时复核：在役 / 还想挖 / 不在等货舱 / 实体还在 / 没超龄 / 次数没超。
   */
  function drainRetargetQueue(scene, session) {
    if (miningRetargetQueue.size === 0) {
      return 0;
    }
    const startedAt = Date.now();
    let processed = 0;
    for (const [crewID, row] of [...miningRetargetQueue]) {
      if (processed > 0 && Date.now() - startedAt >= RETARGET_BUDGET_MS) {
        break;
      }
      miningRetargetQueue.delete(crewID);
      const entry = (stateStore.get().pool || []).find((member) => Number(member.characterID) === crewID);
      if (!entry || entry.summoned !== true) {
        continue;
      }
      if (!miningWanted.has(crewID) || waitingForSpace.has(crewID)) {
        continue;
      }
      if (now() - (Number(row.at) || 0) > RETARGET_MAX_AGE_MS) {
        log(`[mine] ${entry.name}：重选排队超过 ${Math.round(RETARGET_MAX_AGE_MS / 1000)} s，丢弃`);
        continue;
      }
      if (Number(row.attempts) >= RETARGET_MAX_ATTEMPTS) {
        log(`[mine] ${entry.name}：重选已连续失败 ${RETARGET_MAX_ATTEMPTS} 次，先放弃`);
        continue;
      }
      if (!scene || typeof scene.getEntityByID !== "function" || !scene.getEntityByID(entry.shipID)) {
        continue;
      }
      const retryStartedAt = Date.now();
      try {
        const retry = mineCrew(entry.name, {session});
        const retryMs = Date.now() - retryStartedAt;
        processed += 1;
        if (retryMs >= 200) {
          log(`[perf] mine retry ${entry.name} 用时 ${retryMs} ms（队列 ${miningRetargetQueue.size}）`);
        }
        lastRetarget = {
          at: new Date().toISOString().slice(11, 19),
          name: entry.name,
          targets: 0,
          lines: (retry.lines || []).slice(0, 3),
        };
        // 没成功（比如还没靠近）就放回队列，下一拍再来，最多 3 次。
        if (retry && retry.ok !== true) {
          miningRetargetQueue.set(crewID, {at: row.at, attempts: Number(row.attempts) + 1});
        }
      } catch (error) {
        processed += 1;
        lastRetarget = {
          at: new Date().toISOString().slice(11, 19),
          name: entry.name,
          targets: 0,
          lines: [`异常 ${error && error.message}`],
        };
        log(`${entry.name}：重新选矿失败 ${error && error.message}`);
      }
    }
    return processed;
  }

  // Which rock each crew member is committed to, and whether a chain is running.
  // Without this, overlapping retry chains re-target the same modules and kill
  // each other's cycles (the "mines a bit, stops" symptom).
  const activeRock = new Map();
  // ---- 矿的认领表（2026-10-31：「整队挤在同一块矿上」的根因） -------------------
  //
  // 以前「谁挖哪块」只活在 mineCrew 的一次调用里（局部 Set `claimed`）。可实际
  // 下单几乎全是**一人一次**：错峰把批量拆成 mineCrew(名字)（:3739），矿采空后的
  // 重选队列也是逐个 mineCrew(名字)（:4135）。单人调用时 claimed 必为空，于是每个
  // 人都从空集合里挑「离自己最近的一块」——全员同一个 itemID，矿上的激光全打在
  // 同一块石头上。
  //
  // 认领表活过单次调用：**选中那一刻**就占用（不是等模块开起来——那中间还有十几秒
  // 在飞），别人选矿时排除。只放内存、不落盘：落盘会留下「占位残留」，重启后让
  // watch tick 重新选即可。
  const rockClaims = new Map(); // "systemID:itemID" -> crewID
  const crewRockKey = new Map(); // crewID -> "systemID:itemID"（释放 O(1)，不用扫全表）

  function rockSceneKey(scene) {
    return Number(scene && (scene.systemID || scene.sceneDescriptor)) || 0;
  }

  function rockKeyOf(scene, itemID) {
    return `${rockSceneKey(scene)}:${Number(itemID) || 0}`;
  }

  /** 这人不再占着那块矿了（停采 / 换矿 / 矿没了）。 */
  function releaseRockClaim(crewID) {
    const key = Number(crewID) || 0;
    if (!key) {
      return false;
    }
    const claimKey = crewRockKey.get(key);
    if (claimKey && rockClaims.get(claimKey) === key) {
      rockClaims.delete(claimKey);
    }
    crewRockKey.delete(key);
    return true;
  }

  /** 占用（幂等）：同一人换矿时先退旧的，绝不留下两处占位。 */
  function claimRock(scene, crewID, itemID) {
    const key = Number(crewID) || 0;
    const rockID = Number(itemID) || 0;
    if (!key || !rockID) {
      return false;
    }
    releaseRockClaim(key);
    const claimKey = rockKeyOf(scene, rockID);
    // 已经有人占了就别抢：矿不够时大家共享（pickFromScan 的兜底），占位只记先到的
    // 那个人 —— 抢过来反而会让先到的人一释放就把整块矿从表里抹掉。
    const owner = rockClaims.get(claimKey);
    if (!owner || owner === key) {
      rockClaims.set(claimKey, key);
      crewRockKey.set(key, claimKey);
    }
    return true;
  }

  /** 本星系里已经被**别人**认领的矿 id（选矿时并进 excludeIDs）。 */
  function rockClaimsByOthers(scene, crewID) {
    const self = Number(crewID) || 0;
    const prefix = `${rockSceneKey(scene)}:`;
    const out = new Set();
    for (const [claimKey, owner] of rockClaims) {
      if (owner === self || !claimKey.startsWith(prefix)) {
        continue;
      }
      out.add(Number(claimKey.slice(prefix.length)));
    }
    return out;
  }

  /**
   * 懒清理：矿实体没了（采空被引擎摘掉）/ 这人已经不在采矿名单（停采、召回、解散、
   * 被爆）→ 释放。比在每个退出路径上手动 delete 更耐改：漏一处就会永久占住一块矿。
   */
  function pruneRockClaims(scene) {
    if (rockClaims.size === 0) {
      return 0;
    }
    // 拿不到实体表就不敢清：否则会把有效的占位当成「矿没了」整批丢掉。
    if (!scene || typeof scene.getEntityByID !== "function") {
      return 0;
    }
    let dropped = 0;
    for (const claimKey of [...rockClaims.keys()]) {
      const owner = rockClaims.get(claimKey);
      const itemID = Number(claimKey.slice(claimKey.indexOf(":") + 1)) || 0;
      const entity = itemID ? scene.getEntityByID(itemID) : null;
      if (!entity || !miningWanted.has(owner)) {
        rockClaims.delete(claimKey);
        if (crewRockKey.get(owner) === claimKey) {
          crewRockKey.delete(owner);
        }
        dropped += 1;
      }
    }
    return dropped;
  }
  // Last in-system catch-up warp per character (follow is subwarp only).
  const lastCatchup = new Map();
  const chainActive = new Set();
  let watchTimer = null;
  // 跟队跃迁的开关（runtime 级）。以前只看 configs[0].behavior.syncWarp，而
  // configs 按文件名排序、只有个别蓝图写过这个字段，结果整段代码从来没跑过。
  // 现在：命令显式设置优先，否则任一份蓝图打开即视为打开。
  let syncWarpOverride = null;

  /** 任一蓝图命中即算开启：面板/命令都会写全部蓝图，这里只是容错手改过单份文件的情况。 */
  function anyBehavior(predicate) {
    return (configStore.get().configs || []).some(
      (entry) => Boolean(entry && entry.behavior) && predicate(entry.behavior) === true,
    );
  }

  function syncWarpOn() {
    if (syncWarpOverride !== null) {
      return syncWarpOverride === true;
    }
    return anyBehavior((behavior) => behavior.syncWarp === true);
  }

  // 跟随阵型（runtime 级，和 syncWarp 同一套开关方式）：
  //   follow = 跟随（所有人同一个间距，引擎 FOLLOW）
  //   ladder = 阶梯（每人 station 依次外扩，引擎 FOLLOW）
  //   ring   = 环形槽位（都在同一圈上，自写刹车，250 ms 一拍）
  // 跟随/阵型的"当前指令" ------------------------------------------------
  // 唯一权威来源：命令与面板写这里，rearm / 环形控制器读这里。
  // 蓝图里的 followFormation / followDistance / crewSpacingMeters **不再驱动行为**
  // （用户 2026-10-25 定：蓝图不驱动，移动与站位是两套独立系统）。
  // 默认 idle = 召唤落地后静止等命令（"没有默认行动"）。
  // 持久化：租户 state.json 的 settings.followPlan（重启后记得上次的阵型/间距）。
  let followState = followStateModule.normalize(
    (stateStore.get().settings || {}).followPlan || null,
  );
  function followFormationMode() {
    return followState.mode; // "idle" | "follow" | "ladder" | "ring"
  }
  /** 已配置的表面间距（米）；null = 未配置。 */
  function followGapMeters() {
    return followStateModule.gapConfigured(followState) ? followState.gap : null;
  }
  function followSpacingMeters() {
    return followState.spacing;
  }
  /** 改状态（命令/面板都走这里），返回规整后的新状态。 */
  function setFollowState(patch) {
    followState = followStateModule.normalize({...followState, ...(patch || {})});
    // 持久化到租户 state.json 的 settings.followPlan（重启后记得上次的阵型/间距）。
    try {
      stateStore.update((state) => ({
        ...state,
        settings: {...(state.settings || {}), followPlan: {...followState}},
      }));
    } catch (error) {
      log(`[follow] 保存阵型状态失败 ${error && error.message}`);
    }
    return followState;
  }
  // Which crew are in mining mode (drives automatic re-targeting when a rock runs out).
  const miningWanted = new Set();
  // P0.1：换矿时只新开一门模块，剩下的排队到后续 tick（每次激活 = 全船属性重算 0.5–1.1 s）。
  // crewID -> {rockID, modules:[{moduleItem, effectRecord, moduleID}], attempts}
  const miningPending = new Map();
  // 每门模块最多补开几次就放弃（目标超距 / 模块离线 / 无晶体都会一直失败）。
  const MINING_PENDING_MAX_ATTEMPTS = 3;
  // P0.3：服务循环里的「续锁」从每 15 s 放宽到 45 s（watch tick 每秒已经会在丢锁时补锁）。
  const MINING_LOCK_RENEW_MS = 45000;
  const miningLockAt = new Map();
  // P0.4：交付被拒的原因按船 60 秒去重，不再每 15 s 打一遍同样的 REFUSED。
  const haulProblemAt = new Map();
  // P3：哪些船「刚才」查到没有在线武器 —— 带 TTL，不能永久记住：
  // 否则武器后来上线（或换了装配）也永远不会再尝试开火。
  const NO_WEAPON_TTL_MS = 30000;
  const noWeaponShips = new Map();
  const noWeaponLoggedAt = new Map();
  // [haul] 日志去重：每人上次的 "used:stacks"。
  const haulSeen = new Map();

  /** Where the ore goes: the player's own (industrial command) ship, ore hold. */
  function resolveDeliveryTarget(deps2, request = {}) {
    const ownerID = Number(request.playerCharacterID) || 0;
    const locationID = Number(request.playerShipID) || 0;
    if (!ownerID || !locationID) {
      return {ok: false, reason: "NO_PLAYER_SHIP"};
    }
    let flagID = 0;
    if (typeof deps2.oreHoldFlag === "function") {
      try {
        flagID = Number(deps2.oreHoldFlag({characterID: ownerID, shipID: locationID})) || 0;
      } catch (_error) {
        flagID = 0;
      }
    }
    if (!flagID) {
      flagID = Number(deps2.oreHoldFlagFallback) || 0;
    }
    const cargoFlagID = Number(deps2.cargoHoldFlagFallback) || 5;
    if (!flagID) {
      // No ore hold on this hull: the cargo hold is the only option.
      return {
        ok: true,
        ownerID,
        locationID,
        flagID: cargoFlagID,
        facilityBallID: locationID,
        label: `你的船 ${locationID}（货舱 flag ${cargoFlagID}）`,
        targets: [{ownerID, locationID, flagID: cargoFlagID, label: "货舱"}],
      };
    }
    return {
      ok: true,
      ownerID,
      locationID,
      flagID,
      // The facility ball of a player ship is the ship itself.
      facilityBallID: locationID,
      label: `你的船 ${locationID}（矿舱 flag ${flagID}）`,
      // Ore hold first; the cargo hold catches the "ore hold full" case.
      targets: [
        {ownerID, locationID, flagID, label: "矿舱"},
        {ownerID, locationID, flagID: cargoFlagID, label: "货舱"},
      ],
    };
  }

  /** Used/capacity of a ship's mining hold in m³. */
  // deps.holdVolume builds a full dogma resource snapshot and costs 500-1100 ms per
  // call (measured). Only the CAPACITY is needed from it, and capacity changes only
  // when the ship or its fit does, so it is cached; the USED volume is summed from
  // the real stacks (unit volume × quantity), which is cheap.
  const holdCapacityCache = new Map();
  const HOLD_CAPACITY_TTL_MS = 120000;

  function cachedHoldCapacity(deps2, characterID, shipID) {
    const key = `${characterID}:${shipID}`;
    const now = Date.now();
    const hit = holdCapacityCache.get(key);
    if (hit && now - hit.at < HOLD_CAPACITY_TTL_MS) {
      return hit.capacity;
    }
    let capacity = 0;
    if (typeof deps2.holdVolume === "function") {
      try {
        const result = deps2.holdVolume({characterID, shipID});
        if (result) {
          capacity = Number(result.capacity) || 0;
        }
      } catch (_error) {
        capacity = 0;
      }
    }
    holdCapacityCache.set(key, {capacity, at: now});
    return capacity;
  }

  function holdVolumeOf(deps2, request = {}) {
    const characterID = Number(request.characterID) || 0;
    const shipID = Number(request.shipID) || 0;
    let stacks = Array.isArray(request.stacks) ? request.stacks : [];
    if (!Array.isArray(request.stacks)) {
      try {
        stacks = haul.holdStacks(deps2, {locationID: shipID, ownerID: characterID}) || [];
      } catch (_error) {
        stacks = [];
      }
    }
    const used = stacks.reduce((sum, item) => sum + (Number(item.totalVolume) || 0), 0);
    // A persisted capacity (written once per ship) beats rebuilding the dogma snapshot.
    let hint = Number(request.capacityHint) || 0;
    if (!hint) {
      const member = (stateStore.get().pool || []).find(
        (entry) => Number(entry.characterID) === characterID && Number(entry.shipID) === shipID,
      );
      hint = Number(member && member.holdCapacity) || 0;
    }
    const capacity = hint > 0 ? hint : cachedHoldCapacity(deps2, characterID, shipID);
    return {used, capacity, stacks: stacks.length};
  }

  /** Drop the cached capacity (after a fit/ship change). */
  function invalidateHoldCapacity(characterID, shipID) {
    holdCapacityCache.delete(`${Number(characterID) || 0}:${Number(shipID) || 0}`);
  }
  /**
   * M5: one hauling pass — compress the crew holds, then hand the ore to the
   * player's industrial command ship. Called manually (/crewmine deliver) and by
   * the 15 s service loop while mining.
   */
  function deliverCrew(selector, context = {}) {
    const session = context.session || null;
    const systemID = currentSystemID(session);
    const playerCharacterID = fleet.playerCharacterOf(session);
    const playerShipID = Number(session && session._space && session._space.shipID) || 0;
    if (!systemID || !playerShipID) {
      return {ok: false, lines: ["请在太空里下令（当前没有所在星系/飞船）"]};
    }
    const target = resolveDeliveryTarget(deps, {playerCharacterID, playerShipID});
    if (!target.ok) {
      return {ok: false, lines: [`找不到你的收货船：${target.reason}`]};
    }
    const selected = selectMembers(selector, context);
    if (selected.members.length === 0) {
      return {ok: false, lines: selected.problems.length > 0 ? selected.problems : ["本星系没有在役船员"]};
    }
    const scene = follow.sceneFor(deps, session);
    const lines = [];
    let moved = 0;
    for (const member of selected.members) {
      const config = configForBlueprint(member.blueprintID);
      const entity = scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(member.shipID)
        : null;
      if (!entity) {
        lines.push(`${member.name}：船不在场景里`);
        continue;
      }
      const behavior = config ? config.behavior : {};
      const moduleSession = mining.moduleSessionFor(session, member.characterID, entity);
      const stacks = haul.holdStacks(deps, {locationID: member.shipID, ownerID: member.characterID}) || [];
      // C4：没有矿的船（战斗船/空舱）不进入压缩/交付，也不重算容量。
      // 这一步把 service tick 从"每艘船都扫一遍再决策"缩成"空舱直接跳过"。
      if (stacks.length === 0) {
        const haulKey = Number(member.characterID) || 0;
        if (haulSeen.get(haulKey) !== "0:0") {
          haulSeen.set(haulKey, "0:0");
          log(`[haul] ${member.name} used=0 cap=${Math.round(Number(member.holdCapacity) || 0)} stacks=0 stacksDetail=[]`);
        }
        continue;
      }
      const hold = holdVolumeOf(deps, {characterID: member.characterID, shipID: member.shipID, config, stacks});
      // 每秒每人一行纯噪声：只在货舱值变了（≥1 m³）或堆叠数变了才打。
      const haulKey = Number(member.characterID) || 0;
      const haulNow = `${Math.round(hold.used)}:${stacks.length}`;
      if (haulSeen.get(haulKey) !== haulNow) {
        haulSeen.set(haulKey, haulNow);
        log(`[haul] ${member.name} used=${Math.round(hold.used)} cap=${Math.round(hold.capacity)} stacks=${stacks.length} ` +
          `stacksDetail=${JSON.stringify(stacks.map((s) => ({id: s.itemID, f: s.flagID, t: s.typeID, q: s.quantity, v: s.totalVolume})))})`);
      }
      const measured = haul.fillPercent(hold.used, hold.capacity);
      // Unknown hold capacity (no resource state): treat "has ore" as full so the
      // threshold can still trigger — never letting the crew sit on a full hold.
      const capacityUnknown = !(Number(hold.capacity) > 0);
      const percent = capacityUnknown ? (stacks.length > 0 ? 100 : 0) : measured;
      const delivering = haulState.get(Number(member.characterID)) === true;
      // Compress-then-deliver whenever the facility can take it; otherwise wait
      // for the 80% threshold.
      if (!haul.shouldDeliver({
        percent,
        stopPercent: behavior.deliverStopPercent,
        resumePercent: behavior.deliverResumePercent,
        delivering,
        force: context.force === true,
      })) {
        lines.push(`${member.name}：货舱 ${percent.toFixed(0)}%，还没到 ${Number(behavior.deliverStopPercent) || 80}%` +
          `（想立刻收矿用 /crewmine deliver all）`);
        continue;
      }
      haulState.set(Number(member.characterID), true);
      const result = haul.serviceShip(deps, {
        session: moduleSession,
        // 操作用无头会话（压缩/交付要按船员船执行），但**通知客户端**必须用玩家真实会话：
        // 无头会话的 sendNotification 是空函数，会把 OnItemChange 吞掉（矿石要进站才可见）。
        notifySession: session,
        locationID: member.shipID,
        ownerID: member.characterID,
        facilityBallID: target.facilityBallID,
        targets: target.targets,
      });
      const after = holdVolumeOf(deps, {characterID: member.characterID, shipID: member.shipID, config});
      const afterPercent = haul.fillPercent(after.used, after.capacity);
      if (afterPercent <= (Number(behavior.deliverResumePercent) || 70)) {
        haulState.set(Number(member.characterID), false);
      }
      const stalled = result.delivered.moved === 0 && stacks.length > 0;
      if (stalled) {
        // Player holds full: wait. Resume is explicit (command / UI button) so no
        // automatic restart can loop.
        haulState.set(Number(member.characterID), false);
        waitingForSpace.set(Number(member.characterID), {at: now(), percent});
        lines.push(
          `${member.name}：矿舱和货舱都满了，暂停交付` +
          `（货舱 ${percent.toFixed(0)}%）；腾出空间后 /crewmine deliver 手动重试`,
        );
        continue;
      }
      waitingForSpace.delete(Number(member.characterID));
      moved += result.delivered.moved;
      // 已取消：交付后不再由船员在舰队频道发言（用户 2026-10-20 决定）。
      const via = result.delivered.target ? result.delivered.target.label : "—";
      const detail = [
        ...(result.compressed.attempts || []).slice(0, 3).map((a) => `压#${a.itemID}f${a.flagID}=${a.raw}`),
        ...(result.delivered.attempts || []).slice(0, 3).map((a) => `交#${a.itemID}f${a.flagID}=${a.raw}`),
      ];
      if (detail.length > 0) {
        lines.push(`  ${detail.join(" | ")}`);
      }
      lines.push(
        `${member.name}：压缩 ${result.compressed.compressed} 组 · 交付 ${result.delivered.moved} 组 → ${via}` +
        ` · 货舱 ${percent.toFixed(0)}%→${afterPercent.toFixed(0)}%` +
        `${(() => {
          // P0.4：被拒原因按船 60 秒去重 —— 同样的 REFUSED 以前每 15 s 打一遍。
          if (result.problems.length === 0) {
            return "";
          }
          const text = result.problems.slice(0, 3).join(" ");
          const seen = haulProblemAt.get(Number(member.characterID));
          if (seen && now() - seen.at < 60000 && seen.text === text) {
            return ` · ${result.problems.length} 条同类（60 秒内不重复）`;
          }
          haulProblemAt.set(Number(member.characterID), {at: now(), text});
          return ` · ${text}` + (result.problems.length > 3 ? ` 等 ${result.problems.length} 条` : "");
        })()}`,
      );
    }
    lines.unshift(`交付 ${moved} 组 → ${target.label}`);
    return {ok: moved > 0, lines};
  }

  /** One automatic pass: compress every crew hold, deliver when the policy says so. */
  // M7：人数多时把压缩/交付/补燃料这一拍拉开到 30 s。定时器本身还是 15 s 一跳，
  // 这里做闸门，所以不需要重建 timer。
  const SERVICE_LARGE_CREW = 12;
  const SERVICE_INTERVAL_LARGE_MS = 30000;
  let lastServiceRunAt = 0;

  function serviceTick() {
    const session = serviceSession;
    if (!session) {
      stopServiceLoop();
      return;
    }
    const summoned = (stateStore.get().pool || []).filter((entry) => entry.summoned === true);
    if (summoned.length === 0) {
      stopServiceLoop();
      return;
    }
    // M7：闸门 —— 12 人以上拉长到 30 s。
    const baseIntervalMs = Math.max(5000, Number(options.serviceIntervalMs) || 15000);
    const desiredIntervalMs = summoned.length > SERVICE_LARGE_CREW
      ? Math.max(SERVICE_INTERVAL_LARGE_MS, baseIntervalMs)
      : baseIntervalMs;
    if (lastServiceRunAt > 0 && now() - lastServiceRunAt < desiredIntervalMs) {
      return;
    }
    lastServiceRunAt = now();
    {
      const tickScene = follow.sceneFor(deps, session);
      const tickPlayerShipID = Number(session && session._space && session._space.shipID) || 0;
      const tickPlayerEntity = tickPlayerShipID && tickScene && typeof tickScene.getEntityByID === "function"
        ? tickScene.getEntityByID(tickPlayerShipID)
        : null;
      const crewStates = summoned.map((entry) => {
        const entity = tickScene && typeof tickScene.getEntityByID === "function"
          ? tickScene.getEntityByID(entry.shipID)
          : null;
        // R6: with no player entity in the scene the old code fell back to `entity`, so
        // every ship read "0 km" — a fabricated number that looked like a follow bug.
        // 小于 1 km 用米显示：100 m 的跟随以前四舍五入成 "0km"，看起来像没生效。
        const gap = !entity
          ? "无实体"
          : tickPlayerEntity
            ? (() => {
              const meters = mining.surfaceDistance(entity, tickPlayerEntity);
              return meters < 1000 ? `${Math.round(meters)}m` : `${Math.round(meters / 1000)}km`;
            })()
            : "player?";
        return `${entry.name}:${entity ? `${entity.mode || "?"}/${gap}` : gap}`;
      });
      log(`[tick] system=${currentSystemID(session)} playerEntity=${tickPlayerEntity ? "yes" : "NO"} ` +
        `summoned=${summoned.length} crew=[${crewStates.join(" ")}]`);
    }
    // Make sure every summoned member really has an entity in the player's
    // system: a failed transit used to leave the ship item alive with no entity,
    // so the crew neither followed nor approached.
    try {
      const matScene = follow.sceneFor(deps, session);
      const matSystemID = currentSystemID(session);
      const matPlayerShipID = Number(session && session._space && session._space.shipID) || 0;
      const matLeader = matPlayerShipID ? follow.locate(deps, {session, shipID: matPlayerShipID}).entity || null : null;
      for (const entry of summoned) {
        const entity = matScene && typeof matScene.getEntityByID === "function"
          ? matScene.getEntityByID(entry.shipID)
          : null;
        if (entity || !matSystemID) {
          continue;
        }
        const shipSystemID = transit.shipSystemOf(deps, entry.shipID);
        if (shipSystemID && shipSystemID !== matSystemID) {
          continue; // handled by the transit step below
        }
        const revived = ship.ensureEntity(deps, {
          session,
          scene: matScene,
          systemID: matSystemID,
          shipID: entry.shipID,
          characterID: entry.characterID,
          leader: matLeader,
        });
        const reason = String(revived.reason || "");
        // 船被击毁后条目还在，shipID 指向一个已经不存在的东西：标记待重建，只提示一次。
        if (!revived.ok && reason.includes("ITEM_NOT_FOUND")) {
          if (!destroyedWarned.has(Number(entry.characterID) || 0)) {
            destroyedWarned.add(Number(entry.characterID) || 0);
            log(`[crew] ${entry.name} 的船已被击毁（船 ID 不存在），已标记为待重建：/crewmine rebuild ${entry.name}`);
            markDestroyed(entry.characterID);
          }
          continue;
        }
        const key = `${Number(entry.characterID) || 0}:${reason}`;
        if (!revived.ok && materializeLogged.has(key)) {
          continue;
        }
        if (!revived.ok) {
          materializeLogged.add(key);
        } else {
          materializeLogged.delete(`${Number(entry.characterID) || 0}:${reason}`);
          destroyedWarned.delete(Number(entry.characterID) || 0);
          markAlive(entry.characterID);
          // S3/R5: the entity was re-created from its item, so the doomsday attributes
          // are gone again; re-stamp them while we are here (no-op when still present).
          const revivedEntity = matScene && typeof matScene.getEntityByID === "function"
            ? matScene.getEntityByID(entry.shipID)
            : null;
          applyDoomsdayPresence(matScene, entry, revivedEntity);
        }
        log(`[materialize] ${entry.name} ${revived.ok ? "重建实体 ok" : `失败 ${reason}`}`);
      }
    } catch (error) {
      log(`[materialize] 失败 ${error && error.message}`);
    }
    // M6: follow the player across systems before anything else.
    try {
      const playerShipID = Number(session && session._space && session._space.shipID) || 0;
      const playerSystemID = currentSystemID(session);
      if (playerSystemID && playerShipID) {
        const plan = transit.planTransit({
          members: summoned,
          systemID: playerSystemID,
          systemOf: (shipID) => transit.shipSystemOf(deps, shipID),
        });
        for (const [index, entry] of plan.relocate.entries()) {
          const leaderEntity = follow.locate(deps, {session, shipID: playerShipID}).entity || null;
          const moved = transit.relocate({...deps, ship, follow}, {
            session,
            shipID: entry.member.shipID,
            characterID: entry.member.characterID,
            fromSystemID: entry.fromSystemID,
            toSystemID: playerSystemID,
            leader: leaderEntity,
            leaderID: playerShipID,
            followRangeMeters: (configForBlueprint(entry.member.blueprintID) || {}).behavior
              ? configForBlueprint(entry.member.blueprintID).behavior.followRangeMeters
              : 0,
            index,
          });
          log(`[transit] ${entry.member.name} ${entry.fromSystemID}→${playerSystemID} ` +
            `ok=${moved.ok}${moved.ok ? ` warped=${moved.warped === true} follow=${moved.following}` : ` reason=${moved.reason}`}`);
          if (moved.ok) {
            // No explicit "resume mining": the re-target step picks a rock near the
            // player in the new system on its own (redundant work removed).
            activeRock.delete(Number(entry.member.characterID));
            chainActive.delete(Number(entry.member.characterID));
          }
        }
      }
    } catch (error) {
      log(`[transit] 跨星系同步失败 ${error && error.message}`);
    }
    let delivered = 0;
    try {
      // O4：service tick 轮转——每次只处理 1 艘，避免多船员时 3–4 s 的单帧尖峰。
      const behavior = configs_behavior();
      let serviceTarget = "all";
      if (behavior.serviceRotate !== false && summoned.length > 0) {
        const index = serviceCursor % summoned.length;
        serviceCursor = (index + 1) % summoned.length;
        const member = summoned[index];
        serviceTarget = member && member.name ? String(member.name) : "all";
      }
      const result = deliverCrew(serviceTarget, {session});
      lastService = {at: new Date().toISOString().slice(11, 19), ok: result.ok, lines: result.lines.slice(0, 4), error: null};
      delivered = result.ok ? 1 : 0;
      for (const line of result.lines.slice(1)) {
        if (/交付 [1-9]/u.test(line) || /压缩 [1-9]/u.test(line) || /满了/u.test(line)) {
          log(`服务循环：${line}`);
        }
      }
    } catch (error) {
      lastService = {at: new Date().toISOString().slice(11, 19), ok: false, lines: [], error: String(error && error.message)};
      log(`服务循环失败：${error && error.message}`);
    }
    // A crew whose hold is full and whose delivery failed stops mining until the
    // player frees space (no automatic resume: it caused surprise restarts).
    const scene = follow.sceneFor(deps, session);
    for (const entry of summoned) {
      if (!waitingForSpace.has(Number(entry.characterID))) {
        continue;
      }
      const entity = scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(entry.shipID)
        : null;
      if (!entity) {
        continue;
      }
      const config = configForBlueprint(entry.blueprintID);
      const hold = holdVolumeOf(deps, {characterID: entry.characterID, shipID: entry.shipID, config});
      const percent = haul.fillPercent(hold.used, hold.capacity);
      if (Number(hold.capacity) > 0 && percent >= 99) {
        const moduleSession = mining.moduleSessionFor(session, entry.characterID, entity);
        const stopped = mining.stopMining({scene, session: moduleSession, entity});
        if (stopped.stopped > 0) {
          log(`${entry.name}：货舱已满（${percent.toFixed(0)}%），暂停采矿 ${stopped.stopped} 个模块`);
        }
      }
    }
    restoreMiningIntent();
    // M4b: a depleted rock (or stopped modules) puts the crew back to work.
    if (scene) {
      for (const entry of summoned) {
        const characterID = Number(entry.characterID);
        if (!miningWanted.has(characterID) || waitingForSpace.has(characterID)) {
          continue;
        }
        const entity = typeof scene.getEntityByID === "function" ? scene.getEntityByID(entry.shipID) : null;
        if (!entity) {
          continue;
        }
        const targets = entity.activeModuleEffects instanceof Map
          ? [...entity.activeModuleEffects.values()].map((effect) => Number(effect && effect.targetID) || 0).filter(Boolean)
          : [];
        const stillMining = targets.some((targetID) => {
          const rock = typeof scene.getEntityByID === "function" ? scene.getEntityByID(targetID) : null;
          return Boolean(mining.rockOre(rock, {scene, miningState: deps.miningState}));
        });
        if (targets.length > 0 && stillMining) {
          // Already mining the committed rock: never re-target while cycles run.
          // Keep the target lock alive: a mining cycle fails with stopReason
          // "target" (and the module is dropped) when the lock is gone.
          // P0.3：watch tick 每秒已经会在丢锁时补锁，这里只是兜底 —— 15 s 改成 45 s。
          const targetEntity = typeof scene.getEntityByID === "function"
            ? scene.getEntityByID(targets[0])
            : null;
          const lockAt = Number(miningLockAt.get(characterID)) || 0;
          if (targetEntity && now() - lockAt >= MINING_LOCK_RENEW_MS) {
            miningLockAt.set(characterID, now());
            const keepLock = mining.ensureTargetLock({scene, entity, rock: targetEntity});
            if (!keepLock.ok || keepLock.locked !== true) {
              logCombatOnce(characterID, targets[0], "mine:lock",
                `${entry.name}：锁定续期 ${keepLock.ok ? "等待中" : keepLock.reason}`);
            }
          }
          continue;
        }
        miningLockAt.delete(characterID);
        // M3：这里只入队，真正的重选在 1 s 的 watch tick 里按时间预算出队
        // （service 一拍 15–30 s，若在此串行执行，24 条船同时换矿会把单帧顶到几秒）。
        enqueueRetarget(entry);
        log(`${entry.name}：矿采空或模块停转（目标 ${targets.join(",") || "无"}），已排队重新选矿`
          + `（队列 ${miningRetargetQueue.size}）`);
      }
    }
    if (delivered === 0 && summoned.length === 0) {
      stopServiceLoop();
    }
  }

  // Fleet warp follow: when the player's ship enters warp, every crew ship
  // warps to the same destination, offset by the relative position it already
  // had — the fleet's own arrangement is preserved, nothing invented here.

  // 跟随后姿态的“重新下令”器在 nfCrewMiningFollow.createRearmer 里（含节流状态），
  // 这里只注入依赖；下面还留着 bringBackStranded 用的 lastBringBack。
  const lastBringBack = new Map();

  const rearmer = follow.createRearmer({
    gap: () => followSurfaceGap(),
    formation: () => followFormationMode(),
    spacing: () => crewSpacingMeters(),
    configFor: configForBlueprint,
    isMiningAtRock,
    isChasing: (characterID) => chaseTargets.has(characterID),
    isModeActive: (entity) => modeModule.isModeActive(entity),
    followFn: (request) => follow.follow(deps, request),
    surface: (entity, other) => mining.surfaceDistance(entity, other),
    orbitDynamic: (scene, entity, targetID, range) => {
      const runtimeApi = deps && deps.runtime;
      return runtimeApi && typeof runtimeApi.orbitDynamicEntity === "function"
        ? runtimeApi.orbitDynamicEntity(Number(scene.systemID) || 0, entity, targetID, range, {broadcast: true})
        : null;
    },
    orbitScene: (scene, entity, targetID, range) => (
      scene && typeof scene.orbitShipEntity === "function"
        ? scene.orbitShipEntity(entity, targetID, range, {broadcast: true})
        : null
    ),
    blockers: (entity, playerEntity) => movementBlockersFor(entity, playerEntity),
    log,
    now,
  });

  /** 跟随姿态（阶梯 / 分层环绕）：真正的实现在 follow 模块。 */
  function rearmFollow(scene, session, summoned, playerEntity) {
    return rearmer.rearm(scene, session, summoned, playerEntity);
  }

  /**
   * Is this ship actually cycling mining modules on a rock?
   *
   * Used by the follow pass to leave a mining ship at its asteroid. It must NOT be "has any
   * active module effect": hardeners, shield boosters and prop mods also register there, so
   * a ship whose engine had reverted it to a plain follow never got its ring back and sat
   * at 1 km (the "0 km" in the status log).
   */
  function isMiningAtRock(scene, crewID, entity) {
    // 1) 已经在挖矿流程里（activeRock + miningWanted）：**先判这个，再判模块**。
    //    船在"飞向矿"的阶段一模块都没起，早先的写法会直接 false → rearmFollow 每秒把它
    //    拉回玩家，把挖矿的 12 km 接近指令反复覆盖，永远到不了矿（实测 721 次"保持 12 km"
    //    对 630 次 [follow] 互抢，7 小时里 0 次成功开始采矿）。
    const key = Number(crewID) || 0;
    if (key && activeRock.has(key) && miningWanted.has(key)) {
      return true;
    }
    if (!entity || !(entity.activeModuleEffects instanceof Map) || entity.activeModuleEffects.size === 0) {
      return false;
    }
    for (const effect of entity.activeModuleEffects.values()) {
      const targetID = Number(effect && effect.targetID) || 0;
      if (!targetID) {
        continue;
      }
      const target = scene && typeof scene.getEntityByID === "function" ? scene.getEntityByID(targetID) : null;
      if (target && mining.rockOre(target, {scene, miningState: deps.miningState})) {
        return true;
      }
    }
    return false;
  }

  // ---- B 模式：环形槽位 + 自写刹车 -------------------------------------
  // 执行器（含"上次下发的方向/速度/位置"）在 nfCrewMiningFormation.createRingController，
  // 这里只注入依赖，并保留 250 ms 的定时器。
  const RING_TICK_MS = formation.DEFAULT_TICK_MS;
  let formationTimer = null;
  const ringController = formation.createRingController({
    formationMode: () => followFormationMode(),
    surfaceGap: () => followSurfaceGap(),
    pool: () => stateStore.get().pool || [],
    sceneFor: (session) => follow.sceneFor(deps, session),
    isBusy: (scene, entity, characterID) => {
      const mode = String(entity.mode || "").toUpperCase();
      if (mode === "WARP" || entity.pendingWarp || entity.warpState) {
        return true; // 跃迁中不抢控制权
      }
      // 被派去挖矿 / 已在飞向矿的船不要被环形拉回来（否则永远到不了石头）。
      if (miningWanted.has(characterID) || activeRock.has(characterID)) {
        return true;
      }
      if (isMiningAtRock(scene, characterID, entity)) {
        return true; // 停在矿上是有意的
      }
      if (chaseTargets.has(characterID)) {
        return true;
      }
      return modeModule.isModeActive(entity); // 堡垒/会战被引擎钉住
    },
    shareSession: (session, characterID, entity) => mining.moduleSessionFor(session, characterID, entity),
    goto: (scene, callSession, point) => scene.gotoPoint(callSession, point),
    setSpeed: (scene, callSession, fraction) => scene.setSpeedFraction(callSession, fraction),
    now,
    log,
  });

  /** 每 250 ms 推进一次环形站位（没开环形模式时内部直接返回）。 */
  function ringFormationTick(sessionHint) {
    // 环形缺间距时**不静默**：不下发任何指令，并把原因说明一次（60 s 去重）。
    if (followFormationMode() === "ring" && followGapMeters() === null) {
      warnRingMissingGap();
      return;
    }
    ringController.tick(sessionHint || serviceSession);
  }

  // 环形缺间距：每 60 s 说明一次，不刷屏。
  let ringGapWarnAt = 0;
  function warnRingMissingGap() {
    if (now() - ringGapWarnAt < 60000) {
      return;
    }
    ringGapWarnAt = now();
    log("[ring] 环形阵型缺少间距 → 不下发槽位指令；先 /crewmine follow <米>（需 > 0）");
  }

  /**
   * 停船（0.6.8）：**独立动作，不属于阵型**（用户口径 5）。
   *
   * 语义：让选中的船员原地减速停住，然后把跟随模式置回 `idle`
   * —— "没有默认行动"，之后不会再下发移动指令，直到下一条 `/crewmine formation`。
   * 不受影响：采矿（自己在矿上）、会战/堡垒（引擎钉住）、**跟队跃迁**（独立系统）。
   */
  function haltCrew(selector, context = {}) {
    const session = context.session || null;
    const scene = follow.sceneFor(deps, session);
    const selected = selectMembers(selector, context);
    if (selected.members.length === 0) {
      return {
        ok: false,
        lines: selected.problems.length > 0 ? selected.problems : ["本星系没有在役船员"],
      };
    }
    const lines = [];
    let stopped = 0;
    for (const member of selected.members) {
      const crewID = Number(member.characterID) || 0;
      const entity = scene && typeof scene.getEntityByID === "function" ? scene.getEntityByID(member.shipID) : null;
      if (!entity) {
        lines.push(`${member.name}：船不在场景里`);
        continue;
      }
      // 先把追击停掉：否则下一拍 combat 还会把它开走。
      stopChase(crewID, member);
      let ok = false;
      try {
        if (typeof scene.stopShipEntity === "function") {
          const result = scene.stopShipEntity(entity, {reason: "nfCrewHalt"});
          ok = result === true || Boolean(result && result.success === true);
        }
      } catch (error) {
        lines.push(`${member.name}：停船失败 ${error && error.message}`);
        continue;
      }
      if (ok) {
        stopped += 1;
      }
      lines.push(`${member.name}：${ok ? "已停船" : "停船指令被拒（可能会被引擎继续带着走）"}`);
    }
    // 停船后回到"静止等命令"：之后 rearm 不再下发任何指令。
    setFollowState({mode: "idle"});
    log(`[cmd] halt ${selector} → 已停 ${stopped}/${selected.members.length}，跟随模式=idle`);
    lines.push("跟随模式 → 静止（等待命令）。跃迁跟跳属于独立系统，不受影响。");
    return {ok: stopped > 0, lines};
  }

  function recallCrew(selector, context = {}) {
    const session = context.session || null;
    const playerShipID = Number(session && session._space && session._space.shipID) || 0;
    if (!playerShipID) {
      return {ok: false, lines: ["请在太空里召回（当前没有所在星系/飞船）"]};
    }
    const selected = selectMembers(selector, context);
    if (selected.members.length === 0) {
      return {ok: false, lines: selected.problems.length > 0 ? selected.problems : ["没有在役船员"]};
    }
    // PR-5: only the crews this recall actually names stop mining. Clearing the whole
    // pool up front meant "recall one" silently stopped everybody in it.
    for (const member of selected.members) {
      miningWanted.delete(Number(member.characterID));
      miningPending.delete(Number(member.characterID));
      if (member.mining === true) {
        member.mining = false;
        persistMember(member);
      }
    }
    const lines = [];
    let ok = 0;
    // 0.6.8：召回也是"移动"，必须有间距。没设间距就拒绝并提示，不再退回蓝图的
    // followRangeMeters（1000 m）—— 那等于绕过了"没有默认行动"。
    const recallGap = followSurfaceGap();
    if (recallGap === null) {
      return {
        ok: false,
        lines: [
          "召回需要先设表面间距：/crewmine follow <米>（或面板「跟随」下拉）",
          `当前阵型 ${followFormationMode()}，间距未设置 → 船不会移动。`,
        ],
      };
    }
    for (const member of selected.members) {
      const config = configForBlueprint(member.blueprintID);
      const configuredRange = config ? config.behavior.followRangeMeters : follow.DEFAULT_RANGE_METERS;
      const rangeMeters = follow.formationRangeFor(member, selected.members, configuredRange, recallGap, crewSpacingMeters());
      const located = follow.locate(deps, {session, shipID: member.shipID});
      let scene = located.scene;
      let arrivedByWarp = false;
      if (!located.ok) {
        // The ship item is still in space but the entity is not: rebuild it far
        // away and warp it in (a restart drops entities of session-less ships).
        const revived = ship.ensureEntity(deps, {
          session,
          scene,
          systemID: Number(session && session._space && session._space.systemID) || 0,
          shipID: member.shipID,
          characterID: member.characterID,
          leader: follow.locate(deps, {session, shipID: playerShipID}).entity || null,
        });
        if (!revived.ok) {
          lines.push(`${member.name}：召回失败 实体不在场景且无法重新生成（${revived.reason}）`);
          continue;
        }
        scene = revived.scene || scene;
        // S3/R5: a hull revived from its item has no doomsday attributes yet.
        applyDoomsdayPresence(scene, member,
          scene && typeof scene.getEntityByID === "function" ? scene.getEntityByID(member.shipID) : null);
        arrivedByWarp = revived.warped === true;
        if (arrivedByWarp) {
          const delay = Math.max(1200, (revived.warpCompleteAtMs || 0) - now()) + 300;
          const request = {
            sceneDescriptor: located.sceneDescriptor,
            session,
            scene,
            followerShipID: member.shipID,
            leaderShipID: playerShipID,
            rangeMeters,
          };
          scheduleAfter(delay, () => follow.follow(deps, request));
          lines.push(`${member.name}：重建并跃迁进场（${Math.round(delay / 100) / 10}s 后跟随）`);
          continue;
        }
      }
      // Far away (e.g. the player aborted a warp the crew followed): bring it back
      // by repositioning + warping in, not by a subwarp follow.
      const leaderEntity = follow.locate(deps, {session, shipID: playerShipID}).entity || null;
      const crewEntity = scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(member.shipID)
        : null;
      const gap = crewEntity && leaderEntity ? mining.surfaceDistance(crewEntity, leaderEntity) : 0;
      if (leaderEntity && gap > 50000) {
        const systemIDNow = Number(session && session._space && session._space.systemID) || 0;
        const target = ship.buildSpaceState({systemID: systemIDNow, leader: leaderEntity});
        const back = ship.warpIn(deps, {
          systemID: systemIDNow,
          sceneDescriptor: scene && scene.sceneDescriptor,
          shipID: member.shipID,
          targetPoint: target.position,
        });
        log(`[recall] ${member.name} 距离 ${Math.round(gap / 1000)}km → 返航跃迁 ` +
          `${back.ok ? "ok" : `失败 ${back.reason}`}`);
        if (back.ok) {
          ok += 1;
          lines.push(`${member.name}：正在跃迁回你身边（原距离 ${Math.round(gap / 1000)} km）`);
          continue;
        }
      }
      const result = follow.follow(deps, {
        sceneDescriptor: located.sceneDescriptor,
        session,
        scene,
        followerShipID: member.shipID,
        leaderShipID: playerShipID,
        rangeMeters,
      });
      if (result.ok) {
        ok += 1;
        const inFleet = fleet.fleetIDOf(fleet.fleetOf(deps, member.characterID));
        // 小于 1 km 用米显示，避免「回你身边（0 km）」。
        const rangeText = result.rangeMeters > 0 && result.rangeMeters < 1000
          ? `${Math.round(result.rangeMeters)} m`
          : `${Math.round(result.rangeMeters / 1000)} km`;
        lines.push(
          `${member.name}：回你身边（${rangeText}）` +
          `${inFleet ? "" : " · 不在舰队（用 /crewmine fleet join all）"}`,
        );
      } else {
        lines.push(`${member.name}：召回失败 ${result.problems.join(" ")}`);
      }
    }
    return {ok: ok > 0, lines};
  }

  /**
   * 场景里属于某个角色的实体（按 characterID / pilotCharacterID / ownerID 认）。
   * 解散时用它反查「孤儿船」：池记录的 shipID 可能已经被清零或指向旧船。
   */
  function entitiesOfCharacter(scene, characterID) {
    const wanted = Number(characterID) || 0;
    if (!wanted || !scene || typeof scene.getDynamicEntities !== "function") {
      return [];
    }
    let rows = [];
    try {
      // 解散/孤儿清理要的是"现在"的列表，不能吃战斗那份 500 ms 缓存。
      rows = scene.getDynamicEntities() || [];
    } catch (_error) {
      rows = [];
    }
    const out = [];
    for (const entity of Array.isArray(rows) ? rows : []) {
      if (!entity) {
        continue;
      }
      const owner = Number(entity.characterID) || Number(entity.pilotCharacterID)
        || Number(entity.ownerID) || Number(entity.ownerCharacterID) || 0;
      if (owner === wanted && Number(entity.itemID) > 0) {
        out.push(entity);
      }
    }
    return out;
  }

  /** M3: disband — entity gone, ship gone, out of the fleet, character kept. */
  function disbandCrew(selector, confirm, context = {}) {
    const session = context.session || null;
    // Disband is a CLEANUP action: "all" must also cover crew the system filter would
    // skip (a ship that was deleted or lost its spaceState). Otherwise such a record can
    // never be removed and keeps showing up as "1 人在别处".
    const wanted = String(selector == null ? "" : selector).trim();
    const isAll = !wanted || wanted.toLowerCase() === "all";
    const selected = isAll
      ? {
        // 只要「在役」就收：shipID 可能已经被之前的半截清理清零（实体没了但记录还在），
        // 以前要求 shipID>0 就把这种记录永久卡死 —— 永远回「没有在役船员」。
        // 同时按 ownerAccountID 兜一层：多租户下 pool 本来就是本账号的，
        // 但旧模式（EVEJS_CM_TENANT_MODE=0）会共用一份 state，这里绝不能解散别人的船员。
        members: (stateStore.get().pool || []).filter((entry) => {
          if (!entry || !(Number(entry.characterID) > 0)) {
            return false;
          }
          const owner = Number(entry.ownerAccountID) || 0;
          if (tenantAccountID > 0 && owner > 0 && owner !== tenantAccountID) {
            return false;
          }
          return entry.summoned === true || Number(entry.shipID) > 0;
        }),
        skipped: 0,
        problems: [],
      }
      : selectMembers(selector, context);
    if (selected.members.length === 0) {
      // 诊断：池里到底有什么？不然这句「没有在役船员」没法排查。
      const poolRows = (stateStore.get().pool || []).slice(0, 6).map((entry) => (
        `${entry.name || entry.characterID}（summoned=${entry.summoned === true} shipID=${Number(entry.shipID) || 0}）`
      ));
      const total = (stateStore.get().pool || []).length;
      return {
        ok: false,
        lines: [
          ...(selected.problems.length > 0 ? selected.problems : ["没有在役船员"]),
          `池子里共 ${total} 人${poolRows.length > 0 ? "：" + poolRows.join("、") : "（空）"}`,
        ],
      };
    }
    if (confirm !== true) {
      return {
        ok: false,
        lines: [
          `将解散 ${selected.members.length} 人：实体与船会消失，退出舰队，角色记录保留。`,
          "确认请输入 /crewmine disband " + (selector || "all") + " confirm",
        ],
      };
    }
    const lines = [];
    let ok = 0;
    const systemID = currentSystemID(session);
    const warpDelayMs = Math.max(0, Number(context.disbandWarpDelayMs) || 2500);
    for (const member of selected.members) {
      // markReleased() zeroes entry.shipID, so keep the id before that happens.
      const scene = follow.sceneFor(deps, session);
      // 按角色反查实体：池里的 shipID 可能已经清零/过期，实体却还在太空里。
      const owned = entitiesOfCharacter(scene, member.characterID);
      let shipID = Number(member.shipID) || 0;
      if (!shipID && owned.length > 0) {
        shipID = Number(owned[0].itemID) || 0;
        lines.push(`${member.name}：记录里没有船，按角色反查到实体 ${shipID}`);
      }
      // 除了当前这条船，同一个角色名下多出来的（旧船/孤儿船）也要清掉。
      for (const stray of owned) {
        const strayID = Number(stray.itemID) || 0;
        if (!strayID || strayID === shipID) {
          continue;
        }
        const removed = ship.removeEntity(deps, {session, shipID: strayID});
        lines.push(`${member.name}：清理孤儿船 ${strayID} ${removed.ok ? "✓" : "—"}`);
      }
      const config = configForBlueprint(member.blueprintID);
      const departure = resolveDepartureMode(config);
      // Warp out as far as the ship warped in from (same config knob).
      const warpAu = Math.max(0.5, Number(config && config.behavior.warpInAu) || 4);
      // 离场表现（0.6.10）：默认诱导跳走——播一次 JumpDriveOut，等特效演完再摘实体；
      // 想回到"真跃迁飞离"就把蓝图里的 departure 写成 warp。
      let delayMs = 0;
      let how = "";
      if (departure === "jump") {
        const jumped = systemID
          ? ship.jumpOutFx(deps, {session, scene, systemID, shipID})
          : {ok: false, reason: "NO_SYSTEM"};
        if (jumped.ok) {
          delayMs = Math.max(warpDelayMs, jumped.holdMs);
          how = `诱导跳走（${Math.round(delayMs / 100) / 10}s 后移除并退队）`;
        } else if (jumped.reason !== "ENTITY_NOT_FOUND") {
          lines.push(`${member.name}：无法诱导跳走（${jumped.reason}），改跃迁离场`);
        }
      }
      if (!how) {
        // Warp out first so the ship leaves instead of blinking out, then remove it.
        const warped = systemID
          ? ship.warpOut(deps, {
            session,
            scene,
            systemID,
            shipID,
            distanceMeters: Math.round(ship.AU_METERS * warpAu),
          })
          : {ok: false, reason: "NO_SYSTEM"};
        if (warped.ok && warpDelayMs > 0) {
          // Wait for the warp itself when the engine told us when it lands.
          const warpEndsIn = warped.completeAtMs ? Math.max(800, warped.completeAtMs - now()) : warpDelayMs;
          delayMs = Math.max(warpDelayMs, warpEndsIn + 300);
          how = `跃迁离场（${Math.round(delayMs / 100) / 10}s 后移除并退队）`;
        } else {
          if (!warped.ok && warped.reason !== "ENTITY_NOT_FOUND") {
            lines.push(`${member.name}：无法跃迁离场（${warped.reason}），直接移除`);
          }
        }
      }
      const finish = () => {
        const removedEntity = ship.removeEntity(deps, {session, shipID});
        const stockRecord = stockEnabled() ? stockService().findByItemID(shipID) : null;
        // 库存船：不删船，摘掉实体后停回 4-4、转回仓库角色、账本回「在库」。
        let removedShip = null;
        let stockLine = "";
        if (stockRecord) {
          const back = returnStockShip(stockRecord);
          removedShip = {ok: back, problems: back ? [] : ["STOCK_RETURN_FAILED"]};
          stockLine = ` 回库${back ? "✓" : "—"}`;
        } else {
          removedShip = ship.removeShipItem(deps, {shipID});
        }
        const leftFleet = fleet.leave(deps, {member});
        lines.push(
          `${member.name}：实体${removedEntity.ok ? "✓" : "—"} 船${removedShip.ok ? "✓" : "—"} 退队${leftFleet.ok ? "✓" : "—"}${stockLine}` +
          `${removedShip.ok && leftFleet.ok ? "" : ` ${[...removedShip.problems, ...leftFleet.problems].join(" ")}`}`,
        );
      };
      pool.markReleased(member, {nowMs: now()});
      // §18.5: 解散即自动关闭特殊装备。直接改 member（disbandCrew 末尾会把它原样写回
      // state），所以不能用"再 update 一次"的方式，会被末尾那次覆盖。
      member.special = {
        bastion: false,
        siege: false,
        smartbomb: false,
        triage: false,
        industrialCore: false,
        special515: false,
      };
      ok += 1;
      if (delayMs > 0) {
        scheduleAfter(delayMs, finish);
        lines.push(`${member.name}：${how}`);
      } else {
        finish();
      }
    }
    stateStore.update((current) => {
      const byID = new Map((current.pool || []).map((entry) => [entry.characterID, entry]));
      for (const member of selected.members) {
        byID.set(member.characterID, member);
      }
      return {...current, pool: [...byID.values()]};
    });
    return {ok: ok > 0, lines};
  }

  /** Characters on this mod's account that are NOT in the pool (crashes, old runs). */
  function poolScan() {
    const list = deps.characterState && typeof deps.characterState.listCharacterIDs === "function"
      ? deps.characterState.listCharacterIDs()
      : null;
    if (!list) {
      return {ok: false, lines: ["当前环境无法枚举角色记录（需要在游戏里执行）"], orphans: []};
    }
    const known = new Set((stateStore.get().pool || []).map((entry) => Number(entry.characterID)));
    const orphans = [];
    for (const value of list) {
      const characterID = Number(value) || 0;
      if (!characterID || known.has(characterID)) {
        continue;
      }
      let record = null;
      try {
        record = deps.characterState.peekCharacterRecord(characterID);
      } catch (_error) {
        record = null;
      }
      if (!record || Number(record.accountId) !== crewAccount()) {
        continue;
      }
      orphans.push({
        characterID,
        name: String(record.characterName || ""),
        corporationID: Number(record.corporationID) || 0,
      });
    }
    const lines = [
      `本 mod 账号下：池中 ${known.size} 人` +
      `${orphans.length > 0 ? `，池外 ${orphans.length} 人：` : "，没有池外角色"}`,
    ];
    for (const orphan of orphans) {
      lines.push(
        `  ${orphan.name || "(无名)"} (${orphan.characterID}) · 军团 ${orphan.corporationID || "—"}` +
        `  → /crewmine pool adopt ${orphan.characterID}`,
      );
    }
    return {ok: true, lines, orphans};
  }

  /** Take a character that exists on our account into the pool. */
  function poolAdopt(characterID, blueprintID) {
    const id = Number(characterID) || 0;
    if (!id) {
      return {ok: false, lines: ["用法：/crewmine pool adopt <角色ID> [配装id]"]};
    }
    if ((configStore.get().configs || []).length === 0) {
      configStore.reload();
    }
    const list = configStore.get().configs || [];
    const blueprint = String(blueprintID || (list[0] && list[0].id) || "");
    let record = null;
    try {
      record = deps.characterState.peekCharacterRecord(id);
    } catch (_error) {
      record = null;
    }
    if (!record) {
      return {ok: false, lines: [`角色 ${id} 不存在`]};
    }
    if (Number(record.accountId) !== crewAccount()) {
      return {ok: false, lines: [`角色 ${id} 不属于本 mod（accountId=${record.accountId}）`]};
    }
    const existing = (stateStore.get().pool || []).find((entry) => Number(entry.characterID) === id);
    if (existing) {
      return {ok: true, lines: [`${existing.name} 已在池中（${existing.summoned ? "在役" : "待用"}）`]};
    }
    const member = pool.newPoolEntry({
      characterID: id,
      name: String(record.characterName || ""),
      blueprintID: blueprint,
      corporationID: Number(record.corporationID) || 0,
      skillsSeeded: true,
    });
    persistMember(member);
    return {
      ok: true,
      lines: [
        `已收录 ${member.name} (${id}) · 配装 ${blueprint || "—"}`,
        "下次召唤会优先复用它（不会另外造角色）",
      ],
    };
  }

  /** M3b: put summoned crew into the player's fleet on demand.
   * Needed whenever they were summoned without a fleet (or the fleet was lost
   * to a restart — fleet state is in memory only).
   */
  function fleetJoinCrew(selector, context = {}) {
    const session = context.session || null;
    const playerCharacterID = fleet.playerCharacterOf(session);
    if (!playerCharacterID) {
      return {ok: false, lines: ["读不到你的角色"]};
    }
    const playerFleetID = fleet.fleetIDOf(fleet.fleetOf(deps, playerCharacterID));
    if (!playerFleetID) {
      return {
        ok: false,
        lines: ["你还没有舰队：请先在舰队窗口创建舰队，再执行 /crewmine fleet join all"],
      };
    }
    const selected = selectMembers(selector, context);
    if (selected.members.length === 0) {
      return {
        ok: false,
        lines: selected.problems.length > 0
          ? selected.problems
          : [`本星系没有在役船员${selected.skipped > 0 ? `（另有 ${selected.skipped} 人在别处）` : ""}`],
      };
    }
    const lines = [];
    let joined = 0;
    for (const member of selected.members) {
      const config = configForBlueprint(member.blueprintID);
      const result = fleet.join(deps, {
        playerSession: session,
        member,
        ownerAccountID: tenantAccountID,
        shipTypeID: config && config.fit ? config.fit.hull.typeID : null,
      });
      if (!result.ok) {
        lines.push(`${member.name}：入队失败 ${result.problems.join(" ")}`);
        continue;
      }
      const formation = fleet.place(deps, {
        playerSession: session,
        fleetID: result.fleetID,
        characterID: member.characterID,
        wing: config ? config.wing : null,
        squad: config ? config.squad : null,
      });
      joined += 1;
      lines.push(
        `${member.name}：${result.alreadyInFleet ? "已在舰队" : "入队✓"}` +
        `${formation.wingID ? ` · 编队 ${formation.wingID}/${formation.squadID || "-"}` : ""}` +
        `${formation.ok ? "" : ` · ${formation.problems.join(" ")}`}`,
      );
    }
    lines.unshift(
      `入队 ${joined} / ${selected.members.length} 人（舰队 ${playerFleetID}）` +
      `${selected.skipped > 0 ? ` · 跳过 ${selected.skipped} 人（不在本星系）` : ""}`,
    );
    return {ok: joined > 0, lines};
  }

  /** Re-apply the configured corporation to everyone in the pool. */
  function corporationSync(context = {}) {
    const session = context.session || null;
    const entries = stateStore.get().pool || [];
    if (entries.length === 0) {
      return {ok: true, lines: ["驾驶员池是空的"]};
    }
    const lines = [];
    let changed = 0;
    for (const member of entries) {
      const config = configForBlueprint(member.blueprintID);
      const affiliation = resolveAffiliation(config || {}, session);
      if (!affiliation.corporationID) {
        lines.push(`${member.name}：跳过（目标军团未知）`);
        continue;
      }
      let ok = false;
      try {
        if (deps.corporations && typeof deps.corporations.setCharacterAffiliation === "function") {
          const result = deps.corporations.setCharacterAffiliation(
            member.characterID,
            affiliation.corporationID,
            affiliation.allianceID || null,
          );
          ok = !(result && result.success === false);
        }
        if (ok && deps.corporationRuntime
          && typeof deps.corporationRuntime.ensureCharacterMemberState === "function") {
          deps.corporationRuntime.ensureCharacterMemberState(affiliation.corporationID, member.characterID);
          if (typeof deps.corporationRuntime.syncMemberStateToCharacterRecord === "function") {
            deps.corporationRuntime.syncMemberStateToCharacterRecord(affiliation.corporationID, member.characterID);
          }
        }
      } catch (error) {
        lines.push(`${member.name}：失败 ${error && error.message}`);
        continue;
      }
      if (ok) {
        member.corporationID = affiliation.corporationID;
        changed += 1;
        lines.push(`${member.name}：军团 ${affiliation.corporationID}`);
      } else {
        lines.push(`${member.name}：失败`);
      }
    }
    stateStore.update((current) => ({...current, pool: [...(current.pool || [])]}));
    lines.unshift(`军团结算：${changed} / ${entries.length} 人`);
    return {ok: changed > 0, lines};
  }

  // Data feed for the client window. One entry per summoned crew member:
  //   name / mode / used / capacity / compress / active
  // The config validator requires a parsable slot name (hi/med/low/rig slot N),
  // exactly like the hand-written blueprints use.
  // The panel may ask before any command ran, so serviceSession can be null: fall back
  // to the first live session. Both listing and importing must resolve the SAME owner,
  // otherwise a fitting listed from one character fails to import for another.
  // 面板可能在一条命令都没跑过之前就来问：serviceSession 可能是空的，退回本账号的
  // 第一个在线会话（和 resolveFittingOwnerID 同一套规则）。
  function resolvePlayerSession() {
    // 面板缓存的 serviceSession 可能是"还在站里"时的快照（没有 _space）：
    // 只要注册表里有同一个角色的在太空会话，就用那个新的。
    if (serviceSession && Number(serviceSession._space && serviceSession._space.systemID) > 0) {
      return serviceSession;
    }
    try {
      const scoped = tenantSessions();
      const list = Array.isArray(scoped)
        ? scoped
        : (() => {
          const registry = deps.sessionRegistry;
          const all = registry && typeof registry.getSessions === "function" ? registry.getSessions() : [];
          return Array.isArray(all) ? all : [];
        })();
      const charID = Number(serviceSession && (serviceSession.characterID || serviceSession.charid)) || 0;
      const inSpace = (row) => Number(row && row._space && row._space.systemID) > 0;
      const sameChar = charID
        ? list.find((row) => Number(row && (row.characterID || row.charid)) === charID && inSpace(row))
        : null;
      if (sameChar) {
        serviceSession = sameChar;
        return sameChar;
      }
      const anySpace = list.find(inSpace);
      if (anySpace) {
        serviceSession = anySpace;
        return anySpace;
      }
      if (serviceSession) {
        return serviceSession;
      }
      return list.length > 0 ? list[0] : null;
    } catch (_error) {
      return serviceSession;
    }
  }

  function resolveFittingOwnerID() {
    let characterID = Number(serviceSession && (serviceSession.characterID || serviceSession.charid)) || 0;
    if (characterID) {
      return characterID;
    }
    try {
      const mine = resolvePlayerSession();
      return Number(mine && (mine.characterID || mine.charid)) || 0;
    } catch (_error) {
      return 0;
    }
  }

  function slotNameForFlag(flagID) {
    const flag = Number(flagID) || 0;
    if (flag >= 27 && flag <= 34) return `hi slot ${flag - 27}`;
    if (flag >= 19 && flag <= 26) return `med slot ${flag - 19}`;
    if (flag >= 11 && flag <= 18) return `low slot ${flag - 11}`;
    if (flag >= 92 && flag <= 99) return `rig slot ${flag - 92}`;
    if (flag >= 125 && flag <= 132) return `subsystem slot ${flag - 125}`;
    if (flag >= 164 && flag <= 171) return `service slot ${flag - 164}`;
    return `cargo slot ${flag}`;
  }

  // Build a blueprint straight from a server-side saved fitting. fitData entries are
  // triples [typeID, flagID, quantity]; drone bays (flag 87) are skipped on purpose.
  function importServerFitting(fittingID, blueprintID, options = {}) {
    const characterID = Number(options.characterID) || resolveFittingOwnerID();
    const store = deps.fittingStore;
    if (!store || typeof store.getOwnerFittings !== "function") {
      return {ok: false, lines: ["服务端装配库不可用"]};
    }
    const result = store.getOwnerFittings(characterID);
    const map = result && (result.fittings || result.data || result);
    const wanted = Number(fittingID) || 0;
    // The store may hand back a map keyed by fittingID or an array of records.
    const fit = Array.isArray(map)
      ? map.find((entry) => Number(entry && (entry.fittingID || entry.id)) === wanted)
      : (map && map[wanted])
        || (map && Object.values(map).find((entry) => Number(entry && (entry.fittingID || entry.id)) === wanted));
    if (!fit) {
      return {ok: false, lines: [`没找到装配 ${fittingID}`]};
    }
    const id = String(blueprintID || `fit-${fittingID}`).trim();
    const DRONE_BAY_FLAG = 87;
    const fitted = (Array.isArray(fit.fitData) ? fit.fitData : []).filter((entry) => {
      const triple = Array.isArray(entry) ? entry : null;
      const flag = Number(triple ? triple[1] : (entry && (entry.flagID || entry.flag))) || 0;
      return flag !== DRONE_BAY_FLAG;
    });
    const modules = fitted.map((entry) => {
      const triple = Array.isArray(entry) ? entry : null;
      const flagID = Number(triple ? triple[1] : (entry && (entry.flagID || entry.flag))) || 0;
      const typeID = Number(triple ? triple[0] : (entry && (entry.typeID || entry.type))) || 0;
      let name = "";
      try {
        const record = deps.resolveItemByTypeID && deps.resolveItemByTypeID(typeID);
        name = (record && (record.itemName || record.name)) || "";
      } catch (_error) {
        name = "";
      }
      return {
        slot: slotNameForFlag(flagID),
        flagID,
        typeID,
        name,
        quantity: Number(triple ? triple[2] : (entry && (entry.quantity || entry.qty))) || 1,
      };
    });
    const hullTypeID = Number(fit.shipTypeID || fit.typeID) || 0;
    let hullName = "";
    try {
      const record = deps.resolveItemByTypeID && deps.resolveItemByTypeID(hullTypeID);
      hullName = (record && (record.itemName || record.name)) || "";
    } catch (_error) {
      hullName = "";
    }
    const config = {
      id,
      name: String(fit.name || fit.fittingName || id),
      enabled: true,
      count: Math.max(1, Number(options.count) || 1),
      job: "mining",
      skills: "all",
      corporation: "auto",
      wing: null,
      squad: null,
      autoMineOnSpawn: false,
      fit: {source: "inline", hull: {typeID: hullTypeID, name: hullName}, modules},
      behavior: {},
    };
    try {
      fs.writeFileSync(path.join(configsDir, `${id}.json`), `${JSON.stringify(config, null, 2)}\n`, "utf8");
      const reload = configStore.reload();
      const accepted = (reload.configs || []).some((c) => c.id === id);
      if (!accepted) {
        const rejected = (reload.rejected || []).find((r) => (r.config && r.config.id === id) || r.id === id);
        const reason = rejected ? JSON.stringify(rejected.problems || rejected.reason || rejected) : "未知原因";
        return {ok: false, lines: [`蓝图 ${id} 未通过校验：${reason}`]};
      }
      return {ok: true, lines: [`已生成蓝图 ${id}（${config.name} · ${modules.length} 槽）`]};
    } catch (error) {
      return {ok: false, lines: [`写入蓝图失败：${error && error.message}`]};
    }
  }

  function ensureConfigsLoaded() {
    try {
      if ((configStore.get().configs || []).length === 0) {
        configStore.reload();
      }
    } catch (_error) {
      /* best effort */
    }
  }

  // §16: everything the web panel's detail pane shows for one crew ship. Health comes from
  // the entity itself (cheap), fit/cargo from the item store; hold capacity uses the value
  // persisted at spawn because buildShipResourceState costs 500-1100 ms.
  const SLOT_RANGES_FOR_DETAIL = [[11, 34], [92, 99], [125, 132], [164, 171]];

  function isDetailFittingFlag(flagID) {
    const flag = Number(flagID) || 0;
    return SLOT_RANGES_FOR_DETAIL.some(([start, end]) => flag >= start && flag <= end);
  }

  function slotLabelFor(flagID) {
    const flag = Number(flagID) || 0;
    if (flag >= 27 && flag <= 34) return {group: "高槽", slot: `hi slot ${flag - 27}`};
    if (flag >= 19 && flag <= 26) return {group: "中槽", slot: `med slot ${flag - 19}`};
    if (flag >= 11 && flag <= 18) return {group: "低槽", slot: `low slot ${flag - 11}`};
    if (flag >= 92 && flag <= 99) return {group: "改装", slot: `rig slot ${flag - 92}`};
    if (flag >= 125 && flag <= 132) return {group: "子系统", slot: `subsystem slot ${flag - 125}`};
    if (flag >= 164 && flag <= 171) return {group: "服务", slot: `service slot ${flag - 164}`};
    return {group: "货舱", slot: `cargo slot ${flag}`};
  }

  function typeNameOf(typeID) {
    try {
      const record = deps.resolveItemByTypeID && deps.resolveItemByTypeID(Number(typeID) || 0);
      return (record && (record.itemName || record.name)) || "";
    } catch (_error) {
      return "";
    }
  }

  function moduleKindOf(moduleItem) {
    const groupID = Number(moduleItem && moduleItem.groupID) || 0;
    if (groupID === 46 || groupID === 475) return "推进";
    if ([40, 76, 77, 328].includes(groupID)) return "防御";
    const name = typeNameOf(moduleItem && moduleItem.typeID);
    if (/Mining Laser|Strip Miner|Miner|Gas Cloud|Ice Harvester/i.test(name)) return "采矿";
    try {
      const family = deps.weaponDogma && typeof deps.weaponDogma.resolveWeaponFamily === "function"
        ? deps.weaponDogma.resolveWeaponFamily(moduleItem, null)
        : null;
      if (family && typeof deps.weaponDogma.isTurretCycleWeaponFamily === "function"
        && deps.weaponDogma.isTurretCycleWeaponFamily(family)) {
        return "武器";
      }
    } catch (_error) {
      /* fall through */
    }
    return "装备";
  }

  /** Where this crew ship sits relative to the player (metres, screen axes). */
  function crewOffsetFrom(scene, session, entity) {
    try {
      const playerShipID = Number(session && session._space && session._space.shipID) || 0;
      const player = playerShipID && scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(playerShipID)
        : null;
      if (!player || !entity) {
        return null;
      }
      const a = combat.positionOf(entity);
      const b = combat.positionOf(player);
      return {x: Math.round(a.x - b.x), y: Math.round(a.z - b.z), distance: Math.round(combat.surfaceDistance(entity, player))};
    } catch (_error) {
      return null;
    }
  }

  /** Cheap warnings shown as row badges and in the detail pane. */
  function crewWarnings(entry, entity, cargoPct, extra = {}) {
    const warnings = [];
    if (Number(cargoPct) >= 90) {
      warnings.push("货舱将满");
    }
    const cap = entity ? Number(entity.capacitorChargeRatio) : null;
    if (cap !== null && Number.isFinite(cap) && cap < 0.15) {
      warnings.push("电容低");
    }
    if (extra.noAmmo) {
      warnings.push("武器无弹药");
    }
    if (!entity) {
      warnings.push("无实体");
    }
    return warnings;
  }

  function buildCrewDetail(characterID) {
    const wanted = Number(characterID) || 0;
    const entry = (stateStore.get().pool || []).find((row) => Number(row.characterID) === wanted) || null;
    if (!entry) {
      return {ok: false, problems: ["NO_SUCH_CREW"], crew: null, health: null, fitting: [], cargo: []};
    }
    const problems = [];
    const session = serviceSession || null;
    // Resolve the scene even without a live session: the detail pane is often opened
    // before any command created one.
    const scene = follow.sceneFor(deps, session);
    const entity = scene && typeof scene.getEntityByID === "function" ? scene.getEntityByID(entry.shipID) : null;
    const config = configForBlueprint(entry.blueprintID) || null;

    const health = {shield: null, armor: null, structure: null, capacitor: null};
    if (entity) {
      const ratio = (value) => {
        const number = Number(value);
        return Number.isFinite(number) ? Math.min(Math.max(number, 0), 1) : null;
      };
      const shieldMax = Number(entity.shieldCapacity) || 0;
      const shieldRatio = ratio(entity.conditionState && entity.conditionState.shieldCharge);
      if (shieldMax > 0 && shieldRatio !== null) {
        health.shield = {cur: Math.round(shieldMax * shieldRatio), max: Math.round(shieldMax)};
      }
      const armorMax = Number(entity.armorHP) || 0;
      const armorDamage = ratio(entity.conditionState && entity.conditionState.armorDamage);
      if (armorMax > 0 && armorDamage !== null) {
        health.armor = {cur: Math.round(armorMax * (1 - armorDamage)), max: Math.round(armorMax)};
      }
      // Crew ships are built by the mod, so the entity can lack structureHP even though
      // shield/armor are present. Fall back to the hull's `hp` dogma attribute (ID 9).
      let structureMax = Number(entity.structureHP) || Number(entity.hullHP) || 0;
      if (structureMax <= 0) {
        try {
          const hullTypeID = Number(entity.typeID) || Number(entry.hullTypeID) || 0;
          const dogma = hullTypeID > 0 ? sde.loadDogmaAttributes([hullTypeID]).get(hullTypeID) : null;
          const hullHP = dogma && typeof dogma.get === "function" ? Number(dogma.get(9)) || 0 : 0;
          if (hullHP > 0) {
            structureMax = hullHP;
          }
        } catch (_error) {
          /* keep unknown if the SDE lookup fails */
        }
      }
      // 引擎把船体损伤记在 conditionState.damage（见 dogmaService/layerDamageValues.js：
      // hullRatio = 1 - conditionState.damage）。以前读 structureDamage，永远是 undefined，
      // 面板的「结构」就一直是空的。这里把几种可能的字段都兼容一下。
      const structureDamage = ratio(entity.conditionState && (
        entity.conditionState.damage
        ?? entity.conditionState.structureDamage
        ?? entity.conditionState.hullDamage
      ));
      if (structureMax > 0 && structureDamage !== null) {
        health.structure = {cur: Math.round(structureMax * (1 - structureDamage)), max: Math.round(structureMax)};
      }
      const capMax = Number(entity.capacitorCapacity) || 0;
      const capRatio = ratio(entity.capacitorChargeRatio);
      if (capMax > 0 && capRatio !== null) {
        health.capacitor = {cur: Math.round(capMax * capRatio), max: Math.round(capMax)};
      }
    } else {
      problems.push("NO_ENTITY");
    }

    const fitting = [];
    let fitted = [];
    try {
      fitted = deps.fitting && typeof deps.fitting.getFittedModuleItems === "function"
        ? deps.fitting.getFittedModuleItems(wanted, entry.shipID) || []
        : [];
    } catch (error) {
      fitted = [];
      problems.push(`FITTING_FAILED:${error && error.message}`);
    }
    for (const moduleItem of fitted) {
      if (!moduleItem) {
        continue;
      }
      const label = slotLabelFor(moduleItem.flagID);
      // A1：抗性常开是"影子 effect state"，不是真在跑的模块。面板必须区分：
      //   passive = 常开（已生效，不扣电、不占模块）
      //   active  = 真在跑（采矿/武器/回充器脉冲期间）
      const moduleID = Number(moduleItem.itemID) || 0;
      const effectState = entity && entity.activeModuleEffects instanceof Map
        ? entity.activeModuleEffects.get(moduleID) || null
        : null;
      const passive = Boolean(effectState && effectState.passiveHardener === true);
      // S2：结算化的模块（回充器/修甲）不产生 effectState，用结算节流表判断
      // "这一轮正在修"，面板据此显示"结算中"。
      const settling = (Number(defenseSettleState.get(`${wanted}:${moduleID}`)) || 0) > now();
      fitting.push({
        itemID: moduleID,
        flagID: Number(moduleItem.flagID) || 0,
        slot: label.slot,
        group: label.group,
        typeID: Number(moduleItem.typeID) || 0,
        name: typeNameOf(moduleItem.typeID),
        quantity: Number(moduleItem.quantity) || 1,
        online: typeof deps.fitting.isModuleOnline === "function" ? deps.fitting.isModuleOnline(moduleItem) === true : true,
        // Running right now (mining laser firing, MWD on, booster pulsing …).
        active: Boolean(effectState) && !passive,
        passive,
        settling,
        effectLabel: passive ? "抗性常开" : (settling ? "结算中" : null),
        kind: moduleKindOf(moduleItem),
      });
    }

    const cargo = [];
    let cargoUsed = 0;
    try {
      const items = deps.itemStore && typeof deps.itemStore.listContainerItems === "function"
        ? deps.itemStore.listContainerItems(wanted, entry.shipID) || []
        : [];
      for (const item of items) {
        if (!item || isDetailFittingFlag(item.flagID)) {
          continue;
        }
        const quantity = Number(item.quantity) || 1;
        const volume = (Number(item.volume) || 0) * (quantity > 0 ? quantity : 1);
        cargoUsed += volume;
        cargo.push({
          typeID: Number(item.typeID) || 0,
          name: typeNameOf(item.typeID),
          quantity,
          volume: Math.round(volume * 100) / 100,
          isCharge: Number(item.categoryID) === 8,
        });
      }
    } catch (error) {
      problems.push(`CARGO_FAILED:${error && error.message}`);
    }

    // What this ship is working on right now, so the pane can say it in words.
    let target = null;
    let modulesRunning = 0;
    // S2：结算中的（回充器/修甲）也算"在干活"，否则顶部"运行 N"会突然变小。
    const settlingCount = fitting.filter((item) => item.settling === true).length;
    if (entity && entity.activeModuleEffects instanceof Map) {
      modulesRunning = runningModuleCount(entity) + settlingCount;
      const firstEffect = [...entity.activeModuleEffects.values()].find((state) => Number(state && state.targetID) > 0) || null;
      if (firstEffect) {
        const targetID = Number(firstEffect.targetID) || 0;
        const targetEntity = targetID && typeof scene.getEntityByID === "function" ? scene.getEntityByID(targetID) : null;
        const kindByItemID = new Map(fitting.map((item) => [Number(item.itemID) || 0, item.kind]));
        const isAttack = [...entity.activeModuleEffects.entries()].some(([moduleID, state]) =>
          Number(state && state.targetID) === targetID && kindByItemID.get(Number(moduleID) || 0) === "武器",
        );
        target = {
          id: targetID,
          name: (targetEntity && (targetEntity.name || typeNameOf(targetEntity.typeID))) || String(targetID),
          distance: targetEntity ? Math.round(combat.surfaceDistance(entity, targetEntity)) : null,
          kind: isAttack ? "attack" : "mine",
        };
      }
    }
    // Ammo check for the detail pane warning badge (weapons without a loaded charge).
    let noAmmo = false;
    try {
      for (const item of fitting) {
        if (item.kind !== "武器") {
          continue;
        }
        const loaded = typeof deps.fitting.getLoadedChargeByFlag === "function"
          ? deps.fitting.getLoadedChargeByFlag(wanted, entry.shipID, item.flagID)
          : null;
        if (!loaded) {
          noAmmo = true;
          break;
        }
      }
    } catch (_error) {
      noAmmo = false;
    }
    const detailCargoPct = Number(entry.holdCapacity) > 0 ? Math.round(cargoUsed * 100 / Number(entry.holdCapacity)) : 0;
    const modulesPassive = fitting.filter((item) => item.passive === true).length;
    return {
      ok: true,
      problems,
      target,
      modulesRunning,
      modulesPassive,
      modulesTotal: fitting.length,
      offset: crewOffsetFrom(scene, session, entity),
      speed: entity ? {
        // Current speed comes from the velocity vector, max from the derived attribute.
        cur: Math.round(Math.hypot(
          Number(entity.velocity && entity.velocity.x) || 0,
          Number(entity.velocity && entity.velocity.y) || 0,
          Number(entity.velocity && entity.velocity.z) || 0,
        )),
        max: Math.round(Number(entity.maxVelocity) || 0),
        mass: Math.round(Number(entity.mass) || 0),
        signatureRadius: Math.round(Number(entity.signatureRadius) || 0),
      } : null,
      warnings: crewWarnings(entry, entity, detailCargoPct, {noAmmo}),
      crew: {
        characterID: wanted,
        name: String(entry.name || ""),
        blueprintID: String(entry.blueprintID || ""),
        shipID: Number(entry.shipID) || 0,
        hullName: String((config && config.fit && config.fit.hull && config.fit.hull.name) || ""),
        mode: String((entity && entity.mode) || "无实体"),
        active: runningModuleCount(entity) > 0,
        mining: miningWanted.has(wanted),
        // 遥修是只读状态（没有开关），面板只展示"装了哪几族、在修谁"。
        remote: (() => {
          const remoteRows = remoteModulesFor(entry);
          if (remoteRows.length === 0) {
            return null;
          }
          const firing = remoteRows.filter((row) => remoteAssist.isActive(entity, row.moduleItem.itemID));
          const targetID = Number(firing.length > 0
            ? (remoteAssist.effectStateOf(entity, firing[0].moduleItem.itemID) || {}).targetID
            : 0) || 0;
          return {
            families: [...new Set(remoteRows.map((row) => row.family))]
              .map((family) => ({id: family, label: remoteAssist.familySpec(family).label})),
            active: firing.length > 0,
            targetShipID: targetID,
          };
        })(),
        npcMode: npcModeFor(entry),
        target: describeTarget(scene, entity, combatTargets.get(Number(entry.characterID) || 0) || 0),
        destroyed: entry.destroyed === true,
        special: specialModulesFor(entry, entity),
      },
      health,
      fitting,
      cargo,
      cargoUsed: Math.round(cargoUsed * 100) / 100,
      cargoCapacity: Number(entry.holdCapacity) || 0,
    };
  }

  /** 这艘船有没有立体炸弹（组 72）——面板行内按钮用。 */
  function smartbombAvailable(entry, entity) {
    const rows = smartbombModulesFor(entry);
    if (rows.length === 0) {
      return null;
    }
    return {
      kind: "smartbomb",
      moduleName: String(rows[0].moduleItem.itemName || ""),
      active: activeModules.isActive(entity, rows[0].moduleItem.itemID),
      wanted: specialStateOf(entry).smartbomb === true,
    };
  }

  function buildStatusPayload(session) {
    // 字段组装在 lib/nfCrewMiningStatus.js；这里只保留函数名给命令和 web 回调使用。
    // 带上模组版本，面板才能判断"服务端到底重启没有"（旧后端 + 新界面 = 各种显示不对）。
    const payload = statusBuilder.build(session);
    return {...payload, version: MOD_VERSION};
  }

  /** /crewmine price <typeID|名字> [数量] —— 80% 卖价与兜底价。 */
  function priceReport(rest) {
    const target = String(rest[0] || "").trim();
    if (!target) {
      const stats = priceService().stats();
      return [
        `价格口径：吉他最低卖价 × ${stats.discount}；没有卖价的物品按 ${stats.fallbackISK} ISK。`,
        `价格库：${stats.ok ? `${stats.count} 个类型` : `不可用（${stats.error || "未知"}）`}`,
        `        ${stats.dbFile}`,
        "用法：/crewmine price <typeID|名字> [数量]",
      ];
    }
    const qty = Math.max(1, Math.trunc(Number(rest[1])) || 1);
    let typeID = /^\d+$/u.test(target) ? Number(target) : 0;
    let name = "";
    if (!typeID) {
      let hit = null;
      try {
        const resolved = sde.resolveNames([target]);
        hit = resolved ? [...resolved.resolved.values()][0] : null;
      } catch (_error) {
        hit = null;
      }
      if (!hit) {
        return [`不认识的物品：${target}（也可以直接给 typeID）`];
      }
      typeID = Number(hit.typeID) || 0;
      name = hit.chinese || hit.english || "";
    }
    const price = priceService().priceOf(typeID);
    const entry = catalogService().get(typeID);
    const label = name || (entry && entry.n) || "";
    const discount = priceService().stats().discount;
    const lines = [label ? `${label}（${typeID}）` : `typeID ${typeID}`];
    if (price.source === "ask80") {
      lines.push(`吉他卖价 ${Math.round(price.ask).toLocaleString("en-US")} × ${discount} = `
        + `${price.price.toLocaleString("en-US")} ISK/件`);
    } else {
      lines.push(`没有卖价 → 兜底 ${price.price} ISK/件`);
    }
    if (qty > 1) {
      lines.push(`${qty} 件 = ${(price.price * qty).toLocaleString("en-US")} ISK`);
    }
    if (entry && entry.f === "hull") {
      lines.push(`船体槽位：高 ${entry.hi || 0} / 中 ${entry.me || 0} / 低 ${entry.lo || 0} / 改装 ${entry.rig || 0}`
        + ` · 无人机舱 ${entry.dc || 0} m³ / 带宽 ${entry.db || 0}`);
    } else if (entry) {
      lines.push(`索引：${entry.f}${entry.cpu ? ` · CPU ${entry.cpu}` : ""}${entry.pg ? ` · PG ${entry.pg}` : ""}`
        + `${entry.cs ? ` · 弹药尺寸 ${entry.cs}` : ""}`);
    }
    return lines;
  }

  /** /crewmine catalog [build|ships|high|med|low|rig|charge|drone] */
  function catalogReport(rest) {
    const action = String(rest[0] || "status").toLowerCase();
    const catalog = catalogService();
    if (action === "build") {
      const result = catalog.build(true);
      if (!result.ok) {
        return [`索引重建失败：${result.error}`];
      }
      const counts = result.counts || {};
      return [
        `索引已重建：${result.total} 个类型（SDE ${result.sdeBuild}）`,
        `船体 ${counts.hull || 0} · 高槽 ${counts.high || 0} · 中槽 ${counts.med || 0} · 低槽 ${counts.low || 0}`
          + ` · 改装 ${counts.rig || 0} · 弹药 ${counts.charge || 0} · 无人机 ${counts.drone || 0}`,
        `缓存：${result.cacheFile}`,
      ];
    }
    if (action === "ships") {
      const ships = catalog.ships().slice(0, 40);
      return [`船体（前 ${ships.length} 条）：`, ...ships.map((ship) => `${ship.typeID} ${ship.n}`)];
    }
    if (["high", "med", "low", "rig", "charge", "drone"].includes(action)) {
      const list = (action === "charge" || action === "drone"
        ? catalog.all().filter((entry) => entry.f === action)
        : catalog.modules(action)).slice(0, 40);
      return [
        `${action}（前 ${list.length} 条）：`,
        ...list.map((entry) => `${entry.typeID} ${entry.n}`
          + `${entry.cpu ? ` cpu${entry.cpu}` : ""}${entry.pg ? ` pg${entry.pg}` : ""}`
          + `${entry.cs ? ` cs${entry.cs}` : ""}`),
      ];
    }
    const status = catalog.status();
    if (!status.ok) {
      return [`索引不可用：${status.error}`];
    }
    return [
      `索引：${status.total} 个类型（SDE ${status.sdeBuild}，建于 ${new Date(status.builtAt).toISOString()}）`,
      `船体 ${status.counts.hull || 0} · 高 ${status.counts.high || 0} · 中 ${status.counts.med || 0}`
        + ` · 低 ${status.counts.low || 0} · 改装 ${status.counts.rig || 0}`
        + ` · 弹药 ${status.counts.charge || 0} · 无人机 ${status.counts.drone || 0}`,
      `缓存：${status.cacheFile}`,
      "用法：/crewmine catalog build | ships | high|med|low|rig|charge|drone",
    ];
  }

  // ---- P1 库存：仓库角色、取船/回库、买卖 ------------------------------------

  function playerCharacterName(session) {
    const id = Number(session && session.characterID) || 0;
    try {
      if (id && deps.characterState && typeof deps.characterState.peekCharacterRecord === "function") {
        const record = deps.characterState.peekCharacterRecord(id);
        if (record && record.characterName) {
          return String(record.characterName);
        }
      }
    } catch (_error) {
      /* 退回 session 上的名字 */
    }
    return String((session && (session.characterName || session.charName)) || "");
  }

  function warehouseReady(session) {
    const stock = stockService().read();
    if (stock.warehouse && warehouseModule.characterExists(deps, stock.warehouse.characterID)) {
      return {ok: true, created: false, warehouse: stock.warehouse};
    }
    return warehouseModule.ensureWarehouse(deps, {
      stockStore: stockService(),
      playerName: playerCharacterName(session),
      accountId: crewAccount(),
      stationID: warehouseModule.WAREHOUSE_STATION_ID,
      log,
      now,
    });
  }

  /** 按蓝图签名挑 N 艘在库的船并整批占位；不够就整批不动。
   *  stockIDs 给了就只用这几艘（面板多选召唤），仍然校验签名与状态。 */
  function prepareStockPlan({config, members, session, stockIDs}) {
    const ready = warehouseReady(session);
    if (!ready.ok) {
      return {ok: false, lines: [`仓库角色没建好（${ready.problem || "未知"}），库存不可用`]};
    }
    const signature = ship.blueprintSignature(config.fit);
    const explicit = (Array.isArray(stockIDs) ? stockIDs : []).map(String).filter(Boolean);
    let picks = [];
    if (explicit.length > 0) {
      picks = explicit.map((id) => stockService().get(id)).filter(Boolean);
      if (picks.length !== explicit.length) {
        return {ok: false, lines: ["选中的库存船里有已经不存在的（先 /crewmine stock reconcile）"]};
      }
      const bad = picks.find((row) => row.state !== stockModule.STATES.stored || row.signature !== signature);
      if (bad) {
        return {
          ok: false,
          lines: [`${bad.id} 不能召唤：${bad.state !== stockModule.STATES.stored ? `状态 ${bad.state}` : "配装和蓝图不一致"}`],
        };
      }
      if (picks.length < members.length) {
        return {ok: false, lines: [`选中的船 ${picks.length} 艘，不够 ${members.length} 人`]};
      }
      picks = picks.slice(0, members.length);
    } else {
      const stored = stockService().list({state: stockModule.STATES.stored})
        .filter((row) => row.signature === signature);
      if (stored.length < members.length) {
        return {
          ok: false,
          lines: [
            `库存船不够：需要 ${members.length} 艘「${config.id}」的船，库存里只有 ${stored.length} 艘。`,
            `先备货：/crewmine stock buy ${config.id} ${Math.max(1, members.length - stored.length)}`,
          ],
        };
      }
      picks = stored.slice(0, members.length);
    }
    const token = `spawn-${now()}-${Math.random().toString(36).slice(2, 8)}`;
    const reserved = stockService().reserve(picks.map((row) => row.id), token);
    if (!reserved.ok) {
      return {ok: false, lines: [`库存占位失败：${reserved.problem}`]};
    }
    return {
      ok: true,
      plan: {token, records: reserved.items, used: 0, warehouseCharacterID: ready.warehouse.characterID},
    };
  }

  /** 把一艘库存船转给船员并设为当前船；失败不占账本。 */
  function takeStockShip(plan, member) {
    const record = plan.records[plan.used];
    if (!record) {
      return {ok: false, problems: ["STOCK_EXHAUSTED"]};
    }
    const stationID = warehouseModule.WAREHOUSE_STATION_ID;
    const moved = warehouseModule.transferShip(deps, {
      shipID: record.itemID,
      characterID: member.characterID,
      stationID,
    });
    if (!moved.ok) {
      return {ok: false, problems: [`TAKE_FAILED:${moved.error}`]};
    }
    // 兜底补过户：0.6.35 之前转移的船，船里的模块还挂在仓库角色名下。
    try {
      const reowned = warehouseModule.reownShipContents(deps, {shipID: record.itemID, characterID: member.characterID});
      if (reowned && reowned.moved > 0) {
        log(`[stock] ${record.id} 补过户 ${reowned.moved} 件装备给 ${member.characterID}`);
      }
    } catch (_error) {
      /* 补过户失败不影响取船：新转移已经带 reownContents */
    }
    const active = warehouseModule.setActiveShip(deps, {characterID: member.characterID, shipID: record.itemID});
    if (!active.ok) {
      warehouseModule.transferShip(deps, {
        shipID: record.itemID,
        characterID: plan.warehouseCharacterID,
        stationID,
      });
      return {ok: false, problems: [`ACTIVE_FAILED:${active.error}`]};
    }
    plan.used += 1;
    return {ok: true, shipID: record.itemID, problems: [], granted: {modules: 0, drones: 0}, fromStock: record};
  }

  /** 把船停回 4-4 并转回仓库角色；账本回「在库」。 */
  function returnStockShip(record) {
    if (!record) {
      return false;
    }
    const stock = stockService().read();
    const warehouseCharacterID = Number(stock.warehouse && stock.warehouse.characterID) || 0;
    if (!warehouseCharacterID) {
      return false;
    }
    const stationID = warehouseModule.WAREHOUSE_STATION_ID;
    warehouseModule.dockShip(deps, {shipID: record.itemID, stationID});
    const back = warehouseModule.transferShip(deps, {
      shipID: record.itemID,
      characterID: warehouseCharacterID,
      stationID,
    });
    if (back.ok) {
      stockService().markStored(record.id);
      return true;
    }
    log(`[stock] ${record.name || record.itemID} 回库失败：${back.error}`);
    return false;
  }

  /** P1.5 对账：账本跟着物品表走（可选认领仓库机库里没上账的船）。 */
  function reconcileStockLedger(options = {}) {
    const stock = stockService().read();
    const warehouseCharacterID = Number(stock.warehouse && stock.warehouse.characterID) || 0;
    const known = new Set(
      (stateStore.get().pool || []).map((row) => Number(row.characterID)).filter((id) => id > 0),
    );
    if (warehouseCharacterID) {
      known.add(warehouseCharacterID);
    }
    return stockReconcile.reconcileStock({
      stockStore: stockService(),
      lookupItem: (itemID) => warehouseModule.itemOf(deps, itemID),
      warehouseCharacterID,
      stationID: warehouseModule.WAREHOUSE_STATION_ID,
      knownCharacterIDs: known,
      dockShip: (shipID, stationID) => warehouseModule.dockShip(deps, {shipID, stationID}).ok,
      reownShipContents: (shipID, characterID) => warehouseModule.reownShipContents(deps, {shipID, characterID}).moved || 0,
      adopt: options.adopt === true && warehouseCharacterID > 0,
      snapshotOf: (itemID) => ship.snapshotFit(deps, {characterID: warehouseCharacterID, shipID: itemID}),
      listWarehouseShips: () => (warehouseCharacterID > 0
        ? warehouseModule.hangarShips(deps, {
          characterID: warehouseCharacterID,
          stationID: warehouseModule.WAREHOUSE_STATION_ID,
        })
        : []),
      log,
    });
  }

  /** P4：把账本复制一份（物品库另备），给"一起备份"留个落点。 */
  function backupStateFile() {
    try {
      if (!fs.existsSync(stateFile)) {
        return `账本还不存在（${stateFile}），没什么可备份的`;
      }
      const stamp = new Date(now()).toISOString().replace(/[:.]/gu, "-");
      const dir = path.join(path.dirname(stateFile), "backups");
      fs.mkdirSync(dir, {recursive: true});
      const target = path.join(dir, `state-${stamp}.json`);
      fs.copyFileSync(stateFile, target);
      return `账本已备份：${target}\n物品库记得一起备：${path.join(host.WORKSPACE, "_local", "gameStore", "gamestore.sqlite")}`;
    } catch (error) {
      return `备份失败：${error && error.message}`;
    }
  }

  /** 同步钱包加减（负数=扣）。异步权威模式下会抛，调用方报错不造东西。 */
  function walletAdjust(characterID, amount, options = {}) {
    const wallet = deps.wallet;
    if (!wallet) {
      return {ok: false, error: "NO_WALLET"};
    }
    const delta = Math.round(Number(amount) || 0);
    if (!delta) {
      return {ok: true, amount: 0};
    }
    try {
      if (typeof wallet.adjustCharacterBalance === "function") {
        const result = wallet.adjustCharacterBalance(Number(characterID), delta, options);
        if (result && result.success === true) {
          return {ok: true, amount: delta};
        }
        return {ok: false, error: (result && result.errorMsg) || "WALLET_FAILED"};
      }
      return {ok: false, error: "NO_WALLET_API"};
    } catch (error) {
      return {ok: false, error: `WALLET_ERROR:${error && error.message}`};
    }
  }

  /** 扣款/退款：本地权威先走同步；process 模式下同步被禁，自动改走异步接口。 */
  async function walletAdjustAsync(characterID, amount, options = {}) {
    const attempt = walletAdjust(characterID, amount, options);
    if (attempt.ok) {
      return attempt;
    }
    if (!/SYNC_WALLET_AUTHORITY_DISABLED|process mode/iu.test(String(attempt.error || ""))) {
      return attempt;
    }
    const wallet = deps.wallet;
    const asyncApi = wallet && (wallet.adjustCharacterBalanceAsync || wallet.adjustCharacterBalance_async);
    if (typeof asyncApi !== "function") {
      return {ok: false, error: "WALLET_ERROR:进程模式但钱包没有异步接口"};
    }
    try {
      const rounded = Math.round(Number(amount) || 0);
      const result = await asyncApi(Number(characterID), rounded, options, {source: "nf-crew-stock"});
      if (result && result.success === true) {
        return {ok: true, amount: rounded};
      }
      return {ok: false, error: (result && result.errorMsg) || "WALLET_FAILED"};
    } catch (error) {
      return {ok: false, error: `WALLET_ERROR:${error && error.message}`};
    }
  }

  /** 蓝图单件价：船体 + 模块（无人机/弹药不计价）。 */
  function blueprintUnitPrice(config) {
    const items = [];
    const hullTypeID = Number(config && config.fit && config.fit.hull && config.fit.hull.typeID) || 0;
    if (hullTypeID) {
      items.push({typeID: hullTypeID, qty: 1});
    }
    for (const module of Array.isArray(config && config.fit && config.fit.modules) ? config.fit.modules : []) {
      const typeID = Number(module && module.typeID) || 0;
      if (typeID) {
        items.push({typeID, qty: Math.max(1, Number(module.quantity) || 1)});
      }
    }
    return priceService().quote(items);
  }

  async function stockBuy(config, count, sessionArg) {
    const session = sessionArg || resolvePlayerSession();
    const ready = warehouseReady(session);
    if (!ready.ok) {
      return [`仓库角色没建好（${ready.problem || "未知"}）`];
    }
    const characterID = Number(session && (session.characterID || session.charid)) || 0;
    if (!characterID) {
      return ["面板还没拿到你的角色：先在游戏里动一下（或重开面板）再试"];
    }
    const unit = blueprintUnitPrice(config);
    const total = unit.total * count;
    const orderKey = `nfcrew-stock-buy:${tenantAccountID || 0}:${now()}-${Math.random().toString(36).slice(2, 8)}`;
    const charged = await walletAdjustAsync(characterID, -total, {
      idempotencyKey: orderKey,
      description: `NFCrew 库存订货 ${config.id} ×${count}`,
    });
    if (!charged.ok) {
      return [`扣款失败（${charged.error}），没有造任何船`];
    }
    const snapshot = ship.snapshotFromBlueprint(config.fit);
    const signature = ship.blueprintSignature(config.fit);
    const made = [];
    for (let index = 0; index < count; index += 1) {
      const built = ship.createShip(deps, {
        characterID: ready.warehouse.characterID,
        stationID: warehouseModule.WAREHOUSE_STATION_ID,
        fit: config.fit,
        name: `${config.name} ${index + 1}`,
      });
      if (!built.ok) {
        for (const row of made) {
          try {
            deps.itemStore.removeInventoryItem(row.itemID);
          } catch (_error) {
            /* 删不掉就留在仓库里（账本马上也删掉） */
          }
          // 账本条目也要撤：不然对账会把它当"丢失"，看起来像玩家爆了一艘船。
          stockService().remove(row.record.id);
        }
        const refund = await walletAdjustAsync(characterID, total, {
          idempotencyKey: `${orderKey}:refund`,
          description: "NFCrew 订货失败退款",
        });
        return [
          `造船失败（${built.problems.join(" ")}），已退款${refund.ok ? "" : `（退款也失败：${refund.error}）`}`,
        ];
      }
      const record = stockService().add({
        itemID: built.shipID,
        hullTypeID: Number(config.fit.hull.typeID) || 0,
        name: `${config.name} ${index + 1}`,
        source: "bought",
        state: stockModule.STATES.stored,
        fit: snapshot,
        signature,
        pricePaid: unit.total,
        priceBasis: "ask80",
        addedAt: now(),
      });
      made.push({itemID: built.shipID, record});
    }
    stockService().addSpent(total);
    return [
      `已入库 ${made.length} 艘「${config.id}」：单价 ${unit.total.toLocaleString("en-US")} ISK，`
        + `合计 ${total.toLocaleString("en-US")} ISK`,
      ...made.map((row) => `  ${row.record.id} · ${row.record.name}（船 ${row.itemID}）`),
      `仓库：${ready.warehouse.name}（${ready.warehouse.characterID}）@ 吉他 4-4`,
    ];
  }

  function stockDeposit(sessionArg, itemIDs = null) {
    const session = sessionArg || resolvePlayerSession();
    const characterID = Number(session && (session.characterID || session.charid)) || 0;
    if (!characterID) {
      return ["面板还没拿到你的角色：先在游戏里动一下（或重开面板）再试"];
    }
    const activeShipID = Number(session && session._space && session._space.shipID) || 0;
    const ready = warehouseReady(session);
    if (!ready.ok) {
      return [`仓库角色没建好（${ready.problem || "未知"}）`];
    }
    const wanted = (Array.isArray(itemIDs) ? itemIDs : []).map(Number).filter((id) => id > 0);
    let own = warehouseModule.hangarShips(deps, {characterID, stationID: warehouseModule.WAREHOUSE_STATION_ID})
      .filter((row) => row.itemID !== activeShipID);
    if (wanted.length > 0) {
      own = own.filter((row) => wanted.includes(row.itemID));
    }
    if (own.length === 0) {
      return [
        wanted.length > 0
          ? "选中的船不在吉他 4-4 机库（或者正是你在开的那艘）"
          : "你在吉他 4-4 没有可转入的船（正在开的那艘不能转，先换一艘）。",
      ];
    }
    const lines = [];
    for (const row of own) {
      if (stockService().findByItemID(row.itemID)) {
        continue;
      }
      const snapshot = ship.snapshotFit(deps, {characterID, shipID: row.itemID});
      const moved = warehouseModule.transferShip(deps, {
        shipID: row.itemID,
        characterID: ready.warehouse.characterID,
        stationID: warehouseModule.WAREHOUSE_STATION_ID,
      });
      if (!moved.ok) {
        lines.push(`${row.name || row.itemID}：转入失败（${moved.error}）`);
        continue;
      }
      const record = stockService().add({
        itemID: row.itemID,
        hullTypeID: row.typeID,
        name: row.name || String(row.itemID),
        source: "existing",
        state: stockModule.STATES.stored,
        fit: snapshot,
        signature: snapshot.signature,
        pricePaid: 0,
        addedAt: now(),
      });
      lines.push(`已转入：${record.id} · ${record.name}`);
    }
    return lines.length > 0 ? lines : ["没有新增（这些船已经在库存里）"];
  }

  function stockWithdraw(ids, sessionArg) {
    const session = sessionArg || resolvePlayerSession();
    const characterID = Number(session && (session.characterID || session.charid)) || 0;
    if (!characterID) {
      return ["面板还没拿到你的角色：先在游戏里动一下（或重开面板）再试"];
    }
    const lines = [];
    for (const id of ids) {
      const record = stockService().get(id);
      if (!record) {
        lines.push(`${id}：没有这条库存`);
        continue;
      }
      if (record.state !== stockModule.STATES.stored) {
        lines.push(`${id}：不在库（${record.state}）`);
        continue;
      }
      const moved = warehouseModule.transferShip(deps, {
        shipID: record.itemID,
        characterID,
        stationID: warehouseModule.WAREHOUSE_STATION_ID,
      });
      if (!moved.ok) {
        lines.push(`${id}：取出失败（${moved.error}）`);
        continue;
      }
      stockService().remove(id);
      lines.push(`${id}：已取出 ${record.name}（在吉他 4-4 机库）`);
    }
    return lines;
  }

  async function stockSell(ids, sessionArg) {
    const session = sessionArg || resolvePlayerSession();
    const characterID = Number(session && (session.characterID || session.charid)) || 0;
    if (!characterID) {
      return ["面板还没拿到你的角色：先在游戏里动一下（或重开面板）再试"];
    }
    const lines = [];
    for (const id of ids) {
      const record = stockService().get(id);
      if (!record) {
        lines.push(`${id}：没有这条库存`);
        continue;
      }
      if (record.state !== stockModule.STATES.stored) {
        lines.push(`${id}：不在库（${record.state}）`);
        continue;
      }
      if (record.source !== "bought") {
        lines.push(`${id}：自有船只能取出，不能卖`);
        continue;
      }
      try {
        deps.itemStore.removeInventoryItem(record.itemID);
      } catch (error) {
        lines.push(`${id}：删船失败（${error && error.message}）`);
        continue;
      }
      const refund = await walletAdjustAsync(characterID, record.pricePaid, {
        idempotencyKey: `nfcrew-stock-sell:${record.itemID}`,
        description: `NFCrew 库存卖出 ${record.name}`,
      });
      if (!refund.ok) {
        lines.push(`${id}：船已删，但退款失败（${refund.error}）`);
      } else {
        stockService().addRefunded(record.pricePaid);
      }
      stockService().remove(id);
      lines.push(`${id}：已卖出 ${record.name}，退款 ${record.pricePaid.toLocaleString("en-US")} ISK`);
    }
    return lines;
  }

  /**
   * 重购一艘「已丢失」的船：按同一签名找蓝图；找不到就用库存里存的配装快照重建一条临时配装。
   * 花钱/造船都走 stockBuy（和面板订货同一条链路），所以依旧是 80% 价 + 进仓库。
   */
  async function stockRebuy(id, sessionArg) {
    const session = sessionArg || resolvePlayerSession();
    const record = stockService().get(id);
    if (!record) {
      return [`没有这条库存：${id}`];
    }
    if (record.state !== stockModule.STATES.lost) {
      return [`${id} 不是「已丢失」状态（${record.state}），不用重购`];
    }
    const blueprints = configStore.get().configs || [];
    const bySignature = new Map(blueprints.map((config) => [ship.blueprintSignature(config.fit), config]));
    const matched = bySignature.get(record.signature);
    if (matched) {
      const lines = await stockBuy(matched, 1, session);
      if (!lines.some((line) => /失败|不够|没建好|没法/.test(line))) {
        // 重购成功：删掉那条红色的丢失记录，避免“买到了还红着”。
        stockService().remove(id);
        lines.push(`已清掉原丢失记录 ${id}`);
      }
      return [`重购「${matched.id}」：`, ...lines];
    }
    // 没有对应蓝图（配装台拼的自定义船）：把快照还原成 fit 再买。
    const snapshot = record.fit;
    if (!snapshot || !Number(snapshot.hullTypeID)) {
      return [`${id} 没有存下配装快照，没法重购`];
    }
    const modules = [];
    for (const family of ["high", "med", "low", "rig", "subsystem"]) {
      for (const module of (snapshot.modules && snapshot.modules[family]) || []) {
        const entry = {flagID: Number(module.flagID) || 0, typeID: Number(module.typeID) || 0, quantity: 1};
        if (!entry.typeID) {
          continue;
        }
        if (module.charge) {
          entry.charge = {typeID: Number(module.charge) || 0, quantity: Number(module.chargeQuantity) || 1};
        }
        modules.push(entry);
      }
    }
    const fit = {
      source: "inline",
      hull: {typeID: Number(snapshot.hullTypeID) || 0, name: ""},
      modules,
      drones: Array.isArray(snapshot.drones) ? snapshot.drones : [],
      cargo: [],
    };
    const custom = {
      id: `rebuy-${record.id}`,
      name: record.name || "重购",
      fit,
      behavior: configs.BEHAVIOR_DEFAULTS,
    };
    const lines = await stockBuy(custom, 1, session);
    if (!lines.some((line) => /失败|不够|没建好|没法/.test(line))) {
      stockService().remove(id);
      lines.push(`已清掉原丢失记录 ${id}`);
    }
    return [`重购「${record.name || record.id}」：`, ...lines];
  }

  /** 把「不在役」的老船员船搬进库存（在役的等解散时自动回库）。 */
  function stockMigrate(session) {
    const ready = warehouseReady(session);
    if (!ready.ok) {
      return [`仓库角色没建好（${ready.problem || "未知"}）`];
    }
    const lines = [];
    let moved = 0;
    for (const member of stateStore.get().pool || []) {
      const shipID = Number(member.shipID) || 0;
      if (!shipID || stockService().findByItemID(shipID)) {
        continue;
      }
      if (member.summoned === true) {
        lines.push(`${member.name}：在用，等解散时自动回库`);
        continue;
      }
      const item = warehouseModule.itemOf(deps, shipID);
      if (!item) {
        lines.push(`${member.name}：船 ${shipID} 已不存在，跳过`);
        continue;
      }
      const snapshot = ship.snapshotFit(deps, {characterID: member.characterID, shipID});
      warehouseModule.dockShip(deps, {shipID, stationID: warehouseModule.WAREHOUSE_STATION_ID});
      const transferred = warehouseModule.transferShip(deps, {
        shipID,
        characterID: ready.warehouse.characterID,
        stationID: warehouseModule.WAREHOUSE_STATION_ID,
      });
      if (!transferred.ok) {
        lines.push(`${member.name}：迁移失败（${transferred.error}）`);
        continue;
      }
      const record = stockService().add({
        itemID: shipID,
        hullTypeID: snapshot.hullTypeID,
        name: String(item.itemName || member.name || shipID),
        source: "existing",
        state: stockModule.STATES.stored,
        fit: snapshot,
        signature: snapshot.signature,
        pricePaid: 0,
        addedAt: now(),
      });
      moved += 1;
      lines.push(`${member.name}：${record.id} 已入库`);
    }
    lines.unshift(`迁移完成：${moved} 艘入库`);
    return lines;
  }

  /** /crewmine stock ... */
  function stockReport(rest, context) {
    const session = (context && context.session) || null;
    const action = String(rest[0] || "status").toLowerCase();
    const stock = stockService().read();
    const counts = stockService().stats();
    if (action === "on" || action === "off") {
      const enabled = action === "on";
      stockService().setEnabled(enabled);
      if (!enabled) {
        return ["库存已关闭：召唤回到「凭空造」老路径；库存里的船留在仓库不动。"];
      }
      const ready = warehouseReady(session);
      if (!ready.ok) {
        return [`库存已开启，但仓库角色没建好（${ready.problem || "未知"}）`];
      }
      return [
        "库存已开启：召唤改为「从库存取船」。",
        `仓库：${ready.warehouse.name}（${ready.warehouse.characterID}）@ 吉他 4-4`,
        stockReconcile.describeReconcile(reconcileStockLedger({adopt: false})),
        "老船员船：/crewmine stock migrate（在役的等解散时自动回库）",
      ];
    }
    if (action === "init") {
      const ready = warehouseReady(session);
      return ready.ok
        ? [`仓库就绪：${ready.warehouse.name}（${ready.warehouse.characterID}）@ 吉他 4-4${ready.created ? "（新建）" : ""}`]
        : [`仓库角色建不出来：${ready.problem || "未知"}`];
    }
    if (action === "buy") {
      const blueprintID = String(rest[1] || "").trim();
      const count = Math.max(1, Math.trunc(Number(rest[2])) || 1);
      const config = configForBlueprint(blueprintID);
      if (!config) {
        return [`没有这条配装：${blueprintID}（先 /crewmine check）`];
      }
      if (!deps.itemStore || !deps.wallet) {
        return ["缺服务端依赖（itemStore / wallet），订货只能在游戏里执行"];
      }
      return stockBuy(config, count, session);
    }
    if (action === "deposit") {
      const itemIDs = rest.slice(1).map(Number).filter((id) => Number.isFinite(id) && id > 0);
      return stockDeposit(session, itemIDs);
    }
    if (action === "withdraw") {
      const ids = rest.slice(1).map(String).filter(Boolean);
      if (ids.length === 0) {
        return ["用法：/crewmine stock withdraw <库存ID…>"];
      }
      return stockWithdraw(ids, session);
    }
    if (action === "sell") {
      const ids = rest.slice(1).map(String).filter(Boolean);
      if (ids.length === 0) {
        return ["用法：/crewmine stock sell <库存ID…>（只对购入的船生效）"];
      }
      return stockSell(ids, session);
    }
    if (action === "migrate") {
      return stockMigrate(session);
    }
    if (action === "reconcile") {
      const adopt = rest.includes("adopt") || rest.includes("--adopt");
      return [stockReconcile.describeReconcile(reconcileStockLedger({adopt}))];
    }
    if (action === "backup") {
      return [backupStateFile()];
    }
    // status / list：先按物品表校一遍账本，再看数字。
    const lines = [];
    if (stock.warehouse && stock.warehouse.characterID) {
      const reconciled = reconcileStockLedger({adopt: false});
      if (reconciled.ok && (reconciled.lost || reconciled.removed || reconciled.docked)) {
        lines.push(stockReconcile.describeReconcile(reconciled));
      }
    }
    lines.push(
      `库存：${stock.enabled ? "开" : "关"} · 在库 ${counts.counts.stored} / 占位 ${counts.counts.reserved}`
        + ` / 在用 ${counts.counts.in_use} / 丢失 ${counts.counts.lost} · 方案 ${counts.plans}`,
      `累计：订货花掉 ${(counts.spent || 0).toLocaleString("en-US")} ISK · 卖出退回 ${(counts.refunded || 0).toLocaleString("en-US")} ISK`,
      stock.warehouse
        ? `仓库：${stock.warehouse.name}（${stock.warehouse.characterID}）@ 站 ${warehouseModule.WAREHOUSE_STATION_ID}`
        : "仓库：还没建（/crewmine stock init）",
    );
    const rows = stock.ships.filter((row) => row.state !== stockModule.STATES.lost).slice(0, 30);
    if (rows.length === 0) {
      lines.push("库存是空的：/crewmine stock buy <配装> <数量> 或 /crewmine stock deposit");
      // 账本空了但仓库机库里还有船（被旧实例覆盖/换存档）：给个能一键认领的提示。
      if (stock.enabled && stock.warehouse && stock.warehouse.characterID) {
        try {
          const inHangar = warehouseModule.hangarShips(deps, {
            characterID: stock.warehouse.characterID,
            stationID: warehouseModule.WAREHOUSE_STATION_ID,
          });
          if (inHangar.length > 0) {
            lines.push(`仓库机库里还有 ${inHangar.length} 艘船没上账：/crewmine stock reconcile adopt 可以认领回来`);
          }
        } catch (_error) {
          /* 读不到就算了 */
        }
      }
    } else {
      lines.push(...rows.map((row) => `${row.id} | ${row.name} | 船 ${row.itemID} | ${row.state}`
        + `${row.state === "in_use" ? ` @${row.characterID}` : ""}`
        + `${row.pricePaid ? ` | ${row.pricePaid.toLocaleString("en-US")} ISK` : " | 自有"}`));
    }
    lines.push("用法：stock [status|list|on|off|init|buy|deposit|withdraw|sell|migrate|reconcile|backup]");
    lines.push(`备份提醒：账本 ${stateFile} 与物品 gamestore.sqlite 要一起备份（/crewmine stock backup 先复制账本）`);
    return lines;
  }

  // ---- P2 面板：库存视图 / 多选召唤 / 方案 --------------------------------

  function stockView(options = {}) {
    const stock = stockService().read();
    const counts = stockService().stats();
    const limit = Math.min(200, Math.max(1, Math.trunc(Number(options.limit)) || 20));
    const offset = Math.max(0, Math.trunc(Number(options.offset)) || 0);
    // 搜索：按名字 / 库存ID / 船体物品ID / 状态过滤，再分页。
    const query = String(options.query || "").trim().toLowerCase();
    const rows = query
      ? stock.ships.filter((row) => {
        if (String(row.name || "").toLowerCase().includes(query)) {
          return true;
        }
        if (String(row.id || "").toLowerCase().includes(query)) {
          return true;
        }
        if (String(row.itemID || "").includes(query)) {
          return true;
        }
        const stateText = row.state === "in_use"
          ? "在用 in_use"
          : (row.state === "lost" ? "丢失 lost" : (row.state === "stored" ? "在库 stored" : String(row.state)));
        return stateText.toLowerCase().includes(query);
      })
      : stock.ships;
    let balance = null;
    try {
      const session = options.session || serviceSession;
      const characterID = Number(session && session.characterID) || 0;
      if (characterID && deps.wallet && typeof deps.wallet.getCharacterWallet === "function") {
        const wallet = deps.wallet.getCharacterWallet(characterID);
        if (wallet && Number.isFinite(Number(wallet.balance))) {
          balance = Number(wallet.balance);
        }
      }
    } catch (_error) {
      balance = null;
    }
    return {
      ok: true,
      enabled: stock.enabled,
      warehouse: stock.warehouse,
      stationID: warehouseModule.WAREHOUSE_STATION_ID,
      counts,
      total: rows.length,
      offset,
      limit,
      query,
      balance,
      spent: counts.spent,
      refunded: counts.refunded,
      ships: rows.slice(offset, offset + limit).map((row) => ({
        id: row.id,
        itemID: row.itemID,
        name: row.name,
        hullTypeID: row.hullTypeID,
        state: row.state,
        characterID: row.characterID,
        source: row.source,
        pricePaid: row.pricePaid,
        signature: row.signature,
      })),
      plans: stock.plans.map((plan) => ({
        id: plan.id,
        name: plan.name,
        count: (plan.items || []).reduce((sum, item) => sum + (Number(item.count) || 0), 0),
        items: plan.items,
      })),
    };
  }

  /** 玩家在吉他 4-4 机库里的船（面板"转入"用；标记正在驾驶的那艘）。 */
  function stockHangarView() {
    const session = resolvePlayerSession();
    const playerCharID = Number(session && (session.characterID || session.charid)) || 0;
    if (!playerCharID) {
      return {
        ok: false,
        error: "NO_SESSION",
        message: "面板还没拿到你的角色：先在游戏里动一下（或重开面板）再试",
        ships: [],
      };
    }
    const activeShipID = Number(session && session._space && session._space.shipID) || 0;
    const ships = warehouseModule.hangarShips(deps, {
      characterID: playerCharID,
      stationID: warehouseModule.WAREHOUSE_STATION_ID,
    }).map((row) => ({...row, flying: row.itemID === activeShipID}));
    return {
      ok: true,
      ships,
      activeShipID,
      stationID: warehouseModule.WAREHOUSE_STATION_ID,
      characterID: playerCharID,
    };
  }

  /** 多选召唤：按配装签名分组，每组走 spawnCrew（限定这几艘）。 */
  function stockSummonShips(ids, sessionArg) {
    // 面板可能把"还在站里"的旧会话传进来：缺 _space 就换成本账号最新的在太空会话。
    const session = sessionArg && Number(sessionArg._space && sessionArg._space.systemID) > 0
      ? sessionArg
      : (resolvePlayerSession() || sessionArg);
    const unique = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
    if (unique.length === 0) {
      return {ok: false, lines: ["没有选中任何船"]};
    }
    const groups = new Map();
    for (const id of unique) {
      const record = stockService().get(id);
      if (!record) {
        return {ok: false, lines: [`${id} 不存在`]};
      }
      if (record.state !== stockModule.STATES.stored) {
        return {ok: false, lines: [`${id} 不在库（${record.state}）`]};
      }
      const list = groups.get(record.signature) || [];
      list.push(id);
      groups.set(record.signature, list);
    }
    const bySignature = new Map(
      (configStore.get().configs || []).map((config) => [ship.blueprintSignature(config.fit), config]),
    );
    const lines = [];
    for (const [signature, groupIDs] of groups) {
      const config = bySignature.get(signature);
      if (!config) {
        return {
          ok: false,
          lines: [...lines, `有 ${groupIDs.length} 艘船的配装没有对应蓝图，先存成蓝图再召唤`],
        };
      }
      const result = spawnCrew(config.id, groupIDs.length, {session, stockIDs: groupIDs});
      lines.push(...result.lines);
      if (!result.ok) {
        return {ok: false, lines};
      }
    }
    return {ok: true, lines};
  }

  /** 方案：list / create（选中船按签名分组）/ delete / summon */
  function stockPlanAction(request = {}, session) {
    const action = String(request.action || "list").toLowerCase();
    if (action === "list") {
      return {ok: true, lines: stockService().plans().map((plan) => `${plan.id} ${plan.name}`), plans: stockService().plans()};
    }
    if (action === "create") {
      const name = String(request.name || "").trim();
      const ids = [...new Set((Array.isArray(request.ids) ? request.ids : []).map(String).filter(Boolean))];
      if (!name) {
        return {ok: false, lines: ["方案要有个名字"]};
      }
      if (ids.length === 0) {
        return {ok: false, lines: ["先选中要放进方案的船"]};
      }
      const bySignature = new Map(
        (configStore.get().configs || []).map((config) => [ship.blueprintSignature(config.fit), config]),
      );
      const groups = new Map();
      for (const id of ids) {
        const record = stockService().get(id);
        if (!record) {
          return {ok: false, lines: [`${id} 不存在`]};
        }
        const entry = groups.get(record.signature)
          || {signature: record.signature, hullTypeID: record.hullTypeID, name: "", count: 0};
        entry.count += 1;
        if (!entry.name) {
          const config = bySignature.get(record.signature);
          entry.name = config ? config.id : String(record.name || "");
        }
        groups.set(record.signature, entry);
      }
      const plan = stockService().addPlan({name, items: [...groups.values()]});
      if (!plan) {
        return {ok: false, lines: ["方案没建成（名字或船不对）"]};
      }
      return {
        ok: true,
        lines: [`方案 ${plan.id}「${plan.name}」已创建（${plan.items.reduce((sum, item) => sum + item.count, 0)} 艘）`],
        plans: stockService().plans(),
      };
    }
    if (action === "delete") {
      const removed = stockService().removePlan(request.planID || request.id);
      return removed
        ? {ok: true, lines: [`方案 ${removed.id} 已删除`], plans: stockService().plans()}
        : {ok: false, lines: ["没有这个方案"]};
    }
    if (action === "detail") {
      const plan = stockService().getPlan(request.planID || request.id);
      if (!plan) {
        return {ok: false, lines: ["没有这个方案"]};
      }
      // 每个 item 是「签名 + 数量」：列出当前在库、能对上这个方案的船。
      const ships = [];
      const shortfalls = [];
      for (const item of plan.items || []) {
        const want = Math.max(1, Number(item.count) || 1);
        const matching = stockService().list({state: stockModule.STATES.stored})
          .filter((row) => row.signature === item.signature);
        for (const row of matching.slice(0, want)) {
          ships.push({
            id: row.id,
            name: row.name,
            itemID: row.itemID,
            hullTypeID: row.hullTypeID,
            pricePaid: row.pricePaid,
            source: row.source,
            group: item.name || "",
          });
        }
        if (matching.length < want) {
          shortfalls.push(`${item.name || item.signature} 缺 ${want - matching.length} 艘`);
        }
      }
      const lines = [`方案「${plan.name}」（${plan.id}）：在库可用的船 ${ships.length} 艘`];
      if (shortfalls.length) {
        lines.push(`不够：${shortfalls.join("；")}`);
      }
      return {ok: true, lines, plan: {id: plan.id, name: plan.name, items: plan.items}, ships};
    }
    if (action === "summon") {
      const plan = stockService().getPlan(request.planID || request.id);
      if (!plan) {
        return {ok: false, lines: ["没有这个方案"]};
      }
      const picked = [];
      for (const item of plan.items || []) {
        const stored = stockService().list({state: stockModule.STATES.stored})
          .filter((row) => row.signature === item.signature);
        const want = Math.max(1, Number(item.count) || 1);
        if (stored.length < want) {
          return {
            ok: false,
            lines: [`方案「${plan.name}」需要 ${want} 艘 ${item.name || "同配装船"}，库存只有 ${stored.length} 艘`],
          };
        }
        picked.push(...stored.slice(0, want).map((row) => row.id));
      }
      const result = stockSummonShips(picked, session);
      return {ok: result.ok, lines: [`方案「${plan.name}」：`, ...result.lines], plans: stockService().plans()};
    }
    return {ok: false, lines: [`未知动作：${action}`]};
  }

  // ---- P3 配装台 ---------------------------------------------------------

  /** 目录：不带 family 出船体，带 family 出该槽位模块（可按名字过滤）。 */
  function fitCatalog(request = {}) {
    const catalog = catalogService();
    const query = String(request.query || "").trim().toLowerCase();
    const family = String(request.family || "").toLowerCase();
    // 模块族一次给全（改装件 600+、高槽 1000+），不然下拉里会缺东西。
    const limit = Math.min(4000, Math.max(1, Math.trunc(Number(request.limit)) || (family ? 2000 : 500)));
    const match = (row) => !query
      || String(row.n || "").toLowerCase().includes(query)
      || String(row.typeID) === query;
    if (family) {
      const all = catalog.modules(family).filter(match);
      return {ok: true, family, modules: all.slice(0, limit), total: all.length, version: MOD_VERSION};
    }
    const ships = catalog.ships().filter(match);
    return {ok: true, ships: ships.slice(0, limit), total: ships.length, version: MOD_VERSION};
  }

  function fitCharges(moduleTypeID) {
    return {ok: true, charges: catalogService().chargesFor(moduleTypeID)};
  }

  /** 面板请求 → 蓝图 fit 结构（createShip 用的那种）。 */
  function fitRequestToBlueprintFit(request = {}) {
    const catalog = catalogService();
    const hullTypeID = Number(request.hullTypeID) || 0;
    const hull = catalog.get(hullTypeID);
    const modules = [];
    for (const module of Array.isArray(request.modules) ? request.modules : []) {
      const typeID = Number(module && module.typeID) || 0;
      const flagID = Number(module && module.flagID) || 0;
      if (!typeID || !flagID) {
        continue;
      }
      const entry = catalog.get(typeID) || {};
      const row = {flagID, typeID, name: entry.n || "", quantity: 1};
      const chargeTypeID = Number(module && module.chargeTypeID) || 0;
      if (chargeTypeID) {
        row.charge = {
          typeID: chargeTypeID,
          name: (catalog.get(chargeTypeID) || {}).n || "",
          quantity: 1,
        };
      }
      modules.push(row);
    }
    const drones = (Array.isArray(request.drones) ? request.drones : [])
      .map((drone) => ({
        typeID: Number(drone && drone.typeID) || 0,
        quantity: Math.max(1, Number(drone && drone.quantity) || 1),
      }))
      .filter((drone) => drone.typeID > 0)
      .map((drone) => ({...drone, name: (catalog.get(drone.typeID) || {}).n || ""}));
    return {
      source: "inline",
      hull: {typeID: hullTypeID, name: hull ? hull.n : ""},
      modules,
      drones,
      cargo: [],
    };
  }

  /** 报价 + 槽位/CPU/PG 校验（80% 卖价；无人机/弹药不计价）。
   *  allV=true（默认）：按"全技能 V"算——Electronics/Engineering +25% 输出，
   *  CPU Management / Power Grid Management -25% 需求，炮台/发射器再 -25%（Weapon Upgrades）。 */
  function fitQuote(request = {}) {
    const catalog = catalogService();
    const hullTypeID = Number(request.hullTypeID) || 0;
    const hull = catalog.get(hullTypeID);
    const problems = [];
    if (!hull || hull.f !== "hull") {
      return {ok: false, problems: ["先选船体"], items: [], total: 0, usage: null};
    }
    const allV = request.allV !== false;
    const outputScale = allV ? 1.25 : 1;
    const needScale = allV ? 0.75 : 1;
    const weaponScale = allV ? 0.5625 : 1;
    const counts = {high: 0, med: 0, low: 0, rig: 0, subsystem: 0};
    let cpu = 0;
    let pg = 0;
    let turretUsed = 0;
    let launcherUsed = 0;
    const rigGroups = new Map();
    const weapons = [];
    const priced = [{typeID: hullTypeID, name: hull.n, qty: 1, kind: "hull"}];
    for (const module of Array.isArray(request.modules) ? request.modules : []) {
      const typeID = Number(module && module.typeID) || 0;
      if (!typeID) {
        continue;
      }
      const entry = catalog.get(typeID);
      const family = ship.slotFamilyOfFlag(module && module.flagID);
      if (!entry) {
        problems.push(`未知模块 ${typeID}`);
        continue;
      }
      if (!family) {
        problems.push(`${entry.n} 槽位不合法`);
        continue;
      }
      counts[family] = (counts[family] || 0) + 1;
      const scale = entry.w ? weaponScale : needScale;
      cpu += (Number(entry.cpu) || 0) * scale;
      pg += (Number(entry.pg) || 0) * scale;
      if (entry.wt) {
        turretUsed += 1;
      }
      if (entry.wl) {
        launcherUsed += 1;
      }
      if (entry.w) {
        weapons.push({entry, chargeTypeID: Number(module && module.chargeTypeID) || 0});
      }
      if (family === "rig") {
        if (entry.rs && hull.rs && Number(entry.rs) !== Number(hull.rs)) {
          problems.push(`${entry.n} 是 ${entry.rs} 号尺寸的改装件，这艘船只能装 ${hull.rs} 号`);
        }
        const group = Number(entry.g) || 0;
        if (group > 0) {
          if (rigGroups.has(group)) {
            problems.push(`同一个改装件组只能装一个（${rigGroups.get(group)} / ${entry.n}）`);
          } else {
            rigGroups.set(group, entry.n);
          }
        }
      }
      priced.push({typeID, name: entry.n, qty: 1, kind: "module"});
    }
    // 无人机：带宽（1272 × 数量）与容量（体积 × 数量）
    let droneBandwidth = 0;
    let droneVolume = 0;
    for (const drone of Array.isArray(request.drones) ? request.drones : []) {
      const typeID = Number(drone && drone.typeID) || 0;
      const quantity = Math.max(1, Math.trunc(Number(drone && drone.quantity) || 1));
      const entry = typeID ? catalog.get(typeID) : null;
      if (!entry) {
        continue;
      }
      droneBandwidth += (Number(entry.bw) || 0) * quantity;
      droneVolume += (Number(entry.v) || 0) * quantity;
    }
    const limits = {
      high: Number(hull.hi) || 0,
      med: Number(hull.me) || 0,
      low: Number(hull.lo) || 0,
      rig: Number(hull.rig) || 0,
      cpu: Math.round((Number(hull.cpuOut) || 0) * outputScale),
      pg: Math.round((Number(hull.pgOut) || 0) * outputScale),
      turret: Number(hull.turret) || 0,
      launcher: Number(hull.launcher) || 0,
      droneBandwidth: Number(hull.db) || 0,
      droneVolume: Number(hull.dc) || 0,
    };
    for (const family of ["high", "med", "low", "rig"]) {
      if (limits[family] > 0 && counts[family] > limits[family]) {
        problems.push(`${family} 槽 ${counts[family]} > ${limits[family]}`);
      }
    }
    if (limits.cpu > 0 && cpu > limits.cpu) {
      problems.push(`CPU ${Math.round(cpu)} > ${limits.cpu}`);
    }
    if (limits.pg > 0 && pg > limits.pg) {
      problems.push(`PG ${Math.round(pg)} > ${limits.pg}`);
    }
    if (limits.turret > 0 && turretUsed > limits.turret) {
      problems.push(`炮台位 ${turretUsed} > ${limits.turret}`);
    }
    if (limits.launcher > 0 && launcherUsed > limits.launcher) {
      problems.push(`发射器位 ${launcherUsed} > ${limits.launcher}`);
    }
    if (limits.droneBandwidth > 0 && droneBandwidth > limits.droneBandwidth) {
      problems.push(`无人机带宽 ${Math.round(droneBandwidth)} > ${limits.droneBandwidth}`);
    }
    if (limits.droneVolume > 0 && droneVolume > limits.droneVolume) {
      problems.push(`无人机舱容 ${Math.round(droneVolume)} m³ > ${limits.droneVolume}`);
    }

    // 近似模拟：DPS（炮台/发射器 × 弹药伤害 / 射速）与 EHP（按船体基础抗性）。
    let dps = 0;
    for (const weapon of weapons) {
      const charge = weapon.chargeTypeID ? catalog.get(weapon.chargeTypeID) : null;
      const damage = charge && Array.isArray(charge.d) ? charge.d.reduce((sum, value) => sum + (Number(value) || 0), 0) : 0;
      const multiplier = Number(weapon.entry.dm) || 0;
      const rof = Number(weapon.entry.rof) || 0;
      if (damage > 0 && multiplier > 0 && rof > 0) {
        dps += (damage * multiplier) / (rof / 1000);
      }
    }
    let ehp = 0;
    if (hull.hp) {
      const resist = (resonances) => {
        const list = Array.isArray(resonances) && resonances.length ? resonances : [1, 1, 1, 1];
        const avg = list.reduce((sum, value) => sum + (Number(value) || 0), 0) / list.length;
        return Math.min(Math.max(1 - avg, 0.01), 1);
      };
      const shield = Number(hull.hp.s) || 0;
      const armor = Number(hull.hp.a) || 0;
      const structure = Number(hull.hp.h) || 0;
      const res = hull.res || {};
      ehp = (shield > 0 ? shield / resist(res.s) : 0)
        + (armor > 0 ? armor / resist(res.a) : 0)
        + structure;
    }

    const quote = priceService().quote(priced.map((row) => ({typeID: row.typeID, qty: row.qty})));
    return {
      ok: problems.length === 0,
      problems,
      hull: {typeID: hullTypeID, name: hull.n},
      allV,
      usage: {cpu, pg, slots: counts, limits, allV},
      stats: {
        dps: Math.round(dps * 10) / 10,
        ehp: Math.round(ehp),
        turret: {used: turretUsed, max: limits.turret},
        launcher: {used: launcherUsed, max: limits.launcher},
        drones: {
          bandwidth: Math.round(droneBandwidth * 10) / 10,
          bandwidthMax: limits.droneBandwidth,
          volume: Math.round(droneVolume * 10) / 10,
          volumeMax: limits.droneVolume,
        },
      },
      items: priced.map((row, index) => ({
        ...row,
        price: (quote.items[index] && quote.items[index].price) || 100,
        source: (quote.items[index] && quote.items[index].source) || "fallback",
      })),
      total: quote.total,
      discount: priceService().stats().discount,
    };
  }

  /** 配装台订购：校验 → 扣 80% 钱 → 给仓库造真船 → 入库（source=custom）。 */
  async function fitOrder(request = {}, session) {
    const quote = fitQuote(request);
    if (!quote.ok) {
      return {ok: false, lines: ["配装有问题：", ...quote.problems]};
    }
    const fit = fitRequestToBlueprintFit(request);
    const config = {
      id: "custom-fit",
      name: String(request.name || "自定义配装").trim() || "自定义配装",
      fit,
      behavior: configs.BEHAVIOR_DEFAULTS,
    };
    const count = Math.max(1, Math.min(20, Math.trunc(Number(request.count)) || 1));
    const rawLines = await stockBuy(config, count, session);
    const lines = Array.isArray(rawLines) ? rawLines : [String(rawLines)];
    return {ok: !lines.some((line) => /失败|不够|没建好/.test(line)), lines};
  }

  /** 把面板里拼的配装存成蓝图（configs/*.json），之后可按键买/召唤。 */
  function fitSave(request = {}) {
    const id = configs.slugify(String(request.id || request.name || "").trim());
    if (!id) {
      return {ok: false, lines: ["配装要有个 id 或名字"]};
    }
    const fit = fitRequestToBlueprintFit(request);
    const raw = {
      id,
      name: String(request.name || id).trim() || id,
      count: 1,
      job: "mining",
      skills: "all",
      fit,
      behavior: {...configs.BEHAVIOR_DEFAULTS},
    };
    const validated = configs.validateConfig(raw, {sde});
    if (!validated.config || validated.problems.length > 0) {
      return {ok: false, lines: ["存不了：", ...validated.problems]};
    }
    const file = path.join(configsDir, `${id}.json`);
    try {
      fs.writeFileSync(file, `${JSON.stringify(validated.config, null, 2)}\n`, "utf8");
      configStore.reload();
    } catch (error) {
      return {ok: false, lines: [`写盘失败：${error && error.message}`]};
    }
    return {ok: true, lines: [`已存为蓝图：${id}（${file}）`], id};
  }

  function handleText(argumentText, context = {}) {
    try {
      const liveSession = context && context.session ? context.session : null;
      const hasSummoned = (stateStore.get().pool || []).some((entry) => entry.summoned === true);
      if (liveSession && hasSummoned) {
        autoStartServiceLoop(liveSession);
      }
    } catch (_error) {
      /* never block a command on this */
    }
    log(`[cmd] handleText "${String(argumentText).slice(0, 120)}"`);
    const text = String(argumentText == null ? "" : argumentText).trim();
    if (!text || text === "help") {
      return USAGE;
    }
    const [command, ...rest] = text.split(/\s+/);
    const lower = command.toLowerCase();
    if (lower === "check") {
      return checkReport().lines.join("\n");
    }
    if (lower === "price") {
      return priceReport(rest).join("\n");
    }
    if (lower === "catalog") {
      return catalogReport(rest).join("\n");
    }
    if (lower === "stock") {
const stockOut = stockReport(rest, context);
      // 订货/卖出要等钱包（process 模式下只能异步扣款）：返回 Promise，由聊天入口 await。
      return stockOut && typeof stockOut.then === "function"
        ? stockOut.then((lines) => lines.join("\n"))
        : stockOut.join("\n");
    }
    if (lower === "list") {
      return listFittings(rest[0]).join("\n");
    }
    if (lower === "import") {
      const file = rest[0];
      const quoted = /^"([^"]+)"|^'([^']+)'/.exec(rest.slice(1).join(" "));
      const name = quoted ? (quoted[1] || quoted[2]) : rest[1];
      const id = flagValue(rest, "--id");
      const count = flagValue(rest, "--count");
      return importFitting(file, name, {id, count}).lines.join("\n");
    }
    if (lower === "config") {
      // Reload blueprint files first: editing behavior (propulsion, thresholds, syncWarp)
      // must take effect without restarting the server.
      try {
        configStore.reload();
      } catch (_error) {
        /* keep the previous configs */
      }
      return describe().join("\n");
    }
    if (lower === "syncwarp") {
      // 跟队跃迁开关（runtime 级，不再是“只读 configs[0]”）。
      const action = (rest[0] || "").toLowerCase();
      if (action !== "on" && action !== "off") {
        const current = syncWarpOn();
        return [
          `船员跟队跃迁：当前 ${current ? "已启用" : "已关闭"}`,
          "用法：/crewmine syncwarp on   |   /crewmine syncwarp off",
          "说明：启用后你按跃迁，船员同一拍开始对准（各自按自己的船体转），落地各自到编队点。",
        ].join("\n");
      }
      const enabled = action === "on";
      syncWarpOverride = enabled;
      let savedTo = 0;
      try {
        savedTo = behaviorWriter.persist("syncWarp", enabled).written;
      } catch (error) {
        // 开关本身已经生效，写盘失败只影响重启后是否保持。
        log(`[cmd] syncWarp 写盘失败 ${error && error.message}`);
      }
      log(`[cmd] syncWarp=${enabled}`);
      return [
        `船员跟队跃迁已${enabled ? "启用" : "关闭"}（写入 ${savedTo} 份蓝图）`,
        enabled
          ? "之后你跃迁时船员同刻开始对准；跳跃中/落地后都保持可见。"
          : "船员不再跟随你的跃迁。",
      ].join("\n");
    }
    if (lower === "formation") {
      // 阵型有三档：跟随 / 阶梯 / 环形。**停船不在阵型里**（见 /crewmine halt）。
      const action = String(rest[0] || "").toLowerCase();
      const label = (mode) => (mode === "ring"
        ? "环形（同一圈 + 自写刹车）"
        : (mode === "follow" ? "跟随（全部同一间距）" : "阶梯（依次外扩）"));
      const shortName = (mode) => (mode === "ring" ? "环形" : (mode === "follow" ? "跟随" : "阶梯"));
      if (action === "stop") {
        return [
          "停船已从阵型里独立出来，改用命令：/crewmine halt [名字]",
          `当前阵型：${label(followFormationMode())}（船不会因为这条命令动）`,
        ].join("\n");
      }
      if (!behaviorConfig.isFormation(action)) {
        const gap = followSurfaceGap();
        return [
          `跟随阵型：${followFormationMode()}（${label(followFormationMode())}）`,
          `表面间距：${gap === null ? "未设置（不会移动）" : `${gap} m`} · 阶梯步长：${crewSpacingMeters()} m`,
          "用法：/crewmine formation follow | ladder | ring",
          "      follow  = 跟随：所有船和你保持同一个间距（不递增）",
          "      ladder  = 阶梯：第 n 艘 = 间距 + (n-1) × 步长",
          "      ring    = 环形：都在同一圈上，250 ms 闭环刹车",
          "      /crewmine follow <米>   设表面间距（-1 = 清空）",
          "      /crewmine spacing <米>  设阶梯步长（只对阶梯生效）",
          "      /crewmine halt [名字]   停船（独立命令）",
          "说明：环形需要间距 > 0；人多时会自动把圈放大。停船 / 采矿 / 追击 / 堡垒 / 跃迁 各自独立。",
        ].join("\n");
      }
      setFollowState({mode: action});
      log(`[cmd] followMode=${action}`);
      const gap = followSurfaceGap();
      // modeReady 已经覆盖"环形要 > 0、跟随/阶梯要 >= 0、idle 永远不动"三套口径。
      if (!followStateModule.modeReady(followState)) {
        const need = action === "ring" ? "（需 > 0）" : "";
        return `跟随阵型：${shortName(action)} —— 但缺少间距（当前 ${gap === null ? "未设置" : gap + " m"}），`
          + `船员会保持静止。先 /crewmine follow <米>${need}。`;
      }
      if (action === "ring") {
        return `跟随阵型：环形（间距 ${gap} m，250 ms 闭环；会有轻微抖动）`;
      }
      if (action === "follow") {
        return `跟随阵型：跟随（全部保持 ${gap} m；每艘递增 ${crewSpacingMeters()} m 不参与）`;
      }
      return `跟随阵型：阶梯（基准 ${gap} m，每艘 +${crewSpacingMeters()} m，引擎 FOLLOW）`;
    }
    if (lower === "follow") {
      // 设表面间距（米）。-1 / 空 = 清空（之后跟随/阶梯/环形都不动）。
      const raw = String(rest[0] || "").trim();
      if (!raw) {
        const gap = followSurfaceGap();
        return `表面间距：${gap === null ? "未设置（不会移动）" : `${gap} m`}`
          + ` · 阶梯步长 ${crewSpacingMeters()} m · 阵型 ${followFormationMode()}`;
      }
      const gap = followStateModule.normalizeGap(raw);
      setFollowState({gap});
      log(`[cmd] followGap=${gap}`);
      if (gap < 0) {
        return "表面间距已清空（-1）→ 跟随 / 阶梯 / 环形都不会移动（船保持原位）。";
      }
      const mode = followFormationMode();
      const purpose = mode === "ring" ? "环形半径" : (mode === "follow" ? "跟随距离" : "阶梯基准");
      return `表面间距 = ${gap} m（${purpose}）`;
    }
    if (lower === "spacing") {
      const raw = String(rest[0] || "").trim();
      if (!raw) {
        return `阶梯步长：${crewSpacingMeters()} m（相邻两艘的表面差）`;
      }
      const spacing = followStateModule.normalizeSpacing(raw);
      setFollowState({spacing});
      log(`[cmd] ladderSpacing=${spacing}`);
      return `阶梯步长 = ${spacing} m（第 n 艘 = 基准 ${followSurfaceGap() === null ? "?" : followSurfaceGap()} + (n-1)×${spacing}）`;
    }
    if (lower === "halt") {
      const selector = rest.join(" ").trim() || "all";
      const result = haltCrew(selector, context);
      return result.lines.join("\n");
    }    if (lower === "ui") {
      // Open the browser control panel (the in-game UI is shelved).
      try {
        // PR-4: the panel is per-account, so the URL carries this account's token.
        const panelAddress = require(path.join(__dirname, "nfCrewMiningWeb.js")).address();
        const base = `http://${panelAddress.host}:${panelAddress.port}/`;
        const url = options.panelToken ? `${base}?token=${encodeURIComponent(options.panelToken)}` : base;
        const {spawn} = require("node:child_process");
        const command = process.platform === "win32"
          ? {cmd: "cmd", args: ["/c", "start", "", url]}
          : process.platform === "darwin"
            ? {cmd: "open", args: [url]}
            : {cmd: "xdg-open", args: [url]};
        const child = spawn(command.cmd, command.args, {detached: true, stdio: "ignore"});
        if (typeof child.unref === "function") {
          child.unref();
        }
        log(`[web] 已按指令打开控制面板 ${url}`);
        return `已在浏览器打开控制面板：${url}`;
      } catch (error) {
        log(`[web] 打开控制面板失败 ${error && error.message}`);
        return `打开失败：${error && error.message}（可手动访问 ${base}）`;
      }
    }
    if (lower === "status") {
      // Data feed for the client window (client/menu.py). "json" is machine-readable.
      const payload = buildStatusPayload(context && context.session ? context.session : null);
      if ((rest[0] || "").toLowerCase() === "json") {
        return JSON.stringify(payload);
      }
      const lines = [`船员 ${payload.entries.length} 名`];
      lines.push(payload.fullAuthority
        ? "开火授权：全权开火（自由开火 + 末日武器自动发射）"
        : (payload.freeFire ? "开火授权：自由开火（末日需手动）" : "开火授权：未开启"));
      if (payload.lockBlacklist > 0) {
        lines.push(`锁不上黑名单：${payload.lockBlacklist} 条（${Math.round(BLACKLIST_TTL_MS / 1000)} 秒后自动解除）`);
      }
      if (payload.grudge > 0) {
        lines.push(`仇人名单：${payload.grudge} 人 · ${payload.grudgeCorps} 个军团` +
          `（${Math.round(GRUDGE_TTL_MS / 1000)} 秒后失效；名单里的人不需要宣战关系也能打）`);
      }
      if (payload.siege && payload.siege.available > 0) {
        lines.push(`会战/堡垒：${payload.siege.available} 人有模块 · ${payload.siege.active} 人已开启` +
          "（/crewmine siege on|off；面板每行与详情里也有开关）");
      }
      for (const entry of payload.entries) {
        lines.push(
          `${entry.name} · ${entry.mode} · 矿舱 ${entry.used}/${entry.capacity} m³` +
          ` · 压缩${entry.compress ? "可用" : "不可用"}`,
        );
      }
      return lines.join("\n");
    }
    if (lower === "pool") {
      const action = (rest[0] || "list").toLowerCase();
      if (action === "list") {
        return poolList().join("\n");
      }
      if (action === "scan") {
        return poolScan().lines.join("\n");
      }
      if (action === "adopt") {
        return poolAdopt(rest[1], rest[2]).lines.join("\n");
      }
      if (action === "clear") {
        return poolClear(rest[1] === "confirm").lines.join("\n");
      }
      return "用法：/crewmine pool list | scan | adopt <角色ID> | clear confirm";
    }
    if (lower === "spawn") {
      return spawnCrew(rest[0], Number(rest[1]) || 0, context).lines.join("\n");
    }
    if (lower === "mine") {
      // Crew names can contain spaces: the selector is the whole remainder.
      const selector = rest.join(" ").trim() || "all";
      const tokens = selector.split(/\s+/);
      if (tokens.length > 1 && String(tokens[tokens.length - 1]).toLowerCase() === "off") {
        return stopMiningCrew(tokens.slice(0, -1).join(" ") || "all", context).lines.join("\n");
      }
      return mineCrew(selector, context).lines.join("\n");
    }
    if (lower === "deliver") {
      return deliverCrew(rest.join(" ").trim() || "all", context).lines.join("\n");
    }
    if (lower === "aggrodebug") {
      return aggroDebug(rest.join(" ").trim() || "all", context).join("\n");
    }
    if (lower === "rebuild") {
      return rebuildCrew(rest.join(" ").trim() || "all", context).lines.join("\n");
    }
    if (lower === "recall") {
      return recallCrew(rest.join(" ").trim() || "all", context).lines.join("\n");
    }
    if (lower === "disband") {
      // Crew names can contain spaces ("Lena Marek"), so the confirm flag is stripped from
      // the END and everything before it is the selector.
      const tokens = rest.slice();
      let confirmFlag = false;
      if (tokens.length > 0 && String(tokens[tokens.length - 1]).toLowerCase() === "confirm") {
        confirmFlag = true;
        tokens.pop();
      }
      const selector = tokens.join(" ").trim() || "all";
      return disbandCrew(selector, confirmFlag, context).lines.join("\n");
    }
    if (lower === "corp" || lower === "corporation") {
      const action = (rest[0] || "sync").toLowerCase();
      if (action === "sync") {
        return corporationSync(context).lines.join("\n");
      }
      return "用法：/crewmine corp sync";
    }
    if (lower === "fleet") {
      const action = (rest[0] || "join").toLowerCase();
      if (action === "join") {
        return fleetJoinCrew(rest[1] || "all", context).lines.join("\n");
      }
      return "用法：/crewmine fleet join all|<名字>";
    }
    if (lower === "debug") {
      const arg = String(rest[0] || "").toLowerCase();
      if (arg === "on" || arg === "off") {
        debugMode = arg === "on";
        loggingDebug = debugMode;
        log(`[debug] 调试日志 ${debugMode ? "开启" : "关闭"}`);
        return debugMode
          ? "调试日志已开启：会额外输出装备“为什么不启用”的原因（不改变任何行为）。"
          : "调试日志已关闭：只记录装备状态变化。";
      }
      return debugCrew(rest.join(" ").trim() || "all", context).lines.join("\n");
    }
    if (lower === "refresh") {
      // Ships spawned before the derived-state fix carry the bare hull's numbers: their
      // armor plates, rigs and passive hardeners never reached the entity. Re-run the
      // engine's ship modelling for the selected crews. Costly (~0.5-1.1 s per ship,
      // that is why it is a manual command and never a per-tick job).
      const session = context && context.session ? context.session : null;
      const scene = follow.sceneFor(deps, session);
      if (!scene) {
        return "请在太空里刷新（当前没有所在星系）";
      }
      const selected = selectMembers(rest.join(" ").trim() || "all", context);
      if (selected.members.length === 0) {
        return "本星系没有在役船员" + (selected.skipped > 0 ? `（另有 ${selected.skipped} 人在别处）` : "");
      }
      const lines = [];
      for (const member of selected.members) {
        const refreshed = ship.ensureEntity(deps, {
          shipID: member.shipID,
          characterID: member.characterID,
          systemID: Number(scene.systemID) || 0,
          sceneDescriptor: scene.sceneDescriptor,
          scene,
          session,
        });
        // S3/R5: /crewmine refresh is the manual cure for old hulls. Re-running the
        // engine's derived state wipes the doomsday attributes, so they are re-stamped
        // (force: the client must also be told again).
        const refreshedEntity = refreshed.entity
          || (scene && typeof scene.getEntityByID === "function" ? scene.getEntityByID(member.shipID) : null);
        const doomsday = applyDoomsdayPresence(scene, member, refreshedEntity, {force: true});
        if (refreshed.derived) {
          lines.push(`${member.name}：已按装配重算（装甲/护盾/电容/质量）${doomsday ? " · 末日舱门已补" : ""}`);
        } else {
          const reason = (refreshed.warnings || []).join(" ") || refreshed.reason || "NO_ENTITY";
          lines.push(`${member.name}：未重算（${reason}）`);
        }
      }
      return lines.join("\n");
    }
    if (lower === "modules") {
      // Manual pass: runs the same defence/propulsion management the tick uses, so its
      // log lines can be read on demand instead of waiting for a state change.
      const session = context && context.session ? context.session : null;
      const scene = follow.sceneFor(deps, session);
      const selected = selectMembers(rest.join(" ").trim() || "all", context);
      if (selected.members.length === 0) {
        return "本星系没有在役船员" + (selected.skipped > 0 ? `（另有 ${selected.skipped} 人在别处）` : "");
      }
      const lines = [];
      for (const member of selected.members) {
        const entity = scene && typeof scene.getEntityByID === "function" ? scene.getEntityByID(member.shipID) : null;
        if (!entity) {
          lines.push(`${member.name}：船不在场景里`);
          continue;
        }
        const modules = defenseModulesFor(member);
        if (modules.length === 0) {
          lines.push(`${member.name}：没有可管理的装备（增强器/注电器/回充器/推进器）`);
          continue;
        }
        const result = runDefenseFor(scene, session, member, entity);
        logCrewBehavior(scene, session, member, entity);
        const running = runningModuleCount(entity);
        lines.push(`${member.name}：管理 ${modules.length} 件，运行中 ${running} 件` +
          (result && result.errors.length ? `，失败 ${result.errors.join(" · ")}` : ""));
      }
      return lines.join("\n");
    }
    if (lower === "special" || lower === "siege" || lower === "bastion" || lower === "堡垒" || lower === "会战") {
      // PLAN §18.4：`/crewmine special <名字|all> <bastion|siege|doomsday> on|off`
      // `siege`/`堡垒` 等是等价别名；旧的词序 `siege on|off [选择器]` 也继续可用。
      const first = String(rest[0] || "").toLowerCase();
      if (lower !== "special" && (first === "on" || first === "off")) {
        const on = first === "on";
        const selector = rest.slice(1).join(" ").trim() || "all";
        if (selector.toLowerCase() === "all") {
          return setAllSpecial("all", on, context).message;
        }
        return specialTargets(selector)
          .map((entry) => setSpecial(entry.characterID, "all", on, context).message)
          .join("\n") || `没找到在役船员：${selector}`;
      }
      const tokens = rest.slice();
      const action = String(tokens.pop() || "").toLowerCase();
      if (action !== "on" && action !== "off") {
        return specialReport();
      }
      const on = action === "on";
      const kind = normalizeSpecialKind(tokens.pop());
      if (!kind) {
        const selector = tokens.join(" ").trim();
        return `用法：/crewmine special <名字|all> <bastion|siege|doomsday> on|off\n` +
          `（也可以：/crewmine special ${selector ? `${selector} ` : ""}on|off —— 切这艘船装的那种）`;
      }
      if (kind === "doomsday") {
        if (!on) {
          return "末日武器是一次性的，没有常开状态；用 `/crewmine doomsday` 或面板上的「发射」";
        }
        const targets = specialTargets(tokens.join(" ").trim() || "all");
        if (targets.length === 0) {
          return "没有在役船员";
        }
        const lines = [];
        const scene = follow.sceneFor(deps, context && context.session ? context.session : null);
        for (const entry of targets) {
          const entity = scene && typeof scene.getEntityByID === "function" ? scene.getEntityByID(entry.shipID) : null;
          if (!entity) {
            lines.push(`${entry.name}：船不在场景里`);
            continue;
          }
          lines.push(fireDoomsdayFor(scene, entry, entity).line);
        }
        return lines.join("\n");
      }
      const selector = tokens.join(" ").trim() || "all";
      if (selector.toLowerCase() === "all") {
        return setAllSpecial(kind, on, context).message;
      }
      const targets = specialTargets(selector);
      if (targets.length === 0) {
        return `没找到在役船员：${selector}`;
      }
      return targets.map((entry) => setSpecial(entry.characterID, kind, on, context).message).join("\n");
    }
    if (lower === "doomsday") {
      // Plan B: no fuel, no capacitor — cooldown only.
      const session = context && context.session ? context.session : null;
      const scene = follow.sceneFor(deps, session);
      const selected = selectMembers(rest.join(" ").trim() || "all", context);
      if (selected.members.length === 0) {
        return "本星系没有在役船员";
      }
      const lines = [];
      for (const member of selected.members) {
        const entity = scene && typeof scene.getEntityByID === "function" ? scene.getEntityByID(member.shipID) : null;
        if (!entity) {
          lines.push(`${member.name}：船不在场景里`);
          continue;
        }
        lines.push(fireDoomsdayFor(scene, member, entity).line);
      }
      return lines.join("\n");
    }
    if (lower === "attack") {
      // Free fire: the crew picks hostile NPC ships around itself.
      // "full" additionally authorises the doomsday weapons: the crew fires them on
      // its own once the per-ship cooldown is up, instead of waiting for a command.
      const arg = String(rest[0] || "all").toLowerCase();
      if (ENGAGEMENT_RULES.has(arg)) {
        engagementRule = arg;
        log(`[combat] 交战规则 = ${engagementRule}`);
        if (arg === "npc") {
          return "交战规则：只打原生 NPC（默认，绝不会误伤玩家）";
        }
        if (arg === "war") {
          return "交战规则：NPC + 与我们宣战的角色（warRuntimeState 判定，需引擎侧存在有效战争）";
        }
        return "交战规则：NPC + 宣战目标（defend 与 war 同源：引擎不记录「谁打了我」，无法仅凭挨打就还手）";
      }
      if (arg === "off") {
        freeFire = false;
        fullAuthority = false;
        log("[combat] 自由开火与末日授权已关闭");
        return "自由开火已关闭（末日自动发射一并停止）";
      }
      const full = arg === "full";
      freeFire = true;
      fullAuthority = full;
      combatPausedTarget = 0;
      log(`[combat] 自由开火已开启${full ? "（全权：含末日武器自动发射）" : ""}`);
      return full
        ? "全权开火已开启：船员会自行锁定敌对 NPC 开火，并在末日武器冷却结束时自行发射（/crewmine attack off 收回）"
        : "自由开火已开启：船员会自动锁定附近的敌对 NPC 并开火（/crewmine stop all 停火）";
    }
    if (lower === "focus") {
      // 火力集中：打开后不再按 3 艘/拍轮转（本拍所有冷却好的船一起结算）。
      // 面板「火力集中」按钮走的就是这条命令。
      const arg = String(rest[0] || "").toLowerCase();
      const cap = Math.max(
        1000,
        Number(configs_behavior().focusFireMaxTickMs) || FOCUS_FIRE_DEFAULT_CAP_MS,
      );
      const budget = Math.max(1, Math.round(Number(configs_behavior().combatSalvoBudgetPerTick) || 3));
      if (arg === "off") {
        focusFire = false;
        log("[combat] 火力集中已关闭（恢复齐射轮转）");
        return `火力集中已关闭：恢复每拍 ${budget} 艘的齐射轮转。`;
      }
      if (arg === "on") {
        focusFire = true;
        const count = (stateStore.get().pool || []).filter((entry) => entry.summoned === true).length;
        log(`[combat] 火力集中已开启：本拍结算全部在役船（${count} 艘），安全阀 ${cap} ms`);
        const worst = count > 0 ? Math.round(count * 0.6) : 0;
        return [
          `火力集中已开启：本拍结算全部冷却好的船（在役 ${count} 艘），不再按 ${budget} 艘/拍轮转。`,
          `单拍安全阀 ${cap} ms：一拍内累计结算超过它就顺延到下一拍（防止服务器被一拍拍死）。`,
          count > budget
            ? `⚠️ 每艘约 0.5–0.6 s，最坏这一拍约 ${worst} s —— 人越多越卡，建议先拿小队试。`
            : "",
          "关闭：/crewmine focus off，或面板「火力集中」按钮。",
        ].filter(Boolean).join("\n");
      }
      return `火力集中：${focusFire ? "开（本拍结算全部船）" : `关（每拍 ${budget} 艘轮转）`}`
        + ` · 单拍安全阀 ${cap} ms\n用法：/crewmine focus on | off`;
    }
    if (lower === "stop") {
      return stopCrew(rest.join(" ").trim() || "all", context).lines.join("\n");
    }
    return `未知子命令：${command}\n${USAGE}`;
  }

  // Start the client-UI push timer with the runtime itself: a first-time player must get
  // the Neocom button on login, without typing any command.

  /**
   * 删除一个蓝图（configs/<file>.json）。
   * 有船员正在用这个蓝图时**拒绝**（先解散再删，避免池里的记录指向不存在的蓝图）。
   */
  function deletePreset(request = {}) {
    ensureConfigsLoaded();
    const wanted = String((request && (request.id || request.blueprintID)) || "").trim();
    if (!wanted) {
      return {ok: false, error: "BAD_ID"};
    }
    const all = (configStore.get().configs || []);
    const config = all.find((entry) => String(entry.id) === wanted);
    if (!config) {
      return {ok: false, error: "NOT_FOUND", message: `没有这个蓝图：${wanted}`};
    }
    const users = (stateStore.get().pool || [])
      .filter((entry) => String(entry.blueprintID) === wanted && entry.summoned === true)
      .map((entry) => String(entry.name || entry.characterID));
    if (users.length > 0 && request.force !== true) {
      return {
        ok: false,
        error: "IN_USE",
        users,
        message: `还有 ${users.length} 名船员在用这个蓝图（${users.slice(0, 3).join("、")}），先解散他们再删`,
      };
    }
    const fileName = String(config.file || `${wanted}.json`);
    const fullPath = path.join(configsDir, fileName);
    // 只允许删 configs 目录里的 .json，别被 ../ 之类的路径骗了。
    if (path.dirname(path.resolve(fullPath)) !== path.resolve(configsDir)
      || !fileName.toLowerCase().endsWith(".json")) {
      return {ok: false, error: "BAD_PATH", message: `拒绝删除：${fileName}`};
    }
    try {
      fs.unlinkSync(fullPath);
    } catch (error) {
      return {ok: false, error: "DELETE_FAILED", message: String(error && error.message)};
    }
    configStore.reload();
    log(`[config] 删除蓝图 ${wanted}（${fileName}）`);
    return {ok: true, id: wanted, file: fileName, message: `已删除蓝图：${wanted}`};
  }

  // Browser control panel (127.0.0.1:8741): replaces the shelved in-game UI and reuses
  // the same status payload and command handler.
  try {
    const webUi = require(path.join(__dirname, "nfCrewMiningWeb.js"));
    // PR-4: one panel server, one binding per account. The token is what tells two
    // players apart; a request without a matching token never reaches a runtime.
    webUi.start({
      tenant: {accountID: tenantAccountID, crewAccountID: crewAccount()},
      token: String(options.panelToken || ""),
      log,
      callbacks: {
      crewLogFile: deps.crewLogFile,
      crewDetail: (characterID) => buildCrewDetail(characterID),
      setMode: (request) => applyModeRequest(request),
      // PLAN §18.4：特殊装备开关（堡垒 / 会战 / 末日）。
      setSpecial: (request) => applySpecialRequest(request),
      setDebug: (on) => { debugMode = on === true; loggingDebug = debugMode; rawLog(`[debug] 调试日志 ${debugMode ? "开启" : "关闭"}（面板）`); return debugMode; },
      // 蓝图删除（面板「删除蓝图」按钮）。
      deletePreset: (request) => deletePreset(request),
      // 追击开关 + 手动返回环绕。
      setChase: (on) => behaviorWriter.setGlobalBehaviorFlag("chaseOutOfRange", on === true),
      returnOrbit: () => returnToOrbit(),
      log,
      getStatus: () => buildStatusPayload(serviceSession),
      runCommand: (text, session) => handleText(text, session ? {session} : {}),
      // P2 面板「召唤仓库」：和命令共用同一套内部函数。
      stockView: (options) => stockView(options || {}),
      stockBuy: async (request) => {
        const blueprintID = String((request && request.blueprintID) || "").trim();
        const config = configForBlueprint(blueprintID);
        if (!config) {
          return {ok: false, lines: [`没有这条配装：${blueprintID}`]};
        }
        const count = Math.max(1, Math.trunc(Number(request && request.count)) || 1);
        const raw = await stockBuy(config, count, resolvePlayerSession());
        // 兜底：万一 stockBuy 返回的不是数组（旧调用方/异常路径），也不要抛 lines.some。
        const lines = Array.isArray(raw) ? raw : [String(raw)];
        return {ok: !lines.some((line) => /失败|不够|没建好/.test(line)), lines};
      },
      stockDeposit: (request) => ({
        ok: true,
        lines: stockDeposit(resolvePlayerSession(), (request && request.ids) || []),
      }),
      stockWithdraw: (request) => ({
        ok: true,
        lines: stockWithdraw((request && request.ids) || [], resolvePlayerSession()),
      }),
      stockSell: (request) => ({
        ok: true,
        lines: stockSell((request && request.ids) || [], resolvePlayerSession()),
      }),
      stockRebuy: async (request) => {
        const id = String((request && request.id) || "").trim();
        if (!id) {
          return {ok: false, lines: ["没给库存 ID"]};
        }
        const raw = await stockRebuy(id, resolvePlayerSession());
        const lines = Array.isArray(raw) ? raw : [String(raw)];
        return {ok: !lines.some((line) => /失败|不够|没建好|没法|不是「已丢失」/.test(line)), lines};
      },
      stockSummon: (request) => stockSummonShips((request && request.ids) || [], resolvePlayerSession()),
      stockPlan: (request) => stockPlanAction(request || {}, resolvePlayerSession()),
      stockReconcile: (request) => ({
        ok: true,
        lines: [stockReconcile.describeReconcile(reconcileStockLedger({adopt: Boolean(request && request.adopt)}))],
      }),
      stockHangar: () => stockHangarView(),
      // P3 配装台
      fitCatalog: (request) => fitCatalog(request || {}),
      fitCharges: (moduleTypeID) => fitCharges(moduleTypeID),
      fitQuote: (request) => fitQuote(request || {}),
      fitOrder: (request) => fitOrder(request || {}, resolvePlayerSession()),
      fitSave: (request) => fitSave(request || {}),
      // Server-side saved fittings: exactly what the in-game fitting window lists.
      listFittings: () => {
        const out = [];
        try {
          const characterID = resolveFittingOwnerID();
          const store = deps.fittingStore;
          if (store && typeof store.getOwnerFittings === "function" && characterID > 0) {
            const result = store.getOwnerFittings(characterID);
            const map = result && (result.fittings || result.data || result);
            const list = map && typeof map === "object" ? Object.values(map) : [];
            for (const fit of list) {
              if (!fit) {
                continue;
              }
              out.push({
                id: Number(fit.fittingID || fit.id) || 0,
                name: String(fit.name || fit.fittingName || ""),
                shipTypeID: Number(fit.shipTypeID || fit.typeID) || 0,
                slots: Array.isArray(fit.fitData) ? fit.fitData.length : 0,
                source: "server",
              });
            }
          }
        } catch (error) {
          log(`[fittings] 读取服务端装配失败 ${error && error.message}`);
        }
        ensureConfigsLoaded();
        return {fittings: out, blueprints: (configStore.get().configs || []).map((c) => c.id)};
      },
      importFitting: (file, id, options) => importFitting(file, id, options || {}),
      importServerFitting: (fittingID, id, options) => importServerFitting(fittingID, id, {...(options || {}), characterID: Number(serviceSession && (serviceSession.characterID || serviceSession.charid)) || 0}),
      sessionOf: () => {
        if (serviceSession) {
          return serviceSession;
        }
        try {
          // PR-2: never hand the panel another player's session.
          const scoped = tenantSessions();
          if (scoped) {
            return scoped.length > 0 ? scoped[0] : null;
          }
          const registry = deps.sessionRegistry;
          const list = registry && typeof registry.getSessions === "function" ? registry.getSessions() : [];
          return list && list.length > 0 ? list[0] : null;
        } catch (_error) {
          return null;
        }
      },
      },
    });
  } catch (error) {
    log(`[web] 控制面板启动失败 ${error && error.message}`);
  }

  /**
   * P1 master switch per crew ship: a per-ship override in the state file wins, then the
   * blueprint's behavior.npcMode, then the global default (false).
   */
  /**
   * Write a behavior flag into every blueprint config file, then reload. Used by the panel
   * switches (weaponSalvo / npcMode); the global default object itself is frozen at boot.
   */
  /**
   * 面板写跟随三件套（0.6.8）：**只改 followState**，不碰蓝图。
   * 非法值一律拒绝（返回 ok:false），不静默写成默认值。
   *   followFormation   —— 只接受 idle / follow / ladder / ring（"stop" 已从阵型移除，请用 /crewmine halt）
   *   followDistance    —— -1 = 清空；其余 0..5000
   *   crewSpacingMeters —— 0..5000（只对阶梯生效）
   */
  const FOLLOW_FIELDS = new Set(["followFormation", "followDistance", "crewSpacingMeters"]);
  function applyFollowField(field, rawValue) {
    if (field === "followFormation") {
      const text = String(rawValue == null ? "" : rawValue).trim().toLowerCase();
      if (text === "stop") {
        return {ok: false, error: "STOP_IS_NOT_A_FORMATION", hint: "停船请用 /crewmine halt"};
      }
      // 面板的「阵型」下拉含 `idle`（静止），命令层只有 follow/ladder/ring —— 两者都接受。
      if (text !== "idle" && !behaviorConfig.isFormation(text)) {
        return {ok: false, error: "BAD_VALUE"};
      }
      setFollowState({mode: text});
      log(`[web] followMode=${text}`);
      return {ok: true, field, value: text};
    }
    const numeric = Number(rawValue);
    if (rawValue === null || rawValue === undefined || String(rawValue).trim() === ""
      || !Number.isFinite(numeric)) {
      return {ok: false, error: "BAD_VALUE"};
    }
    if (field === "followDistance") {
      const gap = followStateModule.normalizeGap(numeric);
      setFollowState({gap});
      log(`[web] followGap=${gap}`);
      return {ok: true, field, value: gap};
    }
    const spacing = followStateModule.normalizeSpacing(numeric);
    setFollowState({spacing});
    log(`[web] ladderSpacing=${spacing}`);
    return {ok: true, field, value: spacing};
  }

  /** One entry point for the panel: global flag or per-crew npcMode. */
  function applyModeRequest(body) {
    const request = body || {};
    const field = String(request.field || "");
    const value = request.value === true || request.value === "true";
    if (request.characterID) {
      if (field === "doomsday") {
        return fireDoomsdayForCrew(request.characterID);
      }
      // 旧面板的兼容入口：field:"siege" 等价 /api/special 的单人开关。
      if (field === "siege" || field === "mode") {
        return applySpecialRequest({characterID: request.characterID, module: "all", on: value});
      }
      if (field !== "npcMode") {
        return {ok: false, error: "PER_CREW_ONLY_NPCMODE"};
      }
      return setCrewNpcMode(request.characterID, value);
    }
    // 0.6.8：跟随三件套只写 followState（蓝图不再驱动行为，也不再被改写）。
    if (FOLLOW_FIELDS.has(field)) {
      return applyFollowField(field, request.value);
    }
    if (field === "siegeAll" || field === "modeAll") {
      return setAllSpecial("all", value);
    }
    // 注意：这里必须把原始值传下去。以前只传 `value === true || value === "true"`，
    // 于是字符串（followFormation:"ring"）和数字（crewSpacingMeters:150）全都变成
    // false —— 阵型永远写不进去、间距被写成 0。类型转换统一放进 setGlobalBehaviorFlag。
    return behaviorWriter.setGlobalBehaviorFlag(field, request.value);
  }

  /**
   * PLAN §18.4 的 `POST /api/special {characterID, module, on}`。
   * `module` 接受 bastion / siege / doomsday / all；`characterID` 可省略，表示全体。
   */
  function applySpecialRequest(body) {
    const request = body || {};
    const rawModule = String(request.module || request.kind || "").trim();
    if (!rawModule) {
      return {ok: false, error: "BAD_MODULE", message: "要指定 module：bastion / siege / doomsday / all"};
    }
    const kind = normalizeSpecialKind(rawModule);
    const on = request.on === true || request.on === "true" || request.value === true;
    if (!kind) {
      return {ok: false, error: "BAD_MODULE", message: `未知的特殊装备：${request.module}`};
    }
    const characterID = Number(request.characterID) || 0;
    if (!characterID) {
      if (kind === "doomsday") {
        return {ok: false, error: "DOOMSDAY_NEEDS_CREW", message: "末日武器要指定船员"};
      }
      return setAllSpecial(kind, on);
    }
    if (kind === "doomsday") {
      return on ? fireDoomsdayForCrew(characterID) : {ok: false, error: "DOOMSDAY_IS_INSTANT"};
    }
    return setSpecial(characterID, kind, on);
  }

  /** Per-crew NPC switch: stored on the pool entry and persisted with the state file. */
  function setCrewNpcMode(characterID, on) {
    const wanted = Number(characterID) || 0;
    if (!wanted) {
      return {ok: false, error: "BAD_CHARACTER"};
    }
    let found = false;
    stateStore.update((state) => ({
      ...state,
      pool: (state.pool || []).map((entry) => {
        if (Number(entry.characterID) !== wanted) {
          return entry;
        }
        found = true;
        return {...entry, npcMode: on === true};
      }),
    }));
    if (!found) {
      return {ok: false, error: "NO_SUCH_CREW"};
    }
    log(`[mode] ${wanted} npcMode = ${on === true}`);
    return {ok: true, characterID: wanted, npcMode: on === true};
  }

  const doomsdayReadyAt = new Map();
  // 末日没打出去（半径内没有合法目标 / 引擎拒绝且自算也 0）时只短等一会，
  // 而不是照扣满 5 分钟冷却——否则目标一出现还要再等一个冷却周期。
  const DOOMSDAY_RETRY_MS = 15000;

  /** 该候选船的主人是否与我们处于宣战状态（引擎 warRuntimeState 判定）。 */
  function isWarOpponent(crewCharacterID, candidate) {
    if (!crewCharacterID || !candidate) {
      return false;
    }
    const targetCharacterID = Number(candidate.characterID || candidate.pilotCharacterID) || 0;
    if (!targetCharacterID || targetCharacterID === Number(crewCharacterID)) {
      return false;
    }
    const war = deps.warRuntime;
    if (!war || typeof war.areCharactersLegalWarOpponents !== "function") {
      return false;
    }
    try {
      return war.areCharactersLegalWarOpponents(Number(crewCharacterID), targetCharacterID) === true;
    } catch (_error) {
      return false;
    }
  }

  /** Has this entity already been stamped with the doomsday hull attributes? */
  function hasSuperweaponPresence(entity) {
    const attributes = entity && entity.passiveDerivedState && entity.passiveDerivedState.attributes;
    return Boolean(attributes && Number(attributes["2009"]) > 0);
  }

  /**
   * 让客户端把"这艘船装着末日武器"画出来：舱门打开、聚能/释放/冷却三段动画。
   * 引擎里是 superweaponRuntime 给玩家/NPC 泰坦写 entitySuperWeapon* 属性
   * （2009 时长、2010-2013 四系伤害、2046 射程…）；船员船不走那条路径，所以
   * 必须由我们补上，否则客户端只画一艘普通船。
   *
   * 幂等：属性已经在就跳过（避免每次 refresh/召回都重播一遍 slim）。
   * `force` 用于 /crewmine refresh —— 它重算 derived state，属性可能被冲掉。
   */
  function applyDoomsdayPresence(scene, member, entity, options = {}) {
    if (!entity || !member) {
      return false;
    }
    if (options.force !== true && hasSuperweaponPresence(entity)) {
      return false;
    }
    try {
      const modules = special.findDoomsdayModules(deps, {
        characterID: Number(member.characterID) || 0,
        shipID: member.shipID,
      });
      if (modules.length === 0) {
        return false;
      }
      const profile = special.doomsdayProfile({...deps, sde}, modules[0]);
      profile.fxGuid = profile.fxGuid || special.FX_BY_RACE_HULL.get(Number(entity.typeID)) || "";
      special.applySuperweaponEntityAttributes(entity, profile);
      // 属性变了要让客户端重读这条球，否则它还是拿旧数据画。
      if (scene && typeof scene.broadcastSlimItemChanges === "function") {
        scene.broadcastSlimItemChanges([entity]);
      }
      return true;
    } catch (error) {
      log(`[special] 末日舱门属性写入失败 ${error && error.message}`);
      return false;
    }
  }

  // ---- 特殊装备开关（PLAN §18）：会战 / 堡垒模式（模块组 515）-----------------
  // 与末日武器同一契约：船员永远不自己开，玩家开关。按计划书 §18.5 的语义：
  //   - 开关状态持久化在 `entry.special = {bastion, siege}`（state.json），重启后重放；
  //   - 启动前拒绝"正在跃迁 / 已在跑另一个特殊模块"，失败给原因；
  //   - 日志统一 `[special]`；关闭/解散回滚（实体没了状态自然消失，入口清零）。
  //
  // 与 §18.1 的唯一差别（已与用户确认）：这里调引擎真实的 activateGenericModule，而不是
  // 手写"影子 effect state" —— 加成/定身/禁止跃迁/对接全部由引擎按 SDE 数据算，
  // 不会出现 §18.8 第一条"影子与引擎不同步"的风险。代价是每次点击一次属性重算。
  const specialAppliedAt = new Map();
  const SPECIAL_RETRY_MS = 5000;

  function modeModulesFor(entry) {
    return modeModule.findModeModules(deps, {
      characterID: Number(entry && entry.characterID) || 0,
      shipID: Number(entry && entry.shipID) || 0,
    });
  }

  // PLAN §20：B 类只做立体炸弹（隐形/微跃迁不做）。
  // 组 515 全族 + 立体炸弹。未知型号统一落到 special515（组驱动兜底）。
  const SPECIAL_KINDS = new Set(["bastion", "siege", "triage", "industrialCore", "special515", "smartbomb"]);

  /** `/crewmine special` 与面板接受的中文/英文名。 */
  function normalizeSpecialKind(value) {
    const text = String(value == null ? "" : value).trim().toLowerCase();
    if (text === "bastion" || text === "堡垒" || text === "堡垒装备") {
      return "bastion";
    }
    if (text === "siege" || text === "会战" || text === "会战装备" || text === "攻城") {
      return "siege";
    }
    if (text === "smartbomb" || text === "smartbombs" || text === "立体炸弹" || text === "炸弹") {
      return "smartbomb";
    }
    if (text === "triage" || text === "后勤" || text === "会战后勤" || text === "紧急修复" || text === "后勤装备") {
      return "triage";
    }
    if (text === "core" || text === "industrialcore" || text === "industrial" || text === "工业核心") {
      return "industrialCore";
    }
    // 组 515 里没认出来的型号（面板的「全部→特殊」会发这个）。
    if (text === "special515" || text === "515" || text === "特殊") {
      return "special515";
    }
    if (text === "doomsday" || text === "末日" || text === "末日武器") {
      return "doomsday";
    }
    if (text === "all" || text === "全部" || text === "") {
      return "all";
    }
    return "";
  }

  /** `entry.special` 的规范化视图（老存档没有这一项 → 全部关；种类由 SPECIAL_KINDS 驱动）。 */
  function specialStateOf(entry) {
    const raw = (entry && entry.special) || {};
    const state = {};
    for (const kind of SPECIAL_KINDS) {
      state[kind] = raw[kind] === true;
    }
    return state;
  }

  function persistSpecialFlag(characterID, kind, on) {
    const wanted = Number(characterID) || 0;
    let found = false;
    stateStore.update((state) => ({
      ...state,
      pool: (state.pool || []).map((row) => {
        if (Number(row.characterID) !== wanted) {
          return row;
        }
        found = true;
        return {...row, special: {...specialStateOf(row), [kind]: on === true}};
      }),
    }));
    return found;
  }

  /** 该船装着的那一块 `kind` 模块（同船两种都装时各取各的）。 */
  /** 模式模块一开就等于定身：船不会自己刹住，必须显式停船，否则会飘出定身范围。 */
  function stopShipForMode(scene, entity, session) {
    const runtime = deps && deps.runtime;
    if (!entity) {
      return false;
    }
    // 引擎把 stopShipEntity 挂在 SolarSystemScene.prototype 上（runtime.js 的 mixin），
    // 不在 deps.runtime 上 —— 以前找错对象，所以一次都没停过船。
    const stopper = (scene && typeof scene.stopShipEntity === "function")
      ? scene.stopShipEntity.bind(scene)
      : (runtime && typeof runtime.stopShipEntity === "function")
        ? runtime.stopShipEntity.bind(runtime)
        : (typeof deps.stopShipEntity === "function" ? deps.stopShipEntity : null);
    if (!stopper) {
      return false;
    }
    const speedBefore = Math.hypot(
      Number(entity.velocity && entity.velocity.x) || 0,
      Number(entity.velocity && entity.velocity.y) || 0,
      Number(entity.velocity && entity.velocity.z) || 0,
    );
    try {
      stopper(entity, {reason: "module_mode"});
      // 不要自己改 speedFraction/velocity：引擎用它们做运动学记账（speedFractionBeforeStop 等），
      // 手改只会让下一次运动指令对不上。stopShipEntity 的语义就是 TQ 的 CmdStop：断推力、滑行停住。
      const speedAfter = Math.hypot(
        Number(entity.velocity && entity.velocity.x) || 0,
        Number(entity.velocity && entity.velocity.y) || 0,
        Number(entity.velocity && entity.velocity.z) || 0,
      );
      log(`[special] 停船请求已发出：速度 ${speedBefore.toFixed(1)} → ${speedAfter.toFixed(1)} m/s`
        + (speedAfter > 1 ? "（服务端仍在滑行，客户端会看到缓慢减速）" : ""));
      return true;
    } catch (_error) {
      log(`[special] 停船失败：${_error && _error.message}`);
      return false;
    }
  }

  function modeModuleForKind(entry, kind) {
    for (const moduleItem of modeModulesFor(entry)) {
      if (modeModule.modeKindOf(deps, moduleItem).kind === kind) {
        return moduleItem;
      }
    }
    return null;
  }

  /**
   * 把某一块特殊模块对齐到 `entry.special` 的状态。返回 {ok, active, reason}。
   * 启动前的拒绝条件按 §18.5：正在跃迁 / 已在跑另一个特殊模块。
   */
  function applySpecialKind(entry, kind, session, scene) {
    const crewID = Number(entry && entry.characterID) || 0;
    const info = modeModule.MODE_KINDS[kind];
    if (!crewID || !info) {
      return {ok: false, reason: "BAD_REQUEST"};
    }
    const entity = scene && typeof scene.getEntityByID === "function" ? scene.getEntityByID(entry.shipID) : null;
    if (!entity) {
      return {ok: false, reason: "船不在场景里"};
    }
    const on = specialStateOf(entry)[kind] === true;
    const activeKind = activeKindByModule(entry, entity) || modeModule.activeModeKindOf(entity);
    const moduleSession = mining.moduleSessionFor(session, crewID, entity);
    if (on) {
      if (String(entity.mode || "").toUpperCase() === "WARP") {
        return {ok: false, reason: "正在跃迁，不能启动"};
      }
      const moduleItem = modeModuleForKind(entry, kind);
      if (!moduleItem) {
        return {ok: false, reason: `装配里没有${info.moduleLabel}`};
      }
      if (activeKind === kind) {
        // 已经在模式里（例如重启后重放）：同样补一次停船，船可能还在漂。
        stopShipForMode(scene, entity, mining.moduleSessionFor(session, crewID, entity));
        return {ok: true, active: true, already: true};
      }
      if (activeKind) {
        return {ok: false, reason: `已在跑${modeModule.MODE_KINDS[activeKind].moduleLabel}，先关闭`};
      }
      // O3：大模块激活排队——同一系统 2.5 s 内只允许一次大激活。
      // 单次 1.8 s 的重算改不了，但绝不能让堡垒/会战/工业核心叠在同一帧。
      const largeGapMs = Math.max(0, Number(configs_behavior().largeActivationGapMs) || 2500);
      const systemKey = Number(scene && scene.systemID) || 0;
      const largeWaitMs = largeGapMs - (now() - (Number(largeActivationAt.get(systemKey)) || 0));
      if (largeWaitMs > 0) {
        scheduleAfter(largeWaitMs, () => {
          try {
            applySpecialKind(entry, kind, session, scene);
          } catch (_error) {
            /* 下一次 watch tick 会按开关重试 */
          }
        });
        logCombatOnce(crewID, 0, `special-queued:${kind}`,
          `[special] ${entry.name} ${info.moduleLabel} 排队中（${Math.round(largeWaitMs)} ms 后激活，避免同帧大模块叠加）`);
        return {ok: true, active: false, queued: true, waitMs: largeWaitMs};
      }
      largeActivationAt.set(systemKey, now());
      // 方案 A：先把这次的燃料补进货舱，再让引擎照常激活并扣除。
      if (configs_behavior().specialFuelAutoSupply !== false) {
        // 引擎每轮扣一次燃料（scene/tick.js:1474），所以补到燃料舱能装的下限，不是补一轮。
        const fuel = fuelModule.ensureFuel({...deps, sde: (deps && deps.sde) || sde}, {
          characterID: crewID,
          shipID: entry.shipID,
          moduleItem,
          entity,
        });
        if (fuel.needsFuel === false) {
          // 堡垒（94010）这类模块本身不消耗燃料（SDE 无 713/714）：跳过补给，也不当作失败。
        } else if (!fuel.ok) {
          logCombatOnce(crewID, 0, `special-fuel:${fuel.reason}`,
            `[special] ${entry.name} ${info.moduleLabel} 燃料补给失败：${fuel.reason}`);
          return {ok: false, reason: `燃料补给失败（${fuel.reason}）`};
        } else if (fuel.granted > 0) {
          log(`[special] ${entry.name} 补充燃料 ${fuel.granted} × ${fuel.typeID}（${fuel.volume} m³ · `
            + `燃料舱 ${fuel.cyclesLeft}/${fuel.cyclesMax || fuel.targetCycles} 轮）`);
        }
      }
      const result = modeModule.activateMode({
        scene,
        session: moduleSession,
        entity,
        moduleItem,
        effectName: info.effectName,
      });
      if (!result.ok) {
        const reactivating = /MODULE_REACTIVATING/.test(String(result.reason));
        logCombatOnce(crewID, 0, `special-on:${result.reason}`,
          reactivating
            ? `[special] ${entry.name} ${info.moduleLabel} 引擎冷却中（MODULE_REACTIVATING），稍后重试`
            : `[special] ${entry.name} ${info.moduleLabel} 启动失败：${result.reason}`);
        return {ok: false, reason: result.reason};
      }
      // 标记成「停火时保留」：模式/遥修/指挥脉冲不是武器。
      markKeepOnStop(entity, moduleItem);
      log(`[special] ${entry.name} ${info.moduleLabel} 启动（${info.penalty.join(" · ")}）`);
      // 诊断：引擎到底把哪条效应写进了 effectState。guid 为空 = 引擎没拿到这条效应
      // （它按名字找，找不到就静默回退到该型号第一个可激活效应），客户端也就没有 FX。
      const appliedState = entity.activeModuleEffects instanceof Map
        ? entity.activeModuleEffects.get(Number(moduleItem.itemID) || 0) || null
        : null;
      log(`[special] ${entry.name} effectState effectName=${String((appliedState && appliedState.effectName) || "—")}`
        + ` effectID=${Number(appliedState && appliedState.effectID) || 0}`
        + ` guid=${String((appliedState && appliedState.guid) || "—")}`
        + ` durationMs=${Math.round(Number(appliedState && appliedState.durationMs) || 0)}`);
      // 引擎刚发过一帧起始 FX（一次性）。清掉记账，让下一次 sync 立刻补一帧"保持"版本。
      modeFxSentAt.delete(crewID);
    modeFxRefreshAt.delete(crewID);
      // 模式 = 定身。船不会自己刹住，这里显式停船，免得飘出定身/遥修范围。
      const stopped = stopShipForMode(scene, entity, moduleSession);
      log(`[special] ${entry.name} ${info.moduleLabel} 已停船${stopped ? "" : "（引擎没有 stopShipEntity，可能还在漂）"}`);
      return {ok: true, active: true, already: false};
    }
    if (!activeKind) {
      return {ok: true, active: false, already: true};
    }
    if (activeKind !== kind) {
      return {ok: false, reason: `正在跑${modeModule.MODE_KINDS[activeKind].moduleLabel}`};
    }
    const offModuleItem = modeModuleForKind(entry, kind);
    const offModuleID = Number(offModuleItem && offModuleItem.itemID) || 0;
    const offState = offModuleID && entity.activeModuleEffects instanceof Map
      ? entity.activeModuleEffects.get(offModuleID) || null
      : null;
    const offGuid = String((offState && offState.guid) || "");
    const offDurationMs = Number(offState && offState.durationMs) || 0;
    const result = modeModule.deactivateMode({
      scene,
      session: moduleSession,
      entity,
      moduleID: Number(modeModuleForKind(entry, kind) && modeModuleForKind(entry, kind).itemID) || 0,
    });
    if (!result.ok) {
      logCombatOnce(crewID, 0, `special-off:${result.reason}`,
        `[special] ${entry.name} ${info.moduleLabel} 关闭失败：${result.reason}`);
      return {ok: false, reason: result.reason};
    }
    log(`[special] ${entry.name} ${info.moduleLabel} 关闭，恢复机动`);
    // 把人造的"保持"帧收回去；引擎自己的 stop 已经发过，这帧只保证不留残影。
    broadcastModeFxStop(scene, entry, offModuleID, offGuid, offDurationMs);
    modeFxSentAt.delete(crewID);
    modeFxRefreshAt.delete(crewID);
    return {ok: true, active: false, already: result.alreadyOff === true};
  }

  const MODE_REPLAY_ORDER = ["bastion", "siege", "triage", "industrialCore", "special515"];
  const SPECIAL_FUEL_CHECK_MS = 5000;
  const specialFuelCheckAt = new Map();
  // O3：每系统上一次“大模块激活”的时间戳（堡垒/会战/后勤/工业核心/末日）。
  // 同一系统 2.5 s 内只允许一次，避免 1220/1086/1798 ms 叠在同一帧。
  const largeActivationAt = new Map();
  // 上一轮看到的模式：用来发现"模块被引擎静默关掉"（燃料/电容耗尽）。
  const specialModeSeen = new Map();
  // 堡垒/会战/后勤/工业核心的"变形"是**客户端 FX**：引擎只在激活那一刻广播一次
  // （scene/modules.js:3108 broadcastSpecialFx），已经在场景里的客户端收不到重放——
  // 引擎的重放只发生在"客户端重新获取实体"时，且白名单只有 effects.SiegeMode
  // （activeModuleSpecialFx.js:76）。于是第一个 cycle（堡垒 60 s）放完，船就恢复原状，
  // 而服务端状态其实一直没掉。这里按 cycle 边界自己补发一次：只补表现，不碰状态。
  const modeFxSentAt = new Map();
  /** 上一次"状态刷新"帧的时刻（refresh 模式下每 cycle 一帧）。 */
  const modeFxRefreshAt = new Map();
  const MODE_FX_RESEND_SLACK_MS = 2000;

  /** 组 515 里哪一块模块现在真的有激活状态（按 itemID 判断）。 */
  /** 给这块模块的激活状态打上「停火时不要关」的标记。 */
  function markKeepOnStop(entity, moduleItem) {
    const moduleID = Number(moduleItem && moduleItem.itemID) || 0;
    if (!moduleID || !entity || !(entity.activeModuleEffects instanceof Map)) {
      return;
    }
    const state = entity.activeModuleEffects.get(moduleID);
    if (state && typeof state === "object") {
      state.nfKeepOnStop = true;
    }
  }

  function activeKindByModule(entry, entity) {
    if (!entity || !(entity.activeModuleEffects instanceof Map) || entity.activeModuleEffects.size === 0) {
      return "";
    }
    for (const kind of MODE_REPLAY_ORDER) {
      const moduleItem = modeModuleForKind(entry, kind);
      const moduleID = Number(moduleItem && moduleItem.itemID) || 0;
      if (moduleID && entity.activeModuleEffects.has(moduleID)) {
        return kind;
      }
    }
    return "";
  }

  function noteModeStillActive(crewID, kind) {
    if (crewID && kind) {
      specialModeSeen.set(crewID, kind);
    }
  }

  /** 跑到一半的会战/后勤/工业核心：每 5 秒看一眼燃料，少于 2 轮就补满。 */
  function refuelActiveMode(entry, kind, entity) {
    if (configs_behavior().specialFuelAutoSupply === false) {
      return;
    }
    const crewID = Number(entry && entry.characterID) || 0;
    const at = Number(specialFuelCheckAt.get(crewID)) || 0;
    if (now() - at < SPECIAL_FUEL_CHECK_MS) {
      return;
    }
    specialFuelCheckAt.set(crewID, now());
    const moduleItem = modeModuleForKind(entry, kind);
    if (!moduleItem) {
      return;
    }
    const info = modeModule.MODE_KINDS[kind] || {moduleLabel: kind};
    // 用户规则：**燃料低于「一轮的最小需求」才补**（会战/后勤 250、工业核心 1000…）。
    // 以前是「低于 2 轮就补满」，一轮 250 却每 15 秒去检查并大额写入一次。
    const fuel = fuelModule.ensureFuel({...deps, sde: (deps && deps.sde) || sde}, {
      characterID: crewID,
      shipID: entry.shipID,
      moduleItem,
      entity,
      minimumCycles: 1,
    });
    if (fuel.needsFuel === false) {
      // 堡垒（94010）不需要燃料：不是"燃料已空"，直接返回（不补、不日志、不重试）。
      return;
    }
    if (!fuel.ok) {
      logCombatOnce(crewID, moduleItem.itemID || 0, `fuel:${fuel.reason}`,
        `[special] ${entry.name} ${info.moduleLabel} 燃料补给失败：${fuel.reason}`);
      return;
    }
    if (fuel.granted > 0) {
      log(`[special] ${entry.name} 补充燃料 ${fuel.granted} × ${fuel.typeID}（${fuel.volume} m³ · `
        + `${fuel.cyclesLeft}/${fuel.cyclesMax || fuel.targetCycles} 轮）`);
      return;
    }
    if (fuel.cyclesLeft <= 0) {
      logCombatOnce(crewID, moduleItem.itemID || 0, "fuel:empty",
        `[special] ${entry.name} ${info.moduleLabel} 燃料已空（补料失败），引擎会在本轮结束时关掉它`);
    }
  }

  /**
   * 变形动画（堡垒/会战/后勤/工业核心）的补发策略。
   *
   * 实测背景：`OnSpecialFX` 这条通道是"放完就完"的 —— 客户端播完一帧就收，
   * `duration` / `repeat` 填多大都不延长（`repeat: -1`、`duration: -1`、
   * `duration: cycle + repeat: 720` 三种都试过，堡垒仍然 60 s 收）。
   * 玩家自己的船能常亮，靠的是 **godma 状态通道**每个 cycle 补发一次
   * （`scene/tick.js:2248-2254`，只对 `entity.session` 的实体发），船员是 sessionless，
   * 那一段整个被跳过 —— 所以观察者手里只有一次性 FX。
   *
   * `MODE_FX_MODE`（四种都实测过）：
   *   "cycle"（当前）    ＝每过 `cycle × MODE_FX_CYCLE_RESEND_RATIO` 重发一帧 `start:true`。
   *                      **唯一能让观察者持续看到变形的做法**（实测四种参数里只有"重发
   *                      start"能反复点亮它）；代价是客户端替换 FX，每轮末尾会有一小段
   *                      "收起→展开"。重发点提前到 75% 是为了让替换发生在动画播完之前。
   *   "long"           ＝一帧 `duration: 12h / repeat: 1`。**实测无效**：仍 60 s 收。
   *   "refresh"        ＝每 cycle 一帧 `{start:false, active:true}` 静默刷新。**实测无效**。
   *   "hold"           ＝一帧 `duration:cycle / repeat:12h÷cycle`。**实测无效**。
   *
   * 根本原因：`effects.SiegeMode` 在客户端那边是一次性动画，`duration`/`repeat`/`active`
   * 都不延长它；玩家自己的船靠 godma 状态通道每 cycle 补发（`scene/tick.js:2248-2254`，
   * 只对 `entity.session` 生效），船员是 sessionless，拿不到那条通道。
   */
  const MODE_FX_MODE = "cycle";
  /** cycle 模式下重发 start 的时刻 = cycle × 本比例（75% = 动画播完之前替换）。 */
  const MODE_FX_CYCLE_RESEND_RATIO = 0.75;
  /** 12 小时窗口：矿枪也是按这个窗口给 repeat 的（activeModuleSpecialFx.js:74）。 */
  const MODE_FX_REPEAT_WINDOW_MS = 12 * 60 * 60 * 1000;

  function modeFxCycleMsOf(cycleMs) {
    return Math.max(1000, Number(cycleMs) || 0);
  }

  function modeFxRepeatFor(cycleMs) {
    return Math.max(1, Math.ceil(MODE_FX_REPEAT_WINDOW_MS / modeFxCycleMsOf(cycleMs)));
  }

  /** 首帧：请求播放动画 + 声明状态。 */
  function modeFxStartOptions(moduleID, moduleTypeID, cycleMs) {
    return {
      moduleID,
      moduleTypeID,
      start: true,
      active: true,
      duration: modeFxCycleMsOf(cycleMs),
      repeat: modeFxRepeatFor(cycleMs),
    };
  }

  /**
   * 长时保持：duration 直接给 12 小时、repeat 只有 1。
   * 如果客户端是"每 duration 播一遍、播 repeat 遍"，这就是一次播 12 小时；
   * 如果客户端完全不认 duration（前面三版的表现），那它也只会播一轮，退回 cycle 模式。
   */
  function modeFxLongOptions(moduleID, moduleTypeID) {
    return {
      moduleID,
      moduleTypeID,
      start: true,
      active: true,
      duration: MODE_FX_REPEAT_WINDOW_MS,
      repeat: 1,
    };
  }

  /** 每个 cycle 一帧：只声明"还开着"，不请求重播动画。 */
  function modeFxRefreshOptions(moduleID, moduleTypeID, cycleMs) {
    return {
      moduleID,
      moduleTypeID,
      start: false,
      active: true,
      duration: modeFxCycleMsOf(cycleMs),
      repeat: 1,
    };
  }

  function replayModeFx(scene, entry, kind, entity) {
    if (!scene || typeof scene.broadcastSpecialFx !== "function" || !entity || !kind) {
      return false;
    }
    const crewID = Number(entry && entry.characterID) || 0;
    const moduleItem = modeModuleForKind(entry, kind);
    const moduleID = Number(moduleItem && moduleItem.itemID) || 0;
    const effects = entity.activeModuleEffects instanceof Map ? entity.activeModuleEffects : null;
    const state = moduleID && effects ? effects.get(moduleID) : null;
    // 引擎给的 effectState 自带 guid（generic 路径 modules.js:2591）——不用再查 SDE。
    if (!state || !state.guid) {
      return false;
    }
    const durationMs = modeFxCycleMsOf(state.durationMs);
    const moduleTypeID = Number(state.typeID) || 0;
    const sentAt = Number(modeFxSentAt.get(crewID)) || 0;

    let options = null;
    let label = "";
    if (MODE_FX_MODE === "long" || MODE_FX_MODE === "hold") {
      // 只发一帧，之后一直到关闭都不发。
      if (sentAt > 0) {
        return false;
      }
      options = MODE_FX_MODE === "long"
        ? modeFxLongOptions(moduleID, moduleTypeID)
        : modeFxStartOptions(moduleID, moduleTypeID, durationMs);
      label = MODE_FX_MODE === "long" ? "长时保持变形动画" : "保持变形动画";
    } else if (MODE_FX_MODE === "cycle") {
      // 每过 75% 个 cycle 重发一帧 start：这是唯一能反复点亮变形的做法。
      const resendAfterMs = Math.max(1000, Math.round(durationMs * MODE_FX_CYCLE_RESEND_RATIO));
      if (sentAt > 0 && now() - sentAt < resendAfterMs) {
        return false;
      }
      options = modeFxStartOptions(moduleID, moduleTypeID, durationMs);
      label = "补发变形动画";
    } else {
      // refresh：首帧播动画，之后每 cycle 一帧静默刷新。
      if (sentAt <= 0) {
        options = modeFxStartOptions(moduleID, moduleTypeID, durationMs);
        label = "保持变形动画";
      } else {
        const refreshAt = Number(modeFxRefreshAt.get(crewID)) || 0;
        if (now() - refreshAt < durationMs - MODE_FX_RESEND_SLACK_MS) {
          return false;
        }
        options = modeFxRefreshOptions(moduleID, moduleTypeID, durationMs);
        label = "状态刷新";
      }
    }

    try {
      // S6：统一走 broadcastModuleFx（行为与直接调 scene.broadcastSpecialFx 一致）。
      const sent = fxBroadcast.broadcastModuleFx(scene, entity, {guid: state.guid, ...options});
      if (!sent) {
        throw new Error("FX_NOT_SENT");
      }
    } catch (error) {
      modeFxSentAt.delete(crewID);
      modeFxRefreshAt.delete(crewID);
      logCombatOnce(crewID, 0, `mode-fx:${state.guid}`,
        `[fx] ${entry.name} 补发变形动画失败：${error && error.message}`);
      return false;
    }
    modeFxSentAt.set(crewID, now());
    modeFxRefreshAt.set(crewID, now());
    log(`[fx] ${entry.name} ${label} ${state.guid}`
      + `（module=${moduleID} start=${options.start ? 1 : 0} active=${options.active ? 1 : 0}`
      + ` duration=${Math.round(Number(options.duration) / 1000)} s repeat=${options.repeat}）`);
    return true;
  }

  /** 关闭模式时把上面那帧"保持"取消掉（引擎自己也会发 stop，这里只保证不残留）。 */
  function broadcastModeFxStop(scene, entry, moduleID, guid, durationMs) {
    if (!scene || typeof scene.broadcastSpecialFx !== "function" || !moduleID || !guid) {
      return false;
    }
    const crewID = Number(entry && entry.characterID) || 0;
    try {
      // 和引擎自己的 stop 帧同形：start/active 都是 false，duration 用模块自己的 cycle。
      fxBroadcast.broadcastModuleFxStop(scene, {itemID: entry.shipID}, {
        guid,
        moduleID,
        moduleTypeID: 0,
        duration: Math.max(1000, Number(durationMs) || 0),
        repeat: 0,
        visibilityEntity: null,
      });
    } catch (_error) {
      return false;
    }
    modeFxSentAt.delete(crewID);
    modeFxRefreshAt.delete(crewID);
    log(`[fx] ${entry.name} 取消变形动画 ${guid}`);
    return true;
  }

  /** 每秒一次：把持久化的开关状态与引擎实际状态对齐（重启后也靠它重放）。 */
  function syncSpecials(scene, session, summoned, steps) {
    // steps 只在 watch tick 里传：子项 special.detect / .fuel / .fx / .apply 用于归因
    // （名字里的 "." 不计入 accounted）。2026-10-25 实测这段有 1.2–2.1 s，得知道是谁。
    const mark = (name, fn) => (steps ? timeStage(steps, name, fn) : fn());
    for (const entry of summoned) {
      const crewID = Number(entry.characterID) || 0;
      const entity = scene && typeof scene.getEntityByID === "function" ? scene.getEntityByID(entry.shipID) : null;
      if (!entity) {
        continue;
      }
      const state = specialStateOf(entry);
      // 按「这块模块有没有激活状态」判断，比解析 effect 名可靠：
      // 引擎给的 effectName 有时不是 moduleBonus*，曾导致 Triage 明明在跑却被反复激活，
      // 每次失败扣 250 燃料并刷 MODULE_REACTIVATING。
      const activeKind = mark("special.detect",
        () => activeKindByModule(entry, entity) || modeModule.activeModeKindOf(entity));
      // 模式真的没了（引擎关掉/船没了）：把"保持帧已发"的记账清掉，
      // 下次重新开启时才会再发一帧。这是 replayModeFx 里唯一的清除来源之一。
      if (!activeKind) {
        modeFxSentAt.delete(crewID);
    modeFxRefreshAt.delete(crewID);
      }
      // 组 515 全族都参与重放（以前只认 siege/bastion，triage/工业核心重启后不会自己开回来）。
      let wantedKind = "";
      for (const kind of MODE_REPLAY_ORDER) {
        if (state[kind] === true) {
          wantedKind = kind;
          break;
        }
      }
      // 正在跑的：检查燃料（引擎每轮扣一次），不够就补；顺便发现"被引擎悄悄关掉"。
      if (wantedKind === activeKind) {
        if (activeKind) {
          noteModeStillActive(crewID, activeKind);
          mark("special.fuel", () => refuelActiveMode(entry, activeKind, entity));
          // 保持帧只在开启时发一次，之后一直到关闭都不再发（重发会让客户端播关闭+开启）。
          mark("special.fx", () => replayModeFx(scene, entry, activeKind, entity));
        } else if (wantedKind) {
          noteModeStillActive(crewID, wantedKind);
        }
        continue;
      }
      const seenKind = specialModeSeen.get(crewID) || "";
      if (seenKind && !activeKind && seenKind !== wantedKind) {
        // 上一轮还在跑、这一轮没了（燃料/电容耗尽会让引擎静默关模块）——只报一次。
        logCombatOnce(crewID, 0, `mode-dropped:${seenKind}`,
          `[special] ${entry.name} ${modeModule.MODE_KINDS[seenKind] ? modeModule.MODE_KINDS[seenKind].moduleLabel : seenKind}`
          + " 自己关掉了（多半是燃料或电容耗尽），正在按开关重试");
        specialModeSeen.delete(crewID);
      }
      // 两个都开着 = 冲突，交给玩家在面板上先关一个；这里不擅自决定。
      if (wantedKind && activeKind) {
        continue;
      }
      const target = wantedKind || activeKind;
      if (!target) {
        continue;
      }
      const at = Number(specialAppliedAt.get(crewID)) || 0;
      if (now() - at < SPECIAL_RETRY_MS) {
        continue;
      }
      specialAppliedAt.set(crewID, now());
      mark("special.apply", () => applySpecialKind(entry, target, session, scene));
    }
  }

  /** `/crewmine special` 的目标选择：all / 名字 / 角色ID。 */
  function specialTargets(selector) {
    const summoned = (stateStore.get().pool || []).filter((entry) => entry.summoned === true && Number(entry.shipID));
    const wanted = String(selector == null ? "" : selector).trim().toLowerCase();
    if (!wanted || wanted === "all" || wanted === "全部") {
      return summoned;
    }
    return summoned.filter((entry) => String(entry.characterID) === wanted
      || String(entry.name || "").toLowerCase() === wanted);
  }

  // ---- PLAN §20 B/C：立体炸弹 / EWAR / 吸电中和 / 指挥脉冲 ----------------------
  // 与 §18 同一取舍：只决定"什么时候、对谁"，结算全交给引擎（hostileModuleState、
  // 电容、范围伤害、舰队 buff 都由 SDE 数据驱动）。
  const activeAppliedAt = new Map();
  const ACTIVE_RETRY_MS = 3000;
  // 终态失败退避：`${crewID}:${moduleID}` -> {reason, until}。
  // NO_AMMO 这类原因会一直失败（没弹药就是没弹药），每 3 秒重试既刷屏又吃 CPU
  // （每次激活都要重建 live 属性表，实测 1.6~3.1 s 的 watch tick 就是它）。
  const activeFailures = new Map();
  const ACTIVE_FAILURE_AMMO_MS = 300000;
  const ACTIVE_FAILURE_OTHER_MS = 60000;
  // 装填节流：一趟扫货舱不便宜，每船 10 秒最多一次。
  const activeAmmoAt = new Map();
  const ACTIVE_AMMO_MS = 10000;
  const SMARTBOMB_DEFAULT_RADIUS_M = 6000;

  function activeFailureKey(crewID, moduleID) {
    return `${Number(crewID) || 0}:${Number(moduleID) || 0}`;
  }

  function activeFailureOf(crewID, moduleID) {
    const row = activeFailures.get(activeFailureKey(crewID, moduleID));
    if (!row) {
      return null;
    }
    if (now() >= Number(row.until) || 0) {
      activeFailures.delete(activeFailureKey(crewID, moduleID));
      return null;
    }
    return row;
  }

  function noteActiveFailure(crewID, moduleID, reason) {
    const text = String(reason || "UNKNOWN");
    const ammoish = /NO_AMMO|NO_CHARGE|NO_AMMO_IN_CARGO/.test(text);
    const reactivating = /MODULE_REACTIVATING/.test(text);
    activeFailures.set(activeFailureKey(crewID, moduleID), {
      reason: text,
      until: now() + (reactivating ? 3000 : ammoish ? ACTIVE_FAILURE_AMMO_MS : ACTIVE_FAILURE_OTHER_MS),
    });
  }

  function clearActiveFailure(crewID, moduleID) {
    activeFailures.delete(activeFailureKey(crewID, moduleID));
  }

  /** 激活前先去货舱找兼容弹药装到模块槽位（引擎只认槽位上的弹药）。 */
  function ensureActiveAmmo(entry, crewID, moduleItem) {
    const ammoKey = `${Number(crewID) || 0}:${Number(moduleItem && moduleItem.itemID) || 0}`;
    const at = Number(activeAmmoAt.get(ammoKey)) || 0;
    if (now() - at < ACTIVE_AMMO_MS) {
      return;
    }
    activeAmmoAt.set(ammoKey, now());
    try {
      const ammo = combat.ensureAmmoLoaded(deps, {
        characterID: crewID,
        shipID: entry.shipID,
        modules: [{moduleItem}],
      });
      if (ammo && ammo.loaded > 0) {
        log(`[active] ${entry.name} 从货舱装填弹药 ${ammo.loaded} 个（${moduleItem.itemName || moduleItem.typeID}）`);
      }
    } catch (_error) {
      /* 装填失败不影响后续判断：激活会明确报 NO_AMMO */
    }
  }

  const ACTIVE_OWN_PICK_MS = 3000;
  const activeOwnPickAt = new Map();

  /** 给自己挑一个合法敌对（复用战斗候选集：交战规则 + 仇人名单 + 距离）。 */
  function pickOwnActiveTarget(entry, entity, scene, session, crewID) {
    const ranges = activeModulesFor(entry)
      .filter((row) => activeModules.isTargetFamily(row.family))
      .map((row) => activeModules.rangeMetersFor(deps, row.moduleItem))
      .filter((meters) => Number(meters) > 0);
    const searchMeters = Math.max(60000, ...ranges);
    const rule = engagementRule;
    const acceptsWarTargets = rule === "war" || rule === "defend";
    try {
      const picked = combat.pickTargetFor({
        scene,
        sourceEntity: entity,
        crewID,
        excludeIDs: new Set(),
        blacklist: blacklistFor(crewID, now()),
        maxMeters: searchMeters,
        // 与自由开火同一套规则：原生 NPC 永远可打；仇人名单；宣战（按交战规则）。
        accept: (candidate) => Boolean(candidate && candidate.nativeNpc === true)
          || isGrudged(candidate, session)
          || (acceptsWarTargets && isWarOpponent(crewID, candidate)),
        commanderTarget: 0,
        focus: false,
        currentTarget: 0,
        stickiness: 1.25,
        maxCandidates: 8,
        nowMs: now(),
      });
      return Number(picked && picked.targetID) || 0;
    } catch (_error) {
      return 0;
    }
  }

  /** 没有武器时，把「装了什么、在线没在线」打一行，方便排查到底是什么原因。 */
  /** 这条船是不是纯后勤（带遥修/指挥脉冲/传电，但没有武器）。 */
  function isSupportShip(member) {
    const fitting = deps && deps.fitting;
    if (!fitting || typeof fitting.getFittedModuleItems !== "function") {
      return false;
    }
    let items = [];
    try {
      items = fitting.getFittedModuleItems(Number(member.characterID) || 0, member.shipID) || [];
    } catch (_error) {
      items = [];
    }
    return items.some((item) => Boolean(remoteAssist.familyOf(Number(item && item.groupID))))
      || items.some((item) => Number(item && item.groupID) === 1770);
  }

  function describeFittingForNoWeapon(member) {
    const fitting = deps && deps.fitting;
    const dogma = deps && deps.weaponDogma;
    if (!fitting || typeof fitting.getFittedModuleItems !== "function") {
      return "没有 fitting API";
    }
    let items = [];
    try {
      items = fitting.getFittedModuleItems(Number(member.characterID) || 0, member.shipID) || [];
    } catch (_error) {
      items = [];
    }
    if (items.length === 0) {
      return "装配是空的";
    }
    const parts = [];
    let unknownFamily = 0;
    let offline = 0;
    for (const item of items) {
      const online = typeof fitting.isModuleOnline === "function" ? fitting.isModuleOnline(item) !== false : true;
      let family = "";
      try {
        family = String((dogma && typeof dogma.resolveWeaponFamily === "function"
          ? dogma.resolveWeaponFamily(item, null) : "") || "");
      } catch (_error) {
        family = "";
      }
      if (!online) {
        offline += 1;
      } else if (!family) {
        unknownFamily += 1;
      }
      parts.push(`${Number(item.typeID) || 0}${online ? "" : "(离线)"}${family ? `[${family}]` : ""}`);
    }
    return `${items.length} 件装配（离线 ${offline}，认不出武器族 ${unknownFamily}）：${parts.slice(0, 8).join(" ")}`;
  }

  function activeModulesFor(entry) {
    return activeModules.findActiveModules(deps, {
      characterID: Number(entry && entry.characterID) || 0,
      shipID: Number(entry && entry.shipID) || 0,
    });
  }

  function smartbombModulesFor(entry) {
    return activeModulesFor(entry).filter((row) => row.family === activeModules.FAMILY_SMARTBOMB);
  }

  /** 该船装了哪些可切换的特殊装备（bastion / siege / smartbomb）。 */
  function availableSpecialKinds(entry) {
    const kinds = new Set();
    for (const moduleItem of modeModulesFor(entry)) {
      const info = modeModule.modeKindOf(deps, moduleItem);
      if (info.kind) {
        kinds.add(info.kind);
      }
    }
    if (smartbombModulesFor(entry).length > 0) {
      kinds.add("smartbomb");
    }
    return kinds;
  }

  function specialLabel(kind) {
    if (kind === "smartbomb") {
      return "立体炸弹";
    }
    return (modeModule.MODE_KINDS[kind] && modeModule.MODE_KINDS[kind].moduleLabel) || kind;
  }

  /**
   * 立体炸弹的安全判定：范围内有敌对、且**没有友军/中立**才允许开火。
   * 立体炸弹会打到范围内所有船，所以这条闸比任何别的装备都严。
   */
  function smartbombNeighbourhood(scene, session, crewID, entity, radiusMeters) {
    const result = {enemies: 0, friendlies: 0, neutrals: 0, radius: radiusMeters, enemyEntities: []};
    let rows = [];
    try {
      // 立体炸弹的安全判定（有没有友军）必须看实时名单，不能用缓存。
      rows = typeof scene.getDynamicEntities === "function" ? scene.getDynamicEntities() || [] : [];
    } catch (_error) {
      rows = [];
    }
    for (const candidate of rows) {
      if (!candidate || candidate.kind !== "ship" || Number(candidate.itemID) === Number(entity.itemID)) {
        continue;
      }
      if (String(candidate.mode || "").toUpperCase() === "WARP") {
        continue;
      }
      const distance = combat.surfaceDistance(entity, candidate);
      if (radiusMeters > 0 && distance > radiusMeters) {
        continue;
      }
      if (candidate.nativeNpc === true) {
        result.enemies += 1;
        result.enemyEntities.push(candidate);
        continue;
      }
      const id = characterIDOf(candidate);
      if (!id) {
        result.neutrals += 1;
        continue;
      }
      if (isOwnSide(id, session)) {
        result.friendlies += 1;
        continue;
      }
      if (isGrudged(candidate, session) || isWarOpponent(crewID, candidate)) {
        result.enemies += 1;
        result.enemyEntities.push(candidate);
        continue;
      }
      result.neutrals += 1;
    }
    return result;
  }

  // S3：立体炸弹的四种伤害属性（SDE 实测：小炸弹 typeID 1547 只带 116=50）。
  const SMARTBOMB_DAMAGE_ATTRIBUTE_IDS = {em: 114, explosive: 116, kinetic: 117, thermal: 118};
  const SMARTBOMB_SETTLE_CYCLE_MS = 10000;
  const smartbombNextAt = new Map();

  /**
   * S3：立体炸弹结算。一次算量（四系伤害按模块数求和），对半径内每个敌人各结算一次，
   * 然后补一帧 `effects.EMPWave`。
   *
   * 为什么：`activateGenericModule` 每次都要重建全船属性（0.5–1.1 s），而炸弹的本质就是
   * "一个数值 × 目标数"。目标筛选沿用 `smartbombNeighbourhood()`（可见性/距离/声望同一口径）。
   */
  function settleSmartbomb({entry, scene, entity, rows, around, crewID}) {
    // 统一结算走 nfCrewMiningDamage：apply → 记伤害归属 → 打爆时入队 KM。
    // （以前这里连 noteKillmailDamage 都没调，伤害归属和击杀报告全丢。）
    const damageApi = damageSettle.api(deps);
    if (!damageApi.applyDamage) {
      return {ok: false, reason: "NO_DAMAGE_API"};
    }
    const enemies = Array.isArray(around && around.enemyEntities) ? around.enemyEntities : [];
    if (enemies.length === 0) {
      return {ok: false, reason: "NO_TARGET"};
    }
    const nowMs = now();
    if (nowMs < (Number(smartbombNextAt.get(crewID)) || 0)) {
      return {ok: false, reason: "COOLDOWN"};
    }
    const volley = {em: 0, explosive: 0, kinetic: 0, thermal: 0};
    let capNeed = 0;
    let durationMs = 0;
    let moduleCount = 0;
    for (const row of rows) {
      const attributes = remoteAttributeSnapshotFor(entry, entity, row.moduleItem);
      if (!attributes) {
        continue;
      }
      for (const [key, id] of Object.entries(SMARTBOMB_DAMAGE_ATTRIBUTE_IDS)) {
        volley[key] += Math.max(0, Number(attributes[id]) || 0);
      }
      capNeed += Math.max(0, Number(attributes[remoteAttributeId("capNeed")]) || 0);
      durationMs = Math.max(durationMs, Math.max(0, Number(attributes[remoteAttributeId("duration")]) || 0));
      moduleCount += 1;
    }
    const perTarget = volley.em + volley.explosive + volley.kinetic + volley.thermal;
    if (moduleCount === 0 || perTarget <= 0) {
      return {ok: false, reason: "NO_DAMAGE_ATTR"};
    }
    if (capNeed > 0 && !payRemoteCapacitor(entity, capNeed)) {
      return {ok: false, reason: "NO_CAPACITOR"};
    }
    let hit = 0;
    let applied = 0;
    for (const target of enemies) {
      try {
        const settled = damageSettle.applyDamage(deps, {
          scene,
          attacker: entity,
          target,
          damage: {...volley},
          whenMs: nowMs,
          moduleItem: rows[0] && rows[0].moduleItem,
        });
        hit += 1;
        applied += settled.applied;
      } catch (_error) {
        /* 单个目标失败不影响其它目标 */
      }
    }
    if (hit === 0) {
      return {ok: false, reason: "NO_HIT"};
    }
    smartbombNextAt.set(crewID, nowMs + Math.max(1000, durationMs || SMARTBOMB_SETTLE_CYCLE_MS));
    const firstItem = rows[0] && rows[0].moduleItem;
    fxBroadcast.broadcastModuleFx(scene, entity, {
      guid: "effects.EMPWave",
      moduleID: Number(firstItem && firstItem.itemID) || null,
      moduleTypeID: Number(firstItem && firstItem.typeID) || null,
      duration: 1000,
      repeat: 0,
    });
    logCombatOnce(crewID, 0, "smartbomb:settle",
      `[active] ${entry.name} 立体炸弹结算：${hit} 个目标 × ${Math.round(perTarget)} 伤害`
      + `（合计 ${Math.round(applied)}）`);
    return {ok: true, hit, applied, perTarget};
  }

  /** 把一艘船的立体炸弹对齐到玩家开关 + 安全条件。 */
  function applySmartbombFor(entry, session, scene) {
    const crewID = Number(entry && entry.characterID) || 0;
    const entity = scene && typeof scene.getEntityByID === "function" ? scene.getEntityByID(entry.shipID) : null;
    if (!entity) {
      return {ok: false, reason: "船不在场景里"};
    }
    const rows = smartbombModulesFor(entry);
    if (rows.length === 0) {
      return {ok: false, reason: "装配里没有立体炸弹"};
    }
    const moduleSession = mining.moduleSessionFor(session, crewID, entity);
    const off = () => {
      for (const row of rows) {
        activeModules.deactivate({scene, session: moduleSession, entity, moduleID: row.moduleItem.itemID});
      }
      return {ok: true, active: false, label: "立体炸弹"};
    };
    if (specialStateOf(entry).smartbomb !== true) {
      return off();
    }
    let radius = 0;
    for (const row of rows) {
      radius = Math.max(radius, activeModules.rangeMetersFor(deps, row.moduleItem));
    }
    if (radius <= 0) {
      radius = SMARTBOMB_DEFAULT_RADIUS_M;
    }
    const around = smartbombNeighbourhood(scene, session, crewID, entity, radius);
    if (around.friendlies > 0 || around.neutrals > 0) {
      logCombatOnce(crewID, 0, `smartbomb:hazard:${around.friendlies}:${around.neutrals}`,
        `[active] ${entry.name} 立体炸弹待机（半径 ${Math.round(radius / 1000)}km 内有友军 ${around.friendlies} / 中立 ${around.neutrals}）`);
      return off();
    }
    if (around.enemies === 0) {
      logCombatOnce(crewID, 0, "smartbomb:empty",
        `[active] ${entry.name} 立体炸弹待机（半径 ${Math.round(radius / 1000)}km 内没有敌对目标）`);
      return off();
    }
    // S3：立体炸弹"一次算量 × 范围内目标"，不再激活模块。
    // 任何一环缺失（结算 API / 属性快照 / 伤害为 0 / 电容不足）都退回下面的真激活路径。
    if (configs_behavior().smartbombSettlement !== false) {
      const settled = settleSmartbomb({entry, scene, entity, rows, around, crewID});
      if (settled.ok === true) {
        return {ok: true, active: true, enemies: around.enemies, label: "立体炸弹", settled: true};
      }
    }
    let fired = 0;
    for (const row of rows) {
      if (activeModules.isActive(entity, row.moduleItem.itemID)) {
        fired += 1;
        continue;
      }
      const result = activeModules.activate({
        scene,
        session: moduleSession,
        entity,
        moduleItem: row.moduleItem,
      });
      if (!result.ok) {
        logCombatOnce(crewID, row.moduleItem.itemID, `smartbomb:${result.reason}`,
          `[active] ${entry.name} 立体炸弹启动失败：${result.reason}`);
        return {ok: false, reason: result.reason};
      }
      fired += 1;
    }
    if (fired > 0) {
      logCombatOnce(crewID, 0, "smartbomb:fire",
        `[active] ${entry.name} 立体炸弹开火（半径内 ${around.enemies} 个敌对，友军 0）`);
    }
    return {ok: true, active: true, enemies: around.enemies, label: "立体炸弹"};
  }

  /**
   * C 类（EWAR / 吸电 / 中和）挂到当前战斗目标上；指挥脉冲在开火状态下常开。
   * 目标切换就重挂，没目标就全部关掉（避免锁着空气干烧电）。
   */
  function syncActiveFor(entry, session, scene) {
    const crewID = Number(entry && entry.characterID) || 0;
    const entity = scene && typeof scene.getEntityByID === "function" ? scene.getEntityByID(entry.shipID) : null;
    if (!entity) {
      return;
    }
    const rows = activeModulesFor(entry);
    if (rows.length === 0) {
      return;
    }
    const moduleSession = mining.moduleSessionFor(session, crewID, entity);
    let target = Number(combatTargets.get(crewID)) || 0;
    if (target && !(typeof scene.getEntityByID === "function" ? scene.getEntityByID(target) : null)) {
      // 目标已经不在本星系：清掉记录，别让 EWAR/吸电一直挂着旧 ID。
      combatTargets.delete(crewID);
      target = 0;
    }
    let ownPickedTarget = false;
    if (!target && freeFire) {
      // 纯电子战船（没有武器）拿不到武器流程给的目标，这里自己挑一个合法敌对。
      const at = Number(activeOwnPickAt.get(crewID)) || 0;
      if (now() - at >= ACTIVE_OWN_PICK_MS) {
        activeOwnPickAt.set(crewID, now());
        const picked = pickOwnActiveTarget(entry, entity, scene, session, crewID);
        if (picked) {
          combatTargets.set(crewID, picked);
          target = picked;
          ownPickedTarget = true;
          log(`[active] ${entry.name} 自己锁定目标 #${picked}（没有武器流程给目标）`);
        }
      }
    }
    for (const row of rows) {
      const spec = row.spec;
      const moduleID = Number(row.moduleItem.itemID) || 0;
      if (!spec || !moduleID) {
        continue;
      }
      if (row.family === activeModules.FAMILY_SMARTBOMB) {
        continue; // 安全条件由 applySmartbombFor 单独把关
      }
      const state = activeModules.effectStateFor(entity, moduleID);
      if (spec.mode === "self") {
        // 指挥脉冲：只在我方处于交战状态时开（平时开就是白烧电与冷却）。
        if (!freeFire && !target) {
          if (state) {
            activeModules.deactivate({scene, session: moduleSession, entity, moduleID});
          }
          continue;
        }
        if (state) {
          clearActiveFailure(crewID, moduleID);
          continue;
        }
        if (activeFailureOf(crewID, moduleID)) {
          // 终态失败退避中（没弹药 / 没电容之类），到点再试，别每 3 秒来一次。
          continue;
        }
        ensureActiveAmmo(entry, crewID, row.moduleItem);
        const result = activeModules.activate({scene, session: moduleSession, entity, moduleItem: row.moduleItem});
        if (!result.ok) {
          noteActiveFailure(crewID, moduleID, result.reason);
          if (!/MODULE_REACTIVATING/.test(String(result.reason))) {
            logCombatOnce(crewID, moduleID, `active:${result.reason}`,
              `[active] ${entry.name} ${spec.label} 启动失败：${result.reason}`);
          }
        } else {
          clearActiveFailure(crewID, moduleID);
        }
        continue;
      }
      // target 类
      if (!target) {
        if (state) {
          activeModules.deactivate({scene, session: moduleSession, entity, moduleID});
        }
        continue;
      }
      const activeTarget = Number(state && state.targetID) || 0;
      const targetEntity = typeof scene.getEntityByID === "function" ? scene.getEntityByID(target) : null;
      // 目标已经不在了：即使 combatTargets 还没清，也要把 EWAR 关掉（否则会一直锁着空气干烧电）。
      if (!targetEntity) {
        if (state) {
          activeModules.deactivate({scene, session: moduleSession, entity, moduleID});
        }
        continue;
      }
      if (activeTarget === target) {
        continue;
      }
      if (state) {
        activeModules.deactivate({scene, session: moduleSession, entity, moduleID});
      }
      const range = activeModules.rangeMetersFor(deps, row.moduleItem);
      const distance = combat.surfaceDistance(entity, targetEntity);
      if (range > 0 && distance > range) {
        logCombatOnce(crewID, moduleID, "active:range",
          `[active] ${entry.name} ${spec.label} 目标在射程外（${Math.round(distance / 1000)}km > ${Math.round(range / 1000)}km）`);
        continue;
      }
      if (activeFailureOf(crewID, moduleID)) {
        continue;
      }
      if (ownPickedTarget) {
        // 自己挑的目标没人帮我们锁，先锁再挂（引擎要求 TARGET_LOCKED）。
        const locked = combat.ensureTargetLock({scene, entity, target: targetEntity, instant: instantLockEnabled()});
        if (!locked || locked.ok !== true) {
          logCombatOnce(crewID, moduleID, `active:lock:${locked && locked.reason}`,
            `[active] ${entry.name} ${spec.label} 锁定失败：${(locked && locked.reason) || "UNKNOWN"}`);
          continue;
        }
      }
      ensureActiveAmmo(entry, crewID, row.moduleItem);
      const result = activeModules.activate({
        scene,
        session: moduleSession,
        entity,
        moduleItem: row.moduleItem,
        targetID: target,
      });
      if (!result.ok) {
        noteActiveFailure(crewID, moduleID, result.reason);
        if (!/MODULE_REACTIVATING/.test(String(result.reason))) {
          logCombatOnce(crewID, moduleID, `active:${result.reason}`,
            `[active] ${entry.name} ${spec.label} 失败：${result.reason}`);
        }
      } else {
        clearActiveFailure(crewID, moduleID);
        markKeepOnStop(entity, row.moduleItem);
      }
    }
  }

  /** 每秒一次：立体炸弹按安全条件、EWAR/吸电/脉冲按目标对齐。 */
  function syncActiveModules(scene, session, summoned) {
    for (const entry of summoned) {
      const crewID = Number(entry.characterID) || 0;
      const at = Number(activeAppliedAt.get(crewID)) || 0;
      if (now() - at < ACTIVE_RETRY_MS) {
        continue;
      }
      activeAppliedAt.set(crewID, now());
      if (specialStateOf(entry).smartbomb) {
        applySmartbombFor(entry, session, scene);
      }
      syncActiveFor(entry, session, scene);
    }
  }

  // ---- 遥修（docs/archive/遥修实现计划书.md）----------------------------------------
  // 按组识别（41/1697 护盾、325/1698 装甲、585 船体、67 电容），只决定「修谁 / 何时停 /
  // 谁来修」；锁定校验、射程、disallowAssistance（堡垒/会战收不到遥修）、maxGroupActive
  // 与每周期结算全部交给引擎。
  const remoteAppliedAt = new Map();
  const REMOTE_RETRY_MS = 2500;
  // `${family}:${targetShipID}` -> crewID：同一目标同一层只留一个人修，省锁定槽。
  const remoteClaims = new Map();
  // 模块冷却：引擎回 MODULE_REACTIVATING 时，3 秒内别再去试同一块。
  const remoteRetryAfter = new Map();

  function remoteModulesFor(entry) {
    return remoteAssist.findRemoteModules(deps, {
      characterID: Number(entry && entry.characterID) || 0,
      shipID: Number(entry && entry.shipID) || 0,
    });
  }

  /**
   * 遥修白名单：玩家船 + 其它在役船员（同星系）。绝不包含 NPC / 中立。
   * PLAN §18.29 第 1 条：候选集只有这两类，不做 `getDynamicEntities()` 全场扫描。
   */
  function remoteCandidatesFor(scene, session, member, entity) {
    const rows = [];
    const playerShipID = Number(session && session._space && session._space.shipID) || 0;
    if (playerShipID > 0 && playerShipID !== Number(entity.itemID)) {
      const player = typeof scene.getEntityByID === "function" ? scene.getEntityByID(playerShipID) : null;
      if (player) {
        rows.push({entity: player, isPlayer: true, name: "玩家", shipID: playerShipID});
      }
    }
    for (const other of stateStore.get().pool || []) {
      if (other.summoned !== true || Number(other.characterID) === Number(member.characterID)) {
        continue;
      }
      const otherEntity = typeof scene.getEntityByID === "function" ? scene.getEntityByID(other.shipID) : null;
      if (!otherEntity) {
        continue;
      }
      rows.push({entity: otherEntity, isPlayer: false, name: other.name, shipID: Number(other.shipID)});
    }
    return rows;
  }

  function remoteLayerLabel(layer) {
    return layer === "capacitor" ? "电容" : layer === "shield" ? "护盾" : layer === "armor" ? "装甲" : "结构";
  }

  // ---- 遥修「齐射式」结算（PLAN §18.29 路线 A）--------------------------------
  // 引擎每次 activateGenericModule 都会重建全船属性（0.5–1.1 s），遥修照武器齐射的
  // 形态改成纯结算：**一个目标 / 一次算量 / 按模块数乘 / 直接写目标层值**。
  // 用户已定：玩家与友军同权（谁先跌破门槛修谁，平手取缺口大的）、80% 起 95% 停、
  // 电容照扣、取消多目标分配。
  // 关掉 behavior.remoteRepairSalvo（或拿不到模块属性快照）→ 退回下面的逐模块激活。
  const remoteSalvoTargets = new Map(); // `${crewID}:${family}` -> 正在修的目标 shipID（95% 停的滞回）
  const remoteSalvoNextAt = new Map(); // `${crewID}:${family}` -> 下一次可以结算的墙钟
  // 探测「这个宿主能不能建属性快照」也要节流：建不出来时每个 tick 重试一次太贵。
  const remoteSalvoProbeAt = new Map();
  const remoteSalvoProbeOk = new Map();
  const REMOTE_ATTRIBUTE_NAMES = {
    shield: "shieldBonus",
    armor: "armorDamageAmount",
    structure: "structureDamageAmount",
    capacitor: "powerTransferAmount",
    capNeed: "capacitorNeed",
    duration: "duration",
  };
  // 引擎里这些属性的 id 很稳（同 assistanceModuleRuntime 的兜底值）。
  const REMOTE_ATTRIBUTE_FALLBACKS = {
    shield: 68,
    armor: 84,
    structure: 83,
    capacitor: 90,
    capNeed: 6,
    duration: 73,
  };
  const remoteAttributeIdCache = new Map();
  let remoteAttributeApi;

  /** 模块属性 id：优先问引擎的 dogma 索引，问不到就用兜底常量。 */
  function remoteAttributeId(key) {
    if (remoteAttributeIdCache.has(key)) {
      return remoteAttributeIdCache.get(key);
    }
    let id = REMOTE_ATTRIBUTE_FALLBACKS[key];
    const fitting = deps && deps.fitting;
    try {
      if (fitting && typeof fitting.getAttributeIDByNames === "function") {
        const resolved = Number(fitting.getAttributeIDByNames(REMOTE_ATTRIBUTE_NAMES[key]));
        if (Number.isFinite(resolved) && resolved > 0) {
          id = resolved;
        }
      }
    } catch (_error) {
      /* 索引不认这个名字就用兜底 */
    }
    remoteAttributeIdCache.set(key, id);
    return id;
  }

  /**
   * 模块属性的构建器。生产环境用引擎自己的 liveModuleAttributes（技能 / 会战 / 辅助弹药
   * 的修正都在里面）；测试或别的宿主可以从 deps.remoteModuleAttributes 注入。
   */
  function remoteAttributeBuilder() {
    const injected = deps && (deps.remoteModuleAttributes || deps.liveModuleAttributes);
    if (injected && typeof injected.buildLiveModuleAttributeMap === "function") {
      return injected;
    }
    if (remoteAttributeApi !== undefined) {
      return remoteAttributeApi;
    }
    try {
      remoteAttributeApi = require(path.join(host.SERVER_DIR, "space", "modules", "liveModuleAttributes.js"));
    } catch (_error) {
      remoteAttributeApi = null;
    }
    return remoteAttributeApi;
  }

  function remoteSnapshotInputs(entry, entity, moduleItem) {
    const characterID = Number(entry && entry.characterID) || 0;
    const shipID = Number(entry && entry.shipID) || 0;
    const fitting = deps && deps.fitting;
    const shipItem = deps && deps.itemStore && typeof deps.itemStore.findShipItemById === "function"
      ? deps.itemStore.findShipItemById(shipID)
      : null;
    let fittedItems = [];
    try {
      fittedItems = fitting && typeof fitting.getFittedModuleItems === "function"
        ? fitting.getFittedModuleItems(characterID, shipID) || []
        : [];
    } catch (_error) {
      fittedItems = [];
    }
    const flagID = Number(moduleItem && moduleItem.flagID) || 0;
    let chargeItem = null;
    try {
      chargeItem = fitting && flagID > 0 && typeof fitting.getLoadedChargeByFlag === "function"
        ? fitting.getLoadedChargeByFlag(characterID, shipID, flagID)
        : null;
    } catch (_error) {
      chargeItem = null;
    }
    let skillMap = null;
    try {
      const skills = deps && deps.skillState;
      skillMap = skills && typeof skills.getCachedCharacterSkillMap === "function"
        ? skills.getCachedCharacterSkillMap(characterID)
        : null;
    } catch (_error) {
      skillMap = null;
    }
    // 会战/后勤/工业核心对维修量的加成靠激活上下文施加，不传就算成「没吃加成」。
    let activeModuleContexts = null;
    const view = deps && deps.dogmaView;
    try {
      if (view && typeof view.getEntityRuntimeActiveModuleContexts === "function" && entity) {
        activeModuleContexts = view.getEntityRuntimeActiveModuleContexts(entity, {
          excludeModuleID: Number(moduleItem && moduleItem.itemID) || 0,
        });
      }
    } catch (_error) {
      activeModuleContexts = null;
    }
    return {characterID, shipID, shipItem, fittedItems, chargeItem, skillMap, activeModuleContexts};
  }

  /** 一块遥修模块的属性快照（吃技能/会战/辅助弹药），走 5 秒 TTL 的快照缓存。 */
  function remoteAttributeSnapshotFor(entry, entity, moduleItem) {
    if (!moduleItem) {
      return null;
    }
    const inputs = remoteSnapshotInputs(entry, entity, moduleItem);
    const cacheRequest = {
      characterID: inputs.characterID,
      shipID: inputs.shipID,
      moduleItem,
      chargeItem: inputs.chargeItem,
    };
    const cached = snapshotCache.get(cacheRequest);
    if (cached) {
      return cached;
    }
    const builder = remoteAttributeBuilder();
    if (!builder || typeof builder.buildLiveModuleAttributeMap !== "function" || !inputs.shipItem) {
      return null;
    }
    let attributes = null;
    try {
      attributes = builder.buildLiveModuleAttributeMap(
        inputs.shipItem,
        moduleItem,
        inputs.chargeItem,
        inputs.skillMap,
        inputs.fittedItems,
        inputs.activeModuleContexts,
      ) || null;
    } catch (_error) {
      attributes = null;
    }
    if (!attributes || Object.keys(attributes).length === 0) {
      return null;
    }
    snapshotCache.set(cacheRequest, attributes);
    return attributes;
  }

  /** 候选过滤（与 pickTarget 同口径）：不修自己 / 跃迁中 / 堡垒会战 / 超距。 */
  function remoteSalvoCandidateOk(candidate, selfShipID) {
    const entity = candidate && candidate.entity;
    if (!entity) {
      return false;
    }
    if (Number(entity.itemID) === Number(selfShipID)) {
      return false;
    }
    if (String(entity.mode || "").toUpperCase() === "WARP") {
      return false;
    }
    if (candidate.inSiege === true) {
      return false;
    }
    const range = Number(candidate.rangeMeters) || 0;
    const distance = Number(candidate.distanceMeters);
    return !(range > 0 && Number.isFinite(distance) && distance > range);
  }

  /**
   * 选唯一目标：玩家与友军同权 → 谁的那一层最低（=最早跌破门槛）就先修；
   * 平手取 deficitOf 更大的那个（缺口大的先修）。
   */
  function pickRemoteSalvoTarget(family, candidates, startPercent, selfShipID) {
    const spec = remoteAssist.familySpec(family);
    if (!spec) {
      return null;
    }
    const threshold = Number.isFinite(Number(startPercent)) ? Number(startPercent) : 0.8;
    let best = null;
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      if (!remoteSalvoCandidateOk(candidate, selfShipID)) {
        continue;
      }
      const ratio = remoteAssist.layerRatio(candidate.health || remoteAssist.healthOf(candidate.entity), spec.layer);
      if (!(ratio < threshold)) {
        continue;
      }
      const deficit = remoteSalvo.deficitOf(candidate.entity);
      const better = !best
        || ratio < best.ratio - 1e-6
        || (Math.abs(ratio - best.ratio) <= 1e-6 && deficit > best.deficit + 1e-6);
      if (better) {
        best = {row: candidate, ratio, deficit};
      }
    }
    return best ? {...best.row, ratio: best.ratio, deficit: best.deficit} : null;
  }

  /**
   * 电容照扣：优先走引擎的 entityCapacitor（会持久化 / 通知客户端），
   * 宿主没给就按容量比例自己扣；扣不起返回 false（这一轮不结算）。
   */
  function payRemoteCapacitor(entity, amount) {
    const need = Number(amount) || 0;
    if (need <= 0) {
      return true;
    }
    const capacitor = deps && deps.entityCapacitor;
    try {
      if (capacitor && typeof capacitor.consumeEntityCapacitor === "function") {
        return capacitor.consumeEntityCapacitor(entity, need) !== false;
      }
    } catch (_error) {
      return false;
    }
    const capacity = Number(entity && entity.capacitorCapacity) || 0;
    if (capacity <= 0) {
      return true;
    }
    const before = remoteSalvo.clamp01(entity.capacitorChargeRatio === undefined ? 1 : entity.capacitorChargeRatio);
    if (before * capacity + 1e-6 < need) {
      return false;
    }
    entity.capacitorChargeRatio = remoteSalvo.clamp01((before * capacity - need) / capacity);
    return true;
  }

  /**
   * 遥修特效：齐射式结算**不激活模块**，引擎那条「激活 → 广播 OnSpecialFX」的链路
   * 也就不会跑 —— 客户端看不到维修/传电光束。这里自己补一次广播。
   * guid 取模块 effect 记录里的 SDE guid（dogmaeffects.guid），取不到用族的固定值。
   */
  const REMOTE_FX_GUIDS = {
    remoteShield: "effects.ShieldTransfer",
    remoteArmor: "effects.RemoteArmourRepair",
    remoteHull: "effects.RemoteHullRepair",
    remoteCapacitor: "effects.EnergyTransfer",
  };
  const REMOTE_FX_EFFECT_PATTERNS = {
    remoteShield: /remoteshieldbooster/i,
    remoteArmor: /remotearmorrepairer/i,
    remoteHull: /remotehullrepairer/i,
    remoteCapacitor: /remotecapacitortransmitter/i,
  };

  function remoteFxGuidFor(family, moduleItem) {
    const fitting = deps && deps.fitting;
    const typeID = Number(moduleItem && moduleItem.typeID) || 0;
    try {
      if (fitting && typeID > 0 && typeof fitting.getTypeEffectRecords === "function") {
        const records = (fitting.getTypeEffectRecords(typeID) || [])
          .filter((record) => record && String(record.guid || "").trim());
        const pattern = REMOTE_FX_EFFECT_PATTERNS[family] || null;
        const matched = pattern
          ? records.find((record) => pattern.test(String(record.effectName || record.name || "")))
          : null;
        if (matched) {
          return String(matched.guid).trim();
        }
        if (records.length > 0) {
          return String(records[0].guid).trim();
        }
      }
    } catch (_error) {
      /* 落到族的固定 guid */
    }
    return REMOTE_FX_GUIDS[family] || "";
  }

  /** 每块模块一条光束；duration = 本周期、repeat = 1，自己到期，不需要 stop。 */
  function broadcastRemoteSalvoFx(scene, entity, family, modules, targetID, durationMs) {
    if (!scene || typeof scene.broadcastSpecialFx !== "function" || !entity) {
      return 0;
    }
    let sent = 0;
    for (const moduleItem of modules) {
      const guid = remoteFxGuidFor(family, moduleItem);
      if (!guid) {
        continue;
      }
      try {
        scene.broadcastSpecialFx(entity.itemID, guid, {
          moduleID: Number(moduleItem.itemID) || null,
          moduleTypeID: Number(moduleItem.typeID) || null,
          targetID: Number(targetID) || null,
          start: true,
          active: true,
          duration: Math.max(1, Number(durationMs) || 0),
          repeat: 1,
        }, entity);
        sent += 1;
      } catch (_error) {
        /* 表现层失败不影响结算 */
      }
    }
    return sent;
  }

  /**
   * 导弹/鱼雷齐射的发射特效：**每门发射器一条**（MissileDeployment / TorpedoDeployment）。
   * 以前是每组一条、moduleID 只填第一门，客户端只有一门发射器有动作。
   * 现在走引擎自己的 `buildMissileDeploymentSpecialFxOptions`（时间戳/可见性和武器周期
   * 同一套规则）。真正飞出去的弹体由 nfCrewMiningMissileFx 的零伤害球提供。
   */
  function broadcastVolleyFx(scene, entity, targetID, volley) {
    if (!scene || typeof scene.broadcastSpecialFx !== "function" || !entity || !volley) {
      return 0;
    }
    const groups = Array.isArray(volley.fxGroups) ? volley.fxGroups : [];
    if (groups.length === 0) {
      return 0;
    }
    const send = deps && deps.sendOptions;
    const buildOptions = send && typeof send.buildMissileDeploymentSpecialFxOptions === "function"
      ? send.buildMissileDeploymentSpecialFxOptions
      : null;
    const duration = Math.min(2000, Math.max(400, Number(volley.cycleMs) || 1000));
    let sent = 0;
    for (const group of groups) {
      const guid = String((group && group.guid) || "");
      if (!guid) {
        continue;
      }
      // 新格式带 modules（全组发射器）；老调用方只有 moduleItem 就发一条。
      const modules = Array.isArray(group.modules) && group.modules.length > 0
        ? group.modules
        : [group.moduleItem];
      for (const moduleItem of modules) {
        if (!moduleItem) {
          continue;
        }
        const options = {
          moduleID: Number(moduleItem.itemID) || null,
          moduleTypeID: Number(moduleItem.typeID) || null,
          targetID: Number(targetID) || null,
          chargeTypeID: Number(group.chargeTypeID) || null,
          isOffensive: true,
          start: true,
          active: true,
          duration,
          repeat: 0,
        };
        try {
          scene.broadcastSpecialFx(
            entity.itemID,
            guid,
            buildOptions ? buildOptions(options) : options,
            entity,
          );
          sent += 1;
        } catch (_error) {
          /* 表现层失败不影响结算 */
        }
      }
    }
    return sent;
  }

  /** 百分比标签：80 / 79.6（75.0 这种整数不显示小数）。 */
  function remotePercentLabel(ratio) {
    const percent = (Number(ratio) || 0) * 100;
    return Math.abs(percent - Math.round(percent)) < 0.05
      ? String(Math.round(percent))
      : percent.toFixed(1);
  }

  /**
   * 齐射式遥修：每个族选 1 个目标、按模块数一次结算，电容照扣，写完刷新派生状态 + 广播特效。
   * 返回实际结算的族数（用于诊断）。
   */
  function syncRemoteSalvoFor(entry, session, scene, context) {
    const crewID = Number(entry && entry.characterID) || 0;
    const entity = context.entity;
    const selfShipID = Number(entity && entity.itemID) || 0;
    const byFamily = new Map();
    for (const row of context.rows) {
      if (!byFamily.has(row.family)) {
        byFamily.set(row.family, []);
      }
      byFamily.get(row.family).push(row.moduleItem);
    }
    let families = 0;
    for (const [family, modules] of byFamily) {
      const spec = remoteAssist.familySpec(family);
      if (!spec) {
        continue;
      }
      // 从逐模块模式切过来时，船上可能还挂着引擎激活的模块：先关掉（齐射不激活模块）。
      let running = 0;
      for (const item of modules) {
        if (!remoteAssist.isActive(entity, item.itemID)) {
          continue;
        }
        remoteAssist.deactivate({scene, session: context.moduleSession, entity, moduleID: item.itemID});
        running += 1;
      }
      if (running > 0) {
        logCombatOnce(crewID, Number(modules[0] && modules[0].itemID) || 0, `remote:salvo:off:${family}`,
          `[remote] ${entry.name} ${spec.label} 切到齐射结算（关闭 ${running} 块已激活模块）`);
      }
      // 自身电容低于地板：只停手，不结算（与逐模块路径同语义）。
      if (!context.ownCapOk) {
        continue;
      }
      if (family === remoteAssist.FAMILY_CAPACITOR && Number.isFinite(context.ownCap) && context.ownCap < context.capSelfMin) {
        continue;
      }
      const gateKey = `${crewID}:${family}`;
      if (now() < (Number(remoteSalvoNextAt.get(gateKey)) || 0)) {
        continue;
      }
      const rangeForFamily = modules.reduce((max, item) => Math.max(max, activeModules.rangeMetersFor(deps, item)), 0);
      const candidates = remoteCandidatesFor(scene, session, entry, entity).map((row) => ({
        ...row,
        health: remoteAssist.healthOf(row.entity),
        distanceMeters: combat.surfaceDistance(entity, row.entity),
        rangeMeters: rangeForFamily,
        inSiege: modeModule.isModeActive(row.entity),
      }));
      const startPercent = family === remoteAssist.FAMILY_CAPACITOR ? context.capStart : context.startPercent;
      // 80% 起、95% 停：已经在这个族的目标上就修到 95%（不然每 2.5 秒重新挑一次目标，
      // 79.9% 修一下就跳到 84%，等于只修一次）。
      let target = null;
      const heldID = Number(remoteSalvoTargets.get(gateKey)) || 0;
      if (heldID) {
        const held = candidates.find((row) => Number(row.entity.itemID) === heldID);
        if (held && remoteSalvoCandidateOk(held, selfShipID)) {
          const ratio = remoteAssist.layerRatio(held.health, spec.layer);
          if (ratio < context.stopPercent) {
            target = {...held, ratio, deficit: remoteSalvo.deficitOf(held.entity)};
          }
        }
      }
      if (!target) {
        target = pickRemoteSalvoTarget(family, candidates, startPercent, selfShipID);
        if (target) {
          remoteSalvoTargets.set(gateKey, Number(target.entity.itemID));
        } else {
          remoteSalvoTargets.delete(gateKey);
        }
      }
      if (!target) {
        continue;
      }
      const amountID = remoteAttributeId(spec.layer);
      const capNeedID = remoteAttributeId("capNeed");
      const durationID = remoteAttributeId("duration");
      const sums = {amount: 0, capNeed: 0, durationMs: 0, modules: 0};
      for (const moduleItem of modules) {
        const attributes = remoteAttributeSnapshotFor(entry, entity, moduleItem);
        if (!attributes) {
          continue;
        }
        sums.amount += Math.max(0, Number(attributes[amountID]) || 0);
        sums.capNeed += Math.max(0, Number(attributes[capNeedID]) || 0);
        sums.durationMs = Math.max(sums.durationMs, Math.max(0, Number(attributes[durationID]) || 0));
        sums.modules += 1;
      }
      if (sums.modules === 0) {
        logCombatOnce(crewID, Number(modules[0] && modules[0].itemID) || 0, `remote:salvo:noattr:${family}`,
          `[remote] ${entry.name} ${spec.label} 取不到模块属性快照，这一轮跳过`);
        continue;
      }
      const targetID = Number(target.entity.itemID) || 0;
      if (!payRemoteCapacitor(entity, sums.capNeed)) {
        logCombatOnce(crewID, targetID, `remote:salvo:cap:${family}`,
          `[remote] ${entry.name} ${spec.label} 电容不足（需要 ${Math.round(sums.capNeed)}），这一轮不结算`);
        continue;
      }
      // 一个周期结束：下一次结算要等模块自己的 duration。
      const cycleMs = Math.max(REMOTE_RETRY_MS, Number(sums.durationMs) || 0);
      remoteSalvoNextAt.set(gateKey, now() + cycleMs);
      let applied;
      if (family === remoteAssist.FAMILY_CAPACITOR) {
        applied = {
          shield: 0,
          armor: 0,
          hull: 0,
          capacitor: remoteSalvo.applyCapacitorToEntity(target.entity, sums.amount),
        };
      } else {
        applied = remoteSalvo.applyRepairToEntity(target.entity, {
          shield: spec.layer === "shield" ? sums.amount : 0,
          armor: spec.layer === "armor" ? sums.amount : 0,
          hull: spec.layer === "structure" ? sums.amount : 0,
        });
      }
      const healed = (Number(applied.shield) || 0) + (Number(applied.armor) || 0)
        + (Number(applied.hull) || 0) + (Number(applied.capacitor) || 0);
      if (healed > 0) {
        // 层值写完必须让引擎重算派生状态，否则客户端血条 / 服务端缓存都是旧值。
        if (scene && typeof scene.refreshShipEntityDerivedState === "function") {
          try {
            scene.refreshShipEntityDerivedState(target.entity, {broadcast: true});
          } catch (_error) {
            /* 渲染层的事，不影响结算 */
          }
        }
        // 齐射不激活模块 → 引擎不会广播光束，这里自己补（duration = 本周期）。
        broadcastRemoteSalvoFx(scene, entity, family, modules, targetID, cycleMs);
      }
      families += 1;
      const ratioLabel = remotePercentLabel(target.ratio);
      const startLabel = remotePercentLabel(startPercent);
      const progress = (Number(target.ratio) || 0) < startPercent
        ? `${ratioLabel}% < ${startLabel}%`
        : `${ratioLabel}%（已开始，修到 ${remotePercentLabel(context.stopPercent)}%）`;
      logCombatOnce(crewID, targetID, `remote:salvo:${family}`,
        `[remote] ${entry.name} ${spec.label} → ${target.name || ("#" + targetID)}` +
        `（${remoteLayerLabel(spec.layer)} ${progress}，${sums.modules} 块 · +${Math.round(healed)}）`);
    }
    return families;
  }

  function syncRemoteFor(entry, session, scene) {
    const crewID = Number(entry && entry.characterID) || 0;
    const entity = scene && typeof scene.getEntityByID === "function" ? scene.getEntityByID(entry.shipID) : null;
    if (!entity) {
      return;
    }
    const rows = remoteModulesFor(entry);
    if (rows.length === 0) {
      return;
    }
    const behavior = configs_behavior();
    const moduleSession = mining.moduleSessionFor(session, crewID, entity);
    // 用户口径（2026-10-20）：遥修不设玩家开关 —— 装了就一直按安全规则自动用。
    const ownCap = Number(entity.capacitorChargeRatio);
    const capFloor = Number.isFinite(Number(behavior.remoteCapFloorPercent)) ? Number(behavior.remoteCapFloorPercent) : 0.2;
    const startPercent = Number.isFinite(Number(behavior.remoteRepairStartPercent)) ? Number(behavior.remoteRepairStartPercent) : 0.8;
    const stopPercent = Number.isFinite(Number(behavior.remoteRepairStopPercent)) ? Number(behavior.remoteRepairStopPercent) : 0.95;
    const capStart = Number.isFinite(Number(behavior.remoteCapTransferStartPercent))
      ? Number(behavior.remoteCapTransferStartPercent)
      : 0.5;
    const capSelfMin = Number.isFinite(Number(behavior.remoteCapTransferSelfMinPercent))
      ? Number(behavior.remoteCapTransferSelfMinPercent)
      : 0.6;
    const ownCapOk = !Number.isFinite(ownCap) || ownCap >= capFloor;
    // 路线 A（PLAN §18.29）：齐射式结算，默认开。判断依据是「能不能建出模块属性快照」——
    // 拿不到（没有船物品 / 宿主没给构建器）就退回逐模块激活，宁可慢也不要让遥修停摆。
    // 探测本身 30 秒一次：建不出快照时别每 2.5 秒重试一遍 dogma。
    if (behavior.remoteRepairSalvo !== false) {
      const probeAt = Number(remoteSalvoProbeAt.get(crewID)) || 0;
      let ready = remoteSalvoProbeOk.get(crewID) === true;
      if (now() - probeAt >= 30000) {
        remoteSalvoProbeAt.set(crewID, now());
        ready = Boolean(rows[0] ? remoteAttributeSnapshotFor(entry, entity, rows[0].moduleItem) : null);
        remoteSalvoProbeOk.set(crewID, ready);
      }
      if (ready) {
        syncRemoteSalvoFor(entry, session, scene, {
          entity,
          moduleSession,
          rows,
          ownCap,
          ownCapOk,
          startPercent,
          stopPercent,
          capStart,
          capSelfMin,
        });
        return;
      }
    }
    const byFamily = new Map();
    for (const row of rows) {
      if (!byFamily.has(row.family)) {
        byFamily.set(row.family, []);
      }
      byFamily.get(row.family).push(row.moduleItem);
    }
    for (const [family, modules] of byFamily) {
      const spec = remoteAssist.familySpec(family);
      if (!spec) {
        continue;
      }
      // 每族可能有多个模块（例如两颗护盾遥修）。先按"该停的都停"清理，再做分配。
      const runningRows = [];
      for (const item of modules) {
        const state = remoteAssist.effectStateOf(entity, item.itemID);
        if (state) {
          runningRows.push({item, state});
        }
      }
      const stopModule = (row, why) => {
        remoteAssist.deactivate({scene, session: moduleSession, entity, moduleID: row.item.itemID});
        const target = Number(row.state && row.state.targetID) || 0;
        if (target) {
          remoteClaims.delete(`${family}:${target}`);
        }
        if (why) {
          logCombatOnce(crewID, row.item.itemID, `remote:stop:${family}:${why}`,
            `[remote] ${entry.name} ${spec.label} 停（${why}）`);
        }
      };
      if (!ownCapOk) {
        for (const row of runningRows) {
          stopModule(row, `自身电容 ${Math.round(ownCap * 100)}% 低于地板 ${Math.round(capFloor * 100)}%`);
        }
        continue;
      }
      const rangeForFamily = modules.reduce((max, item) => Math.max(max, activeModules.rangeMetersFor(deps, item)), 0);
      for (const row of runningRows) {
        const targetID = Number(row.state && row.state.targetID) || 0;
        const targetEntity = targetID ? scene.getEntityByID(targetID) : null;
        let why = "";
        if (!targetEntity) {
          why = "目标已不在";
        } else if (modeModule.isModeActive(targetEntity) && targetID !== Number(entity.itemID)) {
          why = "目标进入会战/堡垒，收不到遥修";
        } else {
          const ratio = remoteAssist.layerRatio(remoteAssist.healthOf(targetEntity), spec.layer);
          if (ratio >= stopPercent) {
            why = `${remoteLayerLabel(spec.layer)}已到 ${Math.round(ratio * 100)}%`;
          } else if (rangeForFamily > 0 && combat.surfaceDistance(entity, targetEntity) > rangeForFamily * 1.1) {
            why = `目标超出射程 ${Math.round(combat.surfaceDistance(entity, targetEntity) / 1000)}km`;
          }
        }
        if (why) {
          stopModule(row, why);
        }
      }
      if (family === remoteAssist.FAMILY_CAPACITOR && Number.isFinite(ownCap) && ownCap < capSelfMin) {
        continue;
      }
      const stillRunning = modules
        .map((item) => ({item, state: remoteAssist.effectStateOf(entity, item.itemID)}))
        .filter((row) => row.state);
      const freeModules = modules.filter((item) => !remoteAssist.isActive(entity, item.itemID)
        && (Number(remoteRetryAfter.get(Number(item.itemID))) || 0) <= now());
      if (freeModules.length === 0) {
        continue;
      }
      const candidates = remoteCandidatesFor(scene, session, entry, entity).map((row) => ({
        ...row,
        health: remoteAssist.healthOf(row.entity),
        distanceMeters: combat.surfaceDistance(entity, row.entity),
        rangeMeters: rangeForFamily,
        inSiege: modeModule.isModeActive(row.entity),
      }));
      // 认领只挡"别人"；自己已经占着的目标当然可以继续挂（否则两颗模块没法叠同一个目标）。
      const claimedByOthers = new Set();
      for (const [key, owner] of remoteClaims) {
        if (Number(owner) !== crewID) {
          claimedByOthers.add(key);
        }
      }
      const available = remoteAssist.pickTargets({
        family,
        candidates,
        startPercent: family === remoteAssist.FAMILY_CAPACITOR ? capStart : startPercent,
        selfShipID: Number(entity.itemID),
        claimed: claimedByOthers,
      });
      if (available.length === 0) {
        continue;
      }
      // 用户口径：多个目标缺同一层 → 一个模块对一个目标；只剩一个目标 → 所有模块都给他。
      // 已经被别的模块覆盖的目标排到后面，避免"两个都修同一个、第二个人没人管"。
      const covered = new Set(stillRunning.map((row) => Number(row.state && row.state.targetID) || 0));
      const ordered = available
        .filter((cand) => !covered.has(Number(cand.entity.itemID)))
        .concat(available.filter((cand) => covered.has(Number(cand.entity.itemID))));
      for (let index = 0; index < freeModules.length; index += 1) {
        const moduleItem = freeModules[index];
        const target = ordered[Math.min(index, ordered.length - 1)];
        if (!target) {
          break;
        }
        const locked = combat.ensureTargetLock({scene, entity, target: target.entity, instant: instantLockEnabled()});
        if (!locked || locked.ok !== true) {
          logCombatOnce(crewID, moduleItem.itemID, `remote:lock:${locked && locked.reason}`,
            `[remote] ${entry.name} ${spec.label} 锁定失败：${(locked && locked.reason) || "UNKNOWN"}`);
          continue;
        }
        const result = remoteAssist.activate({
          scene,
          session: moduleSession,
          entity,
          moduleItem,
          targetID: Number(target.entity.itemID),
        });
        if (!result.ok) {
          if (/MODULE_REACTIVATING/.test(String(result.reason))) {
            // 引擎冷却中：3 秒后再试，不当失败、不刷日志。
            remoteRetryAfter.set(Number(moduleItem.itemID), now() + 3000);
            continue;
          }
          logCombatOnce(crewID, moduleItem.itemID, `remote:${result.reason}`,
            `[remote] ${entry.name} ${spec.label} 启动失败：${result.reason}`);
          continue;
        }
        markKeepOnStop(entity, moduleItem);
        remoteClaims.set(`${family}:${Number(target.entity.itemID)}`, crewID);
        log(`[remote] ${entry.name} ${spec.label} → ${target.name || ("#" + target.entity.itemID)}`
          + `（${remoteLayerLabel(spec.layer)} ${Math.round((Number(target.ratio) || 0) * 100)}% < ${Math.round((family === remoteAssist.FAMILY_CAPACITOR ? capStart : startPercent) * 100)}%）`);
      }
    }
  }

  /** 遥修每秒一次：白名单挑目标 → 锁定 → 挂模块；修满/进模式/超距/低电就停。 */
  function syncRemoteAssist(scene, session, summoned) {
    for (const entry of summoned) {
      const crewID = Number(entry.characterID) || 0;
      const at = Number(remoteAppliedAt.get(crewID)) || 0;
      if (now() - at < REMOTE_RETRY_MS) {
        continue;
      }
      remoteAppliedAt.set(crewID, now());
      syncRemoteFor(entry, session, scene);
    }
  }
  /** 面板/命令：切一个人的一件特殊装备（kind 也接受 "all"）。 */
  function setSpecial(characterID, kind, on, context = {}) {
    const wanted = Number(characterID) || 0;
    const entry = (stateStore.get().pool || []).find((row) => Number(row.characterID) === wanted);
    if (!entry) {
      return {ok: false, error: "NO_SUCH_CREW", message: `没找到船员：${wanted}`};
    }
    const available = availableSpecialKinds(entry);
    if (available.size === 0) {
      return {
        ok: false,
        error: "NO_MODE_MODULE",
        message: `${entry.name}：装配里没有可切换的特殊装备（会战/堡垒 组 515，或立体炸弹 组 72）`,
      };
    }
    const kinds = kind === "all" ? [...available] : [kind];
    if (kinds.length === 0 || kinds.some((value) => !SPECIAL_KINDS.has(value))) {
      return {ok: false, error: "BAD_KIND", message: `${entry.name}：未知的特殊装备类型 ${kind}`};
    }
    const session = context.session || serviceSession || null;
    const scene = follow.sceneFor(deps, session);
    const messages = [];
    let applied = 0;
    let failure = null;
    // 引擎说"重激活中"时不算失败（开关保持、5 s 后重试），但要在返回值里标明是排队，
    // 否则面板只能看到 ok:true 而分不清"已启动"和"还要等"。
    let pending = false;
    for (const one of kinds) {
      if (!available.has(one)) {
        messages.push(`${entry.name}：装配里没有${specialLabel(one)}`);
        continue;
      }
      if (!persistSpecialFlag(wanted, one, on)) {
        return {ok: false, error: "NO_SUCH_CREW"};
      }
      const current = (stateStore.get().pool || []).find((row) => Number(row.characterID) === wanted) || entry;
      if (!scene) {
        messages.push(`${entry.name}：${specialLabel(one)}${on ? "将启动" : "将关闭"}（回到太空后生效）`);
        applied += 1;
        continue;
      }
      // 冲突/反对回滚：启动被拒时把开关退回原位，避免每 5 秒重试一次注定失败的开启。
      const result = one === "smartbomb"
        ? applySmartbombFor(current, session, scene)
        : applySpecialKind(current, one, session, scene);
      if (!result.ok && /MODULE_REACTIVATING/.test(String(result.reason))) {
        // 引擎说「刚切过、正在重激活」：不是失败。保持开关，下一轮再试。
        pending = true;
        messages.push(`${entry.name}：${specialLabel(one)}正在重激活，稍后重试`);
        applied += 1;
        continue;
      }
      if (!result.ok) {
        persistSpecialFlag(wanted, one, on !== true);
        failure = result.reason;
        messages.push(`${entry.name}：${specialLabel(one)}${on ? "启动失败" : "关闭失败"}（${result.reason}）`);
        continue;
      }
      applied += 1;
      if (one === "smartbomb") {
        messages.push(`${entry.name}：立体炸弹` +
          (on ? (result.active ? "已开启" : "已允许（当前没有安全目标，待机）") : "已关闭"));
        continue;
      }
      messages.push(`${entry.name}：${specialLabel(one)}` +
        `${on ? (result.already ? "本来就是开的" : "已启动") : (result.already ? "本来就是关的" : "已关闭")}`);
    }
    return {
      ok: applied > 0,
      characterID: wanted,
      active: on === true,
      // true = 引擎还在重激活锁里，指令已排队（不是失败）。
      pending,
      error: applied > 0 ? undefined : (failure || "FAILED"),
      messages,
      message: messages.join("\n"),
    };
  }

  /** 一对多：`/crewmine special all bastion on`、面板「全部启动/全部关闭」。 */
  function setAllSpecial(kind, on, context = {}, selector = "all") {
    const targets = specialTargets(selector);
    if (targets.length === 0) {
      return {ok: false, error: "NO_SUMMONED_CREW", message: `没有在役船员${selector && selector !== "all" ? `：${selector}` : ""}`};
    }
    let changed = 0;
    let pending = 0;
    let skipped = 0;
    const problems = [];
    for (const entry of targets) {
      const result = setSpecial(entry.characterID, kind, on, context);
      if (result.ok) {
        changed += 1;
        if (result.pending === true) {
          pending += 1;
        }
        continue;
      }
      skipped += 1;
      if (result.error !== "NO_MODE_MODULE") {
        problems.push(`${entry.name}:${result.error || "FAILED"}`);
      }
      if (result.message) {
        problems.push(...String(result.message).split("\n"));
      }
    }
    const kindLabel = kind === "all"
      ? "会战/堡垒"
      : (modeModule.MODE_KINDS[kind] ? modeModule.MODE_KINDS[kind].moduleLabel : kind);
    return {
      ok: changed > 0,
      changed,
      pending,
      skipped,
      problems,
      value: on === true,
      message: `${on === true ? "全部启动" : "全部关闭"}${kindLabel}：${changed} 人` +
        `${skipped > 0 ? `，${skipped} 人没有可切换的装备` : ""}` +
        `${problems.length > 0 ? ` · ${problems.slice(0, 4).join(" · ")}` : ""}`,
    };
  }

  /** `/crewmine special` 无参数：谁有特殊装备、现在什么状态。 */
  function specialReport() {
    const summoned = (stateStore.get().pool || []).filter((entry) => entry.summoned === true);
    if (summoned.length === 0) {
      return "没有在役船员";
    }
    const scene = follow.sceneFor(deps, serviceSession || null);
    const lines = [];
    for (const entry of summoned) {
      const entity = scene && typeof scene.getEntityByID === "function" ? scene.getEntityByID(entry.shipID) : null;
      const state = specialStateOf(entry);
      for (const moduleItem of modeModulesFor(entry)) {
        const info = modeModule.modeKindOf(deps, moduleItem);
        if (!info.kind) {
          continue;
        }
        const active = modeModuleIsOn(entity, moduleItem, modeModule.activeModeKindOf(entity), info.kind);
        // 引擎的重激活锁还没到期时，命令行也要说清楚（不然玩家只会看到"点了没反应"）。
        const lockLeftMs = reactivationLockRemainingMs(scene, entity, moduleItem.itemID);
        const lockText = !active && lockLeftMs > 0
          ? `（引擎重激活中 ${Math.ceil(lockLeftMs / 1000)} 秒）`
          : (state[info.kind] && !active ? "（等待生效）" : "");
        lines.push(`${entry.name} · ${info.moduleLabel}（${moduleItem.itemName || info.kind}）` +
          ` · ${active ? "已启动" : "已关闭"}${lockText}` +
          ` · 惩罚：${info.penalty.join(" / ")}`);
      }
      // 遥修（组 41/325/585/67）：一行说清谁装了哪几族、允不允许、在修谁。
      for (const row of remoteModulesFor(entry)) {
        const familySpec = remoteAssist.familySpec(row.family);
        const active = remoteAssist.effectStateOf(entity, row.moduleItem.itemID);
        lines.push(`${entry.name} · ${familySpec.label}（${row.moduleItem.itemName || familySpec.moduleLabel}）`
          + ` · ${active ? `正在修 #${Number(active.targetID) || 0}` : "待机（血量/电容都够）"}`);
      }
      // 立体炸弹（组 72）：玩家开关 + 安全条件，单独一行。
      for (const row of smartbombModulesFor(entry)) {
        const active = activeModules.isActive(entity, row.moduleItem.itemID);
        lines.push(`${entry.name} · 立体炸弹（${row.moduleItem.itemName || "smartbomb"}）` +
          ` · ${active ? "已开火" : (state.smartbomb ? "已允许（待机）" : "已关闭")}` +
          " · 惩罚：会伤到范围内的所有船");
        break;
      }
    }
    const usage = "用法：/crewmine special <名字|all> <bastion|siege|triage|core|smartbomb|doomsday> on|off";
    if (lines.length === 0) {
      return `在役船员里没有可切换的特殊装备（会战/堡垒 组 515，立体炸弹 组 72）\n${usage}`;
    }
    return [`特殊装备：${lines.length} 条`, ...lines, usage].join("\n");
  }

  /**
   * 这块模式模块现在是不是真在跑。
   *
   * 口径分两层，缺一不可：
   *   1) 优先直接看**这块模块自己的 itemID** 在不在 `entity.activeModuleEffects` 里 ——
   *      这也是 `[behave] 模块运行:N` 数的口径，不依赖任何名字/型号推断；
   *   2) 兜底才用"当前激活的是不是这一类"（`activeModeKindOf`），覆盖引擎把状态挂在
   *      别的 key 上的情况。
   *
   * 之前只用了第 2 条，实测会战明明在跑（日志有 `启动`、`模块运行:3`），面板却一直是
   * "开会战" —— 因为 `activeModeKindOf()` 在真实 effectState 上没返回 "siege"。
   */
  function modeModuleIsOn(entity, moduleItem, activeKind, kind) {
    const moduleID = Number(moduleItem && moduleItem.itemID) || 0;
    if (
      moduleID
      && entity
      && entity.activeModuleEffects instanceof Map
      && entity.activeModuleEffects.has(moduleID)
    ) {
      return true;
    }
    return Boolean(activeKind && kind && activeKind === kind);
  }

  /** entity 上当前所有 effect id（面板诊断用）。 */
  function activeEffectIdsOf(entity) {
    if (!entity || !(entity.activeModuleEffects instanceof Map)) {
      return [];
    }
    return [...entity.activeModuleEffects.keys()].map((id) => Number(id) || 0).filter(Boolean);
  }

  /**
   * 引擎的「重激活锁」还剩多少毫秒（会战/堡垒刚关闭时的那段封锁）。
   *
   * 引擎在模块关闭时把到期时刻写进 `entity.moduleReactivationLocks`
   * （`space/runtime/scene/modules.js:973-980`：`stopTimeMs + effectState.reactivationDelayMs`），
   * 激活时用 `lockUntil > scene.getCurrentSimTimeMs()` 拒绝（`:724-734` → `MODULE_REACTIVATING`）。
   *
   * ⚠️ 它记的是**模拟时间**，必须和 `scene.getCurrentSimTimeMs()` 相减，不能用墙钟——
   * 否则时间膨胀时倒计时会偏快。
   */
  function reactivationLockRemainingMs(scene, entity, moduleID) {
    const id = Number(moduleID) || 0;
    if (!id || !entity || !(entity.moduleReactivationLocks instanceof Map)) {
      return 0;
    }
    const lockUntil = Number(entity.moduleReactivationLocks.get(id)) || 0;
    if (!(lockUntil > 0)) {
      return 0;
    }
    const simNow = scene && typeof scene.getCurrentSimTimeMs === "function"
      ? Number(scene.getCurrentSimTimeMs()) || 0
      : 0;
    if (!(simNow > 0)) {
      return 0;
    }
    return Math.max(0, lockUntil - simNow);
  }

  /**
   * 详情面板的 `special[]`（PLAN §18.4）：末日武器 + 会战/堡垒，同一个数组。
   * 每项 `{id, name, on, cooldownRemainingMs, pending, penalty[]}`（末日另带伤害/半径，供老界面读）。
   *
   * `pending` = 引擎还没放行（重激活锁未到期）；`cooldownRemainingMs` 是真实剩余毫秒（模拟时间）。
   */
  function specialModulesFor(entry, entity) {
    const crewID = Number(entry && entry.characterID) || 0;
    const list = [];
    // 重激活倒计时要用引擎的模拟时间；serviceSession 为 null 时这里拿到 null，退化成 0。
    const lockScene = follow.sceneFor(deps, serviceSession);
    const doomsdayModules = special.findDoomsdayModules(deps, {characterID: crewID, shipID: entry && entry.shipID});
    if (doomsdayModules.length > 0) {
      const behavior = configs_behavior();
      const cooldownMs = Math.max(60000, Number(behavior.doomsdayCooldownMs) || 300000);
      const readyAt = Number(doomsdayReadyAt.get(crewID)) || 0;
      const profile = special.doomsdayProfile({...deps, sde}, doomsdayModules[0]);
      list.push({
        id: "doomsday",
        name: "末日武器",
        moduleName: profile.name || String(doomsdayModules[0].itemName || ""),
        moduleTypeID: profile.typeID,
        on: false,                       // 一次性武器，没有常开状态
        readyAt,
        readyInMs: Math.max(0, readyAt - now()),
        cooldownRemainingMs: Math.max(0, readyAt - now()),
        cooldownMs,
        radiusMeters: Number(behavior.doomsdayRadiusMeters) || profile.radiusMeters,
        damage: profile.damage,
        penalty: ["长冷却"],
        hasEntity: Boolean(entity),
      });
    }
    const state = specialStateOf(entry);
    const activeKind = modeModule.activeModeKindOf(entity);
    for (const moduleItem of modeModulesFor(entry)) {
      const info = modeModule.modeKindOf(deps, moduleItem);
      if (!info.kind || list.some((row) => row.id === info.kind)) {
        continue;
      }
      const on = modeModuleIsOn(entity, moduleItem, activeKind, info.kind);
      // 引擎刚关过这颗模块时会有重激活锁；锁没过期前点了必定被拒。
      const lockRemainingMs = reactivationLockRemainingMs(lockScene, entity, moduleItem.itemID);
      const fuelDeps = {...deps, sde: (deps && deps.sde) || sde};
      const need = fuelModule.fuelNeedFor(fuelDeps, moduleItem);
      const fuelType = need ? (typeof deps.resolveItemByTypeID === "function" ? deps.resolveItemByTypeID(need.typeID) : null) : null;
      const bayCapacity = fuelModule.fuelBayCapacityOf(entity);
      const perCycleVolume = need ? need.quantity * Math.max(0, Number(fuelType && fuelType.volume) || 0) : 0;
      const cyclesMax = need && perCycleVolume > 0 && bayCapacity > 0 ? Math.floor(bayCapacity / perCycleVolume) : 0;
      const fuelHave = need
        ? fuelModule.fuelInStorage(fuelDeps, {
          characterID: crewID,
          shipID: entry && entry.shipID,
          fuelTypeID: need.typeID,
          flagID: fuelModule.fuelStorageFlagFor(entity),
        })
        : 0;
      list.push({
        id: info.kind,
        fuel: need
          ? {
            typeID: need.typeID,
            quantity: need.quantity,
            name: String((fuelType && (fuelType.itemName || fuelType.typeName)) || ""),
            perCycleVolume: Math.round(perCycleVolume * 100) / 100,
            cyclesLeft: need.quantity > 0 ? Math.floor(fuelHave / need.quantity) : 0,
            cyclesMax,
            bayFlag: fuelModule.fuelStorageFlagFor(entity),
          }
          : null,
        name: info.moduleLabel,
        moduleName: String(moduleItem.itemName || ""),
        moduleTypeID: Number(moduleItem.typeID) || 0,
        on,
        wanted: state[info.kind] === true,
        active: on,
        // 真实剩余毫秒（模拟时间）+ 是否正卡在重激活锁上（面板据此显示「重激活中 Ns」）。
        cooldownRemainingMs: lockRemainingMs,
        pending: lockRemainingMs > 0 && on !== true,
        penalty: [...info.penalty],
        hasEntity: Boolean(entity),
        // 诊断：面板"开会战/关会战"不对时，看这两个字段就知道是识别错了还是状态真没开。
        activeKind: String(activeKind || ""),
        activeEffectIds: activeEffectIdsOf(entity),
      });
    }
    // 立体炸弹（组 72）：开关语义与堡垒/会战相同，但开火还要过安全条件。
    const smartbombs = smartbombModulesFor(entry);
    if (smartbombs.length > 0) {
      const firing = smartbombs.some((row) => activeModules.isActive(entity, row.moduleItem.itemID));
      list.push({
        id: "smartbomb",
        name: "立体炸弹",
        fuel: null,
        moduleName: String(smartbombs[0].moduleItem.itemName || ""),
        moduleTypeID: Number(smartbombs[0].moduleItem.typeID) || 0,
        on: firing,
        wanted: state.smartbomb === true,
        active: firing,
        cooldownRemainingMs: 0,
        penalty: ["会伤到范围内的所有船（含友军/中立）"],
        hasEntity: Boolean(entity),
      });
    }
    return list;
  }

  /** Panel entry: fire the doomsday for one crew by character id. */
  function fireDoomsdayForCrew(characterID) {
    const wanted = Number(characterID) || 0;
    const entry = (stateStore.get().pool || []).find((row) => Number(row.characterID) === wanted);
    if (!entry) {
      return {ok: false, error: "NO_SUCH_CREW"};
    }
    const session = serviceSession || null;
    const scene = follow.sceneFor(deps, session);
    if (!scene) {
      return {ok: false, error: "NO_SCENE", message: "没有可用的星系场景（先回太空里）"};
    }
    const entity = typeof scene.getEntityByID === "function" ? scene.getEntityByID(entry.shipID) : null;
    if (!entity) {
      return {ok: false, error: "NO_ENTITY", message: "这艘船不在当前场景里"};
    }
    const outcome = fireDoomsdayFor(scene, entry, entity);
    return {ok: outcome.ok === true, message: outcome.line, targets: outcome.result ? outcome.result.targets : 0};
  }


  /**
   * 用引擎自己的模块激活路径放末日：这是客户端播放末日光束动画的唯一可靠方式。
   * 代价是一次属性重算（约 1 秒），因此只在开关打开时使用。
   */
  function activateDoomsdayNatively(scene, session, member, entity, moduleItem, profile, target) {
    if (!scene || typeof scene.activateGenericModule !== "function" || !moduleItem) {
      return {ok: false, reason: "NO_ACTIVATION_API"};
    }
    // 玩家客户端发的是全小写效果名（superweaponamarr）；用驼峰会走另一条分发分支，
    // 那条分支只广播光束、没有聚能阶段。
    const effectName = (String(profile.effectName || "")
      || String(profile.fxGuid || "").replace(/^effects\./, "")).toLowerCase();
    if (!effectName) {
      return {ok: false, reason: "NO_EFFECT_NAME"};
    }
    // 引擎要求货舱里有燃料；方案 B 说不消耗燃料，所以这里按需临时补足（引擎随后扣掉）。
    const fuelTypeID = Number(profile.fuelTypeID) || 0;
    const fuelNeed = Number(profile.fuelPerActivation) || 0;
    if (fuelTypeID > 0 && fuelNeed > 0) {
      try {
        const store = deps.itemStore;
        if (store && typeof store.grantItemToCharacterLocation === "function") {
          store.grantItemToCharacterLocation(Number(member.characterID) || 0, Number(entity.itemID) || 0, 5, fuelTypeID, fuelNeed);
        }
      } catch (_error) {
        /* 补燃料失败就让引擎报 NO_FUEL，下面回退 */
      }
    }
    // 客户端识别"超武船"靠船体属性：没有这组属性，舱门不开、聚能/散热都不演。
    const written = special.applySuperweaponEntityAttributes(entity, profile);
    if (debugMode) {
      log(`[special] ${member.name} 写入超武船体属性 ${written} 项`);
    }
    const moduleForCall = {...moduleItem, locationID: Number(entity.itemID) || moduleItem.locationID};
    const pseudoSession = mining.moduleSessionFor(session, Number(member.characterID) || 0, entity);
    try {
      const result = scene.activateGenericModule(pseudoSession, moduleForCall, effectName, {
        targetID: Number(target && target.itemID) || 0,
      });
      const ok = result === true || (result && result.success === true);
      return {ok, reason: ok ? null : String(result && (result.errorMsg || result.reason) || "ACTIVATION_REFUSED")};
    } catch (error) {
      return {ok: false, reason: String(error && error.message || "ACTIVATION_THREW")};
    }
  }

  /**
   * Fire the titan doomsday for one crew ship (Plan B: cooldown, no fuel/capacitor).
   *
   * 目标策略与炮台同源：engagementRule === "npc" 时只打原生 NPC；war/defend 时
   * 宣战目标（isWarOpponent）也算合法目标。之前这条路径永远只喂 NPC 给末日，
   * 于是炮台在打宣战目标、末日却报 NO_TARGET_IN_RANGE。
   */
  function fireDoomsdayFor(scene, member, entity) {
    const crewID = Number(member.characterID) || 0;
    const modules = special.findDoomsdayModules(deps, {characterID: crewID, shipID: member.shipID});
    if (modules.length === 0) {
      return {ok: false, line: `${member.name}：装配里没有末日武器`};
    }
    const behavior = configs_behavior();
    const cooldownMs = Math.max(60000, Number(behavior.doomsdayCooldownMs) || 300000);
    const readyAt = Number(doomsdayReadyAt.get(crewID)) || 0;
    if (now() < readyAt) {
      return {ok: false, line: `${member.name}：末日冷却中（还剩 ${Math.ceil((readyAt - now()) / 1000)} 秒）`};
    }
    const moduleItem = modules[0];
    const profile = special.doomsdayProfile({...deps, sde}, moduleItem);
    profile.fxGuid = profile.fxGuid || special.FX_BY_RACE_HULL.get(Number(entity.typeID)) || "";
    const accept = engagementRule === "npc"
      ? null
      : (candidate) => isWarOpponent(crewID, candidate);
    const radiusMeters = Number(behavior.doomsdayRadiusMeters) || profile.radiusMeters;
    // 优先打炮台正在打的那艘：它已经通过同一套交战规则，玩家看到的就是"打同一个"。
    const combatTargetID = Number(combatTargets.get(crewID)) || 0;
    const candidates = special.findDoomsdayTargets(scene, entity, radiusMeters, accept);
    const preferred = combatTargetID > 0
      ? candidates.find((entry) => Number(entry.entity && entry.entity.itemID) === combatTargetID) || null
      : null;
    const primary = preferred || candidates[0] || null;
    // 有目标时先走引擎激活（客户端才会播动画）；没有目标或引擎拒绝才回退。
    let engine = {ok: false};
    if (primary) {
      engine = activateDoomsdayNatively(scene, serviceSession, member, entity, moduleItem, profile, primary.entity);
    }
    if (engine.ok) {
      doomsdayReadyAt.set(crewID, now() + cooldownMs);
      log(`[special] ${member.name} 末日发射（引擎激活）· 目标 ${Number(primary.entity.itemID)}`);
      return {ok: true, line: `${member.name}：末日已发射（引擎激活，客户端有动画）`, engine: true};
    }
    if (engine.reason) {
      log(`[special] ${member.name} 引擎激活失败 ${engine.reason} → 回退自算伤害`);
    }
    const result = special.fireDoomsday(deps, {
      scene,
      attacker: entity,
      moduleItem,
      profile,
      radiusMeters,
      accept,
      preferredTargetID: primary ? Number(primary.entity.itemID) || 0 : 0,
      nowMs: now(),
    });
    // 真的放出去才进完整冷却；"没有合法目标"只短等一会，别把 5 分钟浪费在没人可打上。
    doomsdayReadyAt.set(crewID, now() + (result.ok ? cooldownMs : DOOMSDAY_RETRY_MS));
    log(`[special] ${member.name} 末日发射：命中 ${result.targets} 个目标，合计 ${Math.round(result.applied)} 伤害` +
      `${result.problems.length > 0 ? " · " + result.problems.join(",") : ""}`);
    return {
      ok: result.ok,
      result,
      line: `${member.name}：末日${result.ok ? `命中 ${result.targets} 个目标（${Math.round(result.applied)} 伤害）` : "未命中（" + result.problems.join(",") + "）"}`,
    };
  }


  function npcModeFor(entry) {
    if (!entry) {
      return false;
    }
    if (typeof entry.npcMode === "boolean") {
      return entry.npcMode;
    }
    const config = configForBlueprint(entry.blueprintID);
    const behavior = (config && config.behavior) || {};
    return behavior.npcMode === true;
  }

  function configs_behavior() {
    const list = configStore.get().configs || [];
    return (list[0] && list[0].behavior) || {};
  }

  /**
   * 秒锁开关（默认开）。船员只有 1 个锁定槽，自然锁定要 9–13 秒：
   * 时长 = (40e6 / scanResolution) / ln(sig + √(sig²+1))²（引擎 space/runtime/targeting.js）。
   * 等待期间每拍都要重试，既慢又费；用户 2026-10-25 要求换成秒锁，作为"只能锁 1 个"的补偿。
   * 蓝图 behavior 里写 instantLock: false 可退回原生锁定。
   */
  function instantLockEnabled() {
    return configs_behavior().instantLock !== false;
  }

  /**
   * 当前生效的**表面间距**（模型到模型）。
   * 0.6.8 起只认 `followState.gap`（命令/面板写的），**不再读蓝图**：
   * 蓝图里的 followDistance / followClose 只是面板初值，改文件不影响运行。
   * 返回 null = 未配置（阶梯/环形都不会动）；0 是合法值（表面相切）。
   */
  function followSurfaceGap() {
    return followGapMeters();
  }

  // P1：战斗选目标用的场景快照按拍缓存。8 艘船在同一拍里各扫一遍 getDynamicEntities()，
  // 实测是战斗阶段的主要成本之一；500 ms 内复用上一次的结果。
  // 只给"选目标"这类容忍几百毫秒延迟的调用用；解散反查、立体炸弹安全判定都直接取实时。
  let dynamicRowsCache = {scene: null, at: 0, rows: null};
  function dynamicEntitiesFor(scene) {
    if (!scene || typeof scene.getDynamicEntities !== "function") {
      return [];
    }
    const at = now();
    if (dynamicRowsCache.scene === scene && Array.isArray(dynamicRowsCache.rows)
      && at - dynamicRowsCache.at < 500) {
      return dynamicRowsCache.rows;
    }
    let rows = [];
    try {
      rows = scene.getDynamicEntities() || [];
    } catch (_error) {
      rows = [];
    }
    dynamicRowsCache = {scene, at, rows};
    return rows;
  }

  /**
   * 阶梯相邻两艘的外扩步长（0.6.8 起只认 `followState.spacing`，不读蓝图）；
   * 0 = 不额外错开（全在同一距离上，会重叠）。
   */
  function crewSpacingMeters() {
    return followSpacingMeters();
  }

  function stationIDFor(session) {
    const characterID = Number(session && session.characterID) || 0;
    try {
      if (characterID && deps.characterState && typeof deps.characterState.peekCharacterRecord === "function") {
        const record = deps.characterState.peekCharacterRecord(characterID);
        const stationID = Number(record && (record.stationID || record.homeStationID)) || 0;
        if (stationID) {
          return stationID;
        }
      }
    } catch (_error) {
      /* fall through to the default */
    }
    return pool.DEFAULT_STATION_ID;
  }

  function currentSystemID(session) {
    return Number(session && session._space && session._space.systemID) || 0;
  }

  function configForBlueprint(blueprintID) {
    const list = configStore.get().configs || [];
    return list.find((entry) => entry.id === blueprintID) || list[0] || null;
  }

  function isDeployedNear(member, context = {}) {
    if (!member || member.summoned !== true || !Number(member.shipID)) {
      return false;
    }
    const scene = context.scene || follow.sceneFor(deps, context.session);
    if (scene && typeof scene.getEntityByID === "function" && scene.getEntityByID(member.shipID)) {
      return true;
    }
    const systemID = currentSystemID(context.session);
    if (!systemID) {
      return false;
    }
    let item = null;
    try {
      item = deps.itemStore && typeof deps.itemStore.findShipItemById === "function"
        ? deps.itemStore.findShipItemById(member.shipID)
        : null;
    } catch (_error) {
      item = null;
    }
    const itemSystemID = Number(item && item.spaceState && item.spaceState.systemID) || 0;
    return itemSystemID === systemID;
  }

  function selectMembers(selector, context = {}) {
    const summoned = (stateStore.get().pool || []).filter((entry) => entry.summoned && entry.shipID);
    const wanted = String(selector == null ? "" : selector).trim();
    if (!wanted || wanted.toLowerCase() === "all") {
      const here = summoned.filter((entry) => isDeployedNear(entry, context));
      return {
        members: here,
        skipped: summoned.length - here.length,
        problems: [],
      };
    }
    const byID = summoned.filter((entry) => String(entry.characterID) === wanted);
    if (byID.length > 0) {
      return {members: byID, skipped: 0, problems: []};
    }
    const byName = summoned.filter((entry) => String(entry.name || "").toLowerCase() === wanted.toLowerCase());
    if (byName.length > 0) {
      return {members: byName, skipped: 0, problems: []};
    }
    return {members: [], skipped: 0, problems: [`没找到在役船员：${wanted}`]};
  }

  // If the player aborted the warp, the crew that followed it is stranded far
  // away: pull it back once the player is no longer warping.
  function bringBackStranded(scene, session, summoned, playerEntity) {
    if (!scene || !playerEntity) {
      return;
    }
    const playerMode = String(playerEntity.mode || "").toUpperCase();
    if (playerMode === "WARP") {
      return;
    }
    for (const entry of summoned) {
      const characterID = Number(entry.characterID);
      const entity = typeof scene.getEntityByID === "function" ? scene.getEntityByID(entry.shipID) : null;
      if (!entity) {
        continue;
      }
      if (String(entity.mode || "").toUpperCase() === "WARP") {
        continue;
      }
      const gap = mining.surfaceDistance(entity, playerEntity);
      if (gap <= 500000) {
        continue;
      }
      const lastAt = Number(lastBringBack.get(characterID)) || 0;
      if (now() - lastAt < 30000) {
        continue;
      }
      lastBringBack.set(characterID, now());
      // Natural behaviour: it finishes the warp it was on, then warps BACK to the
      // player. No teleporting / repositioning.
      const target = ship.buildSpaceState({systemID: Number(scene.systemID) || 0, leader: playerEntity});
      const back = ship.warpIn(deps, {
        systemID: Number(scene.systemID) || 0,
        sceneDescriptor: scene.sceneDescriptor,
        shipID: entry.shipID,
        targetPoint: target.position,
      });
      log(`[bringback] ${entry.name} 距你 ${Math.round(gap / 1000)}km → 返航跃迁 ` +
        `${back.ok ? "ok" : `失败 ${back.reason}`}`);
    }
  }

  // 错峰用：把名单从 offset 处转一圈（返回新数组，不改入参）。
  function rotateFrom(list, offset) {
    const rows = Array.isArray(list) ? list : [];
    if (rows.length <= 1) {
      return rows;
    }
    const start = ((Math.trunc(Number(offset) || 0) % rows.length) + rows.length) % rows.length;
    return start === 0 ? rows : rows.slice(start).concat(rows.slice(0, start));
  }

  /**
   * 本拍还要不要继续做防御配置？
   * 已配过至少 1 条 + 超出预算 → 停（至少 1 条是为了保证最贵的船也不会永远轮不上）。
   */
  function defensePassShouldStop(servedCount, spentMs, budgetMs) {
    if (Number(servedCount) <= 0) {
      return false;
    }
    return Number(spentMs) >= Number(budgetMs);
  }

  /**
   * 防御配置的唯一自动闸门：2 s 节流 + 本拍预算。
   * 所有"顺手也管一下装备"的路径都必须走这里，否则预算会被绕过
   * （2026-10-25 真机：engageMember 里那次无节流调用把 combat 段顶到 1–4 s）。
   * 返回 {ran, runMs, crewKey}：ran=false 表示这拍没做（节流或超预算）。
   */
  function maybeRunDefenseFor(scene, session, member, entity) {
    const crewKey = Number(member && member.characterID) || 0;
    if (now() - (lastDefenseAt.get(crewKey) || 0) < 2000) {
      return {ran: false, runMs: 0, crewKey};
    }
    const pass = defensePassState;
    if (pass && defensePassShouldStop(pass.served, Date.now() - pass.at, pass.budgetMs)) {
      return {ran: false, runMs: 0, crewKey};
    }
    lastDefenseAt.set(crewKey, now());
    if (pass) {
      pass.served += 1;
    }
    const startedAt = Date.now();
    runDefenseFor(scene, session, member, entity);
    return {ran: true, runMs: Date.now() - startedAt, crewKey};
  }

  // 单船一次防御配置 0.2–1.4 s（每次 activateGenericModule 都要重算全船属性），
  // 所以每拍给 400 ms：最坏情况一拍只配 1 条，最好情况配 2–3 条。
  // 可用 options.defenseTickBudgetMs 覆盖（0 = 每拍只配 1 条，测试也用它造确定性场景）。
  const DEFENSE_TICK_BUDGET_MS = Number.isFinite(Number(options.defenseTickBudgetMs))
    ? Math.max(0, Number(options.defenseTickBudgetMs))
    : 400;
  // 下一拍从第几条船开始（错峰游标，见 miningWatchTick 的防御段）。
  let defenseCursor = 0;
  // 本拍的防御预算状态（{served, at, budgetMs}）。**全 tick 只有一份**：
  // 以前 runDefenseFor 有四个调用点（engageMember / syncCombat / 手动命令 / 防御段），
  // 前两个不带任何闸门，8 条船一拍能跑 1–2 遍 → 实测 combat 段 1–4 s。
  // 现在自动路径统一走 maybeRunDefenseFor：2 s 节流 + 每拍预算，手动命令仍可强制。
  let defensePassState = null;

  // Which stage of the watch tick eats the event loop? Measured per stage so a slow tick
  // can be attributed instead of guessed.
  function timeStage(steps, name, fn) {
    const startedAt = Date.now();
    try {
      return fn();
    } finally {
      steps[name] = (steps[name] || 0) + (Date.now() - startedAt);
    }
  }

  // engageMember 内部的分段（combat.engage.weapons / .ammo / .range / .volley）：
  // 它们是 combat 的子项，会出现在 `combat=…(...)` 的括号里。
  function engagePhaseEnd(steps, name, startedAt) {
    if (!steps) {
      return;
    }
    steps[name] = (steps[name] || 0) + (Date.now() - startedAt);
  }

  // 单船防御轮询的归因日志：超过 1 s 才写（阈值见 SLOW_DEFENSE_LOG_MS）。
  // 抽成独立函数是为了能被单测直接调用 —— 真实耗时没法在测试里稳定造出来。
  const SLOW_DEFENSE_LOG_MS = 1000;
  function logSlowDefenseFor(member, entity, runMs, breakdown, passInfo) {
    const ms = Number(runMs) || 0;
    if (ms < SLOW_DEFENSE_LOG_MS) {
      return false;
    }
    const running = entity && entity.activeModuleEffects instanceof Map
      ? entity.activeModuleEffects.size
      : 0;
    // 内层分段（≥50 ms 才提）：modules=读装配 / ammo=补弹药 / harden=抗性常开并入快照 /
    // attention=该不该动 / manage=真激活。
    const parts = breakdown && typeof breakdown === "object"
      ? Object.entries(breakdown)
        .filter(([, partMs]) => Number(partMs) >= 50)
        .map(([name, partMs]) => `${name}=${partMs}ms`)
        .join(" ")
      : "";
    // "做了什么"（不是耗时）：harden 贵的时候必须知道是不是又写了一遍影子状态。
    //   applied=2/2 → 写了 2 个（说明引擎那边被抹掉了）；applied=0/2 → 幂等跳过，贵在别处。
    const info = passInfo && typeof passInfo === "object"
      ? [
        Number.isFinite(passInfo.hardeners) ? `applied=${Number(passInfo.applied) || 0}/${passInfo.hardeners}` : "",
        passInfo.needed === true ? "needed" : passInfo.needed === false ? "无需动作" : "",
        Number(passInfo.activated) > 0 ? `开${passInfo.activated}` : "",
        Number(passInfo.stopped) > 0 ? `关${passInfo.stopped}` : "",
      ].filter(Boolean).join(" ")
      : "";
    log(`[perf] defense 单船 ${(member && member.name) || "?"} ${ms} ms` +
      ` · 模块运行 ${running} · mode=${(entity && entity.mode) || "?"}` +
      (parts ? ` · ${parts}` : "") +
      (info ? ` · ${info}` : ""));
    return true;
  }

  // 全权开火下两次自动末日之间至少隔 3 秒：放一次末日要重算一次属性（约 1 秒），
  // 二十艘船同时就绪时必须摊开，否则每秒的 watch 循环会被拖垮。
  const AUTO_DOOMSDAY_GAP_MS = 3000;
  let lastAutoDoomsdayAt = 0;

  /**
   * 全权开火：末日武器也交给船员自己。
   * 只在"已经在交战"的船上触发——combatTargets 里没有目标就不去扫场景，
   * 避免每 tick 为每艘船做一次范围查询。
   * 返回本 tick 实际发射的数量（0 或 1）。
   */
  function autoFireDoomsdays(scene) {
    if (!fullAuthority || !freeFire || !scene) {
      return 0;
    }
    if (now() - lastAutoDoomsdayAt < AUTO_DOOMSDAY_GAP_MS) {
      return 0;
    }
    // O3：末日也接入“大模块”间隔，和堡垒/会战/工业核心共用一个队列。
    const doomSystemKey = Number(scene.systemID) || 0;
    const doomGapMs = Math.max(0, Number(configs_behavior().largeActivationGapMs) || 2500);
    if (now() - (Number(largeActivationAt.get(doomSystemKey)) || 0) < doomGapMs) {
      return 0;
    }
    const members = (stateStore.get().pool || []).filter((entry) => entry.summoned === true);
    for (const member of members) {
      const crewID = Number(member.characterID) || 0;
      if (!Number(combatTargets.get(crewID)) || !crewID) {
        continue; // 没在打，就别浪费末日
      }
      const readyAt = Number(doomsdayReadyAt.get(crewID)) || 0;
      if (now() < readyAt) {
        continue;
      }
      const entity = typeof scene.getEntityByID === "function" ? scene.getEntityByID(member.shipID) : null;
      if (!entity) {
        continue;
      }
      if (special.findDoomsdayModules(deps, {characterID: crewID, shipID: member.shipID}).length === 0) {
        continue;
      }
      const outcome = fireDoomsdayFor(scene, member, entity);
      lastAutoDoomsdayAt = now();
      largeActivationAt.set(doomSystemKey, now());
      if (outcome.ok) {
        log(`[special] 全权开火：${outcome.line}`);
      }
      return outcome.ok ? 1 : 0; // 一次只放一发，剩下的等下一个间隔
    }
    return 0;
  }

  // P0 过载保护：上一拍超过 800 ms 就说明事件循环已经吃紧，这一拍只跑"必须"的阶段
  // （scene/combat/rearm/warp），把 active/remote/stranded/defense 顺延；最多连续顺延 2 拍。
  const OVERLOAD_MS = 800;
  let lastWatchTickMs = 0;
  let heavySkippedTicks = 0;

  function miningWatchTick() {
    const tickStartedAt = Date.now();
    const steps = {};
    const overloaded = lastWatchTickMs > OVERLOAD_MS;
    const runHeavy = !overloaded || heavySkippedTicks >= 2;
    if (runHeavy) {
      heavySkippedTicks = 0;
    } else {
      heavySkippedTicks += 1;
      steps.deferred = 1;
    }
    const session = serviceSession;
    if (!session) {
      lastWatchTickMs = Date.now() - tickStartedAt;
      return steps;
    }
    // 本拍的防御预算（全 tick 一份，含 combat 段里"顺手管装备"的那些调用）。
    // 过载时预算为 0：每拍最多配 1 条船（"至少 1 条"保证仍有进展）。
    defensePassState = {
      served: 0,
      at: Date.now(),
      budgetMs: runHeavy ? DEFENSE_TICK_BUDGET_MS : 0,
    };
    const scene = timeStage(steps, "scene", () => follow.sceneFor(deps, session));
    if (!scene || typeof scene.getEntityByID !== "function") {
      lastWatchTickMs = Date.now() - tickStartedAt;
      return steps;
    }
    // 诊断：记录每次模块激活的调用方（玩家 vs 船员），用于对比 socket 差异。
    instrumentSceneActivation(scene);
    // M9: mirror the commander's target (and drop dead ones) once per tick.
    try {
      timeStage(steps, "combat", () => {
        // 子项 combat.sync / combat.wake 只用于归因（名字里的 "." 不计入 accounted）。
        const result = timeStage(steps, "combat.sync", () => syncCombat(scene, session, steps));
        // 船员船不是真会话：怪可能一直休眠，这里主动唤醒附近的控制器。
        timeStage(steps, "combat.wake", () => wakeNpcsNearCrew(scene, session));
        return result;
      });
    } catch (_error) {
      /* never let combat bookkeeping break the watch loop */
    }
    // 全权开火：末日武器也交给船员（冷却与交战状态由 autoFireDoomsdays 自己把关）。
    if (fullAuthority) {
      try {
        timeStage(steps, "doomsday", () => autoFireDoomsdays(scene));
      } catch (_error) {
        /* never let a doomsday break the watch loop */
      }
    }
    // Every second: follow the player's warp, then re-arm the follow posture.
    try {
      const playerShipID = Number(session && session._space && session._space.shipID) || 0;
      const playerEntity = playerShipID ? scene.getEntityByID(playerShipID) : null;
      if (playerEntity) {
        const summonedNow = (stateStore.get().pool || []).filter((entry) => entry.summoned === true);
        timeStage(steps, "rearm", () => rearmFollow(scene, session, summonedNow, playerEntity));
        // 会战/堡垒模式：玩家开关，别的什么都不做（和末日一样不由船员决定）。
        timeStage(steps, "special", () => syncSpecials(scene, session, summonedNow, steps));
        if (runHeavy) {
          // PLAN §20 B/C：立体炸弹（按安全条件）、EWAR/吸电/中和（按目标）、指挥脉冲。
          timeStage(steps, "active", () => syncActiveModules(scene, session, summonedNow));
          // 遥修：白名单挑目标 → 锁定 → 挂模块（修满/进模式/超距/低电自动停）。
          timeStage(steps, "remote", () => syncRemoteAssist(scene, session, summonedNow));
          timeStage(steps, "stranded", () => bringBackStranded(scene, session, summonedNow, playerEntity));
        }
        // Defensive + propulsion management also runs outside combat: an MWD is only
        // useful while catching up to the commander, which happens during travel.
        //
        // 错峰（2026-10-25 实测）：一次防御配置 = 1 次 activateGenericModule = 全船属性重算，
        // 单船 0.2–1.4 s；以前一拍把 8 条船全配完 → 实测 watch tick 4025 ms。现在每拍只花
        // 一个预算，剩下的顺延到下一拍（游标轮转，谁都别饿死）。日志部分（几毫秒）不占预算。
        // 注意：闸门（maybeRunDefenseFor）在 combat 段就生效，所以这里用的是同一份预算。
        const defenseMembers = runHeavy ? summonedNow : [];
        const defenseOrder = rotateFrom(defenseMembers, defenseCursor);
        let defenseServed = 0;
        for (const member of defenseOrder) {
          const memberEntity = scene.getEntityByID(member.shipID);
          if (!memberEntity) {
            continue;
          }
          const crewKey = Number(member.characterID) || 0;
          let runMs = 0;
          try {
            // 节流 + 预算都在闸门里；被 combat 段用掉预算的船会自动顺延。
            const ran = maybeRunDefenseFor(scene, session, member, memberEntity);
            if (ran.ran) {
              runMs = ran.runMs;
              defenseServed += 1;
              // 单船一次防御轮询超过 1 s 就单独记一行：能区分「某一条船特别贵」（查装配）
              // 和「每条船都贵」（查属性重算）。日志量由 2 s 节流兜住。
              logSlowDefenseFor(member, memberEntity, runMs, defenseBreakdown.get(crewKey), defensePassInfo.get(crewKey));
            }
          } catch (_error) {
            /* never let module management break the watch loop */
          }
          try {
            const logStartedAt = Date.now();
            logCrewBehavior(scene, session, member, memberEntity);
            const logMs = Date.now() - logStartedAt;
            steps.defense = (steps.defense || 0) + runMs + logMs;
            steps["defense.run"] = (steps["defense.run"] || 0) + runMs;
            steps["defense.log"] = (steps["defense.log"] || 0) + logMs;
          } catch (_error) {
            /* 日志永远不能影响主流程 */
          }
        }
        // 游标只前进“真正配过”的条数：被预算跳过或被 2 s 节流跳过的船，下一拍还从它开始。
        defenseCursor = defenseMembers.length > 0
          ? (defenseCursor + defenseServed) % defenseMembers.length
          : 0;
      }
    } catch (error) {
      log(`[follow] 恢复跟随失败 ${error && error.message}`);
    }
    // 跟队跃迁：命令钩子负责下发（玩家一按跃迁，船员同 tick 开始对准）；这里只
    // 做每秒的收尾——玩家取消时停船、整队落地后记一条日志。开关关掉也照样收尾，
    // 否则飞行中的那一组永远不会被清掉。
    try {
      timeStage(steps, "warp", () => fleetWarp.tick(deps, scene, session));
    } catch (error) {
      log(`[warpfollow] 收尾失败 ${error && error.message}`);
    }
    // M3：重选队列出队 —— 每拍最多 RETARGET_BUDGET_MS，但至少 1 条。
    if (miningRetargetQueue.size > 0) {
      try {
        timeStage(steps, "retarget", () => drainRetargetQueue(scene, session));
      } catch (error) {
        log(`[mine] 重选队列失败 ${error && error.message}`);
      }
    }
    const entries = (stateStore.get().pool || []).filter(
      (entry) => entry.summoned === true && miningWanted.has(Number(entry.characterID)),
    );
    for (const entry of entries) {
      const key = Number(entry.characterID);
      const entity = scene.getEntityByID(entry.shipID);
      if (!entity) {
        continue;
      }
      // P0.1：换矿时没轮到的模块在这里一门一门补开（1 s 一个），
      // 这样换矿的激活不再挤在同一个 tick 里。
      continuePendingMining(scene, session, entry, entity);
      const map = entity.activeModuleEffects instanceof Map ? entity.activeModuleEffects : null;
      if (map && map.size > 0) {
        const state = map.values().next().value || {};
        // 这行以前是「每 tick 每名矿工一条」，纯日志开销；需要时开 debug 再看。
        if (debugMode) {
          log(`[watch] ${entry.name} modules=${map.size} target=${Number(state.targetID) || 0} ` +
            `dur=${Math.round(Number(state.durationMs) || 0)} next=${Math.round(Number(state.nextCycleAtMs) || 0)} ` +
            `stop=${state.stopReason || "null"} remain=${state.remainingCycles}`);
        }
        // Re-lock every second when the lock is gone: a mining cycle fails with
        // stopReason "target" (and the module is dropped) without it.
        const targetID = Number(state.targetID) || 0;
        const targetEntity = targetID && typeof scene.getEntityByID === "function"
          ? scene.getEntityByID(targetID)
          : null;
        if (targetEntity) {
          const lockStartedAt = Date.now();
          let locked = [];
          try {
            locked = typeof scene.getTargetsForEntity === "function"
              ? scene.getTargetsForEntity(entity) || []
              : [];
          } catch (_error) {
            locked = [];
          }
          steps.lock = (Number(steps.lock) || 0) + (Date.now() - lockStartedAt);
          if (!locked.some((id) => Number(id) === targetID)) {
            const relock = mining.ensureTargetLock({scene, entity, rock: targetEntity});
            // 锁不上时这一行以前每秒一条（一晚上几千行）；按 (船员,目标) 10 秒去重。
            logCombatOnce(key, targetID, "mine:relock",
              `${entry.name}：锁定丢失，重新锁定 → ${relock.ok ? (relock.locked ? "已锁" : "等待中") : relock.reason}`);
          }
        }
        miningWatch.set(key, {
          at: new Date().toISOString().slice(11, 19),
          modules: map.size,
          targetID: Number(state.targetID) || 0,
          durationMs: Number(state.durationMs) || 0,
          remainingCycles: state.remainingCycles,
          nextCycleAtMs: Number(state.nextCycleAtMs) || 0,
          deactivateAtMs: Number(state.deactivateAtMs) || 0,
          stopReason: state.stopReason || null,
        });
      } else if (miningWatch.has(key)) {
        // M1：归因 —— 最后一次记到的目标矿还在不在？
        //   还在  → 不是采空，是 cycle 边界重算失败（bug，值得单独盯）
        //   没了  → 正常采空
        const last = miningWatch.get(key) || null;
        const lastTargetID = Number(last && last.targetID) || 0;
        const lastTarget = lastTargetID && typeof scene.getEntityByID === "function"
          ? scene.getEntityByID(lastTargetID)
          : null;
        const targetStillThere = Boolean(
          lastTarget && mining.rockOre(lastTarget, {scene, miningState: deps.miningState}),
        );
        log(`${entry.name}：模块消失 · ${targetStillThere
          ? `目标 ${lastTargetID} 还在 → 边界重算失败`
          : `目标 ${lastTargetID || "无"} 已采空/消失`} · 最后状态 ${JSON.stringify(last)}`);
        miningWatch.delete(key);
        // 两种都得重新选矿；入队后由 watch tick 按预算执行。
        enqueueRetarget(entry);
      }
    }
    // 少了这一行，reportSlowWatchTick 永远只看到 {} → 每个慢 tick 都被算成 other。
    // PLAN §18.26 的「100% 记在 other」就是这个 bug，不是阶段没被计时。
    lastWatchTickMs = Date.now() - tickStartedAt;
    return steps;
  }

  // 分段名里的 "x.y" 是「某个阶段的子项」（如 defense.run / defense.log）：只用于归因
  // 展示，不参与 accounted 求和 —— 否则父子重复计数，other 会被算成负数而消失。
  function isChildStage(name) {
    return String(name).indexOf(".") >= 0;
  }

  function reportSlowWatchTick(startedAt, steps) {
    const elapsed = Date.now() - startedAt;
    const all = steps || {};
    const parents = Object.entries(all).filter(([name]) => !isChildStage(name));
    const stages = parents.filter(([, ms]) => Number(ms) >= 200);
    const slowestStage = stages.reduce((max, [, ms]) => Math.max(max, Number(ms) || 0), 0);
    // 一次 activateGenericModule 就要 1.0–1.3 s，可能整段都塞在一个 < 1500 ms 的 tick 里，
    // 所以「单阶段 ≥800 ms」也要报，否则这些激活一直是隐形的。
    if (elapsed < 1500 && slowestStage < 800) {
      return;
    }
    const accounted = parents.reduce((sum, [, ms]) => sum + (Number(ms) || 0), 0);
    const other = elapsed - accounted;
    const withOther = other >= 200 ? {...all, other} : {...all};
    // 子项只在父阶段被报出来时才跟一段括号（≥50 ms 的才提），保留全名以便一眼认出：
    //   defense=1824ms(defense.run=1820ms)
    const childDetail = (name) => {
      const kids = Object.entries(all)
        .filter(([key, ms]) => key.startsWith(`${name}.`) && Number(ms) >= 50)
        .map(([key, ms]) => `${key}=${ms}ms`);
      return kids.length > 0 ? `(${kids.join(" ")})` : "";
    };
    const detail = Object.entries(withOther)
      .filter(([name, ms]) => !isChildStage(name) && Number(ms) >= 200)
      .map(([name, ms]) => `${name}=${ms}ms${childDetail(name)}`)
      .join(" ");
    log(`[perf] watch tick 用时 ${elapsed} ms${detail ? " · 分段 " + detail : ""}` +
      "（>1500 ms 会让服务器时间膨胀）");
  }

  function startMiningWatch() {
    if (watchTimer) {
      return;
    }
    watchTimer = setInterval(guardTimer("watch", () => {
      const startedAt = Date.now();
      let steps = {};
      try {
        steps = miningWatchTick() || {};
      } catch (error) {
        log(`采样失败 ${error && error.message}`);
      }
      reportSlowWatchTick(startedAt, steps);
    }), 1000);
    if (typeof watchTimer.unref === "function") {
      watchTimer.unref();
    }
    // B 模式（环形槽位）需要比 1 s 更细的控制节拍，否则刹车会冲过死区。
    if (formationTimer) {
      clearInterval(formationTimer);
    }
    formationTimer = setInterval(guardTimer("ring", () => {
      try {
        ringFormationTick();
      } catch (error) {
        log(`[ring] ${error && error.message}`);
      }
    }), RING_TICK_MS);
    if (typeof formationTimer.unref === "function") {
      formationTimer.unref();
    }
  }

  function autoStartServiceLoop(session) {
    if (serviceTimer) {
      serviceSession = session;
      return;
    }
    log("[loop] 指令触发服务循环启动");
    startServiceLoop(session);
  }

  function startServiceLoop(session) {
    serviceSession = session;
    startMiningWatch();
    if (serviceTimer) {
      return;
    }
    const interval = Math.max(5000, Number(options.serviceIntervalMs) || 15000);
    serviceTimer = setInterval(guardTimer("service", () => {
      // 服务循环（压缩/交付/燃料）也是同步跑在主线程上的：超过 800ms 就记一行，
      // 否则它会把 watch tick 的墙钟时间顶起来，看起来像「watch tick 很慢」。
      const startedAt = Date.now();
      try {
        serviceTick();
      } finally {
        const elapsed = Date.now() - startedAt;
        if (elapsed >= 800) {
          log(`[perf] service tick 用时 ${elapsed} ms（压缩/交付/燃料）`);
        }
      }
    }), interval);
    if (typeof serviceTimer.unref === "function") {
      serviceTimer.unref();
    }
  }

  function stopServiceLoop() {
    if (watchTimer) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
    if (formationTimer) {
      clearInterval(formationTimer);
      formationTimer = null;
    }
    ringController.reset();
    if (serviceTimer) {
      clearInterval(serviceTimer);
      serviceTimer = null;
    }
    serviceSession = null;
  }

  // 跟队跃迁：包玩家的跃迁命令（warpToPoint / warpToEntity）。只观察真实会话，
  // 船员始终是 sessionless 实体——不注入伪 session。
  try {
    fleetWarp.register(deps, {
      // deps 是进程级单例，上下文按账号分组，否则多租户会互相顶掉。
      accountID: tenantAccountID,
      enabled: () => syncWarpOn(),
      pool: () => stateStore.get().pool || [],
      sceneFor: (session) => follow.sceneFor(deps, session),
      stopMining: (scene, session, entry, entity) => {
        mining.stopMining({
          scene,
          session: mining.moduleSessionFor(session, Number(entry.characterID) || 0, entity),
          entity,
        });
        activeRock.delete(Number(entry.characterID) || 0);
      },
      log,
      now,
    });
  } catch (_error) {
    /* 注册失败不影响 runtime 启动；跟随仍然可用 */
  }

  return {
    sde,
    state: stateStore,
    configs: configStore,
    deps,
    // PR-2: what this runtime is bound to. accountID 0 = legacy single tenant.
    tenant: {accountID: tenantAccountID, crewAccountID: crewAccount()},
    checkReport,
    listFittings,
    importFitting,
  importServerFitting,
    poolList,
    poolScan,
    poolAdopt,
    poolClear,
    describe,
    // 面板/测试用：和 /api/status 返回同一个结构。
    status: (session) => buildStatusPayload(session),
    buildStatusPayload,
    spawnCrew,
    recallCrew,
    disbandCrew,
    fleetJoinCrew,
    mineCrew,
    debugCrew,
    serviceTick,
    startServiceLoop,
    stopServiceLoop,
    corporationSync,
    selectMembers,
    resolveAffiliation,
    staleTimers: () => timers.size,
    clearTimers,
    handleText,
    // P2 面板：库存窗口用的接口（和命令共用同一套内部函数）。
    stockView: (options) => stockView(options || {}),
    stockBuyBlueprint: (blueprintID, count, session) => {
      const config = configForBlueprint(String(blueprintID || ""));
      return config ? stockBuy(config, Math.max(1, Math.trunc(Number(count)) || 1), session) : [`没有这条配装：${blueprintID}`];
    },
    stockDepositShips: (session, ids) => stockDeposit(session, ids),
    stockWithdrawShips: (ids, session) => stockWithdraw(ids, session),
    stockSellShips: (ids, session) => stockSell(ids, session),
    stockRebuy: (id, session) => stockRebuy(id, session),
    stockSummonShips: (ids, session) => stockSummonShips(ids, session),
    stockPlanAction: (request, session) => stockPlanAction(request || {}, session),
    stockReconcileAction: (options) => stockReconcile.describeReconcile(reconcileStockLedger({adopt: Boolean(options && options.adopt)})),
    stockHangarView: () => stockHangarView(),
    // P3 配装台
    fitCatalog: (request) => fitCatalog(request || {}),
    fitCharges: (moduleTypeID) => fitCharges(moduleTypeID),
    fitQuote: (request) => fitQuote(request || {}),
    fitOrder: (request, session) => fitOrder(request || {}, session),
    fitSave: (request) => fitSave(request || {}),
  // Test-only hook: runs the same combat pass the watch tick runs.
  __syncCombat: (scene, session) => syncCombat(scene, session),
  // S1 hooks: what each crew is shooting, and how many locks are blacklisted.
  __combatTargets: () => new Map(combatTargets),
  // Test hook (§20): pin a crew's combat target without running a full combat pass.
  __setCombatTarget: (crewID, targetID) => {
    const key = Number(crewID) || 0;
    const target = Number(targetID) || 0;
    if (!key) {
      return;
    }
    if (target) {
      combatTargets.set(key, target);
    } else {
      combatTargets.delete(key);
    }
  },
  __lockBlacklist: () => blacklistSize(),
  // PLAN §18 hooks: the special-equipment pass the watch tick runs.
  __syncSpecials: (scene, session, summoned) => syncSpecials(scene, session, summoned),
  __syncActive: (scene, session, summoned) => syncActiveModules(scene, session, summoned),
  __syncRemote: (scene, session, summoned) => syncRemoteAssist(scene, session, summoned),
  // 蓝图删除（面板按钮 / 单测）。
  __deletePreset: (request) => deletePreset(request),
  // 面板详情（单测用：验证血量字段）。
  __crewDetail: (characterID) => buildCrewDetail(characterID),
  __returnOrbit: () => returnToOrbit(),
  __chaseState: () => [...chaseTargets.entries()],
  __activeFailures: () => new Map(activeFailures),
  __specialModules: (entry, entity) => specialModulesFor(entry, entity),
  __specialReport: () => specialReport(),
  // S2 hooks: the grudge list as plain data (characterID -> remaining ms).
  __grudge: () => {
    const at = now();
    const characters = {};
    for (const [id, record] of grudgeCharacters) {
      if (Number(record.untilMs) > at) {
        characters[id] = Number(record.untilMs) - at;
      }
    }
    const corps = {};
    for (const [id, record] of grudgeCorps) {
      if (Number(record.untilMs) > at) {
        corps[id] = Number(record.untilMs) - at;
      }
    }
    return {characters, corps};
  },
  __grudgeHit: (characterID, session) => grudgeCharacter(characterID, {session}),
  __rearmFollow: (scene, session, summoned, playerEntity) => rearmFollow(scene, session, summoned, playerEntity),
  __ringFormationTick: (session) => ringFormationTick(session),
  __salvoTurnFor: (crewID) => salvoTurnFor(crewID),
  // 火力集中：读状态 + 把"本拍已用毫秒"打进去（测试安全阀用，行为代码不调这两个）。
  __focusFire: () => focusFire === true,
  __focusTickSpent: () => focusTickSpentMs,
  __markFocusSpent: (ms) => {
    focusTickSpentMs += Math.max(0, Number(ms) || 0);
    focusTickAt = Math.floor(now() / 1000);
  },
  // 挖矿/跟随抢占的回归钩子：标记 intent 之后，即使模块还没起也要算“在挖矿”。
  __markMiningIntent: (crewID, rockID) => {
    const key = Number(crewID) || 0;
    if (!key) {
      return false;
    }
    activeRock.set(key, Number(rockID) || 0);
    miningWanted.add(key);
    return true;
  },
  __isMiningAtRock: (scene, crewID, entity) => isMiningAtRock(scene, crewID, entity),
  // 矿认领表自检（「整队挤同一块矿」）。行为评审只读 entries，不写。
  __rockClaims: () => [...rockClaims.entries()].map(([key, owner]) => ({key, owner})),
  __rockClaimsByOthers: (scene, crewID) => [...rockClaimsByOthers(scene, crewID)].sort((a, b) => a - b),
  __claimRock: (scene, crewID, itemID) => claimRock(scene, crewID, itemID),
  __releaseRockClaim: (crewID) => releaseRockClaim(crewID),
  __pruneRockClaims: (scene) => pruneRockClaims(scene),
  __formationRangeFor: (member, summoned, baseRange) => follow.formationRangeFor(member, summoned, baseRange, followSurfaceGap(), crewSpacingMeters()),
  __npcModeFor: (entry) => npcModeFor(entry),
  __syncCrewIdentity: (entity) => syncCrewIdentity(entity),
  // 血量上限自愈（structureHP=0 的船员船；见 ensureHealthLayers 的注释）。
  __ensureHealthLayers: (entity) => ensureHealthLayers(entity),
  // 「引擎判定已死但摘不掉」的收尾（无头 session 副作用；见 finalizeDeadCrewShip）。
  __finalizeDeadCrewShip: (scene, entry, entity) => finalizeDeadCrewShip(scene, entry, entity),
  __fireDoomsday: (characterID) => fireDoomsdayForCrew(characterID),
  __runDefenseFor: (scene, session, member, entity) => runDefenseFor(scene, session, member, entity),
  __rebuildCrew: (selector, context) => rebuildCrew(selector, context),
  __markDestroyed: (characterID) => markDestroyed(characterID),
  __markAlive: (characterID) => markAlive(characterID),
  // PR-2 hook: what "the sessions of this player" resolves to.
  __tenantSessions: () => tenantSessions(),
  __scheduleAfter: (delayMs, run) => scheduleAfter(delayMs, run),
  // 性能日志的自检：watch tick 必须把它计时的每个阶段交回来（否则慢 tick 只能写 other）。
  __watchTick: () => miningWatchTick(),
  // P0.3 自检：服务循环（15 s）里的续锁节流。
  __serviceTick: () => serviceTick(),
  __reportSlowWatchTick: (startedAt, steps) => reportSlowWatchTick(startedAt, steps),
  __logSlowDefenseFor: (member, entity, runMs, breakdown) => logSlowDefenseFor(member, entity, runMs, breakdown),
  // 防御配置错峰的接线自检：游标必须随“真正配过几条船”前进。
  __defenseCursor: () => defenseCursor,
  __defenseTickBudgetMs: () => DEFENSE_TICK_BUDGET_MS,
  __rotateFrom: (list, offset) => rotateFrom(list, offset),
  __defensePassShouldStop: (served, spentMs, budgetMs) => defensePassShouldStop(served, spentMs, budgetMs),
  // 唯一闸门（combat 段与防御段共用）：节流 + 每拍预算。
  __maybeRunDefenseFor: (scene, session, member, entity) => maybeRunDefenseFor(scene, session, member, entity),
  __setDefensePassState: (state) => {
    defensePassState = state || null;
    return defensePassState;
  },
  // 唤醒扫描的接线自检：N 条船必须共用 1 次全场景扫描（以前是每人一次）。
  __wakeNpcsNearCrew: (scene, session) => wakeNpcsNearCrew(scene, session),
  __startWatch: (session) => {
    serviceSession = session;
    return true;
  },
  setDebugMode: (on) => { debugMode = on === true; loggingDebug = debugMode; return debugMode; },
  setMode: (request) => applyModeRequest(request),
  // PLAN §18.4 的 /api/special 入口，测试也用它。
  setSpecial: (request) => applySpecialRequest(request),
  buildCrewDetail,
    now,
  };
}

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

/** 船的锁定距离（maxTargetRange / 属性 76）；0 = 未知（没算过派生属性）。 */
function lockRangeOf(entity) {
  const direct = Number(entity && entity.maxTargetRange);
  if (Number.isFinite(direct) && direct > 0) {
    return direct;
  }
  const attributes = entity && entity.passiveDerivedState && entity.passiveDerivedState.attributes;
  if (!attributes) {
    return 0;
  }
  const value = Number(attributes[76] !== undefined ? attributes[76] : attributes["76"]);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

module.exports = {createRuntime, USAGE, __lockRangeOf: lockRangeOf};


