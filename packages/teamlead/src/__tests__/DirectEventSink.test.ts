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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});
