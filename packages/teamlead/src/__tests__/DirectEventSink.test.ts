/**
 * GEO-151: Tests for DirectEventSink ProofShot config persistence.
 *
 * Verifies that DirectEventSink.emitStarted() persists the effective
 * ProofShot config into session_params.proofshot.config so Bridge
 * event-route handlers can read it without re-loading the project YAML.
 *
 * Note: the FLY-24 Forum Post / Forum Tag tests that previously lived here
 * were removed alongside the Discord forum channel concept (FLY-163, PR #193).
 */

import type { EventEnvelope } from "flywheel-edge-worker";
import type { BlueprintResult } from "flywheel-edge-worker/dist/Blueprint.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoQaCoordinator } from "../bridge/auto-qa-coordinator.js";
import type { RuntimeRegistry } from "../bridge/runtime-registry.js";
import type { BridgeConfig } from "../bridge/types.js";
import { DirectEventSink } from "../DirectEventSink.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const testProjects: ProjectEntry[] = [
	{
		projectName: "geoforge3d",
		projectRoot: "/tmp/geoforge3d",
		projectRepo: "xrliAnnie/GeoForge3D",
		leads: [
			{
				agentId: "product-lead",
				chatChannel: "chat-ch-1",
				match: { labels: ["Product"] },
				botToken: "bot-token-test",
			},
		],
	},
];

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		ingestToken: "ingest-secret",
		notificationChannel: "test-channel",
		defaultLeadAgentId: "product-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
		discordBotToken: "global-bot-token",
		...overrides,
	};
}

function makeEnvelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
	return {
		executionId: "exec-1",
		issueId: "issue-1",
		projectName: "geoforge3d",
		issueIdentifier: "GEO-100",
		issueTitle: "Test issue",
		...overrides,
	};
}

describe("DirectEventSink — FLY-147 role-agnostic chat thread creation", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	afterEach(() => {
		store.close();
	});

	it.each(["main", "qa", "designer", "custom-role"])(
		"auto-creates the issue thread for sessionRole=%s",
		async (sessionRole) => {
			const ensureChatThread = vi.fn(async () => ({
				created: true,
				threadId: `thread-${sessionRole}`,
			}));
			const creator = {
				ensureChatThread,
			} as unknown as import("../bridge/ChatThreadCreator.js").ChatThreadCreator;
			const sink = new DirectEventSink(
				store,
				makeConfig({ chatThreadsEnabled: true }),
				testProjects,
				undefined,
				undefined,
				creator,
			);

			await sink.emitStarted(
				makeEnvelope({
					executionId: `exec-${sessionRole}`,
					sessionRole,
					labels: ["Product"],
				}),
			);

			expect(ensureChatThread).toHaveBeenCalledOnce();
			expect(ensureChatThread).toHaveBeenCalledWith(
				expect.objectContaining({
					issueId: "issue-1",
					issueIdentifier: "GEO-100",
					chatChannelId: "chat-ch-1",
					leadId: "product-lead",
				}),
			);
			expect(store.getSession(`exec-${sessionRole}`)?.session_role).toBe(
				sessionRole,
			);
		},
	);
});

