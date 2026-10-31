# CHANGELOG

## 1.0.0 — 2026-10-31 · 正式版：日志分级 + 收尾

从 0.6.15 一路到现在的功能都在这版里，主要变化只有“收尾”：

| 项 | 内容 |
| --- | --- |
| **日志分级** | `crew.log` 只写事件级日志（命令结果、库存/仓库、错误、web 操作）；高频诊断（`[tick]`、`[mine]`、`[haul]`、`[follow]`、`[defense]`、`[combat]`、`[cyno]`、`[perf]`、`[ring]`、`[lock]`）**只在调试模式写**。<br>调试模式：游戏里 `/crewmine debug on`，或启动服务端前设 `EVEJS_CM_DEBUG=1` |
| **命令回显** | 以前 `[cmd]` 会把**所有模组**的聊天命令都抄进 `crew.log`；现在只有 `EVEJS_CM_DEBUG=1` 时才写 |
| **版本** | 0.6.x → **1.0.0**（功能集合定格） |
| 文档 | 计划书标题标注“0.7.0 起，2026-10-31 发布为 1.0.0” |

**测试**：**665/665**。

### 1.0.0 包含的主要能力（速览）

- 船员：召唤（诱导入场/跃迁/直接出现）、解散（诱导跳走）、跟随/阵型、采矿（自动选矿/分矿/接近/压缩交付）、战斗（齐射/导弹/集火/追击）、后勤（遥修/传电）、特殊装备（堡垒/会战/末日/立体炸弹）；
- 库存（`stock`）：仓库角色、账本、订货（80% 卖价）、存入/取出/卖出/重购、对账、方案、迁移；
- 配装台：船体/槽位/弹药搜索、挂点与 CPU/PG 校验、无人机带宽、改装件尺寸与同组限制、DPS/EHP 近似模拟；
- 面板：指挥 / 召唤仓库 / 配装台 / 设置 四个页签，每账号独立令牌；
- 非 GM 可用：`!crewmine <参数>`（普通聊天触发）。

## 0.6.45 — 2026-10-31 · 交付即时刷新 + `!crewmine`（非 GM 可用）+ 船员名去重

| 项 | 内容 |
| --- | --- |
| **A1 交付通知** | 交付时「操作用会话」仍是船员的无头会话，但**通知客户端**改用玩家真实会话（`notifySession`）→ `OnItemChange` 不再被 `sendNotification: () => 0` 吞掉，矿石**当场**出现在矿石舱，不用进站/重登 |
| **A2 非 GM 触发** | 新增 `!crewmine <参数>`（普通聊天消息）：LSC 的 `Handle_SendMessage` 同样会走 `executeChatCommand`，所以 `!crewmine ui`、`!crewmine stock` 对非 GM 角色也有效；`/help` 末尾加了一行说明 |
| **A3 新账号 tenant** | 无需改动：`router.get()` 里已经有 `registry.ensure(accountID)`，只要命令能到 runtime 就会自动建 tenant + 面板令牌（之前 9000087 没建，是因为命令根本没送到） |
| **A4 重名去重** | `createMember` 统一走 `uniqueMemberName()`：按池/游戏库已有名字（大小写不敏感）撞名就加 ` 2`/` 3` 后缀，不再产生两个同名船员 |

**测试**：**665/665**（新增：`uniqueMemberName` 撞名加后缀、不撞名原样）。

**遗留**：已经存在的重名（`Talia Falk` ×2、`Kaelen Lund` ×2）不会自动改——改名会动游戏角色记录，需要单独的 `pool rename` 命令（要的话再说）。

## 0.6.44 — 2026-10-31 · 分矿：射程内被认领光就去更远的未认领矿；接近距离留余量

日志实测：6 名船员全锁在 `5836604764002004` 一块矿上，窗口内 20 次「多人同选一块」。

| 项 | 内容 |
| --- | --- |
| 分矿 | `pickFromScan` 原来在「射程内全是别人认领的矿」时会**共用最近那块**；现在改成**先去更远的未认领矿**（`allowFarther` 时），只有所有矿都被认领才共用 |
| 接近距离 | 停在射程的 **80%**（原来 -1km）：以前船漂一点就 OUT_OF_RANGE，再被“保持 N km”拉回，永远进不了射程 |
| 日志 | 接近时记录「跃迁至矿旁 / 跃迁失败改用跟随」，方便下次定位 |

**测试**：**664/664**（新增 `mining-pick` 4 条：射程内空闲优先、全被认领去更远、全被认领才共用、命令路径保持旧行为）。

## 0.6.43 — 2026-10-31 · 配装台补齐：挂点/无人机/改装件校验 + DPS·EHP 模拟 + 库存搜索

| 编号 | 内容 |
| --- | --- |
| **B5** | 高槽区分**炮台位 / 发射器位**：索引存船体 `turretSlots(102)` / `launcherSlots(101)`，模块按效果 42/40 标记；高槽区头显示「炮台 x/y · 发射器 x/y」，下拉按**剩余挂点**过滤，超了报价报「炮台位 2 > 1」 |
| **B7** | 无人机**带宽/容量**校验：无人机带宽占用（属性 1272）×数量 vs 船 1271，体积×数量 vs 船 283；超了报价报错 |
| **B10** | 改装件**同组只能一个**（groupID 去重），保留同尺寸规则 |
| **B9** | **DPS / EHP 模拟**：DPS = 弹药四系伤害之和 × `damageMultiplier(64)` ÷ 射速(51)；EHP = 护盾/装甲/结构 HP ÷ (1−平均 resonance)，抗性取 267–274。汇总行显示 `DPS x · EHP y`（近似：不含无人机、技能与模块抗性加成） |
| **C14** | 库存**搜索**（名字 / 库存ID / 物品ID / 状态）+ 每页 20/50/100；服务端 `stockView` 支持 `query` 与 `limit≤200` |

**索引升到 v6**（船体挂点/血量/抗性、模块武器标记与伤害倍率/射速、弹药四系伤害、无人机带宽）。

**实测**（真数据）：刺客级舰队型 炮台 5 / 发射器 3，HP 2250/2700/2250；425mm磁轨炮 + 暗影钸质轨道弹 → **DPS 18 · EHP 18740**。

**测试**：**660/660**（新增：炮台位超限、无人机带宽超限、同组改装件重复、DPS/EHP 数值）。

## 0.6.42 — 2026-10-31 · 创建方案挪到仓库工具栏 + 方案改成一行多列卡片

| 项 | 内容 |
| --- | --- |
| 创建方案 | 从「召唤方案」窗口里挪到仓库主工具栏，和 **召唤选中 / 卖出 / 取出到 4-4** 放一起：填方案名 → 「创建召唤方案」；旁边加「方案列表」按钮打开方案窗口 |
| 方案窗口 | 里面不再有创建入口，只做「看一眼 / 一键召唤 / 查看详细 / 删除」 |
| 方案列表 | 一个方案一行改成**一行多列卡片**（`gridCards`），卡片内是 方案名 + ID + 船数 + 三个按钮 |
| 详细页 | 不变：列出方案里具体哪几艘船，带「← 返回方案列表」 |

**测试**：**659/659**；面板冒烟确认方案名输入在仓库工具栏（不在方案窗口里）、方案卡片与 CSS 都在。

## 0.6.41 — 2026-10-31 · 重购清掉红记录 + 召唤方案改成独立窗口（含查看详细）

| 项 | 内容 |
| --- | --- |
| 重购 | 重购成功后**删掉那条红色的丢失记录**（列表里不会“买到了还红着”）；结果里会写「已清掉原丢失记录 s-x」 |
| 召唤方案 | 和「转入机库船」同一模式：仓库顶部「召唤方案」按钮 → 独立占据下方整个区域，按钮变绿，右上「返回仓库」 |
| 方案列表 | 每个方案一行：一键召唤 / **查看详细** / 删除；顶部可「用勾选的船创建方案」 |
| 查看详细 | 切到该方案的在库船清单（船名 / 库存ID / 船体物品ID / 价格 / 属于哪个配装组），每艘可单独召唤；左上「← 返回方案列表」回到方案列表 |
| 接口 | `/api/stock/plan` 新增 `action: "detail"`（返回 `plan` + `ships`），并顺带返回“还差几艘”的提示 |

**测试**：**659/659**（新增：方案详情列出在库船；重购后丢失记录被清掉）。

## 0.6.40 — 2026-10-31 · 修：整队矿船挤在同一块矿上

**症状**：多艘船员矿船同时挖同一块小行星，日志里 `[mine] <名字> 目标=<id>` 全是同一个 id。

**根因**：选矿的排他只在 `mineCrew` 一次调用里成立。局部 Set `claimed` 只收集「本次 selected.members 自己的模块目标 + 本次已经选过的矿」；可实际选矿几乎都是**一人一次**——批量下令被错峰拆成 `mineCrew(名字)`，矿采空后的重选队列也是逐个 `mineCrew(名字)`。单人调用时 `claimed` 必为空，于是每个人都在空集合里挑「最近的一块」，而距离基准以前还是**玩家船**（全队同一个点）→ 同一个 itemID。

| 项 | 内容 |
| --- | --- |
| 认领表 | 新增 runtime 级 `rockClaims`（`systemID:itemID → crewID`）：**选中那一刻**就占用（不等模块开起来，中间还有十几秒在飞），别人选矿时并进 `excludeIDs` |
| 距离基准 | `pickRockDetailed` 的 `sourceEntity` 从玩家船改成**船员自己那条船**：以前全队从同一个点量距离，最近的一块永远同一个 |
| 续挖 | 走 `activeRock` 的已认领矿会**补一次占用**（重启/懒清理后自愈） |
| 释放 | 矿采空、换矿、停采、召回、解散、被爆都不用手工清：`pruneRockClaims` 在每次下令时按「矿实体还在不在 + 人还在不在 `miningWanted`」懒清理，漏一处也不会永久占住一块矿 |
| 边界 | 只放内存不落盘（落盘会留占位残留）；按 runtime 实例隔离，多租户不串；矿不够时仍是 `pickFromScan` 的共享兜底，只是不再无脑挤最近那块 |

**测试**：**657/657**（新增 5：认领/释放/跨星系、懒清理、两人分别下令不撞矿、矿采空后换下一块、距离按自己船算。三条行为用例在修复前全红——都取到同一块矿）。

## 0.6.39 — 2026-10-30 · 丢失的船加「重购」按钮

| 项 | 内容 |
| --- | --- |
| 面板 | 已丢失（红卡）的船，按钮从「召唤（禁用）」换成 **重购**：确认后按同一配装再买一艘（80% 卖价、进仓库） |
| 重购逻辑 | `stockRebuy(id)`：先按 `signature` 找现有蓝图；找不到（配装台拼的自定义船）就用库存里存的配装快照还原成 fit 再买 |
| 旧记录 | 保留那条红色的丢失记录（当历史），新船是新的 `stored` 记录 |
| 接口 | 新增 `/api/stock/rebuy`（`{id}`），和订货同一条链路（扣款失败不造船） |

**测试**：**653/653**（新增 2：有蓝图时重购扣款入库、无蓝图时用快照重购）。

## 0.6.38 — 2026-10-30 · 修：重新登录后库存账本被清空

两个叠加的 bug：

1. **`normalizeState` 把 `stock` 当“未知字段”丢掉**：每次重新加载 state.json（重启、新实例），账本在内存里就是空的；下一次任何写盘（pool/settings 更新）就把空账本写回去 → 船还在、账本没了（`spent/seq` 也归零，说明不是逐条删除，而是整体被空账本覆盖）。
2. **旧实例整份覆盖新数据**：`stateStore` 把整份 state 缓存在内存，`update()` 直接整份写回；如果同账号存在两个实例（热重载/旧定时器），旧实例写一次就把新数据盖掉。

修法：

| 项 | 内容 |
| --- | --- |
| 保留账本 | `normalizeState` 明确保留 `stock`（交给 `normalizeStock` 规整） |
| 防覆盖 | `stateStore.update()` 写盘前比对文件指纹（mtime+size）：磁盘已被别的实例改过就先重新加载再改，避免旧快照覆盖 |
| 提示 | 开启库存但账本为空、而仓库角色机库里有船时，`/crewmine stock` 会提示「/crewmine stock reconcile adopt 可以认领回来」 |

**恢复已有数据**：重启后执行 **`/crewmine stock reconcile adopt`**，会把仓库角色机库里的船重新认领进账本（来源=自有，实付价 0；被清零的累计花费无法还原）。

