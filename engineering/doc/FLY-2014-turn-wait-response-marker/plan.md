# FLY-2014 turn-wait 回信 marker 边界修复 — 实施计划
Issue: FLY-2014 (https://linear.app/geoforge3d/issue/FLY-2014/flywheel-commbug-respond-对引擎自铸的-turn-wait-冒号-id-必报错答案已落库仍-exit-1safe)
日期: 2026-08-24
基于: research.md

> 执行要求：在当前 implement 节点内使用 `superpowers:test-driven-development`，按
> RED → GREEN → REFACTOR 逐项执行；不 dispatch successor 或 review node。

**Goal:** 让 `flywheel-comm respond` 对 engine-owned `turn-wait:` question 正常
exit 0 且 waiter 可读答案，同时保持 marker 写路径的严格路径穿越防护。

**Architecture:** CommDB question ID 与 marker 文件 ID 是两个不同的命名域。
`gate-marker.ts` 提供一个无副作用的安全路径 lookup：外域 ID返回 `undefined`；mutation
继续经过会抛错的严格 `markerPath`。`respond.ts`、CommDB schema 和 turn-wait 铸号不变。

**Tech Stack:** TypeScript、Node.js ESM、Vitest、better-sqlite3、pnpm monorepo。

---

## 1. 文件职责

| 文件 | 责任 | 本单动作 |
|---|---|---|
| `packages/flywheel-comm/src/gate-marker.ts` | gate/ask marker 文件名、读写与清理 | 增加 read-only safe lookup；不放宽 write |
| `packages/flywheel-comm/src/__tests__/gate-marker.test.ts` | marker 模块安全与状态合同 | 加外域 lookup no-op 与冒号 write 拒绝控制 |
| `packages/flywheel-comm/src/__tests__/cli.test.ts` | built CLI 的真实进程退出码与 Q&A round-trip | 加 turn-wait respond exit 0 + check 回读回归 |
| `packages/flywheel-comm/src/__tests__/respond.gate.test.ts` | Bridge gate respond 路径 | 加 workflow-gate markerless 收尾回归 |
| `engineering/doc/FLY-2014-turn-wait-response-marker/*` | 探索、调研、计划与耐久进度 | 随分支提交，不建状态子目录 |
| `CLAUDE.md` | 当前 milestone 索引 | 在所有验证完成后写本单结果，作为 PR 最后一笔本地 commit |

## 2. 不变量

1. `writeGateMarker`/`writeAskMarker` 对任何不匹配
   `/^[a-zA-Z0-9_-]{1,128}$/` 的 ID继续抛 `invalid questionId`。
2. `readGateMarker`/`readAskMarker` 对外域 ID返回 `undefined`，不得构造或访问外部路径。
3. 安全 UUID marker 的现有 round-trip、answered、delete 行为逐字节不变。
4. `turn-wait:<waiter>:<holder>:<epoch>` 不改格式，保持 FLY-1614 replay 幂等。
5. `respond` 的 guarded response 仍先于 marker 收尾 durable commit；本单不新增宽泛 catch。

### Task 1: RED — 钉住 marker lookup 与 CLI round-trip

**Files:**

- Modify: `packages/flywheel-comm/src/__tests__/gate-marker.test.ts`
- Modify: `packages/flywheel-comm/src/__tests__/cli.test.ts`
- Modify: `packages/flywheel-comm/src/__tests__/respond.gate.test.ts`

- [ ] **Step 1: 写 marker 外域 lookup 失败测试**

在 `gate-marker.test.ts` 导入 `readAskMarker` 与 `writeAskMarker`，加入安全 ID正向控制和
外域 ID负向控制：

```ts
it("treats question ids outside the marker filename domain as missing on read", () => {
	const gateId = "11111111-1111-4111-8111-111111111111";
	writeGateMarker(dir, { ...base, questionId: gateId });
	expect(readGateMarker(dir, gateId)?.executionId).toBe("exec-1");
	markGateMarkerAnswered(dir, gateId);
	expect(readGateMarker(dir, gateId)?.answeredAt).toBeTruthy();

	const askId = "22222222-2222-4222-8222-222222222222";
	writeAskMarker(dir, {
		questionId: askId,
		executionId: "exec-1",
		vendor: "codex",
	});
	expect(readAskMarker(dir, askId)?.executionId).toBe("exec-1");

	for (const questionId of [
		"turn-wait:waiter:holder:1",
		"../evil",
		"a/b",
	]) {
		expect(readGateMarker(dir, questionId)).toBeUndefined();
		expect(readAskMarker(dir, questionId)).toBeUndefined();
	}
});
```

并把现有 write 拒绝测试补上 gate/ask 两个 writer 的冒号控制：

```ts
expect(() =>
	writeGateMarker(dir, {
		...base,
		questionId: "turn-wait:waiter:holder:1",
	}),
).toThrow(/invalid questionId/);
expect(() =>
	writeAskMarker(dir, {
		questionId: "turn-wait:waiter:holder:1",
		executionId: "exec-1",
		vendor: "codex",
	}),
).toThrow(/invalid questionId/);
```

- [ ] **Step 2: 写 built CLI 的 turn-wait 回归测试**

在 `cli.test.ts` 的 `describe("respond")` 内加入：

```ts
it("answers a deterministic turn-wait question with exit 0 and a readable response", () => {
	bindDefaultRunner();
	const questionId = "turn-wait:runner:holder:3";
	const db = new CommDB(dbPath);
	db.insertQuestion("runner", "product-lead", "TURN handoff overdue", {
		id: questionId,
	});
	db.close();

	const result = runCliSafe(
		[
			"respond",
			"--lead",
			"product-lead",
			"--db",
			dbPath,
			questionId,
			"Belt inspected; keep waiting.",
		],
		{ FLYWHEEL_GATE_MARKER_DIR: join(tmpDir, "markers") },
	);
	const answer = runCli(["check", "--db", dbPath, questionId]);

	expect(result.exitCode).toBe(0);
	expect(result.stdout).toContain(`Responded to ${questionId}`);
	expect(answer).toBe("Belt inspected; keep waiting.");
});
```

`runCliSafe` 的成功分支固定返回空 stderr，而测试身份环境本身会产生 lease audit 行，故不
使用 stderr 作为权威断言；退出码、stdout 与 `check` round-trip 足以钉住本故障。

- [ ] **Step 3: 写 Bridge workflow-gate 收尾回归测试**

扩展 `respond.gate.test.ts` 的 `seed` helper 支持显式 ID；在已有成功 Bridge route 测试旁
加入 `workflow-gate:submission-digest` question，mock 2xx Bridge，断言 `respond(...)`
resolve 且请求携带原 ID。当前实现会在 Bridge 2xx 后的 `retireMarker` 抛
`invalid questionId`。

- [ ] **Step 4: 运行 RED 并确认失败原因正确**

Run:

```bash
pnpm --filter flywheel-comm exec vitest run \
  src/__tests__/gate-marker.test.ts \
  src/__tests__/cli.test.ts \
  src/__tests__/respond.gate.test.ts
```

Expected: 新 marker read 测试因 `gate-marker: invalid questionId` 失败；新 CLI 测试显示
`exitCode` 为 1（而 `check` 已读到答案）；Bridge 测试在 mock 2xx 后同样因 marker lookup
失败，证明不是 fixture/鉴权错误。

### Task 2: GREEN — 分离 marker read 与 write 边界

**Files:**

- Modify: `packages/flywheel-comm/src/gate-marker.ts`

- [ ] **Step 1: 写最小 production change**

把路径解析拆成：

```ts
function markerPathIfSafe(
	dir: string,
	questionId: string,
): string | undefined {
	if (!SAFE_QUESTION_ID.test(questionId)) return undefined;
	return join(dir, `${questionId}.json`);
}

function markerPath(dir: string, questionId: string): string {
	const path = markerPathIfSafe(dir, questionId);
	if (!path) {
		throw new Error(`gate-marker: invalid questionId "${questionId}"`);
	}
	return path;
}
```

两个 read API改为：

```ts
const p = markerPathIfSafe(dir, questionId); // ask reader uses askMarkerDir(dir)
if (!p || !existsSync(p)) return undefined;
```

所有 write/remove mutation 继续调用严格 `markerPath`。

- [ ] **Step 2: 构建 fresh dist 并运行 GREEN**

Run:

```bash
pnpm --filter flywheel-comm... build
pnpm --filter flywheel-comm exec vitest run \
  src/__tests__/gate-marker.test.ts \
  src/__tests__/cli.test.ts \
  src/__tests__/respond.gate.test.ts
```

Expected: 三文件全绿；CLI 进程 exit 0，stdout 有 `Responded to turn-wait:...`，
`check` 返回原答案。

- [ ] **Step 3: 检查最小 diff 并提交实现**

Run:

```bash
git diff --check
git diff -- packages/flywheel-comm/src/gate-marker.ts \
  packages/flywheel-comm/src/__tests__/gate-marker.test.ts \
  packages/flywheel-comm/src/__tests__/cli.test.ts \
  packages/flywheel-comm/src/__tests__/respond.gate.test.ts
git add packages/flywheel-comm/src/gate-marker.ts \
  packages/flywheel-comm/src/__tests__/gate-marker.test.ts \
  packages/flywheel-comm/src/__tests__/cli.test.ts \
  packages/flywheel-comm/src/__tests__/respond.gate.test.ts
git commit -m "fix(flywheel-comm): accept markerless engine question ids"
```

Expected: 只有上述一个 production module 与三份测试变化；无 `respond.ts`、DB 或 ID
铸造改动。

### Task 3: REFACTOR/验证 — package 与全仓硬门

**Files:**

- Modify if evidence requires: only the three Task 2 files
- Modify last: `CLAUDE.md`

- [ ] **Step 1: 运行 owning package 全包**

Run:

```bash
pnpm --filter flywheel-comm test:run
```

Expected: baseline 1,614 pass / 2 skip 加三条新测试，即至少 1,617 pass / 2 skip；
若总数随 main 漂移，以零失败和三条新测试具名通过为准。

- [ ] **Step 2: 运行角色要求的 full-repo gates**

Run:

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
```

Expected: lint、22 个 workspace build、canonical package aggregate 无 PR-owned failure。
任何 host/load 失败都保留原始输出，先定向隔离复跑与基线比对，不把失败静默改写成 PASS。

- [ ] **Step 3: 复核 inbox、状态与需求覆盖**

Run:

```bash
node "$FLYWHEEL_COMM_CLI" inbox \
  --exec-id f674d95b-47ca-491d-a473-00556ecfc2b2
git status --short --branch
git diff --check
```

Expected: 没有未处理 Lead instruction；只剩预期文档/CLAUDE 变化；diff 无格式错误。

- [ ] **Step 4: 写 CLAUDE milestone 并保持它为 PR 最后一笔本地 commit**

在 `CLAUDE.md` 当前 milestone 表中加入 FLY-2014：修复边界、RED/GREEN 证据、全仓门
结果与“未部署/未重启/未 merge”。不移动 doc-flow 文件，不创建 archive 状态目录。

```bash
git add CLAUDE.md
git commit -m "docs(FLY-2014): record turn-wait response fix"
```

### Task 4: Codex code review — exact HEAD 循环到 APPROVED

**Files:** none unless reviewer requests a blocking fix

- [ ] **Step 1: 进入 code review stage 并注册 request-driven review**

```bash
node "$FLYWHEEL_COMM_CLI" stage set code_review
fly2014_review_json="$(node "$FLYWHEEL_COMM_CLI" gate review_code \
  --lead flywheel-eng-lead \
  --exec-id f674d95b-47ca-491d-a473-00556ecfc2b2 \
  --no-block "Code review requested for FLY-2014")"
fly2014_review_question_id="$(node -p \
  'JSON.parse(process.argv[1]).questionId' "$fly2014_review_json")"
node --input-type=module -e \
  'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[1], process.argv[2])' \
  /private/tmp/fly2014-code-review-question-id \
  "$fly2014_review_question_id"
node "$FLYWHEEL_COMM_CLI" request-review \
  --type code --question-id "$fly2014_review_question_id"
```

- [ ] **Step 2: 轮询 verdict**

```bash
node "$FLYWHEEL_COMM_CLI" check \
  "$(< /private/tmp/fly2014-code-review-question-id)"
```

Expected: `reviewVerdict=APPROVED`。若 `CHANGES_REQUESTED`，只修 blocking finding，
重新跑 RED/GREEN 与受影响门、提交，然后用新 questionId 开新一轮。APPROVED advisories 通过
`ask --report "DONE: review passed; advisories: ..."` 转 Lead，不阻塞主线。

### Task 5: Push、PR 与 implement 节点 handoff

**Files:** none

- [ ] **Step 1: 推送 feature branch 并创建非 draft PR**

```bash
git push -u origin flywheel-FLY-2014
gh pr create --base main --head flywheel-FLY-2014 \
  --title "FLY-2014: fix turn-wait respond false failure" \
  --body-file /private/tmp/fly2014-pr-body.md
```

PR body 必须包含症状、根因、修法、RED/GREEN、full-repo gate 实际结果、风险边界；本单
没有 CLI 子命令删除/改名，因此 FLY-1914 consumer sweep 不适用。

- [ ] **Step 2: 核对 PR head 与 CI 可见状态**

```bash
fly2014_pr_number="$(gh pr view flywheel-FLY-2014 \
  --json number --jq .number)"
test -n "$fly2014_pr_number"
gh pr view "$fly2014_pr_number" \
  --json url,isDraft,headRefName,headRefOid,baseRefName
git ls-remote origin refs/heads/flywheel-FLY-2014
```

Expected: `isDraft=false`、base=`main`、远端 OID与 `git rev-parse HEAD` 相同。

- [ ] **Step 3: 按 bounded node 路由完成**

```bash
node "$FLYWHEEL_COMM_CLI" complete \
  --route needs_review --pr "$fly2014_pr_number"
```

不请求 ship approval，不调用 `verify-approval`，不 merge，不部署，不投 restart ticket。

## 3. 完成审计矩阵

| 要求 | 权威证据 |
|---|---|
| markerless engine respond exit 0 | built CLI turn-wait 的 `exitCode === 0` 与 stdout；Bridge workflow-gate resolve |
| waiter 可读答案 | 同测试随后真实 `check` 返回精确答案 |
| 路径穿越防护保留 | gate/ask marker write 的外域 ID拒绝测试 |
| UUID marker 不退化 | 新正向控制及既有 round-trip/answered/delete 全绿 |
| 变更最小 | exact diff 不含 `respond.ts`、`db.ts`、schema/ID 铸造 |
| repo 可合入 | lint/build/package gates + exact-head code review APPROVED |
| bounded node 正确交接 | 非 draft PR + `complete --route needs_review --pr N` 回执 |

## 4. 会过期的结论

| 结论 | as-of | 重核命令 |
|---|---|---|
| 变更预计只需 1 production + 3 test files | 2026-08-24 / `533adc64f` | `git diff --name-only origin/main...HEAD` |
| canonical package baseline 是 1,614 pass / 2 skip | 2026-08-24 / `533adc64f` | `pnpm --filter flywheel-comm test:run` |
| 当前分支基于 `origin/main=533adc64f` | 2026-08-24 onboard | `git merge-base --is-ancestor origin/main HEAD && git rev-parse origin/main` |
| PR 尚未存在 | 2026-08-24 plan 时刻 | `gh pr list --head flywheel-FLY-2014 --json number,url,state` |
