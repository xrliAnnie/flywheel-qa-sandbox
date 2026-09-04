# FLY-2222 inbox 判据卫生 — 实施计划
Issue: FLY-2222 (https://linear.app/geoforge3d/issue/FLY-2222/判据卫生-runner-的-inbox-查询看不到已注入的-lead-指令no-instructions被当成没有新指令的假阴性两名-qa)
日期: 2026-09-03
基于: research.md

> **For agentic workers:** 按本计划逐项 inline 执行；每个行为改动都走单个 RED → 最小 GREEN →
> REFACTOR，禁止先改生产代码。

**Goal:** 让 runner 的 `inbox` 自查看见仍在 QUEUED/LEASED 的 runner mailbox backlog，不再把
“有待投行但 instruction 过滤为空”误报成 `No instructions.`。

**Architecture:** 保留 delivery、lease、ACK、response `check` 和 JSON stdout 合同。为 inbox 增加与
实际 claim 选择面一致的只读 pending snapshot（queued/leased 计数 + response question IDs）；默认
文本在 pending 非零时显示可执行的 `check` 命令。pending 真空时完整输出逐字节不变。Blueprint
只为有 Lead 的 Claude/Codex runner 解释新增 pending 输出的动作。

**Tech Stack:** TypeScript、Node.js CLI、better-sqlite3、Vitest、pnpm monorepo。

---

## 0. 锁定范围与不变量

| 文件 | 本单职责 |
|---|---|
| `packages/flywheel-comm/src/db.ts` | 导出 indexable pending SQL；返回 queued/leased 与 question IDs |
| `packages/flywheel-comm/src/commands/inbox.ts` | instruction 消费后读取 pending snapshot；DB 缺失返回空 snapshot |
| `packages/flywheel-comm/src/index.ts` | 渲染 pending；保持真空文本和 JSON 合同 |
| `packages/flywheel-comm/src/__tests__/db.test.ts` | 锁定 expired-live 可见与自然命中 `mailbox_live` |
| `packages/flywheel-comm/src/__tests__/commands.test.ts` | 锁定 response 不被 inbox 消费、重复观察仍可见 |
| `packages/flywheel-comm/src/__tests__/cli.test.ts` | 锁定 pending 文本、question ID 与 ACKED 后真空字节兼容 |
| `packages/edge-worker/src/Blueprint.ts` | 为所有有 Lead 的 runner 注入 pending/check 动作规则 |
| `packages/edge-worker/src/__tests__/Blueprint.fly1188-codex-prompt.test.ts` | Claude/Codex 参数化判据及 no-lead 边界 |
| `packages/edge-worker/src/__tests__/__snapshots__/Blueprint.fly1188-codex-prompt.test.ts.snap` | 接受 Claude prompt 唯一预期变化 |
| `engineering/doc/FLY-2222-inbox-verdict-hygiene/` | DOC-FLOW 与证据 |
| `engineering/doc/milestones/FLY-2222.md` | PR ready 前 literal last commit |

明确不改：schema/index、claim/lease/batch 配置、delivery lane、response/check 权威路径、告警、
`--json` 的 `Message[]` stdout、`CLAUDE.md`、运行中的 Bridge/Lead。

pending 查询严格对齐 delivery identity/state 面：

```sql
to_agent = ?
AND recipient_kind = 'runner'
AND carrier = 'inbox'
AND type IN ('instruction','response')
AND state IN ('QUEUED','LEASED')
```

不添加 expiry、superseded、next-retry 或 delivered-at 条件；这些都不是 `claimQueueBatch` 的统一
排除条件。`DEAD`/`ACKED` 不计 pending；历史/永久失败查询不在本单范围。

## Task 1：DB pending snapshot（RED → GREEN）

### Step 1.1：写唯一 DB RED

在 `packages/flywheel-comm/src/__tests__/db.test.ts` 的 instruction pull 邻近增加一个用例：

1. 为 `exec-pending` 插入两个 question/response；把第二个 response 的 `expires_at` 改到过去。
2. 断言新 `getPendingRunnerMailboxSnapshot()` 返回：

```ts
{
	queued: 2,
	leased: 0,
	questionIds: [firstQuestionId, expiredQuestionId],
}
```

3. 对导出的 `PENDING_RUNNER_MAILBOX_SQL` 做 `EXPLAIN QUERY PLAN`，断言自然包含
   `mailbox_live (to_agent=?)` 且不含 `SCAN mailbox`。SQL 本身不得写 `INDEXED BY`。

先只运行该测试，确认因 API/常量不存在而失败：

```bash
pnpm --filter flywheel-comm test:run -- src/__tests__/db.test.ts
```

### Step 1.2：最小 DB GREEN

在 `packages/flywheel-comm/src/db.ts` 增加：

```ts
export interface PendingRunnerMailboxSnapshot {
	queued: number;
	leased: number;
	questionIds: string[];
}

export const PENDING_RUNNER_MAILBOX_SQL = `SELECT state, type, ref_id
  FROM mailbox
 WHERE to_agent = ? AND recipient_kind = 'runner' AND carrier = 'inbox'
   AND type IN ('instruction','response')
   AND state IN ('QUEUED','LEASED')
 ORDER BY seq`;
```

`getPendingRunnerMailboxSnapshot(agentId)` 对 rows 做只读聚合；queued/leased 分别计数，response 的
非空 `ref_id` 按 seq 去重写入 `questionIds`。不读正文、不改 state。复跑 Step 1.1 转绿并做小范围
命名/类型重构。

## Task 2：command 返回 pending（RED → GREEN）

### Step 2.1：写唯一 command RED

在 `packages/flywheel-comm/src/__tests__/commands.test.ts` 增加：

```ts
it("reports a queued response without consuming it", () => {
	const db = new CommDB(dbPath);
	const questionId = db.insertQuestion("exec-pending", "product-lead", "Question");
	db.insertResponse(questionId, "product-lead", "Answer");
	db.close();

	const first = inbox({ execId: "exec-pending", dbPath });
	const second = inbox({ execId: "exec-pending", dbPath });
	expect(first).toMatchObject({
		instructions: [],
		pendingMailbox: { queued: 1, leased: 0, questionIds: [questionId] },
	});
	expect(second.pendingMailbox).toEqual(first.pendingMailbox);
});
```

单独运行 commands suite，确认因 `pendingMailbox` 缺失失败：

```bash
pnpm --filter flywheel-comm test:run -- src/__tests__/commands.test.ts
```

### Step 2.2：最小 command GREEN

`InboxResult` 增加 `pendingMailbox: PendingRunnerMailboxSnapshot`。DB 不存在返回
`{ instructions: [], pendingMailbox: { queued: 0, leased: 0, questionIds: [] } }`。正常路径保持顺序：

1. `getUnreadInstructions`；
2. 对每条 instruction 做既有 ACK；
3. `ackRunnerReceiptWakesStarted`；
4. 读取 pending snapshot 并返回。

这样刚展示的 instruction 不会被重复计入 pending，而 response 不被 ACK。复跑 Step 2.1 转绿。

## Task 3：CLI 可见性与字节兼容（逐项 TDD）

### Step 3.1：QUEUED response 文本 RED

在 `packages/flywheel-comm/src/__tests__/cli.test.ts` 构造 question→response，执行默认 inbox，断言：

```text
Runner mailbox pending: 1 queued, 0 leased.
flywheel-comm check <actual-question-id>
```

并断言 stdout 不含 `No instructions.`。先只运行该用例，确认旧 CLI 仍输出 `No instructions.`。

### Step 3.2：pending 文本 GREEN

`packages/flywheel-comm/src/index.ts` 在非 JSON 路径先原样打印 instruction；pending 总数非零时再打印
计数。对每个 `questionIds` 打印真实命令：

```text
Pending question response: run flywheel-comm check <question-id>.
```

没有 question id 的 pending instruction 仍由计数可见。复跑 Step 3.1 转绿。

### Step 3.3：ACKED 后真空字节 guard

新增用例：先发送一条 instruction，第一次 inbox 展示并 ACK；第二次 inbox 必须逐字等于
`No instructions.`。既有完全真空 `toBe("No instructions.")` 与 JSON 数组用例保持原样。

这不是新增行为 RED，而是 Lead scope 的不可回归 guard；它应在 Step 3.2 实现后直接为绿。若失败，
只撤销多余输出，不引入 caveat。复跑完整 inbox CLI suite 和无 DB 阴性用例。

### Step 3.4：第一批提交

task-boundary inbox 检查后提交 DB、command、CLI 与三份测试：

```text
fix(comm): surface pending runner mailbox items
```

## Task 4：runner prompt 判据卫生（RED → GREEN）

### Step 4.1：写双 vendor RED 与 no-lead 阴性

在 `packages/edge-worker/src/__tests__/Blueprint.fly1188-codex-prompt.test.ts` 参数化调用
`buildCodexPrompt()` 与 `buildPrompt({})`，断言有 Lead 时包含：

```text
Pending runner mailbox items may include answers to outstanding questions
run flywheel-comm check for every question id shown
```

再断言无 `leadId` 的 prompt 不含这条 Lead-specific rule。单独运行并确认两个正 case 在旧实现失败。

### Step 4.2：最小 prompt GREEN

在 `packages/edge-worker/src/Blueprint.ts` 现有 `if (ctx.leadId)` inbox 提示后追加一条公共规则，不复制
vendor 分支、不改检查频率。规则只解释新增 pending 摘要：如果列出 question id，逐个走既有 `check`
权威路径；不增加空结果/历史/DEAD 的常驻提示。

更新唯一受影响的 Claude snapshot，再无 update 模式复跑：

```bash
pnpm --filter flywheel-edge-worker test:run -- src/__tests__/Blueprint.fly1188-codex-prompt.test.ts -u
pnpm --filter flywheel-edge-worker test:run -- src/__tests__/Blueprint.fly1188-codex-prompt.test.ts
```

snapshot diff 只能新增该规则。

### Step 4.3：已知未覆盖与治理证据

第一轮 review finding `reported-incident-shape-gets-byte-identical-output` 指出：已经注入并 ACKED 后，
pending 计数为零，CLI 仍输出 `No instructions.`。Lead 的
`[lead-instruction 2222-ruling-byte-identical]` 将该风险明确判为本单外：本单只区分“有待投行/没有
待投行”，不得给高频空轮询追加永久 caveat。压缩或换体后主动查历史应另行设计显式命令。

结构化 ruling 已按 `[lead-instruction 2222-governance-receipt]` 登记：

```text
ruling_id: d2ebf5e3-009a-4800-970c-6fc4ffd43160
findingKey: reported-incident-shape-gets-byte-identical-output
disposition: overruled
follow-up: 风险真实但超出本单；后续设计显式 injected-instruction 历史查询
```

这项不得记成 resolved/fixed。PR body 必须逐字包含 Lead governance receipt 的“审查处置”块，并如实
记录“已知未覆盖 + 不在本单的理由 + 正确后续方向”。

### Step 4.4：第二批提交

task-boundary inbox 检查后提交 Blueprint、测试、snapshot 与修订后的 DOC-FLOW 文档：

```text
fix(runner): teach inbox verdict boundaries
```

## Task 5：聚焦回归、全仓门禁与 request-driven code review

### Step 5.1：聚焦验证与边界审计

```bash
pnpm --filter flywheel-comm build
pnpm --filter flywheel-comm test:run -- src/__tests__/db.test.ts src/__tests__/commands.test.ts src/__tests__/cli.test.ts
pnpm --filter flywheel-edge-worker test:run -- src/__tests__/Blueprint.fly1188-codex-prompt.test.ts
git diff origin/main...HEAD --check
```

确认 response state/read_at 不变、past-expiry live response 可见、empty/JSON stdout 原字节、非空
instruction 格式不变、SQL 无 `INDEXED BY`、schema/index/claim 均未变化。

### Step 5.2：精确全仓门禁

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
bash scripts/__tests__/fly2045-milestone-layout.test.sh
git diff --name-only origin/main...HEAD -- 'scripts/__tests__/*.test.sh'
```

最后一条若列出其他新增/修改 shell suite，也逐个直接运行。

### Step 5.3：冻结 review head 并请求 code review

progress 记录 cursor `5/7`、`full_gates=complete` 后：

```bash
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js stage set code_review
REVIEW_GATE=$(node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js gate review_code \
  --lead flywheel-eng-lead \
  --exec-id 93ef22fa-bb3a-4f6a-b4aa-66aa8253200c \
  --no-block "Code review requested for FLY-2222 inbox verdict hygiene")
REVIEW_QID=$(printf '%s\n' "$REVIEW_GATE" | jq -r '.questionId')
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js request-review \
  --type code --question-id "$REVIEW_QID"
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js check "$REVIEW_QID"
```

request-review lane 调用 `codex:rescue`；禁止 raw `codex exec`。只有结构化
`reviewVerdict=APPROVED` 才继续。`CHANGES_REQUESTED` 按 findingKey 新走 RED/GREEN、重跑完整 gates、
开新 gate/request。APPROVED advisories 用 `ask --report` 转述 Lead。

## Task 6：milestone、PR 与 bounded completion

### Step 6.1：预开 draft PR 以获得真实编号

review 通过后 push 已评审 head，以相同最终标题/正文创建 draft PR，获取 `#NNN`。draft 只用于为
milestone 提供真实 PR 编号；此时不向 Lead 声称 ready，也不触发完成路由。

### Step 6.2：milestone literal last commit

progress 记录 cursor `6/7`、`code_review=complete` 后不再改 progress。按
`engineering/doc/milestones/README.md` 新建：

```markdown
# FLY-2222 — inbox 判据卫生

**Status**: ⏳ Pending ship
**PR**: #NNN
**Date**: 2026-09-03

让 runner 自查可见仍在 QUEUED/LEASED 的 mailbox item，并为 pending response 给出真实
question-id check 命令；保留消息状态机、真空文本和 JSON 合同。
```

单独提交，验证 HEAD 只含该路径，运行 `bash scripts/__tests__/fly2045-milestone-layout.test.sh`，push，
并把 draft PR 标为 ready。milestone 因此是 ready-for-review head 的 literal last commit，且 PR 字段
不是永久 placeholder。

### Step 6.3：PR/CI、Lead 回执与完成路由

PR body 记录生产只读取证、每个 RED/GREEN、query plan、全仓 gates、code review verdict 和不改
delivery 边界；另按治理要求列出 ACKED-history 已知未覆盖、永久 caveat 被拒的理由、显式历史查询
后续方向及结构化 ruling。运行 `gh pr checks <number>`；exit 8 表示 pending，后续 turn 重查，其他
非零先诊断。

最终 inbox 检查后，用 `ask --report` 回执完整 `[lead-instruction 2222-scope]`，包含独立复核、commits
与 PR URL；若有其他未回执 instruction 也分别回执。再发一条 self-contained DONE 总报告，最后：

```bash
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js complete \
  --route needs_review --pr <runtime-pr-number>
```

不 dispatch QA、不请求 ship approval、不 merge、不 deploy。

## 计划自审

- QUEUED/LEASED 与 claim 选择面一致；past-expiry RED 防止条件再次漂移。
- pending response 既有计数也有可执行 question id，但正文与消费权威仍在 `check`。
- 已 ACKED 历史风险显式记为治理后的 known gap；不改真空输出，不把 ACKED DB row 错当“模型已处理”。
- 真空文本/JSON、schema、delivery、lease、ACK 均保持兼容；只新增 pending 非零输出。
- shell milestone guard 明确执行；review/PR/milestone 顺序无占位符且保持 literal last commit。