**测试**：**651/651**（新增：两个实例共用一份文件时，旧实例写盘不会清掉新账本；`normalizeState` 保留 stock）。

## 0.6.37 — 2026-10-30 · 召唤仓库：点卡片选择（绿/蓝/红），去掉勾选框

| 项 | 内容 |
| --- | --- |
| 选择方式 | 不再用勾选框：**点卡片 = 选中/取消**，选中卡片变**绿**（边框+底色+名字变绿） |
| 状态颜色 | **在用**的船卡片变**蓝**（不可选，点了提示“在船员的船上”）；**已丢失**变**红**（名字划线、不可选） |
| 批量 | 工具栏「全选本页」按钮：点一下选中本页所有在库船，再点清空（按钮文字会在「全选本页/清空选择」间切换） |
| 防御 | 面板所有接口回复统一用 `linesText()` 转文本；服务端 `stockBuy` 回调对返回值做数组兜底——之前旧后端/异常路径会把 Promise 当数组用，报 `lines.some is not a function` |

**测试**：**650/650**；面板冒烟确认「无勾选框 / 有全选按钮 / `stockCardClick` / 三色 CSS」都在。

## 0.6.36 — 2026-10-30 · 修：召唤出来的船“没有装备”

原因：服务端 `transferItemToOwnerLocation` 默认**只改船体那一行**的 ownerID，船里的模块/弹药仍属于原主人（仓库角色）。模组转移时没传 `options.reownContents`，于是按 owner 过滤的读（船员详情 `listContainerItems`、`snapshotFit`）一条模块都读不到——看起来就是“没装备的船壳”。

| 修法 | 内容 |
| --- | --- |
| 转移 | `warehouseModule.transferShip` 现在传 `{reownContents: true}`：取船/取出/存入/解散回库/迁移都会连内容一起过户 |
| 补过户 | 新增 `reownShipContents(deps, {shipID, characterID})`：把 `locationID = 船` 的所有物品 owner 改成新主人（位置/flag 不变）；`takeStockShip` 取船后跑一次，`stock reconcile` 对“在用”的船也跑一次 |
| 对账 | 对账结果新增「补过户装备 N 件」一行 |

**测试**：**650/650**（新增：转移带 `reownContents`；`reownShipContents` 只动不属于新主人的物品并保留 flag）。

## 0.6.34 — 2026-10-30 · 修：人在太空，面板召唤却说「没有所在星系/飞船」

原因：面板调用召唤时传的是 `serviceSession`——那是**某次命令时缓存的会话快照**。如果那次是在站里跑的（或者更早），快照里没有 `_space`，模组就以为你不在太空，哪怕你其实已经出站了。

修法：

| 项 | 内容 |
| --- | --- |
| 会话选择 | `resolvePlayerSession()` 改成：优先用**本账号最新的在太空会话**（`_space.systemID > 0`）；缓存的快照没 `_space` 就自动替换，并更新缓存 |
| 召唤 | `spawnCrew` 与 `stockSummonShips` 都会先换会话再取 `systemID/shipID`；面板的订货/机库/卖出/方案一键召唤也都传实时会话 |
| 提示 | 真拿不到会话时，提示改成「没拿到你的在太空会话…按一下 `/crewmine status` 或移动一下让模组看到你」 |

**测试**：**649/649**（新增：缓存会话在站里、注册表里有在太空会话时，召唤照样成功）。

## 0.6.33 — 2026-10-30 · 修：process 模式下订货扣款失败（WALLET_ERROR:SYNC_WALLET_AUTHORITY_DISABLED）

用户报：`扣款失败（WALLET_ERROR:synchronous wallet command character.adjust-isk is disabled in process mode），没有造任何船`。

原因：服务端开了**钱包进程权威**（process mode），同步钱包命令被禁用，只能用 `adjustCharacterBalanceAsync`；模组之前只调同步接口。

修法：

| 项 | 内容 |
| --- | --- |
| 扣款/退款 | 新增 `walletAdjustAsync`：先试同步（本地权威，行为不变）；若报 `SYNC_WALLET_AUTHORITY_DISABLED` / `process mode`，自动改走异步接口并等结果；异步接口也没有时报清楚的人话 |
| 异步链路 | `stockBuy` / `stockSell` / `fitOrder` 改成 async；钱包扣款/退款都 `await`，失败就不造船 |
| 聊天命令 | `handleText` 现在可以返回 Promise（`/crewmine stock buy` 会等扣款完成再回复；loader 已支持 Promise 回复，服务端 slash/LSC 都支持） |
| 面板接口 | `/api/stock/*`、`/api/fit/*`、`/api/cmd` 都 `await` 处理结果，面板能拿到真实结果 |

**测试**：**648/648**（新增 1 条：模拟 process 模式——同步接口抛错、异步接口成功时，订货照样扣款并入库）。

## 0.6.32 — 2026-10-30 · 配装台：CPU/PG 按「全技能 V」计算

以前 `CPU 305/340 · PG 1410/950` 用的是**船体基础值 + 模块原始需求**，等于 0 技能，当然显得装不下。

现在默认按**全 V**：

| 项 | 倍率 |
| --- | --- |
| 船体 CPU / PG 输出 | **×1.25**（Electronics V / Engineering V 各 +5%/级） |
| 所有模块 CPU / PG 需求 | **×0.75**（CPU Management V / Power Grid Management V） |
| 炮台 / 发射器额外 | **再 ×0.75**（Weapon Upgrades V / Advanced Weapon Upgrades V，合计 ×0.5625） |

- 配装台工具栏新增「技能全 V」勾选框（默认勾上）；取消勾选就回到基础值对比。
- 汇总行开头标「全 V ·」或「基础 ·」，槽位卡的 `CPU x / PG y` 也是全 V 后的数字。
- 服务端报价（`/api/fit/quote`）接受 `allV`，与界面同一套算法；炮台/发射器靠索引里的 `w` 标记（SDE 效果 `turretFitted` / `launcherFitted`）识别。
- 类型索引升到 **v5**（模块多了 `w` 标记）。

**实测**：刺客级舰队型 基础 340/950 → **全 V 425/1188**；`50 CPU / 10 PG` 的模块全 V 后 `37.5 / 7.5`。

**测试**：**647/647**（新增全 V 倍率断言）。

## 0.6.31 — 2026-10-30 · 下拉搜「大型」找不到？—— 排序 + 计数 + 滚动提示

核查结论：**模块没丢**。8529（大型F-S9覆盖式紧凑型护盾扩展装置）一直在中槽列表里——搜「大型」时它排在**第 30 位**，而下拉面板只露出 7 行，且中文排序把「超大型…」排在「大型…」前面，看起来就像没有。

修法：

| 改动 | 效果 |
| --- | --- |
| 排序按相关度 | 完全相等 > **前缀命中** > 包含；搜「大型」时「大型护盾扩展装置」不再被「超大型…」压在下面 |
| 显示匹配数 | 列表底部多一行「共 N 件匹配 · 上面可滚动」，超过 300 件时提示「还有 M 件，继续输入缩小范围」 |
| 列表加高 | 面板列表高度 280 → 320 px |
| 重新加载模块 | 配装台加了「重新加载模块」按钮：清掉页面缓存、重新向服务端要列表（服务端升级/索引重建后不用刷新整页） |
| 槽位候选数 | 每个槽位卡显示「可选 N 件」，过滤前/后差多少一眼可见 |

**测试**：**647/647**；面板冒烟确认 `rankByQuery`、匹配提示、重新加载按钮与 CSS 都在。

## 0.6.30 — 2026-10-30 · 面板自检「后端到底重启没有」

用户报「中槽显示不对，比如刺客级没有 8529」——8529 是**大型F-S9覆盖式紧凑型护盾扩展装置**（中槽，CPU 35 / PG 140），它本身是合法中槽模块。这类"东西少了"的现象，最典型的原因是**服务端没重启**：

- 面板的 HTML/JS 是每次从磁盘读的，所以**刷新页面就能看到新界面**；
- 但 `/api/fit/catalog`、索引缓存、超预算回退、rigSize 这些都在**服务端代码**里：旧版每族只返回 200 条（中槽实际 909 条），于是中槽会缺一大半。

这版加了自动自检，让这种情况不再靠猜：

| 机制 | 行为 |
| --- | --- |
| 版本号比对 | `/api/status` 现在带模组版本；面板拿它和自己的版本比，不一致就在页签下方显示**黄色警示条**：「服务端 x / 面板 y：接口还是旧版的，重启游戏服务端后再刷新」 |
| 截断检测 | `/api/fit/catalog` 返回 `total`；面板发现 `modules.length < total`（旧后端截到 200）时，配装台信息行直接写「服务端只返回了 200/909 个 med 模块 —— 重启游戏服务端后再刷新」 |

**测试**：**647/647**；面板冒烟确认版本警示条、`syncVersionWarn`、截断提示与 CSS 都在。

## 0.6.29 — 2026-10-30 · 配装台：超预算不再清空下拉 + 卸载按钮 + 状态条固定顶部

| 问题 | 修法 |
| --- | --- |
| 超了 CPU/PG 后，下拉里的装备全消失 | 原因是「只看装得下的」按**剩余**预算过滤：已经超了，剩余是负数，所有模块都被滤掉。现在一旦发现已超预算，就退一步按「这件**本身**在船体上限内」过滤，至少还能挑一件换上去；并且**当前装着的这件永远留在列表里** |
| 没有卸载按钮 | 每个槽位卡底部新增「卸载」（空槽位时灰掉），点一下清掉装备和弹药并重新报价 |
| 汇总行在底部看不到 | 把 `CPU / PG / 槽位 / 合计 / 问题` 状态条挪到槽位区**上方并 sticky 固定**；超预算时整条变黄边，滚动槽位时始终可见 |

**测试**：**647/647**；面板冒烟确认状态条位置、`fitUnloadSlot`、超预算回退逻辑与 sticky 样式都在。

## 0.6.28 — 2026-10-30 · 配装台：弹药也能搜 + 槽位复制/粘贴

| 项 | 内容 |
| --- | --- |
| 弹药下拉 | 和装备下拉同一套组件：收起显示当前弹药（或「（不装弹药）」），点开面板**顶部带搜索框**，按名字过滤；选中后按钮显示弹药名 |
| 槽位复制 | 每个槽位卡底部新增「复制」：把这个槽位的**装备 + 弹药**存进面板剪贴板（切换船体时清空） |
| 槽位粘贴 | 「粘贴」把剪贴板内容装到目标槽位；会校验**槽位家族**（高槽不能粘中槽装备）和**改装件尺寸**，不合法直接提示，不会装错 |
| 提示 | 复制/粘贴/失败原因都显示在配装台底部的提示行 |

**测试**：**647/647**；面板冒烟确认弹药搜索下拉、`fitCopySlot/fitPasteSlot`、剪贴板状态与 CSS 都在。

## 0.6.27 — 2026-10-30 · 配装台：下拉栏保持原样，搜索框放到下拉面板顶部

0.6.26 把输入框直接摊在外面，太难看了。改成：

| 状态 | 样子 |
| --- | --- |
| 收起 | 就是**原来的下拉条**：深色框 + 当前装备名（没装显示「（空）」）+ 右侧 ▾ |
| 点开 | 面板最顶部是**搜索框**（自动聚焦），下面才是选项列表，每项右侧带 `CPU x / PG y` |
| 操作 | 边打边过滤；`↑/↓` 移动高亮、`Enter` 选第一项、`Esc` 或点空白收起；选中后按钮显示新装备名 |
| 船体 | 同样样式：收起显示船体名，点开顶部搜索框 + 400+ 船体列表（带槽位数） |

**测试**：**647/647**；面板冒烟确认船体下拉、槽位下拉、`toggleSelect/renderSelectList/pickSelectItem` 与 CSS 都在。

## 0.6.26 — 2026-10-30 · 配装台：搜索直接做进下拉框（船体 + 每件装备）

按反馈：搜索不该是外挂的一个输入框，应该**在每个下拉框里直接输入搜索**。

| 位置 | 现在 |
| --- | --- |
| 船体 | 换成可搜索下拉：点一下列出全部 400+ 船体，直接输入名字（中文/英文都行）过滤，回车选第一项；显示 高/中/低/改装/子系统 槽位数 |
| 每个装备槽位 | 每个槽位一张卡，卡里的输入框就是搜索框：聚焦列出全部可装装备，边打边过滤（名字或 typeID），Enter 选第一项、Esc 收起；已装的模块名会显示在框里 |
| 过滤规则 | 仍然按 槽位家族 + 改装件尺寸（同尺寸才出）+ 勾选「只看装得下的」时按剩余 CPU/PG 过滤；选完后该槽显示 CPU/PG 占用 |
| 移除了 | 外挂的全局「搜索装备」输入框（被每个下拉框自带搜索取代） |

