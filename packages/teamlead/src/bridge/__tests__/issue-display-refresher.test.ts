/**
 * FLY-907 Step 5: lifecycle-node pins for the unified issue-display refresher.
 *
 * Real in-memory StateStore; the Discord writers and CommDB probes are stubbed
 * at their seams (the writers' own network behavior is covered by the
 * ChatThreadCreator / AutoQaEffects suites). Every row of the plan's lifecycle
 * matrix asserts what each of the three faces was asked to render:
 *   design running / park+handoff / awaiting_review(park) / qa FAIL wake /
 *   qa PASS / kill QA / operator-reset / finalize / attach cross-wire.
 */

import type { DesignBackend, WorkflowPhaseRole } from "flywheel-config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTransition } from "../../applyTransition.js";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { StateStore } from "../../StateStore.js";
import { buildWorkflowRunSnapshotV1 } from "../../workflow-run-snapshot.js";
import type { ChatThreadCreator } from "../ChatThreadCreator.js";
import type { DisplayWriteResult, ParkProbe } from "../issue-display.js";
import {
	attachTargetMatchesIssue,
	computeSessionsFingerprint,
	IssueDisplayRefresher,
	type IssueDisplayRefresherDeps,
	parseWorkflowRouteSummary,
} from "../issue-display-refresher.js";
import type { BridgeConfig } from "../types.js";

const ISSUE = "issue-907";
const IDENT = "FLY-907";
const CH = "chan-1";
const THREAD = "thread-1";
const PROJECT = "proj";

it("reads only a valid founder-visible route summary from session params", () => {
	expect(
		parseWorkflowRouteSummary(
			JSON.stringify({
				workflowRoute: {
					summary: "🧭 **Route**: `generic` · source `default_fallback`",
				},
			}),
		),
	).toContain("default_fallback");
	expect(parseWorkflowRouteSummary("{")).toBeUndefined();
	expect(
		parseWorkflowRouteSummary(
			JSON.stringify({ workflowRoute: { summary: 1 } }),
		),
	).toBeUndefined();
});

function makeProjects(): ProjectEntry[] {
	return [
		{
			projectName: PROJECT,
			projectRoot: "/tmp/proj",
			leads: [
				{
					agentId: "lead-1",
					chatChannel: CH,
					match: { labels: [] },
					botToken: "tok",
				},
			],
		},
	];
}

interface TitleCall {
	via: "stage" | "statusBadge";
	stage?: string;
	phaseBadge?: string;
	badge?: string | null;
}

interface FaceLog {
	title: TitleCall[];
	titleMarkers: Array<string | null | undefined>;
	header: string[];
	attachPin: string[];
	unresolved: number;
	/** Legacy scattered status-line messages the refresher deleted (converge). */
	deleted: string[];
}

function makeLog(): FaceLog {
	return {
		title: [],
		titleMarkers: [],
		header: [],
		attachPin: [],
		unresolved: 0,
		deleted: [],
	};
}

function makeCreatorStub(
	log: FaceLog,
	results: Partial<Record<keyof FaceLog | "all", DisplayWriteResult>> = {},
): ChatThreadCreator {
	const r = (k: "title" | "header" | "attachPin"): DisplayWriteResult =>
		results[k] ?? results.all ?? "changed";
	return {
		stampStageEmojiResult: async (
			ctx: unknown,
			_threadId: string,
			stage: string,
			_withWord: boolean,
			phaseBadge?: string | null,
		) => {
			log.titleMarkers.push(
				(ctx as { modelMarker?: string | null }).modelMarker,
			);
			log.title.push({
				via: "stage",
				stage,
				phaseBadge: phaseBadge ?? undefined,
			});
			return r("title");
		},
		stampStatusBadgeResult: async (
			ctx: unknown,
			_threadId: string,
			badge: string | null,
		) => {
			log.titleMarkers.push(
				(ctx as { modelMarker?: string | null }).modelMarker,
			);
			log.title.push({ via: "statusBadge", badge });
			return r("title");
		},
		ensureRunnerPipelineHeaderPinResult: async (
			_ctx: unknown,
			_threadId: string,
			content: string,
		) => {
			log.header.push(content);
			return r("header");
		},
		ensureRunnerAttachPinResult: async (
			_ctx: unknown,
			_threadId: string,
			command: string,
		) => {
			log.attachPin.push(command);
			return r("attachPin");
		},
		ensureRunnerAttachUnresolvedResult: async () => {
			log.unresolved++;
			return r("attachPin");
		},
	} as unknown as ChatThreadCreator;
}

interface HarnessOpts {
	park?: Record<string, ParkProbe>;
	/** execId → tmux window (absent = no CommDB target). */
	tmux?: Record<string, string>;
	/** tmux window → resolved live window_name. */
	windowNames?: Record<string, string>;
	resolveAttach?: IssueDisplayRefresherDeps["resolveAttach"];
	results?: Partial<
		Record<"title" | "header" | "attachPin" | "all", DisplayWriteResult>
	>;
	deleteOk?: boolean;
	isReconnectTitleActive?: (execId: string) => boolean;
	flags?: {
		issueStatusEmojiEnabled?: boolean;
		issueAttachPinEnabled?: boolean;
	};
}

