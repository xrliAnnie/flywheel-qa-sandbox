# FLY-2925 引擎统一体生命周期 — 调研
Issue: FLY-2925 (https://linear.app/geoforge3d/issue/FLY-2925/病根修复-7-codex-体生死只认引擎一侧goal-结束不等于死引擎终结后-goal-不得自续重启只按原会话续接6-张-43)
日期: 2026-09-26
基于: exploration.md

## 1. 取证基线

代码基线：`fdd1b404d`，2026-09-26 当前共享分支。执行体 `0e6daf78-4d2a-4b32-85df-eaa57342e879`；design TURN epoch 2；run `1cbf4e1f-a667-4372-add1-c3269a744267`，node `eng_design`，attempt 1。

已读项目 CLAUDE.md、product-experience-spec、相关 FLY-2808 / FLY-2903 / FLY-2893 文档、FLY-2072 六单盘点及具体消费者。遵循注入 DOC-FLOW；旧项目目录规则不覆盖本单目录。无历史 seed 快照；本任务没有重放旧设计。

## 2. 当前调用链与真正缺口

| 文件（相对仓库根） | 读到的行为 | 对计划的约束 |
|---|---|---|
| `packages/claude-runner/src/codex-daemon-runtime.ts:664,792` | daemon detached 进程组、socket 锁、精确进程身份与 reap | Bridge 死不必然带死 daemon；保留证明后清理，不能按标题/PID 单独杀 |
| `packages/claude-runner/src/CodexTmuxAdapter.ts:2230` | Bridge 中的 adapter 调 runtime.runGoal，持有 phase/turn/termination promises | 独立运行需移出控制者，不是只换启动命令 |
| `packages/claude-runner/src/codex-daemon-client.ts:1348,1510` | blocked 无 gate 时设 terminal；phase 仅对 complete 进入 hold | 修纯分类 helper 太晚：goal promise 已退出，finally 已清理；必须改变 loop 的结束条件 |
| `packages/claude-runner/src/codex-daemon-adapter-helpers.ts:175` | 非 complete 一律 non-success | 需要 observation/disposition 区分，不能用 success=false 表达“活着等纠正” |
| `packages/claude-runner/src/CodexTmuxAdapter.ts:2406,2712,2778` | finally 清理，随后 goal_blocked 终态失败输出 | 活体等待不能落入此 finally；清理只跟引擎终结/批准退下/确证物理故障 |
| `packages/teamlead/src/bridge/event-route.ts:2185,3493` | goal_blocked 到 session blocked 的终态消费者 | 删除发送侧还不够；旧事件重放也不能重新判死 |
| `packages/teamlead/src/bridge/codex-session-reown.ts:535,640,900–929` | owner 消失后检查存活/gate；可 beginRecovery；commit 后 reconcile，失败抛错 | Bridge 重启不应产生新业务回合；活宿主走重连，故障恢复走原会话 |
| `packages/teamlead/src/bridge/plugin.ts:10281` | 重建上下文、读取 immutable launch snapshot、reconcile/arm 接线 | “当前配置”和“启动时身份”混合的风险具体落在此处 |
| `packages/claude-runner/src/codex-daemon-client.ts:1401,1458` | 恢复通过 goal confirmed 或 turn_started receipt 提交；存在 startInitialTurn kick | 不可声称每次恢复必新 turn；要删除的是恢复缺省落入启动 kick 的许可 |
| `packages/claude-runner/src/codex-daemon-goal-runtime.ts:825,860` | FLY-2903 restartGate；缺 predicate 默认允许，抛错拒绝 | 新宿主必须总是携带引擎关闭检查，不能遗漏后走默认允许 |
| `packages/claude-runner/src/codex-execution-ownership.ts:70` | ownership registry 和 stop marks 都是进程内状态 | 将 owner 移出 Bridge 后，需以持久关闭事实补齐，不能仅移植 Map |
| `packages/teamlead/src/bridge/codex-terminal-sweep.ts` / `codex-terminal-sweep-runtime.ts` | 引擎终态集合、owner-stop/reap、进程与 token 观察 | 保留 FLY-2903；更新“owner 在另一个进程”识别，不把新宿主当无人持有 |
| `packages/config/src/feature-flags/registry.ts:644` | node_standby_resume 默认 false，admission scoped、bridge global | 默认开影响两 vendor 新体；不是一行默认值就能让旧在飞体获新合同 |
| `packages/teamlead/src/bridge/runs-route.ts:3832–3948` | LAUNCH_PENDING success=false/retryable=false；启动结果直接影响返回 | FLY-2689 需将 run admission 与首次物理启动结果分开呈现 |

核心事实：FLY-2808 的 `isIntentionalStandby` 只让 retiring/standby/resuming 跳过 reowner。active 体不会因开关变默认开而自动跳过旧 reown。因此必须把 active 体的重启重连也设计进来。

## 3. FLY-2903 状态刷新

GitHub PR [#1343](https://github.com/xrliAnnie/flywheel/pull/1343) 已于 2026-09-26T15:15:00Z 合并，merge `cfc8d52d81ed0f4f2a0d79bc3825ae22107a4bba`。当前代码有 requestStop、mayRestartAfterTransportDeath、终态 sweep。

旧盘点中“FLY-2814 无修复”不再足以描述当前基线。本单验收仍保留 FLY-2814 的原现象，但不重复建 stop registry/sweep/token 账本。独立宿主会使现有进程内 owner 语义发生变化，这个连接处必须纳入本单计划。合并证据不等于生产已部署或真实验收已通过。

## 4. 原生能力验证与外部资料

本机只读 `codex --version` 为 0.157.1。`codex resume --help` 明确支持精确 SESSION_ID、remote endpoint、独立 CODEX_HOME profile；没有启动任务。`/Users/xiaorongli/Dev/codex` 的开源树与实际二进制功能存在差异，不能把本地旧源里搜不到 goal 当作发行版不支持。

官方 [Using Goals in Codex](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex) 说明原生 `/goal` 及暂停/续接能力。官方 [App Server](https://learn.chatgpt.com/docs/app-server) 说明 turn/steer、精确 thread/resume、turn 通知，以及与 TUI 相同的持久 goal 状态 API。读取日期 2026-09-26。

由此支持“保留 app-server 协议、将控制者搬出 Bridge”的设计推论；**官方能力文档不能证明 Flywheel 的邮箱、529 账号隔离或终态竞态已经正确**。原生终端路线仍是首选评估对象，未找到现有裸 CLI 对外提供完整同等机器控制接口的证据，不应以此断言它绝对不可能。

## 5. 最近两周恢复失败统计

### 5.1 窗口与原始数据

`evidence/reown-census.py` 使用生产 SQLite `mode=ro`、query_only 和单次读事务；未复制活库。时间范围为 **[2026-09-12T20:24:44Z, 2026-09-26T20:24:44Z)**，冻结最大 session_event id **11160650**。关闭连接后才生成 JSON/CSV。SQL 值参数化，事件类型和 vendor 固定；时间通过 julianday 统一空格与 ISO 表示。

仅采集三个类型：reown_revive_failed、reown_turn_reconcile_failed、包含明确恢复失败指纹的 session_failed。只保留事件编号、执行体/run/node/issue、时间和枚举错误码；不导出消息正文、凭据或完整 payload。

- `evidence/reown-events.json`：458 条，SHA256 `70e5dd171fa61002931ddc2d33e4f4ca4db47f550ad8b92721dcaeb330c3fa00`。
- `evidence/reown-incidents.csv`：100 行，每 execution_id 一行，保留 proof_event_id 与 event_count。
- `evidence/reown-summary.json`：可重放汇总。
- 默认重跑脚本只使用冻结 JSON；必须显式 `--refresh` 才重新只读取数。

### 5.2 数字和原因证据分布

| 最具体的已观察错误 | 有错误的执行体 | 其中有恢复相关 session_failed |
|---|---:|---:|
| launch_snapshot_mismatch：恢复配置和启动快照不符 | 41 | 26 |
| active_turn_mismatch：回合身份不符 | 25 | 19 |
| keyed_home_reown_arm_mismatch：home 绑定不符 | 16 | 11 |
| owner_failed_unknown：未给出可识别错误 | 17 | 5 |
| recovery exhausted：只有次数耗尽摘要 | 1 | 1 |
| **合计** | **100** | **62** |

原始事件分组：reown_revive_failed 214 条 / 96 个执行体；reown_turn_reconcile_failed 182 条 / 27 个执行体；恢复相关 session_failed 62 条 / 62 个执行体。三组重叠，不能相加成执行体数。100 个体涉及 72 张单。

一个体有多个原因时优先选择具体机械错误：active_turn_mismatch → turn_reconciliation_failed → home_arm_mismatch → launch_snapshot_mismatch → generic post-commit → generic owner → exhausted → unknown。分组是“该体观察到的最具体错误”，不保证其最后一次失败一定由同一原因引起。代码与事件共同支持机制推断；未知原因不强行归为某一种根因。

62 是恢复相关明确终态失败数；另外 38 只证明恢复曾报错，可能后来成功、仍等待或因别的原因失败，**不声称这 38 已恢复成功**。100 不是完整舰队死亡数，也不是 Bridge 重启次数。没有重启总次数、成功恢复分母及逐次班车关联，因此不给失败率，也不声称全部由班车触发。

### 5.3 与旧普查衔接

FLY-2893 以执行体创建时间 [09-11 22:00Z,09-25 22:00Z) 入组，并综合多种来源判故障：Codex K5 64 个、48 张单、56.4 节点小时；总 K5 65 包括 1 个 Claude。此处是失败事件发生时间窗口且覆盖较晚一天，口径不同。旧 ×43 是六张病根单的盘点次数，不能代替这份事件统计。

本单后续可复用 CSV 的确定身份，在 529 合成原现象；不能将本次生产只读统计描述成真实修后验收。

## 6. 目标合同（供下一步实施计划细化）

稳定主键继续沿用 engine execution_id、run/node/attempt、activation。threadId 为原生对话身份，process-body generation 为物理进程代数，account binding 为凭据归属；五者不可互相替代。

引擎持有终结、需求、TURN 权威；独立宿主只持有执行与观察。Bridge 重连只验证 exec/generation/thread/endpoint 并补事件。纯重连不消费恢复预算、不改 goal、不发业务输入、不创建新的 thread。

同体 upstream 等待与 gate/phase 停驻分开记原因：blocked 无 gate 也不是 terminal；用户暂停不能自动解除；限额和预算也不能因为默认 retry 被重置。瞬态错误用有界重试，其他问题保留原体等待纠正，恢复必须带合法需求而非自行杜撰任务。

物理进程确证消失后，按精确原会话拉起；空/错 id、旧代数、账号/home 错绑、引擎关闭、未知 liveness 一律不拉起。FLY-2808 的 fresh fallback 与本单“重启只原会话”要求须明确分流：**Bridge restart 原因禁止 fresh fallback**，合法独立需求的既有 fallback 不能被误删。

关闭沿 FLY-2903 的 stop→drain→进程/监听/token 观察。新的跨进程 owner 不能只依赖 Bridge 内存 stopMarks；引擎关闭记录必须持久，宿主每次重启/原线程激活都核对；关闭超时显示未收净，不能宣布成功。

## 7. 计划需覆盖的实际消费者

1. adapter / goal loop / transport / turn & phase lifecycle / launch snapshots：拆运行宿主后的传参和回执契约。
2. Bridge reowner / dispatcher / plugin / heartbeat / process-body controller：重连、真实故障恢复、standby 按需恢复三条语义。
3. ownership / teardown / terminal sweep / event-route：活体等待、终态与远端 owner。
4. per-runner CODEX_HOME、账号切换、凭据物理副本与运行时实际账号回执：以 FLY-2902 最新版本为准。
5. runs-route / Lead start-action 返回值消费者：run 已接纳与物理启动失败不能互相伪装。
6. feature flag registry / default consumer / frozen snapshots / rollback / tests：不能只改默认声明。

这些是闭包要求，不代表批准六套新框架。优先复用 FLY-2808 与 FLY-2903，不新增一套并行生命周期词表。

## 8. 验收设计与待收口问题

每张单在 plan 中需有固定前置、触发、前后断言、负例和证据路径。529 验证至少包括：Bridge 真重启且当前回合继续；有消息时重连不重投；手工暂停不被恢复；上游 capacity 同 thread 再试；引擎关闭与传输死亡竞态；错误 thread/home/代数拒绝；lease 缺失时 API 与 run 事实一致；账号隔离与一次授权切号。

本机仅设计取证；后续实现按失败相关用例→最小实现→相关文件验证，禁止全仓/全包 suite。TypeScript 变化需显式测试文件与 owning package 的 vitest related；精确 head CI 才是全套证据。

尚待 Lead 回答：独立宿主是否有更晚的架构裁决、FLY-2902 合同，以及 FLY-2689 的最小响应语义修正是否已有归属。问题 `8221ee32-6265-4da8-b341-7e100b14926a`，本轮一次 check 返回 not yet。未请求 brainstorm 或 ship approval。
