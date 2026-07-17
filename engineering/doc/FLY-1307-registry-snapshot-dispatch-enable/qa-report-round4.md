# FLY-1307 — QA 验证报告 Round 4（PR-8 R9 修复，head `0dffb320b`）

Issue: FLY-1307
日期: 2026-07-16
基于: plan.md (v1.35 §4) · qa-report-round3.md (PR-8 kickback:等价 harness 空过) · PR #626 R9

## 0. 结论 —— **PASS（带一条明示限定）**

Round 3 kickback 的**具名硬 gate「eng 等价 harness」空过已根治**（§1 突变铁证：
当初钉死的同两刀突变，R9 下**都变红**）。Tadashi 点名的三项复验重点全部独立
mutation-verified 成立。R9 另修的 binding 候选面收紧亦为真实安全改进。

| 复验项 | 裁决 | 依据 |
|---|---|---|
| 等价 harness 非空转（round3 kickback 项）| ✅ **已根治** | §1 突变 A/B 均变红 |
| 三段式 entry / active-phase 强制 | ✅ 真 | §2 三道 guard 各自突变变红 + 生产接线 |
| idempotency fallback / replay | ✅ 真 | §2（idempotencyKey guard 突变红）+ §3 |
| binding 候选面收紧（R9 附带）| ✅ 真 | §4 |
| 真机 E2E 引擎链条 | ✅ 走通 | §5①（events 逐跳为真 + qa probe 200）|
| 真机 E2E 完整 13/13 | ⚠️ **未取得** | §5②③：满载生产机 pane 计时超 harness 窗口 = **环境**，非缺陷 |

**明示限定**：我未在本机取得 E2E 13/13 干净复现（原因已证实为环境，§5 有铁证）。
建议在低负载窗口 / FLY-529 QA Room 补一次完整绿，作为 §4.3 硬 gate 的证据收尾。
这不是逻辑疑点，不阻塞 —— 但我不假装它绿过。

## 1. Round 3 kickback 项已修复 —— 等价 harness 现在真观测 legacy（突变铁证）

R9 把 legacy trace 从**手写字符串**改为**从 `legacy.start.mock.calls[].sessionRole`
观测导出**，超限腿从 `start` 实参 + `alertLeadPipelineError` 观测（正是 round3 §4
的修法建议）。用 round3 §2 钉死的**同两刀突变**验证它现在真会变红（基线 74/74 绿）：

| 突变（改 legacy 生产代码） | round3 结果 | R9(0dffb320b) 结果 |
|---|---|---|
| A: `DEFAULT_MAX_FIX_ROUNDS` 3→1（legacy 第2轮 escalate，engine 仍第4轮）| ❌ 仍绿(空过) | ✅ **变红**（trace 不等）|
| B: `onPhaseComplete` 顶部 `return`（legacy 完全不交接）| ❌ 仍绿(空过) | ✅ **变红**（legacy 变 `design->missing`）|

两刀在 R9 下都打红了 harness → 空过根治。两次突变后逐字还原、工作树净。

## 2. 三段式 entry 强制（Tadashi 重点①）—— 真实（3 突变）

R9 `resolveWorkflowTemplateSelection` 新增：v1 候选必须 `allowSchemaV1Dispatch===true`
**且**有 `idempotencyKey`，否则回 legacy；且这两道在 **flag block 之后**（显式启用但
缺旗仍 fail-closed，符合真值表）；外加 `candidateSchemaAtEntry` TOCTOU 断言。
生产接线在 `runs-route.ts`：`role==="main" && candidateSchemaAtEntry!==2` 才走
`resolveThreeStageEntry`，v1 仅在真三段式 entry 命中 + `shareParentBranch===true` 时
才 `allowSchemaV1Dispatch` —— 即 **v1 不能绕过三段式 opt-out / 共享 worktree phase guard**
（R9 核心 HIGH 修复）。基线 `workflow-template-selection`+`start-e2e` 61/61 绿。

| 突变（去掉 guard） | 结果 |
|---|---|
| 去 `allowSchemaV1Dispatch!==true` return | ✅ **4 红** |
| 去 v1 `idempotencyKey` return | ✅ **2 红** |
| 破坏 `candidateSchemaAtEntry` TOCTOU 断言 | ✅ **1 红** |

三道 entry guard 全部真实。

