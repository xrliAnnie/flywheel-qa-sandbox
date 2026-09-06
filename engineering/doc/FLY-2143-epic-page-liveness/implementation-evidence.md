# FLY-2143 Epic 页面活化 — 实施证据
Issue: FLY-2143 (https://linear.app/geoforge3d/issue/FLY-2143/2108d-epic-页面活化事件扫描双路更新过期自报卡住上页可见)
日期: 2026-09-05
基于: implementation-notes.md

## 1. 实施与 TDD 轨迹

基线为 `79f6fc39b`；批准设计为 `03b1e6f33`。行为代码按 M0–M11 小步提交，进度账本在每个块后单独提交。

| 块 | RED 证据 | GREEN 提交 / 定向证据 |
|---|---|---|
| M0 model/receipt | signals 形状、非法键、id8、source pointer、reasons/receipt mismatch 先失败 | `57f71c4d4`; `model.test.ts`, `receipt.test.ts` |
| M1 StateStore | table CHECK、CAS token、200-row retention、freshness counterexamples、version drift、7 个 statusChanged 状态先失败 | `13a9e95e5`; `statestore-epic-page.test.ts` 与 FLY-2006 retention tests |
| M2a CommDB | 分类、泄漏哨兵、窗口/LIMIT/500 上界、旧 schema、重复行 starvation 先失败 | `9cb105628`, latest-stop correction `951e5ff7b`; `epic-page-signals.test.ts` |
| M2b signals | 五类、两源 fail-soft、finally close、前缀碰撞与 held run fallback 先失败 | `dadb9b680`; `signals.test.ts` |
| M3 materialize/freshness | 九个 freshness Cell、oldest/next scan、stuck 排序与 prospective version 先失败 | `5447f2a68`; `freshness.test.ts`, `materialize.test.ts`, `generate.test.ts` |
| M4 rendering | nonce script、无 CSP、静态 generated_at、年龄更新、stuck/waiting 分栏、自由文本哨兵先失败 | `9ba2821a0`; HTML/Markdown render tests |
| M5 stable publish primitives | token ownership、覆盖开关、稳定 registry、1000 entries、14-day boundary、三方并发先失败 | `e06a36ea1`; registry/blob/critical-section/reports tests |
| M6 publisher | P0–P4、唯一 outcome、same-token retry、hosting truth table、512 KiB 先失败 | `b2c10ced3`; `epic-page-publisher.test.ts` |
| M7 serializer/refresher/manual | burst、tailing、no-throw、single skip、one-attempt-one-row、manual no publish 先失败 | `f9fa93643`; `epic-page-refresher.test.ts`, `epic-page-route.test.ts` |
| M8 event wiring | 每类 callback 正例与 replay/no-op/reject 负例先失败 | `8ef5d5af9`; sink/event/runs/dependency/finalizer/wiring tests |
| M9 scan/tick | scan publish/failure、stuck N=0 byte identity、N>0 one line、waiting founder exclusion 先失败 | `c4eebfb48`; residual scan/model/tick tests |
| M10 status/CLI/rules | auth、URL truth、no Linear、failure fields、CLI JSON、rule grep 先失败 | `5c54b21d1`; route/CLI/rule tests |
| M11 E2E | event+scan stable token、no-op fallback、two-roads-off, Linear failure history、HTML self-check | `4225d2b6c`; `epic-page-liveness.e2e.test.ts` 4/4 |
| final branch audit | fresh generalized 409/429 coverage gap补齐；legacy delayed-session race 先红（callback 0 次） | `b1b082636`, `a38e22621`; `runs-route.dag-entry.test.ts` 55/55 |

明确记录的最后一轮 RED：

```text
FLY-2143 refreshes a legacy start after its delayed session becomes durable
expected spy to be called once, but got 0 times
```

最小修复把 legacy `run_started` callback 从 dispatcher 返回后的瞬时读取移到 `waitForSession` 成功后的 durable boundary；同一文件随后 55/55 通过。

## 2. A · 稳定地址

### A-① 最小结构

- `StateStore.ts` 仅新增 `epic_page_publication`（五列 + CHECK）和 `epic_page_refresh`。
- 无通用 `Publication*` 导出。`report-critical-section.ts` 为 22 行，只导出 `ReportCriticalSection` 与 `createReportCriticalSection`。

### A-② 窄 API 与旧语义

- 非测试 `stageEpicPageRepublish` 调用点恰一处：`epic-page-publisher.ts:67`。
- 非测试 `putEpicPage` 调用点恰一处：`epic-page-publisher.ts:77`。
- registry 拒绝非法 token 与不属于该项目 publication 的 token；blob API 分开固定页 overwrite 与普通报告 `allowOverwrite:false`。
- `reports-route.test.ts` 证明两个普通 publish 仍获得不同 token；无旧 API 删除/改名。

### A-③ stable-token / TTL / concurrency

- `report-registry.test.ts`: same token republish 只留一 entry并替换字节；`createdAt` 前进；1000 个未过期普通 entry 后刷新为 1001；恰 14 天的 Epic 先 replacement 再 prune，仍存活。
- `report-critical-section.test.ts`: ordinary publish、两个项目 Epic 与 sweep FIFO；受控并发无丢 entry；恰 14 天 republish 不被排队 sweep 误删。
- `report-blob-store.test.ts`: Epic overwrite 为 true，普通报告 false；Blob 年龄 sweep 使用最新对象 metadata。
- `epic-page-liveness.e2e.test.ts`: event 后 scan 使用同 token 与同 pathname。

### A-④ 无备选机制

无稳定地址开关、fallback token 或「不做固定页」分支。hosting 未配置/unsupported 时只明确记 `ok_unpublished:*`，不伪造 URL。

## 3. B · 信号

### B-① 有界只读 fail-soft

- `CommDB.openReadonly` + `finally close()`；SQL 使用参数、`created_at >=` 与 `LIMIT`，execution ids 硬钳 500，输出上界 1500。
- `epic-page-signals.test.ts` 覆盖旧 schema、窗口、LIMIT、500×2 kinds 与大量重复行不能饿死后续 exec。
- `signals.test.ts` 覆盖 CommDB/StateStore 分别失败；健康来源仍保留，缺失来源生成对应 gap，异常文本哨兵不外泄。

### B-② 最小业务字段

`Signal` 业务投影只有 `{kind,since,execution_id8,reason?}`，另有审计元数据 `{provenance,observed_at}`。model/receipt/CommDB/render tests 均以非法键和 `SENTINEL` 负控，JSON、Markdown、HTML、tick 不含自由文本。

### B-③ founder wait 分流

`epic-page-signals.test.ts` 证明 protected+checkpoint 未答问题为 `waiting_founder`；`signals.test.ts` 证明同 exec 可并存普通问题；`generate.test.ts`、`residual.test.ts`、`render.test.ts` 证明它不进 `stuck_items`/`stuckForLead`，但在独立区域可见。

### B-④ 可见但不打扰

`patrol-tick-render.test.ts` 证明 N=0 字节不变，N>0 只增加一行。相对基线 `lead-runtime.ts` diff 为空，`GUARDRAIL_EVENT_TYPES` 与 `RETRYABLE_LEAD_EVENT_TYPES` 未改。E2E harness 不包含 Discord 发送依赖，事件/扫描路径无 founder 投递调用点。

## 4. C · 双路与过期

### C-① 接线矩阵

`implementation-notes.md` §3 给出每个生产挂点及对应正负测试。关键断言均验证 callback reason；重放/no-op/reject 为零次。generalized fresh start 对 200/202/409/429 都在 materialization 后单次触发；legacy delayed session race 亦有 RED→GREEN。

### C-② 突发

`epic-page-refresher.test.ts` 在一个 debounce window 内调用 20 次、覆盖七个 event reason，物化一次并保留七元素并集；in-flight 新事件只形成一次尾随 attempt。E2E 再以八次（dependency 重复）证明 event publish 与稳定 token。

### C-③ 顺序

同一 refresher 的 settle/尾随测试与 attempt tests 证明每个实际 attempt 恰一次 materialize、一次 receipt、一次账本 settle；顺序事件跨 debounce window 时不被错误合并。全站点分支证据归 C-①，不声称生产只有八个调用点。

### C-④ scan 兜底

`epic-page-liveness.e2e.test.ts`：事件全部 no-op 时下一次 scan 仍写一行并发布；event 与 scan 都不调用时账本为零。`epic-residual-scan.test.ts` 证明 scan 使用共享 attempt。

### C-⑤ 失败自报

E2E 顺序为成功发布 → scan Linear failure → manual success → event publish success：

- failure 后 status 的 `last_published` 保持，发布失败计数为 1；
- manual `ok_unpublished` 不清零；
- 成功重试页面仍显示「本版之前」失败 1 次及正确 publish-failure token；
- 同刻 live status 计数归零；`last_failure` 与 `last_publish_failure` 独立。

### C-⑥ 读者层

托管 HTML 静态包含 `generated_at`；happy-dom 假时钟执行后年龄文本变化。`epic-page-html-self-check.mjs --file` 通过，脚本被拦或年龄元素隐藏两类负控都 fail-closed。

### C-⑦ 相位与 manual

status 和 manual materialization 都复用生产 patrol schedule；route test 对 `next_scan_expected_at` 与同相位独立计算值做相等断言。manual test 证明不改 publication/registry，不延长 TTL。

## 5. D · 通用门

最终 gate 运行结果在完成前写回本节；Vitest 始终遵守「一个 package、一个文件、fork pool、maxForks=1」。

| 命令 | 结果 |
|---|---|
| `pnpm --filter flywheel-teamlead exec vitest run src/__tests__/epic-page-liveness.e2e.test.ts --pool=forks --poolOptions.forks.maxForks=1` | PASS，4/4 |
| `pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/runs-route.dag-entry.test.ts --pool=forks --poolOptions.forks.maxForks=1` | PASS，55/55 |
| touched-file Biome / package typecheck | PASS |
| `pnpm lint` | 待最终门禁 |
| `pnpm -r build` | 待最终门禁 |
| `pnpm test:packages:run` | 待最终门禁 |
| 新增 `scripts/__tests__/*.test.sh` | 无；本单没有新增 shell test |

PR body 必须列明：新增 CLI `epic-page status`、新增 CommDB `listEpicPageSignals`；无删除/改名，不触发 FLY-1914 sweep。

## 6. 安全与 residue 核对

- 所有 SQLite 查询参数化；status 的 `projectName` 走既有 project resolver。
- HTML 沿用 escape helper；年龄脚本只使用 `textContent`，无 fetch、外链、innerHTML。
- 只有已发布 Blob page 才返回 URL；hostOverride 与预留 token 不暴露固定页地址。
- 无 secrets、`CLAUDE.md` 或 `projects.json` 改动。
- 批准计划 §9 的五项 residue 全部保留，详见 `implementation-notes.md` §7；没有借 code review 扩机制。

