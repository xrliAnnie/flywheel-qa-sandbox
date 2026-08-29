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
import type { CodexReviewHoldCoordinator } from "../bridge/codex-review-hold.js";
import type { ReviewAuthorizationAlerts } from "../bridge/review-authorization-alerts.js";
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

describe("DirectEventSink — FLY-1609 D-arm attribution", () => {
	it("persists bare-ponytail and effective on:arm together", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const sink = new DirectEventSink(store, makeConfig(), testProjects);
			await sink.emitStarted(
				makeEnvelope({
					skillFrameworkMode: "bare-ponytail",
					skillFrameworkModeVia: "hash",
					ponytailCondition: "on:arm",
				}),
			);
			await sink.flush();
			const row = store.getSession("exec-1")!;
			expect(row.skill_framework_mode).toBe("bare-ponytail");
			expect(row.skill_framework_mode_via).toBe("hash");
			expect(row.ponytail_condition).toBe("on:arm");
		} finally {
			store.close();
		}
	});
});

describe("DirectEventSink — FLY-1709 archived-thread reactivation", () => {
	let store: StateStore;
	const creator = {
		ensureChatThread: vi.fn(async () => ({
			created: false,
			threadId: "thread-reactivate",
		})),
	};

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		creator.ensureChatThread.mockClear();
		store.upsertChatThread(
			"thread-reactivate",
			"chat-ch-1",
			"issue-1",
			"product-lead",
		);
	});

	afterEach(() => store.close());

	it("clears the archive epoch for a newly admitted session_started", async () => {
		store.markChatThreadArchived("thread-reactivate");
		await new Promise((resolve) => setTimeout(resolve, 2));
		const sink = new DirectEventSink(
			store,
			makeConfig({ chatThreadsEnabled: true }),
			testProjects,
			undefined,
			undefined,
			creator as never,
		);

		await sink.emitStarted(makeEnvelope({ labels: ["Product"] }));

		expect(store.getChatThreadArchivedAt("thread-reactivate")).toBeNull();
		expect(creator.ensureChatThread).toHaveBeenCalledOnce();
	});

	it("keeps started_at set-once and does not reactivate on an old running replay", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const originalStartedAt = "2026-08-01 12:00:00.123";
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "running",
			started_at: originalStartedAt,
		});
		store.markChatThreadArchived("thread-reactivate");
		const archivedAt = store.getChatThreadArchivedAt("thread-reactivate");
		const sink = new DirectEventSink(
			store,
			makeConfig({ chatThreadsEnabled: true }),
			testProjects,
			undefined,
			undefined,
			creator as never,
		);

		await sink.emitStarted(makeEnvelope({ labels: ["Product"] }));

		expect(store.getSession("exec-1")?.started_at).toBe(originalStartedAt);
		expect(store.getChatThreadArchivedAt("thread-reactivate")).toBe(archivedAt);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("cannot prove reactivation epoch"),
		);
	});
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
			() => true,
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
			() => true,
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

	it("uses the store value instead of the YAML authoring value", async () => {
		const sink = new DirectEventSink(
			store,
			makeConfig(),
			testProjects,
			undefined,
			undefined,
			undefined,
			{ proofshot: { enabled: true, dev_command: "pnpm dev" } },
			() => false,
		);

		await sink.emitStarted(makeEnvelope());
		const params = store.getSessionParams("exec-1")!;
		const proofshot = params.proofshot as Record<string, unknown>;
		const cfg = proofshot.config as Record<string, unknown>;
		expect(cfg).toMatchObject({ enabled: false, dev_command: "pnpm dev" });
	});

	it("disables ProofShot locally when the store read throws", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const sink = new DirectEventSink(
			store,
			makeConfig(),
			testProjects,
			undefined,
			undefined,
			undefined,
			{ proofshot: { enabled: true } },
			() => {
				throw new Error("store unavailable");
			},
		);

		await sink.emitStarted(makeEnvelope());
		const params = store.getSessionParams("exec-1")!;
		const proofshot = params.proofshot as Record<string, unknown>;
		const cfg = proofshot.config as Record<string, unknown>;
		expect(cfg.enabled).toBe(false);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("store unavailable"),
		);
		warn.mockRestore();
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
});