**测试**：**647/647**；面板冒烟确认船体搜索框、槽位搜索框标记、`openSlotPicker` 全选行为与 CSS 都在。

## 0.6.25 — 2026-10-30 · 面板：页签铺满、机库独占、配装台分区 + 搜索 + 槽位过滤

| 用户反馈 | 改动 |
| --- | --- |
| 页签挤成一块 | 页签改成 `flex:1` 铺满整行（指挥 / 召唤仓库 / 配装台 / 设置） |
| 老设置按钮没删 | 顶栏 ⚙ 按钮删掉，只留页签 |
| 转机库按钮不变化 | 「转入机库船」变成开关：打开变**绿色**、再点/关闭复原 |
| 打开机库还显示别的东西 | 机库打开时**独占下方整个区域**（库存列表/订货/方案/分页全部隐藏），关闭才回来；船也按**卡片分列**，不再一条一行 |
| 高/中/低槽没分开 | 配装台按 **高槽 / 中槽 / 低槽 / 改装件 / 子系统** 分区，每个槽位一张卡 |
| 没有插件槽位 | 新增**改装件**（rig）槽位；T3 船还有**子系统**槽位（类型索引新增 32 类子系统，共 48 件） |
| 显示了装不上的装备 | 模块下拉三重过滤：① 只看该槽位家族；② 改装件按**船体尺寸**（`rigSize`）匹配；③ 勾了「只看装得下的」就按**剩余 CPU/PG** 过滤；报价时也会对尺寸不符的改装件报错 |
| 没有搜索 | 配装台加「搜索装备」输入框，实时过滤所有槽位的模块下拉 |

**索引**：类型索引升到 **v4**（新增 rigSize / 子系统槽位 / 32 类子系统），模块一次给全：高 1399 / 中 909 / 低 1017 / 改装 642 / 子系统 48 / 无人机 154。

**测试**：**647/647**；面板冒烟确认页签、机库独占结构、配装台工具栏与分区代码。

## 0.6.24 — 2026-10-30 · 面板：设置独立成页签 + 列表改「一行多列」卡片

| 项 | 内容 |
| --- | --- |
| 设置页签 | 「设置」从顶栏弹出小盒子改成和「召唤仓库」「配装台」一样的**独立页签**（齐射 / NPC 模式 / 调试日志 / 火力集中开·关 / 配装条数） |
| 船员列表 | 从「一条船员占一整行」的表格改成**卡片网格**：`repeat(auto-fill, minmax(340px, 1fr))`，一行放 2–4 张卡；卡里是名字+徽标 / 船型 / 状态·货舱·压缩 / 操作按钮；点卡片仍然选中该船员 |
| 召唤仓库 | 同样改成卡片网格：勾选框 + 船名 + ID + 状态·来源·价格 + 召唤按钮 |
| 累计花费 | 仓库头部那行现在显示「累计花掉 X / 退回 Y」 |

**测试**：**647/647**；面板冒烟确认 4 个页签、两处 `gridCards` 容器、卡片渲染函数与 CSS 都在。

## 0.6.23 — 2026-10-29 · 面板：机库转入改成「逐艘勾选」+ 会话兜底

用户反馈：点「转入机库船」只回一句「你在吉他 4-4 没有可转入的船」，**没有任何可选的界面**。

| 修的东西 | 说明 |
| --- | --- |
| 机库选择面板 | 点「转入机库船」在库存窗口下方展开「吉他 4-4 机库」：逐艘列出（名字 / typeID / itemID），带勾选框 +「转入选中」「全部转入」「关闭」；**正在驾驶的那艘**灰掉并标「正在驾驶」 |
| 没有会话时不再装空 | 以前 `serviceSession` 为空（面板打开后还没跑过命令）时，机库查询直接返回空列表 + 那句误导的提示。现在会退回**本账号第一个在线会话**（和装配列表同一套规则）；真没会话时明确回 `NO_SESSION` + 提示「先在游戏里动一下（或重开面板）」 |
| POST body | `/api/stock/deposit` 以前不读 body，面板选的 itemID 根本传不到后端；现在读（空 body 也兼容） |
| 存款动作 | `stockDeposit(session, itemIDs)` 两个参数都可省略：会话回退、ID 为空 = 全部非在开的 |

**测试**：**647/647**（新增 2：会话兜底 + 机库标记正在驾驶；面板测试补了「选中的 itemID 透传」；另有一条路由读 body 的回归）。

## 0.6.22 — 2026-10-29 · 修：仓库角色建不出来（NAME_UNAVAILABLE）

用户实测：`/crewmine stock on` 报「仓库角色没建好（NAME_UNAVAILABLE）」。

**根因**：服务端的 `VALIDATION_CODE.VALID` 是**数字 `1`**，不是字符串 `"VALID"`；0.6.21 的命名校验按字符串比较，于是把每一个候选名字都判成不可用，四个候选全被跳过，最后回落到 `NAME_UNAVAILABLE`（一个角色都没建，数据库里也确实没有 `*NFCREW` 角色）。

**修法**

1. 命名校验改成认服务端的 `VALIDATION_CODE.VALID`（数字 1），同时兼容字符串 `"VALID"` 的旧构建。
2. 候选名字加后缀时**按后缀长度让位**：以前 37 字名字加 `-2` 会被 `slice(0,37)` 截回同一个名字，四个候选变成同一个。
3. 候选从 4 个加到 6 个。
4. 如果**本账号**下已经有同名角色（上次建到一半、账本丢了），直接**认领**这个角色，不再新建；别人账号的同名角色绝不认领（会认错）。
5. 失败信息带上每个候选的拒绝码（`NAME_UNAVAILABLE(name:-101,…)`），下次一眼能看出原因。

**验证**：用真实 `characterNameRuntime` + 假的角色存储跑通 `CCA总督NFCREW` 创建；645/645（新增 3 条：数字 VALID、长名字候选不截断、本账号同名认领）。

## 0.6.21 — 2026-10-29 · 库存 P4：账目/回滚/备份（界面调整留到最后一轮）

| 项 | 内容 |
| --- | --- |
| 累计账目 | 账本新增 `spent` / `refunded`：订货成功累加、卖出退款累加；`stock` 状态里多一行「累计：订货花掉 X · 卖出退回 Y」，`stockView` 也带这两个字段（面板以后直接用） |
| 回滚更干净 | `stock buy` 造船失败时，除了删已造好的船 + 退款，**现在连账本条目一起撤**——以前会留下"丢失"记录，看起来像玩家爆了一艘船 |
| 逐艘转入 | `stock deposit [ID…]`：不给 ID = 全部非在开的；给了就只转那几艘（面板后接） |
| 备份 | 新增 `stock backup`：把 `state.json` 复制到同目录 `backups/state-<时间>.json`，并提示 `gamestore.sqlite` 要一起备；`stock` 状态末尾常驻一行备份提醒 |
| 帮助 | `stock` 用法行补上 `reconcile` / `backup` |

**测试**：**642/642**（新增 4：累计计数、失败回滚撤账本、按 ID 转入、备份文件落盘）。

## 0.6.20 — 2026-10-29 · 库存 P3：配装台（拼配装 → 报价 → 订购 / 存为蓝图）

| 部分 | 内容 |
| --- | --- |
| 页签 | 新增「配装台」（第三个页签） |
| 配装 | 选船体 → 按船的 高/中/低 槽位数自动生成槽位下拉；每门需要弹药的炮出现弹药下拉（数据来自引擎的 `chargeGroup1..5` + `chargeSize`）；无人机下拉 + 数量 |
| 实时 | CPU / PG 用量与上限、各槽位用量、**80% 卖价合计**（无人机/弹药不计价），超限当场标红并列出问题 |
| 订购 | 校验通过 → 扣 80% 卖价 → 给仓库角色造真船并装满 → 入库（和「按蓝图订货」同一条链路） |
| 存为配装 | 写 `configs/<id>.json`（和手工蓝图同格式，之后可在召唤仓库按键订货） |
| 后端 | `/api/fit/catalog`、`/api/fit/charges`、`/api/fit/quote`、`/api/fit/order`、`/api/fit/save` |
| 目录 | 索引升到 v2：船体多存 `cpuOut`（属性 48）/ `pgOut`（属性 11），配装台拿它当上限（SDE 变了会自动重建） |

**真数据验证**（真 SDE + 真市场库）

- 妄想级（Covetor）：高 2 / 中 2 / 低 3 / 改装 3，**CPU 240 / PG 70**；
- 一套「妄想级 + ORE 露天采矿器」：CPU 50/240、PG 10/70，合计 **24,721,722 ISK**（船体 24,712,474 + 采矿器 9,248，正好等于逐件 80% 价之和）。

**测试**：**638/638**（新增配装台 1 条：报价累加/超槽位/无船体/订购扣款与入库）。

**已知限制**：MVP 不做 rig / 子系统 / 改装件；弹药下拉只对带 `chargeGroup` 的模块出现；「存为配装」会走现有 `checkFit`，个别组合可能被拒（提示原因）。

## 0.6.19 — 2026-10-29 · 库存 P2：面板「召唤仓库」窗口

| 部分 | 内容 |
| --- | --- |
| 侧边导航 | 面板顶部新增「指挥 / 召唤仓库」两个页签，仓库是独立窗口（和 faction-sim 的功能选择一个思路） |
| 库存窗口 | 逐艘列表（ID / 名字 / 状态 / 来源 / 价格）、分页（20/页）、全选、**多选召唤**、单艘「召唤」按钮 |
| 动作 | 订货（蓝图 + 数量，80% 卖价）、转入机库船、取出到 4-4、卖出（只对购入）、对账、库存开关 |
| 方案 | 勾几条船 → 起名 → 创建方案；方案行上「一键召唤」「删除」 |
| 后端 | `/api/stock`（分页视图，含余额）、`/api/stock/hangar`、`/api/stock/{buy,deposit,withdraw,sell,summon,plan,reconcile}`；全部复用 P1 的内部函数，命令与面板同一套逻辑 |

**按 ID 召唤**（新增）：`prepareStockPlan` 支持 `stockIDs`，面板多选的就是那几艘；仍然校验「在库 + 配装签名和蓝图一致」，多配装混选会按签名分组召唤。

**实测**：面板能起、HTML 里有 `#stockPane` / 页签、`/api/stock` 正常返回；637/637。

**已知限制**：前端是功能版（表格 + 按钮，没有虚拟滚动）；几千艘时建议分页调小。配装台（P3）还没做。

## 0.6.18 — 2026-10-29 · 库存 P1.5：对账（账本跟着物品表走）

P1 留下的问题：船员船被击毁、被玩家挪走、服务端崩溃，账本都会和物品表对不上。现在补上对账。

| 规则（以物品为准） | 结果 |
| --- | --- |
| 物品不存在 | 账本标 `lost`（终态；物品再出现会按 owner 复活） |
| `owner` = 仓库角色 | 改回 `stored`；位置不在 4-4 就**停回 4-4** |
| `owner` = 某个船员角色 | 改成 `in_use`，`characterID` 跟物品走 |
| `owner` = 别人（玩家/未知） | 账本删掉这条（船已经不在库存了），**物品不动** |
| `reserved` 过期 | 放回 `stored` |
| `reconcile adopt` | 仓库机库里没上账的船认领为 `existing` |

**触发点**

- `/crewmine stock reconcile [adopt]`：显式对账（`adopt` 认领没上账的船）。
- `/crewmine stock`（status/list）：先对账一遍，有变化才多打一行。
- `/crewmine stock on`：开关打开时顺手对一次。

**实现**：新增 `lib/nfCrewMiningStockReconcile.js`（纯函数，注入 `lookupItem` / `dockShip` / `snapshotOf` / `listWarehouseShips`，不直接依赖 itemStore）；运行时只提供这几个回调。

**测试**：**635/635**（新增 `reconcile` 10：在库保持 / 物品没了标丢失 / 已 lost 不重复计数 / 船员名下转在用 / 在用但已回仓库 / 停回 4-4 / 别人手里移除 / lost 复活 / adopt 认领 / 描述文本；`commands` 1：`stock reconcile` 与 status 的自动对账）。

