# FLY-2661 机器试判历史按需生成 — 实施计划
Issue: FLY-2661 (https://linear.app/geoforge3d/issue/FLY-2661/报告托管省量-机器试判历史页停止定时托管发布改为按需手动生成worker-每-30-分钟-24-页全量重发把-vercel-blob)
日期: 2026-09-16
基于: research.md

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The injected implement TURN forbids successor dispatch, so execution stays inline in this worktree.

**Goal:** 完全移除机器试判历史的自动托管发布，并提供一条只读、按需、本地单文件生成命令。

**Architecture:** Bridge 不再构造任何 history timer/publisher；它只在已有 master-token loopback 路由后读取 `ShipJudgmentHistory` 并返回静态 HTML。`flywheel-comm` 对响应做类型/大小验证并原子写 `--out`，不会接触 report registry、Blob 或 publish-report。Epic HTML 只显示按需说明；迁移层共享窄指纹，跳过无标题的旧自动历史页。

**Tech Stack:** TypeScript, Express, better-sqlite3, Vitest, Node fs, pnpm monorepo.

---

## 文件结构

- 修改 `packages/teamlead/src/ship-judgment/history-pages.ts`：增加无托管 origin、无分页 URL 的全量单文件 renderer；复用现有行 schema、转义和 2KiB 行预算。
- 修改 `packages/teamlead/src/bridge/ship-judgment-read-routes.ts`：增加 `GET /history/render?project=flywheel`，保持 master-token mount 和只读事务。
- 新增 `packages/flywheel-comm/src/commands/ship-judgment-history.ts`：严格解析 `render --project flywheel --out *.html`，有界拉取 HTML，原子落盘。
- 新增 `packages/flywheel-comm/src/commands/__tests__/ship-judgment-history.test.ts`：CLI 红绿、无上传、失败不留半文件。
- 修改 `packages/flywheel-comm/src/index.ts`：注册新顶层命令与 help。
- 修改 `packages/teamlead/src/bridge/__tests__/ship-judgment-routes.test.ts`：验证 auth、HTML、只读、未来 `next_due_at` 无副作用及 CLI 整链。
- 修改 `packages/teamlead/src/bridge/plugin.ts`：删除 history runtime 构造、启动、停止和 Epic refresh 回调。
- 删除 `packages/teamlead/src/bridge/ship-judgment-history-runtime.ts`、`packages/teamlead/src/ship-judgment/history-runtime.ts`、`packages/teamlead/src/ship-judgment/history-publisher.ts` 及只覆盖自动发布的测试文件。
- 收窄 `packages/teamlead/src/ship-judgment/history-state.ts` 为旧 published-state 的只读 view；删除 `StateStore.getShipJudgmentHistoryState()` 和自动 lease/state 测试，保留数据库列/触发器兼容已有生产库。
- 修改 `packages/teamlead/src/epic-page/render-html.ts` 与判断渲染测试：移除 href，显示固定按需说明；Markdown 本地预览和 audit sidecar 保留。
- 修改 `packages/teamlead/src/bridge/report-registry.ts`、`report-hosting-migration.ts` 及迁移/retarget 测试：两条搬运路径共同跳过旧自动历史页指纹。
- 新增 `packages/teamlead/src/bridge/__tests__/ship-judgment-history-disabled.test.ts`：结构性断言 `plugin.ts` 无 runtime/refresh 接线；结构删除比 timer mock 更强，外部 24h 假时钟没有可触发路径。

### Task 1: 先钉死零自动发布

**Files:**
- Create: `packages/teamlead/src/bridge/__tests__/ship-judgment-history-disabled.test.ts`
- Modify: `packages/teamlead/src/bridge/plugin.ts`
- Delete: `packages/teamlead/src/bridge/ship-judgment-history-runtime.ts`
- Delete: `packages/teamlead/src/bridge/__tests__/ship-judgment-history-runtime.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
it("has no production history publisher or Epic refresh wiring", () => {
  const source = readFileSync(new URL("../plugin.ts", import.meta.url), "utf8");
  expect(source).not.toContain("createShipJudgmentHistoryRuntime");
  expect(source).not.toContain("shipJudgmentHistoryRuntime");
  expect(source).not.toContain('requestRefresh("flywheel", "ship_judgment_history")');
});
```

- [ ] **Step 2: 运行红灯**

Run: `VITEST_MAX_FORKS=1 pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/ship-judgment-history-disabled.test.ts --maxWorkers=1`

Expected: FAIL，命中当前三个生产接线标识。

- [ ] **Step 3: 最小删除接线**

从 `plugin.ts` 删除 import、factory 调用、`start()`、`stop()` 与 `ship_judgment_history` refresh callback，并删除 bridge adapter 与其测试。不得增加 feature flag、env 或替代 timer。

- [ ] **Step 4: 运行绿灯**

Run: 同 Step 2。

Expected: 1 test PASS。

### Task 2: 实现单文件只读 renderer 与 Bridge 路由

**Files:**
- Modify: `packages/teamlead/src/ship-judgment/history-pages.ts`
- Modify: `packages/teamlead/src/bridge/ship-judgment-read-routes.ts`
- Modify: `packages/teamlead/src/bridge/__tests__/ship-judgment-routes.test.ts`

- [ ] **Step 1: 写 renderer 和路由红测**

测试插入 21 行以上数据并断言：响应是一个完整 HTML、包含第一页和第二页的事项、没有 `reports.example`/`rel="next"`、转义 `<script>`；请求前后 `total_changes()` 相等；把 `next_due_at` 设为 `2026-12-31T00:00:00.000Z` 后响应相同；无 token 为 401，额外 query 为 400。

```ts
const response = await fetch(`${origin}/api/ship-judgment/history/render?project=flywheel`, { headers });
expect(response.headers.get("content-type")).toMatch(/^text\/html/);
expect(await response.text()).toContain("本文件由 Lead 按需生成，尚未上传");
```

- [ ] **Step 2: 运行红灯**

Run: `VITEST_MAX_FORKS=1 pnpm --filter flywheel-teamlead exec vitest run src/ship-judgment/__tests__/history-pages.test.ts src/bridge/__tests__/ship-judgment-routes.test.ts --maxWorkers=1`

Expected: FAIL，`renderHistoryDocument`/route 不存在。

- [ ] **Step 3: 最小实现**

新增：

```ts
export function renderHistoryDocument(input: HistoryRow[], asOf: string): string {
  const rows = input.map((row) => historyRowSchema.parse(row));
  utc.parse(asOf);
  return injectHeadMeta(`<!doctype html>...${rows.map(renderRow).join("")}...`);
}
```

路由只接受严格 `{ project: "flywheel" }`，调用 `store.getShipJudgmentHistory().read(now().toISOString())`，以 `res.type("html").send(renderHistoryDocument(snapshot.rows, snapshot.asOf))` 返回；异常统一 503 `history_render_failed`。

- [ ] **Step 4: 运行绿灯**

Run: 同 Step 2。

Expected: renderer 与 route tests 全 PASS，数据库 changes 不变。

### Task 3: 新增 flywheel-comm 按需命令

**Files:**
- Create: `packages/flywheel-comm/src/commands/ship-judgment-history.ts`
- Create: `packages/flywheel-comm/src/commands/__tests__/ship-judgment-history.test.ts`
- Modify: `packages/flywheel-comm/src/index.ts`
- Modify: `packages/teamlead/src/bridge/__tests__/ship-judgment-routes.test.ts`

- [ ] **Step 1: 写 CLI 红测**

覆盖：成功只有一次 loopback GET、Authorization master token、无请求 body、输出 HTML 字节相等；重复/未知参数、非 flywheel、非 `.html`、非 loopback、缺 token、HTTP 非 2xx、非 HTML、超过 32MiB 均失败；失败时旧文件保持或目标不存在；测试依赖注入 `writeAtomic`，断言没有 publish 调用。

```ts
expect(await runShipJudgmentHistory(["render", "--project", "flywheel", "--out", output], deps)).toBe(0);
expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ rendered: true, project: "flywheel", out: output });
```

- [ ] **Step 2: 运行红灯**

Run: `VITEST_MAX_FORKS=1 pnpm --filter flywheel-comm exec vitest run src/commands/__tests__/ship-judgment-history.test.ts --maxWorkers=1`

Expected: FAIL，命令模块不存在。

- [ ] **Step 3: 最小实现与注册**

`runShipJudgmentHistory` 使用 `parseArgs({ strict:true, tokens:true })`，拒绝重复 option；`assertLoopbackCarrierUrl` 限制 Bridge；流式读取响应并在 32MiB 处 cancel；验证 `text/html` 与完整 `<html>`/`</html>`；临时文件使用 `wx`，成功后 rename 到目标，catch 时删除临时文件。`index.ts` 增加 help、import 和 case：

```ts
case "ship-judgment-history":
  process.exitCode = await runShipJudgmentHistory(commandArgs);
  break;
```

- [ ] **Step 4: 运行 CLI 单测与 Bridge 整链绿灯**

Run: Task 3 Step 2，然后重跑 `ship-judgment-routes.test.ts`。

Expected: 全 PASS，命令输出本地文件且 registry/Blob API 未被调用。

### Task 4: 移除托管 runtime/publisher 实现，保留兼容只读状态

**Files:**
- Delete: `packages/teamlead/src/ship-judgment/history-runtime.ts`
- Delete: `packages/teamlead/src/ship-judgment/history-publisher.ts`
- Delete: `packages/teamlead/src/ship-judgment/__tests__/history-runtime.test.ts`
- Delete: `packages/teamlead/src/ship-judgment/__tests__/history-publisher.test.ts`
- Delete: `packages/teamlead/src/ship-judgment/__tests__/history-integration.test.ts`
- Delete: `packages/teamlead/src/ship-judgment/__tests__/history-state.test.ts`
- Delete: `packages/teamlead/src/ship-judgment/__tests__/history-dirty.test.ts`
- Modify: `packages/teamlead/src/ship-judgment/history-state.ts`
- Modify: `packages/teamlead/src/StateStore.ts`

- [ ] **Step 1: 静态引用检查**

Run: `rg -n "ShipJudgmentHistoryRuntime|HistoryReportPublisher|getShipJudgmentHistoryState" packages/teamlead/src --glob '!dist/**'`

Expected before cleanup: 仅自动发布模块、测试和 StateStore factory 命中。

- [ ] **Step 2: 删除不可达自动实现**

删除 runtime、publisher 与专属测试；`history-state.ts` 只保留读取旧 `published_url/published_as_of/last_error/history_dirty` 的 `view()`，供兼容 Epic snapshot 使用；删除 StateStore factory/import。数据库 schema 和 dirty triggers 不改，避免生产迁移与机器试判写路径扩 scope。

- [ ] **Step 3: 静态与 focused green**

Run: 上述 `rg` 应零命中（若只读类名保留则仅允许 `ShipJudgmentHistoryState` 在 `epic-history.ts/history-state.ts`）；运行 `history-query.test.ts`、`epic-history.test.ts`、Task 1/2 测试。

Expected: 全 PASS；`next_due_at` 无消费方。

### Task 5: Epic 固定页只显示按需说明

**Files:**
- Modify: `packages/teamlead/src/epic-page/render-html.ts`
- Modify: `packages/teamlead/src/epic-page/__tests__/judgment-render.test.ts`
- Modify: `packages/teamlead/src/epic-page/__tests__/optional-budget.test.ts`

- [ ] **Step 1: 写红测**

把现有“查看近 30 天历史”断言改为：所有 HTML 变体不含旧 URL、不含 `data-history-link`，恰含一次 `机器试判历史按需生成`；Markdown 仍含 `最近 20 / 150 条`；audit sidecar 仍保留 cell。

- [ ] **Step 2: 运行红灯**

Run: `VITEST_MAX_FORKS=1 pnpm --filter flywheel-teamlead exec vitest run src/epic-page/__tests__/judgment-render.test.ts src/epic-page/__tests__/optional-budget.test.ts --maxWorkers=1`

Expected: FAIL，当前 footer 仍包含 href/旧文案。

- [ ] **Step 3: 最小实现**

```ts
function renderJudgmentHistory(page: EpicPage, dictionary: RenderAudit): string {
  const cell = page.ship_judgment_history;
  if (!cell) return "";
  dictionary.sidecar?.add(cell);
  return "<footer data-history-on-demand>机器试判历史按需生成</footer>";
}
```

不改 Markdown preview、不改审计 sidecar、不改机器意见 item rendering。

- [ ] **Step 4: 运行绿灯**

Run: 同 Step 2。

Expected: 全 PASS。

### Task 6: 两条迁移路径跳过旧自动历史页

**Files:**
- Modify: `packages/teamlead/src/bridge/report-registry.ts`
- Modify: `packages/teamlead/src/bridge/report-hosting-migration.ts`
- Modify: `packages/teamlead/src/__tests__/report-hosting-migration.test.ts`
- Modify: `packages/teamlead/src/__tests__/report-hosting-retarget.test.ts`

- [ ] **Step 1: 写两条红测**

创建三条：无标题机器历史、无标题普通报告、有标题机器历史。初始 migration 和 retarget 都必须只跳过第一条；断言第一条 token 不进入 `putMigratedReport`、gateway manifest 和验证 token 集合，另外两条仍迁移。

- [ ] **Step 2: 运行红灯**

Run: `VITEST_MAX_FORKS=1 pnpm --filter flywheel-teamlead exec vitest run src/__tests__/report-hosting-migration.test.ts src/__tests__/report-hosting-retarget.test.ts --maxWorkers=1`

Expected: FAIL，旧自动历史 token 仍上传。

- [ ] **Step 3: 共享窄判定与最小实现**

```ts
export function isReportHostingMigrationEligible(entry: ReportEntry, html: string): boolean {
  return Boolean(entry.title?.trim()) || !html.includes("<title>机器试判历史</title>");
}
```

`migrateReportHostingLocked` 在保留集里缓存 HTML 并过滤；`retainedSnapshot` 在摘要/内容/manifest 计算前应用同一 predicate。不得仅在 upload loop 过滤，否则 CAS digest 与 gateway manifest 会漂移。

- [ ] **Step 4: 运行绿灯**

Run: 同 Step 2。

Expected: 两套迁移测试全 PASS。

### Task 7: 回归、全仓门与代码评审

**Files:**
- Modify: `engineering/doc/FLY-2661-manual-history-render/progress.md`
- Create last: `engineering/doc/milestones/FLY-2661.md`

- [ ] **Step 1: focused regression**

Run: 受影响的 history/query/Epic/routes/CLI/migration suites，`VITEST_MAX_FORKS=1`。

Expected: 全部测试通过且有非零 test count。

- [ ] **Step 2: repository gates**

Run in order:

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
```

再运行所有本次新增或修改的 `scripts/__tests__/*.test.sh`（若 diff 中没有则记录 none）。Expected: 退出 0；若 package gate 仅有允许的 onTaskUpdate RPC 错误，保存完整 PACKAGE_GATE_RECEIPT，不把 focused green 冒充 aggregate green。

- [ ] **Step 3: 检查范围与不变量**

Run:

```bash
rg -n "ShipJudgmentHistoryRuntime|HistoryReportPublisher|ship_judgment_history" packages/teamlead/src/bridge/plugin.ts
git diff --check
git status --short
```

Expected: 第一条零命中；diff 无 whitespace error；只包含 FLY-2661 文件。

- [ ] **Step 4: 提交实现、更新 progress、写 literal-last milestone**

先提交实现与普通文档，更新 progress；所有验证文本稳定后，按 `engineering/doc/milestones/README.md` 新建 `FLY-2661.md` 并作为 PR 前字面最后 commit。不得在 milestone 后改头，除非重新评审/CI。

- [ ] **Step 5: 请求有效代码评审**

运行 `stage set code_review`，打开 `review_code` gate（带必需 message）并 `request-review --type code`；按 questionId 轮询。CHANGES_REQUESTED 只修阻塞 finding 并开新 gate；APPROVED advisories 用 `ask --report` 转 Lead。

- [ ] **Step 6: push、PR 与 exact-head CI**

正常 push feature branch，创建 PR；核对 PR head == `git rev-parse HEAD`，等待 exact-head CI。不得 force push、merge、deploy、dispatch QA。

- [ ] **Step 7: 结构化交接**

在 completion 前按 runner-memory closeout 合同写最多 5 条可复用判断（若无则不写），发送 `ask --report "DONE: ..."`，再执行：

```bash
node "$FLYWHEEL_COMM_CLI" complete --route needs_review --pr <PR_NUMBER>
```

Expected: `session_completed` receipt，route=`needs_review`；未 merge、未 deploy、未 QA dispatch。

## 自检

- Spec coverage：验收 1→Tasks 1/4/7；2→Tasks 2/3；3→Task 5 + Task 1 refresh 删除；4→Task 6；5→Tasks 2/4；6→Task 7 focused/aggregate gates。
- Placeholder scan：无 TBD/TODO/“类似前文”；每一行为变更都有文件、命令和期望结果。
- 类型一致性：服务端函数名 `renderHistoryDocument`，CLI 函数名 `runShipJudgmentHistory`，route `/api/ship-judgment/history/render`，顶层命令 `ship-judgment-history` 在全文一致。
- Scope：不修改机器判断 verdict、评论 delivery、outcome 或 learning；不部署、不清生产库、不改 `next_due_at`。