describe("DirectEventSink — GEO-151 ProofShot config persistence", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	afterEach(() => {
		store.close();
	});

	it("persists effective ProofShotConfig into session_params.proofshot.config", async () => {
		const sink = new DirectEventSink(
			store,
			makeConfig(),
			testProjects,
			undefined,
			undefined,
			undefined,
			{
				enabled: true,
				proofshot: {
					enabled: true,
					dev_command: "pnpm dev",
					capture_stages: ["test"],
					vision_token_budget: 5000,
				},
			},
		);

		await sink.emitStarted(makeEnvelope());
		await sink.flush();

		const params = store.getSessionParams("exec-1");
		expect(params?.proofshot).toBeDefined();
		const proofshot = params!.proofshot as Record<string, unknown>;
		const cfg = proofshot.config as Record<string, unknown>;
		expect(cfg.enabled).toBe(true);
		expect(cfg.dev_command).toBe("pnpm dev");
		expect(cfg.capture_stages).toEqual(["test"]);
		expect(cfg.vision_token_budget).toBe(5000);
	});

	it("falls back to DEFAULT_PROOFSHOT_CONFIG (enabled=false) when skillsConfig missing", async () => {
		const sink = new DirectEventSink(
			store,
			makeConfig(),
			testProjects,
			undefined,
			undefined,
			undefined,
			undefined, // no skillsConfig
		);

		await sink.emitStarted(makeEnvelope());
		await sink.flush();

		const params = store.getSessionParams("exec-1");
		const proofshot = params!.proofshot as Record<string, unknown>;
		const cfg = proofshot.config as Record<string, unknown>;
		expect(cfg.enabled).toBe(false); // safe default
		expect(cfg.capture_stages).toEqual(["test", "code_review", "pr_created"]);
	});

	it("preserves existing proofshot.runs + last_artifact on replay (read-modify-write)", async () => {
		// Pre-seed session_params with a prior run + last_artifact (simulating
		// a Bridge restart mid-capture, then session_started getting replayed).
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "running",
			started_at: "2026-05-21T00:00:00",
			last_activity_at: "2026-05-21T00:00:00",
			heartbeat_at: "2026-05-21T00:00:00",
			session_role: "main",
		});
		store.setSessionParams("exec-1", {
			proofshot: {
				runs: {
					"exec-1|test|ui": {
						state: "pending",
						dedupKey: "exec-1|test|ui",
						attempt: 1,
						updatedAt: 1234567890,
						lastError: null,
					},
				},
			},
			last_artifact: {
				model_path: "/Users/x/.flywheel/screens/exec-1/model.glb",
			},
			unrelated_key: "stays",
		});

		const sink = new DirectEventSink(
			store,
			makeConfig(),
			testProjects,
			undefined,
			undefined,
			undefined,
			{
				proofshot: { enabled: true, dev_command: "pnpm dev" },
			},
		);

		await sink.emitStarted(makeEnvelope());
		await sink.flush();

		const params = store.getSessionParams("exec-1")!;
		const proofshot = params.proofshot as Record<string, unknown>;
		const cfg = proofshot.config as Record<string, unknown>;
		expect(cfg.enabled).toBe(true);
		expect(cfg.dev_command).toBe("pnpm dev");

		// Prior run survives replay
		const runs = proofshot.runs as Record<string, Record<string, unknown>>;
		expect(runs["exec-1|test|ui"]).toBeDefined();
		expect(runs["exec-1|test|ui"]?.state).toBe("pending");
		expect(runs["exec-1|test|ui"]?.attempt).toBe(1);

		// Other session_params keys also preserved
		const lastArtifact = params.last_artifact as Record<string, unknown>;
		expect(lastArtifact.model_path).toBe(
			"/Users/x/.flywheel/screens/exec-1/model.glb",
		);
		expect(params.unrelated_key).toBe("stays");
	});
});

