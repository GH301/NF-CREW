"use strict";
if (require("./lib/launcherGuard.js").gate("nf-crew")) return;

const fs = require("node:fs");

// nf-crew loader (M1b).
//
// Adds the /crewmine chat command without touching any file on disk: the server
// already exports executeChatCommand from services/chat/chatCommands.js, so the
// loader wraps that module through a Module._load hook and answers /crewmine
// itself. Everything is guarded — a broken loader must never stop the server.
//
// Disable with EVEJS_NPC_CREW_MINING=0 (or rename this file to .disabled).

const path = require("node:path");
const Module = require("node:module");

const {createRuntimeRouter} = require(path.join(__dirname, "lib", "nfCrewMiningRouter.js"));
const tenantModule = require(path.join(__dirname, "lib", "nfCrewMiningTenant.js"));

const MOD_ID = "nf-crew";
// PR-3: one runtime per player account, created on first command.
// EVEJS_CM_TENANT_MODE=0 falls back to the old single-runtime behaviour.
const TENANT_MODE = String(process.env.EVEJS_CM_TENANT_MODE || "").trim() !== "0";
const MOD_DIR = __dirname;
const WORKSPACE = path.resolve(MOD_DIR, "..", "..");
const SERVER = path.join(WORKSPACE, "server", "src");
const CHAT_COMMANDS_SUFFIX = path.join("services", "chat", "chatCommands.js");
// The web panel tails this file so a tester can watch the mod work live.
const CREW_LOG_DIR = path.join(WORKSPACE, "_local", "gameStore", "nf-crew", "logs");
const CREW_LOG_FILE = path.join(CREW_LOG_DIR, "crew.log");
// 日志保留天数（默认 3 天；0 = 不清理，设成 EVEJS_CM_LOG_RETENTION_DAYS 可覆盖）。
const CREW_LOG_RETENTION_DAYS = (() => {
  const raw = Number(process.env.EVEJS_CM_LOG_RETENTION_DAYS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 3;
})();
const logRetention = safeRequire(path.join(__dirname, "lib", "nfCrewMiningLogRetention.js"));
// S1：射程快照缓存（5 s TTL），和武器齐射/遥修共用。
const snapshotCache = safeRequire(path.join(__dirname, "lib", "nfCrewMiningSnapshotCache.js"));
const COMMAND_REPLIES = path.join(SERVER, "services", "chat", "commands", "commandReplies.js");

function log(message) {
  try {
    console.log(`[${MOD_ID}] ${message}`);
  // stdout is NOT captured into server.log, so keep our own file for review.
  try {
    const dir = path.join(__dirname, "..", "..", "_local", "gameStore", "nf-crew", "logs");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
    const file = path.join(dir, "crew.log");
    try {
      // 以前 rename 到固定名 crew.log.1，Windows 上目标已存在会直接抛错（被吞掉），
      // 文件就永远不轮转。现在用带时间戳的名字，并只保留最近几份。
      if (logRetention && typeof logRetention.rotateIfLarge === "function") {
        logRetention.rotateIfLarge({dir, maxBytes: 5 * 1024 * 1024});
      }
    } catch (_error) {
      /* 轮转失败不能影响写日志 */
    }
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(path.join(dir, "crew.log"), line, "utf8");
  } catch (_error) {
    /* logging must never throw */
  }
  } catch (_error) {
    /* logging must never throw */
  }
}

if (String(process.env.EVEJS_NPC_CREW_MINING || "").trim() === "0") {
  log("disabled by EVEJS_NPC_CREW_MINING=0");
  module.exports = {};
  return;
}

// 日志按天清理：启动时跑一次，之后每 6 小时一次（EVEJS_CM_LOG_RETENTION_DAYS=0 关闭）。
function pruneCrewLogs() {
  if (!logRetention || typeof logRetention.pruneByAge !== "function") {
    return;
  }
  if (!(CREW_LOG_RETENTION_DAYS > 0)) {
    return;
  }
  try {
    const result = logRetention.pruneByAge({
      dir: CREW_LOG_DIR,
      retentionDays: CREW_LOG_RETENTION_DAYS,
    });
    if (result.removedLines > 0 || result.deletedFiles > 0) {
      log("[log] 清理旧日志：删掉 " + result.removedLines + " 行 / " + result.deletedFiles
        + " 个轮转文件（保留 " + CREW_LOG_RETENTION_DAYS + " 天）");
    }
  } catch (_error) {
    /* 清理失败不能影响加载 */
  }
}

pruneCrewLogs();
try {
  const pruneTimer = setInterval(pruneCrewLogs, 6 * 60 * 60 * 1000);
  if (pruneTimer && typeof pruneTimer.unref === "function") {
    pruneTimer.unref();
  }
} catch (_error) {
  /* 定时器失败也不影响 */
}

function safeRequire(file) {
  try {
    return require(file);
  } catch (error) {
    log(`require failed: ${file} (${error && error.message})`);
    return null;
  }
}

let runtime = null;
let runtimeError = null;
let deps = null;

/** Server-side dependencies, resolved lazily so startup order cannot matter. */
function serverDeps() {
  if (deps) {
    return deps;
  }
  const characterState = safeRequire(path.join(SERVER, "services", "character", "characterState.js"));
  // P1 库存：角色名规则（仓库角色 <玩家名>NFCREW 的唯一性/合法性校验）与钱包。
  const characterName = safeRequire(path.join(SERVER, "services", "character", "characterNameRuntime.js"));
  const walletState = safeRequire(path.join(SERVER, "services", "account", "walletState.js"));
  const identityAllocator = safeRequire(path.join(SERVER, "services", "_shared", "identityAllocator.js"));
  const skillState = safeRequire(path.join(SERVER, "services", "skills", "skillState.js"));
const entityCapacitor = safeRequire(path.join(SERVER, "space", "runtime", "entityCapacitor.js"));
  const worldData = safeRequire(path.join(SERVER, "space", "worldData.js"));
  const itemStore = safeRequire(path.join(SERVER, "services", "inventory", "itemStore.js"));
  const itemTypeRegistry = safeRequire(path.join(SERVER, "services", "inventory", "itemTypeRegistry.js"));
  const corporationState = safeRequire(path.join(SERVER, "services", "corporation", "corporationState.js"));
  const corporationRuntime = safeRequire(path.join(SERVER, "services", "corporation", "corporationRuntimeState.js"));
  const fleetRuntime = safeRequire(path.join(SERVER, "services", "fleets", "fleetRuntime.js"));
  const fitting = safeRequire(path.join(SERVER, "services", "fitting", "liveFittingState.js"));
  const miningDogma = safeRequire(path.join(SERVER, "services", "mining", "miningDogma.js"));
  // M9: weapon family predicates (turret / missile) reused from the engine's own dogma.
  const weaponDogma = safeRequire(path.join(SERVER, "space", "combat", "weaponDogma.js"));
// 导弹伤害/射程结算（齐射用：不走导弹实体，只算伤害与射程）。
const missileSolver = safeRequire(path.join(SERVER, "space", "combat", "missiles", "missileSolver.js"));
// 导弹部署特效的时间戳/可见性选项：和服务端自己的武器周期同一套
// （space/runtime/scene/modules.js 里 effects.MissileDeployment 走的就是它）。
const sendOptions = safeRequire(path.join(SERVER, "space", "destiny", "delivery", "sendOptions.js"));
// 激活中的模块上下文（会战/后勤/工业核心的射程、伤害加成要它才会算进快照）。
const entityDogmaView = safeRequire(path.join(SERVER, "space", "runtime", "entityDogmaView.js"));
const superweaponRuntime = safeRequire(path.join(SERVER, "space", "modules", "superweapons", "superweaponRuntime.js"));
const npcBehaviorLoop = safeRequire(path.join(SERVER, "space", "npc", "npcBehaviorLoop.js"));
const npcService = safeRequire(path.join(SERVER, "space", "npc", "npcService.js"));
const shipActionRestrictions = safeRequire(path.join(SERVER, "space", "runtime", "shipActionRestrictions.js"));
const destinyMovementEngine = safeRequire(path.join(SERVER, "space", "runtime", "destinyMovementEngine.js"));
  const miningState = safeRequire(path.join(SERVER, "services", "mining", "miningRuntimeState.js"));
  const miningInventory = safeRequire(path.join(SERVER, "services", "mining", "miningInventory.js"));
  const chatRuntime = safeRequire(path.join(SERVER, "_secondary", "chat", "chatRuntime.js"));
  const itemCustody = safeRequire(path.join(SERVER, "services", "inventory", "itemCustody.js"));
  // Live sessions (web panel) and the server-side saved-fitting store.
  const chatSessionRegistry = safeRequire(path.join(SERVER, "services", "chat", "sessionRegistry.js"));
  const savedFittingStore = safeRequire(path.join(SERVER, "_secondary", "fitting", "fittingStore.js"));
  // The compression manager is a BaseService subclass: instantiate it once.
  const compressionService = safeRequire(path.join(SERVER, "services", "mining", "inSpaceCompressionMgrService.js"));
  let compression = null;
  if (typeof compressionService === "function") {
    try {
      const instance = new compressionService();
      if (instance && typeof instance.Handle_CompressItemInSpace === "function") {
        compression = instance;
      }
    } catch (error) {
      compression = null;
    }
  }
  const spaceRuntime = safeRequire(path.join(SERVER, "space", "runtime.js"));
  // 诱导入场的 cyno 力场是个动态实体，itemID 必须由引擎的分配器发（和场景共用同一个计数器）。
  const runtimeEntityIdentity = safeRequire(path.join(SERVER, "space", "runtime", "runtimeEntityIdentity.js"));
  const creation = safeRequire(path.join(SERVER, "services", "character", "characterCreationData.js"))
    || safeRequire(path.join(SERVER, "services", "character", "characterCreation.js"));
  deps = {
    crewLogFile: CREW_LOG_FILE,
    sessionRegistry: chatSessionRegistry || null,
    fittingStore: savedFittingStore || null,

    characterState: characterState || null,
  skillState: skillState || null,
  entityCapacitor: entityCapacitor || null,
    identityAllocator: identityAllocator || null,
    // P1 库存：角色名规则与钱包（仓库角色创建、订货扣款/卖出退款用）。
    characterName: characterName || null,
    wallet: walletState || null,
    // 动态实体的 itemID 分配（诱导力场用）。拿不到就退回"不点灯、直接跳入"。
    allocateEntityID: runtimeEntityIdentity
      && typeof runtimeEntityIdentity.allocateRuntimeEntityID === "function"
      ? () => runtimeEntityIdentity.allocateRuntimeEntityID()
      : null,
    worldData: worldData || null,
    creation: creation || null,
    itemStore: itemStore || null,
    corporations: corporationState || null,
    corporationRuntime: corporationRuntime || null,
    fleetRuntime: fleetRuntime || null,
    fitting: fitting || null,
    // Push the moved item to the player's client so an open inventory refreshes.
    notifyInventory: itemStore && typeof itemStore.findItemById === "function"
      ? (session, itemID) => {
        try {
          if (!session) {
            return;
          }
          const item = itemStore.findItemById(itemID);
          if (item && typeof characterState.buildItemChangePayload === "function") {
            // The engine's own refresh path: OnItemChange with the new location/flag.
            const payload = characterState.buildItemChangePayload(item, {});
            if (payload) {
              session.sendNotification("OnItemChange", "clientID", payload);
              return;
            }
          }
          if (item && typeof characterState.syncInventoryItemForSession === "function") {
            characterState.syncInventoryItemForSession(session, item, {}, {});
          }
        } catch (_error) {
          /* best effort */
        }
      }
      : null,
    // M5: the in-space compression facility API (Handle_CompressItemInSpace).
    compression: compression || null,
    cargoHoldFlagFallback: 5,
    oreHoldFlagFallback: 134,
    // Restored: dropping these silently broke mining-module resolution (0 modules).
    miningDogma: miningDogma || null,
    weaponDogma: weaponDogma || null,
    missileSolver: missileSolver || null,
    // 导弹 deployment 特效的发送选项（缺了退回普通 payload，画面还在、时间戳规则差一点）。
    sendOptions: sendOptions || null,
    dogmaView: entityDogmaView || null,
  superweaponRuntime: superweaponRuntime || null,
  npcBehaviorLoop: npcBehaviorLoop || null,
  npcService: npcService || null,
  shipActionRestrictions: shipActionRestrictions || null,
  destinyMovementEngine: destinyMovementEngine || null,
    miningState: miningState || null,
    miningInventory: miningInventory || null,
    // PR-war: 交战规则判定（宣战状态）用引擎自己的战争表，不自己造一套。
    warRuntime: safeRequire(path.join(SERVER, "services", "corporation", "warRuntimeState.js")) || null,
    // M5 glue: the ore-hold flag of a ship, and its used/capacity volume.
    oreHoldFlag: miningInventory && typeof miningInventory.getPreferredMiningHoldFlagForType === "function"
      ? ({characterID, shipID}) => {
        try {
          const shipItem = typeof itemStore.findShipItemById === "function"
            ? itemStore.findShipItemById(shipID)
            : null;
          const fittedItems = fitting && typeof fitting.getFittedModuleItems === "function"
            ? fitting.getFittedModuleItems(characterID, shipID) || []
            : [];
          const skillMap = skillState && typeof skillState.getCachedCharacterSkillMap === "function"
            ? skillState.getCachedCharacterSkillMap(characterID)
            : null;
          return miningInventory.getPreferredMiningHoldFlagForType(
            characterID,
            shipItem,
            fittedItems,
            0,
            skillMap,
          );
        } catch (_error) {
          return 0;
        }
      }
      : null,
    // NOTE: buildShipResourceState costs 500-1100 ms per call (measured: 3 crew ships =
    // 1.7 s of blocked event loop per pass, which is what pushed the grid into time
    // dilation). The hold layout only changes when the ship/fit does, so the result is
    // memoised briefly; `used` is recomputed cheaply by the callers from item stacks,
    // but the cached value keeps this wrapper honest for callers that trust it.
    invalidateHoldVolume: null,
    holdVolume: fitting && typeof fitting.buildShipResourceState === "function"
      ? ((cache) => ({characterID, shipID}) => {
        const key = `${Number(characterID) || 0}:${Number(shipID) || 0}`;
        const now = Date.now();
        const hit = cache.get(key);
        if (hit && now - hit.at < 600000) {
          return hit.value;
        }
        try {
          const shipItem = typeof itemStore.findShipItemById === "function"
            ? itemStore.findShipItemById(shipID)
            : null;
          if (!shipItem) {
            return null;
          }
          const fittedItems = typeof fitting.getFittedModuleItems === "function"
            ? fitting.getFittedModuleItems(characterID, shipID) || []
            : [];
          const skillMap = typeof skillState.getCachedCharacterSkillMap === "function"
            ? skillState.getCachedCharacterSkillMap(characterID)
            : null;
          const resources = fitting.buildShipResourceState(characterID, shipItem, {fittedItems, skillMap});
          // Mining holds are their own resource keys (flag 134 = generalMiningHold).
          // Using cargoCapacity reported 350 m³ and made the hold look 25% full.
          const capacity = Number(
            (resources && (
              resources.generalMiningHoldCapacity
              || resources.asteroidHoldCapacity
              || resources.iceHoldCapacity
              || resources.cargoCapacity
            )) || 0,
          ) || 0;
          let used = 0;
          const items = typeof itemStore.listContainerItems === "function"
            ? itemStore.listContainerItems(characterID, shipID) || []
            : [];
          for (const item of items) {
            used += Number(item && item.volume) || 0;
          }
          const value = {used, capacity};
          cache.set(key, {value, at: now});
          return value;
        } catch (_error) {
          return null;
        }
      })(new Map())
      : null,
    // Range with skills/rigs/bursts, for holding at max range while mining.
    // S1：整船属性重建很贵（0.5–1.1 s/次），而射程只跟"船 + 模块 + 装配 + 技能"有关，
    // 所以走 5 秒 TTL 的快照缓存（和武器齐射、遥修共用同一个模块）。
    buildMiningSnapshot: miningDogma && itemStore && skillState && typeof miningDogma.buildMiningModuleSnapshot === "function"
      ? ({characterID, shipID, moduleItem, effectRecord, fittedItems}) => {
        const cacheRequest = {characterID, shipID, moduleItem, chargeItem: null};
        const cached = snapshotCache.get(cacheRequest);
        if (cached) {
          return cached;
        }
        let shipItem = null;
        try {
          shipItem = typeof itemStore.findShipItemById === "function"
            ? itemStore.findShipItemById(shipID)
            : null;
        } catch (_error) {
          shipItem = null;
        }
        let skillMap = null;
        try {
          skillMap = typeof skillState.getCachedCharacterSkillMap === "function"
            ? skillState.getCachedCharacterSkillMap(characterID)
            : null;
        } catch (_error) {
          skillMap = null;
        }
        const snapshot = miningDogma.buildMiningModuleSnapshot({
          characterID,
          shipItem,
          moduleItem,
          effectRecord,
          fittedItems,
          skillMap,
        });
        return snapshotCache.set(cacheRequest, snapshot);
      }
      : null,
    resolveItemByTypeID: itemTypeRegistry && typeof itemTypeRegistry.resolveItemByTypeID === "function"
      ? (typeID) => itemTypeRegistry.resolveItemByTypeID(typeID)
      : null,
    runtime: spaceRuntime || null,
    skillsSeed: skillState && typeof skillState.seedCharacterAllSkills === "function"
      ? (characterID) => skillState.seedCharacterAllSkills(characterID)
      : null,
    // PR-3: the sessions of one player account. "First session" must never
    // resolve to another player's login.
    sessionsFor: (accountID) => sessionsFor(accountID),
    log,
  };
  return deps;
}

function sessionsFor(accountID) {
  const wanted = Number(accountID) || 0;
  const registry = deps && deps.sessionRegistry;
  const list = registry && typeof registry.getSessions === "function" ? registry.getSessions() : [];
  if (!wanted) {
    return list;
  }
  return list.filter((session) => tenantModule.resolveAccountID(session, deps) === wanted);
}

function createRuntimeInstance(extra = {}) {
  const {createRuntime} = require(path.join(MOD_DIR, "lib", "nfCrewMiningRuntime.js"));
  return createRuntime({deps: serverDeps(), log, ...extra});
}

/** The legacy single runtime, shared by every player (EVEJS_CM_TENANT_MODE=0). */
function getRuntime() {
  if (runtime) {
    return runtime;
  }
  if (runtimeError) {
    throw runtimeError;
  }
  try {
    runtime = createRuntimeInstance();
    return runtime;
  } catch (error) {
    runtimeError = error;
    log(`runtime init failed: ${error && error.message}`);
    throw error;
  }
}

let router = null;

function getRouter() {
  if (router) {
    return router;
  }
  router = createRuntimeRouter({
    createRuntime: (options) => createRuntimeInstance({
      tenant: options.tenant,
      configsDir: options.configsDir,
      stateFile: options.stateFile,
      panelToken: options.panelToken,
      log: options.log,
    }),
    registry: tenantModule.createTenantRegistry({log}),
    log,
  });
  return router;
}

/** The runtime of one player account (PR-3). */
function getRuntimeFor(accountID) {
  if (!TENANT_MODE) {
    return getRuntime();
  }
  const runtimeForAccount = getRouter().get(accountID);
  warnAboutLegacyState(accountID);
  return runtimeForAccount;
}

const LEGACY_WARNED = new Set();

/**
 * Upgrading an install leaves the old single-tenant pool behind: the new tenant
 * starts empty and the player sees their crew "disappear". Say it once, loudly,
 * with the exact command that claims the crew.
 */
function warnAboutLegacyState(accountID) {
  if (LEGACY_WARNED.has(accountID)) {
    return;
  }
  LEGACY_WARNED.add(accountID);
  try {
    if (fs.existsSync(getRouter().pathsFor(accountID).stateFile)) {
      return;
    }
    const legacy = path.join(WORKSPACE, "_local", "gameStore", "nf-crew", "state.json");
    if (!fs.existsSync(legacy)) {
      return;
    }
    log(`旧版单租户存档还在（${legacy}），但租户 ${accountID} 的池子是空的；`
      + `认领请跑 node tools/migrate-tenants.js --account ${accountID} --apply`);
  } catch (_error) {
    /* a warning must never break a command */
  }
}

function resetRuntimes() {
  if (router) {
    router.reset();
  }
  runtime = null;
  runtimeError = null;
  LEGACY_WARNED.clear();
}

/** Answer /crewmine (or !crewmine), or return null so the server handles the message. */
function handleCrewMine(session, rawMessage, chatHub, options) {
  const trimmed = String(rawMessage == null ? "" : rawMessage).trim();
  // 非 GM 角色：客户端会吞掉它不认识的 `/命令`，但**普通聊天消息**一定会送到服务端，
  // 而 LSC 的 Handle_SendMessage 同样会走 executeChatCommand → 走到这里。
  // 所以额外支持 `!crewmine <参数>`（不带斜杠、也不会被当成聊天广播出去）。
  let argumentText = null;
  if (trimmed.startsWith("/") || trimmed.startsWith(".")) {
    const [commandName, ...rest] = trimmed.slice(1).trim().split(/\s+/);
    if (!commandName || commandName.toLowerCase() !== "crewmine") {
      return null;
    }
    argumentText = rest.join(" ");
  } else if (/^!crewmine(\s|$)/iu.test(trimmed)) {
    argumentText = trimmed.replace(/^!crewmine/iu, "").trim();
  } else {
    return null;
  }
  // 逐条命令回显只在调试模式写（以前这里会把**所有模组**的聊天命令都抄进 crew.log）。
  if (process.env.EVEJS_CM_DEBUG === "1") {
    log(`[cmd] char=${Number(session && (session.characterID || session.charid)) || 0} raw="${trimmed.slice(0, 120)}"`);
  }
  const replies = safeRequire(COMMAND_REPLIES);
  const reply = (message) => {
    if (replies && typeof replies.handledResult === "function") {
      return replies.handledResult(chatHub, session, options, message);
    }
    return {handled: true, message};
  };
  try {
    // PR-3: the command belongs to the account behind this session.
    const accountID = TENANT_MODE ? tenantModule.resolveAccountID(session, serverDeps()) : 0;
    const text = getRuntimeFor(accountID).handleText(argumentText, {session});
    const settle = (value) => {
      log(`[reply] ${String(value).split("\n").slice(0, 6).join(" | ").slice(0, 600)}`);
      return reply(String(value));
    };
    // 订货/卖出要等钱包（process 模式只能异步扣款）：handleText 可能返回 Promise。
    if (text && typeof text.then === "function") {
      return text.then(settle).catch((error) => {
        log(`command failed: ${error && error.stack ? error.stack : error}`);
        return reply(`crewmine 出错：${error && error.message ? error.message : String(error)}`);
      });
    }
    return settle(text);
  } catch (error) {
    log(`command failed: ${error && error.stack ? error.stack : error}`);
    return reply(`crewmine 出错：${error && error.message ? error.message : String(error)}`);
  }
}


function normalizeLoadPath(value) {
  return String(value || "").replace(/\\/g, "/").toLowerCase();
}

function installChatHook() {
  if (installChatHook.installed) {
    return;
  }
  const originalLoad = Module._load;
  const wrapped = new WeakMap();

  Module._load = function load(request, parent, isMain) {
    // Resolve inside a guard: some mods serve virtual modules through their own
    // inner hook, and resolving those here would abort server startup.
    let resolved = null;
    try {
      resolved = Module._resolveFilename(request, parent, isMain);
    } catch (_error) {
      return originalLoad.call(this, request, parent, isMain);
    }
    const exported = originalLoad.call(this, request, parent, isMain);
    // M7a login delivery is DISABLED: hooking handshake.js made the client lose its
    // whole UI (the login source it received no longer compiled). The handshake module
    // is therefore left completely untouched until the injected source has been proven
    // to compile. See docs/client-ui.md .
    if (!resolved || !String(resolved).endsWith(CHAT_COMMANDS_SUFFIX)) {
      return exported;
    }
    if (wrapped.has(exported)) {
      return wrapped.get(exported);
    }
    if (!exported || typeof exported.executeChatCommand !== "function") {
      return exported;
    }
    const replacement = Object.assign({}, exported);
    replacement.executeChatCommand = function executeChatCommand(session, rawMessage, chatHub, options) {
      const handled = handleCrewMine(session, rawMessage, chatHub, options);
      if (handled) {
        return handled;
      }
      return exported.executeChatCommand(session, rawMessage, chatHub, options);
    };
    wrapped.set(exported, replacement);
    return replacement;
  };
  installChatHook.installed = true;
  log("chat command /crewmine ready");
}

try {
  installChatHook();

  module.exports = {handleCrewMine, getRuntime, getRuntimeFor, getRouter, resetRuntimes, TENANT_MODE};
} catch (error) {
  log(`loader failed: ${error && error.stack ? error.stack : error}`);
  module.exports = {};
}
