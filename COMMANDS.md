# NFCrew · 船员编队 · 指令说明

`nf-crew`（`/crewmine`）—— 召唤虚拟玩家驾驶他们自己的采矿船，加入你的舰队、跟着你采矿、
用你的工业指挥舰压缩、把矿整舱交到你的矿舱里。

> 全部指令都在**游戏内聊天框**输入，以 `/crewmine` 开头（服务器端拦截，不需要开 GM）。
> 输入 `/crewmine` 或 `/crewmine help` 会打印简版用法。

---

## 1. 第一次使用（照抄）

```text
# ① 在舰队窗口创建舰队（舰队状态是内存的，服务器重启就没了）

# ② 看配装是否合法（不生成任何东西）
/crewmine check

# ③ 看现有配装
/crewmine list

# ④ 召唤 1 个人（2 AU 跃迁进场，约 30 秒落地）
/crewmine spawn covetor-ore 1

# ⑤ 如果第 ④ 步提示 NO_PLAYER_FLEET，先建舰队再补入队
/crewmine fleet join all

# ⑥ 下令采矿
/crewmine mine all

# ⑦ 挖满一舱后交付（压缩 + 搬进你的矿舱）
/crewmine deliver all

# ⑧ 收工：解散（跃迁离场，2.5 秒后移除）
/crewmine disband all confirm
```

---

## 2. 指令一览

### 2.1 配装（`configs/*.json`，一条配装一个文件）

| 指令 | 作用 |
| --- | --- |
| `/crewmine check` | 预检所有配装：槽位、CPU/PG（技能全 5 的 ×1.25）、校准值、无人机舱体积、是否有采矿模块。**不生成任何东西** |
| `/crewmine list` | 列出配装文件与里面的条目（id / 船 / 模块数） |
| `/crewmine list <文件>` | 列出某个配装文件里的全部条目 |
| `/crewmine import <文件> "<名字>"` | 从客户端装配文件（XML）生成一条配置；可加 `--id <id>`、`--count <数量>` |
| `/crewmine config` | 打印配装目录、状态文件、类型缓存、别名文件、SDE 路径 |

### 2.2 驾驶员池

| 指令 | 作用 |
| --- | --- |
| `/crewmine pool list` | 池里的人：名字 · 配装 · 在役（船号）/ 待用 |
| `/crewmine pool scan` | 找出**池外**的本 mod 角色（召唤中途失败留下的孤儿） |
| `/crewmine pool adopt <角色ID>` | 把池外角色收进池里复用（下次召唤优先用它） |
| `/crewmine pool clear confirm` | 删除池里所有角色记录（**不可恢复**） |

> 池的意义：同一个角色反复使用，不会无限造人。解散后角色仍在池里（`待用`），下次召唤优先复用。

### 2.3 召唤与舰队

| 指令 | 作用 |
| --- | --- |
| `/crewmine spawn <配装id> [数量]` | 造人（或复用池里待用的人）→ 建船并装满配装 → 送上天 → **诱导入场**（在你旁边点亮诱导力场，4 秒后跳进来）→ 入队 → 编队 → 落地后跟随 |
| `/crewmine fleet join all\|<名字>` | 把他们加入你当前的舰队（需要你先有舰队）；`all` 只处理**本星系**的船员 |
| `/crewmine recall all\|<名字>` | 召回：回到你身边待命（**不改变舰队关系**）；实体丢了会**重建并跃迁进场** |
| `/crewmine disband all\|<名字> confirm` | 解散：**诱导跳走**（播一次跳走特效，6 秒后移除实体、删船、退队）；角色保留在池里 |

### 2.4 采矿

| 指令 | 作用 |
| --- | --- |
| `/crewmine mine all\|<名字>` | 下令采矿：选矿（默认 150 km 内、**离自己这条船**最近且**没被别人认领**的一块；矿不够时才共享）→ 超出射程则**保持距离**飞到射程内 → 锁定 → 激活船上**在线**采矿模块 |
| `/crewmine mine all\|<名字> off` | **停止采矿**：关掉采矿模块、清目标、退出采矿名单（面板行内「停止采矿」按钮用这个） |
| `/crewmine deliver all\|<名字>` | 压缩 + **整舱一次性**交付到你的**矿舱**；矿舱满或没有矿舱则改投**货舱**；两个都满则暂停并提示手动重试 |

### 2.5 军团与诊断