describe("DirectEventSink — FLY-191 R4: Phase-2 binding atomicity", () => {
	let store: StateStore;
	const HEAD_A = "a".repeat(40);
	const HEAD_B = "b".repeat(40);

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	afterEach(() => {
		store.close();
	});

	function makeResult(headSha?: string) {
		return {
			success: true,
			decision: { route: "needs_review", reasoning: "test" },
			evidence: {
				commitCount: 1,
				filesChangedCount: 1,
				commitMessages: ["feat: x"],
				changedFilePaths: ["a.ts"],
				linesAdded: 1,
				linesRemoved: 0,
				diffSummary: "1 file changed",
				headSha: headSha ?? null,
				partial: false,
				durationMs: 10,
			},
			// biome-ignore lint/suspicious/noExplicitAny: minimal BlueprintResult shape
		} as any;
	}

	function makeSink(): DirectEventSink {
		return new DirectEventSink(store, makeConfig(), testProjects);
	}

	it("qid-less in-process completion must NOT re-point pr_head_sha of a Phase-2-bound session (Codex R4 CRITICAL)", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "awaiting_review",
		});
		store.setReviewBinding("exec-1", {
			questionId: "11111111-1111-1111-1111-111111111111",
			prHeadSha: HEAD_A,
		});
		store.markGateTimeoutNotified("exec-1"); // observable window state

		// In-process emission with a NEWER head but no questionId — the R4
		// attack shape: Q1's old approval must not authorize head B.
		await makeSink().emitCompleted(makeEnvelope(), makeResult(HEAD_B));

		const s = store.getSession("exec-1");
		expect(s?.review_question_id).toBe("11111111-1111-1111-1111-111111111111");
		expect(s?.pr_head_sha).toBe(HEAD_A); // binding pair stays atomic
		expect(s?.gate_timeout_notified_at).toBeTruthy(); // window not drifted
	});

	it("UNBOUND-sentinel sessions are equally protected (no sha attach, no window reset)", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "awaiting_review",
		});
		store.setReviewBinding("exec-1", { questionId: null, prHeadSha: null });

		await makeSink().emitCompleted(makeEnvelope(), makeResult(HEAD_B));

		const s = store.getSession("exec-1");
		expect(s?.review_question_id).toBe("unbound");
		expect(s?.pr_head_sha).toBeUndefined();
	});

	it("pure-legacy sessions (no binding) keep the old behavior: sha contributed when valid", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "running",
		});

		await makeSink().emitCompleted(makeEnvelope(), makeResult(HEAD_B));

		const s = store.getSession("exec-1");
		expect(s?.status).toBe("awaiting_review");
		expect(s?.review_question_id).toBeUndefined(); // NULL — legacy
		expect(s?.pr_head_sha).toBe(HEAD_B);
	});
});

describe("DirectEventSink — FLY-191 R5: late qid-less emission can't regress approved_to_ship", () => {
	let store: StateStore;
	const HEAD_A = "a".repeat(40);
	const HEAD_B = "b".repeat(40);

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	afterEach(() => {
		store.close();
	});

	it("bound + approved_to_ship + qid-less needs_review → status/binding/window all preserved", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "awaiting_review",
		});
		store.setReviewBinding("exec-1", {
			questionId: "11111111-1111-1111-1111-111111111111",
			prHeadSha: HEAD_A,
		});
		store.markGateTimeoutNotified("exec-1");
		// Approval landed — runner is shipping.
		store.persistTransition("exec-1", "approved_to_ship", {
			issue_id: "issue-1",
			project_name: "geoforge3d",
		});

		// Late in-process needs_review emission (dual-sink straggler).
		const sink = new DirectEventSink(store, makeConfig(), testProjects);
		await sink.emitCompleted(makeEnvelope(), {
			success: true,
			decision: { route: "needs_review", reasoning: "straggler" },
			evidence: {
				commitCount: 1,
				filesChangedCount: 1,
				commitMessages: ["feat: x"],
				changedFilePaths: ["a.ts"],
				linesAdded: 1,
				linesRemoved: 0,
				diffSummary: "1 file changed",
				headSha: HEAD_B,
				partial: false,
				durationMs: 10,
			},
			// biome-ignore lint/suspicious/noExplicitAny: minimal BlueprintResult shape
		} as any);

		const s = store.getSession("exec-1");
		expect(s?.status).toBe("approved_to_ship"); // NOT dragged back
		expect(s?.review_question_id).toBe("11111111-1111-1111-1111-111111111111");
		expect(s?.pr_head_sha).toBe(HEAD_A);
		expect(s?.gate_timeout_notified_at).toBeTruthy(); // window untouched
		// Evidence still recorded (no summary arg passed — decision_route +
		// commit_count prove the evidence-only patch ran)
		expect(s?.decision_route).toBe("needs_review");
		expect(s?.commit_count).toBe(1);
	});

	it("FLY-846 gate ⓪: the straggler must not spawn auto-QA either — the ROW is approved_to_ship even though the sink's local status says awaiting_review", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "awaiting_review",
		});
		store.setReviewBinding("exec-1", {
			questionId: "11111111-1111-1111-1111-111111111111",
			prHeadSha: HEAD_A,
		});
		store.persistTransition("exec-1", "approved_to_ship", {
			issue_id: "issue-1",
			project_name: "geoforge3d",
		});

		// Wire a REAL coordinator — the sink's LOCAL `status` for this emission is
		// awaiting_review, so it DOES reach the coordinator; the row's old real
		// qid defeats the evidence gate, so gate ⓪ (row status re-check) is the
		// line that must stop the spawn.
		const start = vi.fn(async () => ({
			executionId: "qa-x",
			issueId: "qa-issue",
		}));
		const coord = new AutoQaCoordinator({
			store,
			startDispatcher: { start },
			resolveQaPolicy: () => ({ enabled: true }),
			effects: {
				postThread: () => {},
				createQaIssue: () => ({ issueId: "qa-issue" }),
				notifyShipReady: () => {},
				feedbackWakeMain: () => {},
				alertLeadPipelineError: () => {},
				stampIssueStage: () => {},
				retestWakeQa: () => ({ ok: true }),
				closeQaRunner: () => {},
			},
		});
		const sink = new DirectEventSink(store, makeConfig(), testProjects);
		sink.autoQaCoordinator = { current: coord };

		await sink.emitCompleted(makeEnvelope(), {
			success: true,
			decision: { route: "needs_review", reasoning: "straggler" },
			evidence: {
				commitCount: 1,
				filesChangedCount: 1,
				commitMessages: ["feat: x"],
				changedFilePaths: ["a.ts"],
				linesAdded: 1,
				linesRemoved: 0,
				diffSummary: "1 file changed",
				headSha: HEAD_B,
				partial: false,
				durationMs: 10,
			},
		} as unknown as BlueprintResult);

		expect(start).not.toHaveBeenCalled();
		expect(store.getAutoQaRecord("exec-1", HEAD_A)).toBeUndefined();
		expect(store.getAutoQaRecord("exec-1", HEAD_B)).toBeUndefined();
	});
});

