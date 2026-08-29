# FLY-1253 审查等待 park 重试 — 探索
Issue: FLY-1253 (https://linear.app/geoforge3d/issue/FLY-1253/fix-flywheel-land-30min-硬杀-改-park定期重试审查等待不该被切)
日期: 2026-07-14
基于: 无

## Problem

`flywheel-land` v0.3.0 把两种不同时间都写成 30 分钟 terminal timeout：

- CI 自身 30 分钟无进展；
- 已提交审查或 gate 后，等待外部 verdict/response。

FLY-1225 第一轮 implement 实撞了第二条：PR #587 在 16:05 UTC 进入
`pr_created` / `code_review`，约 33 分钟后 execution 以
`decision.route=blocked`、`Landing failed: unknown` 收尾。代码和 PR 仍在，但原
runner context 没有继续；后续 execution 只能重读分支再发起 review。

关键区别是：

- **active time**：runner 仍在分析、写代码或跑命令；现有 active timeout 应继续
  生效；
- **external wait time**：存在当前 execution 所有、未答、未过期的 checkpointed
  gate；等待 Lead/reviewer/founder 不代表 runner 失控；
- **unbound review wait**：只有 GitHub `reviewDecision` pending，或模型声称在等，
  却没有绑定 question id；它没有 Flywheel checkpoint 证据，不能获得本单的长期
  wait exemption。

FLY-1135 的 DAG 节点仍会复用 review/gate contract；task#139 缺陷⑦也记录了同一
等待被错误终止问题。因此本单要把“可证明的外部等待”变成明确状态：bounded
park、低频 `check`、response 后继续同一个运行上下文。

## Evidence

### FLY-1225 Runtime

- StateStore session `1515a3d5-53de-40bf-b616-0f897d59d64e` 的
  `adapter_type=codex-tmux`、model=`gpt-5.6-sol`、role=`implement`。
- 15:49:54 started；16:04:53 创建 PR #587；16:05:18 进入 code review；
  16:38:17 blocked。
- branch 上已有实现 commit `c71a8cbde`，CI 后来也 green；终止发生在
  review/landing wait，而不是实现阶段。
- 第一轮 review jobs 没形成可交付 verdict；后续 execution 重新发 review 后才得到
  APPROVED。文件可恢复不等于原 context 没有丢。

### Reachability Audit

`packages/claude-runner/src/ClaudeCodeAdapter.ts` 中确有
`DEFAULT_TIMEOUT_MS = 30m`，并直接传给 `execFile({ timeout })`，但它**不是
FLY-1225 的终止者，也不在当前 production dispatch path 上**：

- `run-infra.ts` 只注册 `claude-tmux`、`codex-tmux`、`antigravity-tmux`、
  `kimi-tmux`；default 为 `claude-tmux`；
- `ExecutorBackend` 是上述四值闭集，没有 bare `"claude"`；
- direct `ClaudeCodeAdapter.type="claude"` 没有 production instantiation；
- Blueprint 当前给 production adapter 的 active timeout 默认是 24h；
- FLY-1225 明确运行在 `codex-tmux`。

因此因果必须拆开：

1. **PR-B / flywheel-skills 是当前事故真修**：删除 bound review/gate wait 的
   terminal 30m policy，改为 park/retry；
2. **PR-A / direct ClaudeCodeAdapter 是 founder 指定的 dormant future hardening**：
   为未来 DAG/standalone direct path 补同样的 checkpoint-aware lifetime contract；
   FLY-1253 不注册、不接线、不声称它修复了 FLY-1225。

Lead 在看到 reachability 证据后明确批准这一修正，并撤销此前基于“adapter 直杀”
假设的 A→B rollout 顺序。

### Existing Runtime Support

- `TmuxAdapter` 已在 poll loop 中保持 heartbeat，并把 pending CommDB wait 从 active
  elapsed 中扣除；每段 wait 有 49h cap。
- `CodexTmuxAdapter` 用 question-bound gate marker 驱动 goal deadline extension，
  heartbeat timer 独立运行。
- `flywheel-comm park --until 10m` 写 bounded lease；`unpark` 或 lease expiry 清除
  intentional-quiet 状态，不需要新 schema。
- 两个 production adapter 都能承受 runner 在 pane/goal 内执行 5m `sleep` +
  `check`；但必须用实际 claude-tmux/codex-tmux smoke 证明，而不是用 dormant adapter
  fake test代替 production acceptance。

## Requirements

### Must

1. bound checkpointed review/gate wait 超过 30 分钟时不再写 terminal
   `review_timeout`；land signal 保持 `pending`。
2. runner 以 10m bounded park lease 声明 intentional quiet，每 5m 续 lease并
   `check "$QUESTION_ID"`。
3. verdict/response/timeout 到达后先 `unpark`，再在同一 execution/pane/thread 中
   继续。
4. 只有已捕获的 exact question id，或通过
   `pending --lead "$FLYWHEEL_LEAD_ID" --json` 对当前 execution 唯一恢复出的
   checkpoint question id 才适用；checkpoint-less ask、
   GitHub-only unbound/ambiguous review、普通 active work 不适用。
5. CI 30m no-progress、max fix attempts、merge conflict 等原 terminal 语义不变。
6. production acceptance 必须覆盖 claude-tmux 与 codex-tmux；dormant direct adapter
   的 fake-clock test 只证明未来兼容，不充当事故验收。
7. direct adapter hardening 必须保持单 child，并采用累计 active budget + per-wait
   cap + absolute outer cap；gate 关闭不能刷新无限 active lifetime。

### Preserve

- gate TTL、timeout behavior、question/head binding、approve authority；
- `land-status.json` 只在真实 ready/failure 时 terminal；
- live `TmuxAdapter` 目前使用 broad `hasPendingQuestionsFrom` 的 legacy 语义。本单
  不趁机收窄 production timeout contract；direct adapter 新增的 exemption 则只用
  `hasPendingBlockingGateFrom`。两者差异必须记录，不伪装成全局统一；
- Claude reviewer 主动分析一轮的 30m safety cap；
- model allocation：Design/Implement 为 Codex `gpt-5.6-sol` xhigh，Design 继续由
  `FLYWHEEL_THREE_STAGE_CODEX_DESIGN` 选择，QA 为 Claude Opus。

## Options

### Option A — 全局把 30 分钟调大

无法区分 active 与 wait，也没有 bound question 证据。**否决。**

### Option B — 只发布 flywheel-land v0.4.0

这是修复 FLY-1225 当前 production incident 的最小完整方案；live tmux adapters
已有 wait-aware lifetime。缺点是 founder 明确要求的 direct adapter / future DAG
兼容仍未交付。**作为 current-incident fix 成立，但不覆盖完整 issue delivery。**

### Option C — 独立 PR-B 真修 + 正交 PR-A future hardening（采用）

- PR-B 先做/可独立发布：bound gate wait → park/retry；
- PR-A 单独交付：dormant direct adapter 增加 wait-aware supervisor 与 env parity；
- 两者没有 rollout dependency；PR-A 不增加 registry entry；
- QA 分别证明 production behavior 和 dormant future contract。

这既尊重 founder 的两项交付，又不把 dead code 误写成事故 prerequisite。

## Design Direction

### Production Skill State Machine

```text
ACTIVE / CI_POLL
  ├─ CI no progress 30m ----------------------> FAILED(ci_timeout)
  ├─ review wait 30m + no bound question ----> FAILED(review_wait_unbound)
  └─ review wait 30m + bound open question --> PARKED_WAIT

PARKED_WAIT
  ├─ five bounded 60s sleeps --> check response + revalidate open pending row
  ├─ qid still open ----------> renew 10m lease + retry
  ├─ response/verdict --------> unpark --> ACTIVE in same runner
  ├─ qid expired/disappears --> unpark --> FAILED(review_gate_expired)
  ├─ sleep/CommDB poll errors --> unpark --> FAILED(review_wait_poll_error)
  └─ runner crash ------------> lease expires in <=10m
```

`QUESTION_ID` 优先来自此前 checkpoint `gate --no-block` 返回的 JSON。若
shell/context 没有
保留它，skill 可调用 `pending --lead "$FLYWHEEL_LEAD_ID" --json`，只接受
`from_agent==$FLYWHEEL_EXEC_ID && checkpoint!=null` 的**唯一** open row；零个或多个
都 fail-closed。skill 不猜“最近一个” gate，不把 GitHub-only review 冒充 Flywheel
checkpoint。

`check` 只识别 response，不识别 bare expiry。Codex gate-marker watcher会写 synthetic
timeout response；claude-tmux 没有该 watcher。因此每轮 `check` 仍 pending 后必须再次
读取 expiry-aware pending JSON，确认同一 qid 仍 open；若消失，先 race-safe 再
`check` 一次捕获并发 response，仍 pending才写明确 `review_gate_expired`。不能继续
续租或留下 pending signal。

只有成功、可解析的 pending JSON 才能证明 qid present/absent；`check`/`pending`
非零或不可解析不是 expiry，统一 unpark 并写 `review_wait_poll_error`。qid仍 open时
必须重新执行同一 park命令并明确回到五段 sleep的第一段，形成真正周期。

### Dormant Direct Adapter State Machine

```text
ACTIVE
  ├─ child exits ------------------------------> DONE
  ├─ cumulative active budget exhausted
  │    + no pending blocking gate ------------> TIMEOUT
  │    + pending blocking gate ----------------> WAITING

WAITING
  ├─ same gate still pending ------------------> retry probe later
  ├─ gate closes ------------------------------> ACTIVE (remaining budget)
  ├─ one wait exceeds waiting cap -------------> TIMEOUT
  └─ absolute outer cap exceeded --------------> TIMEOUT
```

direct supervisor 只调用 `hasPendingBlockingGateFrom(executionId)`。probe error/no DB
fail-closed 到普通 timeout；不 respawn、不用 `--resume` 伪造 context continuity。

### Compatibility Matrix

| PR-A direct adapter | PR-B skill | 当前 production 结果 | 结论 |
|---|---|---|---|
| A0 | B0 | bound review 30m terminal stop | baseline |
| A1 | B0 | 当前 production 无变化；future direct path 具备保护 | safe, dormant |
| A0 | B1 | FLY-1225 真修；live tmux adapters 承接 park/retry | safe, current target |
| A1 | B1 | 当前事故已修 + future direct contract 已备齐 | full issue delivery |

PR-B 可独立发布/回滚。PR-A 仅在未来 direct adapter 被正式注册后才有 runtime
rollout/rollback 含义。

## Non-goals

- 不给 direct adapter 新增 production registration/backend selector；
- 不修改 `TmuxAdapter` broad wait predicate 或 Codex gate-marker protocol；
- 不把 GitHub-only pending review 转成 checkpoint；
- 不修改 `claude-review-runner.ts` 的 active review 30m cap；
- 不创建 PR、实现代码或发布 skill（当前 session 只交设计）。

## Approved Boundary

Lead 最终确认：FLY-1225 是 `codex-tmux + flywheel-land` policy stop；PR-B 为事故真修；
PR-A 保留为 dormant future hardening，FLY-1253 内不注册、不接线；旧 A→B 顺序撤销，
两项正交交付。此边界作为 research/plan 与后续实现 review 的权威 scope。
