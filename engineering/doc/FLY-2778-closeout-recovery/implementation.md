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

## C2：stock cleanup apply 的 scoped CAS

根因：既有 `lifecycle_apply_claims` 只以 `(root_uuid, approved_hash)` 标识全 issue closeout，`putApplyClaim` 是无条件 upsert。它没有目录效果 scope、稳定 effect key、requestId/target digest 内容绑定，也无法阻止两个不同请求同时认领同一目录删除效果。

最小修复：兼容迁移原表，把旧行保留为 `effect_scope=issue_closeout`、`effect_key=root_uuid`；stock 路径使用独立 `stock_worktree_cleanup` scope，并持久化 effect key、requestId、target digest、project 与 actor。两个 partial unique indexes 分别锁定 stock effect 和 requestId。新 `claimApplyEffect` 以 `INSERT ... ON CONFLICT DO NOTHING` 原子认领：完全相同请求只重放原 claim，同 request 内容变化或另一请求争抢同 effect 均拒绝；`casApplyEffect` 还要求 scope/key/hash/request/digest/root/project/actor/前态全部匹配才写 receipt。

### 红绿与选择

- RED：新具体文件 4 项中 3 fail / 1 pass，旧代码没有 scoped claim/CAS 接口；旧表迁移正对照已先通过。
- GREEN：`StateStore.lifecycle-apply-claims.test.ts` 4/4，覆盖旧 epoch 迁移、两个独立 StateStore connection 争抢同 effect 仅一方成功、request 内容漂移拒绝、非赢家与错误前态均不能写 receipt。
- 直接受影响旧契约：`lifecycle-closeout.test.ts` 64/64、`StateStore.fly663-migration.test.ts` 11/11、`fly-2413-retention-migration.test.ts` 1/1 均分别通过。没有新增表，既有 `lifecycle_apply_claims` retention 分类继续生效。
- 受限 related config 经 `vitest list --filesOnly` 确认为上述 4 个具体文件；`vitest related` 实际选中 3 文件，79 项中 76 pass，3 项仅因当时 host load 65–79 下超过既有 5 秒超时。相同 `lifecycle-closeout.test.ts` 已在默认超时下单独 64/64 通过，因此该轮不计绿，最终验证需在负载恢复后按原 timeout 重跑；未提高 timeout、未放宽断言。
- `pnpm --filter "flywheel-teamlead..." build` 成功。diff 不含进程 signal/spawn/kill 字面或 FLY-1560 禁用词；因此 kill-path inventory 与 lexical guard 均记录为本批排除项，不以无关全包运行代替。

## C3：存量清理的认证 preview 与 fail-closed execute 边界

实现新增版本化、哈希绑定的 stock cleanup manifest，以及 Claude reclose peer、Codex lifecycle route、`flywheel-comm land cleanup` 三条认证入口。preview 只枚举已注册 worktree，并逐项证明项目归属、目录 inode/realpath 身份、StateStore 绑定、PR 状态、远端提交包含关系、干净状态、嵌套仓库扫描、只读 CWD census 与 land target snapshot 权限。FLY-2688 / FLY-2751 固定保留；OPEN、无 PR、dirty、未推送、活体、未知或权限漂移一律排除。

无绑定目标即使 PR 已终结，也必须具备受信来源、归属、socket 与锁四项证明；当前生产没有共同 body provider，因此这类目标额外标记 `untrusted_binding`，所有已绑定目标也保守标记 `body_unknown`。execute 入口验证认证上下文和 manifest/request tuple 后明确返回 `stock_cleanup_execute_disabled`，没有任何删除或 signal 路径；待 FLY-2919 导出同一生命真源后才能接通 apply。这保证 stock reclose 在任何发信号能力之前完成全量 cwd/process census，本批本身不含 signal API。

### 红绿、选择与构建

- RED 后 GREEN：`stock-worktree-cleanup.test.ts` 3/3、`stock-worktree-cleanup-observer.test.ts` 3/3、`stock-worktree-cleanup-route.test.ts` 4/4、`land-reclose-peer.test.ts` 6/6、`lifecycle-routes.test.ts` 17/17、flywheel-comm `land.test.ts` 6/6。
- TeamLead 受限 related config 仅含上述 5 个具体文件，33/33；flywheel-comm 受限 related 仅含 `land.test.ts`，6/6。没有新增 `scripts/__tests__/*.test.sh`。
- 12 个改动文件的精确 Biome check exit 0，仅报告 `plugin.ts` 两条既有 `useConst` warning。仓库级 `pnpm lint` 当前 exit 1（5117 files，10 errors / 26 warnings），错误均在本单未改的 FLY-1563/config/core/scripts 等文件；未越权修改。
- `pnpm --filter flywheel-comm build`、`pnpm --filter flywheel-teamlead typecheck`、`pnpm --filter "flywheel-teamlead..." build` 均通过；`git diff --check` 通过。
