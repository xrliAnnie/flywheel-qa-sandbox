# FLY-1314 gate 卫生:auto-supersede + 单活跃 gate 不变式 — QA 报告
Issue: FLY-1314
日期: 2026-07-17
基于: plan.md, exploration.md, research.md + 已提交实现(branch flywheel-FLY-1314 @ ae8b7ace5)

## Verdict: **PASS**

三段式 QA phase 独立验证。实现与 Codex-approved 设计(design review 6 轮)一致、**已真正接线到生产路径(非空过)**、全部 FLY-1314 相关测试通过、承重的 CI-green 闸在**真实 free-tier 仓库**上验证为放行。未发现任何 ship-blocking 缺陷。仅 2 条非阻断观察项(见 §4)。

## 1. Scope 验证范围

四片(PR-1 供给侧 supersede sweeper / PR-2 belt 回收 / PR-3 retest head-delta / PR-4 CI 入口闸),code-only diff ≈ 60 文件(`7b54058cd..HEAD`,排除 progress/docs)。核心新文件:
- `flywheel-comm/src/ship-ci-guard.ts`(CI 闸)
- `teamlead/src/bridge/issue-gate-supersede.ts`(supersede sweeper)
- `teamlead/src/bridge/retest-head-delta.ts`(exact-range 判定)

## 2. 设计一致性 + 接线(非空过)核查

| 项 | 结论 | 证据 |
|---|---|---|
| **I1 单活跃 gate** newest-wins sweeper | 一致 | `sweepIssueGatesForProject`:读全量→按 (issue, family) 分组→(created_at,rowid) 全序→retire 老 pending。`getGatesForSupersede` 只取三 family 且 `superseded_at IS NULL` |
| **I4 双层承重**(retire 成功的 gate 永不成 ship 授权) | 一致 | 层1 `verify-approval` `superseded_at IS NULL` 校验(`gate_superseded`);层2 `insertResponse` 对 `approve_to_ship` 根部 open-only 原子 SQL,`{written:false}` 贯穿 respond.ts / write-gate-response.ts(reject **before** runHook,无 post-write 副作用/不 wake) |
| **I5 历史不可改写** | 一致 | retire 双保险 WHERE(仅 unanswered);受信写先赢 → retire 因 answered no-op → `superseded_at` 保持 NULL → verify 照常放行 |
| **founder 候选集排除 review gate** | 一致 | `gate-poller.ts` `founderReviewGateExcludeEnabled()` + `isReviewGateCheckpoint` 排除,不动 relay/pending/liveness |
| **PR-3 completionContext 贯穿两 sink** | **已接线** | `DirectEventSink`(`completionEventId=randomUUID()`,source=direct)+ `event-route`(source=http)均传入 `onPhaseComplete`;`shouldSuppressQaRetest` 任一缺失/歧义 → false(fail-open retest) |
| **review-gate issue 映射兜底** | **非空过** | `getCodexReviewJobByQuestionId` 依赖 `question_id`;确认 `insertCodexReviewJob` INSERT 写入 `question_id`(schema `NOT NULL`)→ 兜底可用 |
| **sweeper 挂进生产 patrol** | **已接线** | `plugin.ts` `issueGateSupersedeTick` 遍历 projects 调 `sweepIssueGatesForProject`,作为 `onIssueGateSupersedeTick` 传给 `GatePoller`(每 tick,独立 catch) |
| **kill-switch 注册** | 一致 | registry 新增 `issue_gate_supersede`(default enforce)/ `founder_review_gate_exclude` / `retest_head_delta_guard` / `ship_ci_guard`,均 default-on |
| **PR-2 ghost-probe + CAS** | 一致 | 仅 `dead_pin`/`absent` 授权回收(alive/indeterminate/无 target → 跳过);`deleteTurnIfCurrent(issue,holder,epoch)` CAS,epoch 前移 → 拒删 |

## 3. 测试结果

### 3.1 FLY-1314 targeted(全绿)
- `flywheel-comm`:db.fly1314 / gate / respond.gate / ship-ci-guard / verify-approval / ship-eligibility / gate-noblock / three-stage-turn — **144 passed**
- `teamlead`:issue-gate-supersede / retest-head-delta / external-merge-reconcile / gate-poller-fly1041-report-exclusion / gate-poller-health / merged-landing-ci-probe-wiring / merge-ship-gate.integration / write-gate-response / StateStore.fly1314 / park-watch / heartbeat-review-timeout / DirectEventSink — **150 passed**

