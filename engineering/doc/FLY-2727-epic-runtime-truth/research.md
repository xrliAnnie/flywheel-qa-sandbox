# FLY-2727 Epic 页运行态可信 — 调研
Issue: FLY-2727 (https://linear.app/geoforge3d/issue/FLY-2727/epic-页可信-在跑不许照抄-linear-started按机器会话真相判活linear-状态单独显示-discord-链接改)
日期: 2026-09-17
基于: exploration.md

## 现有数据流

`materializeEpicPage()` 读取 Linear scope 后，按 item 调用 StateStore 的现有投影：

- `getEpicPageSessionFact()` 从 `sessions` 取最新一条会话，并聚合 `ledger_live_count`；
- `getEpicPageRunFact()` 从 `workflow_run` 取最新 active/held run；
- `getEpicPageAttemptFact()` 从 `workflow_run_node` 取 current node 最新 attempt；
- `readSignals()` 把 StateStore/CommDB 的 blocked、held、runner stopped、pending question 等信号放入同一 item。

这些事实已进入 `EpicItem`，无需新表或新账本。问题只发生在投影规则：`classifyItem()` 完全没有读取它们。

## 为什么现有 `ledger_live_count` 不能直接等于“在跑”

`getEpicPageSessionFact()` 使用共享 `CMUX_LIVE_SESSION_STATUSES` 聚合，集合包括：

`pending`、`running`、`ship_parked`、`awaiting_review`、`design_done`、`approved_to_ship`。

这个集合用于“cmux/runner 仍可被唤醒或持有上下文”，不是“机器此刻正在工作”。代码注释也明确指出 status 不能单独证明 parked/active。若直接复用 `ledger_live_count`，会把等待 review、等待 ship 的驻留体重新误报成“在跑”。

裸 `status = 'running'` 也不够：`getStuckSessions()` / `getOrphanSessions()` 的存在正是因为异常退出会留下 running residue。最小可信扩展是在同一个 session SQL 聚合中增加 `machine_running_count`，只计 `status = 'running'`、`heartbeat_at` 非空且相对页面生成时间未超过 Bridge `TEAMLEAD_STUCK_THRESHOLD` 的行；另记 running heartbeat stale/null 的证据状态，保留原 `ledger_live_count` 给既有审计和其它消费者。超过该阈值的 running row 必须计为 0。

`last_activity_at` 明确不能参与判活。Lead 在 2026-09-18 05:00Z 对 `teamlead.db` 的 11 具在跑体实测：两种载体的 `heartbeat_at` 年龄全部为 0 分钟，包括两个持续 1 小时 36 分的 goal turn；同一批 `last_activity_at` 年龄却为 99–275 分钟。它实际接近 stage 更新时间（FLY-2297），若用它会把健康体大量误判为停止。

SQLite `heartbeat_at`/`started_at` 通常是 `YYYY-MM-DD HH:MM:SS`，页面 `generatedAt` 是 RFC3339；二者不能直接按 TEXT 比较。freshness SQL 必须用 `julianday(column)` 与 `julianday(?) - (? / 1440.0)` 统一时间尺度，测试 fixture 也使用数据库实际的空格格式。

## workflow 节点真相

`workflow_run.status = active` 只说明整条工作流未终止；它可能正等 gate。`workflow_run_node.state = running` 也可能因异常退出而残留。因此 workflow 判活必须同时满足：

1. run 为 `active`；
2. current attempt 为 `running`；
3. attempt 绑定的 session 为 `running` 且 heartbeat 新鲜。

`pending`、`admitted`、`review` 和 held run 都不能显示“在跑”。

## 展示分类

Linear terminal (`completed` / `canceled`) 仍按原规则收进 terminal tail。其它 item 先看机器判活：

1. `machine_running_count > 0`，或 active run + running attempt + fresh bound session → `live`。该规则覆盖所有 non-terminal Linear 状态；若 Linear blockers 仍未完成，卡片继续显示 blockers，不能因 live 而隐去矛盾。
2. Linear `started` 且零活机器按“显式正证”分类：
   - current attempt `pending`/`admitted` 以非空的 `workflow_run_node.started_at` 为唯一启动 freshness anchor。宽限只取既有 `stuckThresholdMinutes`（默认 15），阈值内 → `evidence_gap`（“刚起跑·等第一次心跳·说不准”），过期 → `stopped_stuck`（“起跑后无心跳”）；生产 pending session 的三个时间戳均可为 null，不能继承旧 completed 语义；这些 anchor 只判断“正在启动”，绝不参与 running liveness；
   - 最近 session 为 `completed`/`ship_parked`/`awaiting_review`/`design_done`/`approved_to_ship`/`approved`，或 current attempt 为 `review` → `stopped_acceptance`；
   - 账面 session/node 为 running，但 heartbeat stale/null → `evidence_gap`；卡片进一步显示“心跳过期·说不准”或“心跳缺失·说不准”，不声称已经停着或卡住；timestamp-less pending 也进入该证据不足类；
   - `failed`/`blocked`/`timeout`/`terminated`/`canceled`/`cancelled`/`rejected`/`deferred`/`shelved`、held/blocked/runner-stopped 信号、未知状态、无 session/run 记录 → `stopped_stuck`。
3. 非 started 且无活机器的 backlog/unstarted/triage dependency 分类保持不变。

这样“Linear = In Progress”只决定它属于 stopped 分支，不再能直接产生 live。Linear 名称继续由 `.st-linear` 原样显示。

## 计数与数据合同

当前 `RootCounts` 是互斥 item 分类之和。为了不把 stopped 子单偷塞进“未开始”，应在同一合同中加入：

- `stopped_acceptance`；
- `stopped_stuck`。

另加 `evidence_gap`，它不是 stopped；单独计数，避免把“证据不足”伪装成反方向的确定结论。

计数行仍在原位置，显示为：

`N 在跑 · S 停着 · E 说不准 · M 未开始 · 共 T`

其中 `N` 只来自 fresh machine-active item，`S` 是两种 stopped 之和，`E` 是单列的 `evidence_gap`，`M` 保留 waiting/free/idle 的现有合计。每张 stopped 卡分别显示“停着·等验收”或“停着·卡住”；超过启动宽限仍无首次心跳时必须显示“起跑后无心跳”。说不准卡只承载有界启动宽限或账面 running 的 stale/null heartbeat，并写清“等第一次心跳”或“心跳过期/缺失，需核实”。全是 stopped/evidence-gap child 的 Epic 仍必须展示，绝不能进入“全做完”的隐藏计数。

FLY-2514 曾出现 Codex 长 goal turn 期间 heartbeat 不刷新、健康体约每 25 分钟被判 `monitoring_lost`。因此 stale heartbeat 必须 fail closed 为“证据不足”，而非反向断言“没人工作/卡住”；这样即使该症状复发，页面也不会把不确定性伪装成事实。

计数 provenance 必须增加 session/run/attempt/signal-source 路径，避免新结果仍声称只由 Linear state 与 blockers 推出。

## FLY-2639 复用结论

`d9db7310a75d01d406765d2b1a858e29533efbaa` 已提供 `discordLinkPair()` / `renderDiscordLinkPair()`：

- app: `discord://-/channels/{guild}/{channel-or-thread}`；
- web: `https://discord.com/channels/{guild}/{channel-or-thread}`；
- 静态主链保留 HTTPS（移动端 universal link / no-script 安全）；
- 已知桌面浏览器通过同一个 nonce script 渐进升级到 app scheme；
- 相邻“网页版”链接始终保留。

缺口不在 renderer，而在三处 ID→URL 构造仍手拼字符串。应在 `discord-link.ts` 增加一个 canonical guild/thread helper，返回上述 pair；`attention-sources.ts`、`attention.ts`、`attention-presentation.ts` 都从该 helper 取同一个 web 值，所有可见表面继续由 `renderDiscordLinkPair()` 生成 app/web 双写。

`latest` session 排序必须让 status=pending 的无时间戳新行优先于旧 completed 行；否则 design→implement / implement→qa 交接会被误说成“等验收”。无时间戳 pending 被选中后归 `evidence_gap`，而不是借旧完成态安慰性补猜。

## 测试影响面

- 规则与 root counts：`rules.test.ts`、`scope-v2.test.ts`、model recomputation fixtures。
- founder 可见 HTML：`founder-render.test.ts`，新增 started+零活/有活两组 fixture 与计数断言。
- StateStore 投影：`statestore-epic-page.test.ts` 证明 `running` 与 parked 状态分开计数。
- Discord：helper 单测，加 attention source/derived/presentation 三路径等值断言；保留 FLY-2639 的设备矩阵。
- 变异证明：在 scratch copy 将 machine 判活短路回 `state.type === 'started'`，started+零活测试必须红。

## 生产证据边界

实现节点不部署、不重启 Bridge。生产数据取证只能通过受管 snapshot 工具读取现有 `teamlead.db`，再用本分支代码离线生成/提取 FLY-2598 的 HTML 片段；不得 `cp` live DB。PR 证据会明确区分“当前生产账本数据 + 本分支 renderer 离线重放”和“尚未部署的托管页”。