## 0.6.17 — 2026-10-29 · 库存系统 P1：仓库角色 + 账本 + 买卖/存入/取出/迁移 + 召唤改走库存

库存计划书（`docs/PLAN-STOCK-0.7.0.md`）的 P1 落地。**默认关闭**（`/crewmine stock on` 才切换），老玩法完全不受影响。

| 模块 | 内容 |
| --- | --- |
| `lib/nfCrewMiningStock.js`（新） | 账本 + 四态机：`stored → reserved（60 s）→ in_use → stored|lost`；整批占位（一艘不满足就整批不动）、过期自动放回、一个 itemID 只允许一条账本 |
| `lib/nfCrewMiningWarehouse.js`（新） | 仓库角色 `<玩家名>NFCREW`（截断 37 字符、撞名 `-2/-3`、建在**模组船员账号**下、固定吉他 4-4 = 60003760）；转移/靠站/设当前船/机库船的封装 |
| `lib/nfCrewMiningShip.js` | 新增配装快照 `snapshotFit` / `snapshotFromBlueprint`、签名 `fitSignature` / `blueprintSignature`（船体 + 模块，弹药/无人机不参与匹配） |
| 召唤 | 库存开启时按蓝图签名从库存取船（**不再造船**），先整批占位；取船失败/送上天失败自动回库；成功记「在用」 |
| 解散 | 库存船**不删船**：摘实体 → 停回 4-4 → 转回仓库 → 账本回「在库」；非库存船仍是老逻辑 |
| 命令 | `stock [status\|list]`、`stock on\|off`、`stock init`、`stock buy <配装> [数量]`、`stock deposit`、`stock withdraw <ID…>`、`stock sell <ID…>`、`stock migrate` |
| `loader.js` | 接 `characterName`（角色名校验）与 `wallet`（订货扣款/卖出退款） |

**行为要点**

- 订货按 **80% 卖价 ×（船体 + 模块）**扣款，一次订货一次扣款（幂等 key `nfcrew-stock-buy:…`）；扣款失败不造船，造船失败自动删船+退款。
- `stock deposit`：把玩家在 4-4 机库里**不是正在开**的船全部转入（在开的船转了会把玩家自己晾在站里，所以跳过）。
- `stock migrate`：把**不在役**的老船员船搬进库存；在役的等解散时自动回库（不硬拽在太空飞的船）。
- `stock sell`：只对 `source=bought` 生效，按实付价退款；自有船只能取出。

**已知限制（P1.5）**

- 船员船**被击毁**时账本还停在 `in_use`（没有对账/丢失标记）；对账与 `stock reconcile` 放 P1.5。
- `stock summon <ID…>`（按库存 ID 精确召唤）留给 P2 面板的多选召唤。
- 钱包走**同步** `adjustCharacterBalance`；若服务端开异步权威模式会直接报错（不扣款、不造船）。

**测试**：**624/624**（新增 `stock` 6、`warehouse` 5、`commands` 4：库存召唤取船/回库、库存不足整批不动、订货扣款、余额不足不造船）。

## 0.6.16 — 2026-10-29 · 库存系统 P0：价格服务 + 类型目录索引

库存计划书（`docs/PLAN-STOCK-0.7.0.md`）的 P0 落地，**还没有库存/召唤改动**，只是把地基铺好：

| 模块 | 内容 |
| --- | --- |
| `lib/nfCrewMiningPrices.js`（新） | 价格 = **吉他最低卖价 × 0.8**；没有卖价的物品按 **100 ISK**；5 分钟缓存、`readonly` 打开市场库、读不到就整体降级（只警告一次）。**禁用** `seed_buy_orders`/`seed_stock`（吉他市场补丁灌的脏数据，实测矿枪买单价 6.51 亿） |
| `lib/nfCrewMiningCatalog.js`（新） | 一次性扫 SDE（`types` / `groups` / `typeDogma`）产出 `_local/nf-crew/catalog.json`：船体 / 模块（按引擎的 hiPower/medPower/loPower/rigSlot 效果分槽）/ 弹药 / 无人机。按 `_sde.jsonl` 的 `buildNumber` 判断重建 |
| 命令 | `/crewmine price <typeID\|名字> [数量]`、`/crewmine catalog [build\|ships\|high\|med\|low\|rig\|charge\|drone]` |

**实测（真库 + 真 SDE）**

- 价格：Covetor `30,890,592 × 0.8 = 24,712,474`；ORE 采矿激光 `11,560.62 × 0.8 = 9,248`；查不到 → 100；吉他共 **19,527** 个类型有卖价。
- 索引：**5,565** 个类型（船体 423 / 高槽 1399 / 中槽 909 / 低槽 1017 / 改装 642 / 弹药 1017 / 无人机 154），重建 **906 ms**，缓存命中 **12 ms**；Covetor 槽位 2/2/3、改装 3、无人机舱 50 / 带宽 50，与游戏一致。

**偏差**：索引里**不存价格**（价格 5 分钟一变），查询时由价格服务现查合并。

**测试**：`609/609`（新增 `prices` 5、`catalog` 4、`commands` 2）。

## 0.6.15 — 2026-10-28 · 导弹/鱼雷齐射有实体弹了（纯表现，伤害不变）

用户要求：把 evejs-faction-sim 的导弹攻击效果（`lib/bridge/theatreFire.js`）搬到 nf-crew。

| 项 | 落地 |
| --- | --- |
| 现象 | 齐射只发 `MissileDeployment` 特效、没有弹体；客户端没有可挂的导弹球，发射动作/弹道/命中爆炸/声音都看不到 |
| 做法 | 每个导弹武器组补发**一枚真实导弹球**：`scene.launchMissile` + 零伤害快照（`family: "festivalLauncher"`、`rawShotDamage` 全 0、`damageMultiplier` 0），伤害仍由齐射即时结算 |
| 为什么零伤害就够 | 引擎给"纯表现弹"留了 `festivalLauncher` 分支：命中连 `applyWeaponDamageToTarget` 都不进，也不发 0 伤害的伤害提示、不给无人机记仇恨；全 0 伤害是第二道保险 |
| 飞行时间 | `flightTimeMs` 至少覆盖 `表面距离/速度 × 1.25 + 2 s`，否则 `expiresAtMs` 先到、球在半路消失，看不到命中爆炸 |
| 发射器 | 一个球带全组 `launchModules`（每门发射器的 itemID）：客户端仍让每门发射器开火，服务端只花一个实体 |
| 顺序 | **先发球、后结算伤害**：这一轮如果把目标打爆了，`launchMissile` 会因目标已死拒发，致命那一发反而没有弹体 |
| 特效 | deployment FX 改走引擎自己的 `buildMissileDeploymentSpecialFxOptions`，并**每门发射器一条**（原来每组一条、只填第一门） |
| 上限 | 每场景同时最多 24 枚球（`EVEJS_CM_MISSILE_CAP`，0 = 不限）；超了只是不建球，伤害照常。为什么必须自己加：perf-fix 的 missilecap 只拦「无 session + npcEntityType」的 NPC 对 NPC 导弹，船员船挂的是无头 session，不在它保护范围内 |
| 开关 | `behavior.missileEntity`（默认开，面板 `/api/mode {field:"missileEntity", value:false}` 或写蓝图）；全局关 `EVEJS_CM_MISSILE_FX=0` |
| 不变 | 伤害、电容、弹药、循环、日志里的「导弹 N 发」全部照旧（日志多一句「已发射」） |

**已知表现取舍**（方案 A 的代价）：伤害是即时的，所以如果目标在导弹飞到之前就被这一轮打爆，球会被服务端按「目标丢失」摘掉（不播命中爆炸）。要「弹到伤到」需要把伤害延到 `impactAtMs` 结算（方案 B），那是另一个开关，本次没做。

**改动**：`lib/nfCrewMiningMissileFx.js`（新增：零伤害快照、发球、每场景上限、统计）、
`lib/nfCrewMiningSalvo.js`（导弹分支发球、`launches`、`fxGroups.modules`、`MISSILE_FX` 不算失败）、
`lib/nfCrewMiningRuntime.js`（传 `missileFx` 开关、`broadcastVolleyFx` 每门一条 + 引擎选项、日志）、
`loader.js`（注入 `sendOptions`）、`lib/nfCrewMiningConfig.js`（`missileEntity` 默认值 + 布尔键）、
`lib/nfCrewMiningBehavior.js`（可写键）、`lib/nfCrewMiningStatus.js`（状态透传）、
`使用说明.md` / `COMMANDS.md`（behavior 表）。

**测试**：**595/595**（+11：导弹球零伤害/原快照不改/飞行时间/全组 launchModules/模拟时间/上限/开关/幽灵名额回收/先发后结算/致命一轮仍有弹体）。

## 0.6.14 — 2026-10-28 · 建筑目标：84742 这类投射装备能对建筑生效，船员也能打你标记的建筑

用户报告：Monitor（45534）没有武器，用 Tisiphone 改良型目标标记（84742）指向赤潮的 Fortizar（35833，item 1030000000006）时，
客户端弹「无法激活该装备，因为目标已经不存在」；本意是靠标记把目标指给 nf-crew 打。

| 项 | 落地 |
| --- | --- |
| 根因 | 服务端 `hostileModuleRuntime` 只把 `kind === "ship"` 当合法目标，建筑（`kind === "structure"`）直接被判 `TARGET_NOT_FOUND`，客户端把它翻译成「目标已经不存在」 |
| 引擎修复 | **只放行目标标记**（targetPainter）对建筑激活：Fortizar 没有声明 `targetPainterResistance`，+35% 信号半径是全额生效；网子 / 中和 / 吸血 / 感应抑阻 / 武器扰断 / 制导扰断 / 扰断 / ECM 对建筑**保持原样拒绝**，不做额外改动 |
| 激活与循环 | 激活闸门和每拍循环闸门共用同一个判定（`isHostileTargetEntityAllowed`），不会出现「激活成功、下一拍自己停」 |
| 船员选目标 | `nfCrewMiningCombat.pickTargetFor`：自由开火候选集**仍然只有船**；**指挥官显式指向**的建筑才可能作为命令（焦点，或附近没有别的目标时） |
| 船员判定 | `nfCrewMiningRuntime.isCommandedStructureTarget`：只认「指挥官正用模块指着」的建筑；自己军团 / 联盟的建筑一律拒绝（涂自家 Fortizar 不会让 70 门炮转过来） |
| 听令模式 | `/crewmine freefire off` 下走同一条判定，友方建筑同样不会被打 |
| 生效方式 | 引擎补丁 + 本 loader 模组都**要重启服务器**才生效 |

**改动**：`server/src/space/modules/hostileModuleRuntime.js`（新增 `STRUCTURE_HOSTILE_TARGET_FAMILIES` / `isHostileTargetEntityAllowed`，替换激活与循环两处 `kind === "ship"` 闸门）、
`lib/nfCrewMiningCombat.js`（`candidateFor` 允许显式命令指向建筑）、
`lib/nfCrewMiningRuntime.js`（`isCommandedStructureTarget`、`focusActive` 接受建筑命令、听令分支同判定）。

**测试**：**584/584**（+5：建筑不进自由开火候选、焦点压过更近的 NPC、无焦点时更近的船优先、附近无目标时按命令打建筑、不是指挥官目标的建筑不理会）；
引擎侧新增 `server/tests/hostileStructureTargets.test.js` 6 条（标记对建筑放行、网子 / 中和 / 扰断仍拒绝、对船不变、循环能继续、闸门矩阵）。

## 0.6.13 — 2026-10-28 · 火力集中模式（面板开关）：解除每拍 3 艘的齐射轮转

用户要求：额外增加"火力集中模式"，UI 界面控制，打开时解除 3 艘/秒的限制。

| 项 | 落地 |
| --- | --- |
| 开关 | 面板「作战」栏新增按钮 **火力集中：关/开**；等价命令 `/crewmine focus on\|off`（不带参数只报状态） |
| 打开后 | `salvoTurnFor()` **直接放行**：本拍所有"冷却好了、电容够、在交战"的船一起结算，不再按 `combatSalvoBudgetPerTick`（默认 3）轮转 |
| 没变的部分 | 每艘船自己的武器循环（`max(1000, cycleMs)`）、电容预检、跃迁/挖矿/追击/堡垒的跳过条件、目标选择——全部照旧；只动"同一拍放行几艘" |
| 安全阀 | `behavior.focusFireMaxTickMs`（默认 **6000 ms**，1000–30000）：一拍内累计结算超过它就**顺延余下的船到下一拍**，防止 24 艘 × ~0.6 s ≈ 14 s 把事件循环钉死。日志 `[combat] 火力集中：本拍结算已用 …ms（安全阀 …ms），余下船员的齐射顺延到下一拍`（30 s 去重） |
| 状态/持久化 | `status.focusFire`（面板按钮只认它，刷新/换客户端能对上）；和 `freeFire` 一样是**运行时状态**，重启回关闭 |
| 风险提示 | 开关时会回报"在役 N 艘 / 最坏这一拍约 X s"；`[perf] watch tick` 里能直接看到代价 |