function makeRefresher(store: StateStore, opts: HarnessOpts = {}) {
	const log = makeLog();
	const creator = makeCreatorStub(log, opts.results);
	const refresher = new IssueDisplayRefresher({
		store,
		projects: makeProjects(),
		config: { discordBotToken: "global" } as unknown as BridgeConfig,
		chatThreadCreator: creator,
		deleteMessage: async (_threadId, messageId) => {
			log.deleted.push(messageId);
			return { ok: opts.deleteOk ?? true };
		},
		flags: {
			issueStatusEmojiEnabled: opts.flags?.issueStatusEmojiEnabled ?? true,
			issueAttachPinEnabled: opts.flags?.issueAttachPinEnabled ?? true,
		},
		keepAliveEnabled: () => true,
		isReconnectTitleActive: opts.isReconnectTitleActive,
		readParkProbe: (_project, execId) => opts.park?.[execId] ?? "not_parked",
		getTmuxTarget: (execId) => {
			const w = opts.tmux?.[execId];
			return w ? { tmuxWindow: w, sessionName: w.split(":")[0]! } : undefined;
		},
		resolveAttach:
			opts.resolveAttach ??
			(async (tmuxWindow) => ({
				kind: "cmux",
				session: `cmux-${opts.windowNames?.[tmuxWindow] ?? "unknown"}`,
				windowName: opts.windowNames?.[tmuxWindow],
			})),
	});
	return { refresher, log };
}

/** Assert the pinned header's per-phase state glyphs (设计/实现/QA rows). */
function expectHeaderStates(
	header: string,
	states: { design: string; implement: string; qa: string },
): void {
	expect(header).toMatch(
		new RegExp(`\\*\\*\\[设计[^\\]]*\\]\\*\\* ${states.design}`),
	);
	expect(header).toMatch(
		new RegExp(`\\*\\*\\[实现[^\\]]*\\]\\*\\* ${states.implement}`),
	);
	expect(header).toMatch(
		new RegExp(`\\*\\*\\[QA[^\\]]*\\]\\*\\* ${states.qa}`),
	);
}

let seq = 0;
function seedSession(
	store: StateStore,
	args: {
		exec: string;
		role?: WorkflowPhaseRole | "main";
		status: string;
		stage?: string;
		model?: string;
		designBackend?: DesignBackend;
		backend?: string;
	},
): void {
	seq += 1;
	store.upsertSession({
		execution_id: args.exec,
		issue_id: ISSUE,
		project_name: PROJECT,
		status: args.status,
		issue_identifier: IDENT,
		issue_title: "thread display refresh",
		// Monotonic timestamps so "latest per role" is deterministic.
		last_activity_at: `2026-07-06 10:00:${String(seq).padStart(2, "0")}`,
		chat_thread_role: args.role ?? "main",
		session_role: args.role ?? "main",
		runner_model: args.model,
		design_backend: args.designBackend,
		adapter_type: args.backend,
	});
	if (args.stage) {
		store.patchSessionMetadata(args.exec, { session_stage: args.stage });
	}
}

function storedFingerprint(store: StateStore): string | null {
	return (
		store
			.listDisplayReconcileCandidates(null, 10)
			.find((c) => c.issue_id === ISSUE)?.display_fingerprint ?? null
	);
}

