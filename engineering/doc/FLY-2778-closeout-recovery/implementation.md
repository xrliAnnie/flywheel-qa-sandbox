# FLY-2778 收尾恢复 — 实施记录
Issue: FLY-2778 (https://linear.app/geoforge3d/issue/FLY-2778/收尾清理失效-ship-之后-worktree-没被删thread-没归档land-收尾-issue-closeout-incomplete)
日期: 2026-09-26
基于: plan.md

## 当前依赖边界

- 本轮审计时 `origin/main` 为 `570fdb56d`。FLY-2919 尚未合入；远端头 `da14f1f89` 的进度仍明确写着 B11 及后续范围、最终审查/PR 未完成。因此本单不把整条 WIP 分支当作已发布的共同生命 provider，也不复制第二套死亡判定。provider 缺席时 stock cleanup 保持 unknown 拒删；正常 land closeout 继续既有路径，避免把所有 ship 收尾永久锁死。provider 一旦可用，normal land 与 stock cleanup 才共同消费其 observation。
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
- GREEN：`StateStore.lifecycle-apply-claims.test.ts` 5/5，覆盖旧 epoch 迁移、两个独立 StateStore connection 争抢同 effect 仅一方成功、request 内容漂移拒绝、非赢家与错误前态均不能写 receipt，以及 rejected 收据保留但新 manifest/request 可重新认领同一 effect。
- 直接受影响旧契约：`lifecycle-closeout.test.ts` 64/64、`StateStore.fly663-migration.test.ts` 11/11、`fly-2413-retention-migration.test.ts` 1/1 均分别通过。没有新增表，既有 `lifecycle_apply_claims` retention 分类继续生效。
- 受限 related config 经 `vitest list --filesOnly` 确认为上述 4 个具体文件；`vitest related` 实际选中 3 文件，79 项中 76 pass，3 项仅因当时 host load 65–79 下超过既有 5 秒超时。相同 `lifecycle-closeout.test.ts` 已在默认超时下单独 64/64 通过，因此该轮不计绿，最终验证需在负载恢复后按原 timeout 重跑；未提高 timeout、未放宽断言。
- `pnpm --filter "flywheel-teamlead..." build` 成功。diff 不含进程 signal/spawn/kill 字面或 FLY-1560 禁用词；因此 kill-path inventory 与 lexical guard 均记录为本批排除项，不以无关全包运行代替。

## C3：存量清理的认证 preview 与 fail-closed execute 边界

实现新增版本化、哈希绑定的 stock cleanup manifest，以及 Claude reclose peer、Codex lifecycle route、`flywheel-comm land cleanup` 三条认证入口。preview 只枚举已注册 worktree，并逐项证明项目归属、目录 inode/realpath 身份、StateStore 绑定、PR 状态、远端提交包含关系、干净状态、嵌套仓库扫描、只读 CWD census 与 land target snapshot 权限。FLY-2688 / FLY-2751 固定保留；OPEN、无 PR、dirty、未推送、活体、未知或权限漂移一律排除。

无工作树绑定目标即使 PR 已终结，也必须具备受信来源、归属、socket 与锁四项证明；它们仍额外标记 `untrusted_binding`，不会因 provider 字符串自行放行。已绑定但从未产生进程 binding 的 execution 只接受共同 provider 的 typed never-started closure；provider 缺席或四项任一未知均为 `body_unknown`。生产 execute 已接入 scoped claim/CAS：在认证上下文、manifest/request tuple、临删前 authority/identity/body/CWD 二次校验全部通过后，才调用 `processHandling: "refuse"` 的无信号、无 `--force` 删除；任一漂移逐项拒绝，不把空执行冒充成功。

### 红绿、选择与构建

- RED 后 GREEN：`stock-worktree-cleanup.test.ts` 3/3、`stock-worktree-cleanup-observer.test.ts` 3/3、`stock-worktree-cleanup-route.test.ts` 4/4、`land-reclose-peer.test.ts` 6/6、`lifecycle-routes.test.ts` 17/17、flywheel-comm `land.test.ts` 6/6。
- TeamLead 受限 related config 仅含上述 5 个具体文件，33/33；flywheel-comm 受限 related 仅含 `land.test.ts`，6/6。没有新增 `scripts/__tests__/*.test.sh`。
- 12 个改动文件的精确 Biome check exit 0，仅报告 `plugin.ts` 两条既有 `useConst` warning。仓库级 `pnpm lint` 当前 exit 1（5117 files，10 errors / 26 warnings），错误均在本单未改的 FLY-1563/config/core/scripts 等文件；未越权修改。
- `pnpm --filter flywheel-comm build`、`pnpm --filter flywheel-teamlead typecheck`、`pnpm --filter "flywheel-teamlead..." build` 均通过；`git diff --check` 通过。

## A1/A2：从未启动来源与共同 provider 闭包

FLY-2754 的 auth pre-spawn 只提供“可能从未启动”的来源，不能自行证明体已死。本批新增 source-only assessor：live receipt 必须来自 Bridge 内部原子终态链；legacy 只接受冻结 cutoff 前、同一 `DirectEventSink` 终态与 teardown 锚定的两种 auth 失败族。普通 `Child stdio timeout`、cutoff 后事件、项目/activation/revision 漂移、活动 launch owner 或 receipt 身份不一致全部拒绝。dry-run 只报 candidate；正常路径才按 snapshot digest CAS 落 `legacy_compat` receipt。assessor 不调用 pgrep/tmux/window，也不产生独立死亡 verdict。

共同 provider 契约新增 typed `NeverStartedBodyObservation`，把来源、owner/spawn/restart、daemon ledger shape、socket、spawn lock、TTL 与 digest 放在同一 observation。legacy 必须是 `no_group + prelaunch_home_only`；live 只允许 `missing` 或同一 prelaunch shape。provider 存在时，正常 land closeout 与 stock preview 都只在常规 `observe()` 没有 process binding 时查询这个可选分支，并在 effect 前调用 provider 的同步 current check。两条消费者都核对 execution/project/issue/run/activation/lifecycle/adapter；来源、归属、socket、锁任一缺失都保持 unknown，不归档、不删 worktree。FLY-2919 factory 尚未合入时 stock cleanup 仍 fail-closed，正常 land closeout 则继续既有收尾判定。

### 红绿与验证

- RED→GREEN：stock preview 的 legacy daemon shape 与 execution-run 漂移各自先被错误放行为 eligible；补 exact identity/shape 校验后 `stock-worktree-cleanup.test.ts` 10/10。
- RED→GREEN：normal land closeout 对完整 never-started closure 仍返回 blocked；接入同一 provider 分支后完整闭包不进入 signal path，来源/归属/socket/锁四类缺失逐一保持 blocked。`lifecycle-closeout-body-observation.test.ts` 9/9，完整 `lifecycle-closeout.test.ts` 64/64。
- source assessor：`codex-pre-spawn-source.test.ts` 5/5；原凭证/producer/retention 回归 `StateStore.codex-pre-spawn.test.ts` 8/8、`DirectEventSink.dag-seam.test.ts` 15/15、`StateStore.fly2341-terminal-archive.test.ts` 28/28、`fly-2413-retention-migration.test.ts` 1/1。
- 受限 related 配置先以 `vitest list --filesOnly` 核对 10 个明确文件，随后 changed-file related 实际选中 9 files / 173 tests，全绿；没有回落到包级 suite。精确 Biome 与 `git diff --check` 通过，TeamLead typecheck 通过。

## 交卷前 exact-diff 自审修正

逐文件比较当前分支与 `origin/main` 时又找出三处不能带进复审的边界，并各自先补失败用例：

1. stock execute 的冻结目标 digest 原先没有绑定 execution run、lifecycle revision 与 adapter；新 activation/revision 即使目录、branch、generation 未变也可能沿用旧批准。现把三项加入稳定 target identity，revision 漂移在 remove 前返回 `target_identity_changed`。
2. stock effect 的唯一索引原先覆盖 `rejected`，一次临时 unknown/CWD veto 会让该目录永久 `effect_already_claimed`。索引现只占用 `claimed|applied`；原 request 仍精确回放 rejected 审计，新 dry-run/new request 可重试。`claimed` 崩溃恢复与 `applied` 永久防重语义不变。
3. 早期 WIP 曾在 FLY-2919 provider 模块不存在时给 normal land closeout 注入 fail-closed observer。代码复审确认这会阻塞所有 ship 收尾；下节 R1 修订已经撤销该接线。stock preview 仍因缺少 observation 拒删，而 normal land closeout 在 provider 尚未发布时继续既有路径。

对应 RED→GREEN：`stock-worktree-cleanup-executor.test.ts` 7/7、`StateStore.lifecycle-apply-claims.test.ts` 5/5、`execution-body-observer-wiring.test.ts` 2/2；共同 closeout 回归 `lifecycle-closeout-body-observation.test.ts` 9/9。受限 changed-file `vitest related` 只选中这 4 个具体文件，23/23。当前代码提交 `c6f686aef` 上 `pnpm --filter "flywheel-teamlead..." build`、TeamLead typecheck、仓库 lint（5184 files，25 个既有 warning、0 error）与 `git diff --check` 均通过。

## 代码复审 R1 修订

首轮代码复审在 `48bcb715e` 上给出 1 个 HIGH 与 6 个 MEDIUM/LOW 可修正项。本轮按原设计边界逐项收敛：

1. FLY-2919 provider 缺席时不再向 normal land closeout 注入永久 unknown；动态 factory 只有在同时提供 `observe` / `isCurrent` 时才启用。精确的模块不存在会告警并保持 legacy land 可用，factory 缺失、契约错误或其它加载异常会显式报错。stock cleanup 因没有 observation 仍拒删。
2. land 告警第三次 sink 抛错后把 outbox 终结为 `failed`，保留错误细节，不再永久停在 `delivering`。
3. `replayAfterAmbiguousAttempt` 沿 Hub、infra router、Lead inbox、issue-thread 与 fallback 全链传递；`sent` / `queued_durable` 路由结果写 delivery receipt，duplicate/skipped 不伪造送达。
4. cleanup apply actor 改为 lease-generation 稳定身份；连接 peer pin 仍在每次 effect 前由 `assertCurrent()` 校验。不同连接可恢复同一 generation 的 claim，新 generation 不能继承。
5. stock execute 在 repo lock 内只重取获批的单个 canonical path，不再为每个目标重复做全仓 preview。
6. provider 加载的非预期错误不再静默吞掉。
7. stock effect key 加入 generation 与 leaf inode identity；同一路径后续真实 generation 可以重新认领，既有 generation 仍保持幂等。

复审 LOW 项“body 已死后是否继续清理 tmux UI residue”未在本单改动：当前没有不向 pane 进程发信号的安全 UI-only 原语；扩展 `closeRunner` 会改变 teardown 语义。现有规则仍是先完成 CWD/进程 census，再决定是否发信号，stock cleanup 全程使用 no-signal 删除路径；该 LOW 项留给后续治理，不冒充已修复。

### R1 红绿与最终本地证据

- 每项先补失败用例：provider 缺席的 normal land、第三次告警异常、route replay/receipt、跨连接 cleanup actor、target-only revalidation 与同路径新 generation 均先在旧实现上转红，再做最小修复。
- 直接变更测试 9 files / 118 tests 全绿；literal 命中的 `LeadAlertNotifier.test.ts` 69/69、`codex-quota-outbox.test.ts` 12/12、`lead-inbox-runtime.test.ts` 49/49，以及结构命中的 `fly2278-retirement.test.ts` 1/1、`workflow-dispatch-seams.structure.test.ts` 8/8、`workflow-gate-fence-wiring.test.ts` 2/2、`workflow-pr-binding-wiring.test.ts` 2/2、`automated-message-inventory.test.ts` 2/2 均逐文件通过。
- mandatory changed-TypeScript `vitest related ... --run` 因 `plugin.ts` 是组合根扩展为 141 files：139 files / 1846 tests pass、1 skipped；`fly2139-query-plans.test.ts` 的生成 evidence digest 过期，按同一 capture set 更新后单文件 2/2 通过。`lead-activity-service.real-tmux.test.ts` 在 suite 初始化调用 `ps -A` 时被 runner sandbox 稳定拒绝为 `EPERM`，测试正文未执行（1 skipped）；独立 shell `ps -A -o ppid=,ucomm=` 同样返回 operation not permitted，记录为本地环境限制，不作为绿色证据。
- 测试发现中的直接行为/结构消费者全部保留并逐文件运行。仅命中通用 `plugin.ts`、`packages/teamlead/src/bridge` 父目录、历史 test-report/fixture 或静态 test-consumer inventory 的宽泛结果被排除：这些匹配不导入或断言本轮变更契约，逐个纳入会把目录文字匹配伪装成包级 suite；required `related` 仍覆盖实际 TypeScript 依赖闭包。没有新增 `scripts/__tests__/*.test.sh`。
- `pnpm lint` exit 0（5184 files，25 个既有 warning、0 error）；`pnpm --filter "flywheel-teamlead..." build` 与 TeamLead typecheck 通过；`git diff --check` 通过。

## QA rework：同步主干与 CI 容量归因

QA 在 `14b6e0284` 上确认 PR #1375 的唯一 full-CI 红项是 Script Tests 4/6 容量
tripwire（1068 秒，大于 1020 秒），同时 PR 已与 `origin/main` 发生内容冲突。本轮只按 Lead
裁定做技术同步与同头复验，不调整全局 CI 分片，也不把本地 targeted/related 结果冒充 full CI。

- 合入 `origin/main@975822f5d`。`StateStore.ts` 的冲突同时保留本分支 `preSpawnReceipt`
  接线与主干 `quotaStandby` 状态；FLY-2139 index audit 使用合并后 capture set 的真实 digest
  `685b14ca379b1222376c5ee1a180fd2763183e857aaef8e748eb384dd46317dd`。后者先以主干旧
  digest 跑出 1 fail / 1 pass，再更新 evidence 后同一具体文件 2/2 通过。
- 同步后 TeamLead related 首轮暴露的 13 个失败中，12 个来自主干新增 API 对应的
  `flywheel-comm/dist` 陈旧产物；先构建 `flywheel-comm` 后两个具体失败文件分别 49/49、1/1
  通过。剩余一个 real-tmux 文件在 runner sandbox 的 `ps` 权限边界失败；用只服务于测试的
  临时、未入库 process census seam 验证后，Claude Runner 相关闭包为 10 files / 669 tests
  全绿。该临时 seam 已删除，未进入提交。
- 受影响依赖构建 `pnpm --filter "flywheel-teamlead..." build` 成功；edge-worker related 为
  36 files（1 skipped）/ 542 pass / 9 skip，Claude Runner related 为 10 files / 669 pass，
  core related 为 2 files / 23 pass / 2 skip，flywheel-comm land related 为 1 file / 6 pass。
- TeamLead changed-TypeScript related 以 `StateStore.ts` / `plugin.ts` 等 18 个改动源文件为根会
  展开 600+ 个文件；重跑过程中 Lead 因同机多 Runner 负载影响 Bridge 而将其终止，没有最终
  汇总，故本轮不计 related 绿色证据，也不再重启。改为保留已逐文件完成的直接测试：
  `DirectEventSink.dag-seam` 16/16、`StateStore.fly2341-terminal-archive` 29/29、
  `StateStore.lifecycle-apply-claims` 5/5、`event-route` 115/115、retention migration 1/1、
  `terminal-failure-info` 3/3、`codex-pre-spawn-source` 5/5、execution-body wiring 2/2、
  `execution-closeout-evidence` 31/31、`infra-alert-wiring` 23/23、`land-alert-delivery` 5/5、
  `land-reclose-peer` 7/7、`lifecycle-closeout-body-observation` 11/11、`lifecycle-routes` 17/17、
  stock cleanup executor/observer/route/main 分别 8/8、3/3、5/5、10/10，以及 Lead inbox
  runtime/summary 分别 49/49、1/1。最终 `pnpm lint` 检查 5228 files，0 error / 25 个既有 warning。

### Script Tests 4/6 容量比较

PR run `36298125503` 的该 job 从开始到 tripwire 为 1068 秒，其中 Build 121 秒、既有
`Test — FLY-1364 cmux sync repair` 771 秒。同步目标主干 run `36298975675` 同一 job 成功，
对应 898 / 66 / 675 秒；再往前三次成功主干分别约为 852 / 79 / 621、815 / 58 / 605、
877 / 80 / 636 秒（总时长 / Build / cmux）。本 PR 相对同步后主干只改动两个 retention
registry JSON，没有修改 `.github/workflows`、`scripts/__tests__` 或该 shard 的命令。因此
现有证据指向 runner/host 时间波动，而不是 FLY-2778 向 4/6 增加了脚本负载；按 Lead 裁定
不做无归属的 CI 重排，新的 exact-head full CI 留给 QA 冻结后验证。