**改动**：`nfCrewMiningRuntime.js`（`focusFire` 状态、`salvoTurnFor` 分流 + 安全阀、`focus` 命令、USAGE、`flags()`、两个测试钩子）、
`nfCrewMiningConfig.js`（`focusFireMaxTickMs` 默认值 + 区间）、`nfCrewMiningStatus.js`（透传 `focusFire`）、
`web/index.html` + `web/app.js`（按钮、`toggleFocusFire` / `syncFocusFire`、render 时同步）。

**测试**：**579/579**（+7）：默认仍 3 艘/拍、`focus on` 8 艘全放行、`focus off` 恢复轮转、安全阀按毫秒顺延并下一秒重置、
安全阀调大能装更多船、`focus` 只报状态、`focusFireMaxTickMs` 归一。

## 0.6.12 — 2026-10-28 · 阵型加「跟随」：所有船和你保持同一个间距

用户要求：在阵型模式里加「跟随模式」，即与玩家保持设置的间距。

| 项 | 落地 |
| --- | --- |
| 新阵型 `follow` | 面板「阵型」下拉第二项 **跟随（同一距离）**；命令 `/crewmine formation follow` |
| 语义 | **所有人同一个表面距**（选多少就是多少，`gap`），**不**按序号递增 —— 这是它和「同心环（距离递增）」的唯一区别 |
| 走哪条路 | 和阶梯一样走引擎 `FOLLOW`（`desiredRange = gap + r1 + r2`，**无 500 m 下限**），所以 100 m 也真的生效；不经过 250 ms 环形控制器 |
| 「每艘递增」 | 跟随模式**不参与**（面板灰掉、`/crewmine spacing` 只对阶梯生效）；选了也不会被偷偷套用 |
| 缺间距 | 和阶梯一致：**不下发任何指令** + 一次提示（60 s 去重）+ `status.followReason = "跟随缺少间距 → 不动"` |
| 持久化 | 走已有的 `state.json → settings.followPlan`，重启后保持；召唤时若已是跟随模式且间距已设，新船落地就按同一间距跟随 |

**改动**：`nfCrewMiningFollowState.js`（`MODES` 加 `follow`、新增 `followStandoff` / `modeReady`）、
`nfCrewMiningBehavior.js`（`FORMATIONS`）、`nfCrewMiningFollow.js`（`createRearmer` 把 `follow`/`ladder` 并到同一分支，只改站位算法）、
`nfCrewMiningRuntime.js`（召唤自动跟随、命令回执/帮助、面板 API 注释）、`nfCrewMiningConfig.js`（覆盖解析接受 `follow`）、
`nfCrewMiningStatus.js`（`followReason`）、`web/index.html` + `web/app.js`（下拉项、灰掉步长、日志）。

**测试**：**572/572**（+7）：跟随站位 = 所有人同值（3 艘 300/300/300）、跟随缺间距什么都不发、跟随共用 5 s 节流、
`modeReady`/`followStandoff` 单元、面板可选 `follow`、命令回执、缺间距文案。

## 0.6.11 — 2026-10-27 · 驾驶员头像：跳入/原地出现之后再补一次船信息

用户要求把"更稳的刷新办法"直接加上（不退回跃迁）。

- 非跃迁入场（`cyno` / `instant`）在船落地 **1.5 秒后再补发一次这艘船的 slim 信息**（`republishShip`），
  客户端据此把驾驶员头像解析出来；跃迁那条路本来就有"真跃迁顺带解析"，不补（少一次广播）。
- 补发失败只在日志里留一行（`[arrival] … 补发船信息失败`），不影响召唤结果。
- 测试：**566/566**，新增 1 条（instant 入场：落地后 slim 信息重播第二次）。

## 0.6.10 — 2026-10-27 · 灯会灭 + 解散改成诱导跳走

用户实测反馈：0.6.9 的诱导力场**亮着不走**；另外要求离场也做成"诱导跳走"。

| 口径 | 落地 |
| --- | --- |
| **灯必须自己灭** | 0.6.9 信了"场景会按 `expiresAtMs` 收掉"，实际 `cynoField` 不是库存实体，**不进场景的过期索引**，所以一直挂着。现在模组自己定时摘：点亮后 `cynoDurationMs`（默认 60 秒）+ 250 ms 摘掉，并广播给客户端 |
| 同星系不叠灯 | 再召唤一次会先把上一个还亮着的灯收掉，不会两个力场叠在一起 |
| 没人跳进来不留灯 | 建船全失败（一个人都没落位）时，当场把灯收掉 |
| **解散=诱导跳走**（默认） | 新字段 `behavior.departure`，默认 `"jump"`：播一次 `effects.JumpDriveOut`（带 `graphicInfo` 目标星系，客户端靠它定方向），**不发动跃迁**，6 秒后摘实体（特效 5 秒；球被摘掉会同时停掉特效和音效，所以必须等它演完） |
| 目标星系 | 取当前星系最近的一扇星门的 `destinationSolarSystemID`，绝不指向本星系（指自己等于没方向）；没有星门（虫洞）兜底 Jita/Perimeter |
| 想回老的跃迁飞离 | `departure: "warp"`，就是 0.6.9 之前的真跃迁离场 |

**实现**：`lib/nfCrewMiningShip.js` 加 `jumpOutFx()` / `pickJumpDestination()` / `JUMP_OUT_HOLD_MS`；`lib/nfCrewMiningRuntime.js` 用 `litCynoFields` 记住亮着的灯并定时摘，`disbandCrew` 分出 jump/warp 两条离场路；`behavior.departure` 也进了面板/API 白名单（`POST /api/mode {"field":"departure","value":"warp"}`）。

**关于驾驶员头像**：0.6.9/0.6.10 靠落地瞬间的一次重播；0.6.11 起非跃迁入场会再补一次（见上一条），不需要退回跃迁。

**测试**：**565/565**。新增 7 条：力场的灯到点自己收 / 再召唤先收旧灯 / 解散默认跳走（特效 + 目标星系 + 不跃迁 + 延迟摘实体）/ `departure=warp` 仍走真跃迁 / `jumpOutFx` 单元 2 条 / `departure` 配置归一与白名单。

## 0.6.9 — 2026-10-27 · 诱导入场：召唤改成"点诱导力场 → 跳进来"（跟 evejs-faction-sim 一样）

用户口径：nf-crew 成员的入场方式改成诱导入场，和 `evejs-faction-sim` 的会战舰队一致。

| 口径 | 落地 |
| --- | --- |
| **默认就是诱导入场** | 新字段 `behavior.arrival`，默认 `"cyno"`：`spawn` 先在你旁边点亮一个诱导力场，`cynoLeadMs`（默认 4 秒）之后船员跳进来 |
| **跳入是"画面"，不是真跳跃** | 引擎真正的诱导力场（`space/runtime/cynosuralField.js`）要 session + 装好的 cyno 发生器，还会挂 fleet beacon（玩家能跳进来）。无 session 的船员船两样都没有，所以照 faction-sim 的做法手搓同一个 `cynoField` 实体（type 21094、`nfCrewCyno: true`、**不挂 beacon**，谁都跳不进去）；**灯的生命周期见 0.6.10：场景不收这种实体，得模组自己定时摘** |
| **船到点才出现** | 诱导期间船在太空里但不在场景里（和跃迁进场"正在跃迁"同性质）；到点生成实体、补末日属性、重播 slim，再播 `effects.JumpDriveIn`（faction-sim 的旗舰跳入用的同一个 guid，5 秒一次性） |
| **落点散开** | 跳进来的船落在力场周围一圈上（`cynoRadiusMeters` 默认 2000 m，按人序号分角度），不再全叠在一个点；`0` = 老落点 |
| **点不着灯也不挡召唤** | 没有实体 ID 分配器 / 老场景 / 测试桩：命令里记一行原因，船员直接跳入（特效照播） |
| 另两种入场保留 | `arrival: "warp"` 老行为（2 AU 外真跃迁进场，客户端画跃迁）；`arrival: "instant"` 直接出现。老写法 `warpIn: false` 仍然等于 `instant`，但 `warpIn: true` **不再**强制跃迁 |
| 只改召唤 | 召回 / 重启重建 / 掉队拉回 / 过门复活仍然走真跃迁（那几处是"已经在场上的船飞回来"，点灯反而怪） |

**实现**（没动引擎文件）：

- `lib/nfCrewMiningShip.js`：`spawnCynoField()`（造力场实体）、`jumpInFx()`（播跳入）、`buildCynoArrivalState()`（落点环）；
- `lib/nfCrewMiningRuntime.js`：`spawn` 分出 cyno 分支（先点灯 → `scheduleAfter(leadMs)` → 生成实体 + 特效 + 入队 + 编队 + 跟随），跃迁/瞬时那条路一个字节没改；`finish()` 收口"实体出现之后"的所有步骤；
- `lib/nfCrewMiningConfig.js`：`arrival` + `cynoLeadMs` / `cynoDurationMs` / `cynoRadiusMeters` / `cynoTypeID`（带夹取）；
- `loader.js`：`deps.allocateEntityID` 走引擎自己的 `allocateRuntimeEntityID`（和场景共用计数器，itemID 不会撞）。

**进游戏要确认的两点**（本版只有单元测试，没进客户端）：跳入之后 HUD/舰队窗口里驾驶员头像是否立刻出现（以前靠真跃迁顺便解析，现在靠 `republishShip`）；小船播 `JumpDriveIn` 的观感。不对就把该蓝图的 `behavior.arrival` 改回 `"warp"`。

**测试**：**558/558**。新增 `test/ship.test.js` 4 条（落点环 / 力场实体 / 退化 / 特效）、`test/commands.test.js` 4 条（先点灯再跳入 / 点不着灯也照跳 / 诱导期间被解散不再生成 / 诱导期间被召回只补特效）、`test/config.test.js` 1 条（arrival 归一与夹取）、`test/behavior-writer.test.js` 补 `arrival` 白名单；`commands` / `spawn` 两个测试的蓝图钉住 `arrival: "warp"`，继续测老那条路。

## 0.6.8 — 2026-10-25 · 队形互斥：没有默认行动 + 停船独立 + 阵型只有两档

按用户口径（原话见 `docs/PLAN-FORMATION-0.6.7.md` §0）重做跟随/阵型这一层：

| 口径 | 落地 |
| --- | --- |
| **没有默认行动**，召唤落地静止等命令 | 新增 `followMode`，默认 `idle`：`rearm` 一条指令都不发；`spawn` 也不再自动跟随 |
| **以当前命令为准** | 阵型/间距/步长只有一个权威来源（命令或面板），**蓝图里的 `followFormation`/`followDistance`/`crewSpacingMeters` 不再驱动行为** |
| **停船是独立命令与 UI，不属于阵型** | `FORMATIONS` 去掉 `"stop"`；新增 `/crewmine halt [名字]` + 面板独立「停船」按钮 |
| 间距**维持自选**（不自动兜底） | 环形缺间距 → 不下发 + 说明原因（`status.followReason`），不静默降级成别的行为 |
| `crewSpacingMeters` 只对阶梯生效 | 环形只用 `followDistance`；面板选环形时把步长输入框灰掉 |
| 阶梯距离**维持自选** | 阶梯走引擎 `FOLLOW`（`desiredRange = followRange + r1 + r2`，**没有 500 m 下限**），所以 <500 也真的生效；旧"分层环绕"（走 `ORBIT`，会被抬到 500）随 `idle` 一起移除 |
| 跃迁独立 | `fleetWarp` 完全没动；`idle` 期间玩家起跳，船员照样跟跳 |

**新增命令**：`/crewmine follow <米>`、`/crewmine spacing <米>`、`/crewmine halt [名字]`；
`/crewmine formation` 只接受 `ladder | ring`（传 `stop` 会提示改用 `halt`）。