describe("IssueDisplayRefresher — lifecycle matrix (plan Step 5)", () => {
	let store: StateStore;

	beforeEach(async () => {
		seq = 0;
		store = await StateStore.create(":memory:");
		store.upsertChatThread(THREAD, CH, ISSUE);
	});
	afterEach(() => {
		store.close();
		vi.restoreAllMocks();
	});

	it("FLY-1709: archived thread writes no display face and persists a terminal fingerprint", async () => {
		seedSession(store, { exec: "e-main", role: "main", status: "terminated" });
		store.markChatThreadArchived(THREAD);
		store.setPhaseStatusLine(ISSUE, CH, "legacy-line", "stale");
		const { refresher, log } = makeRefresher(store);

		await refresher.refresh(ISSUE);

		expect(log.title).toEqual([]);
		expect(log.header).toEqual([]);
		expect(log.attachPin).toEqual([]);
		expect(log.deleted).toEqual([]);
		const fingerprint = JSON.parse(storedFingerprint(store)!);
		expect(JSON.parse(fingerprint.c)).toEqual({ archived: true });
	});

	it("design running → title 🎨设计, header 设计▶/实现◾/QA◾ (状态收敛在置顶块一处)", async () => {
		seedSession(store, { exec: "e-design", role: "design", status: "running" });
		const { refresher, log } = makeRefresher(store, {
			tmux: { "e-design": "runner-proj:@1" },
			windowNames: { "runner-proj:@1": `${IDENT}-runner-design` },
		});
		await refresher.refresh(ISSUE);

		expect(log.title).toEqual([
			{ via: "stage", stage: "", phaseBadge: "🎨设计" },
		]);
		const header = log.header[0]!;
		expect(header).toContain("▶ 进行中 · exec `e-design`".slice(0, 20));
		expect(header).toContain("◾ 未开始");
		expect(header).not.toContain("✅");
		expectHeaderStates(header, {
			design: "▶ 进行中",
			implement: "◾ 未开始",
			qa: "◾ 未开始",
		});
	});

	it("renders pending workflow actor models from the immutable run snapshot", async () => {
		const snapshot = buildWorkflowRunSnapshotV1({
			template: { id: "tpl-display", revision: 1 },
			manifest: {
				schema_version: 1,
				nodes: [
					{
						id: "design",
						type: "design",
						vendor: "claude",
						model: "claude-fable-5",
						effort: "high",
					},
					{
						id: "implement",
						type: "implement",
						vendor: "codex",
						model: "gpt-5.6-sol",
						effort: "high",
					},
					{
						id: "qa",
						type: "qa",
						vendor: "claude",
						model: "claude-opus-4-6[1m]",
						effort: "high",
					},
					{ id: "founder_gate", type: "gate" },
				],
				edges: [
					{
						id: "design_done",
						from: "design",
						to: "implement",
						condition: "design_done",
					},
					{
						id: "implement_done",
						from: "implement",
						to: "qa",
						condition: "implement_done",
					},
					{
						id: "qa_pass",
						from: "qa",
						to: "founder_gate",
						condition: "qa_pass",
					},
				],
				loops: [
					{
						id: "qa_retry",
						from: "qa",
						to: "implement",
						loop_when: "qa_fail",
						exit_when: "qa_pass",
						max_iterations: 3,
						on_limit: "escalate",
					},
				],
				terminal_gate: {
					node: "founder_gate",
					predicate: "founder_approved",
				},
				ship_claims: ["qa_passed", "founder_approved"],
			},
		});
		store.createWorkflowRun({
			runId: "run-display",
			issueId: ISSUE,
			projectName: PROJECT,
			snapshotJson: JSON.stringify(snapshot),
			claimsReadEnrolled: false,
		});
		seedSession(store, {
			exec: "e-design",
			role: "design",
			status: "running",
			model: "claude-fable-5",
		});
		const { refresher, log } = makeRefresher(store, {
			tmux: { "e-design": "runner-proj:@1" },
			windowNames: { "runner-proj:@1": `${IDENT}-runner-design` },
		});

		await refresher.refresh(ISSUE);

		expect(log.header[0]).toContain(
			"**[实现·GPT-5.6]** ◾ 未开始（计划模型 GPT-5.6）",
		);
		expect(log.header[0]).toContain("**[QA·Opus]** ◾ 未开始（计划模型 Opus）");
	});

	it("does not guess a model from persisted codex design backend metadata", async () => {
		seedSession(store, {
			exec: "e-design",
			role: "design",
			status: "running",
			designBackend: "codex",
		});
		const { refresher, log } = makeRefresher(store);

		await refresher.refresh(ISSUE);

		expect(log.header[0]).not.toMatch(/\[设计·/);
	});

	it("does not guess a model from persisted claude design backend metadata", async () => {
		seedSession(store, {
			exec: "e-design",
			role: "design",
			status: "running",
			designBackend: "claude",
		});
		const { refresher, log } = makeRefresher(store);

		await refresher.refresh(ISSUE);

		expect(log.header[0]).not.toMatch(/\[设计·/);
	});

	it("design park+handoff (design_done+parked, implement running) → 设计✅ 实现▶, title 🔨实现", async () => {
		seedSession(store, {
			exec: "e-design",
			role: "design",
			status: "design_done",
		});
		seedSession(store, {
			exec: "e-impl",
			role: "implement",
			status: "running",
		});
		const { refresher, log } = makeRefresher(store, {
			park: { "e-design": "parked" },
		});
		await refresher.refresh(ISSUE);

		expect(log.title).toEqual([
			{ via: "stage", stage: "", phaseBadge: "🔨实现" },
		]);
		expectHeaderStates(log.header[0]!, {
			design: "✅ 完成",
			implement: "▶ 进行中",
			qa: "◾ 未开始",
		});
	});

	it("implement awaiting_review(parked) + qa running → header 实现✅, title 🧪QA", async () => {
		seedSession(store, {
			exec: "e-design",
			role: "design",
			status: "design_done",
		});
		seedSession(store, {
			exec: "e-impl",
			role: "implement",
			status: "awaiting_review",
		});
		seedSession(store, { exec: "e-qa", role: "qa", status: "running" });
		const { refresher, log } = makeRefresher(store, {
			park: { "e-design": "parked", "e-impl": "parked" },
		});
		await refresher.refresh(ISSUE);

		expect(log.title).toEqual([
			{ via: "stage", stage: "", phaseBadge: "🧪QA" },
		]);
		expectHeaderStates(log.header[0]!, {
			design: "✅ 完成",
			implement: "✅ 完成",
			qa: "▶ 进行中",
		});
	});

	it("qa FAIL → wake implement (park marker cleared) → 实现 flips BACK to ▶, title back to 🔨实现 (FLY-543 correction — never a fake ✅)", async () => {
		seedSession(store, {
			exec: "e-design",
			role: "design",
			status: "design_done",
		});
		seedSession(store, {
			exec: "e-impl",
			role: "implement",
			status: "awaiting_review",
		});
		seedSession(store, { exec: "e-qa", role: "qa", status: "running" });
		const { refresher, log } = makeRefresher(store, {
			// wake cleared implement's marker; QA parked itself awaiting re-test.
			park: { "e-design": "parked", "e-impl": "not_parked", "e-qa": "parked" },
		});
		await refresher.refresh(ISSUE);

		expect(log.title).toEqual([
			{ via: "stage", stage: "", phaseBadge: "🔨实现" },
		]);
		// The parked QA's round is at a boundary (✅, not a lingering ▶); the
		// woken implement is the one genuinely working.
		expectHeaderStates(log.header[0]!, {
			design: "✅ 完成",
			implement: "▶ 进行中",
			qa: "✅ 完成",
		});
	});

	it("qa PASS (qa at awaiting_review + parked, holding the ship gate) → title waits for approval while phase rows stay done", async () => {
		seedSession(store, {
			exec: "e-design",
			role: "design",
			status: "design_done",
		});
		seedSession(store, {
			exec: "e-impl",
			role: "implement",
			status: "awaiting_review",
		});
		seedSession(store, {
			exec: "e-qa",
			role: "qa",
			status: "awaiting_review",
		});
		const { refresher, log } = makeRefresher(store, {
			park: {
				"e-design": "parked",
				"e-impl": "parked",
				"e-qa": "parked",
			},
		});
		await refresher.refresh(ISSUE);

		expectHeaderStates(log.header[0]!, {
			design: "✅ 完成",
			implement: "✅ 完成",
			qa: "✅ 完成",
		});
		expect(log.title).toEqual([{ via: "stage", stage: "approve" }]);
	});

	it("post-ship finalization completion → completed during the stale awaiting_review cleanup window", async () => {
		seedSession(store, {
			exec: "e-design",
			role: "design",
			status: "design_done",
		});
		seedSession(store, {
			exec: "e-impl",
			role: "implement",
			status: "awaiting_review",
		});
		seedSession(store, { exec: "e-qa", role: "qa", status: "completed" });
		store.insertEvent({
			event_id: "claim-issue-907",
			execution_id: "e-qa",
			issue_id: ISSUE,
			project_name: PROJECT,
			event_type: "post_ship_finalization_completed",
			source: "test",
		});
		const { refresher, log } = makeRefresher(store, {
			park: { "e-design": "parked", "e-impl": "parked" },
		});
		await refresher.refresh(ISSUE);

		expect(log.title).toEqual([{ via: "stage", stage: "completed" }]);
	});

	it("merge_block without a post-ship claim remains at approval, never completed", async () => {
		seedSession(store, {
			exec: "e-design",
			role: "design",
			status: "design_done",
		});
		seedSession(store, {
			exec: "e-impl",
			role: "implement",
			status: "awaiting_review",
		});
		seedSession(store, {
			exec: "e-qa",
			role: "qa",
			status: "awaiting_review",
		});
		store.insertEvent({
			event_id: "merge-block-issue-907",
			execution_id: "e-qa",
			issue_id: ISSUE,
			project_name: PROJECT,
			event_type: "merge_block",
			source: "test",
		});
		const { refresher, log } = makeRefresher(store, {
			park: {
				"e-design": "parked",
				"e-impl": "parked",
				"e-qa": "parked",
			},
		});
		await refresher.refresh(ISSUE);

		expect(log.title).toEqual([{ via: "stage", stage: "approve" }]);
	});

	it("kill/terminate QA → header QA 🔴, title 🔴受阻", async () => {
		seedSession(store, {
			exec: "e-design",
			role: "design",
			status: "design_done",
		});
		seedSession(store, {
			exec: "e-impl",
			role: "implement",
			status: "awaiting_review",
		});
		seedSession(store, { exec: "e-qa", role: "qa", status: "terminated" });
		const { refresher, log } = makeRefresher(store, {
			park: { "e-design": "parked", "e-impl": "parked" },
		});
		await refresher.refresh(ISSUE);

		expect(log.title).toEqual([{ via: "statusBadge", badge: "🔴受阻" }]);
		expect(log.header[0]).toContain("🔴 受阻");
		expectHeaderStates(log.header[0]!, {
			design: "✅ 完成",
			implement: "✅ 完成",
			qa: "🔴 受阻",
		});
	});

	it("FLY-1709 R1: an earlier completed phase cannot make a terminated phase look concluded", async () => {
		seedSession(store, {
			exec: "e-design",
			role: "design",
			status: "completed",
		});
		seedSession(store, {
			exec: "e-impl",
			role: "implement",
			status: "terminated",
		});
		const { refresher, log } = makeRefresher(store);

		await refresher.refresh(ISSUE);

		expect(log.title).toEqual([{ via: "statusBadge", badge: "🔴受阻" }]);
		expectHeaderStates(log.header[0]!, {
			design: "✅ 完成",
			implement: "🔴 受阻",
			qa: "◾ 未开始",
		});
	});

	it("FLY-1709 R1: completed predecessors cannot make a running QA phase look concluded", async () => {
		seedSession(store, {
			exec: "e-design",
			role: "design",
			status: "completed",
		});
		seedSession(store, {
			exec: "e-impl",
			role: "implement",
			status: "completed",
		});
		seedSession(store, { exec: "e-qa", role: "qa", status: "running" });
		const { refresher, log } = makeRefresher(store, {
			park: { "e-qa": "parked" },
		});

		await refresher.refresh(ISSUE);

		expect(log.title).toEqual([
			{ via: "stage", stage: "", phaseBadge: "🧪QA" },
		]);
		expectHeaderStates(log.header[0]!, {
			design: "✅ 完成",
			implement: "✅ 完成",
			qa: "✅ 完成",
		});
	});

	it("FLY-1709 R3: a historical completed main cannot conclude a later terminated main", async () => {
		seedSession(store, {
			exec: "e-main-old",
			role: "main",
			status: "completed",
		});
		seedSession(store, {
			exec: "e-main-latest",
			role: "main",
			status: "terminated",
		});
		const { refresher, log } = makeRefresher(store);

		await refresher.refresh(ISSUE);

		expect(log.title).toEqual([{ via: "statusBadge", badge: "🔴受阻" }]);
	});

	it("FLY-1709 R3: a merge-confirmed terminated main is concluded cleanup", async () => {
		seedSession(store, {
			exec: "e-main-cleanup",
			role: "main",
			status: "terminated",
		});
		store.insertEvent({
			event_id: "merge-claim-1709",
			execution_id: "e-main-cleanup",
			issue_id: ISSUE,
			project_name: PROJECT,
			event_type: "post_ship_finalization_claim",
			source: "test",
		});
		const { refresher, log } = makeRefresher(store);

		await refresher.refresh(ISSUE);

		expect(log.title).toEqual([
			{ via: "stage", stage: "completed", phaseBadge: undefined },
		]);
	});

	it("operator-reset (terminate + re-dispatch new exec) → header shows the NEW exec id + its attach command, state back to ▶", async () => {
		seedSession(store, { exec: "e-qa-old", role: "qa", status: "terminated" });
		seedSession(store, { exec: "e-qa-new1", role: "qa", status: "running" });
		const { refresher, log } = makeRefresher(store, {
			tmux: { "e-qa-new1": "runner-proj:@9" },
			windowNames: { "runner-proj:@9": `${IDENT}-runner-qa` },
		});
		await refresher.refresh(ISSUE);

		const header = log.header[0]!;
		expect(header).toContain("e-qa-new"); // execId.slice(0,8)
		expect(header).not.toContain("e-qa-old");
		expect(header).toContain(`cmux-${IDENT}-runner-qa`);
		expect(log.title).toEqual([
			{ via: "stage", stage: "", phaseBadge: "🧪QA" },
		]);
	});

	it("finalize (ship 收尾, all phases completed) → title ✅完成, header all ✅ — 不留任何「进行中」", async () => {
		seedSession(store, {
			exec: "e-design",
			role: "design",
			status: "completed",
		});
		seedSession(store, {
			exec: "e-impl",
			role: "implement",
			status: "completed",
		});
		seedSession(store, { exec: "e-qa", role: "qa", status: "completed" });
		// Post-ship finalization leaves NO park markers — terminal-done must not
		// flip back to active (the 1a unconditional-done contract).
		const { refresher, log } = makeRefresher(store, {
			park: {
				"e-design": "not_parked",
				"e-impl": "not_parked",
				"e-qa": "not_parked",
			},
		});
		await refresher.refresh(ISSUE);

		expect(log.title).toEqual([{ via: "stage", stage: "completed" }]);
		const header = log.header[0]!;
		expect(header).not.toContain("▶ 进行中");
		expect(header.match(/✅ 完成/g)?.length).toBe(3);
	});

	it("attach cross-wire (window_name belongs to ANOTHER issue) → command withheld, degraded 终端待解析 row + warn (FLY-543/923)", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		seedSession(store, {
			exec: "e-impl",
			role: "implement",
			status: "running",
		});
		const { refresher, log } = makeRefresher(store, {
			tmux: { "e-impl": "runner-proj:@3" },
			// Cross-wired: resolves to an FLY-921 window while rendering FLY-907.
			windowNames: { "runner-proj:@3": "FLY-921-runner-impl" },
		});
		await refresher.refresh(ISSUE);

		const header = log.header[0]!;
		expect(header).toContain("（终端待解析）");
		expect(header).not.toContain("tmux attach");
		expect(header).not.toContain("FLY-921");
		expect(
			warn.mock.calls.some((c) => String(c[0]).includes("attach cross-wire")),
		).toBe(true);
	});

	it("single-runner (non-DAG workflow) cross-wire → the pin is actively degraded, never left showing the wrong link", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		seedSession(store, {
			exec: "e-main",
			role: "main",
			status: "running",
			stage: "implement",
		});
		const { refresher, log } = makeRefresher(store, {
			tmux: { "e-main": "runner-proj:@5" },
			windowNames: { "runner-proj:@5": "FLY-921-runner-x" },
		});
		await refresher.refresh(ISSUE);

		expect(log.unresolved).toBe(1);
		expect(log.attachPin).toEqual([]);
	});

	it("passes the execution identity into founder attach resolution and renders unresolved instead of another phase", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		seedSession(store, {
			exec: "e-main",
			role: "main",
			status: "running",
			stage: "implement",
		});
		const resolved: Array<[string, string]> = [];
		const { refresher, log } = makeRefresher(store, {
			tmux: { "e-main": "runner-proj:@999" },
			resolveAttach: async (tmuxWindow, expectedExecutionId) => {
				resolved.push([tmuxWindow, expectedExecutionId]);
				return {
					kind: "unresolved",
					tmuxWindow,
					reason: "window-id-mismatch",
				};
			},
		});

		await refresher.refresh(ISSUE);

		expect(resolved).toEqual([["runner-proj:@999", "e-main"]]);
		expect(log.unresolved).toBe(1);
		expect(log.attachPin).toEqual([]);
	});

	it("single-runner sentinel: a running main session renders its persisted session_stage badge + the legacy attach command (byte-compat at the stage_changed moment)", async () => {
		seedSession(store, {
			exec: "e-main",
			role: "main",
			status: "running",
			stage: "implement",
		});
		const { refresher, log } = makeRefresher(store, {
			tmux: { "e-main": "runner-proj:@5" },
			windowNames: { "runner-proj:@5": `${IDENT}-runner-x` },
		});
		await refresher.refresh(ISSUE);

		// Face A: exactly the reported stage — identical badge input to the
		// legacy stampStageEmojiForSession path.
		expect(log.title).toEqual([{ via: "stage", stage: "implement" }]);
		// Face B: the byte-compat single-runner pin with the SAME command the
		// legacy path builds (buildAttachCommand of the cmux target).
		expect(log.attachPin).toEqual([
			`env -u TMUX tmux attach -t '=cmux-${IDENT}-runner-x'`,
		]);
		expect(log.header).toEqual([]); // no pipeline header on a single-session issue
		expect(log.deleted).toEqual([]); // no legacy status line to clean
	});

	it("renders the actual Codex model marker from the persisted session", async () => {
		seedSession(store, {
			exec: "e-main",
			role: "main",
			status: "running",
			stage: "implement",
			backend: "codex-tmux",
			model: "gpt-5.6-sol",
		});
		const { refresher, log } = makeRefresher(store);
		await refresher.refresh(ISSUE);

		expect(log.titleMarkers[0]).toBe("G");
	});

	it("pending implement without a recorded model gets no guessed marker", async () => {
		seedSession(store, {
			exec: "e-impl",
			role: "implement",
			status: "running",
		});
		const { refresher, log } = makeRefresher(store);
		await refresher.refresh(ISSUE);

		expect(log.titleMarkers[0]).toBeNull();
	});

	it("single-session terminal states: completed → ✅完成; failed → 🔴受阻 (kill/reset now refresh — the old code never did)", async () => {
		seedSession(store, {
			exec: "e-main",
			role: "main",
			status: "failed",
			stage: "implement",
		});
		const { refresher, log } = makeRefresher(store, {});
		await refresher.refresh(ISSUE);
		expect(log.title).toEqual([{ via: "statusBadge", badge: "🔴受阻" }]);
	});

	it("fingerprint persists ONLY when every enabled face landed (changed/noop) — a failed face keeps the issue a sweep candidate (Codex R2 #2)", async () => {
		seedSession(store, { exec: "e-design", role: "design", status: "running" });

		// Failing header write → NO fingerprint.
		const fail = makeRefresher(store, { results: { header: "failed" } });
		await fail.refresher.refresh(ISSUE);
		expect(storedFingerprint(store)).toBeNull();

		// All faces land → fingerprint persisted, sessions component comparable.
		const ok = makeRefresher(store, {});
		await ok.refresher.refresh(ISSUE);
		const fp = storedFingerprint(store);
		expect(fp).not.toBeNull();
		expect(JSON.parse(fp!).s).toBe(computeSessionsFingerprint(store, ISSUE));
	});

	it("a deferred canonical title write withholds the success fingerprint", async () => {
		seedSession(store, { exec: "e-design", role: "design", status: "running" });
		const { refresher } = makeRefresher(store, {
			results: { title: "deferred" },
		});
		await refresher.refresh(ISSUE);
		expect(storedFingerprint(store)).toBeNull();
	});

	it("title-active guard defers Face A and withholds the fingerprint", async () => {
		seedSession(store, {
			exec: "e-main",
			role: "main",
			status: "running",
			stage: "implement",
		});
		const { refresher, log } = makeRefresher(store, {
			isReconnectTitleActive: () => true,
			tmux: { "e-main": "runner-proj:@5" },
			windowNames: { "runner-proj:@5": `${IDENT}-runner-x` },
		});
		await refresher.refresh(ISSUE);
		expect(log.title).toEqual([]);
		expect(storedFingerprint(store)).toBeNull();
	});

	it("FLY-1264: boot title settle lets the same persisted stage replace ⚠️ without a runner event", async () => {
		seedSession(store, {
			exec: "e-main",
			role: "main",
			status: "running",
			stage: "implement",
		});
		let titleActive = true;
		const { refresher, log } = makeRefresher(store, {
			isReconnectTitleActive: () => titleActive,
			tmux: { "e-main": "runner-proj:@5" },
			windowNames: { "runner-proj:@5": `${IDENT}-runner-x` },
		});

		await refresher.refresh(ISSUE);
		expect(log.title).toEqual([]);
		expect(storedFingerprint(store)).toBeNull();

		titleActive = false;
		await refresher.refresh(ISSUE);
		expect(log.title).toEqual([{ via: "stage", stage: "implement" }]);
		expect(storedFingerprint(store)).not.toBeNull();
	});

	it("Lead 指令 17ab4f53 收敛: a legacy scattered status-line message is DELETED (record cleared) — 一处置顶、原地更新、别散发", async () => {
		seedSession(store, { exec: "e-design", role: "design", status: "running" });
		// Simulate the pre-FLY-907 scattered standalone status-line message.
		store.setPhaseStatusLine(
			ISSUE,
			CH,
			"legacy-msg-1",
			"🎨design(parked)·🔨implement(pending)·🧪qa(pending)",
		);
		const { refresher, log } = makeRefresher(store, {});
		await refresher.refresh(ISSUE);

		expect(log.deleted).toEqual(["legacy-msg-1"]);
		expect(store.getPhaseStatusLine(ISSUE, CH)).toBeUndefined();
		// And the refresher never posts a replacement standalone line — the
		// pinned header (asserted elsewhere) is the ONLY status surface.
	});

	it("Lead 指令 17ab4f53 收敛: a failed delete keeps the record + blocks the fingerprint (sweep retries)", async () => {
		seedSession(store, { exec: "e-design", role: "design", status: "running" });
		store.setPhaseStatusLine(ISSUE, CH, "legacy-msg-1", "old");
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { refresher } = makeRefresher(store, { deleteOk: false });
		await refresher.refresh(ISSUE);

		expect(store.getPhaseStatusLine(ISSUE, CH)).toBeDefined();
		expect(storedFingerprint(store)).toBeNull();
	});

	it("no thread / no sessions → complete no-op (never throws)", async () => {
		const { refresher, log } = makeRefresher(store, {});
		await refresher.refresh("nonexistent-issue");
		expect(log.title).toEqual([]);
		expect(log.header).toEqual([]);
	});

	it("coalesce-to-latest: triggers during an in-flight refresh collapse into ONE extra pass", async () => {
		seedSession(store, { exec: "e-design", role: "design", status: "running" });
		const { refresher, log } = makeRefresher(store, {});
		await Promise.all([
			refresher.refresh(ISSUE),
			refresher.refresh(ISSUE),
			refresher.refresh(ISSUE),
		]);
		// 1 initial pass + at most 1 coalesced re-run — never 3 full passes.
		expect(log.header.length).toBeLessThanOrEqual(2);
	});
});

