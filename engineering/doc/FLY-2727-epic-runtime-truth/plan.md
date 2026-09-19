# FLY-2727 Epic 页运行态可信 — 实施计划
Issue: FLY-2727 (https://linear.app/geoforge3d/issue/FLY-2727/epic-页可信-在跑不许照抄-linear-started按机器会话真相判活linear-状态单独显示-discord-链接改)
日期: 2026-09-17
基于: research.md

## 锁定范围

只修改 Epic page 的执行态分类、对应计数/文案/审计来源，以及三处 Discord thread URL 构造。保留 Linear 状态栏、页面布局、lead-note、刷新/托管/发布、FLY-2720 投递节奏和 Linear 写回不变。

TDD 公共接缝已经由用户硬红验收锁定：Epic HTML 可见输出，以及 shared Discord link helper/attention 三路径输出。

## 实施步骤

### Slice 1：started + 零机器运行必须停止冒充 live

1. 在 founder render/rules 测试先加入红侧 fixture：Linear `In Progress`、session `running_count = 0`、无 running workflow node。
2. 断言 badge 为“停着·卡住”、完整 `kid-a` 为“没有机器在动·卡住”，整张卡不含“在跑”或“还没起跑”，Linear `In Progress` 仍单独存在。
3. 最小实现 machine-active helper，并把 `started => live` 替换成“机器活跃才 live；started 且非活跃进入 stopped”。

### Slice 2：正常完成但未验收与真实 running 分开

1. 先加最近 session `completed` 的 started fixture，断言 badge“停着·等验收”与完整进度行“没有机器在动·等验收”。
2. 再加 fresh-heartbeat session `running` 与 active workflow node + running attempt + fresh bound session 两个正向 fixture，断言“在跑”。
3. 加 `status=running` + heartbeat 明确超过 `stuckThresholdMinutes` 与 heartbeat null 两个硬反例，必须不为“在跑”或“停着”，并分别显示“心跳过期·说不准”与“心跳缺失·说不准”，进入独立 evidence-gap 计数。
4. 加生产形状防回归 fixture：heartbeat 新鲜 + `last_activity_at` 4 小时前仍必须为“在跑”，证明判活完全不依赖 `last_activity_at`。
5. 以穷举表驱动其余 fixture：
   - current attempt `pending`/`admitted` 只以非空的 `workflow_run_node.started_at` 为 freshness anchor：`stuckThresholdMinutes` 宽限内 → `evidence_gap`（“刚起跑·等第一次心跳·说不准”），宽限外 → `stopped_stuck`（“起跑后无心跳”）；fixture 分别使用阈值内/外时间，不引入 2 分钟或 3 小时新常量。timestamp-less pending session 不得读取旧 completed session 后误显“等验收”；
   - `completed`、`ship_parked`、`awaiting_review`、`design_done`、`approved_to_ship`、`approved`，或 current attempt `review` → `stopped_acceptance`；
   - `failed`、`blocked`、`timeout`、`terminated`、`canceled`、`cancelled`、`rejected`、`deferred`、`shelved`、unknown、无 session/run、held/blocked/runner-stopped → `stopped_stuck`。
6. `ProgressLine`、`progress()`、`progressText()` 必须显式覆盖两种 stopped kind 与独立 `evidence_gap`，并保留 heartbeat stale/null/awaiting-first-heartbeat 原因；禁止合法 `idle` fall-through。

### Slice 3：StateStore 提供精确 running 聚合

1. 在 `statestore-epic-page.test.ts` 先用数据库实际的 `YYYY-MM-DD HH:MM:SS` 格式断言同 issue 的 fresh `running`、超过 `stuckThresholdMinutes` 的 stale `running`、null-heartbeat `running` 与 `awaiting_review` / `design_done` / `ship_parked` 分开计数；另加 fresh heartbeat + 4 小时前 `last_activity_at` 仍 machine-live。
2. 把页面生成时间与现有 Bridge `stuckThresholdMinutes`（默认 15）作为必填参数传入既有事实读取链。在 `getEpicPageSessionFact()` 增加 `machine_running_count`：只计 `status='running'` 且 heartbeat 非空/新鲜；同时输出 stale/null running heartbeat 证据，保留 `ledger_live_count` 不变。所有 cutoff 用 `julianday(column) >= julianday(?) - (? / 1440.0)` 正规化 SQLite/RFC3339 格式，禁止直接 TEXT 比较。`last_activity_at` 只可用于既有“最近记录”排序/审计，严禁参与 liveness predicate；latest 排序显式优先 pending，避免 timestamp-less pending 被旧 completed 遮住。
3. `getEpicPageAttemptFact()` 通过 attempt.execution_id 关联同一 session heartbeat，输出 current node 的 `machine_live` 与 heartbeat fresh/stale/missing 证据；裸 `workflow_run_node.state='running'` 不构成活证据。
4. freshness 参数保持非 optional，并显式接通三个生产调用点：`bridge/epic-residual-scan.ts`、`bridge/plugin.ts`、`bridge/epic-page-route.ts`；增加 wiring test/类型覆盖，漏接必须编译失败。
5. 更新 model 类型、测试 fixture 和审计摘要；不创建表、不迁移 schema。

### Slice 4：计数与排序使用机器真相

1. 先加 Epic fixture：一个 fresh running、一个 completed-waiting-acceptance、一个 stuck、一个 stale-heartbeat evidence gap、一个宽限内 admitted evidence gap、一个 unstarted。
2. 断言计数行为 `1 在跑 · 2 停着 · 2 说不准 · 1 未开始 · 共 6`，且 root count provenance 包含 session/run/attempt/signal source。
3. 给 `RootCounts` 增加两种 stopped 互斥分类和独立 `evidence_gap`，更新 recomputation/schema guard、排序与 `allWaitingOn`/隐藏规则。全是 stopped/evidence-gap child 的 Epic 必须保留且 hidden-done count 不增加。
4. machine-active 可覆盖任何 non-terminal Linear state；blocked-but-running fixture 仍显示“在跑”与完整 blocker 文案，不能吞掉 blocker。
5. 增加 `child.*` / `progress.*` 文案与视觉样式（starting/acceptance 为中性，evidence gap 为证据警示，stuck 为故障警示），保持 DOM 区块与 lead-note 不变；render test 断言 class/CSS。
6. 把“状态照抄 Linear”改成明确双事实文案：“Linear 状态单列；在跑按机器会话”，避免新 badge 与页内说明互相矛盾。

### Slice 5：Discord 三处统一 helper

1. 先给 shared helper 写字面量红测，要求 app=`discord://-/channels/123/456`、web=`https://discord.com/channels/123/456`，并拒绝非法 ID。
2. 在 `discord-link.ts` 增加 canonical guild/thread pair helper，复用 FLY-2639 的 `discordLinkPair()`。
3. `attention-sources.ts`、`attention.ts`、`attention-presentation.ts` 全部从该 helper 取同一个 canonical web fallback；可见 HTML 继续通过 `renderDiscordLinkPair()` 输出 app/web 双链。
4. 加三路径一致性单测并保留 FLY-2639 设备矩阵。

### Slice 6：变异、当前账本重放与视觉证据

1. 在 scratch package copy 中只把 machine 判活短路回 `state.type === "started"`，运行 started+零活用例，保存必红的原始命令输出；原工作树保持干净，并把原始失败输出贴入 PR body。
2. 用 `scripts/flywheel-snapshot-control.mjs runner` 创建受管生产 StateStore snapshot，读取 FLY-2598 当前 session/workflow facts。若 helper 仍以 `snapshot_helper_missing` 结构性失败，立即停止重试，不复制 live DB、不另造快照；改用可只读取得的真实 facts 构造 fixture，并在 DONE 单列生产离线重放缺口（相邻病根 FLY-2705）。
3. 用当前 Linear scope + snapshot facts（或上一步允许的真实只读 facts fixture）和本分支 renderer 离线生成固定页，保存 FLY-2598 卡片 HTML 片段与三项对账：页面 `在跑` 数、fresh-heartbeat running session 数、current-node machine_live 数。
4. 对生成 HTML 运行既有 self-check；如本机浏览器工具可用，渲染截图并人工检查 badge、Linear 状态与计数行。证据明确标注“生产账本离线重放，未部署”。

## 验证矩阵

- Focused：Epic rules、founder view/render、StateStore Epic facts、attention/Discord helper。
- Mutation：started→live 回退必须让零活 fixture 失败。
- Render：HTML self-check + FLY-2598 片段/可用时截图。
- Aggregate：`pnpm lint`、`pnpm -r build`、`pnpm test:packages:run`、新增/相关 `scripts/__tests__/*.test.sh`（若本单没有新增 shell test，记录为无新增）。
- Exact-head：push 后 PR CI 必须绑定最终 head。
- Review：通过注入的 `review_code` gate + `request-review --type code` 获取 effective `APPROVED`；CHANGES 必须修复并以新 head 重开 review。

## 交付顺序

1. 完成红→绿 vertical slices，小提交并更新 `progress.md`。
2. 运行 focused、mutation、render、aggregate verification。
3. 创建 `engineering/doc/milestones/FLY-2727.md`，确保其为 PR literal-last commit；不改 `CLAUDE.md`。
4. push feature branch，开 PR；PR body 写明沿用 FLY-2639 / `d9db7310a`，附 FLY-2598 HTML/截图和机器账本对账。
5. 获取 effective code review 与 exact-head CI，处理所有 blocker。
6. 通过 `ask --report` 发送自包含 DONE；不派 QA、不 merge、不 deploy；最后执行注入的 `complete --route needs_review --pr <number>`。

## 回滚与失败边界

- 该改动只影响派生页面模型/渲染；回滚为撤销本 PR，无生产 migration。
- session/workflow fact 读取失败、heartbeat 缺失或超过 stuck threshold 时 fail closed：绝不显示“在跑”，展示执行事实缺失/停着，不从 Linear 或裸 ledger-open 状态补猜。
- 无法读取受管生产 snapshot 或当前 Linear scope时，focused/aggregate 仍可继续，但不得伪称完成真机/生产重放验收；通过 Lead report 明确缺口。