**持久化**：阵型/间距/步长写进租户 `state.json` 的 `settings.followPlan`，重启后保持。

**面板重排**（用户反馈"一点也不清晰"）：编队条按语义分组 —— 左「编队」：阵型／间距／步长（带文字标签，顺序改成"先阵型再参数"），右「动作」：停船／跟队跃迁，状态单独一行；
阵型下拉新增 **静止（不动）** 档，与后端 `idle` 一一对应；删掉冗余的「跟随」「清空间距」按钮（下拉已即时生效）。

**测试**：本版 **548/548**；新增 `test/follow-state.test.js`(6)、`test/follow-idle.test.js`(5)，
重写 `formation-stop`（改成 halt/idle 语义）与 `formation` / `follow-range` / `point-formation` /
`orbit-formation` / `commands` 里的旧断言。
实现说明见 `docs/FOLLOW-IMPLEMENTATION.md`（改造前的现状）与 `docs/PLAN-FORMATION-0.6.7.md`（方案）。

## 0.6.7 — 2026-10-25 · 性能：watch tick 4 s → ~1.4 s；锁定改成秒锁

> 全部真机验证。排查过程与数据在 `docs/PLAN-0.6.7.md` **第十六节**。

### 性能（8 船编队实测）

| 指标 | 改前 | 改后 |
| --- | --- | --- |
| 单拍最大 | 4025 ms（首次配置）/ 3850 ms（战斗） | 2242–3189 ms（仅堡垒激活或齐射扎堆） |
| 典型拍 | 1900–2900 ms | **平均 ~1435 ms**（最小 815） |
| `[tick]` 间隔 | 被拖到 30 s（漏拍） | 15.0 / 15.0 / 15.7 / 15.1 s |

修掉五处"每船每拍重复做同一件事"的浪费：

1. **唤醒扫描**：`wakeNpcsNearCrew` 对每条船各扫一次全场景（节流只挡"唤醒"不挡扫描）
   → 每拍取一份候选集共用；
2. **选目标扫描**：`scanCandidates` 同样每船一次全场景扫描 → 每拍一份**新鲜**快照共用
   （不能用 500 ms 缓存：目标被击毁必须**下一拍**就换，`P4` 用例抓到过）；
3. **防御**：一拍把 8 条船的首次配置全做完 → 改成 **400 ms/拍 + 游标轮转 + 至少 1 条**；
4. **防御多入口**：`engageMember`（无节流）与 `syncCombat`（2 s）都直接调 `runDefenseFor`，
   绕过了预算 → 收敛成唯一闸门 `maybeRunDefenseFor`，每拍开头重置预算；
5. **换目标**：`disengageMember` 会 `stopCombat` + `stopDefense`，把武器与防御模块全关再开回来
   （单拍最高 3983 ms）→ 换目标只清旧目标记账，真正停火才走完整流程。

### 秒锁（新功能）

船员的锁定槽只有 1 个，而引擎锁定时长 = `(40e6 / scanResolution) / ln(sig + √(sig²+1))²`，
打旗舰目标实测 **9–13 秒**，等待期间每拍重试。

现在用引擎**自己的**两个方法立即完成锁定，不改引擎文件、不 monkey-patch：
`requestModuleTargetLock` → `finalizeTargetLock`；槽位被占时先 `removeLockedTarget` 再完成。
战斗 / EWAR / 遥修三处都用它。**实测 `锁定中` 从 608 次/10 分钟降到 0**。
关掉：蓝图 `behavior` 里写 `"instantLock": false`。

### 归因工具（保留）

`[perf] watch tick … 分段 combat=…(combat.engage=… combat.engage.volley.…)`；名字带 `.` 的子项
不计入 `accounted`（否则 `other` 会算成负数并消失）；单船防御超过 1 s 单独一行
`[perf] defense 单船 <名字> … applied=N/N`。
**齐射已挖到底**：成本全在引擎 `applyWeaponDamageToTarget`（507–641 ms），
合并/跨船批处理省不了或会把 KM 凶手记错 → 不再优化（PLAN §16.5.1）。

- 新增 `test/defense-budget.test.js`(4)、`test/defense-gate.test.js`(3)、`test/wake-scan.test.js`(2)、
  `test/instant-lock.test.js`(4)，`test/combat.test.js` +2、`test/perf-guards.test.js` +2。
- 测试 **515 → 532 全绿**。

### 待做（未包含在本版）

队形互斥改造（计划书：`docs/PLAN-FORMATION-0.6.7.md`，等你拍板 5 个确认点）、末日目标规则与炮台
不一致、面板顶部按钮不显示 `pending`、`MODULE_REACTIVATING` 日志降噪。

## 0.6.6 — 2026-10-24 · 修：挖矿的“接近”被跟随抢指令（7 小时 0 次成功采矿）

实测 `crew.log`（07:41–07:45）：3 艘船每 4 秒收到一次「保持 12 km」去够 29 km 外的矿，
1 秒后又被 `[follow]` 拉回玩家身边，30 次后「放弃接近」。整段日志统计：

| 事件 | 次数 |
| --- | --- |
| `保持 12 km 指令`（接近矿） | 721 |
| `[follow]`（拉回玩家） | 630 |
| `接近中（第 N 次）` | 216 |
| `矿采空…自动重新选矿` | 216 |
| **`采矿中`（成功开始采矿）** | **0** |

根因：`isMiningAtRock()` 先判 `activeModuleEffects`。船在“飞向矿”的阶段一个模块都没起，
于是返回 `false` → `rearmFollow` 认为它没在挖矿 → 每 5 秒把它拉回玩家，和挖矿的接近指令
互相覆盖，船原地打转。

- 现在**先判 `activeRock + miningWanted`**（只要这条船在挖矿流程里，哪怕还在飞、模块还没起），
  再回落到模块判定。模块全停但挖矿意图还在的船也不再被跟随抢走。
- 影响面：阶梯跟随与环形控制器都会跳过“接近矿”的船；矿真挖空/停止挖矿/跨星系搬迁时
  `activeRock` 会被清掉，船照常恢复跟随。
- 新增 `test/mining-guard.test.js` 2 条（没模块也算挖矿中；不在名单里的船照常跟随）。
- 测试 **457/457 通过**。

## 0.6.5 — 2026-10-24 · 发布版（召唤复用定稿 + 多账号面板核对）

本版**无代码改动**，把 0.6.4 的召唤修正定为对外发布版，并记录一次多账号核对结果。

**召唤（本次发布的核心）**：`spawn X N` 的取人规则定稿为

1. `summoned === true` 的角色**永远不参与**（在役 = 占用）——正在跟着你的船员不会被拆船、
   不会被 2 AU 重新跃迁；
2. 先挑同蓝图的空闲角色；
3. 不够就**跨蓝图借调**空闲角色（角色保留，`blueprintID` 重贴为目标蓝图，
   清 `holdCapacity` 缓存与 `mining` 标记）；
4. 借完还不够才新建角色。

实测：场上已有 8 人在跟随，再 `spawn X 8`，会在役那 8 个连 `shipID` 都不动，另外从
空闲池里挑 8 个。回复里会多一行「借调 N 名其它蓝图的空闲角色（重贴为 X，角色保留）」。

**多账号面板核对**（用全新临时工作区实测）：新账号首次 `/crewmine ui` →
`created:true`、生成 32 位十六进制 token、`tokenFor()` 再取稳定、`tenants.json` 落盘、
`t/<账号>/configs/` 自动播种 4 份蓝图模板。面板只监听 `127.0.0.1`，所以**只对
“自己跑服务端”的人生效**；连别人服务器玩的人用游戏内命令即可（功能完整，不依赖面板）。

**分发说明**：只打包 `mods/nf-crew/`；**不要**带 `_local/gameStore/nf-crew/`
（`state.json` / `tenants.json` / `configs/` / `logs/` 是运行数据，带上会让对方继承你的
船员池与 token）。

已知小毛病（不影响使用，暂不修）：`/crewmine ui` 在**打不开浏览器**时，提示会变成
`base is not defined`，手动访问日志里的 `http://127.0.0.1:8741/` 即可。

测试 **455/455 通过**。

## 0.6.4 — 2026-10-24 · 召唤复用语义修正（在役 = 占用，可跨蓝图借调）

问题：`spawn X 8` 时把**正在跟着你的那 8 个**当成"可复用空位"，删掉他们的船和实体、
2 AU 重新跃迁进场（`crew.log` 里那句"复用 8 名在场船员（角色保留，旧船已回收）"）。
根因是 0.5.0 按"别一直建角色"的要求把 `summoned !== true` 的过滤整个删掉了。

现在：

- `selectForSpawn`：**`summoned === true` 的角色永远不参与**（在役 = 占用）；
  优先同蓝图的空闲角色，不够就**跨蓝图借调**（返回 `borrowed`），仍然不够才新建。
- `spawnCrew`：删掉"回收在场成员"的整段逻辑（拆船/退队/标空闲）；借来的角色
  重贴 `blueprintID` 为目标蓝图、清掉 `holdCapacity` 缓存与 `mining` 标记；
  回复里多一行「借调 N 名其它蓝图的空闲角色（重贴为 X，角色保留）」。
- 效果：场上已有 8 个时再 `spawn X 8`，会从池里另外的空闲角色里挑 8 个，
  在役的 8 个连 `shipID` 都不会被碰。只有池子真的空了才新建角色。
- 测试 **455/455 通过**（`pool.test.js` 覆盖"在役不参与 / 同蓝图优先 / 跨蓝图借 /
  借完才建"；`commands.test.js` 新增"借调不新建 + 重贴蓝图 + 在役不动"）。

## 0.6.3 — 2026-10-24 · 补上停滞抓钩（group 1672）

- **group 1672 = Stasis Grappler（停滞抓钩）** 之前不在 `FAMILIES` 表里，`familyOf()` 返回空，
  `findActiveModules()` 直接跳过——所以船上装了也不会被使用。现在并入 `FAMILY_WEB`
  （和 group 65 Stasis Web 同一个 family），走完全相同的 target 分支：有交战目标 →
  射程内 → 锁定 → `activateGenericModule`。
- 顺带核对同类组（SDE `groups.jsonl`，category 7）：52 Warp Scrambler ✓、65 Stasis Web ✓、
  68 Nosferatu ✓、71 Neutralizer ✓、72 Smart Bomb ✓、201 ECM ✓、208 Sensor Dampener ✓、
  291 Weapon Disruptor ✓、379 Target Painter ✓、842 Burst Projectors ✓、1770 Command Burst ✓。
  **仍未接**：80 Burst Jammer（范围 ECM，会连带干扰友军，不建议自动开）、
  899 Warp Disrupt Field Generator（可部署物，不是船上模块）、
  321/341（NPC 专用）、514/753（被动装备）。
- 测试 **452/452 通过**（新增：1672 必须映射到与 65 相同的 family）。
- **清单版本号补齐**：`evejs-launcher.mod.json` 一直停在 `0.4.0`（0.5.x / 0.6.x 全漏），
  已改为 `0.6.3`，并加 `test/manifest.test.js` 断言「清单 version === CHANGELOG 最新版本」，
  以后改 CHANGELOG 忘了同步会直接红。

## 0.6.2 — 2026-10-24 · 降膨胀（P0 + P1）

来自 `crew.log` 的实测：181 条 `[perf]`、73 条 >1500 ms、最大 **19.4 秒**，
同一时刻 `time-dilation.log` 把 30004764 压到 **0.55**。四处改动：

- **P0-a 齐射前先查电容**：纪录上一轮的真实开销（`salvoCapCost`），下一轮开打前
  比较 `getEntityCapacitorAmount()`；不够就直接返回"电容不足"（10 秒一条日志），
  不再"算完 8 门伤害 + 特效 + 广播再报错"。实测那场战斗 **388/560 次齐射**都是这种白算。
- **P0-b watch tick 过载保护**：上一拍 > 800 ms 时，本拍只跑
  scene/combat/rearm/warp，把 `active / remote / stranded / defense` 顺延；
  最多连续顺延 2 拍，保证它们仍会执行。日志里会出现 `steps.deferred=1`。
- **P1-a 齐射轮转**：新配置 `behavior.combatSalvoBudgetPerTick`（默认 3）。
  8 艘船时每拍只结算 3 艘、光标循环，成本从 1.9 s 摊到 ~0.7 s；
  设成 ≥ 在役人数即关闭轮转（人人每拍都打，DPS 回到原来的 1/1）。
