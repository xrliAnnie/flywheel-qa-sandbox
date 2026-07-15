/**
 * FLY-1070 substitute-QA — 验证面 4:隔离 module-driven 行为 E2E(E1-E8)
 *
 * 真:dist 编译产物、StateStore(tmp sqlite 文件)、CommDB(tmp,FLYWHEEL_COMM_DIR
 * 隔离——commdb-path.ts 官方测试逃生口)、express 双挂载 router(createBridgeApp,
 * 形态镜像 actions-fly1050 head 测试)、真 PhaseOrchestrator / DirectEventSink /
 * event-route(经 /events HTTP)/ crash-reaper(reapCrashedRunners)。
 *
 * fake 仅 3 面(每个 fake 都记录调用供断言):
 *   1. startDispatcher.start — 记录 + 模拟 pre-launch seam(CommDB grantTurn
 *      epoch 自增 → StateStore 落 alive qa row),模式抄 fly1050 head 测试 :92-:95;
 *   2. tmux/worktree effects(capturePhaseHeadSha 固定 sha / probe 可注入 /
 *      park/close/wake 记录;E3 的 cleanupPending 走【真】lookupTmuxTarget+
 *      killTmuxWindow 对不存在窗口的失败——非 mock);
 *   3. Discord/alert 出口(postIssueThread / alertLeadPipelineError 记录)。
 *
 * fire-and-forget 纪律(Codex R1 #2):正向断言有界轮询 waitFor(5s/25ms);
 * 负向断言等满 SILENCE_MS=800ms 静默窗口再判零(窗口时长记入 evidence)。
 *
 * 运行:node qa-e2e-harness.mjs(串行;每条剧本独立 tmp 环境)
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WT = "/Users/xiaorongli/Dev/flywheel-FLY-1070/worktrees/qa-fly-1070";
const T = `${WT}/packages/teamlead/dist`;
const { PhaseOrchestrator } = await import(`${T}/bridge/phase-orchestrator.js`);
const { StateStore } = await import(`${T}/StateStore.js`);
const { createBridgeApp } = await import(`${T}/bridge/plugin.js`);
const { DirectEventSink } = await import(`${T}/DirectEventSink.js`);
const { reapCrashedRunners } = await import(`${T}/bridge/crash-reaper.js`);
const { DirectiveExecutor } = await import(`${T}/DirectiveExecutor.js`);
const { CommDB } = await import(`${WT}/packages/flywheel-comm/dist/db.js`);
const { WorkflowFSM, WORKFLOW_TRANSITIONS } = await import(
	`${WT}/packages/core/dist/index.js`
);

delete process.env.FLYWHEEL_THREE_STAGE_QA_RESPAWN;

const HEAD = "5da5fd18deadbeef";
const PROJ = "qa1070-proj";
const ISSUE = "FLY-E2E";
const SILENCE_MS = 800; // negative-assertion silence window (recorded)
const WAIT_MS = 5000; // positive-assertion bounded poll
let failures = 0;
let _scenarioNo = 0;
function check(label, cond, detail = "") {
	const tag = cond ? "PASS" : "FAIL";
	if (!cond) failures++;
	console.log(`  [${tag}] ${label}${detail ? ` — ${detail}` : ""}`);
}
function scenario(name) {
	_scenarioNo++;
	console.log(`\n═══ ${name} ═══`);
}
async function waitFor(fn, ms = WAIT_MS, interval = 25) {
	const t0 = Date.now();
	for (;;) {
		if (fn()) return true;
		if (Date.now() - t0 > ms) return false;
		await new Promise((r) => setTimeout(r, interval));
	}
}
const silence = () => new Promise((r) => setTimeout(r, SILENCE_MS));

const testProjects = [
	{
		projectName: PROJ,
		projectRoot: `/tmp/${PROJ}`,
		leads: [
			{
				agentId: "flywheel-eng-lead",
				forumChannel: "test-channel",
				chatChannel: "test-chat",
				match: { labels: ["Flywheel"] },
			},
		],
	},
];
const makeConfig = () => ({
	host: "127.0.0.1",
	port: 0,
	dbPath: ":memory:",
	ingestToken: "ingest-secret",
	notificationChannel: "test-channel",
	defaultLeadAgentId: "flywheel-eng-lead",
	stuckThresholdMinutes: 15,
	stuckCheckIntervalMs: 300000,
	orphanThresholdMinutes: 60,
});

/** One fully-isolated environment per scenario. */
async function makeEnv(opts = {}) {
	const envDir = mkdtempSync(join(tmpdir(), "qa1070-e2e-"));
	// HOME isolation (hermetic terminate path, codex code review R1 MEDIUM) —
	// lookupTmuxTarget / deleteCommDbSession resolve join(homedir(), ".flywheel",
	// "comm", ...) at call time and do NOT honor FLYWHEEL_COMM_DIR; redirecting
	// HOME for the scenario's lifetime guarantees a re-run can never see (kill /
	// delete) production ~/.flywheel state even on a project/exec name collision.
	// Restored in cleanup().
	const savedHome = process.env.HOME;
	process.env.HOME = envDir;
	// FLYWHEEL_COMM_DIR isolation — the code under test (lookupTmuxTarget,
	// hasGateResponse) resolves through commDbPathForProject at call time.
	process.env.FLYWHEEL_COMM_DIR = join(envDir, "comm");
	mkdirSync(join(envDir, "comm", PROJ), { recursive: true });
	const commDbPath = join(envDir, "comm", PROJ, "comm.db");
	const store = await StateStore.create(join(envDir, "state.db"));
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
	let spawnSeq = 0;

	const withComm = (fn) => {
		const db = new CommDB(commDbPath);
		try {
			return fn(db);
		} finally {
			db.close();
		}
	};

	const deps = {
		startDispatcher: {
			start: async (req) => {
				calls.start.push(req);
				if (opts.startDelayMs)
					await new Promise((r) => setTimeout(r, opts.startDelayMs));
				spawnSeq++;
				const execId = `qa-new-${spawnSeq}`;
				// pre-launch seam: TURN grant (epoch auto-inc) then the alive row lands
				withComm((db) =>
					db.grantTurn(req.issueId, execId, req.sessionRole, Date.now()),
				);
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
			probeGhostTmux: async (row) =>
				opts.ghostLivenessFor?.(row) ?? opts.ghostLiveness ?? "absent",
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
		listPhaseSessionRows: (issueId, phase) =>
			store
				.getPhaseSessionsForIssue(issueId)
				.filter((s) => s.chat_thread_role === phase),
		keepAliveEnabled: () => true,
		getAlivePhaseSession: (issueId, phase) =>
			store
				.getPhaseSessionsForIssue(issueId)
				.find((s) => s.chat_thread_role === phase && ALIVE.has(s.status)),
		hasShipFinalizationClaim: (issueId) =>
			store.countEventsByIssueAndType(issueId, "post_ship_finalization_claim") >
			0,
		refreshPhaseStatusLine: async () => {},
		grantTurn: ({ issueId, execId, phase }) =>
			withComm((db) => db.grantTurn(issueId, execId, phase, Date.now())),
		turnBelt: {
			listTurns: () =>
				withComm((db) =>
					db.listTurns().map((turn) => ({ projectName: PROJ, turn })),
				),
			getTurn: (issueId) => withComm((db) => db.getTurn(issueId)),
			deleteTurn: (issueId) => withComm((db) => db.deleteTurn(issueId)),
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
		logger: { log: (m) => logs.push(m), warn: (m) => warns.push(m) },
	};

	const orch = new PhaseOrchestrator(deps);
	const holder = { current: orch };
	const fsm = new WorkflowFSM(WORKFLOW_TRANSITIONS);
	const executor = new DirectiveExecutor(store);
	const transitionOpts = { store, fsm, executor };
	const app = createBridgeApp(
		store,
		testProjects,
		makeConfig(),
		undefined,
		transitionOpts,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{ phaseOrchestrator: holder },
	);
	const server = app.listen(0, "127.0.0.1");
	await new Promise((r) => server.once("listening", r));
	const port = server.address().port;
	const baseUrl = `http://127.0.0.1:${port}`;

	const sink = new DirectEventSink(store, makeConfig(), testProjects);
	sink.phaseOrchestrator = holder;

	const seedImpl = (over = {}) => {
		const row = {
			execution_id: "impl-1",
			issue_id: ISSUE,
			project_name: PROJ,
			status: "awaiting_review",
			session_role: "implement",
			chat_thread_role: "implement",
			...over,
		};
		store.upsertSession(row);
		store.setReviewBinding(row.execution_id, {
			questionId: "q-real-1",
			prHeadSha: HEAD,
		});
		return row;
	};
	const seedQa = (execId, status = "running", over = {}) => {
		store.upsertSession({
			execution_id: execId,
			issue_id: ISSUE,
			project_name: PROJ,
			status,
			session_role: "qa",
			chat_thread_role: "qa",
			...over,
		});
	};
	const postAction = (mount, body) =>
		fetch(`${baseUrl}${mount}/terminate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	const postEvent = (body) =>
		fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(body),
		});
	const getTurn = (issueId) => withComm((db) => db.getTurn(issueId));
	const cleanup = async () => {
		await new Promise((resolve) => server.close(() => resolve()));
		store.close();
		rmSync(envDir, { recursive: true, force: true });
		delete process.env.FLYWHEEL_COMM_DIR;
		process.env.HOME = savedHome;
	};
	return {
		store,
		orch,
		holder,
		sink,
		calls,
		logs,
		warns,
		commDbPath,
		seedImpl,
		seedQa,
		postAction,
		postEvent,
		getTurn,
		withComm,
		cleanup,
		baseUrl,
		transitionOpts,
	};
}

const isStaleAlert = (r) => /stale|TURN/i.test(r) && !/respawn cap/i.test(r);

// ─────────────────────────────────────────────────────────────────────────────
// E1 — 基线:/api/actions terminate 杀活 QA → 事件驱动 respawn
// ─────────────────────────────────────────────────────────────────────────────
{
	scenario(
		"E1 — /api/actions terminate live QA → event-driven respawn (epoch+1, belt quiet)",
	);
	const env = await makeEnv();
	env.seedImpl();
	env.seedQa("qa-0");
	env.withComm((db) => db.grantTurn(ISSUE, "qa-0", "qa", Date.now())); // QA holds the TURN
	const pre = env.getTurn(ISSUE);
	const res = await env.postAction("/api/actions", { execution_id: "qa-0" });
	check("terminate HTTP 200", res.status === 200);
	check(
		"row flipped terminated",
		env.store.getSession("qa-0")?.status === "terminated",
	);
	const spawned = await waitFor(() => env.calls.start.length === 1);
	check(
		"event-driven respawn: exactly 1 start (no boot reconcile ran)",
		spawned,
		`start=${env.calls.start.length}`,
	);
	if (spawned) {
		const req = env.calls.start[0];
		check("sessionRole=qa", req.sessionRole === "qa");
		check("startPoint=implement head", req.startPoint === HEAD);
		check("shareParentBranch=true", req.shareParentBranch === true);
		check(
			"ignoreRunnerLabelSelection=true",
			req.ignoreRunnerLabelSelection === true,
		);
	}
	await waitFor(() => env.getTurn(ISSUE)?.holder_exec_id === "qa-new-1");
	const post = env.getTurn(ISSUE);
	check(
		"CommDB TURN holder = fresh QA",
		post?.holder_exec_id === "qa-new-1",
		JSON.stringify(post),
	);
	check(
		`epoch strictly +1 (${pre?.epoch} → ${post?.epoch})`,
		post?.epoch === (pre?.epoch ?? 0) + 1,
	);
	await silence();
	check(
		"zero STALE-TURN alerts (silence 800ms)",
		!env.calls.alerts.some(isStaleAlert),
		JSON.stringify(env.calls.alerts),
	);
	check(
		"zero alerts overall",
		env.calls.alerts.length === 0,
		JSON.stringify(env.calls.alerts),
	);
	check("exactly 1 respawn thread note", env.calls.threadNotes.length === 1);
	await env.cleanup();
}

// ─────────────────────────────────────────────────────────────────────────────
// E2 — 同 E1 经 /actions dashboard alias(FLY-175 双挂载)
// ─────────────────────────────────────────────────────────────────────────────
{
	scenario("E2 — /actions dashboard alias → same respawn");
	const env = await makeEnv();
	env.seedImpl();
	env.seedQa("qa-0");
	env.withComm((db) => db.grantTurn(ISSUE, "qa-0", "qa", Date.now()));
	const res = await env.postAction("/actions", { execution_id: "qa-0" });
	check("terminate HTTP 200", res.status === 200);
	const spawned = await waitFor(() => env.calls.start.length === 1);
	check(
		"respawn via dashboard mount",
		spawned,
		`start=${env.calls.start.length}`,
	);
	check("sessionRole=qa", env.calls.start[0]?.sessionRole === "qa");
	await silence();
	check("zero alerts", env.calls.alerts.length === 0);
	await env.cleanup();
}

// ─────────────────────────────────────────────────────────────────────────────
// E3a — terminate(成功形态)+ 死 qa 的 tmux 注入 alive → ghostGuard fail-closed
//       挡 spawn + belt TURN 不动。
//       (发现记录:lookupTmuxTarget 硬编码 homedir 路径,对本 harness 的隔离
//       project 恒 gone → terminate 返 success;"kill 不存在窗口" 被 killTmuxWindow
//       明确归为 benign killed:true —— cleanupPending 形态单独走 E3b。)
// ─────────────────────────────────────────────────────────────────────────────
{
	scenario(
		"E3a — terminate success + live-ghost probe → ghostGuard blocks spawn, TURN untouched",
	);
	const env = await makeEnv({
		ghostLivenessFor: (row) =>
			row.execution_id === "qa-0" ? "alive" : "absent",
	});
	env.seedImpl();
	env.seedQa("qa-0", "running", { tmux_session: "qa1070-none:@999" });
	env.withComm((db) => db.grantTurn(ISSUE, "qa-0", "qa", Date.now()));
	const pre = env.getTurn(ISSUE);
	const res = await env.postAction("/api/actions", { execution_id: "qa-0" });
	check(
		"terminate HTTP 200 (tmux lookup gone → success shape)",
		res.status === 200,
	);
	check(
		"FSM row flipped terminated",
		env.store.getSession("qa-0")?.status === "terminated",
	);
	const alerted = await waitFor(() => env.calls.alerts.length >= 1);
	check(
		"qa-loss fired → ghostGuard fail-closed alert",
		alerted,
		JSON.stringify(env.calls.alerts),
	);
	check(
		"alert names the live ghost (refusing duplicate spawn)",
		env.calls.alerts.some(
			(r) => /LIVE|possibly-live/.test(r) && r.includes("qa-0"),
		),
		JSON.stringify(env.calls.alerts),
	);
	await silence();
	check("zero spawn (ghost blocked)", env.calls.start.length === 0);
	const post = env.getTurn(ISSUE);
	check(
		"belt TURN untouched (terminated NOT fast-tracked stale; probe alive → no-op)",
		post?.holder_exec_id === pre?.holder_exec_id && post?.epoch === pre?.epoch,
		`pre=${JSON.stringify(pre)} post=${JSON.stringify(post)}`,
	);
	await env.cleanup();
}

// ─────────────────────────────────────────────────────────────────────────────
// E3b — cleanupPending 真实产线形态:CommDB 读损坏(actions.ts MED-3 注释点名的
//       observable partial-failure)→ success:false + cleanupPending:true,
//       qa-loss 照触发(守卫 (success || cleanupPending),Codex R1 #2)。
//       构造:HOME 覆盖到 tmp(lookupTmuxTarget 硬编码 homedir)+ 该路径下放
//       损坏 comm.db —— 全程零接触真实 ~/.flywheel。
// ─────────────────────────────────────────────────────────────────────────────
{
	scenario(
		"E3b — REAL cleanupPending (corrupt CommDB read) → qa-loss STILL fires → respawn",
	);
	const savedHome = process.env.HOME;
	const fakeHome = mkdtempSync(join(tmpdir(), "qa1070-home-"));
	try {
		const env = await makeEnv();
		env.seedImpl();
		env.seedQa("qa-0");
		// corrupt comm.db at the homedir-hardcoded lookup path (isolated fake HOME)
		mkdirSync(join(fakeHome, ".flywheel", "comm", PROJ), { recursive: true });
		const { writeFileSync } = await import("node:fs");
		writeFileSync(
			join(fakeHome, ".flywheel", "comm", PROJ, "comm.db"),
			"NOT A SQLITE DB",
		);
		process.env.HOME = fakeHome;
		const res = await env.postAction("/api/actions", { execution_id: "qa-0" });
		const body = await res.json();
		check(
			"HTTP 400 + cleanupPending=true (CommDB read error — cannot confirm tmux gone)",
			res.status === 400 && body.cleanupPending === true,
			JSON.stringify(body),
		);
		check(
			"FSM row still flipped terminated",
			env.store.getSession("qa-0")?.status === "terminated",
		);
		const spawned = await waitFor(() => env.calls.start.length === 1);
		check(
			"qa-loss fired on the cleanupPending shape → respawn",
			spawned,
			`start=${env.calls.start.length}`,
		);
		process.env.HOME = savedHome;
		await env.cleanup();
	} finally {
		process.env.HOME = savedHome;
		rmSync(fakeHome, { recursive: true, force: true });
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// E4 — session_failed 两条产线路径:DirectEventSink.emitFailed + /events route
// ─────────────────────────────────────────────────────────────────────────────
{
	scenario(
		"E4a — DirectEventSink.emitFailed(qa) → respawn (qa-loss before belt)",
	);
	const env = await makeEnv();
	env.seedImpl();
	env.seedQa("qa-0");
	env.withComm((db) => db.grantTurn(ISSUE, "qa-0", "qa", Date.now()));
	await env.sink.emitFailed(
		{
			executionId: "qa-0",
			issueId: ISSUE,
			projectName: PROJ,
			sessionRole: "qa",
		},
		"killed in OOM",
	);
	const spawned = await waitFor(() => env.calls.start.length === 1);
	check("respawn after emitFailed", spawned, `start=${env.calls.start.length}`);
	check("row status failed", env.store.getSession("qa-0")?.status === "failed");
	await waitFor(() => env.getTurn(ISSUE)?.holder_exec_id === "qa-new-1");
	check(
		"TURN holder = fresh QA (belt reconcile no-oped via guard 1)",
		env.getTurn(ISSUE)?.holder_exec_id === "qa-new-1",
	);
	await silence();
	check(
		"zero alerts",
		env.calls.alerts.length === 0,
		JSON.stringify(env.calls.alerts),
	);
	await env.cleanup();
}

{
	scenario("E4b — /events session_failed (event-route) → respawn");
	const env = await makeEnv();
	env.seedImpl();
	env.seedQa("qa-0");
	const res = await env.postEvent({
		event_id: "evt-fail-e4b",
		execution_id: "qa-0",
		issue_id: ISSUE,
		project_name: PROJ,
		event_type: "session_failed",
		payload: { error: "killed in OOM" },
	});
	check("/events HTTP 200", res.status === 200);
	const spawned = await waitFor(() => env.calls.start.length === 1);
	check("respawn via event-route", spawned, `start=${env.calls.start.length}`);
	check(
		"sessionRole=qa @ head",
		env.calls.start[0]?.sessionRole === "qa" &&
			env.calls.start[0]?.startPoint === HEAD,
	);
	await silence();
	check("zero alerts", env.calls.alerts.length === 0);
	await env.cleanup();
}

// ─────────────────────────────────────────────────────────────────────────────
// E5 — crash-reaper 钩子(onQaPhaseTerminated 闭包,镜像 plugin.ts:3477)
// ─────────────────────────────────────────────────────────────────────────────
{
	scenario(
		"E5 — crash-reaper reaps stale QA → onQaPhaseTerminated closure → respawn",
	);
	const env = await makeEnv();
	env.seedImpl();
	const staleHeartbeat = new Date(Date.now() - 120 * 60_000)
		.toISOString()
		.replace("T", " ")
		.replace(/\.\d+Z$/, "");
	env.seedQa("qa-0", "running", { heartbeat_at: staleHeartbeat });
	const reapDeps = {
		enabled: true,
		crashGraceMinutes: 60,
		orphanThresholdMinutes: 60,
		nowMs: Date.now(),
		store: env.store,
		transitionOpts: env.transitionOpts,
		isSuppressed: () => false,
		hasPendingCompleteMarker: () => false,
		lookupTmuxTarget: () => ({
			kind: "found",
			target: { tmuxWindow: "geo:@1", sessionName: "geo" },
		}),
		probeLiveness: async () => "dead_pin",
		captureScrollback: async () => ({ ok: true, text: "OOM CRASH" }),
		writeCrashLog: () => ({ path: "/tmp/qa1070-crash.log" }),
		killCmuxLinkedSession: async () => ({ killed: true }),
		killTmuxWindow: async () => ({ killed: true }),
		closeTerminalView: async () => {},
		deleteCommDbSession: () => {},
		archiveThread: async () => {},
		log: () => {},
		// plugin.ts:3477 closure, mirrored verbatim
		onQaPhaseTerminated: (executionId, issueId) => {
			void env.holder.current
				?.reconcileQaLoss({ issueId, terminalExecId: executionId })
				.catch((err) =>
					console.warn(`qa-loss reconcile failed: ${err.message}`),
				);
		},
	};
	const res = await reapCrashedRunners(reapDeps);
	check("reaped exactly 1", res.reaped === 1);
	check(
		"row flipped terminated",
		env.store.getSession("qa-0")?.status === "terminated",
	);
	const spawned = await waitFor(() => env.calls.start.length === 1);
	check(
		"respawn triggered by reaper hook",
		spawned,
		`start=${env.calls.start.length}`,
	);
	await env.cleanup();
}

// ─────────────────────────────────────────────────────────────────────────────
// E6 — cap 风暴(MANDATORY):连杀 3 轮 → 第 3 条死 row 后 failClosed + 零 spawn;
//      再触发仍告警(离散事件语义)
// ─────────────────────────────────────────────────────────────────────────────
{
	scenario(
		"E6 — cap storm: kill → respawn ×2 (epoch increments), 3rd dead row → failClosed, re-trigger re-alerts",
	);
	const env = await makeEnv();
	env.seedImpl();
	env.seedQa("qa-0");
	env.withComm((db) => db.grantTurn(ISSUE, "qa-0", "qa", Date.now())); // epoch 1
	// round 1
	await env.postAction("/api/actions", { execution_id: "qa-0" });
	check("round1: respawn", await waitFor(() => env.calls.start.length === 1));
	check(
		"round1: epoch 2, holder qa-new-1",
		(() => {
			const t = env.getTurn(ISSUE);
			return t?.epoch === 2 && t?.holder_exec_id === "qa-new-1";
		})(),
		JSON.stringify(env.getTurn(ISSUE)),
	);
	// round 2
	await env.postAction("/api/actions", { execution_id: "qa-new-1" });
	check("round2: respawn", await waitFor(() => env.calls.start.length === 2));
	check(
		"round2: epoch 3, holder qa-new-2",
		(() => {
			const t = env.getTurn(ISSUE);
			return t?.epoch === 3 && t?.holder_exec_id === "qa-new-2";
		})(),
		JSON.stringify(env.getTurn(ISSUE)),
	);
	// round 3 → 3rd dead row → cap
	await env.postAction("/api/actions", { execution_id: "qa-new-2" });
	const capAlerted = await waitFor(() =>
		env.calls.alerts.some((r) => r.includes("respawn cap")),
	);
	check(
		"round3: failClosed cap alert",
		capAlerted,
		JSON.stringify(env.calls.alerts),
	);
	await silence();
	check(
		"round3: ZERO further spawn (start stays 2)",
		env.calls.start.length === 2,
		`start=${env.calls.start.length}`,
	);
	const alertsBefore = env.calls.alerts.filter((r) =>
		r.includes("respawn cap"),
	).length;
	// re-trigger through a second production path (emitFailed on the dead row)
	await env.sink.emitFailed(
		{
			executionId: "qa-new-2",
			issueId: ISSUE,
			projectName: PROJ,
			sessionRole: "qa",
		},
		"re-trigger",
	);
	const reAlerted = await waitFor(
		() =>
			env.calls.alerts.filter((r) => r.includes("respawn cap")).length ===
			alertsBefore + 1,
	);
	check(
		"re-trigger → cap re-alerts (discrete-event semantics)",
		reAlerted,
		JSON.stringify(env.calls.alerts),
	);
	await silence();
	check("re-trigger → still zero spawn", env.calls.start.length === 2);
	await env.cleanup();
}

// ─────────────────────────────────────────────────────────────────────────────
// E7 — escape-hatch 对照(MANDATORY):FLYWHEEL_THREE_STAGE_QA_RESPAWN=0
// ─────────────────────────────────────────────────────────────────────────────
{
	scenario(
		"E7 — escape hatch =0: scoped inert + boot reverts row-exists + stranded-pass hardening NOT gated",
	);
	process.env.FLYWHEEL_THREE_STAGE_QA_RESPAWN = "0";
	try {
		// (a) scoped: E1 fixture replay → inert
		const env = await makeEnv();
		env.seedImpl();
		env.seedQa("qa-0");
		const res = await env.postAction("/api/actions", { execution_id: "qa-0" });
		check("terminate HTTP 200", res.status === 200);
		await silence();
		check(
			"(a) scoped reconcileQaLoss inert: zero spawn (silence 800ms)",
			env.calls.start.length === 0,
		);
		// (b) boot criteria reverts to row-exists → skip (pre-fix behavior)
		await env.orch.reconcileOnStartup();
		await silence();
		check(
			"(b) boot row-exists criteria: zero spawn",
			env.calls.start.length === 0,
		);
		// (c) stranded-pass terminated hardening NOT gated by the switch
		env.store.setSessionParams("qa-0", {
			three_stage_verdict: { status: "pass", event_id: "e1", at: "t0" },
		});
		const deadRow = env.store.getSession("qa-0");
		await env.orch.onPhaseComplete(deadRow);
		check(
			"(c) stranded-pass alert still fires with =0 (hardening independent of switch)",
			env.calls.alerts.some(
				(r) => r.includes("terminated") && r.includes("ship gate"),
			),
			JSON.stringify(env.calls.alerts),
		);
		await env.cleanup();
	} finally {
		delete process.env.FLYWHEEL_THREE_STAGE_QA_RESPAWN;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// E8 — 幂等/并发
// ─────────────────────────────────────────────────────────────────────────────
{
	scenario("E8a — after respawn lands alive row, a re-trigger is a no-op");
	const env = await makeEnv();
	env.seedImpl();
	env.seedQa("qa-0");
	await env.postAction("/api/actions", { execution_id: "qa-0" });
	check("respawn once", await waitFor(() => env.calls.start.length === 1));
	// re-trigger via a second production path on the SAME dead row
	await env.sink.emitFailed(
		{
			executionId: "qa-0",
			issueId: ISSUE,
			projectName: PROJ,
			sessionRole: "qa",
		},
		"re-trigger",
	);
	await silence();
	check(
		"re-trigger no-op: start stays 1 (alive qa-new-1 owns the pipeline)",
		env.calls.start.length === 1,
	);
	await env.cleanup();
}

{
	scenario(
		"E8b — two concurrent reconcileQaLoss on the same issue → exactly 1 spawn (in-flight guard)",
	);
	const env = await makeEnv({ startDelayMs: 50 });
	env.seedImpl();
	env.seedQa("qa-0", "terminated");
	await Promise.all([
		env.orch.reconcileQaLoss({ issueId: ISSUE, terminalExecId: "qa-0" }),
		env.orch.reconcileQaLoss({ issueId: ISSUE, terminalExecId: "qa-0" }),
	]);
	check(
		"exactly 1 spawn under concurrency",
		env.calls.start.length === 1,
		`start=${env.calls.start.length}`,
	);
	await env.cleanup();
}

console.log(`\n${"─".repeat(60)}`);
console.log(
	`silence window for negative assertions: ${SILENCE_MS}ms; positive poll bound: ${WAIT_MS}ms`,
);
console.log(
	failures === 0 ? "ALL E2E SCENARIOS PASS" : `${failures} CHECK(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