describe("DirectEventSink — FLY-1505 blocked-after-approval deflection", () => {
	let store: StateStore;
	const HEAD_A = "a".repeat(40);
	const HEAD_B = "b".repeat(40);

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	afterEach(() => {
		store.close();
	});

	function seedApproved(opts?: { bound?: boolean; head?: string }): void {
		const bound = opts?.bound ?? true;
		const head = opts?.head ?? HEAD_A;
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: bound ? "awaiting_review" : "approved_to_ship",
			pr_number: 715,
		});
		if (bound) {
			store.setReviewBinding("exec-1", {
				questionId: "11111111-1111-1111-1111-111111111111",
				prHeadSha: head,
			});
			store.persistTransition("exec-1", "approved_to_ship", {
				issue_id: "issue-1",
				project_name: "geoforge3d",
			});
		} else {
			// upsertSession intentionally does not write approval bindings; use the
			// metadata path to model a true pre-Phase-2 row (head present, qid NULL).
			store.patchSessionMetadata("exec-1", { pr_head_sha: head });
		}
	}

	function blockedResult(
		headSha: string | null,
		route: "blocked" | "ship_attempt_failed" = "blocked",
		reviewQuestionId?: string,
	): BlueprintResult {
		return {
			success: false,
			decision: { route, reasoning: "ship poll window elapsed" },
			reviewQuestionId,
			evidence: {
				headSha,
				landingStatus: { status: "ready_to_merge", prNumber: 715 },
			},
		} as unknown as BlueprintResult;
	}

	function makeSink(alertShipAttemptFailed = vi.fn()) {
		const sink = new DirectEventSink(store, makeConfig(), testProjects);
		sink.reviewAuthorizationAlerts = {
			current: {
				alertShipAttemptFailedBestEffort: alertShipAttemptFailed,
			} as unknown as ReviewAuthorizationAlerts,
		};
		return { sink, alertShipAttemptFailed };
	}

	it("settles the explicit attempt route for a real bound approval and alerts once per approval/head", async () => {
		seedApproved();
		const { sink, alertShipAttemptFailed } = makeSink();

		await sink.emitCompleted(
			makeEnvelope(),
			blockedResult(
				HEAD_A,
				"ship_attempt_failed",
				"11111111-1111-1111-1111-111111111111",
			),
		);
		await sink.emitCompleted(
			makeEnvelope(),
			blockedResult(
				HEAD_A,
				"ship_attempt_failed",
				"11111111-1111-1111-1111-111111111111",
			),
		);

		expect(store.getSession("exec-1")?.status).toBe("approved_to_ship");
		expect(store.getSessionParams("exec-1")).toMatchObject({
			fly1505_ship_attempt_failed: {
				head_sha: HEAD_A,
				pr_number: 715,
				attempt_count: 2,
				review_question_id: "11111111-1111-1111-1111-111111111111",
			},
		});
		expect(alertShipAttemptFailed).toHaveBeenCalledOnce();
		expect(alertShipAttemptFailed).toHaveBeenCalledWith(
			expect.objectContaining({ execution_id: "exec-1" }),
			expect.stringContaining("founder"),
		);
	});

	it("keeps the legacy unbound approved_to_ship shape compatible", async () => {
		seedApproved({ bound: false });
		const { sink } = makeSink();
		await sink.emitCompleted(makeEnvelope(), blockedResult(HEAD_A));
		expect(store.getSession("exec-1")?.status).toBe("approved_to_ship");
		expect(store.getSessionParams("exec-1")).toMatchObject({
			fly1505_ship_attempt_failed: { head_sha: HEAD_A },
		});
	});

	it("uses the current row binding for a live blocked event that omits its binding", async () => {
		seedApproved();
		const { sink, alertShipAttemptFailed } = makeSink();
		await sink.emitCompleted(makeEnvelope(), blockedResult(HEAD_A));
		expect(store.getSession("exec-1")?.status).toBe("approved_to_ship");
		expect(store.getSessionParams("exec-1")).toMatchObject({
			fly1505_ship_attempt_failed: {
				head_sha: HEAD_A,
				review_question_id: "11111111-1111-1111-1111-111111111111",
				attempt_count: 1,
			},
		});
		expect(alertShipAttemptFailed).toHaveBeenCalledOnce();
	});

	it("consumes a delayed head-A attempt after head-B approval without marking or alerting B", async () => {
		seedApproved({ head: HEAD_B });
		const { sink, alertShipAttemptFailed } = makeSink();
		await sink.emitCompleted(makeEnvelope(), blockedResult(HEAD_A));
		expect(store.getSession("exec-1")?.status).toBe("approved_to_ship");
		expect(
			store.getSessionParams("exec-1")?.fly1505_ship_attempt_failed,
		).toBeUndefined();
		expect(alertShipAttemptFailed).not.toHaveBeenCalled();
	});

	it("consumes a delayed same-head Q1 attempt without marking or alerting Q2", async () => {
		seedApproved();
		store.setReviewBinding("exec-1", {
			questionId: "22222222-2222-2222-2222-222222222222",
			prHeadSha: HEAD_A,
		});
		const { sink, alertShipAttemptFailed } = makeSink();
		await sink.emitCompleted(
			makeEnvelope(),
			blockedResult(
				HEAD_A,
				"ship_attempt_failed",
				"11111111-1111-1111-1111-111111111111",
			),
		);
		expect(store.getSession("exec-1")?.status).toBe("approved_to_ship");
		expect(
			store.getSessionParams("exec-1")?.fly1505_ship_attempt_failed,
		).toBeUndefined();
		expect(alertShipAttemptFailed).not.toHaveBeenCalled();
	});

	it("uses result.evidence.headSha as authority: a missing event head stays unknown instead of borrowing the row head", async () => {
		seedApproved({ head: HEAD_B });
		const { sink, alertShipAttemptFailed } = makeSink();
		await sink.emitCompleted(makeEnvelope(), blockedResult(null));
		expect(store.getSessionParams("exec-1")).toMatchObject({
			fly1505_ship_attempt_failed: {
				head_sha: "(unknown)",
				attempt_count: 1,
			},
		});
		expect(alertShipAttemptFailed).toHaveBeenCalledOnce();
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

	it("FLY-1259: emitStarted persists and locks designBackend", async () => {
		const sink = new DirectEventSink(store, makeConfig(), testProjects);
		await sink.emitStarted(
			makeEnvelope({
				sessionRole: "design",
				chatThreadRole: "design",
				designBackend: "codex",
			}),
		);
		await sink.emitStarted(
			makeEnvelope({
				sessionRole: "design",
				chatThreadRole: "design",
				designBackend: "claude",
			}),
		);

		expect(store.getSession("exec-1")?.design_backend).toBe("codex");
	});

	it.each(["codex-tmux", undefined])(
		"emitStarted renders GPT-5.6 in a fresh thread when backend metadata is %s",
		async (runnerBackend) => {
			const contexts: Array<Record<string, unknown>> = [];
			const creator = {
				ensureChatThread: vi.fn(async (ctx: Record<string, unknown>) => {
					contexts.push(ctx);
					return { created: true, threadId: "thread-1255" };
				}),
			};
			const sink = new DirectEventSink(
				store,
				makeConfig({ chatThreadsEnabled: true }),
				testProjects,
				undefined,
				undefined,
				creator as never,
			);

			await sink.emitStarted(
				makeEnvelope({
					labels: ["Product"],
					runnerBackend,
					runnerModel: "gpt-5.6-sol",
				}),
			);

			expect(contexts[0]?.modelMarker).toBe("G");
		},
	);

	it("persists and forwards the founder-visible route summary on session start", async () => {
		const contexts: Array<Record<string, unknown>> = [];
		const creator = {
			ensureChatThread: vi.fn(async (ctx: Record<string, unknown>) => {
				contexts.push(ctx);
				return { created: true, threadId: "thread-route" };
			}),
		};
		const sink = new DirectEventSink(
			store,
			makeConfig({ chatThreadsEnabled: true }),
			testProjects,
			undefined,
			undefined,
			creator as never,
		);
		const routeSummary = "🧭 **Route**: `generic` · source `default_fallback`";
		await sink.emitStarted(makeEnvelope({ labels: ["Product"], routeSummary }));
		expect(contexts[0]?.routeSummary).toBe(routeSummary);
		expect(store.getSessionParams("exec-1")?.workflowRoute).toEqual({
			summary: routeSummary,
		});
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

describe("DirectEventSink — FLY-1404 design HTML admission", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		delete process.env.FLYWHEEL_DESIGN_HTML_GATE;
	});

	afterEach(() => {
		delete process.env.FLYWHEEL_DESIGN_HTML_GATE;
		store.close();
	});

	it("refuses design-node completion because this sink has no legal attestation carrier", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const sink = new DirectEventSink(store, makeConfig(), testProjects);
		await sink.emitStarted(
			makeEnvelope({ sessionRole: "design", chatThreadRole: "design" }),
		);
		await sink.emitCompleted(makeEnvelope(), {
			decision: { route: "phase_design_complete" },
			evidence: { headSha: "a".repeat(40) },
		} as unknown as BlueprintResult);

		expect(store.getSession("exec-1")?.status).toBe("running");
		expect(
			store
				.getEventsByExecution("exec-1")
				.some((event) => event.event_type === "session_completed"),
		).toBe(false);
		expect(warn).toHaveBeenCalledWith(
			expect.stringMatching(/founder design HTML.*refus/i),
		);
		warn.mockRestore();
	});

	it("FLY-1981 refuses missing attestation when the retired env is 0", async () => {
		process.env.FLYWHEEL_DESIGN_HTML_GATE = "0";
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const sink = new DirectEventSink(store, makeConfig(), testProjects);
		await sink.emitStarted(
			makeEnvelope({ sessionRole: "design", chatThreadRole: "design" }),
		);
		await sink.emitCompleted(makeEnvelope(), {
			decision: { route: "phase_design_complete" },
			evidence: { headSha: "a".repeat(40) },
		} as unknown as BlueprintResult);

		expect(store.getSession("exec-1")?.status).toBe("running");
		expect(warn).toHaveBeenCalledWith(
			expect.stringMatching(/founder design HTML.*refus/i),
		);
		warn.mockRestore();
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

	it("FLY-1259: sends the persisted effective design backend to the Lead", async () => {
		const delivered: Array<{ event: { design_backend?: string } }> = [];
		const registry = {
			resolveWithLead: () => ({
				runtime: {
					deliver: async (env: { event: { design_backend?: string } }) => {
						delivered.push(env);
						return { delivered: true };
					},
				},
				lead: { agentId: "product-lead", chatChannel: "chat-ch-1" },
			}),
		} as unknown as RuntimeRegistry;
		const sink = new DirectEventSink(
			store,
			makeConfig(),
			testProjects,
			undefined,
			registry,
		);

		await sink.emitStarted(
			makeEnvelope({
				sessionRole: "design",
				chatThreadRole: "design",
				designBackend: "codex",
			}),
		);
		await sink.flush();

		expect(delivered[0]?.event.design_backend).toBe("codex");
	});

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
		(
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db.run(
			`INSERT INTO auto_qa_record
			 (parent_execution_id, target_pr_head_sha, issue_id, project_name, status, started_at)
			 VALUES (?, ?, ?, ?, 'running', datetime('now'))`,
			["exec-1", SHA, "issue-1", "geoforge3d"],
		);
		await sink.emitCompleted(makeEnvelope(), needsReviewResult());
		expect(store.getSession("exec-1")?.status).toBe("awaiting_review");
		expect(delivered).not.toContain("session_completed");
	});

	it("runs the neutral Codex hold on awaiting-review completion", async () => {
		const sink = new DirectEventSink(store, makeConfig(), testProjects);
		const order: string[] = [];
		sink.codexReviewHold = {
			current: {
				onSessionAwaitingReview: async () => {
					order.push("codex");
					return "ready" as const;
				},
			} as CodexReviewHoldCoordinator,
		};
		await sink.emitStarted(makeEnvelope());
		await sink.emitCompleted(makeEnvelope(), needsReviewResult());

		expect(order).toEqual(["codex"]);
	});

	it("a server-classified docs-only PR releases the review-required delivery", async () => {
		// FLY-1251: the only no-QA release is a server-owned docs-only
		// classification for the exact reviewed PR head.
		const { registry, delivered } = captureRegistry();
		const sink = new DirectEventSink(
			store,
			makeConfig(),
			testProjects,
			undefined,
			registry,
		);
		await sink.emitStarted(makeEnvelope());
		store.patchSessionMetadata("exec-1", { pr_number: 42 });
		store.recordCodexReviewApproved({
			executionId: "exec-1",
			targetPrHeadSha: SHA,
			issueId: "issue-1",
			projectName: "geoforge3d",
			authorFamily: "claude",
			reviewerFamily: "codex",
		});
		expect(store.getCodexReviewRecord("exec-1", SHA)).toMatchObject({
			author_family: "claude",
			reviewer_family: "codex",
		});
		store.putShipRelevantDiffSnapshot({
			execution_id: "exec-1",
			pr_head_sha: SHA,
			repo: "xrliAnnie/GeoForge3D",
			pr_number: 42,
			base_ref: "main",
			base_oid: "b".repeat(40),
			classifier_version: 1,
			ship_relevant: 0,
			file_count: 1,
			sample_paths: ["engineering/doc/GEO-100/plan.md"],
		});
		await sink.emitCompleted(makeEnvelope(), needsReviewResult());
		expect(delivered).toContain("session_completed");
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

	it("FLY-1279: emitFailed persists goal_blocked as blocked with its real reason", async () => {
		await new DirectEventSink(store, makeConfig(), testProjects).emitFailed(
			makeEnvelope(),
			"legacy error",
			undefined,
			{
				failureKind: "goal_blocked",
				failureReason: "goal ended non-complete: blocked",
			},
		);

		const s = store.getSession("exec-1");
		expect(s?.status).toBe("blocked");
		expect(s?.last_error).toBe("goal ended non-complete: blocked");
	});

	it("FLY-1066: blocked completion enqueues the DirectEventSink bypass", async () => {
		const enqueue = vi.fn();
		const sink = new DirectEventSink(store, makeConfig(), testProjects);
		sink.terminalCommDbSync = { enqueue };

		await sink.emitCompleted(makeEnvelope(), {
			...needsReviewResult(),
			decision: { route: "blocked", reasoning: "blocked fixture" },
		});

		expect(enqueue).toHaveBeenCalledWith("exec-1", "blocked", "geoforge3d");
	});

	it("FLY-1066: emitFailed enqueues both failed and goal-blocked outcomes", async () => {
		const enqueue = vi.fn();
		const sink = new DirectEventSink(store, makeConfig(), testProjects);
		sink.terminalCommDbSync = { enqueue };

		await sink.emitFailed(makeEnvelope({ executionId: "exec-failed" }), "boom");
		await sink.emitFailed(
			makeEnvelope({ executionId: "exec-blocked" }),
			"legacy",
			undefined,
			{ failureKind: "goal_blocked", failureReason: "blocked" },
		);

		expect(enqueue).toHaveBeenNthCalledWith(
			1,
			"exec-failed",
			"failed",
			"geoforge3d",
		);
		expect(enqueue).toHaveBeenNthCalledWith(
			2,
			"exec-blocked",
			"blocked",
			"geoforge3d",
		);
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

	function makeFakeReconciler() {
		const reconcileTurnBelt = vi.fn(async () => {});
		return {
			holder: {
				current: {
					reconcileTurnBelt,
				} as unknown as import("../bridge/turn-belt-reconcile.js").TurnBeltReconciler,
			},
			reconcileTurnBelt,
		};
	}

	it("emitFailed of a workflow actor triggers a scoped TURN reconcile", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "running",
			session_role: "qa",
			chat_thread_role: "qa",
		});
		const sink = new DirectEventSink(store, makeConfig(), testProjects);
		const fake = makeFakeReconciler();
		sink.turnBeltReconciler = fake.holder;

		await sink.emitFailed(makeEnvelope(), "killed by lead");

		expect(fake.reconcileTurnBelt).toHaveBeenCalledOnce();
		expect(fake.reconcileTurnBelt).toHaveBeenCalledWith({
			issueId: "issue-1",
			projectName: "geoforge3d",
			terminalExecId: "exec-1",
		});
	});

	it("emitCompleted of a workflow actor triggers a scoped TURN reconcile", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "running",
			session_role: "implement",
			chat_thread_role: "implement",
		});
		const sink = new DirectEventSink(store, makeConfig(), testProjects);
		const fake = makeFakeReconciler();
		sink.turnBeltReconciler = fake.holder;

		await sink.emitCompleted(makeEnvelope(), needsReviewResult());

		expect(fake.reconcileTurnBelt).toHaveBeenCalledOnce();
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
		const fake = makeFakeReconciler();
		sink.turnBeltReconciler = fake.holder;

		await sink.emitFailed(makeEnvelope(), "boom");

		expect(fake.reconcileTurnBelt).not.toHaveBeenCalled();
	});
});
