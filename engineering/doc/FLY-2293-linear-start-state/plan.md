# FLY-2293 派发同步 Linear 开工态 — 实施计划
Issue: FLY-2293 (https://linear.app/geoforge3d/issue/FLY-2293/状态可信度-派发不可靠地置-in-progress11-个在跑-runner-里-6-张单仍是-backlogstartedatnull-按)
日期: 2026-09-04
基于: research.md

## 目标与完成定义

当生产 `DirectEventSink` 接受 `session_started` 并把 session 持久化为 running 后，仍处于 backlog/unstarted 的同一个 issue 被推进到其 Linear team 的首个 `type=started` workflow state；写后可读状态为 started，且 `startedAt` 非 null。自动化不得覆盖 founder 已置的 canceled，不得把 completed 或更靠后的 started 状态降级，也不得把尚未 triage 的 issue 自动推进。

同一实现必须覆盖 `implement/codex-tmux` 与 `design/claude-tmux`，不得按 adapter/role 复制逻辑。测试的初始 issue 必须是 Backlog、`startedAt=null`。

## 锁定范围

修改：

- `packages/teamlead/src/bridge/linear-issue-starter.ts`：最小 Linear started transition 与 SDK factory。
- `packages/teamlead/src/DirectEventSink.ts`：running row 落盘、现有 thread/通知完成后在调用点创建并执行 transition。
- `packages/teamlead/src/bridge/__tests__/linear-issue-starter.test.ts`：Backlog 正例、幂等与失败护栏。
- `packages/teamlead/src/__tests__/DirectEventSink.test.ts`：两条题述 role/adapter 路径。
- `scripts/test-deploy.sh` 与 `scripts/__tests__/test-deploy-generalized.test.sh`：所有 slot/QA Bridge 显式关闭 Linear started 写入，同时保留 Linear key 给只读 PreHydrator。
- 本文件夹进度文档与最终 `engineering/doc/milestones/FLY-2293.md`。

不修改：

- 不改 approved plan 以外的 dispatch/admission/worktree/triage 行为。
- 不增加依赖、数据库 schema、后台重试队列、feature flag 或 adapter 分支。
- 不动 `CLAUDE.md`，不处理 completed/canceled 收尾与僵尸 session。
- 不自动修复题述 6 张已漂移存量单；本 PR 只堵住后续派发入口，存量在 founder 确认后由 Lead 通过手动 `update-issue` proxy 收口。

## 行为设计

### 1. Linear started transition

实现 `markLinearIssueStarted(client, issueId)`：

1. 读取 issue、当前 state、`startedAt`；state 不可读则 fail closed、零写。
2. 首先检查 state type：`triage` → 零写并返回 `skipped_triage`；`canceled` 或 `completed` → 零写并返回 `skipped_terminal`；`started` → 零写（判据仅为 `state.type === "started"`），若 `startedAt=null` 则返回可观测失败，绝不通过重写最低-position started state 来降级。re-dispatch 不会静默重开 Done、覆盖 founder 的 Cancel，或越过 triage。
3. 读取 team states；过滤 `type=started`，按 position 升序取第一项。
4. 无 team/started state → `{started:false, reason}`。
5. 写前第二次 fresh read，再按第 2 步先处理 triage/canceled/completed/started；state 不可读或与首读不同也零写，只有同一 backlog/unstarted state 可继续。
6. `updateIssue(issueId, {stateId})` 后重新读取；只有 `state.type=started && startedAt!=null` 才返回成功。
7. 所有 SDK 异常转换成带稳定 `errorClass` 的 `{started:false, reason}`；不伪报成功。所有 await 前后检查同一个 `AbortSignal`，abort 后不得继续到 mutation。

`makeLinearIssueStarter(config)` 读取 default-ON kill switch：仅当 `process.env.FLYWHEEL_LINEAR_STARTED_SYNC !== "0"` 且存在 `linearApiKey` 时返回 closure；kill switch 为 `0` 或无 key 时都返回 undefined。有 key 时复用已安装的 `@linear/sdk` 动态 import，并输出带 issue 标识的成功/warning 日志。

`scripts/test-deploy.sh` 在三条 Bridge 启动分支各只向现有 `BRIDGE_EXTRA_ENV` 追加一行 `FLYWHEEL_LINEAR_STARTED_SYNC=0`。这样 slot/QA Bridge 继续把 Linear key 提供给只读 PreHydrator，却不会改写生产 Linear。该 env block 与 FLY-2284 有文件重叠，PR body 必须显式注明。

### 2. 生产接线

`DirectEventSink.emitStarted()` 在调用点执行 `makeLinearIssueStarter(this.config)`，镜像同文件 `makeLinearDoneFinalizer(this.config)` 的既有形状，不增加第 9 个构造参数或新的 public 依赖字段。running row 持久化后，其余现有 tail 放入 `try`；`finally` 先执行 `pushNotification`，再执行唯一一次 started transition，因此 post-upsert 的任何较早 throw 仍会尝试同步。关键顺序：

```text
insert session_started event
→ upsert session(status=running)
→ try: proofshot/thread/display
→ finally: Lead notification
→ finally: markIssueStarted(issueId, issueIdentifier)
```

调用置于 `pushNotification` 之后，Linear 慢请求不会消耗 thread 创建的 5 秒轮询预算。调用点使用与 `raceMarkIssueDoneWithAbort` 相同的 controller/timer/`Promise.race` 形状，15 秒先 abort 再返回 timeout 结果；不新建另一套 helper family。

Linear 外部失败不撤销已经持久化的 session，也不阻断 adapter。每次实际调用 starter 都只写一条 `linear_issue_start_outcome` session event，payload 为 `{issueId, executionId, outcome, errorClass?}`；`outcome` 仅为 `started | skipped_terminal | skipped_triage | failed`。零写分支的 reason 由 transition result 保留并映射到 outcome event；本路径绝不写 `linear_state_observations`，也绝不调用 `observeLinearStateAndClaimCloseout`。

验收 SQL 分成两把尺子：有 `session_started` 但没有 `linear_issue_start_outcome` 的 execution 表示从未尝试；`outcome=failed` 表示尝试过但失败。因为这个 sink 是所有 generalized start/retry/phase 的共同生产入口，两条失败样本路径无需单独分支。

## TDD 顺序

1. **RED — helper**：新建测试，fake issue 初始 Backlog/null；要求最低 position started state 被写入，随后读到 started + non-null timestamp。先运行并确认因模块/行为缺失而失败。
2. **GREEN — helper**：写最小 transition；跑 helper 测试转绿。
3. **RED — kill switch**：断言 factory 在默认/任意非 `0` 值下启用、在 `0` 下关闭；静态脚本测试要求三条 Bridge 分支都通过 `BRIDGE_EXTRA_ENV` 收到关闭值。先确认 factory/script 尚未支持而失败。
4. **GREEN — kill switch**：实现 factory guard，并在 `test-deploy.sh` 每条分支只追加一行；跑 helper 与脚本测试转绿。
5. **RED — wiring**：参数化 `implement/codex-tmux`、`design/claude-tmux`；用 `makeConfig({linearApiKey:"k"})` 构造 sink、不注入 starter，stub `@linear/sdk` 动态 import，并在 SDK 调用时断言 StateStore row 已 running。另断言 started/skip/failure 各留下唯一 outcome event，且 post-upsert tail throw 仍调用一次。先确认未接线时失败。
6. **GREEN — wiring**：以 finally tail 接入一次；跑两组测试转绿。
7. **REFACTOR**：删除重复/无用分支，仅保留共享函数；`git diff --check`、lint/typecheck。

## 测试矩阵

| Case | 初态 | 期望 |
|---|---|---|
| H1 backlog happy path | type=backlog, startedAt=null | 写最低-position started state；确认 startedAt 非 null |
| H2 multiple started | backlog/null | 选 position 最小，不靠名称 |
| H3 unstarted happy path | type=unstarted, startedAt=null | 与 backlog 同样推进到最低-position started state |
| N1 already started | started + timestamp | 零 `updateIssue` |
| N2 started timestamp missing | started/null | started=false，零写且不降级 |
| N3 triage | triage/null | 零写，outcome=skipped_triage |
| N4 canceled | canceled | 零写，outcome=skipped_terminal |
| N5 completed | completed | 零写，outcome=skipped_terminal，不静默重开 |
| N6 no team / no started state | backlog/null | started=false，零写 |
| N7 write/read failure | backlog/null | started=false，不 throw |
| N8 write not effective | 写后仍 backlog/null | started=false，不伪绿 |
| N9 midflight state change | backlog/null → 任意其他 state | started=false，零写 |
| F1 factory | no key / key / kill switch 0 | 无 key或值为 0时 undefined；默认且有 key 时为 function |
| W0 default production wiring | config 有 key、无注入 | stub SDK 收到 transition，证明调用点 factory 生效 |
| W1 implement/codex | backlog/null + running sink envelope | SDK transition 一次，且调用时 row 已 running |
| W2 design/claude | backlog/null + running sink envelope | 与 W1 同一默认路径，无角色分支 |
| W3 transition outcomes | started/terminal/triage/failure | 每次尝试恰好一条 `linear_issue_start_outcome`，payload 无 reason 文本 |
| W4 transition failure/timeout | running sink envelope | adapter 不失败；outcome=failed + 稳定 errorClass |
| W5 post-upsert tail throw | running row + later helper throws | finally 仍先走通知，再且仅调用一次 starter |
| S1 test slot isolation | 三条 Bridge 启动分支 | `FLYWHEEL_LINEAR_STARTED_SYNC=0`，Linear key 仍供只读 hydration |

## 验证命令

遵守 Lead 的单 package / 单线程约束，不运行 packages-wide 测试，也不触碰 macOS tmux viewer：

```bash
VITEST_MAX_THREADS=1 VITEST_MIN_THREADS=1 pnpm --filter flywheel-teamlead exec vitest run \
  --pool=forks \
  --poolOptions.forks.maxForks=1 \
  --poolOptions.forks.minForks=1 \
  src/bridge/__tests__/linear-issue-starter.test.ts \
  src/__tests__/DirectEventSink.test.ts
bash scripts/__tests__/test-deploy-generalized.test.sh
pnpm --filter flywheel-teamlead typecheck
pnpm --filter flywheel-teamlead build
pnpm lint
```

代码 review 前核对：工作树干净、PR head 与本地 HEAD 一致、新测试真以 backlog/null 为前置、无 role/backend 条件分支、无新增依赖；任何隔离/QA/slot Bridge 都显式令 `FLYWHEEL_LINEAR_STARTED_SYNC=0`，并保留 Linear key 只做 hydration。PR body 标出与 FLY-2284 在 `test-deploy.sh` env block 的重叠。候选 head push 后，必须确认 GitHub CI 对这个 exact head 全绿，才可设置 `code_review` 并提交 `request-review`。

下游 QA 节点只验证：(i) 两个聚焦测试文件，(ii) factory/default-wiring/outcome/finally 用例，(iii) test-slot kill switch，(iv) read-only grep 以 `run-infra.ts` 的 `new DirectEventSink(` symbol 为锚，并确认紧随的构造参数包含 `config`。QA 不使用漂移的行号锚点，也不在 slot/隔离 Bridge 上写真实 Linear。真实 Linear 确认由 Lead 在 updater 部署后的第一次生产派发上执行：从 Linear 回读该单 `state.type=started` 且 `startedAt!=null`。

## 提交与评审

1. 设计文档提交并绑定 design review；获 APPROVED 前不写实现。
2. PR 尽早以 base `main` 打开，body 含 Linear 链接与 Test plan。
3. 实现按 RED/ GREEN 小提交推进，并在 meaningful batch 后更新 ledger。
4. 最终验证、候选 head push、并确认该 exact head 的 GitHub CI 全绿后，设置 `code_review`，通过 `codex:rescue`/注入 review gate 请求跨模型代码审查；评审运行时冻结 head。
5. blocking finding 修复后只做一次 batch push，开新 review request。
6. APPROVED 后不再运行 progress（避免移动 head）；`engineering/doc/milestones/FLY-2293.md` 必须在最终 review 前作为 literal last commit。
7. 完成后仅运行 `complete --route needs_review --pr <NUMBER>`；不 dispatch QA、不 merge、不 deploy。