describe("DirectEventSink — FLY-222 #1: no_code → terminal completed", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});
	afterEach(() => {
		store.close();
	});

	function noCodeResult() {
		return {
			success: true,
			decision: { route: "no_code", reasoning: "learning run, no code" },
			evidence: {
				commitCount: 0,
				filesChangedCount: 0,
				commitMessages: [],
				changedFilePaths: [],
				linesAdded: 0,
				linesRemoved: 0,
				diffSummary: "",
				headSha: null,
				partial: false,
				durationMs: 10,
			},
			// biome-ignore lint/suspicious/noExplicitAny: minimal BlueprintResult shape
		} as any;
	}

	it("running + route=no_code (no merge) → completed (NOT awaiting_review), decision_route persisted", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "running",
		});

		await new DirectEventSink(store, makeConfig(), testProjects).emitCompleted(
			makeEnvelope(),
			noCodeResult(),
		);

		const s = store.getSession("exec-1");
		expect(s?.status).toBe("completed");
		expect(s?.decision_route).toBe("no_code");
	});

	// Codex code-review MED-2: no_code must NOT clear a non-running (review-gated)
	// session — skip the status write (symmetric with event-route's skip).
	it("awaiting_review + route=no_code → status unchanged (skipped)", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "awaiting_review",
		});

		await new DirectEventSink(store, makeConfig(), testProjects).emitCompleted(
			makeEnvelope(),
			noCodeResult(),
		);

		expect(store.getSession("exec-1")?.status).toBe("awaiting_review");
	});

	// FLY-228 Finding K (qa-fly-222): a parked-alive no_code Runner reaches terminal
	// `completed`; the Lead closes it → tmux dies → Blueprint.run resolves
	// success=false and re-emits a route=blocked completion. The already-terminal
	// session must be IMMUNE — not flipped to blocked, decision_route not overwritten.
	function blockedResult() {
		return {
			success: false,
			decision: { route: "blocked", reasoning: "runner closed / pane died" },
			evidence: {
				commitCount: 0,
				filesChangedCount: 0,
				commitMessages: [],
				changedFilePaths: [],
				linesAdded: 0,
				linesRemoved: 0,
				diffSummary: "",
				headSha: null,
				partial: false,
				durationMs: 10,
			},
			// biome-ignore lint/suspicious/noExplicitAny: minimal BlueprintResult shape
		} as any;
	}

	it("Finding K: completed/no_code session is terminal-immune to a spurious route=blocked re-emission (lead-close)", async () => {
		// First: legitimate no_code completion → completed.
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "running",
		});
		const sink = new DirectEventSink(store, makeConfig(), testProjects);
		await sink.emitCompleted(makeEnvelope(), noCodeResult());
		expect(store.getSession("exec-1")?.status).toBe("completed");
		expect(store.getSession("exec-1")?.decision_route).toBe("no_code");

		// Then: the spurious post-close route=blocked re-emission must be ignored.
		await sink.emitCompleted(makeEnvelope(), blockedResult());
		const s = store.getSession("exec-1");
		expect(s?.status).toBe("completed"); // NOT blocked
		expect(s?.decision_route).toBe("no_code"); // not overwritten to blocked
	});

	// Codex K-fix review MED: a SAME-status duplicate completion (completed→completed)
	// must also be ignored — it would otherwise overwrite decision_route/evidence +
	// double-notify, inconsistent with the HTTP sink (applyTransition rejects
	// completed→completed too).
	it("duplicate same-status completion on a completed/no_code session is ignored (no decision_route/evidence overwrite)", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "running",
		});
		const sink = new DirectEventSink(store, makeConfig(), testProjects);
		await sink.emitCompleted(makeEnvelope(), noCodeResult());
		const first = store.getSession("exec-1");
		expect(first?.status).toBe("completed");
		expect(first?.decision_route).toBe("no_code");

		// A second `completed` emission with a DIFFERENT route + evidence must NOT
		// overwrite the terminal session's recorded route/evidence.
		const dupCompleted = {
			success: true,
			decision: { route: "auto_approve", reasoning: "dup" },
			evidence: {
				commitCount: 99,
				filesChangedCount: 42,
				commitMessages: ["dup"],
				changedFilePaths: ["x.ts"],
				linesAdded: 1,
				linesRemoved: 0,
				diffSummary: "dup",
				headSha: null,
				partial: false,
				durationMs: 10,
			},
			// biome-ignore lint/suspicious/noExplicitAny: minimal BlueprintResult shape
		} as any;
		await sink.emitCompleted(makeEnvelope(), dupCompleted);

		const after = store.getSession("exec-1");
		expect(after?.status).toBe("completed");
		expect(after?.decision_route).toBe("no_code"); // not overwritten to auto_approve
		expect(after?.commit_count).toBe(0); // evidence not overwritten with 99/42
		expect(after?.files_changed).toBe(0);
	});

	it.each(["completed", "terminated", "shelved", "approved"])(
		"terminal %s is immune to a spurious blocked re-emission",
		async (terminal) => {
			store.upsertSession({
				execution_id: "exec-1",
				issue_id: "issue-1",
				project_name: "geoforge3d",
				status: terminal,
			});
			await new DirectEventSink(
				store,
				makeConfig(),
				testProjects,
			).emitCompleted(makeEnvelope(), blockedResult());
			expect(store.getSession("exec-1")?.status).toBe(terminal);
		},
	);
});