| 指令 | 作用 |
| --- | --- |
| `/crewmine corp sync` | 把池里所有人重新结算到你当前的军团设置（`corporation`） |
| `/crewmine debug [all\|<名字>]` | 诊断：实体是否在场、`mode`、距你多远、选中的矿与面距、射程、模块在线/已激活、**接近指令结果**、场景静态实体/还有矿数量 |
| `/crewmine aggrodebug [all\|<名字>]` | 诊断：NPC 仇恨/锁定（排查"怪不打船员"） |
| `/crewmine rebuild [all\|<名字>]` | 按装配重建船的派生属性（老船属性不对时用） |
| `/crewmine status [json]` | 当前状态快照；`json` 给外部程序读（面板 `/api/status` 同一份） |

### 2.6 编队 / 跃迁 / 面板

| 指令 | 作用 |
| --- | --- |
| `/crewmine syncwarp on\|off` | **跟队跃迁**：你按跃迁时，船员同一拍开始对准（各自按自己的船体转），落地各自到编队点。写进全部蓝图，重启后保持 |
| `/crewmine formation follow\|ladder\|ring` | **跟随阵型**：`follow` 跟随（所有船和你保持**同一个**间距，不递增，走引擎 FOLLOW）/ `ladder` 阶梯（按间距依次外扩，走引擎 FOLLOW，无 500 m 下限）/ `ring` 环形（都在同一圈上，250 ms 闭环刹车）。⚠️ 只在**有间距**时才动，见下一条 |
| `/crewmine follow <米>` | **表面间距**（模型到模型）：跟随/阶梯的基准距离、环形的圈半径。`-1` = 清空（之后不移动） |
| `/crewmine spacing <米>` | **阶梯步长**：第 n 艘 = 间距 + (n-1) × 步长。只对阶梯生效，跟随/环形忽略 |
| `/crewmine halt [名字]` | **停船**（独立动作，不属于阵型）：让在役船员原地减速停住，并回到"静止等命令"。跟队跃迁不受影响。不带名字 = 全部 |
| `/crewmine ui` | 打开浏览器控制面板（自动带本账号 token） |

> **没有默认行动**：召唤落地后是 `idle`（静止等命令），必须显式下 `formation` + `follow` 才会动。
> 阵型/间距/步长存在租户的 `state.json` 里（`settings.followPlan`），重启后保持。

---

### 2.7 库存 / 价格 / 配装台（1.0.0）

> 库存默认**关**：`/crewmine stock on` 才把召唤切到「从仓库取船」。关掉不会清空仓库，只是回到老的“凭空造/删”行为。

| 指令 | 作用 |
| --- | --- |
| `/crewmine stock [status\|list]` | 库存状态：在库/占用/在用/丢失数量、累计花费/退回、仓库角色、最近 30 条 |
| `/crewmine stock on\|off` | 库存总开关（开启时自动建仓库角色 `<你的角色名>NFCREW` @ 吉他 4-4） |
| `/crewmine stock init` | 单独创建/自检仓库角色 |
| `/crewmine stock buy <配装> [数量]` | 订货：按 **80% 卖价**（船体+模块）扣款，造真船进仓库（一次订货一次扣款） |
| `/crewmine stock deposit [ID…]` | 把你在吉他 4-4 机库里的船（不含正在开的）转入仓库 |
| `/crewmine stock withdraw <ID…>` | 取出到吉他 4-4 机库 |
| `/crewmine stock sell <ID…>` | 卖出（只对购入的船，按实付价退） |
| `/crewmine stock migrate` | 把**不在役**的老船员船搬进库存（在役的等解散时自动回库） |
| `/crewmine stock reconcile [adopt]` | 对账：按物品表修正账本；`adopt` 认领仓库机库里没上账的船 |
| `/crewmine stock backup` | 复制一份账本到 `backups/`（物品库 `gamestore.sqlite` 要一起备，停服后复制） |
| `/crewmine price <typeID\|名字> [数量]` | 查价格：吉他最低卖价 × 0.8，没有卖价按 100 ISK |
| `/crewmine catalog [build]` | 类型索引状态 / 重建（船体/模块/弹药/无人机，索引 v6） |

**配装台（面板页签）**：船体/槽位/弹药下拉都可输入搜索；校验 CPU/PG（默认全 V）、炮台位/发射器位、无人机带宽/舱容、改装件尺寸与同组；汇总行给出 80% 报价与 `DPS · EHP` 近似值。

