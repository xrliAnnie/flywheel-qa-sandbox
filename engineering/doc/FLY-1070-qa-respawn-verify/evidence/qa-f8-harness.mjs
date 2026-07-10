/**
 * FLY-1070 substitute-QA harness — 验证面 2 (F8a-F8d + FLY-1018 + F9) & 面 3 (F10)
 *
 * Imports PR #528 head 5da5fd18 的 **dist 编译产物**(非 src),deps 闭包逐条镜像
 * plugin.ts:4422-4975 的生产接线形态:
 *   - 真 StateStore(每 case 独立实例)— real-store 桶
 *   - 真 CommDB(tmp 目录)— turnBelt / F8a CommDB-only 形态
 *   - fake 仅:startDispatcher(记录 + 模拟 pre-launch seam:落 alive qa row +
 *     grantTurn epoch 自增)、tmux/worktree effects(记录)、Discord/alert 出口(记录)
 *
 * 每个子 case 标注证据来源标签:real-store / CommDB-only / fault-injected / code-audit。
 * 运行:node qa-f8-harness.mjs  (from packages/teamlead dir of the QA worktree)
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WT = "/Users/xiaorongli/Dev/flywheel-FLY-1070/worktrees/qa-fly-1070";
const { PhaseOrchestrator } = await import(
	`${WT}/packages/teamlead/dist/bridge/phase-orchestrator.js`
);
const { StateStore } = await import(
	`${WT}/packages/teamlead/dist/StateStore.js`
);
const { CommDB } = await import(`${WT}/packages/flywheel-comm/dist/db.js`);

// default-ON escape hatch must be untouched in this process
delete process.env.FLYWHEEL_THREE_STAGE_QA_RESPAWN;

const HEAD = "5da5fd18deadbeef";
const PROJ = "qa1070-proj";
let failures = 0;
let caseNo = 0;
function check(label, cond, detail = "") {
	const tag = cond ? "PASS" : "FAIL";
	if (!cond) failures++;
	console.log(`  [${tag}] ${label}${detail ? ` — ${detail}` : ""}`);
}
function section(name) {
	caseNo++;
	console.log(`\n═══ Case ${caseNo}: ${name} ═══`);
}

/** Mirror of plugin.ts deps wiring over a REAL StateStore + REAL CommDB. */
async function makeRealHarness(opts = {}) {
	const store = await StateStore.create(":memory:"); // real StateStore code (sql.js)
	const commRoot = mkdtempSync(join(tmpdir(), "qa1070-comm-"));
	mkdirSync(join(commRoot, PROJ), { recursive: true });
	const commDbPath = join(commRoot, PROJ, "comm.db");
	const calls = {
		start: [],
		alerts: [],
		threadNotes: [],
		parks: 0,
		wakes: 0,
		closes: 0,
	};
	const logs = [];
	const warns = [];
	const ALIVE = new Set([
		"running",
		"awaiting_review",
		"approved_to_ship",
		"design_done",
	]);

	const listPhaseSessionRowsReal = (issueId, phase) =>
		store
			.getPhaseSessionsForIssue(issueId)
			.filter((s) => s.chat_thread_role === phase);

	const deps = {
		startDispatcher: {
			start: async (req) => {
				calls.start.push(req);
				if (opts.startFails) throw new Error("dispatch exploded");
				const execId = `qa-new-${calls.start.length}`;
				// pre-launch seam simulation: grant TURN (epoch auto-inc) THEN land the row
				const db = new CommDB(commDbPath);
				try {
					db.grantTurn(req.issueId, execId, req.sessionRole, Date.now());
				} finally {
					db.close();
				}
				store.upsertSession({
					execution_id: execId,
					issue_id: req.issueId,
					project_name: req.projectName,
					status: "running",
					session_role: req.sessionRole,
					chat_thread_role: req.sessionRole,
				});
				return { executionId: execId };
			},
		},
		effects: {
			capturePhaseHeadSha: async () => HEAD,
			closePhaseRunner: async () => {
				calls.closes++;
			},
			alertLeadPipelineError: async (args) => {
				calls.alerts.push(args.reason);
			},
			probePhaseAlive: async () => "alive",
			probeGhostTmux: async () => opts.ghostLiveness ?? "absent",
			parkPhaseRunner: async () => {
				calls.parks++;
			},
			wakePhaseRunner: async () => {
				calls.wakes++;
				return { ok: true };
			},
			assertPhaseWorktreeReady: async () => ({ ok: true }),
		},
		resolveThreeStage: () => ({ enabled: true }),
		resolveLeadId: () => "flywheel-eng-lead",
		listStrandedDesignPhases: () => [],
		listStrandedImplementPhases: () =>
			store.getStrandedImplementPhaseSessions(),
		listPhaseSessionRows: opts.wrapListPhaseSessionRows
			? opts.wrapListPhaseSessionRows(listPhaseSessionRowsReal)
			: listPhaseSessionRowsReal,
		keepAliveEnabled: () => true,
		getAlivePhaseSession: (issueId, phase) =>
			store
				.getPhaseSessionsForIssue(issueId)
				.find((s) => s.chat_thread_role === phase && ALIVE.has(s.status)),
		hasShipFinalizationClaim: (issueId) =>
			store.countEventsByIssueAndType(issueId, "post_ship_finalization_claim") >
			0,
		refreshPhaseStatusLine: async () => {},
		grantTurn: ({ issueId, execId, phase }) => {
			const db = new CommDB(commDbPath);
			try {
				db.grantTurn(issueId, execId, phase, Date.now());
			} finally {
				db.close();
			}
		},
		turnBelt: {
			listTurns: () => {
				const db = new CommDB(commDbPath);
				try {
					return db.listTurns().map((turn) => ({ projectName: PROJ, turn }));
				} finally {
					db.close();
				}
			},
			getTurn: (issueId) => {
				const db = new CommDB(commDbPath);
				try {
					return db.getTurn(issueId);
				} finally {
					db.close();
				}
			},
			deleteTurn: (issueId) => {
				const db = new CommDB(commDbPath);
				try {
					db.deleteTurn(issueId);
				} finally {
					db.close();
				}
			},
			getSessionForTurnHolder: (execId) => store.getSession(execId),
			getPhaseSessionsForIssue: (issueId) =>
				store.getPhaseSessionsForIssue(issueId),
		},
		qaVerdicts: {
			getSession: (id) => store.getSession(id),
			readIntent: (id) => store.getSessionParams(id)?.three_stage_verdict,
			patchIntent: (id, patch) => {
				const cur = store.getSessionParams(id) ?? {};
				store.setSessionParams(id, {
					...cur,
					three_stage_verdict: { ...(cur.three_stage_verdict ?? {}), ...patch },
				});
			},
			countImplementPhases: (issueId) =>
				store.countSessionsByIssueAndChatThreadRole(issueId, "implement"),
			recordFixRound: () => 1,
			getActiveImplementSession: () => undefined,
			listVerdictEventCandidates: () => [],
			getLatestQaResultEvent: () => undefined,
			listStrandedPassCandidates: () => [],
			postIssueThread: async (_s, text) => {
				calls.threadNotes.push(text);
			},
			hasGateResponse: () => false,
		},
		logger: {
			log: (m) => logs.push(m),
			warn: (m) => warns.push(m),
		},
	};

	const getTurn = (issueId) => {
		const db = new CommDB(commDbPath);
		try {
			return db.getTurn(issueId);
		} finally {
			db.close();
		}
	};
	const cleanup = () => {
		store.close();
		rmSync(commRoot, { recursive: true, force: true });
	};
	return { store, deps, calls, logs, warns, commDbPath, getTurn, cleanup };
}

