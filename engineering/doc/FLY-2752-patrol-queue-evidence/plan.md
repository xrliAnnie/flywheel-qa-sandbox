# FLY-2752 巡检队列证据完成门 — 实施计划
Issue: FLY-2752 (https://linear.app/geoforge3d/issue/FLY-2752/巡检完成门-fly-27021257给巡检快照的-activity-evidencepane-evidence-加了-queue)
日期: 2026-09-18
基于: research.md

> **For agentic workers:** Follow this plan inline under the injected implement TURN. Use
> systematic debugging, TDD, and verification-before-completion; do not dispatch another worker
> or broaden the issue.

**Goal:** 让巡检完成门接受 FLY-2702 已上线的三项 queue 证据、严格校验其取值，同时保留旧报告兼容和未知字段拒绝能力。

**Architecture:** 生产者保持不变。`patrol-report.ts` 为 PANE/ACTIVITY 两类机器行定义显式字段集合，并在已有通用字段解析后调用一个共享的可选 queue 值校验器。单元测试覆盖字段和值合同，现有 snapshot shell 测试把真实生成的机器骨架送入真实 CLI，证明跨层闭环。

**Tech Stack:** TypeScript、Vitest、Bash、现有 `flywheel-patrol-continuity.mjs` CLI。

---

## 文件结构

- 修改 `packages/teamlead/src/__tests__/patrol-report.test.ts`：字段兼容、取值边界与未知字段反例。
- 修改 `scripts/__tests__/lead-patrol-snapshot.test.sh`：真实新版 snapshot 骨架到 validate CLI 的回归。
- 修改 `packages/teamlead/src/patrol-report.ts`：白名单与 queue 值校验的唯一生产实现。
- 创建 `engineering/doc/milestones/FLY-2752.md`：PR literal-last milestone。

### Task 1: 单元测试先锁定字段合同

**Files:**
- Modify: `packages/teamlead/src/__tests__/patrol-report.test.ts`
- Test: `packages/teamlead/src/__tests__/patrol-report.test.ts`

- [ ] **Step 1: 在 `activity report evidence` suite 中构造新版真实字段形状**

在既有 `complete` fixture 后加入：

```ts
const queueFields =
	"queue_request=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa queue_position=3 queue_wait_seconds=65";
const modern = complete
	.replace(`activity_evidence=${id}`, `activity_evidence=${id} ${queueFields}`)
	.replace("branch_activity=no", `branch_activity=no ${queueFields}`);
```

- [ ] **Step 2: 写新版与旧版正向用例**

```ts
it("accepts queue evidence emitted by the current snapshot", () =>
	expect(validatePatrolReport(modern)).toEqual({ valid: true, errors: [] }));
it("keeps accepting legacy evidence without queue fields", () =>
	expect(validatePatrolReport(complete)).toEqual({ valid: true, errors: [] }));
```

- [ ] **Step 3: 写未知字段与非法 queue 值反例**

```ts
for (const [name, value] of [
	["request token", "queue_request=request/one queue_position=3 queue_wait_seconds=65"],
	["negative position", "queue_request=request-one queue_position=-1 queue_wait_seconds=65"],
	["fractional position", "queue_request=request-one queue_position=1.5 queue_wait_seconds=65"],
	["negative wait", "queue_request=request-one queue_position=3 queue_wait_seconds=-1"],
	["fractional wait", "queue_request=request-one queue_position=3 queue_wait_seconds=1.5"],
] as const)
	it(`rejects invalid ${name}`, () =>
		expect(
			validatePatrolReport(
				complete
					.replace(`activity_evidence=${id}`, `activity_evidence=${id} ${value}`)
					.replace("branch_activity=no", `branch_activity=no ${value}`),
			).valid,
		).toBe(false));

it("rejects unknown fields on both machine evidence rows", () => {
	expect(
		validatePatrolReport(
			complete.replace(`activity_evidence=${id}`, `activity_evidence=${id} surprise=yes`),
		).valid,
	).toBe(false);
	expect(
		validatePatrolReport(complete.replace("branch_activity=no", "branch_activity=no surprise=yes"))
			.valid,
	).toBe(false);
});
```

- [ ] **Step 4: 运行 focused Vitest，确认 RED 原因正确**

Run:

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/patrol-report.test.ts
```

Expected: 新版正向用例因三项 `invalid_or_duplicate_field` 失败；pane 未知字段反例因当前无白名单而失败。既有旧版用例仍通过。

### Task 2: 用真实 snapshot 输出建立跨层 RED

**Files:**
- Modify: `scripts/__tests__/lead-patrol-snapshot.test.sh`
- Test: `scripts/__tests__/lead-patrol-snapshot.test.sh`

- [ ] **Step 1: 在 `$PANES_OUT` 真实生成后抽取可独立关闭的机器骨架**

紧接 `run_snapshot "$PANES" "$PANES_OUT"` 后加入：

```bash
VALIDATE_REPORT="$PANES/validate-report.md"
{
  grep -E '^(patrol_schema=2|PANE_EVIDENCE |ACTIVITY_EVIDENCE |ACTIVITY_RECORD )' "$PANES_OUT"
  printf '%s\n' 'MECHANISM_REVIEW result=none count=0'
} > "$VALIDATE_REPORT"
if "$ROOT/scripts/flywheel-patrol-continuity.mjs" validate-report --report "$VALIDATE_REPORT" \
  > "$PANES/validate-report.out" 2>&1; then
  pass "current snapshot machine skeleton passes report validation"
else
  cat "$PANES/validate-report.out"
  fail "current snapshot machine skeleton passes report validation"
fi
```

- [ ] **Step 2: 运行 shell suite，确认 RED 来自 queue allowlist 漂移**

Run:

```bash
bash scripts/__tests__/lead-patrol-snapshot.test.sh
```

Expected: 新断言失败，CLI JSON 含每条新版 activity 行对应的三条 `invalid_or_duplicate_field`；原有 snapshot 断言不发生更早失败。

### Task 3: 最小实现让两组 RED 转绿

**Files:**
- Modify: `packages/teamlead/src/patrol-report.ts`
- Test: `packages/teamlead/src/__tests__/patrol-report.test.ts`
- Test: `scripts/__tests__/lead-patrol-snapshot.test.sh`

- [ ] **Step 1: 定义显式字段集合与规范非负整数格式**

在现有正则常量后加入：

```ts
const NONNEGATIVE_INTEGER = /^(?:0|[1-9][0-9]*)$/;
const PANE_EVIDENCE_FIELDS =
	"pane target owner exec capture_sha256 lines bytes state_sha256 last_change_epoch findings action result schema activity semantic_sha256 last_change_basis last_checked_epoch activity_evidence queue_request queue_position queue_wait_seconds".split(
		" ",
	);
const ACTIVITY_EVIDENCE_FIELDS =
	"id exec activation interval_start interval_end source ref_complete refs_sha256 semantic_sha256 coverage_since reason branch_activity queue_request queue_position queue_wait_seconds".split(
		" ",
	);
```

- [ ] **Step 2: 添加只校验已出现字段的共享函数**

```ts
function validQueueEvidence(fields: Fields): boolean {
	return (
		(!Object.hasOwn(fields, "queue_request") ||
			TOKEN.test(fields.queue_request ?? "")) &&
		(!Object.hasOwn(fields, "queue_position") ||
			NONNEGATIVE_INTEGER.test(fields.queue_position ?? "")) &&
		(!Object.hasOwn(fields, "queue_wait_seconds") ||
			NONNEGATIVE_INTEGER.test(fields.queue_wait_seconds ?? ""))
	);
}
```

- [ ] **Step 3: 对 pane/activity 使用白名单并调用值校验**

替换两个解析分支：

```ts
} else if (line.startsWith("PANE_EVIDENCE")) {
	const p = fields(line, PANE_EVIDENCE_FIELDS);
	if (!validQueueEvidence(p)) fail("invalid_queue_evidence");
	panes.push(p);
} else if (line.startsWith("ACTIVITY_EVIDENCE")) {
	const a = fields(line, ACTIVITY_EVIDENCE_FIELDS);
	if (!validQueueEvidence(a)) fail("invalid_queue_evidence");
	if (!HEX.test(a.id ?? "") || activities.has(a.id ?? ""))
		fail("invalid_activity_identity");
	activities.set(a.id ?? "", a);
```

- [ ] **Step 4: 运行 focused Vitest 与 snapshot shell suite，确认 GREEN**

Run:

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/patrol-report.test.ts
bash scripts/__tests__/lead-patrol-snapshot.test.sh
```

Expected: 两个命令 exit 0；新版和旧版正向用例通过，非法值与未知字段反例通过。

- [ ] **Step 5: 检查 diff，只保留本 issue 所需改动**

Run:

```bash
git diff --check
git diff -- packages/teamlead/src/patrol-report.ts packages/teamlead/src/__tests__/patrol-report.test.ts scripts/__tests__/lead-patrol-snapshot.test.sh
```

Expected: `git diff --check` exit 0；无 snapshot producer、continuity 语义或规则文档改动。

### Task 4: 全量验证、代码评审与 PR

**Files:**
- Create: `engineering/doc/milestones/FLY-2752.md`
- Verify: repository-wide commands

- [ ] **Step 1: 运行角色要求的全量验证**

Run:

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
bash scripts/__tests__/lead-patrol-snapshot.test.sh
```

Expected: lint/build exit 0；package gate 零 assertion failure；shell suite exit 0。若 package gate 只出现允许的 onTaskUpdate RPC infrastructure errors，保存完整 PACKAGE_GATE_RECEIPT，不把它冒充纯绿。

- [ ] **Step 2: 提交实现并推送 feature branch**

Run:

```bash
git add packages/teamlead/src/patrol-report.ts packages/teamlead/src/__tests__/patrol-report.test.ts scripts/__tests__/lead-patrol-snapshot.test.sh engineering/doc/FLY-2752-patrol-queue-evidence
git commit -m "fix(teamlead): validate patrol queue evidence"
git push -u origin flywheel-FLY-2752
```

Expected: push 为 fast-forward，pre-push hooks 通过；不使用 force/no-verify。

- [ ] **Step 3: 创建 literal-last milestone 并推送最终候选 head**

创建 `engineering/doc/milestones/FLY-2752.md`：

```md
# FLY-2752

- 巡检完成门接受并严格校验 queue_request、queue_position、queue_wait_seconds。
- 旧版无 queue 字段报告保持兼容；未知机器字段仍 fail closed。
- 验证证据：focused Vitest、真实 snapshot validate、lint、build、package gate。
```

Run:

```bash
git add engineering/doc/milestones/FLY-2752.md
git commit -m "docs: record FLY-2752 milestone"
git push
```

Expected: milestone 是当前分支 literal last commit；后续评审绑定这个 exact head。

- [ ] **Step 4: 按注入流程请求 exact-head effective code review**

Run:

```bash
node "$FLYWHEEL_COMM_CLI" stage set code_review
REVIEW_JSON="$(node "$FLYWHEEL_COMM_CLI" gate review_code --lead flywheel-eng-lead --exec-id 2ca96e73-335a-4ff1-83bc-ef10f16ed468 --no-block "Code review requested for FLY-2752")"
REVIEW_ID="$(printf '%s\n' "$REVIEW_JSON" | jq -er '.questionId')"
node "$FLYWHEEL_COMM_CLI" request-review --type code --question-id "$REVIEW_ID"
node "$FLYWHEEL_COMM_CLI" check "$REVIEW_ID"
```

Expected: effective `reviewVerdict=APPROVED`。若 CHANGES_REQUESTED，只修 blocking finding，
重跑验证，并再次更新 milestone 形成新的 literal-last commit 后发起新 review question。

- [ ] **Step 5: 在 approved exact head 创建 PR**

Run:

```bash
gh pr create --base main --head flywheel-FLY-2752 \
  --title "FLY-2752: validate patrol queue evidence" \
  --body $'## Summary\n- accept and validate package-gate queue evidence in patrol reports\n- preserve legacy report compatibility and reject unknown evidence fields\n\n## Verification\n- focused patrol-report Vitest\n- real snapshot skeleton validate-report regression\n- pnpm lint\n- pnpm -r build\n- pnpm test:packages:run'
PR_NUMBER="$(gh pr view --json number -q .number)"
gh pr view "$PR_NUMBER" --json number,url,headRefOid
```

Expected: PR 的 `headRefOid` 等于 `git rev-parse HEAD`，且 milestone 仍是 literal last commit。
不请求普通 review revision head 的 full CI，QA 冻结 head 后自行请求。

- [ ] **Step 6: 报告并走 implement completion route**

Run:

```bash
node "$FLYWHEEL_COMM_CLI" ask --lead flywheel-eng-lead --exec-id 2ca96e73-335a-4ff1-83bc-ef10f16ed468 --report "DONE: FLY-2752 implementation complete; tests, review, commit, push, and PR receipts attached in progress ledger"
node "$FLYWHEEL_COMM_CLI" complete --route needs_review --pr "$PR_NUMBER"
```

Expected: completion 返回结构化 receipt；不 merge、不 deploy、不 dispatch QA。

## 自审

- 覆盖 issue 两项正向要求：新版真实骨架与旧版兼容。
- 覆盖 QA 负向要求：未知字段拒绝，并额外验证三项 queue 格式。
- 无占位符，无生产者或 schema 重设计，无 `ci.yml` 修改。
- 所有行为改动先有可观察 RED，再做单一 validator 修复。
