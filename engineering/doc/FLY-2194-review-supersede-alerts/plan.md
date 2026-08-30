# FLY-2194 良性评审顶替通知分类 — 实施计划
Issue: FLY-2194 (https://linear.app/geoforge3d/issue/FLY-2194/病根-良性-supersede-被当-failed-推进-founder-thread设计改版顶掉在审门正常流程通知层却报job)
日期: 2026-08-30
基于: 无

> Lead 判档: `plan_only`。Founder 判据：「以后我看到 alarm 都不会去理会它，这个 alarm 不就没有用了吗」——修完后每条进入 founder thread 的 ⚠️ 都必须值得点开。

## 目标与不变量

旧 design/code review gate 被**同 execution、同 checkpoint**的新 revision gate 正常顶替时，旧 reviewer 结果仍 fail-close 丢弃，旧 `codex_review_job` 仍落 failed 内部账，但不再产生 founder-facing `review_job_failed`，Lead patrol 也不得把它翻译成失败或同-request 重试。只有 bound gate 可验证为 open 且 failure reason 可重放时，warning 才能建议用同 `requestId` 重试。

不改变：review authority、`issue-gate-supersede` newest-wins、quota retry 预算、真实 reviewer failure 的 warning route、StateStore/CommDB schema。

## failure_reason 分类矩阵

| 事实分类 | 识别证据 | 内部 job reason / 账 | founder thread | 恢复提示 |
|---|---|---|---|---|
| 良性 revision supersede | bound question 有 durable `superseded_at + superseded_by`，且 supersessor question 与旧门是**同 `from_agent`、同 checkpoint** | `failed / superseded_by_revision`；保留 counter、CommDB supersede row、既有 `review_gate_superseded` audit、coordinator log；Lead patrol 排除 | **静默，零 `review_job_failed` event** | 无；新 gate / 新 review 已是 authority path |
| foreign answer，非 supersede | response/resolved，但无 `superseded_at` | `failed / gate_answered_externally`；无 authority | 继续 ⚠️（所有权异常值得点开） | 不得重放旧 request；开新 gate + 新 request |
| expired / missing / mismatch | gate revalidation 结构证据 | 保留现有 `gate_expired` / `gate_missing` / `gate_mismatch` | 继续现有 ⚠️ | 开新 gate + 新 request |
| head/reviewed head moved | trusted head revalidation | 保留 `head_moved` / `reviewed_wrong_head` | 继续现有 ⚠️ | 新 requestId 重新冻结当前 head；**即使旧 gate open 也不重放旧 requestId** |
| quota / timeout / no verdict / reviewer nonzero exit / internal crash | reviewer outcome / coordinator failure | 保留真实 failure reason、raw 仅内部账 | 照旧 ⚠️ | 已排期则报 automatic retry；否则 gate 可验证 open 才可 same-request retry；非 open 则新 gate + 新 request |
| session/worktree 缺失 | trusted StateStore binding 缺失 | `session_missing` / `worktree_missing` | 照旧 ⚠️ | 先修复 execution/binding；之后仅在 gate 可验证 open 时重试 |
| CommDB 检查失败 | `inspectGate` 捕获异常 | `gate_unknown`（authority fail-close） | 继续 ⚠️ | 不猜 open/closed；提示先检查 CommDB/gate，再选择恢复路径 |

`gate_answered_externally` 不能整类静默：现有测试覆盖 forged runner response 与真实 foreign answer；两者无可信同-owner supersessor，必须继续 fail-loud。跨 execution 的 same-issue supersede 也不是良性 revision，继续 warning。静默条件只认 durable supersede provenance，不读自由文本、不猜 issue title。

## TDD 实施

### RED 1 — 重放 design/code 两条真实分支

在 `packages/teamlead/src/bridge/__tests__/review-request-coordinator.test.ts` 扩展 `FakeQuestion` 的 supersede 字段，用 `it.each(["design", "code"])`（issue 保持 fixture 值；这才覆盖实际分支）：

1. 以该 issue 注册 Codex session，打开旧 review gate `q1`，让 reviewer deferred 运行；
2. 打开新 revision gate `q2`，把 `q1` 原子形状设为 `resolved_at + superseded_at + superseded_by=q2`；
3. 旧 reviewer 返回 APPROVED；
4. 断言 `q1` 无 Bridge response；code case 另断言无 code-review authority；
5. 断言旧 job 为 `failed / superseded_by_revision`（内部账仍在）；
6. 断言该 request 的 `review_job_failed` structured event 数为 0（founder thread 零消息）。

先运行：

```bash
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/review-request-coordinator.test.ts
```

当前代码应 RED：reason 是 `gate_answered_externally`，且会 emit warning。

### RED 2 — provenance、redrive 与 recovery copy

- same-execution supersede：scheduled retry 和 boot redrive 都不启动 reviewer，job 改 `superseded_by_revision`、清 `retry_at`、零 structured warning；
- cross-execution supersessor：不静默，仍是 foreign/answered warning；
- open-gate timeout 保持**完整精确字符串** `Retry POST /review-requests with the same requestId`；answered/expired/missing/mismatch 保持完整精确字符串但改为 new gate + new request；CommDB throw 使用“先检查 gate”文案；
- `head_moved` 即使 gate open 也断言不得 same-request replay；session/worktree 文案先要求修 binding；
- 既有 accept-time answered 断言继续固定 `gate_answered`；failed-job replay 对 superseded gate 固定 409 `gate superseded`；
- `scripts/__tests__/lead-patrol-snapshot.test.sh` 加 `superseded_by_revision` fixture，先证明 patrol 当前错误输出 `REVIEW_JOB_FAILED ... recovery=POST_/review-requests_same_requestId`；GREEN 后断言完全不输出该 row。

再次运行同一 spec，确认 retry 文案断言按当前无条件 copy 正确 RED。

### GREEN — 最小生产改动

改动边界：coordinator + 其 spec、Lead patrol + 其 shell spec，以及清理未路由的 generic copy；不改 routing ownership。

1. `ReviewCommDb.getMessageById` 窄接口暴露 `superseded_at?: string | null`、`superseded_by?: string | null`；
2. `ReviewGateState` 增 `superseded | unknown`；`inspectGate()` 只有在 `superseded_by` 指向同 owner/checkpoint question 时返回 `superseded`，跨 execution 退回 `answered`；catch 返回 `unknown`，所有 authority decision 仍把它当非 open；
3. runtime mapping 为 `superseded → superseded_by_revision`、`answered → gate_answered_externally`、其余 `gate_${state}`；initial accept 保留当前 `gate_answered`（仅 superseded 特判为新 reason）。覆盖 failed replay recheck、initial accept、authority-recovery 后的 runJob preflight、lost-session fallback、post-review recheck、scheduled retry；删除 `gateStillOpen()`；
4. runJob preflight 在 request-bound authority 恢复 lane 之后、创建 reviewer session 之前拒绝非 open gate，避免 boot redrive 为废门消耗 reviewer；
5. `emitReviewJobFailureAlert(job)` 实时 inspect：可信 supersede 只 log 后 return；recovery 由 `failure_reason × gate.state` 决定（automatic retry > stale-head 新 requestId > binding repair > verified-open same request > verified-closed new gate/request > unknown 先检查），所有 founder copy 继续用完整字符串测试；
6. Lead patrol 的 replay-exclusion literal 加 `superseded_by_revision`，shell fixture 固定它不产生 finding；`alert-kind-copy.ts` 的无 caller generic body 改为中性“按 reason 与 live gate 决定恢复”，避免保留矛盾文案；
7. 不改 `review-governance-effects.ts` / `kind-contract.ts` / `infra-event-router.ts`，真实 `review_job_failed` route 不变。

运行聚焦 spec 到 GREEN 后 refactor，仅去重 helper；提交：

```bash
git add packages/teamlead/src/bridge/review-request-coordinator.ts packages/teamlead/src/bridge/__tests__/review-request-coordinator.test.ts packages/teamlead/src/bridge/alert-kind-copy.ts scripts/lead-patrol-snapshot.sh scripts/__tests__/lead-patrol-snapshot.test.sh
git commit -m "fix(review): silence superseded review failures"
```

## 验证与交付

```bash
pnpm --filter flywheel-teamlead test:run
pnpm --filter flywheel-teamlead typecheck
pnpm --filter flywheel-teamlead build
bash scripts/__tests__/lead-patrol-snapshot.test.sh
pnpm lint
pnpm -r build
pnpm test:packages:run
git diff origin/main...HEAD --check
```

随后按动态协议开全新 `review_code` gate + `request-review`，只在 effective `reviewVerdict=APPROVED` 后继续。所有代码/docs/progress commit 完成后，创建 `engineering/doc/milestones/FLY-2194.md` 作为 literal last commit，push、开 PR、报告 Lead，最后 `complete --route needs_review --pr`；不得 merge/ship/dispatch QA。
