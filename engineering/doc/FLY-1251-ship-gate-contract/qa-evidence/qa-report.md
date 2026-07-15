# FLY-1251 ship-gate 契约落地 — QA 报告（R2 · Codex R1 kickback 复验）

Issue: FLY-1251 (https://linear.app/geoforge3d/issue/FLY-1251)
日期: 2026-07-15
基于: plan.md / research.md / exploration.md + qa-report R1（同文件夹历史）

> 三段式 pipeline 的 QA 段（re-test wake，epoch 5）。R1 我 verdict = FAIL（Codex R1
> 在 founder-approval 授权边界查出 3 项 HIGH）→ kickback。implement 段已修
> （commit `fa98f1ef1`）+ merge main + 补测试 seed（`51ec80c6`）。本轮复验修复。

## 1. R1 三个 HIGH — 逐条复验 + **突变验证**（不是看绿测背书）

本单核心诉求 = founder-approval 绑定根治 = **ship-gate 绕过 bug class**。按本机 QA 纪律
（memory `feedback_label_substituting_for_fact_bug_class`：ship-gate 绕过的绿测证明不了
fail-closed），我对 implement 加的每条回归守卫测试做了**突变验证**——回退对应修复、确认
守卫测试变红、再恢复。绿测**不是**橡皮章。

| # | 修复位置 | 修法 | 突变验证结果 |
|---|---|---|---|
| HIGH-1 顺序偏离 §3.2 | `auto-qa-held.ts:152-154` | main-role + `pr_number == null → qa_evidence_unknown` **上移到 codex gate / passed-record 之前**（fail-closed 优先；`qa_evidence_unknown` 不在 deferrable 集合） | 回退（删早期检查）→ `review-held.test.ts` 3 个 E4 测试变红，含两个顺序专项「before a Codex-pending result can defer」「before a passed QA record can release」。**守卫真** |
| HIGH-2 分类末尾无 head 终检 | `ship-relevant-diff.ts:297-315` | `classifyShipRelevantDiff` docs-only 出口前加 `finalMetadata` 复取，复核 `head.sha` / `base.ref` / `base.sha` / `changed_files`，任一漂移 → `head_mismatch` / 新增 `metadata_drift` | 回退（删 finalMetadata 块）→ `ship-relevant-diff.test.ts` 4 个参数化守卫（head/base ref/base sha/changed-file count）全变红，`metadataReads===2` 断言同时失守。**守卫真** |
| HIGH-3 base 复核 30s 节流的有界 fail-open | `ship-relevant-diff.ts:401-410` | metadata sub-lease 节流短路加 `cached.ship_relevant === 1 &&` 守卫——**仅安全侧（held）可用节流**；docs-only 豁免（=0）每次 consumer pass 都重取 metadata 复核 head+base，retarget 改 base 立即作废重算 | 回退（删 `=== 1` 守卫）→「revalidates a docs-only exemption every time and invalidates it immediately on retarget」变红；「may throttle ... cached ship-relevant result」保持绿（正确：=1 侧仍应节流）。**守卫真** |

> 三处修复读代码逐行确认无误（见 §3）；三条回归守卫全部突变验证 = 真守卫。

## 2. 活案例（issue 指定验收素材）在新闸下**机械不可能**

2026-07-14 flag 批（#584/585/588/589/590）= 5 张 code PR 以 no-three-stage 派发 → 零 QA
节点 → approve 卡照开的原型违反（R1+R2）。我 R1 写的真 StateStore E1 重放测试
（`qa-fly-1251-ship-gate.test.ts`，10/10 绿）复刻事故行 shape：code PR + 零 QA record →
`qa_evidence_missing` + `founderApprovalHoldGuard = true`（卡拒开）；唯一放行 = server 判
`ship_relevant=0`；锚错（别的 head/别的 PR 号/旧 classifier_version）都不能放行本 head。
= issue 的「最小验收」达成。

## 3. 谓词顺序（复验 HIGH-1 全链，非只看被改的一行）

`reviewHoldReason`（`auto-qa-held.ts`）现行顺序：
`merge_block` → 非 reviewable role 放行 → 非 awaiting_review 放行 →
（try）无/非法 sha：main→`qa_evidence_unknown`（fail-closed）→
**main + pr_number==null → `qa_evidence_unknown`（HIGH-1 上移点）** →
codex gate 未满足 → `codex_pending` → passed record → 放行 / 非 passed → `qa_not_green` →
非 main 放行 → snapshot 缺/PR号不符/classifier 旧 → `qa_evidence_missing` →
snapshot 过期/时钟异常 → `qa_evidence_unknown` → `ship_relevant==0 ? 放行 : qa_evidence_missing`；
catch：main 读失败 → `qa_evidence_unknown`（授权谓词，读失败即闭），非 main rethrow（字节兼容）。
→ main-role pr_number 缺失在 codex/record **之前**就 fail-close，且落 **non-deferrable** 原因（不能被 defer 绕过）。顺序正确。

## 4. 测试证据（本机跑，非自报）

- **FLY-1251 相关文件：397 断言全绿，0 失败**（两轮跑）：
  - 核心 11 文件：auto-qa-held / review-held / ship-relevant-diff（bridge + StateStore）/
    manual-qa-routes / auto-qa-coordinator / deferred-approval / founder-ship-approval /
    gate-poller-ship-readiness-hold / qa-fly-1251 / StateStore.manual-qa-enrollment
    = **211 绿**。
  - 触碰的其余 10 文件：gate-poller / heartbeat-review-timeout / DirectEventSink /
    event-route / fleet-routes-mount / wiring-postwrite（+重跑核心 4）= **186 绿**。
- **typecheck 绿**：`pnpm -r build` 全 23 包通过（含 teamlead `tsc`）。
- **突变验证**：3 条守卫测试各自回退修复后精确变红（§1），恢复后复绿。

## 5. 边界与不背书（诚实）

- 本段验 **PR-1 止血**（`fail closed founder approval until QA evidence`，PR #594）。
  PR-2（卡状态机 / R9 / §5 契约级 run-barrier / ship_subject / freeze_epoch / merge 闸终态）
  **不在已提交代码**，不背书；依赖 FLY-1244 seam + 子单。R1 已同此边界。
- 未做真机 Discord E2E：本段改动为 Bridge 内谓词 + StateStore + server 路由，无 founder 面
  渲染变化需真机看；行为由真 StateStore 测试 + 全套件 + 突变验证锚定。
- 环境性套件假失败（TMPDIR-in-~/.flywheel + 高 load 的 codex-lead-runtime / STACK_TRACE）
  是 runner 宿主所致，非本单代码；CI 干净环境 Build & Test 为绿。

## 6. Verdict（分两层，诚实）

- **代码层 = PASS**：R1 三个 HIGH 修复正确、逐条突变验证为真守卫；397 相关断言 + typecheck 绿；
  活案例在新闸下机械不可能。
- **ship-gate 层 = 待 Codex 复审**：当前 head（`51ec80c6`）在 teamlead.db 无 codex_review_record
  （fix-cycle 未在新 head 重跑 FLY-827，对应已知 coordinator 缺陷「QA-role codex record dropped」）。
  按我 R1 kickback 的收尾条件——**Codex code review 在最终 head APPROVED 之前不 PASS、不开 approve gate**——
  我先驱动新 head 的跨家族 Codex code review 至 APPROVED，再 emit qa-result pass + 走 approve gate。
