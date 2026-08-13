# Design Review — FLY-1718 plan.md (Round 3)
Date: 2026-08-12
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 的五项修订都已被实质采纳：P1 的 branch key 与 async ordering 已同源；P3 增加 request manifest 和 dirty-path guard；P4 改成 lease reservation、canonical root UUID 和独立 privileged reset。此前 P1/P2 的 Git 与 hook 设计不再有阻塞项。

本轮仍有四个由新设计细化后暴露的缺口。最直接的是 P4 把 `emitStarted/session row` 写成 settlement 点，但源码明确该事件发生在 worktree 创建之前；这与计划自己的 create-fail→release 测试互相矛盾。P4 的单行账本还无法区分“未 settled 就失败的尝试”，且 `(root, role)` 会把 auto-QA child 与三阶段 QA 折到同一断路器。P3 则没有定义 Bridge-owned manifest 的权威存储/读取通道，按当前 CLI 形状无法完成可信三方校验。

## What's Good (Keep)

- P1 现在以一次 server-side `worktreeIssueId` 计算同时驱动 probe 与 Blueprint，并明确 `issueIdentifier` 不参与 branch key；UUID/identifier 组合测试覆盖正确。
- P1 的精确顺序把远端探针移到 lifecycle claim 之前，pre-claim typed rejection 不再误调用 `abortPreLaunch`；`ResumeComputer` 升为 awaited seam 并共享 repo lock，解决了 Round 2 的接口矛盾。
- P2 已闭合：发布资产、自安装、外置 hooksDir、回滚、审计和诚实边界均可按计划实施。本轮无需再改设计。
- P3 的 request revision、result/manifest/HEAD 三方比较，以及 staged/unstaged path-scoped clean check，正确覆盖旧 result 重放与 A→A′ dirty 形态。
- P4 的 reservation owner、lease expiry、同 owner 幂等和 known-failure release 是正确方向；reset 不再复用可 no-op/有 loopback alias 的普通 action mount。
- 四包独立 PR、P1 先 ship 的 sequencing 继续成立；下面的 P3/P4 修订不应阻塞 P1。

## Issues & Recommendations

1. **[BLOCKER] P4 settlement 点选错：`emitStarted` 不是 durable launch commit。**

   **为什么重要：** Blueprint 在进入 `run()` 后先 fire-and-forget `emitStarted`（`Blueprint.ts:1019-1023`），随后才进入 `runInner()` 创建 worktree（`:1360-1375`）。`DirectEventSink.emitStarted()` 自己也明确说明它发生在 worktree/binding 之前，lifecycle activation 已移到 `emitWorktreeReady`（`DirectEventSink.ts:284-288`）。真正的现有 commit seam 是 `bindWorktreeOnce` 成功后调用 `lifecycleActivate`（`:439-494`）。若按计划 §5.2 step 5 在 `emitStarted/session row` 把 reservation `reserved→settled`，后续 hook/config/worktree create 失败时 reservation 已 settled，无法执行 §5.2 step 6 的 release；这会重新产生永久消费问题。

   **建议修复：** settlement 挂在 bridge-local `emitWorktreeReady` 的 binding-authority seam：仅当 `bindWorktreeOnce` 已成功或幂等地确认相同 binding，且 lifecycle activation 未拒绝时，才 CAS `reserved(owner=executionId)→settled`；activation 拒绝则释放给 park 流程。不要从 runner 可发的 HTTP `worktree_ready` 或 `session_started` 路径结算。还要关闭 binding 已落、settlement 未落时的 crash window：重入/startup repair 看到 reservation owner 已有匹配的 durable binding 时必须补 settle，而不能等 lease 过期后开放第二个 launch。把测试改为明确断言：session row 已存在但 create/config 失败仍保持 `reserved` 并可 release；binding durable 后才 settled；binding→settle 间 crash 可修复；重复 `emitWorktreeReady` 幂等。

