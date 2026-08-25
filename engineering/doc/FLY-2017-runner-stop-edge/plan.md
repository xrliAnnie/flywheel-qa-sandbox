# FLY-2017 RUNNER-STOPPED 状态沿申明 — 实施计划
Issue: FLY-2017 (https://linear.app/geoforge3d/issue/FLY-2017/bridgebug-停驻体-runner-stopped-申明是周期重发不是状态沿触发安静停驻的体每-3-分钟给-lead-灌一条同文)
日期: 2026-08-24
基于: research.md

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development` to execute each RED → GREEN slice inline in this bounded Implement node. Do not dispatch successor/review nodes; the DAG orchestrator owns advancement.

**Goal:** 把 RUNNER-STOPPED 从“每个 vendor turn 重发”改成按 execution 的状态沿申明，并让可信 `rstop-*` 成为只需 ACK、禁止 `respond` 的单向 lifecycle report。

**Architecture:** CommDB 新增一行-per-execution 的 current declaration ledger；一个 `BEGIN IMMEDIATE` 原语比较完整 canonical content 与“content 推导完成时刻”，只有新 content 才沿用现有 `kind=report` mailbox enqueue；比 current 更早的不同推导返回独立 `stale`。旧沿仅在已有 delivery/ACK 证据时 supersede，未投递沿继续可靠投递；batch ACK 是单向 report 的自然退休点。现有 `runner_question` event type 不变，live/legacy admission 只贯穿 question kind；两个 runtime 用严格三项信任谓词渲染 no-response report，`respond.ts` 用同一谓词 fail closed，bootstrap/pending 从待回答候选集中排除该类 report。全程不按 hook ingress timestamp 排序、不新增 event/alert/timer。

**Tech Stack:** TypeScript、better-sqlite3/WAL、Vitest、Node child processes、Bash hook harness、pnpm monorepo。

---

## 不变量与信任谓词

可信 RUNNER-STOPPED report 必须同时满足：

```ts
question.kind === "report" &&
/^rstop-[0-9a-f]{32}$/.test(question.id) &&
question.content.startsWith("RUNNER-STOPPED kind=runner_stopped ")
```

所有判断都使用完整、未截断字段。三项任一不满足，均保留普通 question 的既有 render/bootstrap/respond 语义。状态沿比较完整 canonical content 与 SHA-256；hash 只用于诊断/索引，不能单独决定相等。

`ingressTs` 仍保留给当前 pending-question lower-bound 推导，但不进入 current ledger。content 在 detached leg 执行时才从 live CommDB/runner state 推导；canonical content 构造完毕后立即捕获 `derivedAtMs`，用它拒绝一个在 DB 写锁外等待后才提交的旧推导。相同 content 会把 ledger 时刻单调推进；毫秒完全相同的不同 content 按 SQLite transaction 顺序收敛。

## 文件边界

- `packages/flywheel-comm/src/db.ts`：创建 `runner_stop_declarations`；提供唯一原子 compare/enqueue/delivery-aware-supersede 原语；session finalize 清理 current row。
- `packages/flywheel-comm/src/mailbox-queue.ts`：batch ACK 时 terminal-dispose 本批可信 rstop report。
- `packages/flywheel-comm/src/runner-stop-report.ts`：三项信任谓词，供 respond/pending/TeamLead 共用。
- `packages/flywheel-comm/src/commands/runner-stopped.ts`：保留 reason 推导和 per-turn replay marker，最终入队改走状态沿原语。
- `packages/flywheel-comm/src/commands/respond.ts`：可信 rstop report fail closed，发生在 authorization/write/marker side effect 之前。
- `packages/flywheel-comm/src/commands/pending.ts`：排除可信 rstop，只列仍需回答的问题。
- `packages/flywheel-comm/src/__tests__/runner-stopped.test.ts`：跨 turn 同文、A→B→A、旧沿退役、completion consumption、finalize 回归。
- `packages/flywheel-comm/src/__tests__/runner-stop-declaration-race.test.ts`：使用 built `dist/db.js` 的真实多 OS process race。
- `packages/flywheel-comm/src/__tests__/respond-mailbox.test.ts`：rstop respond 无 response、无 marker retirement；普通 ask 保持可回复。
- `packages/flywheel-comm/src/__tests__/{mailbox-queue,cli}.test.ts`：ACK retirement 与 pending filter。
- `packages/teamlead/src/bridge/hook-payload.ts`：增加 `question_kind` wire field 与共享 live formatter/可信谓词。
- `packages/teamlead/src/bridge/question-admission.ts`、`packages/teamlead/src/bridge/gate-poller.ts`：live cutover 与 legacy relay 都传递 `question.kind`。
- `packages/teamlead/src/bridge/bootstrap-generator.ts`：完整 row 上过滤可信 rstop；`BootstrapRunnerQuestion` 不扩字段。
- `packages/teamlead/src/bridge/{mailbox-lead-runtime,commdb-lead-runtime}.ts`：复用共享 live formatter；普通 bootstrap question 保持原文。
- `packages/teamlead/src/__tests__/{mailbox-lead-runtime,commdb-lead-runtime,bootstrap-generator}.test.ts`、`packages/teamlead/src/bridge/__tests__/question-admission.test.ts`：投递、near-match 与重启恢复合同。
- `packages/teamlead/lead-rules-base/{department-lead-rules,cos-lead-rules,runner-messaging-rules,runner-patrol-rules}.md`：所有冲突位置增加 rstop no-respond 窄例外。
- `packages/teamlead/src/__tests__/fly2017-runner-stop-report-rules.test.ts`：逐文件固定例外存在，且无无范围的 all-runner-question respond 语句。

### Task 1: RED — 锁定状态沿、退役与 breadcrumb 安全

**Files:**

- Modify: `packages/flywheel-comm/src/__tests__/runner-stopped.test.ts`

- [ ] **Step 1: 写不同 turn 同一 parked content 的失败测试**

注册 parked=`quiet-wait`，用两个不同 Codex `turnId` 调两次 `runnerStopped()`；期待首个 `sent`、第二个 `duplicate`，report row 与 pending rstop 均只有一条。

- [ ] **Step 2: 写 A → B → A 的失败测试**

依次更新 declared state 为 A/B/A，每次用新 turn id 调用。期待三个不同 question id、三条不可变历史。若前沿先标记为已投递/ACKED，则 successor 可将它 supersede；若未投递，则 successor 不得撤销它，A/B/A 三条仍保持 QUEUED/可投递，直到各自 batch ACK 后 terminal disposed。

- [ ] **Step 3: 写 completion breadcrumb 消费合同**

覆盖两类：

1. completion content 与 current 完全相同 → duplicate 合法消费，因为对应 content 已成功入队；
2. 删除 per-turn sent marker 后复用同一 turn id，并让 completion 推导内容与该 qid 已有 row 不同 → deterministic identity conflict 保留首内容，breadcrumb 必须保持未消费，current 与旧 pending 也不变。

第二类明确防止“未入队终态被当 duplicate 消费”的设计审查 HIGH 回归。另加一例：较新的 completion edge 先提交，较早 `derivedAtMs` 的 parked writer 后取得锁，必须返回 `stale/contentMatched=false`，不能退役 completion、回写 current 或消费任何 breadcrumb。

- [ ] **Step 4: 写 finalize cleanup 回归**

首个 report 后调用 `finalizeSession(exec)`，直接查询 `runner_stop_declarations` 应无该 execution；随后依靠 receipt lineage 的 late reporter 可以重新发一条，证明 cleanup 不破坏既有 post-finalize 路径。

- [ ] **Step 5: 运行 RED**

```bash
pnpm --filter flywheel-comm test -- --run src/__tests__/runner-stopped.test.ts
```

Expected: 跨 turn 同文目前是第二个 `sent`/两条 report；schema/退役断言尚不存在或失败。

### Task 2: GREEN — CommDB 原子 current declaration ledger

**Files:**

- Modify: `packages/flywheel-comm/src/db.ts`
- Modify: `packages/flywheel-comm/src/commands/runner-stopped.ts`
- Test: `packages/flywheel-comm/src/__tests__/runner-stopped.test.ts`

- [ ] **Step 1: 添加 current-state schema（无 ingress watermark）**

```sql
CREATE TABLE IF NOT EXISTS runner_stop_declarations (
  execution_id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  content TEXT NOT NULL,
  question_id TEXT NOT NULL,
  derived_at_ms INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
```

- [ ] **Step 2: 添加原子 API**

在 `CommDB` 增加：

```ts
recordRunnerStopDeclaration(input: {
  executionId: string;
  leadId: string;
  content: string;
  questionId: string;
  derivedAtMs: number;
}): {
  status: "sent" | "duplicate" | "stale";
  questionId: string;
  contentMatched: boolean;
}
```

主体在 `.transaction(...).immediate()` 内严格按顺序执行：

1. 读 execution current row；完整 content/hash 相同则返回 `duplicate, contentMatched:true`，并将 ledger `derived_at_ms` 单调推进到 `max(current,incoming)`；
2. content 不同且 `incoming derivedAtMs < current.derivedAtMs` 时返回 `stale, contentMatched:false`，不写 mailbox/current/旧沿；
3. current 不同且 incoming 不旧时调用既有 `insertQuestion(...,{id,kind:'report'})`；
4. preferred qid 若已存在且所有 identity/content 字段完全相同，返回 `duplicate, contentMatched:true`，但若 current 已指向另一条沿，绝不能用这个旧 turn replay 回退 current、退役当前沿或制造 A→B→旧 A；若 qid 已有不同内容，返回 `duplicate, contentMatched:false` 或抛既有 deterministic conflict，由 caller 保持 breadcrumb 未消费，且 transaction 不推进 current；
5. 新 row 成功插入后，只有旧 current row 的 `delivered_at IS NOT NULL OR state='ACKED'` 时，才用 guarded retirement 并写 `supersededBy=new qid`；未投递旧沿必须留在队列；
6. 最后 UPSERT current content/hash/qid/derived_at_ms/updated_at；任何异常回滚 enqueue、旧沿退役与 current 更新。

对 deterministic conflict 的具体返回/抛错可保持现有 public behavior，但 `contentMatched` 必须准确表达“这份完整 content 已经存在于该 qid”，不能把任何其他抑制原因视为 true。测试还要固定“旧 turn exact replay 在 current 已变化后不回退账面”；正常 A→B→A 必须使用第三个新 turn-derived qid。

- [ ] **Step 3: runnerStopped 接入 API**

保留现有 turn hash、sent marker、canonical wire text、reason precedence。canonical content 构造后立即捕获 `derivedAtMs`。仅当原子 API `contentMatched === true` 时消费 completion breadcrumb；`stale` 必为 false。无论 duplicate/sent/stale，只有 DB 原语成功后才写 sent marker。

- [ ] **Step 4: finalize 清 current row**

在 `finalizeSession()` 的既有 transaction 中与 `runner_shutdown_controls` 一样删除 `runner_stop_declarations WHERE execution_id=?`；同时覆盖 guarded finalization 间接路径。

- [ ] **Step 5: 运行 GREEN 与 DB 回归**

```bash
pnpm --filter flywheel-comm test -- --run src/__tests__/runner-stopped.test.ts src/__tests__/db.test.ts src/__tests__/db.fly1328.test.ts
```

Expected: 同文仅一条；A→B→A 三沿都不会在投递前被撤销；older-derived writer 不回退 current；冲突 breadcrumb 不消费；finalize ledger cleanup 通过。

### Task 3: RED/GREEN — 真实跨进程原子性

**Files:**

- Create: `packages/flywheel-comm/src/__tests__/runner-stop-declaration-race.test.ts`

- [ ] **Step 1: 写 built-dist worker race**

沿用 `lifecycle-claim-race.test.ts` 模式：parent 先创建 CommDB、完成 schema migration并注册 session，再动态写 `.mjs` worker，import `packages/flywheel-comm/dist/db.js`。N 个独立 Node process 等待同一 wall-clock barrier 后，对同一 DB/execution、相同 content、不同 preferred qid 调 `recordRunnerStopDeclaration()`。

- [ ] **Step 2: 断言 contention 结果**

same-content arm 期待恰好一个 `sent`、N-1 个 `duplicate`，所有 process exit 0/stderr 不含 `SQLITE_BUSY|locked`；最终 current ledger 一行、report history 一行。different-content arm 给旧/新内容显式不同 `derivedAtMs` 并交叉启动顺序；无论 lock winner，current 必须是较新内容，较旧结果只能是先 `sent` 后保留可投递，或后到 `stale`，绝不能 supersede/撤销较新沿。测试在 dist 不存在时按现有仓库模式 skip，但验证前先 build package，确保 CI/full gate 真正执行。

- [ ] **Step 3: build + 运行 race**

```bash
pnpm --filter flywheel-comm build
pnpm --filter flywheel-comm test -- --run src/__tests__/runner-stop-declaration-race.test.ts
```

Expected: race test 非 skip 且全部通过。

- [ ] **Step 4: 提交状态沿切片**

```bash
git add packages/flywheel-comm/src/db.ts packages/flywheel-comm/src/commands/runner-stopped.ts packages/flywheel-comm/src/__tests__/runner-stopped.test.ts packages/flywheel-comm/src/__tests__/runner-stop-declaration-race.test.ts
git commit -m "fix(FLY-2017): edge-trigger runner stop declarations"
```

### Task 4: RED/GREEN — live Lead 投递与 respond fail closed

**Files:**

- Modify: `packages/teamlead/src/bridge/hook-payload.ts`
- Modify: `packages/teamlead/src/bridge/question-admission.ts`
- Modify: `packages/teamlead/src/bridge/gate-poller.ts`
- Modify: `packages/teamlead/src/bridge/mailbox-lead-runtime.ts`
- Modify: `packages/teamlead/src/bridge/commdb-lead-runtime.ts`
- Modify: `packages/teamlead/src/bridge/__tests__/question-admission.test.ts`
- Modify: `packages/teamlead/src/__tests__/mailbox-lead-runtime.test.ts`
- Modify: `packages/teamlead/src/__tests__/commdb-lead-runtime.test.ts`
- Modify: `packages/flywheel-comm/src/commands/respond.ts`
- Modify: `packages/flywheel-comm/src/commands/pending.ts`
- Create: `packages/flywheel-comm/src/runner-stop-report.ts`
- Modify: `packages/flywheel-comm/src/__tests__/respond-mailbox.test.ts`

- [ ] **Step 1: 写两个 runtime 的 RED 测试**

构造可信 event（`event_type=runner_question`、`question_kind=report`、canonical rstop id、canonical full summary），两个 runtime 均断言：包含 `[REPORT] Runner lifecycle declaration`、`Do not respond`、`ACK`；不包含 `flywheel-comm respond`。再用 table-driven near-match 分别破坏 kind/id/signature，必须仍显示 `[ASK]` 与 respond。

- [ ] **Step 2: 写 QuestionAdmission/legacy kind 贯穿 RED**

插入 `{kind:'report'}` rstop question，分别走 `QuestionAdmission.materialize()` 与 legacy GatePoller relay，捕获完整 envelope，断言 `question_kind === 'report'`。普通 ask 无 kind或保留既有值。

- [ ] **Step 3: 写 respond fail-closed RED**

在 CommDB 插入可信 rstop row并写 ask marker。调用 `respond()` 应抛出明确错误，随后断言：无 response child、question 仍原样、marker 仍存在、无 runner wake。另写 three near-match cases 和普通 ask positive control，证明 guard 不扩大。

- [ ] **Step 4: 写 pending 与 ACK retirement RED**

CLI `pending --json` 混合普通 ask、可信 rstop 与 near-match：只排除可信 rstop。MailboxQueue 用真实 lead batch claim + ACK，断言可信 rstop 变成 `relay_state='terminal_disposed'`、`resolved_via='report_ack'`、无 response child；ACK 前仍可重投。覆盖 queue-enabled `ackBatchByRecipient` 与 legacy `ackBatch` 两条消费路径。

- [ ] **Step 5: 实现 shared predicate、live formatter 与 wire field**

在 flywheel-comm 新增共享 `isRunnerStopReport({id,kind,content})` 并导出 package subpath。`HookPayload` 增加 `question_kind?: string`；`hook-payload.ts` 映射 event 字段调用共享谓词并导出 `formatRunnerQuestion(env)`；两个 runtime 删除 formatter 副本并复用。QuestionAdmission/GatePoller payload 添加 `question_kind: question.kind`（有值时）。

- [ ] **Step 6: 实现 respond/pending/ACK 边界**

在 `respond()` 读到 question 后、所有 authorization/route/write/retireMarker 之前调用共享谓词；命中则 throw。`pending()` 在 projection 前过滤。MailboxQueue 两个 lead batch ACK transaction 在可靠消费成功后，以相同 SQL 三项条件 terminal-dispose 本批 rstop；普通 report/ask/gate 不变。

- [ ] **Step 7: 运行 focused GREEN**

```bash
pnpm --filter flywheel-comm test -- --run src/__tests__/respond-mailbox.test.ts src/__tests__/mailbox-queue.test.ts src/__tests__/cli.test.ts
pnpm --filter flywheel-teamlead test -- --run src/__tests__/mailbox-lead-runtime.test.ts src/__tests__/commdb-lead-runtime.test.ts src/bridge/__tests__/question-admission.test.ts src/__tests__/gate-poller.test.ts
```

Expected: rstop no-response 与普通 ask respond 两类合同同时通过，两个 runtime parity-by-construction。

### Task 5: RED/GREEN — bootstrap 与 Lead rules 不再制造回复义务

**Files:**

- Modify: `packages/teamlead/src/bridge/bootstrap-generator.ts`
- Modify: `packages/teamlead/src/__tests__/bootstrap-generator.test.ts`
- Modify: `packages/teamlead/lead-rules-base/department-lead-rules.md`
- Modify: `packages/teamlead/lead-rules-base/cos-lead-rules.md`
- Modify: `packages/teamlead/lead-rules-base/runner-messaging-rules.md`
- Modify: `packages/teamlead/lead-rules-base/runner-patrol-rules.md`
- Create: `packages/teamlead/src/__tests__/fly2017-runner-stop-report-rules.test.ts`

- [ ] **Step 1: 写 bootstrap RED 与 near-match tests**

同一 execution 插入普通 ask 与可信 rstop，`generateBootstrap()` 只返回普通 ask。再分别构造 kind-only、id-only、signature-only、任意双项匹配 near-match，全部保留在 pendingRunnerQuestions；谓词必须在 `content.slice()` 前使用完整 content。

- [ ] **Step 2: generator 排除可信 rstop**

在 non-checkpoint branch 构造 `BootstrapRunnerQuestion` 之前执行严格三项判断并 `continue`。不向 bootstrap model 增加 `kind`，因为 rstop 是 one-way delivered report，不是 pending question；普通 question 的 model/runtime 字节结构保持不变。

- [ ] **Step 3: 修订全部四份规则**

department/cos 的 `Runner Question Handling` 必须同时修订：事件示例、编号步骤 3、步骤 4、gate-vs-runner table、结尾 “Both reply the same way”。明确可信 `[REPORT] Runner lifecycle declaration`：可按 lifecycle 状态 relay 一次，ACK enclosing batch/event，NEVER `respond`；one-question/one-response 只适用于 `[ASK]`。

`runner-messaging-rules.md` 的 hard gate/respond 与 wake matrix旁加入 rstop report 禁止 respond；`runner-patrol-rules.md` 的 lifecycle relay checklist 和 durable ACK 段明确 rstop report 是状态 relay，不等待/制造 answer。不得新增 timer、patrol、alert 或通知通道。

专用合同测试逐一读取四份源文件：每份必须包含 canonical `rstop-*`/`RUNNER-STOPPED` no-respond 例外；department/cos 还必须把步骤 3/4、table、closing sentence限定为 `[ASK]`，四份文件均不得残留无范围的 “all runner_question → respond/answer” 断言。

- [ ] **Step 4: 运行 focused GREEN 与规则合同**

```bash
pnpm --filter flywheel-teamlead test -- --run src/__tests__/bootstrap-generator.test.ts src/__tests__/mailbox-lead-runtime.test.ts src/__tests__/commdb-lead-runtime.test.ts src/__tests__/fly369-patrol-rule.test.ts src/__tests__/fly2017-runner-stop-report-rules.test.ts src/__tests__/rules-bundle-truth-process.test.ts
```

Expected: bootstrap 不含可信 rstop；普通 ask 仍含 respond；规则后文不再声明所有 runner_question 都必须 response。

- [ ] **Step 5: 提交 Lead 单向语义切片**

```bash
git add packages/flywheel-comm/src/commands/respond.ts packages/flywheel-comm/src/__tests__/respond-mailbox.test.ts packages/teamlead/src/bridge packages/teamlead/src/__tests__ packages/teamlead/lead-rules-base
git commit -m "fix(FLY-2017): make runner stop reports one-way"
```

### Task 6: Hook、全仓验证与审查

**Files:**

- Verify: `scripts/hooks/runner-stop-notify.sh`
- Verify: `scripts/hooks/test-runner-stop-notify.sh`
- Modify only if required by RED evidence: `scripts/hooks/test-runner-stop-notify.sh`
- Update: `engineering/doc/FLY-2017-runner-stop-edge/progress.md`

- [ ] **Step 1: 运行 hook 主链回归**

```bash
bash scripts/hooks/test-runner-stop-notify.sh
```

Expected: 所有 case PASS；Codex detached reporter 与 wake sweep 仍独立，hook 前台时限不变。

- [ ] **Step 2: 运行 focused package suites 与静态检查**

```bash
pnpm exec biome check packages/flywheel-comm/src/db.ts packages/flywheel-comm/src/commands/runner-stopped.ts packages/flywheel-comm/src/commands/respond.ts packages/flywheel-comm/src/__tests__/runner-stopped.test.ts packages/flywheel-comm/src/__tests__/runner-stop-declaration-race.test.ts packages/flywheel-comm/src/__tests__/respond-mailbox.test.ts packages/teamlead/src/bridge packages/teamlead/src/__tests__ packages/teamlead/lead-rules-base
pnpm --filter flywheel-comm build
pnpm --filter flywheel-comm test -- --run src/__tests__/runner-stopped.test.ts src/__tests__/runner-stop-declaration-race.test.ts src/__tests__/respond-mailbox.test.ts
pnpm --filter flywheel-teamlead test -- --run src/__tests__/mailbox-lead-runtime.test.ts src/__tests__/commdb-lead-runtime.test.ts src/__tests__/bootstrap-generator.test.ts src/bridge/__tests__/question-admission.test.ts src/__tests__/gate-poller.test.ts
```

Expected: 0 error；跨进程 race 明确执行（非 skip）；所有 focused tests 通过。

- [ ] **Step 3: 运行全仓 gates**

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
```

Expected: 全绿；若 aggregate 出现不相关环境失败，保留原始证据并对精确 suite 串行复验，不能把失败的 aggregate 冒充全绿。

- [ ] **Step 4: 更新 progress 与剩余文档**

```bash
node "$FLYWHEEL_COMM_CLI" progress --exec-id c269d9fa-c055-4bd9-bbe3-82f21b0da8b7 --file engineering/doc/FLY-2017-runner-stop-edge/progress.md --phase implement --cursor 4/4 --next "request code review"
git add engineering/doc/FLY-2017-runner-stop-edge packages scripts/hooks/test-runner-stop-notify.sh
git commit -m "docs(FLY-2017): document runner stop edge protocol"
```

- [ ] **Step 5: 按 Codex author request-driven 流程请求 code review**

先 `stage set code_review`，再开新的 `review_code --no-block` gate并 `request-review --type code`；轮询至 `reviewVerdict=APPROVED`。CHANGES 必须修复并开新 gate；APPROVED advisories 用 `ask --report` 转 Lead。

- [ ] **Step 6: Push、开 PR、完成 bounded node**

检查 Lead inbox；push 当前 branch，`gh pr create --base main`。从 PR 读取 number 后执行：

```bash
node "$FLYWHEEL_COMM_CLI" stage set pr_created
pr_number="$(gh pr view --json number --jq .number)"
node "$FLYWHEEL_COMM_CLI" complete --route needs_review --pr "$pr_number"
```

不请求 ship approval，不 merge，不投 restart ticket。

## 计划自审

- **Spec coverage:** 状态沿、A→B→A、跨进程原子性、旧沿退役、completion breadcrumb 不丢、rstop no-response、CLI fail closed、bootstrap 排除、普通 ask/gate 兼容、无新告警层均有对应 RED/GREEN。
- **Review correction:** 删除 ingress watermark；改用 content 构造后的 `derivedAtMs`，older different writer 有独立 `stale/contentMatched=false`，不会吞 completion breadcrumb或回退 current。
- **Pending-row lifecycle:** 未投递沿永不 supersede；delivery/ACK 后才可退役，batch ACK直接消费本批 rstop，finalize 删除 current ledger；bootstrap/pending 不恢复 one-way report。
- **Trust boundary:** live renderer、bootstrap filter、respond guard 都要求 kind + canonical id + full signature 三项同时成立，并有 near-match negative tests。
- **Placeholder scan:** 无 TBD/TODO/“稍后实现”；每个写码步骤含精确 API/事务顺序或测试合同，每个验证步骤含命令与期望。