// FLY-493: pr_handoff (no-transport antigravity build+PR terminal) MUST behave
// like no_code in the in-process sink — running→completed with PR evidence,
// non-running→skipped, and a terminal session immune to a later duplicate.
describe("DirectEventSink — FLY-493: pr_handoff → terminal completed", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});
	afterEach(() => {
		store.close();
	});

	function prHandoffResult() {
		return {
			success: true,
			decision: { route: "pr_handoff", reasoning: "antigravity build+PR" },
			evidence: {
				commitCount: 2,
				filesChangedCount: 3,
				commitMessages: ["feat: x"],
				changedFilePaths: ["a.ts"],
				linesAdded: 10,
				linesRemoved: 1,
				diffSummary: "3 files changed",
				headSha: "c".repeat(40),
				landingStatus: { status: "ready_to_merge", prNumber: 42 },
				partial: false,
				durationMs: 10,
			},
			// biome-ignore lint/suspicious/noExplicitAny: minimal BlueprintResult shape
		} as any;
	}

	it("running + route=pr_handoff → completed (NOT awaiting_review), pr_number persisted", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "running",
		});
		await new DirectEventSink(store, makeConfig(), testProjects).emitCompleted(
			makeEnvelope(),
			prHandoffResult(),
		);
		const s = store.getSession("exec-1");
		expect(s?.status).toBe("completed");
		expect(s?.decision_route).toBe("pr_handoff");
		expect(s?.pr_number).toBe(42);
		// NEVER enters the wake-dependent approve loop:
		expect(s?.review_question_id ?? null).toBeNull();
	});

	// Codex code review R1: the PRODUCTION started path is DirectEventSink, so it
	// MUST persist the executor backend as adapter_type — otherwise the
	// no-transport wake-guard (runner-wake) can't recognize an antigravity session.
	it("emitStarted persists runnerBackend as session.adapter_type (no-transport wake-guard input)", async () => {
		await new DirectEventSink(store, makeConfig(), testProjects).emitStarted(
			makeEnvelope({ runnerBackend: "antigravity-tmux" }),
		);
		expect(store.getSession("exec-1")?.adapter_type).toBe("antigravity-tmux");
	});

	// FLY-728: the PRODUCTION started path must persist the resolved runner model
	// as runner_model so the dashboard / issue surfaces show which model a
	// per-issue routed runner is using.
	it("emitStarted persists runnerModel as session.runner_model", async () => {
		await new DirectEventSink(store, makeConfig(), testProjects).emitStarted(
			makeEnvelope({ runnerModel: "claude-fable-5" }),
		);
		expect(store.getSession("exec-1")?.runner_model).toBe("claude-fable-5");
	});

	it("emitStarted without runnerModel leaves runner_model unset (byte-compat)", async () => {
		await new DirectEventSink(store, makeConfig(), testProjects).emitStarted(
			makeEnvelope(),
		);
		expect(store.getSession("exec-1")?.runner_model ?? null).toBeNull();
	});

	it("awaiting_review + route=pr_handoff → status unchanged (skipped, no strand-clear)", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "awaiting_review",
		});
		await new DirectEventSink(store, makeConfig(), testProjects).emitCompleted(
			makeEnvelope(),
			prHandoffResult(),
		);
		expect(store.getSession("exec-1")?.status).toBe("awaiting_review");
	});

	// Race (Codex R3 #1): a session already terminal-completed by the HTTP
	// pr_handoff sink must NOT be moved to awaiting_review by a later duplicate.
	it("completed (via pr_handoff) is terminal-immune to a later duplicate emission", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "running",
		});
		const sink = new DirectEventSink(store, makeConfig(), testProjects);
		await sink.emitCompleted(makeEnvelope(), prHandoffResult());
		expect(store.getSession("exec-1")?.status).toBe("completed");
		// Duplicate pr_handoff after terminal → still completed.
		await sink.emitCompleted(makeEnvelope(), prHandoffResult());
		expect(store.getSession("exec-1")?.status).toBe("completed");
	});
});

