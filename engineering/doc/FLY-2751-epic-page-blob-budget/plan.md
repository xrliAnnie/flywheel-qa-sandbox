# FLY-2751 Epic 固定页 Blob 预算 — 实施计划
Issue: FLY-2751 (https://linear.app/geoforge3d/issue/FLY-2751/托管额度-epic-固定页每个事件都自动重发14h-159-次每次-4-次-blob-写列删-免费档-2000)
日期: 2026-09-18
基于: research.md

> **执行约束：** 严格按本计划 TDD；每一步先看到目标测试失败，再做最小实现。不得部署、dispatch QA、请求 ship 或合并。

## 目标

自动 fixed page 只因 page/presentation 实质变化或 24h TTL keepalive 写入；自动成功发布至少间隔 15 分钟且到期重新物化最后状态。显式 `epic-page generate` 立即发布，只读命令不发布。每次 publish 不再 list，audit 失败孤儿由每日 sweep 收敛。

## Task 1：page semantic + presentation digest

**文件：**

- 修改 `packages/teamlead/src/epic-page/__tests__/model.test.ts`
- 修改 `packages/teamlead/src/epic-page/model.ts`
- 修改/新增 `packages/teamlead/src/epic-page/*presentation*.ts` 及对应测试（按现有 helper 归属落点）

**RED**

- 参数化证明 `generator`、`freshness`、标量 version、`generated_at/observed_at/source_updated_at/observedAt` 原值变化不改变 page digest。
- 参数化反例证明正文、可见 counts、`since`、lead note `written_at` 改变 digest。
- 同一个 page 的 now 跨 deployment 12h stale 阈值、attention wait/drift hour bucket 时 presentation digest 改变；同一桶内不变。

**GREEN**

- `hostedContentDigest()` 移除整个 generator 并补 camelCase sampling timestamp。
- 新建可测试的 hosted presentation state/digest，复用 renderer 的 stale/wait/drift 计算，禁止复制不同阈值。
- publisher 的最终 content digest 组合 page semantic + presentation state。

## Task 2：publisher 15 分钟 backstop 与 24h TTL keepalive

**文件：**

- 修改 `packages/teamlead/src/__tests__/epic-page-publisher.test.ts`
- 修改 `packages/teamlead/src/bridge/epic-page-publisher.ts`
- 修改 `packages/teamlead/src/StateStore.ts` 及 outcome parser 测试

**RED**

- 自动相同 digest 在 `<24h` 为 `unchanged_digest`，跨 `>=24h` 只做一次 TTL keepalive。
- presentation digest 跨 12h stale 阈值视为变化。
- 实质变化在最近成功发布后 `<15m` 返回 `ok_unpublished:<v>:minimum_interval` 且 Blob 0 调用，到 `>=15m` 发布。
- explicit manual publish 同内容且窗口内仍发布；普通 manual read 不进入 publisher（Task 4 覆盖）。
- invalid/未发布 timestamp 无 cooldown；future timestamp delay 最多 15m；失败不推进成功时间。

**GREEN**

- 导出 `EPIC_PAGE_MIN_PUBLISH_INTERVAL_MS`，critical section 顺序为：自动同 digest 且 `<24h` skip；自动任何变化且 `<15m` delay；否则发布。
- `publishHosted(page, { force: true })` 显式绕过 digest/interval；hosting retarget 与普通自动更新一样在 15m 内完成。
- 新增 parser outcome `minimum_interval`；拆分 accepted-delay 与 hosted-equivalent，避免 retry failure/dirty intake 误清。

## Task 3：refresher admission 预排程与 trailing 最新态

**文件：**

- 修改 `packages/teamlead/src/bridge/__tests__/epic-page-refresher.test.ts`
- 修改 `packages/teamlead/src/bridge/epic-page-refresher.ts`
- 修改 `packages/teamlead/src/bridge/plugin.ts` wiring
- 修改 `packages/teamlead/src/__tests__/lead-note-e2e.test.ts`

**RED**

- fake clock 回放 60 分钟 11 个真实注册 reason：attempt/publish 都 `<=4`。
- cooldown 内 reasons 合并；due 时 materializer 读取最后 source 值，首个未发布变化最迟 15 分钟被发布。
- publisher race 返回 `minimum_interval` 时 reasons 重新入队，不立即循环。
- `flushForTest()` 面对未来 cooldown 不空转；lead-note set/clear 测试显式推进 15 分钟后验证最终页。

**GREEN**

- request admission 读取 publication；valid published timestamp 的剩余 delay clamp 到 `[0,15m]`，timer 取 `max(5s, remaining)`。
- due 时才运行 attempt；publisher backstop 的 delayed outcome 复用同一排程 helper。
- `flushForTest()` 只 flush 当前 debounce/drain，保留未来 cooldown timer。

## Task 4：区分显式手动发布与只读 manual

**文件：**

- 修改 `packages/flywheel-comm/src/commands/epic-page.ts`
- 修改 `packages/flywheel-comm/src/commands/__tests__/epic-page.test.ts`
- 核对/修改 `packages/flywheel-comm/src/commands/__tests__/dependency.test.ts`
- 修改 `packages/teamlead/src/bridge/epic-page-route.ts`
- 修改 `packages/teamlead/src/bridge/__tests__/epic-page-route.test.ts`
- 修改 `packages/teamlead/src/bridge/epic-page-refresher.ts` attempt input/逻辑
- 修改 `packages/teamlead/src/__tests__/epic-page-liveness.e2e.test.ts`

**RED**

- CLI 只有 `epic-page generate` 发送 `{publish:true}`；show/render/dependency show 请求体没有该字段。
- route 只接受严格布尔 publish intent；read manual 保持 `ok_unpublished:*:manual` 且 publisher 0 调用。
- publish manual 调 publisher、立即 put，并证明 materialized page 含 production 同源的 deployment 与 ship-judgment history。

**GREEN**

- `EpicPageAttemptInput` 增加仅 manual 可用的 explicit publish intent；event/scan 逻辑不变。
- route 补 `readDeployment`、`readShipJudgmentHistory`，拒绝未知/非布尔 option。
- attempt 只对 explicit intent 调 `publishHosted(page, { force: true })`；publisher 不把 `trigger=manual` 本身当写权限。

## Task 5：publish 定点 DEL + daily orphan sweep

**文件：**

- 修改 `packages/teamlead/src/__tests__/epic-audit-blob.test.ts`
- 修改 `packages/teamlead/src/__tests__/report-blob-store.test.ts`
- 修改 `packages/teamlead/src/__tests__/report-hosting-maintenance.test.ts`
- 修改 `packages/teamlead/src/bridge/report-blob-store.ts`
- 修改 `packages/teamlead/src/bridge/report-hosting-maintenance.ts`

**RED**

- 旧 HTML current + previous，新发布后只 DEL old previous，保留 new current + old current；publish `list=0`。
- 相同 hash retry、A→B→A、gzip、audit/HTML/registry/DEL 失败均不删当前/上一版。
- daily sweep 对 mutable audit 使用自身 uploadedAt，GET HTML 保护 current/previous，删除满 14 天 orphan；GET/解析失败 fail closed；普通 immutable TTL 行为不变。

**GREEN**

- `putEpicPage()` 解析 `oldHash/oldPrevious`，afterCommit 对唯一 obsolete path best-effort `del`，删除逐 publish 的 `auditPaths()`。
- maintenance 把 registry 中 `mutable` tokens 传给 sweep；sweep 每个 active mutable token 至多 GET 一次，只有 daily path 使用全量 list。

## Task 6：一小时 counting Blob client 验收

**文件：**

- 新增 `packages/teamlead/src/__tests__/epic-page-blob-budget.test.ts`（若复用现有 harness 更小则扩展 liveness e2e）

串起 refresher → attempt → publisher → `VercelBlobReportStore`：

- 回放工单观测频率的一小时 11 个注册 reason，publish `<=4`、publish-path `list=0`。
- 全部只改变 generator/sampling fields 时新增 put=0。
- 每个稳态 publish 为 1 GET + 2 PUT + 至多 1 DEL；最后 HTML/audit 是 cooldown 内最后状态。
- explicit manual generate 在窗口内立即多一次 publish；show/render 不增加调用。
- fixture 注释说明它来自 159/14h 频率与注册 reason，而非生产 DB 逐行导出。

## Task 7：受影响兼容套件

- 更新 liveness e2e：相同 scan 为 unchanged，manual read/publish 分开，24h keepalive 明确。
- 更新 lead-note e2e 的 fake clock，不用 `flushForTest` 绕过 cooldown。
- 更新 route/CLI tests，证明读路径不写和完整 materializer。
- 保留 hosting-not-configured/unsupported、credential/binding、size、registry/publication failure、intake CAS 行为。

## Task 8：验证、评审与交付

1. focused suites（显式路径）：model、publisher、refresher、route、audit Blob、report Blob/maintenance、lead-note、liveness、budget，以及 flywheel-comm epic-page/dependency tests。
2. 运行 `pnpm lint`、`pnpm -r build`、`pnpm test:packages:run`；package gate 若仅 host RPC unreached，按注入规则运行单 fork 明确套件并保存 receipt。
3. 检查 inbox，更新 progress；提交实现和文档。
4. 写 `engineering/doc/milestones/FLY-2751.md` 作为 literal last commit。
5. push feature branch，发起有效 code review；blocking finding 修复后新开 review，最终 HEAD 通过。
6. 开 PR；本 implement handoff 未冻结 current head，不运行 `ci-full ensure`。
7. runner-memory closeout（仅有可复用新判断时）、`ask --report`、`complete --route needs_review --pr <number>`。

## 明确不做

- 不删 24h TTL keepalive，不改 14 天 report retention。
- 不新增持久表/独立定时器；复用现有 refresher 和 daily Blob sweep。
- 不把正文业务 count 当噪音，不把巡检 read 命令变成 publish。
- 不实现月度硬预算/套餐升级策略；研究文档已明确 15m cap 的最坏值仍可超过 2,000/月。
- 不改 `CLAUDE.md`，不部署、不使用生产 credential、不 dispatch QA、不 merge。
