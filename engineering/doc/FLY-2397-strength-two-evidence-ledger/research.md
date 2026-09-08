# FLY-2397 强度二证据台账 — 调研

Issue: FLY-2397 (https://linear.app/geoforge3d/issue/FLY-2397/2309b3-强度二证据台账-真环境跑过-外部可查可重跑的记录两个独立字段p0-影子跑前置)
日期: 2026-09-06
基于: exploration.md

---

## 0. 结论

exploration §3 的 **B 路**(新子命令 → Bridge 新 route → 新表)可行,且每个落点都有现成范式可抄,不需要新造机制:

| 需要 | 现成范式 | 位置 |
| --- | --- | --- |
| 新表 + 幂等建表 | `migrate()` 里 `CREATE TABLE IF NOT EXISTS` | `StateStore.ts:3528`(入口)、`:4491-4520`(`auto_qa_record` 样板) |
| 行不可改不可删 | `BEFORE UPDATE/DELETE … RAISE(ABORT)` 触发器 + 64-hex digest CHECK | `founder_review_card_binding`,`StateStore.ts:21668-21688` |
| 绑 exact head | PK / CHECK `length(head_sha)=40`,写入前 lowercase | `codex_review_record`(`:11851`)、`workflow_node_pr_binding` |
| execution → run | `listWorkflowActivationsForActor(executionId)` 取全部 activation,去重 `run_id` | `StateStore.ts:30589` |
| 路由鉴权 | `rejectNonLoopback` + `tokenAuthMiddleware(config.ingestToken)` | `workflow-decision-routes.ts:455`、`plugin.ts:1121` |
| 取地址 + 超时 | `fetch(url, {signal: AbortSignal.timeout(ms)})` + 结构化 envelope | `verify-report.ts:233-246` |
| 托管报告本地权威 | `ReportRegistry.list()`(token → entry)+ `readReportHtml(token)` | `report-registry.ts:362,372` |
| 529 房身份 | `GET http://127.0.0.1:<bridgePort>/health` 的 `buildSha` / `artifactBuildSha`;slot → port 由 `~/.flywheel/test-slots.json` | `test-deploy.sh:56,665`;记忆库 `reference_529_bridge_runs_script_repo_not_from_branch` |
| retention 登记 | 组字符串 + fixture + 硬计数 | `scripts/lib/fly-2006-retention-registry.mjs:35-75`、`scripts/__tests__/fixtures/fly-2006-teamlead-production-tables.json`、`fly-2006-database-retention-sweep.test.ts:253-321` |

Lead 已裁(ask `14a0e53c`,2026-09-07):(1) B 路批;⛔ 不改 `qa-result` 的 `submission_digest` 合同;新表归 `protectedCurrentOrReference`。
(2) 半边 (b) **在写入时判定**:Bridge 真取一次地址(HTTP 200 + 内容 digest),把 `checked_at / status / digest` 存进行里;之后地址过期**不回溯改判**;
B4 报表把记录分三态单列:`live` / `verified_then_expired` / `unsatisfied`。托管 14 天过期作为已知限制写进 plan 并告知 B4。

## 1. 逐点核对(plan 依据)

### 1.1 `qa-result` 为什么不能扩 —— 它是一次性 credential + 重放摘要合同

- `qa-result.ts:693` POST `/api/workflow/decision`(`workflow-decision-routes.ts:694`,**loopback-only**);
  body `{credential, client_request_id, status, summary?, client_pr_head_sha?}`。
- 服务端 `submitWorkflowDecisionByCredential`(`StateStore.ts:49196`)在一个事务里**消费** `workflow_submission_credential`
  (`consumed_at`,`:49256` 已消费即拒)并以 `canonicalSubmissionDigest`(`:49242-49255`)做重放键,写 `workflow_claims`。
- 所以:① credential 一次性,`qa-result` 之后同一 credential 不能再用来记第二件事;② 改 payload 形状 = 改重放摘要 = 改合同。
  ⇒ 新命令**不能**借这条 credential,要走另一条鉴权(§1.3)。

### 1.2 `auto_qa_record` 今天没有生产写入方

FLY-1981 已删掉它的写 API(`engineering/doc/FLY-1981-founder-flag-verdicts/research.md:86`),
全仓 `INSERT INTO auto_qa_record` 只剩测试 helper;`ship-eligibility.ts:14` 称它「read-only ledger」。
活的 QA 结论台账是 `workflow_claims`(`qa_passed` 371 行,`evidence` 只有 `summary` 一个键)。
⇒ 不在 `auto_qa_record` 上加列(给死表加列没有写入者);新表独立。

### 1.3 新 route 的鉴权 —— 与 `complete` 同源:ingest bearer + loopback + execution 归属

- `complete` 走 `POST /events`,`Authorization: Bearer $FLYWHEEL_INGEST_TOKEN`(`complete.ts:261,474`);
  runner pane 由 `TmuxAdapter.ts:694` / `CodexTmuxAdapter.ts:2384` 注入 `FLYWHEEL_INGEST_TOKEN`,QA 节点同样有。
- `/api/workflow/*` 路由族在 `plugin.ts:2019-2055` 挂载;decision 路由自带 `rejectNonLoopback`(`:455`),
  `/events` 用 `tokenAuthMiddleware(config.ingestToken)`(`plugin.ts:2321`)。
- 新路由 `POST /api/workflow/evidence-run` = **两层都上**:`tokenAuthMiddleware(config.ingestToken)` + `rejectNonLoopback`;
  身份 = body 里的 `recorder_execution_id`,服务端用 `listWorkflowActivationsForActor` 解析到唯一 `run_id`
  (0 个 ⇒ 422 `recorder_not_enrolled`;>1 个不同 run ⇒ 422 `recorder_run_ambiguous`),**不信 CLI 报的 run**。
- 与 FLY-2395 C4 同风格:所有 422 都在 DB 写入之前,零副作用。

### 1.4 「真环境」能被机器核到哪一步

| 事实 | 谁能核 | 怎么核 |
| --- | --- | --- |
| 房里跑的是这个 head | **Bridge 自己**(同机) | `GET http://127.0.0.1:<bridgePort>/health` → `buildSha === head && artifactBuildSha === head`;port 由 `~/.flywheel/test-slots.json` `slots[i].bridgePort`(1987x)解析 |
| 房现在还活着 | Bridge | 同上,取不到 ⇒ `site_unverifiable` |
| 驱动器跑到第几步、退出码 | 只有 QA runner(驱动器 stdout / `step-N.json` 在 `/tmp/flywheel-test-slot-N/e2e-evidence/`,teardown 即失) | **自报**;plan 把它列为 (a) 的**残余自报项**,不假装机器核过 |

⇒ (a) 的机器核 = 「房活着 + 房的 buildSha/artifactBuildSha 恰等于被记的 head」。这就把记忆库那条
「先拷证据再拆房」的纪律变成硬规则:**记账必须在 teardown 之前**,拆了房就记不上(fail-closed)。
驱动器退出码是自报项,但 rerun 配方让任何人能重跑核实。

### 1.5 「外部可查」能被机器核到哪一步

| 地址类 | 识别 | 写入时核法 | digest |
| --- | --- | --- | --- |
| `hosted_report` | `^https://<vercelProjectName>\.vercel\.app/r/<hex-token>/$`(或 `hostOverride.publicBaseUrl/<project>/r/<token>/`,`reports-route.ts:97-103`) | ① `ReportRegistry.list()` 有该 token 且未过期(`report-registry.ts:452-475` 的 TTL 判定)⇒ 否则 `not_in_registry`;② `fetch(url, {signal: AbortSignal.timeout(5000)})` 必须 2xx ⇒ 否则 `http_error` / `unreachable` / `timeout` | sha256(响应体);另与本地 `readReportHtml(token)` 的 sha256 比对,不等 ⇒ `digest_mismatch`(托管体被换) |
| `github_comment` | `^https://github\.com/<owner>/<repo>/(pull\|issues)/<n>#issuecomment-<id>$` | `gh api repos/<owner>/<repo>/issues/comments/<id>`(Bridge 已有 `execFileP("gh", ["api", …])` 面,`plugin.ts:5007`;5s `AbortSignal`)⇒ 非 0 / 非 JSON ⇒ `unreachable` | sha256(`body` 字段) |
| 其它 | — | **拒绝**(422 `record_url_kind_unsupported`),不写行 | — |

本机路径(`~/.flywheel/artifacts/…`、`/tmp/…`)**不是外部可查**,不收;CLI 可以另带 `--local-copy <path>` 作为审计备注列(不参与判定)。

### 1.6 「怎么重跑」的结构

驱动器与起房脚本的参数面(`qa-529-generalized-e2e.mjs:52-80`、`test-deploy.sh:4-5,199-222`)决定了重跑配方是有限的结构化字段:

```json
{ "schemaVersion": 1,
  "deploy": { "script": "scripts/test-deploy.sh", "slot": 2, "flags": ["--generalized","--stub-runner","--expect-head <head>"], "envNames": ["TEST_REPLY_BY_ISSUE"] },
  "driver": { "script": "scripts/qa-529-generalized-e2e.mjs", "rev": "<40hex>", "slot": 2, "issue": "FLY-145", "real": false, "timeoutMs": 600000 },
  "head": "<40hex>", "worktree": "flywheel-FLY-2397" }
```

Bridge 校验形状(slot 正整数、issue `^[A-Z]+-\d+$`、rev 40 hex、flags 白名单、envNames 只收名不收值)并渲染成一行 `rerun_command` 存表;
自由文本不收。`--expect-head` 是现成 fence(FLY-1775),把它写进配方等于让重跑者自动撞上「起错房」。

### 1.7 幂等与并发

- `record_id` = CLI 生成的 UUID,CLI 先写本地 receipt 文件再发(与 `qa-result` 的 fail-close marker 同思路),重试带同一 id。
- 服务端:`SELECT` by `record_id` → 有且全字段相等 ⇒ 200 `replayed`;有且不等 ⇒ 409 `record_conflict`;无 ⇒ 先做 §1.4/§1.5 两次探测(只读、可重复),再 `INSERT`(单事务)。
- 崩溃窗口:探测后、INSERT 前崩 ⇒ 无行,重试重探;INSERT 后、响应前崩 ⇒ 重试命中 replay。两侧都安全。
- 同 `(run_id, head_sha)` 允许多行(重跑各记一行),**只追加**;判定函数在行集合上算(§1.8)。
- sql.js 单写者事务串行化,不需要额外锁。

### 1.8 判定是纯函数,两半各自独立

```ts
judgeRan(site: SiteProbe, lane, driverExitCode): { satisfied, reason }      // (a)
judgeRecord(probe: RecordProbe, claimedDigest?): { satisfied, reason }      // (b)
evaluateStrengthTwo(rows: LedgerRow[]): { ran, record, verdict, basisRecordId } // 行集合 → 结论
```
- `evaluateStrengthTwo([])` ⇒ 两半都 `no_ledger_row`(阳性对照 1)。
- 行里 `ran_status='satisfied'` 但 `record_status='unsatisfied'`(写入时地址取不到,行照记)⇒ verdict `unsatisfied`,`record.reason` 说明原因(阳性对照 2)。
- 反向:两半都 satisfied ⇒ verdict satisfied,`basisRecordId` 指向那一行。
- 测试分别断言 `ran` 与 `record` 两个字段,并断言不存在「一个布尔盖两件事」的路径(两半的 reason 词汇表不相交)。

### 1.9 retention 登记 —— 三处 + 与 FLY-2395 的合并顺序

- `TEAMLEAD_TABLE_CLASSIFICATION.protectedCurrentOrReference` 加表名(按字母序);fixture JSON 加一行;
  `fly-2006-database-retention-sweep.test.ts` 计数 `protectedCurrentOrReference` 115→116、总数 173→174、170→171。
- **FLY-2395 同时加两张表**(173→175)。两单谁后合谁 rebase 计数;plan 写成「相对 +1」,不写绝对数。
- 不进 `deleteTarget` ⇒ 不需要 engine `staticPolicy`。

### 1.10 消费者今天是零,本单交的是读面

`review-hold.ts` / land / founder gate **不读新表**(影子跑前置:只记账不拦人)。交付读面:
`listStrengthTwoRecordsForRun(runId)`、`listStrengthTwoRecordsForHead(runId, headSha)`、`evaluateStrengthTwo(rows)`、
`probeRecordLiveness(row, fetch)`(给 B4 三态报表,不参与判定)。B4 记录线 ③ 按 `(run_id, head_sha)` 精确 join;
ledger head ≠ gate head(例如 QA 后又推了 progress.md)⇒ 该 head 无行 ⇒ 判不满足,并落进 B4 已有的「绑定失败」栏,不猜。

## 2. 只读副本上的预演(2026-09-07T01:14Z 副本,手算)

- 371 条 `qa_passed` 里 301 条含 `vercel.app` 托管地址、205 条提到 slot/529 房;若本单上线前这些单都要按新规则判,
  **全部 371 条 = `no_ledger_row` ⇒ 不满足**(阳性对照 1 的历史形态)。这是设计使然:自称不算。
- 托管地址 14 天过期:副本里最早的 `vercel.app` 记录早已取不到;新规则下它们若被记过账,状态会是 `verified_then_expired`,
  verdict 不变(Lead 裁)。
- 0 条用过 GitHub Actions run URL;`github_comment` 类是给未来准备的第二载体,不是今天的主路径。

## 3. 决定(带取舍)

| 决定 | 取 | 舍 | 为什么 |
| --- | --- | --- | --- |
| 写入者 | 新子命令 `evidence-run record` + 新路由 | 扩 `qa-result` | §1.1;Lead 已裁 |
| (a) 机器核 | Bridge 自己探 529 房 `/health` | 信 QA 自报的 buildSha | 房拆了就记不上 = 把「先拷后拆」纪律变硬规则 |
| (b) 判定时刻 | 写入时,存 checked_at/status/digest | 判定时重探 | Lead 裁;避免期末把早期单子误判 |
| 地址取不到 | **仍写行**,`record_status='unsatisfied'` | 422 拒写 | 阳性对照 2 要「有台账行但取不到 ⇒ 不满足」,行必须在;且留审计痕迹 |
| 地址类 | `hosted_report` + `github_comment` 白名单 | 任意 https | 「填个字符串就算」是 (b) 的退化方向;白名单 + 服务端 digest 堵它 |
| 多行 | 同 head 允许多行,只追加 | UPSERT | 重跑历史有价值;不可改删靠触发器 |
| 驱动器退出码 | 自报 + 明写残余 | 让 Bridge 读 `/tmp` 证据目录 | 跨进程读易失目录不可靠(FLY-2163 亦提示 slot 与生产目录有串写风险) |

## 4. 风险

- **Bridge 出站取地址阻塞事件循环?** 不会:`fetch` 异步 + 5s `AbortSignal`;`gh api` 走 `execFileP` 子进程 + signal。路由不在 GatePoller tick 内。
- **`/health` 探测打到生产 Bridge 自己?** slot port 只从 `test-slots.json` 解析,且拒绝 `TEAMLEAD_PORT` 自身端口;`site_kind='other'` 不探测直接 `lane_unproven`。
- **hostOverride 房(FLYWHEEL_REPORT_HOST_OVERRIDE_URL)**:地址形状用 `hostOverride.publicBaseUrl` 分支,registry 仍是本地权威。
- **B4 期望的三态**:`live` 需要判定后再探,本单只给 `probeRecordLiveness` 函数,不存表。

## 5. 不确定 / 未核

- `gh api` 在 Bridge 进程里的凭据面(是否与 `ship-relevant-diff` 用同一把 token)—— 实现时核,`github_comment` 类若凭据不足则 fail-closed 为 `unreachable`。
- 529 房 `/health` 在 `--stub-runner` 与 `--codex-runner` 两种房里 `artifactBuildSha` 是否都等于 `buildSha` —— 实现时用 §1.6 配方各起一次核;不等则规则改为只比 `buildSha` 并记录差异。
