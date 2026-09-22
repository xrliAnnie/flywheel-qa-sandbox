# FLY-2751 Epic 固定页 Blob 预算 — 设计修正
Issue: FLY-2751 (https://linear.app/geoforge3d/issue/FLY-2751/托管额度-epic-固定页每个事件都自动重发14h-159-次每次-4-次-blob-写列删-免费档-2000)
日期: 2026-09-18
基于: plan.md

## 权威范围变更

Founder 2026-09-18 23:52Z 原话：

> 「ok fine let's avoid Epic 固定页 too..... just update it when I asked for it」

Lead 指令 `[lead-instruction bd0c2d5e-cf64-4eac-9cae-2821f430e3be]` 将实现范围改为：Epic 固定页不再因自动事件或自动 scan 发布；只有显式手动 `epic-page` 命令（founder/Lead 明确要求刷新）可以上传。15 分钟节流不再需要。原 plan 保留为设计历史，本文件覆盖其中关于自动 digest/presentation 发布、cooldown 与 24h keepalive 的实施安排。

## 修正后的行为合同

| 入口 | 是否重新物化/记 receipt | 是否调用 hosted publisher | Blob 预期 |
|---|---|---|---|
| event refresher | 保留现有本地物化与 refresh history，避免破坏调用方 | 否 | put=0, list=0 |
| residual scan | 保留现有 scan/诊断入口 | 否 | put=0, list=0 |
| `epic-page show` / `render` | 是，只读响应 | 否 | put=0, list=0 |
| `dependency show` | 是，只读响应 | 否 | put=0, list=0 |
| 显式 `epic-page publish` | 是，使用完整 production 数据面 | 是，立即且强制 | 一次发布，list=0 |

Lead 2026-09-19 补充指令 `[lead-instruction 9582f5ab-84a8-480a-bf98-06666cb709ff]` 确认 FLY-2720 已取消、PR 已关闭；本单不再为“两小时播报”保留任何自动发布入口。event/scan 只做本地物化，唯一 hosted 写入口是显式 `epic-page publish`。

## 实现计划（覆盖原 plan）

### Task C1：给手动发布建立显式意图

**文件：**

- `packages/flywheel-comm/src/commands/epic-page.ts`
- `packages/flywheel-comm/src/commands/__tests__/epic-page.test.ts`
- `packages/flywheel-comm/src/commands/__tests__/dependency.test.ts`
- `packages/teamlead/lead-rules-base/runner-patrol-rules.md`
- `packages/teamlead/lead-rules-base/legacy-token-savings/runner-patrol-rules.md`
- `packages/teamlead/src/bridge/epic-page-route.ts`
- `packages/teamlead/src/bridge/__tests__/epic-page-route.test.ts`
- `packages/teamlead/src/bridge/epic-page-refresher.ts`
- `packages/teamlead/src/bridge/__tests__/epic-page-refresher.test.ts`
- `packages/teamlead/src/bridge/epic-page-publisher.ts`
- `packages/teamlead/src/__tests__/epic-page-publisher.test.ts`
- `packages/teamlead/src/StateStore.ts`

**RED**

- 新增独立 `epic-page publish`，只有它发送严格布尔 `{publish:true}`；既有 generate/show/render/dependency show 不发送，原命令语义不变。
- route 拒绝非布尔/未知 option；普通 manual 继续 `ok_unpublished:<v>:manual` 且 publisher 0 调用。
- explicit manual 调 `publishHosted(page, {force:true})`；同 digest、24h 内仍恰好发布一次。
- route materializer 对 read 与 publish 无条件包含 production 路径已有的 deployment 与 ship-judgment history，保证预览与发布同形且不发布降级页。
- 新 CLI 打到未升级 Bridge 时 400 fail closed；部署/启用顺序明确为 Bridge 先接受 option，再允许调用新命令。

**GREEN**

- `EpicPageAttemptInput` 增加 `publishHosted?: boolean`，只允许 `trigger=manual` 使用。
- `EpicPagePublisher.publishHosted` 增加显式 `force` option；publisher 不从 `trigger=manual` 猜写权限。
- route 无条件补齐 `readDeployment` 与 `readShipJudgmentHistory`，把 request intent 传给 attempt。
- StateStore 保留 manual unpublished outcome；不新增 15 分钟 outcome。
- 两份当前 Lead rules 保留“show/render/generate 不刷新”并新增：只有 founder/Lead 明确要求时才运行 `epic-page publish`。

### Task C2：自动 event/scan 永不上传

**文件：**

- `packages/teamlead/src/bridge/epic-page-refresher.ts`
- `packages/teamlead/src/bridge/__tests__/epic-page-refresher.test.ts`
- `packages/teamlead/src/bridge/epic-residual-scan.ts`（仅在测试证明需要时改；入口必须保留）
- `packages/teamlead/src/__tests__/epic-page-liveness.e2e.test.ts`
- `packages/teamlead/src/__tests__/lead-note-e2e.test.ts`

**RED**

- event attempt 即使注入 publisher 也不调用，记录明确的 `ok_unpublished:<v>:event`。
- scan attempt 同样不调用 publisher，记录 `ok_unpublished:<v>:scan`。
- 回放一小时 11 个注册 refresh reason，counting Blob client 的 put=0、list=0。
- 连续 3 次以上 `epic_intake` event 后，retry failures 仍为 0、`notRefreshable=false`，且本轮捕获的 dirty rows 经 revision CAS 清零；unpublished 不是 publish failure。
- refresher 与 scan 的本地物化职责保留，但不能作为 hosted publisher 入口。

**GREEN**

- `runEpicPageAttempt` 只有 `trigger=manual && publishHosted===true` 进入 publisher；其余 trigger 在 receipt 后以明确 unpublished outcome settle。
- `EPIC_PAGE_REFRESH_OUTCOMES`/parser 接受 event/scan unpublished outcome。
- 拆开 `isLocalRefreshSuccess` 与 `isHostedOutcome`：本地 materialize+receipt 成功就重置 intake retry 并调用现有 revision-CAS clear；只有真正 `ok:` 才更新 hosted publication。
- 删除原 plan 的 cooldown/minimum-interval 实现；5 秒 debounce 只影响本地物化成本，不产生 Blob 请求。

### Task C3：publish audit cleanup 不再 list

**文件：**

- `packages/teamlead/src/bridge/report-blob-store.ts`
- `packages/teamlead/src/__tests__/epic-audit-blob.test.ts`
- `packages/teamlead/src/__tests__/report-blob-store.test.ts`（仅回归 daily sweep）

**RED**

- 旧 HTML 同时含 current hash 与 `data-previous-audit`；新发布 afterCommit 只 DEL old previous，保留 new current + old current。
- 正常、相同 hash retry、A→B→A、gzip、audit/HTML/registry/DEL failure 都断言 publish path 的 list=0，且不删当前/上一版。
- legacy HTML 无 previous 时不猜测、不 list；已有 daily sweep 行为保持回归绿。

**GREEN**

- `putEpicPage()` 在已有 GET 中解析 `oldHash`/`oldPrevious`；afterCommit 只 best-effort DEL 唯一且不再被引用的 old previous。
- 删除 per-publish `auditPaths()` 全量扫描；不新增新的定时器或持久状态。
- 如实保留限制：失败留下的孤儿 audit 只有在该 mutable token 连续 14 天未显式发布、整个 token 过期时才由现有 sweep 回收；本单不声称 active token 的 orphan 会每日收敛。

### Task C4：预算与端到端验收

**文件：**

- 新增或扩展 `packages/teamlead/src/__tests__/epic-page-blob-budget.test.ts`
- 更新 `packages/teamlead/src/__tests__/epic-page-liveness.e2e.test.ts`

计数 fake client 串起 route/refresher → attempt → publisher → `VercelBlobReportStore`：

1. 一小时代表性 11 事件：Blob put=0、list=0。
2. 内容变化的 event/scan 仍 put=0；本地 receipt 只留证，后续显式手动 publish 必须重新物化当时的最新 source，不能复用旧 page。
3. explicit manual publish 立即且恰好发布 1 次；稳态最多 1 GET + 2 PUT + 1 DEL，list=0。
4. show/render/dependency show 不增加 Blob 调用。
5. fixture 注明来源为工单 159/14h 观测与代码注册 reason，不冒充生产 DB 逐行导出。
6. 插入超过 200 条 unpublished event/scan 后，freshness 的 `last_published` 仍来自权威 publication + 对应 receipt，publish-failure count 不增长。

### Task C5：让按需页面与 TTL 状态说真话

**文件：**

- `packages/teamlead/src/epic-page/render-html.ts`
- 对应 renderer snapshot/markup tests
- `packages/teamlead/src/bridge/epic-page-route.ts`
- `packages/teamlead/src/bridge/__tests__/epic-page-route.test.ts`
- `packages/teamlead/src/StateStore.ts` 及 freshness tests

**RED/GREEN**

- 顶栏从“系统自己刷新”改为“按需刷新”，明确页面是生成时快照；deployment/attention 的健康与等待结论注明“截至本页生成时间”，避免旧页冒充实时状态。
- status publication 增加由权威 `last_published_at + 14d` 推导的 `expires_at`；未发布为 null。它给 Lead 一个可见过期信号，不新增自动 keepalive 或外部提醒。
- `getEpicPageFreshness.last_published` 以 `epic_page_publication` 为权威，并用对应 `epic_page` receipt/version 恢复 trigger；200 条 unpublished history 不再抹掉真实发布。

### Task C6：修正 hosting retarget 操作提示

**文件：**

- `scripts/migrate-report-hosting.ts`
- 对应 migration script tests/fixtures

- 删除“Epic audit 下一次刷新补齐”的自动承诺。
- 改成明确收尾：升级/重启后的 Bridge 接受新命令后，操作者显式运行 `flywheel-comm epic-page publish --project <name>` 并验证 stable URL。脚本不自行发布、不使用真实凭据。

## 改后 Blob 预算

- event-driven 自动发布：0 次/天，原 159/14h 的来源被完全切断。
- 每次显式 `epic-page publish`：首次/无 old previous 为 1 GET + 2 PUT = 3 次；稳态至多再加 1 DEL = 4 次。
- 现有 daily retention sweep 的 store-wide LIST 独立保留，不属于每次 fixed-page publish。

## 明确接受的结果

- 不再做自动语义 digest gate、presentation-time digest、15 分钟 cooldown 或 24h keepalive；没有自动 publisher 调用，它们不再影响 Blob 预算。
- 固定链接仍服从现有 14 天 TTL；14 天没有显式刷新时可过期，status 预先暴露 `expires_at`，下一次显式 publish 强制重建。这与 founder 的“when I asked for it”一致。
- FLY-2720 已取消；不保留也不重建两小时自动发布策略。
- event/scan 仍每个 debounce 做一次 Linear active-scope 物化、写 receipt 并推进版本；这是为保持现有入口/intake 状态机而接受的非 Blob 成本。本单不另改频率。
- 不新增月度硬预算、定时任务、生产写入、部署或 QA dispatch。

## 验证与交付

Focused suites 包含：flywheel-comm epic-page/dependency；teamlead publisher、refresher、route、StateStore freshness/intake、renderer、audit Blob、Blob store、liveness、lead-note、budget、规则同步与 migration script。随后运行 `pnpm lint`、`pnpm -r build`、`pnpm test:packages:run`，再按正常 code review、milestone literal-last、push、PR 与 `needs_review` completion 流程交付；不请求 full CI、不 merge。