**非 GM 用法**：客户端会吞掉非 GM 角色不认识的 `/命令`，改用普通聊天 `!crewmine <参数>`（等同 `/crewmine <参数>`）。

---

## 3. 行为配置（`configs/*.json` 的 `behavior` 字段）

改完保存即可，无需重启（按 mtime 自动重新加载）。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `arrival` | `"cyno"` | **入场方式**：`cyno` 诱导入场（先点亮诱导力场，`cynoLeadMs` 后跳进来，和 evejs-faction-sim 的会战舰队一样）/ `warp` 从远处跃迁进场（老行为，客户端画真跃迁）/ `instant` 直接出现在你旁边。**优先于 `warpIn`** |
| `departure` | `"jump"` | **离场方式**（解散时）：`jump` 诱导跳走（播一次跳走特效，6 秒后移除）/ `warp` 真跃迁飞离（老行为） |
| `cynoLeadMs` | `4000` | 诱导力场点亮后多久船跳进来（毫秒，0–30000） |
| `cynoDurationMs` | `60000` | 诱导力场保留多久（毫秒，1000–600000）；到点由模组自己摘（场景不收这种实体），再召唤会先收掉旧的 |
| `cynoRadiusMeters` | `2000` | 跳进来的船在力场周围散开的半径（米，0–50000）；`0` = 全部落在力场上 |
| `cynoTypeID` | `21094` | 力场用的物品类型（默认 Cynosural Field），一般不用改 |
| `warpIn` | `true` | 老写法：`false` = 直接出现（等价 `arrival: "instant"`）。`true` **不再**强制跃迁——要跃迁请写 `arrival: "warp"` |
| `warpInAu` | `2` | 只有 `arrival: "warp"` 时才用：出生点在 2 AU 外 |
| `followRangeMeters` | `1000` | 只在**没有**命令设间距时作为"召回"等显式命令的兜底距离，范围 200–60000 |
| `combatSalvoBudgetPerTick` | `3` | 普通模式下每拍最多结算几艘船的齐射（1–16；设成 ≥ 在役人数 = 不轮转） |
| `missileEntity` | `true` | 导弹/鱼雷齐射发一枚零伤害实体球（纯表现；关掉只是看不到弹体，伤害/电容不变）。全局关 `EVEJS_CM_MISSILE_FX=0`，上限 `EVEJS_CM_MISSILE_CAP`（默认 24，0=不限） |
| `focusFireMaxTickMs` | `6000` | **火力集中**打开时的单拍安全阀（毫秒，1000–30000）：一拍内累计结算超过它就顺延到下一拍 |
| `followDistance` | `-1` | ⚠️ **0.6.8 起不再驱动行为**：运行期间距只认 `/crewmine follow <米>` 或面板（存 `state.json` 的 `settings.followPlan`）。这里只作为面板初值 |
| `crewSpacingMeters` | `100` | ⚠️ 同上，不再驱动行为；运行期用 `/crewmine spacing <米>` 或面板「步长」 |
| `followFormation` | `"ladder"` | ⚠️ 同上，不再驱动行为；运行期用 `/crewmine formation follow\|ladder\|ring`。历史值 `stop` 已非法（停船改为 `/crewmine halt`） |
| `syncWarp` | `false` | 跟队跃迁：你跃迁时船员同刻对准（`/crewmine syncwarp on` 会写这一项） |
| `mineSearchRadiusMeters` | `150000` | **选矿**范围：离你多远内的矿会被选中（150 km）；范围 1000–500000 |
| `mineEngageRangeMeters` | `15000` | **开采**射程的兜底值（真实射程优先取模块的 `maxRangeMeters`，含技能/改装；实测 24 km） |
| `compressOnCycle` | `true` | 能压缩就压缩（压缩后立即交付，不设阈值） |
| `serviceIntervalMs` | `15000` | 自动服务循环间隔（压缩 + 交付），5000–300000 |
| `deliverStopPercent` | `80` | **没有压缩设施**时，货舱到该百分比开始交付 |
| `deliverResumePercent` | `70` | 交到该百分比以下停止 |
| `drones.launch` | `"auto"` | 无人机发射策略（`auto` / `manual` / `none`） |
| `drones.mode` | `"mining"` | 无人机用途 |
| `drones.maxActive` | `0` | 同时在飞的无人机上限（0 = 不限） |
| `drones.recallBeforeWarp` | `true` | 跃迁前召回无人机 |
| `drones.recallWhenIdle` | `true` | 空闲时召回无人机 |