describe("IssueDisplayRefresher — sweep (plan Step 4.5)", () => {
	let store: StateStore;

	beforeEach(async () => {
		seq = 0;
		store = await StateStore.create(":memory:");
		store.upsertChatThread(THREAD, CH, ISSUE);
	});
	afterEach(() => store.close());

	it("single-session fingerprints include the durable merge conclusion bit", () => {
		const hasFinalizationCompletedForIssue = vi.fn(() => false);
		const hasMergeConfirmedForIssue = vi.fn(() => true);
		const fingerprint = computeSessionsFingerprint(
			{
				hasFinalizationCompletedForIssue,
				hasMergeConfirmedForIssue,
				getLatestPhaseSessionsForIssue: () => [],
				getSessionByIssue: () => undefined,
			},
			ISSUE,
		);

		expect(JSON.parse(fingerprint).fc).toBe(false);
		expect(JSON.parse(fingerprint).cc).toBe(true);
		expect(hasFinalizationCompletedForIssue).toHaveBeenCalledOnce();
		expect(hasMergeConfirmedForIssue).toHaveBeenCalledOnce();
	});

	it("layer 1: a sessions-status change after the stored fingerprint re-enqueues the issue", async () => {
		seedSession(store, { exec: "e-design", role: "design", status: "running" });
		const { refresher, log } = makeRefresher(store, {});
		await refresher.refresh(ISSUE);
		expect(storedFingerprint(store)).not.toBeNull();

		// No drift → sweep enqueues via layer 2 only (issue is non-terminal);
		// the refresh it triggers is a no-op render (writers record it though).
		// Now drift the sessions table UNDER the fingerprint (a kill the
		// triggers missed): sweep layer 1 must catch it.
		seedSession(store, {
			exec: "e-design",
			role: "design",
			status: "terminated",
		});
		log.title.length = 0;
		await refresher.runSweep();
		// drain the enqueued coalesced refresh
		await refresher.refresh(ISSUE);
		expect(log.title.some((t) => t.badge === "🔴受阻")).toBe(true);
	});

	it("layer 1: a post-ship claim alone invalidates the sessions fingerprint", async () => {
		seedSession(store, {
			exec: "e-design",
			role: "design",
			status: "design_done",
		});
		seedSession(store, {
			exec: "e-impl",
			role: "implement",
			status: "awaiting_review",
		});
		seedSession(store, {
			exec: "e-qa",
			role: "qa",
			status: "awaiting_review",
		});
		const { refresher } = makeRefresher(store, {
			park: {
				"e-design": "parked",
				"e-impl": "parked",
				"e-qa": "parked",
			},
		});
		await refresher.refresh(ISSUE);
		const before = computeSessionsFingerprint(store, ISSUE);

		store.insertEvent({
			event_id: "claim-fingerprint-issue-907",
			execution_id: "e-qa",
			issue_id: ISSUE,
			project_name: PROJECT,
			event_type: "post_ship_finalization_completed",
			source: "test",
		});
		const after = computeSessionsFingerprint(store, ISSUE);
		expect(after).not.toBe(before);

		// Isolate layer 1: the non-terminal layer-2 rotation must not enqueue.
		vi.spyOn(store, "listDisplaySweepActiveIssues").mockReturnValue([]);
		const enqueue = vi.spyOn(refresher, "enqueue").mockImplementation(() => {});
		await refresher.runSweep();
		expect(enqueue).toHaveBeenCalledWith(ISSUE);
	});

	it("layer 2: CommDB-only drift (park marker change / late tmux registration — sessions table unchanged) still converges for a non-terminal issue", async () => {
		seedSession(store, {
			exec: "e-impl",
			role: "implement",
			status: "awaiting_review",
		});
		// First render: parked → ✅.
		const park: Record<string, ParkProbe> = { "e-impl": "parked" };
		const { refresher, log } = makeRefresher(store, { park });
		await refresher.refresh(ISSUE);
		expectHeaderStates(log.header[0]!, {
			design: "◾ 未开始",
			implement: "✅ 完成",
			qa: "◾ 未开始",
		});
		expect(storedFingerprint(store)).not.toBeNull();

		// Park marker cleared OUT OF BAND (manual turn re-grant): sessions
		// fingerprint unchanged → layer 1 blind; layer 2 must refresh anyway.
		park["e-impl"] = "not_parked";
		log.header.length = 0;
		await refresher.runSweep();
		await refresher.refresh(ISSUE); // drain coalesced enqueue
		const latest = log.header[log.header.length - 1]!;
		expectHeaderStates(latest, {
			design: "◾ 未开始",
			implement: "▶ 进行中",
			qa: "◾ 未开始",
		});
	});

	it("terminal issue with a MISSING fingerprint is still a layer-1 candidate (crashed-finalization stale face must not hide)", async () => {
		seedSession(store, { exec: "e-main", role: "main", status: "completed" });
		const { refresher, log } = makeRefresher(store, {});
		await refresher.runSweep();
		await refresher.refresh(ISSUE); // drain
		expect(log.title).toContainEqual({ via: "stage", stage: "completed" });
	});
});