- **P1-b 场景快照按拍缓存**：战斗选目标的 `getDynamicEntities()` 500 ms 内复用
  （8 艘船一拍只扫一次）。**只给选目标用**——解散反查、立体炸弹的友军安全判定
  仍然直接取实时列表，避免拿到过期数据。
- 测试 **451/451 通过**（新增 `test/combat-budget.test.js` 2 条：默认预算 3/8、
  预算≥人数时不轮转）。

## 0.6.1 — 2026-10-24 · 文档归档清理

- **`docs/` 只留现行两份**：`README.md`（索引 + 模块地图 + 归档规则）、`multitenant.md`
  （多账号部署）。其余 11 份历史材料移入 `docs/archive/`：`PLAN.md`、`sync-warp.md`
  （旧的伪 session 方案）、`spike-multitenant.md`、`多租户改造PR计划.md`、
  `优化10-24-03.md`、`修复计划书-燃料弹药回血.md`、`战斗目标系统修复计划书.md`、
  `矿船优化计划书.md`、`遥修实现计划书.md`、`全量遍历报告.md`、`待解决问题-2026-10-24.md`。
- **根目录 `PLAN.md` 变成 3 行指路牌**（真身移到 `docs/archive/PLAN.md`），
  这样代码注释里几十处 `PLAN §18.5` 之类的引用仍有落点。
- **`COMMANDS.md` 补上缺失的指令**：`syncwarp` / `formation` / `ui` / `status` /
  `aggrodebug` / `rebuild`；配置表删掉已废弃的 `compressThrottleMs`、`deliverWithinMeters`，
  修正 `followRangeMeters` 默认值（12000 → 1000），补上
  `followDistance` / `crewSpacingMeters` / `followFormation` / `syncWarp`。
- 修正文档互链：`docs/遥修实现计划书.md`（3 处代码注释）、CHANGELOG 里的
  `docs/优化10-24-03.md`、使用说明里的 `PLAN.md` 链接。
- **`_local/mod-backup/` 的备份按你的要求不动**（101 个目录原样保留）。
- 449/449 测试仍通过（纯文档改动）。

## 0.6.0 — 2026-10-24 · P2 收尾

P0（删死代码）→ P1（去重）→ P2（拆模块）完成。**行为没有变化**，449/449 通过。

- runtime 从 **8566 → 8150 行**（−416），新增 4 个模块：
  `geometry`(69) / `behavior`(156) / `status`(152) / `formation`(+138)，
  `follow` 从 126 → 316（接手了跟随重下令器和它的节流状态）。
- 现在「一个概念一个文件」：
  - 距离/坐标 → `geometry`
  - behavior 配置读写 → `behavior`（唯一写入口）
  - 面板状态快照 → `status`
  - 跟随（FOLLOW / 阶梯 / 环形）/ 重下令 → `follow` + `formation`
  - 跟队跃迁 → `fleetWarp`
  - 面板（html/css/js 三件套）→ `web/`
- **故意没搬**：`miningWatchTick` 仍留在 runtime。它外面每个阶段都包着
  `try/catch`，整段搬丢不会报错、只会静默失效；现在有了
  `test/watch-stages.test.js` 兜底（九个阶段必须都进过 `timeStage`），
  下次要搬是安全的，但今天不再动——收尾阶段不引入不可验证的改动。
- 最终体检：`node --check` 全部 lib 通过；449/449 测试通过；面板
  `/`、`/panel.css`、`/app.js` 三个文件都能取到。

## 0.5.7 — 2026-10-24 · P2 第 4 步：抽出跟随重下令器 + watch 阶段看护

- `nfCrewMiningFollow.js` 新增 `createRearmer(ctx)`：`rearmFollow` 整体搬过去，
  **连同它自己的节流状态**（`lastAt` / `lastRange` 两个 Map）。阶梯（表面间距 + 船员
  间距）和分层环绕（orbit → follow 回退链）都在模块里；对外是
  `rearm / forget(characterID) / clear()`——`stopChase` 和「返回环绕」用后两个清节流。
  `formationSlotIndex` / `formationRangeFor` 也搬过去并导出（recall 命令复用）。
- runtime 删掉 `rearmFollow`（139 行）、`formationSlotIndex`、`formationRangeFor`、
  `lastFollowRearm`、`lastIssuedFollowRange`；只留一处注入 + 一行转发。
- **新增 `test/watch-stages.test.js`**：用假场景 + 1 名船员跑一整拍 `__watchTick()`，
  断言 `scene / combat / rearm / special / active / remote / stranded / warp / defense`
  九个阶段都真的进过 `timeStage`。这条测试是后续搬 watch 的安全网——那些阶段外面都包着
  `try/catch`，整段搬丢不会报错，只会「船员突然不干这件事」。
- runtime 行数 8290 → **8150**。
- 测试 **449/449 通过**。

## 0.5.6 — 2026-10-24 · P2 第 3 步：环形执行器连状态一起搬走

- `nfCrewMiningFormation.js` 新增 `createRingController(ctx)`：250 ms 一拍、
  选人（跳过跃迁中/挖矿/追击/堡垒）、规划、下发 `gotoPoint` + `setSpeedFraction`，
  以及**它自己的下发状态**（`characterID → {fraction, at, point}`）全部在模块内部。
- runtime 删掉 `ringFormationTick` 的实现、`applyRingSlot`、`ringState`、`ringWarnAt`
  和三个常量（RING_TICK_MS / DEADBAND），只留 20 行注入 + 一个转发函数 + 定时器。
- runtime 行数 8385 → **8290**；formation 模块 172 → 310（状态跟着逻辑走）。
- 测试 **448/448 通过**（新增控制器用例：忙碌的船不接管、没移动不重复下发、
  `reset()` 后重发、阶梯模式不接管）。

## 0.5.5 — 2026-10-24 · P2 第 2 步：抽出状态快照

- 新增 `lib/nfCrewMiningStatus.js`（152 行）：`buildStatusPayload` 的字段组装搬过去，
  依赖全部通过 `createStatusBuilder(ctx)` 注入（场景、池子、货舱、特殊装备、警告、
  跟队跃迁/阵型开关、开火状态、黑名单/仇恨计数…）。面板 `/api/status`、
  `/crewmine status`、网页详情都还是同一个结构，字段顺序不变。
- runtime 的 `buildStatusPayload` 只剩三行转发；`describe()` 留在原处（只有 5 行）。
- runtime 行数 8477 → **8385**。
- 测试 **447/447 通过**；给「召唤 1 人」的用例补了状态断言（`entries`、`holdPct`、
  `siege`、`presets`、`followFormation`/`followDistance`），**这条新断言会走完整条
  组装循环**——注入漏一个回调就会在这里炸，而不是等游戏里打开面板。

## 0.5.4 — 2026-10-24 · P2 第 1 步：抽出 behavior 写入模块

- 新增 `lib/nfCrewMiningBehavior.js`（165 行）：白名单、数值区间、布尔/字符串转换、
  写盘、裁剪旧键、reload，全在一个文件里，对外是 `createBehaviorWriter()`。
- runtime 删掉本地三份实现（`pruneBehaviorKeys` / `persistBehaviorEverywhere` /
  `setGlobalBehaviorFlag`）和本地的 `normalizeFormation`，改为注入式调用：
  命令（`syncwarp` / `formation`）、面板 API（`/api/mode`）、网页「追击」开关
  现在走同一个 writer，类型转换只有一套规则。
- runtime 行数 8566 → 8477。
- 测试 **447/447 通过**（新增 `test/behavior-writer.test.js` 3 条：类型转换、
  写全量蓝图 + 裁旧键、拒绝未知键/非法值）。

## 0.5.3 — 2026-10-24 · P2（面板）

- **面板拆成三个文件**：`web/index.html`（结构，142 行）、`web/panel.css`（样式）、
  `web/app.js`（逻辑）。`nfCrewMiningWeb.js` 新增两个静态资源路由（`/panel.css`、
  `/app.js`），和其它资源一样在鉴权之前提供，带 `no-store`。
- **编队条独立成一层**：跟随 / 跟随间距 / 分层环绕 / 船员间距 / 阵型 / 跟队跃迁 从
  「作战」页签和设置抽屉里搬出来，放到模式页签下面常驻的一行（`#formationBar`）——
  这些是作业模式下也要用的参数，不该藏在作战页签里。作战页签只留动词：
  自由开火 / 末日授权 / 追击 / 交战规则 / 停火。
- 测试 **444/444 通过**（新增：`/`、`/panel.css`、`/app.js` 都能取到，content-type 正确，
  html 里不再内联脚本）。

## 0.5.2 — 2026-10-24 · P1 去重（行为不变）

- **距离公式只留一份**：新增 `lib/nfCrewMiningGeometry.js`（`positionOf` / `radiusOf` /
  `centreDistance`），mining / combat / salvo / formation 里四份重复实现改成一行委托。
  三个调用方原本对"实体缺失"的语义不同（0 / Infinity / 到原点），所以保留三个名字明确的
  变体（`surfaceDistance` / `surfaceDistanceOrInfinite` / `surfaceDistanceOrZero`），
  只合并计算过程，不改调用方语义。
- **配置写入只留一条路径**：`persistBehaviorEverywhere()` 成为唯一写盘入口（含 prune +
  reload + 逐文件错误收集），`setGlobalBehaviorFlag()` 和 `/crewmine syncwarp|formation`
  都走它；顺带修了它返回 `value: value === true`（数字/字符串会变 false）的问题，
  现在回 `nextValue`。
- **配置读取只留一套规则**：`followFormation` 以前只读 `configs[0]`（手改第二份文件会
  静默不生效），现在和 `syncWarp` 共用 `anyBehavior()`——任一份蓝图打开即生效。
- **面板**：`setBehaviorFlag` / `setModeField` 的 fetch + 错误处理合并成 `postMode()`。
- 测试 **443/443 通过**（新增：任一份蓝图写 ring 时阵型必须是 ring）。

## 0.5.1 — 2026-10-24 · P0 清理

只删不生效的东西，不改行为（442/442 通过）：

- **删除两个从未被 require 的模块**：`lib/nfCrewMiningFleetLattice.js`（114 行）、
  `lib/nfCrewMiningLoginDelivery.js`（124 行）。
- **删除 7 个空配置键**（`BEHAVIOR_DEFAULTS` 51 → 44）：`compressThrottleMs`、
  `specialFuelRefillBelowCycles`、`formationBaseMeters`、`formationSpacingMeters`、
  `fleetWarpFollow`、`deliverWithinMeters`、`fleetWarpInject`。它们只存在于默认值里，
  代码一次都没读过。
- **写盘自动清理旧键**：`pruneBehaviorKeys()` 在 `setGlobalBehaviorFlag` 和
  `persistBehaviorEverywhere` 落盘前删掉 `behavior` 里不存在的字段，老配置会在下一次
  面板/命令写入时自愈（已把 t/69 的 14 份蓝图里的 `fleetWarpInject` /
  `compressThrottleMs` / `deliverWithinMeters` 清掉）。
- **面板**：删掉 `#sync` 空占位元素（跟队跃迁按钮已自带状态）。
- **USAGE 补齐 7 条已实现但没写进帮助的命令**：`aggrodebug`、`rebuild`、`status`、
  `syncwarp`、`formation`、`ui`（+ `corp sync` 的旧写法说明）。
- 测试 **442/442 通过**，新增 2 条断言：面板写入后旧键必须被清掉。

## 0.5.0 — 2026-10-24

按“表面间距 + 方案 A（同 tick 下发、各自对准）+ 不塞假身份”重做跟随与跟队跃迁。

- **跟随改为引擎 FOLLOW 闭环**：`followShipEntity(entity, playerShipID, 表面间距)`。
  引擎的 `desiredRange = followRange + r1 + r2`，所以下拉值就是**模型到模型**的距离；
  `gap <= 50` 时它会把速度匹配到玩家（玩家停就停），不再像 GOTO 那样全速撞上来。
  `followDistance` 允许 **0**（模型相切），`-1` = 不保持间距（分层环绕）。
- **删除 GOTO 驻位**：`holdFormationPoint` / `formationPointFor` 及 goto 回退全部移除
  （引擎的 GOTO 没有到达判定，位置≈目标点时按旧朝向继续全速飞，这是“压到玩家身上”的根因）。
- **`syncWarp` 闸门修正**：以前只读 `configs[0].behavior`（按文件名排序 = 1fenghuang，
  没有这个字段），导致整段跟队跃迁代码从未执行。现在改为 runtime 级开关
  （`/crewmine syncwarp on|off`），并保证关掉时也能收尾飞行中的那一组。