### 3.2 邻居/共享文件回归(全绿)
- teamlead: detection-escalation-sinks / voice-routes / founder-reply-deliverer / phase-orchestrator.fly887-keepalive / gate-poller-fly1041-sweeper / deferred-approval — **165 passed**
- teamlead: event-route-fly1041-retire / event-route-fly921-turn-belt — **15 passed**
- edge-worker: Blueprint.fly191-approve-gate / Blueprint.fly887-keepalive-prompt — **23 passed**

### 3.3 全量 flywheel-comm suite
`1024 passed`,`11 failed` —— **全部为高负载 flake,非 FLY-1314 回归**:
- 非确定(两跑 9→11);失败文件 `await-codex-gate` / `cli` / `commands` / `progress.realgit` 均为 **子进程/spawn 型**,且 **FLY-1314 未触碰**;
- 隔离单跑(`--no-file-parallelism`)**78/78 全绿**;失败伴随 vitest-worker RPC timeout(负载征兆)。

### 3.4 FLY-1309 回归重演(硬项,非空过)
`issue-gate-supersede.test.ts` 真实 CommDB 建 4 gate(2 跨-exec approve + 2 review 其一 answered)→ 跑真 `sweepIssueGatesForProject` → 断言:candidates=2/retired=2、`getPendingQuestions('lead')` **仅剩 newApprove**(founder 单字母候选=1)、`getPendingGatesByRunner('impl-exec')=[]`(I3 terminal 畅通)、`superseded_by` 列正确、audit 事件成对。审计崩溃自愈测试证明 `superseded_by` 不被后来的 supersessor 改写(I5 因果)。

## 4. 真机验证 + 观察项

### 4.1 CI-green 闸真机验证(承重路径)
`ship-ci-guard.ts` 用 `gh` 作证据源。**在真实 flywheel PR #627 上核验实际 code path**:
- `gh pr view --json headRefOid,mergeStateStatus` → `{headRefOid:ae8b7ace5..., mergeStateStatus:CLEAN}` ✓
- 实现调用 `gh pr checks <pr> --json bucket,name,state`(**无 `--required`**)→ `[{Build & Test:pass}, {FLY-1062:pass}]` → `probeShipCiGreen` 返回 **GREEN** ✓

**关键点(记录以防未来回退)**:flywheel 是**私有 free-tier 仓库**(`branches/main/protection/required_status_checks` → HTTP 403 "Upgrade to GitHub Pro"),**不可能有 required checks**。plan §5.1 文字写的是 `gh pr checks --required`;若实现照抄 `--required`,在本仓 `gh pr checks --required` 会 **exit 1 + 空 stdout**,`execFileSync` 抛错 → 闸 fail-closed → **阻断本仓每一次 ship**(gate 开不了 + verify-approval 永拒)。实现方**正确地未用 `--required`**,改查全部 check → 与 free-tier 现实相容,同时仍拦住 FLY-621(Build&Test 失败=非 pass → 非 green)。
- 已加 QA 回归 `ship-ci-guard.test.ts`「free-tier repo … NEVER filters with --required」,**mutation-verified**(注入 `--required` → 测试 RED)。

### 4.2 观察项(非阻断,交实现方判断)
- **Obs-1(LOW)**:`verify-approval` 的前置守卫 `!Number.isSafeInteger(prNumber) || prNumber<=0 || (!worktreePath && !ciProbe) → ci_not_green` 位于 `probeShipCiGreen`(内含 `FLYWHEEL_SHIP_CI_GUARD=0` 判定)**之前**。即:kill-switch 关时,缺 `pr_number` 的 session 仍返 `ci_not_green`,未完全字节回退。真实流里 `pr_number` 恒由 `complete --route needs_review --pr` 绑定,故正常 session 不受影响;仅对「未绑 PR 号」的畸形 session 保持 fail-closed(可辩为正确)。若要 kill-switch 严格字节回退,可把前置守卫也纳入 `FLYWHEEL_SHIP_CI_GUARD` 判定。
- **Obs-2(doc)**:plan §5.1 与代码在 `--required` 上不一致(见 §4.1)。**代码正确**;建议后续把 plan 文字改成「查全部 check(free-tier 无 required)」,以免有人「对齐 plan」而反把 bug 引回。

## 5. 结论
无 ship-blocking 缺陷。实现正确、接线完整、测试充分、承重 CI 闸经真机验证。**PASS**,进入 approve gate。