> **入场/离场想换回老样子**：把 `configs/*.json` 的 `behavior.arrival` / `behavior.departure` 改成 `"warp"`（保存即生效，不用重启），
> 或走面板接口 `POST /api/mode {"field":"arrival","value":"warp"}` / `{"field":"departure","value":"warp"}`。
> 诱导力场是**画出来的**（`nfCrewCyno: true`，不挂 beacon，谁都跳不进去）；引擎真正的诱导力场要 session + 装好的 cyno 发生器，
> 无 session 的船员船没有这两样。

> 交付策略（最终确定）：
>
> - **默认：货舱到 80%（`deliverStopPercent`）自动压缩并整舱交付**，降到 70%（`deliverResumePercent`）以下停止；
> - **一键收矿**：`/crewmine deliver all`（将来是 UI 按钮）**忽略 80% 阈值，立即压缩并整舱交付**；
> - **矿舱优先，矿舱满 / 无矿舱自动改投货舱**；整舱一次性搬完，不按堆零敲碎打；
> - 玩家两个舱都满 → 暂停交付并提示，**不自动恢复采矿**（腾出空间后手动 `deliver` 或等循环重试）。
> 两个都满就暂停交付，**不自动恢复采矿**——腾出空间后手动 `/crewmine deliver`（将来是 UI 按钮）。

---

## 4. 配装文件格式

```json
{
  "id": "covetor-ore",
  "name": "挖矿",
  "count": 1,
  "job": "mining",
  "skills": "all",
  "corporation": "auto",
  "wing": null,
  "squad": null,
  "fit": {
    "hull":    {"typeID": 17476, "name": "Covetor"},
    "modules": [{"typeID": 28754, "name": "ORE Strip Miner", "flagID": 27}],
    "drones":  [{"typeID": 3218, "name": "Harvester Mining Drone", "quantity": 5}],
    "cargo":   []
  },
  "charges": [],
  "behavior": {"warpInAu": 2, "mineSearchRadiusMeters": 150000}
}
```

- `corporation`：`"auto"`（跟你同军团）/ `"none"`（无军团）/ `<军团ID>`
- 模块授予时**自带 `moduleState.online = true`**（否则采矿模块无法激活）
- 客户端装配文件来自 `C:\Users\<你>\Documents\EVE\fittings\*.xml`；水晶/弹药需在 `charges` 里显式给
- 类型名解析顺序：`aliases.json` 别名 → 类型缓存 → SDE 流式扫描

---

## 5. 数据与路径

| 内容 | 路径 |
| --- | --- |
| 配装 | `_local/nf-crew/configs/*.json` |
| 状态（驾驶员池） | `_local/gameStore/nf-crew/state.json` |
| 类型缓存 | `_local/nf-crew/typecache.json` |
| 别名 | `_local/nf-crew/aliases.json`（`{"aliases": {"驯鹿级": 12345}}` 或直接映射） |
| SDE | `_local/sde/eve-online-static-data-3396210-jsonl/` |

> ⚠ **服务器运行时不要用裸 node 跑会写状态的命令**（`spawn` / `disband` / `pool clear` 等）：
> 那是只读角色，写物品会失败但状态可能被改写。离线只跑 `check` / `list` / `pool list` / `config`。

---

## 6. 常见输出与处理

| 输出 | 含义 / 处理 |
| --- | --- |
| `入队失败 NO_PLAYER_FLEET（请先在舰队窗口创建舰队，再召唤）` | 你还没有舰队。建舰队后再 `fleet join all` |
| `跃迁 2 AU / 299.2e9 m（29.5s 后跟随）` | 2 AU 的出生点距离与引擎算出的飞行时间（时长由船速决定，不是距离） |
| `采矿 x / y 人` + `前往目标（29 km） · 保持 23 km（射程 24 km）` | 在往矿飞，进入射程后自动锁定+激活 |
| `锁定中（5s 后开始采矿）` | 正常：目标锁定需要时间 |
| `X km 内没有矿，改去 Y km 处的 <矿ID>` | 半径内没矿了，自动去更远的那块 |
| `没有可采小行星（场景静态实体 37 个，其中还有矿 0 个…）` | **矿带被采空**（`还有矿 0`）或纯粹距离问题（`还有矿 N`） |
| `矿舱和货舱都满了，暂停交付…手动重试` | 你的船满了：腾空间后 `/crewmine deliver all` |
| `压缩 N 组 · 交付 M 组 → 矿舱/货舱 · 货舱 82%→0%` | 正常交付 |
| `召唤步骤异常（…），角色已保留在池中` | 某一步抛异常；角色不会丢，可用 `pool list` 确认 |
| `实体✗（不在场景）`（debug） | 船实体不在场景；`recall` 或 `mine` 会自动重建 |

