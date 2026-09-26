# FLY-2778 收尾恢复 — 实施记录
Issue: FLY-2778 (https://linear.app/geoforge3d/issue/FLY-2778/收尾清理失效-ship-之后-worktree-没被删thread-没归档land-收尾-issue-closeout-incomplete)
日期: 2026-09-26
基于: plan.md

## 当前依赖边界

- 当前 `origin/main` 为 `fdd1b404d`。FLY-2919 尚未合入；远端头 `a84a07854` 的进度明确写着 A 组未完成、B–F 未实施、当前头未全绿。因此本单不把整条 WIP 分支当作已发布的共同生命 provider，也不复制第二套死亡判定。
- FLY-2754 远端头 `3f89b8a76` 尚未完成实现审查。本单只按已批准计划逐项重取其受信来源凭证设计，并重新做当前头红绿；不整分支 cherry-pick。

## C1：stock cleanup 的零信号删除原语

根因：`WorktreeManager.removeCleanWorktreeByPath` 在任何 `git worktree remove` 前都无条件调用 `reapPath`。该调用最终可向目录内进程发送 SIGTERM/SIGKILL，不满足存量清理“任意 CWD 进程都拒绝、绝不发信号”的边界。

本批新增显式 `processHandling: "refuse"`：在既有 repo lock 内执行只读 CWD census；目录内进程、无法解析的 CWD 或 census 异常全部拒绝；拒绝模式不调用 reaper、不允许 branch 删除，只执行无 `--force` 的 `git worktree remove`。默认路径仍保持原先 reap-first 行为。

### 红绿与选择

- RED：`WorktreeManager.reap.test.ts` 新增 5 个边界后为 3 fail / 4 pass（随后补入 branch 与 malformed-CWD 负控）；失败显示旧实现仍调用 reaper 并删除目录。
- GREEN：同一具体文件 9/9 pass。
- 保留的明确匹配：`WorktreeManager.test.ts` 58/58；`WorktreeManager.reap.e2e.test.ts` 1 pass / 8 platform-skipped；`test-worktree-removal-contract.test.sh` 7/7；FLY-2211 `kill-path-inventory.test.ts` 5/5。
- `vitest related src/WorktreeManager.ts src/__tests__/WorktreeManager.reap.test.ts --run` 意外展开到 30+ Blueprint/WorktreeManager 文件；已见部分均绿，但运行随后长时间无输出，手动终止且没有最终摘要，因此不计通过。最终验证必须使用受限配置重跑相关集合。
- `git grep -lF -- 'removeCleanWorktreeByPath'` 的可执行消费者为三个 edge-worker 文件、两个 teamlead 文件及 `scripts/qa-fly2616-closeout-replay.mjs`；其余命中均为历史/设计/报告文档，排除为非可执行测试。`WorktreeManager.ts` path/basename/parent 的宽匹配中保留 removal contract 与 kill-path inventory；其余文档、数据快照、无关 Blueprint/配置测试不因仅含路径文字而纳入本批显式集合。

### 构建

- `pnpm install --frozen-lockfile` 成功；首次测试因依赖 `dist` 缺失只算 preflight，不算 RED。
- `pnpm --filter "flywheel-edge-worker..." build` 在实现后成功。

## B：held 告警稳定身份与歧义重放

根因：`land_alert_outbox` 已按 `(operation_id, resume_generation)` 固定一条逻辑告警，但 dispatcher 的 transport `eventId` 追加了 `attempt`。每次重试因而绕过下游去重，且 dispatcher 仅凭 `sink.alert()` 的返回值结账，没有读取 `alert_delivery_receipts`；异常还会立即重新排队，跳过已有的 30 分钟歧义窗口语义。

最小修复：transport identity 固定为 `land-held:<operationId>:<resumeGeneration>`；land outbox claim 标出是否为过期 `delivering` 的重放；首次投递使用 30 分钟 lease。dispatcher 在调用 sink 前后都读取稳定 eventId 的 delivery receipt，仅 `sent` / `queued_durable` 结为 sent，`deadlettered_durable` 和缺 receipt 均按失败累计。sink 抛错保持 `delivering`，过歧义窗口后才以内部 `replayAfterAmbiguousAttempt: true` 重放；该字段不进入 payload。

### 红绿与选择

- RED 1：稳定身份断言 1 fail，旧实现实际产生 `...:0:1` / `...:0:2`。
- RED 2：receipt/重放三条边界为 3 fail / 1 pass：无 receipt 仍结 sent、已有 queued receipt 仍调用 sink、异常立即回 pending。
- GREEN：`land-alert-delivery.test.ts` 4/4，覆盖稳定 eventId、无 receipt 拒绝、queued receipt 免重发、30 分钟后同身份 replay；dead-letter receipt 连续三次最终进入可检索 `failed`，不冒充送达。
- 直接 literal 消费者保留 `StateStore.land-lifecycle.test.ts` 与 `LeadAlertNotifier.test.ts`；分别 40/40、69/69。`vitest related` 使用外部临时 config，先以 `vitest list --filesOnly` 核对仅这三文件，随后 3 files / 113 tests 全绿。宽目录/通用文件名命中均为历史文档、静态 inventory 或与该 claim/receipt 契约无直接关系的测试，排除；没有新增 `scripts/__tests__/*.test.sh`。
- `pnpm --filter "flywheel-teamlead..." build` 成功；`pnpm lint` exit 0（5111 files，25 个既有 warning，本批无 error）。