describe("DirectEventSink — FLY-579 QA-held founder suppression (Codex R1 HIGH-1)", () => {
	let store: StateStore;
	const SHA = "a".repeat(40);

	function captureRegistry(): {
		registry: RuntimeRegistry;
		delivered: string[];
	} {
		const delivered: string[] = [];
		const registry = {
			resolveWithLead: () => ({
				runtime: {
					deliver: async (env: { event: { event_type: string } }) => {
						delivered.push(env.event.event_type);
						return { delivered: true };
					},
				},
				lead: { agentId: "product-lead", chatChannel: "chat-ch-1" },
			}),
		} as unknown as RuntimeRegistry;
		return { registry, delivered };
	}

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});
	afterEach(() => store.close());

	function needsReviewResult(): BlueprintResult {
		return {
			decision: { route: "needs_review" },
			evidence: { headSha: SHA },
		} as unknown as BlueprintResult;
	}

	it("suppresses the review-required delivery when the awaiting_review main is QA-held", async () => {
		const { registry, delivered } = captureRegistry();
		const sink = new DirectEventSink(
			store,
			makeConfig(),
			testProjects,
			undefined,
			registry,
		);
		await sink.emitStarted(makeEnvelope());
		// A held record exists for (exec-1, reviewed head) → founder must stay out.
		store.claimAutoQaRecord({
			parentExecutionId: "exec-1",
			targetPrHeadSha: SHA,
			issueId: "issue-1",
			projectName: "geoforge3d",
		});
		await sink.emitCompleted(makeEnvelope(), needsReviewResult());
		expect(store.getSession("exec-1")?.status).toBe("awaiting_review");
		expect(delivered).not.toContain("session_completed");
	});

	it("byte-compat: with NO held record the review-required delivery fires", async () => {
		// FLY-827: this pre-codex byte-compat test asserts delivery with no held
		// record. Run gate-OFF so isReviewHeld falls back to isQaHeld (false here);
		// under the hard gate an un-reviewed awaiting_review is intentionally held.
		process.env.FLYWHEEL_CODEX_HARD_GATE = "0";
		try {
			const { registry, delivered } = captureRegistry();
			const sink = new DirectEventSink(
				store,
				makeConfig(),
				testProjects,
				undefined,
				registry,
			);
			await sink.emitStarted(makeEnvelope());
			await sink.emitCompleted(makeEnvelope(), needsReviewResult());
			expect(delivered).toContain("session_completed");
		} finally {
			delete process.env.FLYWHEEL_CODEX_HARD_GATE;
		}
	});
});

