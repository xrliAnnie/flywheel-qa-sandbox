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