describe("applyTransition onTransition hook (FLY-907 Step 4.1)", () => {
	it("fires after a successful persist with the transition ctx; absent hook → byte-compat no-op; a throwing hook never breaks the transition", async () => {
		const store = await StateStore.create(":memory:");
		const { WorkflowFSM, WORKFLOW_TRANSITIONS } = await import("flywheel-core");
		const fsm = new WorkflowFSM(WORKFLOW_TRANSITIONS);
		const seen: string[] = [];

		// No hook — byte-compat.
		const r1 = applyTransition({ store, fsm }, "exec-1", "running", {
			executionId: "exec-1",
			issueId: ISSUE,
			projectName: PROJECT,
			trigger: "test",
		});
		expect(r1.ok).toBe(true);

		// Hook fires on success.
		const r2 = applyTransition(
			{
				store,
				fsm,
				onTransition: (execId, status, ctx) =>
					seen.push(`${execId}:${status}:${ctx.issueId}`),
			},
			"exec-1",
			"completed",
			{
				executionId: "exec-1",
				issueId: ISSUE,
				projectName: PROJECT,
				trigger: "test",
			},
		);
		expect(r2.ok).toBe(true);
		expect(seen).toEqual([`exec-1:completed:${ISSUE}`]);

		// Rejected transition (terminal has no out-edges) → hook NOT fired.
		const r3 = applyTransition(
			{
				store,
				fsm,
				onTransition: () => seen.push("must-not-fire"),
			},
			"exec-1",
			"running",
			{
				executionId: "exec-1",
				issueId: ISSUE,
				projectName: PROJECT,
				trigger: "test",
			},
		);
		expect(r3.ok).toBe(false);
		expect(seen).toHaveLength(1);

		// Throwing hook is contained.
		const r4 = applyTransition(
			{
				store,
				fsm,
				onTransition: () => {
					throw new Error("boom");
				},
			},
			"exec-2",
			"running",
			{
				executionId: "exec-2",
				issueId: ISSUE,
				projectName: PROJECT,
				trigger: "test",
			},
		);
		expect(r4.ok).toBe(true);
		store.close();
	});
});

describe("attachTargetMatchesIssue (Step 3 anchor)", () => {
	it("verifies the buildWindowLabel identifier prefix and fails closed without a resolved window", () => {
		expect(attachTargetMatchesIssue("FLY-907", "FLY-907-runner-x-title")).toBe(
			true,
		);
		expect(attachTargetMatchesIssue("FLY-907", "FLY-921-runner-x-title")).toBe(
			false,
		);
		// FLY-90 must not prefix-match FLY-907's window… and vice versa.
		expect(attachTargetMatchesIssue("FLY-90", "FLY-907-runner-x")).toBe(false);
		expect(attachTargetMatchesIssue(undefined, "FLY-907-runner-x")).toBe(true);
		expect(attachTargetMatchesIssue("FLY-907", undefined)).toBe(false);
	});
});
