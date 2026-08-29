/**
 * FLY-172 integration test (Codex R3 guidance #3): replay marker through the
 * REAL `/events` route with a REAL StateStore + WorkflowFSM (production-like
 * transitionOpts). This is the key guard against parity drift between the
 * loopback self-POST replay and the canonical ingest path — it must NOT be
 * mocked with a no-FSM test app.
 */

import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApplyTransitionOpts } from "../applyTransition.js";
import {
	buildLoopbackBaseUrl,
	reconcileCompleteFailedMarkers,
	tryReconcileComplete,
} from "../bridge/complete-marker-reconciler.js";
import { createBridgeApp } from "../bridge/plugin.js";
import type { BridgeConfig } from "../bridge/types.js";
import { DirectiveExecutor } from "../DirectiveExecutor.js";
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
				forumChannel: "test-channel",
				chatChannel: "test-chat",
				match: { labels: ["Product"] },
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
		...overrides,
	};
}

const ingestHeaders = {
	"Content-Type": "application/json",
	Authorization: "Bearer ingest-secret",
};

describe("FLY-172 marker replay → real /events route (parity)", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let markerDir: string;
	let quarantineDir: string;
	let tmp: string;

	async function startRunning(execId: string, issueId: string) {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify({
				event_id: `evt-start-${execId}`,
				execution_id: execId,
				issue_id: issueId,
				project_name: "geoforge3d",
				event_type: "session_started",
				payload: { issueIdentifier: "GEO-374", issueTitle: "Font work" },
			}),
		});
		expect(res.status).toBe(200);
	}

	function writeMarker(execId: string, route: string, merged: boolean) {
		mkdirSync(markerDir, { recursive: true });
		const body = {
			event_id: `evt-complete-${execId}`,
			execution_id: execId,
			issue_id: `iss-${execId}`,
			project_name: "geoforge3d",
			event_type: "session_completed",
			source: "flywheel-comm",
			payload: {
				decision: { route },
				evidence: merged
					? { landingStatus: { status: "merged" } }
					: { landingStatus: undefined },
				sessionRole: "main",
			},
		};
		writeFileSync(
			join(markerDir, `${execId}.json`),
			JSON.stringify(body),
			"utf8",
		);
	}

	beforeEach(async () => {
		// FLY-869: bypass the new merge/QA ship gates — these tests exercise the
		// marker-replay FSM parity, not the approval gate.
		process.env.FLYWHEEL_MERGE_APPROVAL_GATE = "0";
		process.env.FLYWHEEL_QA_DONE_GATE = "0";
		store = await StateStore.create(":memory:");
		const fsm = new WorkflowFSM(WORKFLOW_TRANSITIONS);
		const executor = new DirectiveExecutor(store);
		const transitionOpts: ApplyTransitionOpts = { store, fsm, executor };
		const app = createBridgeApp(
			store,
			testProjects,
			makeConfig(),
			undefined,
			transitionOpts,
		);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = buildLoopbackBaseUrl("127.0.0.1", port);

		tmp = mkdtempSync(join(tmpdir(), "fly172-int-"));
		markerDir = join(tmp, "complete-failed");
		quarantineDir = join(tmp, "quarantine");
	});

	afterEach(async () => {
		delete process.env.FLYWHEEL_MERGE_APPROVAL_GATE;
		delete process.env.FLYWHEEL_QA_DONE_GATE;
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
		rmSync(tmp, { recursive: true, force: true });
	});

	const deps = () => ({
		store,
		bridgeBaseUrl: baseUrl,
		ingestToken: "ingest-secret",
		markerDir,
		quarantineDir,
		log: () => {},
	});

	it("needs_review (no merge) → awaiting_review through real FSM, marker deleted", async () => {
		await startRunning("execA", "iss-execA");
		expect(store.getSession("execA")!.status).toBe("running");
		writeMarker("execA", "needs_review", false);

		const r = await tryReconcileComplete("execA", deps());
		expect(r).toEqual({ kind: "reconciled", status: "awaiting_review" });
		expect(store.getSession("execA")!.status).toBe("awaiting_review");
		expect(readdirSync(markerDir)).not.toContain("execA.json");
	});

	it("auto_approve + merged → completed through real FSM", async () => {
		await startRunning("execB", "iss-execB");
		writeMarker("execB", "auto_approve", true);

		const r = await tryReconcileComplete("execB", deps());
		expect(r.kind).toBe("reconciled");
		expect(store.getSession("execB")!.status).toBe("completed");
	});

	it("blocked → blocked through real FSM", async () => {
		await startRunning("execC", "iss-execC");
		writeMarker("execC", "blocked", false);

		const r = await tryReconcileComplete("execC", deps());
		expect(r.kind).toBe("reconciled");
		expect(store.getSession("execC")!.status).toBe("blocked");
	});

	it("idempotent: a second boot drain with same event_id is a safe no-op", async () => {
		await startRunning("execD", "iss-execD");
		writeMarker("execD", "needs_review", false);

		const r1 = await reconcileCompleteFailedMarkers(deps());
		expect(r1.reconciled).toBe(1);
		expect(store.getSession("execD")!.status).toBe("awaiting_review");
		// Re-write the SAME marker (same event_id) and drain again — /events
		// dedups by event_id; session stays terminal, no crash.
		writeMarker("execD", "needs_review", false);
		const r2 = await reconcileCompleteFailedMarkers(deps());
		// duplicate event + session already terminal → duplicate_terminal (deleted)
		expect(store.getSession("execD")!.status).toBe("awaiting_review");
		expect(readdirSync(markerDir)).not.toContain("execD.json");
		expect(r2.reconciled).toBe(1);
	});

	it("invalid route → unreplayable (route guard would 200+warning) → quarantined, session stays running", async () => {
		await startRunning("execE", "iss-execE");
		writeMarker("execE", "garbage", false);

		const r = await tryReconcileComplete("execE", deps());
		expect(r.kind).toBe("quarantined");
		// invalid route can never reach a terminal state via /events' strict
		// route guard, so it is quarantined; the live session is left running.
		expect(store.getSession("execE")!.status).toBe("running");
		expect(readdirSync(quarantineDir)).toContain("execE.json");
	});
});