## 3. idempotency / replay（Tadashi 重点③）—— 逻辑正确，测试 timeout 是环境非 bug

`workflow-decision-routes.test.ts`「safely re-drives the phase orchestrator on replay」
（该文件**未被 R9 改**，round3 时在 200/200 里绿过）：

- 5s 默认 timeout 下失败，**无断言失败信息** = 卡在 `await` 非 assert。
- 该文件用**真 git init/commit + 真 HTTP server bind**，单文件跑满 11 tests 约 23s。
- **判据（拉高 timeout）**：`--testTimeout=30000` 下 **11/11 全过**（23.5s）→ 无死锁，
  纯粹是真 IO 在满载生产机（Bridge + 18 sessions + fleet）下超 5s。
- **裁决：环境慢 flaky，非 R9 回归**（文件没改、CI 绿、高 timeout 全过）。

## 4. binding 候选面收紧（R9 附带安全改进）—— 真实

`ensureDefaultWorkflowBindings`：旧代码在 founder 只绑 `heavy` 时 boot 仍补 `*`
（match 所有 category）**扩大候选面**；R9 改为 `if (existing.length>0) continue`——
任何已有 binding 即整个 project 跳过。这落实了 `enable-decision.md`「default binding
不得覆盖 founder 既有 exact category binding」，与 R9「收紧 v1 派发准入」主题一致。

## 5. 真机 E2E（plan §4.3 硬 gate）—— 引擎链条验证通过；未达 13/13 的原因**已证实为环境**

我独立跑了 4 次（R9 head）。最干净的一次（`/tmp/e2e-qa4.log`）证据如下。

**① 引擎链条完全正确**（run events 逐条为真，非投影）：
`design admitted → node_completed(design_done) → edge_traversed(design→implement,
successorExecutionId) → implement node_dispatched(via engine_intent) → admitted →
node_completed(implement_done) → edge_traversed(implement→qa) → qa node_dispatched →
qa admitted(decision:true)`。snapshot 里 `{vendor,model,effort}` 按 FLY-1224 resolver 固定
（design=claude/fable-5、implement=codex/gpt-5.6-sol/xhigh、qa=claude/opus-4-8）。
`engineering_v1_selected_and_materialized` **PASS**。

**② 未过的那格 = harness 等待窗口，不是缺陷**（决定性日志顺序）：

```
[qa] FAIL harness_error=Error: timed out waiting for engineering founder gate   ← 先
[TmuxAdapter] Runner pane died: window=@1515 exit=0 elapsed=17s                 ← 后
[qa] probe qa:1 response=200 reason=none output=none                            ← 最后:qa probe 其实成功了
```

**qa probe 返回 200（成功）**，只是发生在 harness `waitFor`(script:78) 超时**之后**。
pane 耗时**递增**：design **3s** → implement **9s** → qa **17s** —— 满载生产机
（生产 Bridge + 18 sessions + fleet + 本机并发）上 runner pane spawn 越来越慢，
越过了 harness 的等待窗口。

**③ 归因论证**（非"感觉是环境"）：
- R9 **未触碰 TmuxAdapter**（改动仅 selection entry / binding / runs-route）。
- round3 在 PR-7 head 用**同一脚本** 13/13 全过（当时机器负载低）。
- 失败层是 tmux/pane 计时（含另一次 `tmux session ensure held: unknown`），非断言失败。
- qa probe 自身 200 = qa 派发/admission/probe 路径**功能正确**。

**裁决：不作为缺陷、不 kickback**；但**我未取得 13/13 干净复现**，故 §4.3 硬 gate
的完整绿证据建议在**低负载窗口或 FLY-529 QA Room** 补跑一次（机制已由 ① 证明可行，
属证据完备性收尾，不是逻辑疑点）。此项列为交付给 Tadashi 的**明示限定**，不隐去。

## 6. 门禁与回归

| 项 | 结果 |
|---|---|
| CI Build & Test @ 0dffb320b | ✓ 绿（+ FLY-1062 payload 绿）|
| 跨家族 Codex R9 | ✓ APPROVED @ 0dffb320b（Tadashi 转述）|
| PR-8 定向套件（15 文件 324 测）| ✓ 逻辑全绿（唯一失败=§3 环境 timeout，高 timeout 下过）|
| 工作树 | ✓ 所有突变逐字还原，`git status` 空 |