describe("DirectEventSink — FLY-793: completion must not clobber a phase role (824 R2 E2E)", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	afterEach(() => {
		store.close();
	});

	function needsReviewResult() {
		return {
			success: true,
			decision: { route: "needs_review", reasoning: "test" },
			evidence: {
				commitCount: 1,
				filesChangedCount: 1,
				commitMessages: ["feat: x"],
				changedFilePaths: ["a.ts"],
				linesAdded: 1,
				linesRemoved: 0,
				diffSummary: "1 file changed",
				headSha: null,
				partial: false,
				durationMs: 10,
			},
		} as unknown as BlueprintResult;
	}

	it("emitCompleted preserves a dispatched phase role even when the envelope role defaults to main", async () => {
		// The 824 Track-1 shape reproduced in the in-process sink: the session was
		// dispatched as an Implement phase (role=implement), but the completion
		// envelope carries no sessionRole (→ would default to "main"). The stored
		// role MUST stay "implement" so the Implement→QA handoff can fire.
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "running",
			session_role: "implement",
		});

		await new DirectEventSink(store, makeConfig(), testProjects).emitCompleted(
			// makeEnvelope() has no sessionRole → env.sessionRole is undefined,
			// exactly the clobber-to-"main" scenario.
			makeEnvelope(),
			needsReviewResult(),
		);

		const s = store.getSession("exec-1");
		expect(s?.status).toBe("awaiting_review");
		expect(s?.session_role).toBe("implement"); // NOT clobbered to "main"
	});

	it("emitFailed preserves a dispatched phase role", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "running",
			session_role: "design",
		});

		await new DirectEventSink(store, makeConfig(), testProjects).emitFailed(
			makeEnvelope(),
			"boom",
		);

		const s = store.getSession("exec-1");
		expect(s?.status).toBe("failed");
		expect(s?.session_role).toBe("design"); // NOT clobbered to "main"
	});

	it("byte-compat: a non-phase (main) session keeps role main on completion", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "running",
			session_role: "main",
		});

		await new DirectEventSink(store, makeConfig(), testProjects).emitCompleted(
			makeEnvelope(),
			needsReviewResult(),
		);

		const s = store.getSession("exec-1");
		expect(s?.session_role).toBe("main");
	});

	// ─── FLY-921 Fix C: turn-belt reconcile wiring pins ──────────
	// Sister pins for the HTTP surface: event-route-fly921-turn-belt.test.ts.

	function makeFakeOrchestrator() {
		const reconcileTurnBelt = vi.fn(async () => {});
		const onPhaseComplete = vi.fn(async () => {});
		const reconcileQaLoss = vi.fn(async () => {});
		return {
			holder: {
				current: {
					reconcileTurnBelt,
					onPhaseComplete,
					reconcileQaLoss,
				} as unknown as import("../bridge/phase-orchestrator.js").PhaseOrchestrator,
			},
			reconcileTurnBelt,
			onPhaseComplete,
			reconcileQaLoss,
		};
	}

	it("FLY-921: emitFailed of a three-stage phase session triggers a scoped turn-belt reconcile", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "running",
			session_role: "qa",
			chat_thread_role: "qa",
		});
		const sink = new DirectEventSink(store, makeConfig(), testProjects);
		const fake = makeFakeOrchestrator();
		sink.phaseOrchestrator = fake.holder;

		await sink.emitFailed(makeEnvelope(), "killed by lead");

		expect(fake.reconcileTurnBelt).toHaveBeenCalledOnce();
		expect(fake.reconcileTurnBelt).toHaveBeenCalledWith({
			issueId: "issue-1",
			projectName: "geoforge3d",
			terminalExecId: "exec-1",
		});
	});

	it("FLY-921: emitCompleted of a three-stage phase session reconciles AFTER onPhaseComplete", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "running",
			session_role: "implement",
			chat_thread_role: "implement",
		});
		const sink = new DirectEventSink(store, makeConfig(), testProjects);
		const fake = makeFakeOrchestrator();
		sink.phaseOrchestrator = fake.holder;

		await sink.emitCompleted(makeEnvelope(), needsReviewResult());

		expect(fake.onPhaseComplete).toHaveBeenCalledOnce();
		expect(fake.reconcileTurnBelt).toHaveBeenCalledOnce();
		expect(fake.onPhaseComplete.mock.invocationCallOrder[0]!).toBeLessThan(
			fake.reconcileTurnBelt.mock.invocationCallOrder[0]!,
		);
	});

	it("FLY-921 byte-compat: a main-role failure does NOT touch the turn belt", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "running",
			session_role: "main",
		});
		const sink = new DirectEventSink(store, makeConfig(), testProjects);
		const fake = makeFakeOrchestrator();
		sink.phaseOrchestrator = fake.holder;

		await sink.emitFailed(makeEnvelope(), "boom");

		expect(fake.reconcileTurnBelt).not.toHaveBeenCalled();
	});

	// ─── FLY-1050: QA-loss re-drive wiring pins ──────────
	// Sister pins for the HTTP surface: event-route-fly921-turn-belt.test.ts.

	it("FLY-1050: emitFailed of a three-stage QA row fires reconcileQaLoss BEFORE the belt reconcile", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "running",
			session_role: "qa",
			chat_thread_role: "qa",
		});
		const sink = new DirectEventSink(store, makeConfig(), testProjects);
		const fake = makeFakeOrchestrator();
		sink.phaseOrchestrator = fake.holder;

		await sink.emitFailed(makeEnvelope(), "killed");

		expect(fake.reconcileQaLoss).toHaveBeenCalledOnce();
		expect(fake.reconcileQaLoss).toHaveBeenCalledWith({
			issueId: "issue-1",
			terminalExecId: "exec-1",
		});
		expect(fake.reconcileTurnBelt).toHaveBeenCalledOnce();
		expect(fake.reconcileQaLoss.mock.invocationCallOrder[0]!).toBeLessThan(
			fake.reconcileTurnBelt.mock.invocationCallOrder[0]!,
		);
	});

	it("FLY-1050: emitFailed of a non-qa phase row does NOT fire reconcileQaLoss", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "running",
			session_role: "implement",
			chat_thread_role: "implement",
		});
		const sink = new DirectEventSink(store, makeConfig(), testProjects);
		const fake = makeFakeOrchestrator();
		sink.phaseOrchestrator = fake.holder;

		await sink.emitFailed(makeEnvelope(), "boom");

		expect(fake.reconcileQaLoss).not.toHaveBeenCalled();
		expect(fake.reconcileTurnBelt).toHaveBeenCalledOnce(); // belt still runs
	});
});