---

## 7. 当前进度与已知边界

- ✅ M0–M4：配装/池/召唤（跃迁进场）/舰队/跟随/召回/解散/军团同步/采矿（锁定+激活）/分矿
- ✅ M5 第一片：压缩 + 整舱交付（矿舱→货舱）+ 80/70 阈值（无压缩时）
- ✅ 自动服务循环：`mine all` 后每 `serviceIntervalMs`（默认 15 秒）检查一次，**到 80% 才压缩+整舱交付**；
  玩家矿舱 + 货舱都满时暂停交付，**不自动恢复采矿**（腾出空间后手动 `/crewmine deliver` 或 UI 按钮）
- ⏳ 未完成：矿采空后的自动换矿、**无人机发射**、
  跨星系跟随（M6）、Neocom 窗口 UI（M7）、战斗扩展（M9–M12）

## 网页控制面板

```text
/crewmine ui        # 用默认浏览器打开 http://127.0.0.1:8741/
```

- 只绑 `127.0.0.1`，局域网不可访问；
- 页面能力：装配方案下拉 + 召唤、全部入队、全部采矿、**一键收矿**、全部召回、解散（一步确认）；
- 每行单船操作：开始采矿 / 回收矿物 / 召回 / 解散（带置灰与确认）；
- 「帐号装配方案」区：读取服务端装配库（`savedFittings`），可搜索/翻页/导入为蓝图；
- 底部「运行日志」记录每次操作的指令与服务端回执。

接口：`/api/status`、`/api/cmd`、`/api/stream`(SSE)、`/api/fittings`、`/api/import`。

### 五、作业与战斗

| 指令 | 作用 |
| --- | --- |
| `/crewmine mine all\|<名字>` | 开始采矿（面板行内按钮同义） |
| `/crewmine mine all\|<名字> off` | 停止采矿 |
| `/crewmine deliver all\|<名字>` | **一键收矿**（无视阈值） |
| `/crewmine recall all\|<名字>` | 召回 |
| `/crewmine attack all` | **自由开火**：自动锁定附近敌对 NPC（原生 NPC 舰船）并开火 |
| `/crewmine attack off` | 关闭自由开火 |
| `/crewmine focus on\|off` | **火力集中**（0.6.13）：打开后**解除每拍 3 艘的齐射轮转**，本拍所有冷却好的船一起结算；面板「火力集中」按钮等价。只保留单拍安全阀 `focusFireMaxTickMs`（默认 6000 ms，超了余下顺延到下一拍）。人越多这一拍越长 |
| `/crewmine special <名字\|all> bastion\|siege on\|off` | **特殊装备开关**（PLAN §18）：堡垒装备 33400 / 会战装备 20280。玩家决定，船员不会自己开 |
| `/crewmine special <名字\|all> smartbomb on\|off` | **立体炸弹**（组 72）：允许/禁止使用；真正开火还要求范围内只有敌人（无友军/中立） |
| `/crewmine special <名字\|all> triage\|core on\|off` | **组 515 其余型号**：后勤（Triage）/ 工业核心，与堡垒/会战同一套开关 |
| 燃料 | 会战/后勤要**锶包合物**、工业核心要**重水**；激活前由模组自动补一次的量（`behavior.specialFuelAutoSupply`，默认开） |
| `/crewmine special <名字> doomsday on` | 发射末日（等价 `/crewmine doomsday`） |
| `/crewmine special` | 看谁装了特殊装备、现在开没开、启动后有哪些惩罚 |
| `/crewmine siege on\|off [选择器]` | 上一条的旧写法（等价 `special … all on\|off`），保留兼容 |
| `/crewmine stop all\|<名字>` | **停火**：关闭所有已激活模块并清除目标（同时关闭自由开火） |
| `/crewmine disband all\|<名字> confirm` | 解散 |

> 交战是**自动**的：你锁定并开火的目标，船员会自动锁定同一目标一起打；你换目标它们跟着换；
> 你取消锁定它们停火。`/crewmine stop all` 让它们停火，并在你锁定**新**目标前保持停火。
> 不追击，编队始终跟着你。