2. **[BLOCKER] `reserved→none` 后，未结算尝试的 failed session 会被误认成下一代 DOA。**

   **为什么重要：** create 失败前 `emitStarted` 已可能创建 session row，Blueprint 随后还会发 terminal failure。计划的 step 1–3 每次读取“最近 terminal 前任”；已知失败把 reservation 从 reserved 释放为 none 后，最新 failed execution B 与普通 settled 后短命的 successor 在当前 schema 中没有持久区别。下一次 start 会把 B 当作“新 execution_id”执行 count+1，违反“下一代只由 settled successor 自己又短命 failed 推进”。单个 `release_owner_execution_id + release_state` 还会在下一次 reserve 时被覆盖，无法作为长期证明。

   **建议修复：** 增加明确的 durable settlement identity，例如 `last_settled_successor_execution_id`，或使用按 execution 追加的 reservation/settlement receipt 表。计数候选必须满足 `failed.execution_id === last_settled_successor_execution_id`；未 settled 的 terminal row 永不涨代，系统继续针对原 `last_counted_predecessor` 重新 reserve。补测试：B 在 session_started 后 worktree create 失败并落 failed row，C 重试时 count 不变、仍服务于原 predecessor；reservation owner 被后续尝试覆盖后也不能把 B 追认成 settled。

3. **[BLOCKER] `(lifecycle_root_uuid, role)` 会把 auto-QA 与三阶段 QA 错折到同一个 DOA 断路器。**

   **为什么重要：** `resolveLifecycleRootKey()` 有意把 Bridge 创建的 auto-QA child UUID 折到 parent root（`lifecycle-root-key.ts:10-14,133-158`）。auto-QA 在独立 QA issue 上以 `sessionRole:"qa"` 启动并携带 `qaContext`（`auto-qa-coordinator.ts:1091-1132`）；三阶段 QA 则在 parent issue 上同样以 role `qa` 启动（`phase-orchestrator.ts:693-717`）。按当前主键，两条不同 retry/lifecycle lane 会互相累计 count、占用 lease或触发 needs_lead；auto-QA 本身已有独立 bounded retry/stuck/Lead-alert 协议，叠加 P4 还会产生双状态机。

   **建议修复：** 最简单且符合现有所有权的是让 P4 明确豁免 `req.qaContext != null` 的 auto-QA lane，由 AutoQaCoordinator 继续独占其重试/告警；三阶段 QA 保留 P4。若确实要覆盖 auto-QA，则主键必须增加 Bridge-derived lane discriminator，不能只用 role。增加交叉测试：auto-QA child failed 不改变 parent three-stage QA 的 row/count/lease，反向亦然。

4. **[HIGH] P3 的 “Bridge-owned manifest” 没有定义存储位置和可信读取协议，当前 `await-codex-gate` 接口无法实现。**

   **为什么重要：** 计划只说“原子写 manifest”。若写在 worktree 的 `.flywheel/runs/...`，runner 与 result writer 可改它，就不是 request-side trust anchor；若写在 StateStore，当前 runner-side `await-codex-gate` 只接受 reviewType/execId/worktreePath，并只读取本地 skip/result 文件（`await-codex-gate.ts:55-61,98-108,290-340`），没有读取 Bridge authority 的通道。此外 manifest 更新与 CommDB instruction 之间存在 crash window；只更新 manifest 没投递新 requestId 会让 gate 永久拒绝旧 result，而上游 event 已按 `event_id` 去重，不会自然重跑 handler（`event-route.ts:1043-1055`）。

   **建议修复：** 将 manifest 放进 StateStore 的专用表，使用 `(execution_id, revision)`/current pointer 和 source `event_id` 做幂等 CAS；不要以 runner-writable文件为权威。定义一个 Bridge-side validation endpoint/seam：runner gate 提交 result projection，Bridge 在服务端读取 manifest、session worktree/binding并完成 requestId/path/blob 校验，只有服务端 allow 才退出 0；token 缺失/manifest 不可读/Bridge 不可达均 fail closed。manifest advance + instruction delivery需 durable outbox/receipt，或加启动/reconcile drain，保证 crash 后当前 requestId 最终会投递。测试 manifest 文件伪造无效、manifest-write 后投递前 crash 可恢复、同 source event replay不递增 revision。

## Verdict

**CHANGES REQUESTED**

P1、P2 可按现计划独立推进；Q1/Q2 和已关闭的 Round 1/2 branch/hook 结论不重开。批准整体计划前只需再收口 P3 的服务端 manifest authority/delivery，以及 P4 的真实 binding commit seam、settlement identity 和 auto-QA lane 隔离。