function seedImpl(store, over = {}) {
	// upsertSession does NOT carry review_question_id / merge_block_reason —
	// production writes them via dedicated setters (setReviewBinding /
	// setMergeBlock). Seed the same way (harness lesson: first run used
	// upsertSession fields and got silently-NULL columns → false reds).
	const { review_question_id, merge_block_reason, ...rest } = {
		execution_id: "impl-1",
		issue_id: "FLY-QA1070",
		project_name: PROJ,
		status: "awaiting_review",
		session_role: "implement",
		chat_thread_role: "implement",
		review_question_id: "q-real-1",
		...over,
	};
	store.upsertSession(rest);
	if (review_question_id) {
		store.setReviewBinding(rest.execution_id, {
			questionId: review_question_id,
			prHeadSha: HEAD,
		});
	}
	if (merge_block_reason) {
		store.setMergeBlock({
			executionId: rest.execution_id,
			reason: merge_block_reason,
			head: HEAD,
		});
	}
}
function seedDeadQa(store, over = {}) {
	store.upsertSession({
		execution_id: "qa-dead-1",
		issue_id: "FLY-QA1070",
		project_name: PROJ,
		status: "terminated",
		session_role: "qa",
		chat_thread_role: "qa",
		...over,
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// F8a — CommDB-only 孤儿(样本① d2f31930 形态):CommDB 有 row(issue_id=NULL),
// StateStore 无 row。 [标签: CommDB-only]
// ─────────────────────────────────────────────────────────────────────────────
{
	section(
		"F8a — CommDB-only orphan (issue_id=NULL in CommDB, NO StateStore row) [CommDB-only]",
	);
	const h = await makeRealHarness();
	// faithful morphology: the orphan exists ONLY in the CommDB session registry
	const db = new CommDB(h.commDbPath);
	db.registerSession("d2f31930-orphan", "w:@1", PROJ); // issueId omitted → NULL
	db.close();
	seedImpl(h.store); // a stranded implement exists — the dangerous backdrop
	const orch = new PhaseOrchestrator(h.deps);
	let threw = false;
	try {
		await orch.reconcileQaLoss({
			issueId: "FLY-QA1070",
			terminalExecId: "d2f31930-orphan",
		});
	} catch {
		threw = true;
	}
	check("does not throw", !threw);
	check(
		"zero spawn (getSession→undefined → main-role default no-op)",
		h.calls.start.length === 0,
	);
	check("zero alerts", h.calls.alerts.length === 0);
	h.cleanup();
}

// ─────────────────────────────────────────────────────────────────────────────
// F8b — 死 qa 形态但 chat_thread_role='main'(跨 scope 僵尸的 StateStore 侧影)
// [标签: real-store]
// ─────────────────────────────────────────────────────────────────────────────
{
	section("F8b — dead main-role row → full no-op [real-store]");
	const h = await makeRealHarness();
	seedImpl(h.store);
	h.store.upsertSession({
		execution_id: "main-dead-1",
		issue_id: "FLY-QA1070",
		project_name: PROJ,
		status: "terminated",
		session_role: "qa",
		chat_thread_role: "main", // the cross-scope zombie's StateStore shadow
	});
	const orch = new PhaseOrchestrator(h.deps);
	await orch.reconcileQaLoss({
		issueId: "FLY-QA1070",
		terminalExecId: "main-dead-1",
	});
	check("zero spawn", h.calls.start.length === 0);
	check("zero alerts", h.calls.alerts.length === 0);
	check("zero thread notes", h.calls.threadNotes.length === 0);
	h.cleanup();
}

// ─────────────────────────────────────────────────────────────────────────────
// F8c real-store 半 — issue_id 形态矩阵(StateStore 侧只含可构造形态:
// issue_id TEXT NOT NULL → 空串 + 跨 project;NULL 归 F8a) [标签: real-store]
// ─────────────────────────────────────────────────────────────────────────────
{
	section(
		"F8c-1 — issue_id='' dead qa row, scoped + boot → no crash, zero spawn [real-store]",
	);
	const h = await makeRealHarness();
	h.store.upsertSession({
		execution_id: "qa-empty-issue",
		issue_id: "",
		project_name: PROJ,
		status: "terminated",
		session_role: "qa",
		chat_thread_role: "qa",
	});
	const orch = new PhaseOrchestrator(h.deps);
	let threw = false;
	try {
		await orch.reconcileQaLoss({
			issueId: "",
			terminalExecId: "qa-empty-issue",
		});
		await orch.reconcileOnStartup();
	} catch {
		threw = true;
	}
	check("does not throw (scoped + boot)", !threw);
	check("zero spawn", h.calls.start.length === 0);
	check("zero alerts", h.calls.alerts.length === 0);
	h.cleanup();
}

{
	section(
		"F8c-2 — cross-project dead qa row (zombie form: NO stranded implement), scoped + boot → no crash, zero spawn [real-store]",
	);
	const h = await makeRealHarness();
	h.store.upsertSession({
		execution_id: "qa-cross-proj",
		issue_id: "OTHER-77",
		project_name: "some-other-project",
		status: "terminated",
		session_role: "qa",
		chat_thread_role: "qa",
	});
	const orch = new PhaseOrchestrator(h.deps);
	let threw = false;
	try {
		await orch.reconcileQaLoss({
			issueId: "OTHER-77",
			terminalExecId: "qa-cross-proj",
		});
		await orch.reconcileOnStartup();
	} catch {
		threw = true;
	}
	check("does not throw", !threw);
	check(
		"zero spawn (no stranded implement → no-op)",
		h.calls.start.length === 0,
	);
	check("zero alerts", h.calls.alerts.length === 0);
	h.cleanup();
}

// ─────────────────────────────────────────────────────────────────────────────
// F8c fault-injected 半 — 判据查询异常 → fail-closed(算 progressed,不重驱)+ 告警
// [标签: fault-injected — 依赖级 throwing seam,不冒充 real-store 覆盖]
// ─────────────────────────────────────────────────────────────────────────────
{
	section(
		"F8c-3 — listPhaseSessionRows throws (qa query) → fail-closed, zero spawn, warn [fault-injected]",
	);
	const h = await makeRealHarness({
		wrapListPhaseSessionRows: (real) => (issueId, phase) => {
			if (phase === "qa") throw new Error("injected query fault");
			return real(issueId, phase);
		},
	});
	seedImpl(h.store);
	seedDeadQa(h.store);
	const orch = new PhaseOrchestrator(h.deps);
	let threw = false;
	try {
		await orch.reconcileQaLoss({
			issueId: "FLY-QA1070",
			terminalExecId: "qa-dead-1",
		});
	} catch {
		threw = true;
	}
	check("does not throw (caught inside criteria)", !threw);
	check(
		"zero spawn (fail-closed: treated as progressed)",
		h.calls.start.length === 0,
	);
	check(
		"fail-closed warn logged",
		h.warns.some((w) => w.includes("treating as progressed")),
		JSON.stringify(h.warns),
	);
	h.cleanup();
}

// ─────────────────────────────────────────────────────────────────────────────
// F8d — scope-free 判定佐证:boot reconcile 是 store-wide(无 leadId scope 检查),
// 跨 project 的 stranded implement 会被遍历到,但判据(alive qa)让它 no-op。
// [标签: real-store + code-audit(行号引用见 qa-report)]
// ─────────────────────────────────────────────────────────────────────────────
{
	section(
		"F8d — cross-project stranded implement IS traversed by boot reconcile, criteria no-ops [real-store]",
	);
	const h = await makeRealHarness();
	h.store.upsertSession({
		execution_id: "impl-other",
		issue_id: "OTHER-88",
		project_name: "some-other-project",
		status: "awaiting_review",
		session_role: "implement",
		chat_thread_role: "implement",
	});
	h.store.setReviewBinding("impl-other", {
		questionId: "q-other",
		prHeadSha: HEAD,
	});
	// alive qa on duty → hasProgressedPastImplement true → skip (no spawn)
	h.store.upsertSession({
		execution_id: "qa-other-alive",
		issue_id: "OTHER-88",
		project_name: "some-other-project",
		status: "running",
		session_role: "qa",
		chat_thread_role: "qa",
	});
	const orch = new PhaseOrchestrator(h.deps);
	await orch.reconcileOnStartup();
	check(
		"cross-project candidate traversed (skip log names impl-other)",
		h.logs.some(
			(l) =>
				l.includes("impl-other") && l.includes("pipeline still owns itself"),
		),
		JSON.stringify(h.logs.filter((l) => l.includes("impl-other"))),
	);
	check("zero spawn (criteria no-op)", h.calls.start.length === 0);
	h.cleanup();
}

// ─────────────────────────────────────────────────────────────────────────────
// 2c — FLY-1018 现场重构:implement@awaiting_review + qa failed ×2 均无 intent
// → 重生 spawn 恰 1 次(与 head F2 单测互证) [标签: real-store]
// ─────────────────────────────────────────────────────────────────────────────
{
	section(
		"FLY-1018 — impl@awaiting_review + 2 dead failed qa (no intent) → exactly 1 respawn [real-store]",
	);
	const h = await makeRealHarness();
	seedImpl(h.store);
	seedDeadQa(h.store, { execution_id: "qa-1018-a", status: "failed" });
	seedDeadQa(h.store, { execution_id: "qa-1018-b", status: "failed" });
	const orch = new PhaseOrchestrator(h.deps);
	await orch.reconcileOnStartup();
	check(
		"exactly 1 spawn",
		h.calls.start.length === 1,
		`start=${h.calls.start.length}`,
	);
	if (h.calls.start.length === 1) {
		const req = h.calls.start[0];
		check("sessionRole=qa", req.sessionRole === "qa");
		check("startPoint=implement head", req.startPoint === HEAD);
		check("shareParentBranch=true", req.shareParentBranch === true);
		check(
			"ignoreRunnerLabelSelection=true",
			req.ignoreRunnerLabelSelection === true,
		);
	}
	check(
		"respawn thread note posted (dead-qa 前科 + alive row landed)",
		h.calls.threadNotes.length === 1,
	);
	const turn = h.getTurn("FLY-QA1070");
	check(
		"TURN granted to fresh QA via pre-launch seam",
		turn?.holder_exec_id === "qa-new-1",
	);
	check("zero alerts", h.calls.alerts.length === 0);
	h.cleanup();
}

// ─────────────────────────────────────────────────────────────────────────────
// 2d — F9 生产真实 marker:merge_block_reason =
// 'merge_without_approval:review_question_unbound/qa_snapshot_missing_exempt'
// → scoped + boot 双路径零 spawn 零告警(isMergeBlocked 非空真值检查对生产形态真截断)
// [标签: real-store,marker 串取自生产库只读快照(research.md §4)]
// ─────────────────────────────────────────────────────────────────────────────
{
	section(
		"F9 — production merge_block marker string truncates respawn on BOTH paths [real-store]",
	);
	const MARKER =
		"merge_without_approval:review_question_unbound/qa_snapshot_missing_exempt";
	const h = await makeRealHarness();
	seedImpl(h.store, { merge_block_reason: MARKER });
	seedDeadQa(h.store);
	const orch = new PhaseOrchestrator(h.deps);
	await orch.reconcileQaLoss({
		issueId: "FLY-QA1070",
		terminalExecId: "qa-dead-1",
	});
	check("scoped: zero spawn", h.calls.start.length === 0);
	check("scoped: zero alerts", h.calls.alerts.length === 0);
	await orch.reconcileOnStartup();
	check("boot: zero spawn", h.calls.start.length === 0);
	check("boot: zero alerts", h.calls.alerts.length === 0);
	check("zero thread notes", h.calls.threadNotes.length === 0);
	check(
		"merge-block skip logged",
		h.logs.some((l) => l.includes("merge-blocked")),
	);
	h.cleanup();
}

// ─────────────────────────────────────────────────────────────────────────────
// F10 — Step 3 验证面 3
// ─────────────────────────────────────────────────────────────────────────────
{
	section(
		"F10-1 — FLY-1023 现状形态(生产快照重构):无 implement@awaiting_review → 零触发 [real-store]",
	);
	// research.md §4 morphology: design completed / implement completed /
	// qa completed(+marker) / implement terminated(+marker) — NO awaiting_review
	const h = await makeRealHarness();
	const MARKER =
		"merge_without_approval:review_question_unbound/qa_snapshot_missing_exempt";
	h.store.upsertSession({
		execution_id: "321fb0cd",
		issue_id: "FLY-1023",
		project_name: PROJ,
		status: "completed",
		session_role: "design",
		chat_thread_role: "design",
	});
	h.store.upsertSession({
		execution_id: "9b4838c3",
		issue_id: "FLY-1023",
		project_name: PROJ,
		status: "completed",
		session_role: "implement",
		chat_thread_role: "implement",
	});
	h.store.setReviewBinding("9b4838c3", {
		questionId: "q-1023",
		prHeadSha: HEAD,
	});
	h.store.upsertSession({
		execution_id: "f561baa4",
		issue_id: "FLY-1023",
		project_name: PROJ,
		status: "completed",
		session_role: "qa",
		chat_thread_role: "qa",
	});
	h.store.setMergeBlock({
		executionId: "f561baa4",
		reason: "merge_without_approval:gate_not_answered",
		head: HEAD,
	});
	h.store.upsertSession({
		execution_id: "3f8be4bb",
		issue_id: "FLY-1023",
		project_name: PROJ,
		status: "terminated",
		session_role: "implement",
		chat_thread_role: "implement",
	});
	h.store.setMergeBlock({
		executionId: "3f8be4bb",
		reason: MARKER,
		head: HEAD,
	});
	const orch = new PhaseOrchestrator(h.deps);
	await orch.reconcileQaLoss({
		issueId: "FLY-1023",
		terminalExecId: "f561baa4",
	});
	await orch.reconcileOnStartup();
	check("zero spawn on current FLY-1023 shape", h.calls.start.length === 0);
	check("zero alerts", h.calls.alerts.length === 0);
	h.cleanup();
}

{
	section(
		"F10-2 — FLY-1047 现状形态(生产快照重构):无 implement@awaiting_review → 零触发 [real-store]",
	);
	const h = await makeRealHarness();
	h.store.upsertSession({
		execution_id: "ad172522",
		issue_id: "FLY-1047",
		project_name: PROJ,
		status: "completed",
		session_role: "design",
		chat_thread_role: "design",
	});
	h.store.upsertSession({
		execution_id: "a0d9163f",
		issue_id: "FLY-1047",
		project_name: PROJ,
		status: "completed",
		session_role: "implement",
		chat_thread_role: "implement",
	});
	h.store.setReviewBinding("a0d9163f", {
		questionId: "q-1047",
		prHeadSha: HEAD,
	});
	h.store.setMergeBlock({
		executionId: "a0d9163f",
		reason: "merge_without_approval:response_not_structured",
		head: HEAD,
	});
	h.store.upsertSession({
		execution_id: "c05e6ab8",
		issue_id: "FLY-1047",
		project_name: PROJ,
		status: "terminated",
		session_role: "qa",
		chat_thread_role: "qa",
	});
	h.store.upsertSession({
		execution_id: "b7d7adf1",
		issue_id: "FLY-1047",
		project_name: PROJ,
		status: "terminated",
		session_role: "implement",
		chat_thread_role: "implement",
	});
	const orch = new PhaseOrchestrator(h.deps);
	await orch.reconcileQaLoss({
		issueId: "FLY-1047",
		terminalExecId: "c05e6ab8",
	});
	await orch.reconcileOnStartup();
	check("zero spawn on current FLY-1047 shape", h.calls.start.length === 0);
	check("zero alerts", h.calls.alerts.length === 0);
	h.cleanup();
}

{
	section(
		"F10-3 — 缺口类实证:issue 已 Done(Linear 状态,StateStore 无关联字段)+ impl@awaiting_review + 死 qa + 无 ship claim + 无 merge_block → boot 触发 spawn(判据无 Done 否决)[real-store + code-audit]",
	);
	// StateStore has NO issue-state field — that absence IS the gap. This fixture
	// is byte-identical to a legitimately-stranded issue; nothing in the criteria
	// (hasProgressedPastImplement, phase-orchestrator.ts:701-720) consults
	// Linear/founder issue state, so the respawn FIRES on a Done issue.
	const h = await makeRealHarness();
	seedImpl(h.store); // issue is Done in Linear — invisible to the store
	seedDeadQa(h.store);
	const orch = new PhaseOrchestrator(h.deps);
	await orch.reconcileOnStartup();
	check(
		"spawn IS triggered (gap confirmed: no issue-Done hard veto)",
		h.calls.start.length === 1,
		`start=${h.calls.start.length}`,
	);
	h.cleanup();
}

console.log(`\n${"─".repeat(60)}`);
console.log(failures === 0 ? "ALL CASES PASS" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