- **跟队跃迁重写（`lib/nfCrewMiningFleetWarp.js`）**：包玩家的 `warpToPoint` / `warpToEntity`，
  命令成功的那一拍就对每条在役船员下发 `warpDynamicEntityToPoint({forceImmediateStart:false})`，
  复制玩家的 `requestedAtMs` / `warpSpeedAU`；落点用引擎的碰撞感知点阵
  （`computeFleetWarpPointLandingPoints`）。**不注入伪 session**：船员是 sessionless 实体，
  起跳/落地由引擎 tick 的 `sharedUpdates` 广播（和 NPC 同一通道），
  `beginPilotWarpVisibilityHandoff` 在无 session 时直接返回，所以船不会被摘球。
- **取消/重下**：玩家取消时，仍在“对准”阶段的船员停船（清 `pendingWarp` 后走
  `stopDynamicEntity` 以便广播 Stop）；已经进入 warp 的让它们落地。再次跃迁按新目标重下。
- **F1 注入删除**：`collectFleetWarpFollowers` 包装与伪 session、`runtime.warpToPoint` 全局
  补丁全部移除；`fleetWarpInject` 字段保留但恒为 false（旧配置不报错）。
- **池子只复用角色**：`selectForSpawn` 不再排除“在场”的成员，同一蓝图的人优先复用；
  复用时先回收旧实体与旧船（`removeEntity` + `removeShipItem`），只有池子人数不够才新建角色。
  连点两次不会再凭空多出一个角色，机库也不会再堆积已装配的旧船。
- **面板**：跟随下拉新增 `0 m（贴住）` 与 `分层环绕`，文案改为“表面间距”。
- **船员彼此之间保持表面间距**：新配置 `behavior.crewSpacingMeters`（默认 100，面板「间距」）。
  第 i 艘船（按 characterID 稳定排序）的站位 = 跟随间距 + i × 船员间距，形成阶梯；
  引擎的 FOLLOW 只控制"离目标多远"、控制不了方位，所以同一方位上的两艘船只能靠半径差
  拉开（两艘半径 r 的船要留 D 米空隙，径向需要 2r + D）。
- **回退**：上一版"下发时扣掉 50 m 死区"的改动已撤销（那是把需求理解成"船员↔玩家"的距离）。
  玩家间距仍按配置值原样下发；实测稳定在 `配置 + 50 m` 是引擎 `gap > 50` 的逼近死区，
  属于引擎行为，不在 mod 里补偿。
- **跟随阵型可选模式**（和跟队跃迁一样是可切换开关）：
  - `ladder`（默认，A）：第 i 艘船站位 = 跟随间距 + i × 船员间距，引擎 FOLLOW，最稳；
  - `ring`（B）：所有船员停在同一个环上（表面半径 = 跟随间距），250 ms 闭环
    `gotoPoint` + `setSpeedFraction` 自写刹车，距离一致但会有轻微抖动；
    人多/船大时自动把环放大到相邻不重叠（日志 `[ring] … 环半径临时放大到`）；
    被派去挖矿、追击、跃迁中、堡垒/会战模式的船不会被环接管。
  切换方式：面板「阵型」下拉，或 `/crewmine formation ladder|ring`，写入全部蓝图。
  纯计算在 `lib/nfCrewMiningFormation.js`（`planRingStep` / `approachFraction` 等）。
- **修复：面板写「阵型 / 间距」被布尔转换吃掉**。`applyModeRequest` 先把
  `request.value` 折成 `value === true || value === "true"`，再把结果交给
  `setGlobalBehaviorFlag`：于是 `followFormation:"ring"` 永远写不进去（面板 2 s 后
  被 status 拨回"阶梯"），`crewSpacingMeters:150` 被当成 `false` → `Number(false)=0`
  写进全部蓝图（"间距总变成 0"）。现在把原始值原样传下去，由 `setGlobalBehaviorFlag`
  按 key 自己转换（布尔 / 数字 / 字符串），并加了一条回归测试。
- 测试 **442/442 通过**（新增 `test/crew-warp-follow.test.js` 5 条 + 阶梯站位 1 条 +
  `test/formation-ring.test.js` 7 条 + 环形接入 1 条 + 面板写入 1 条）。

## 0.4.0 — 2026-10-24

按 [`docs/archive/优化10-24-03.md`](docs/archive/优化10-24-03.md) 实施（O1–O5、O8、F1）：

- **O1 脉冲模块 `repeat` 常驻**：护盾回充器/装甲维修器激活时传 `{repeat: 1}`，引擎自己循环，
  不再每 4 s/15 s 重激活；达到 90%/95% 才由 mod `deactivate`。
  新开关 `behavior.defenseRepeatModules`（默认 true）。
- **O2 防御按需 + 每 tick 限 1 次激活**：`runDefenseFor` 先做廉价预判（没有模块需要开/关就跳过）；
  `manageDefense` 新增 `maxActivations`（runtime 传 1），同一帧最多激活 1 个，其余排队到下一 tick。
  新开关 `behavior.defenseMaxActivations`（默认 1）。
- **O3 大模块激活排队**：堡垒/会战/后勤/工业核心/末日共用一个“每系统 2.5 s 一次”的间隔，
  不再出现 1220/1086/1798 ms 叠在同一帧；单次 1.8 s 的引擎重算仍在，只是不叠加。
  新开关 `behavior.largeActivationGapMs`（默认 2500）。
- **O4 `serviceTick` 轮转**：每次只处理 1 艘船员（交付/压缩/燃料），多船员时不再一次 3–4 s。
  新开关 `behavior.serviceRotate`（默认 true）。
- **O5 `syncCombat` 扫描冷却**：没有候选目标后 2 s 内不重扫；集火/复仇/指挥官目标变化不受限制。
  新开关 `behavior.scanCooldownMs`（默认 2000）。
- **O8 分段计时**：`mine` 重选矿耗时 ≥200 ms 时记 `[perf] mine retry …`；
  watch tick 的 defense/service 段已有计时，可直接对照。
- **跟队跃迁改在“玩家开始对准”时触发**：`followFleetWarp` 不再等 `mode === "WARP"` 之后的
  `warpState`，而是玩家一写入 `pendingWarp`（对准开始）就给船员下跃迁命令：
  复制玩家的 `requestedAtMs` / `alignTime` / `warpSpeedAU`，用 `warpDynamicEntityToPoint`
  让船员同一刻开始转向、加速、起跳；落点按相对位置偏移保持阵型；玩家取消跃迁时自动停船。
  跃迁窗口内临时挂 pseudo session，激活后广播 warp-start 给可见会话，落地恢复。
  没有 dynamic API 时退回原来的 ingress 复刻。日志关键字：`玩家开始准备跃迁`、
  `同刻开始对准（dynamic warp）`、`广播 warp-start`、`跟随跃迁取消`。
- **F1 注入实验回退**：`fleetWarpInject` 默认 **false**，面板勾选已移除；注入代码保留在
  `lib/nfCrewMiningFleetWarp.js`，后续选定方案再启用。跟队跃迁仍由 `followFleetWarp` 负责。
- **面板按钮**：**「跟随」下拉**（50/100/200/…/1000 m）：所有船员保持在玩家周围该半径的圆环上，
  按槽位均匀分布，不排成一字长蛇；点跟随 `gotoPoint`，玩家移动 >25 m 或每 1 s 重下发。
  **「分层环绕」**：半径固定 **100 / 200 / 300 / 400 m，最大 500 m**。两个都是下令按钮。
- **召回距离显示**：小于 1 km 显示米（不再是“回你身边（0 km）”）。
- **日志面板**：`crew.log` / 运行日志在用户往上翻时不再强制滚到底部；`crew.log` 改用追加节点，避免整体替换重置滚动位置。
- **F1 广播时机**：warp-start 改为**等 `activatePendingWarp` 激活后**（`warpState` 存在且
  `pendingWarp` 已置空）再调用 `sendSessionlessWarpStartToVisibleSessions`；preparing 阶段
  `buildWarpStartUpdates` 为空，所以之前一直发不出去。
- 测试 **431/431 通过**（新增 5 条：O1 repeat、O2 maxActivations、F1 pseudo session/注入/关闭）。

## 0.3.1 — 2026-10-24

- **搜索半径按船的锁定距离**：`syncCombat` 与采矿选矿不再用固定 `freeFireRangeMeters`（60 km）/
  配置半径，而是取实体的 `maxTargetRange`（属性 76，没算出来时退回配置值）。
  日志里的“搜索半径”显示实际使用的锁定距离；锁不到的目标/矿不再进入候选。
- **导弹/鱼雷齐射发射特效**：`fireVolley` 返回 `fxGroups`（按 `resolveWeaponSpecialFxGUID`
  取 `effects.MissileDeployment` / `effects.TorpedoDeployment`），runtime 在每次齐射时广播，
  客户端能看到发射动画。仍是齐射结算、不生成导弹实体，伤害逻辑不变。
- 测试 **426/426 通过**（新增 2 条：导弹齐射 FX 组、锁定距离取值）。

## 0.3.0 — 2026-10-24

本次解决的问题（对应 `docs/待解决问题-2026-10-24.md` 的编号）：

### 面板 / 可观测性

- **A1 常开装备在船员信息里看不见**：`buildCrewDetail` 的装配项新增 `passive` / `effectLabel`，
  面板把抗性增强器显示为 **“常开 · 已生效”**（不再误显示“使用中”），
  汇总改为 **`运行 N · 常开 M / 共 T`**，被动项不再混进“运行”计数。
- **A2 中槽标签错**：`slotNameForFlag` / `slotLabelFor` 的中槽范围从 19–21 扩到 **19–26**，
  flag 22–26 的模块不再被写成 `cargo slot 22` 或归到“货舱”组。

### 回充器 / 装甲维修器

- **A4 / A5 回充器 `<60% 开、>90% 停`**：停止阈值默认 0.85 → **0.9**；
  新增 **“充电中”锁存**——低于 60% 触发后，周期结束仍会继续重激活，直到 ≥90% 才停，
  不再停在 60% 出头。
- **A7 装甲维修器同款问题**：修甲共用同一个锁存，装甲 60% 起会连续修到 ≥95% 才停。

### 装备

- **B1 导弹制导计算机（group 1396）**：加入防御装备映射，按常开处理，
  激活时带 `repeat: 1` 让它自己循环；激活前会把货舱里的脚本（如 Missile Precision Script）装到模块上。

### 性能

- **C1 `syncCombat` 每 tick 全场景重扫**：当前目标仍然合法（同场景、在射程、未被黑名单/胶囊/友军排除）
  时直接沿用，不再调用 `pickTargetFor` 全扫；指挥官集火、报仇目标、仇人扩散仍按原优先级重选。
- **C2 不需要燃料的模块被当成“燃料已空”**：`ensureFuel` 新增 `needsFuel` 字段
  （堡垒 33400/94010 这类无 713/714 的模块返回 `needsFuel: false` + `NO_FUEL_REQUIRED`），
  调用方直接跳过补给；补料结果按 typeID 缓存。堡垒不再每 10 秒刷“燃料已空”，也不会每 5 秒重试激活。
- **C3 NPC 唤醒太频繁**：`wakeNpcsNearCrew` 半径 80 km → **40 km**，同一 NPC 间隔 10 s → **30 s**。
- **C4 `service tick` 3–4 秒**：`deliverCrew` 对**空舱**（战斗船/没有矿的船）直接跳过，
  不再做容量重算和压缩/交付；同时 `holdVolumeOf` 支持复用已扫描的堆叠，少扫一遍库存。

### 目标

- **A3 目标不在当前星系**：听令模式下先校验指挥官目标是否在当前场景，不在就不下令，
  不再每 45 秒白锁一次并刷“不在当前星系”。

### 测试

- `node --test`：**424/424 通过**（新增 8 条：A1/A2 面板字段、A5/A7 锁存、B1 制导计算机、C2 燃料需求）。

### 未包含

- **NPC 泰坦末日“只能打旗舰”补丁**：属于服务端引擎补丁（`NPC泰坦末日旗舰限制修复补丁\`），
  不在本 mod 的版本里。

---

## 0.2.0 — 2026-10-21

- mod 身份迁移：id / 目录 `nf-crew-mining` → `nf-crew`，显示名改为 **NFCrew · 船员编队**；
  数据目录、启动器清单、日志前缀同步迁移（脚本 `tools/rename-mod-id.js`）。
