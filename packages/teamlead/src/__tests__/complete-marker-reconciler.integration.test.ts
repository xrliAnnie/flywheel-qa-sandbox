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
import { setHistoricalQaRequiredSnapshot } from "./helpers/historical-qa.js";

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
	let originalHome: string | undefined;
	let originalCompleteMarkerDir: string | undefined;

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
		const session = store.getSession(execId);
		store.upsertSession({
			execution_id: execId,
			issue_id: session?.issue_id ?? issueId,
			project_name: session?.project_name ?? "geoforge3d",
			status: session?.status ?? "running",
			worktree_path: process.cwd(),
		});
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
		originalHome = process.env.HOME;
		originalCompleteMarkerDir = process.env.FLYWHEEL_COMPLETE_MARKER_DIR;
		// FLY-869: bypass the merge-approval gate — these tests exercise marker
		// replay parity. QA exemptions are modeled durably per test when needed.
		process.env.FLYWHEEL_MERGE_APPROVAL_GATE = "0";
		process.env.FLYWHEEL_WORKFLOW_CLAIMS_READ = "0"; // retired input is ignored
		tmp = mkdtempSync(join(tmpdir(), "fly172-int-"));
		store = await StateStore.create(join(tmp, "teamlead.db"));
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

		markerDir = join(tmp, "complete-failed");
		quarantineDir = join(tmp, "quarantine");
	});

	afterEach(async () => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalCompleteMarkerDir === undefined) {
			delete process.env.FLYWHEEL_COMPLETE_MARKER_DIR;
		} else {
			process.env.FLYWHEEL_COMPLETE_MARKER_DIR = originalCompleteMarkerDir;
		}
		delete process.env.FLYWHEEL_MERGE_APPROVAL_GATE;
		delete process.env.FLYWHEEL_WORKFLOW_CLAIMS_READ;
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

	it("a legacy shadow binding remains on the canonical completion path", async () => {
		await startRunning("execLegacy", "iss-execLegacy");
		store.createWorkflowRun({
			runId: "legacy-shadow-run",
			issueId: "iss-execLegacy",
			projectName: "geoforge3d",
			claimsReadEnrolled: false,
		});
		expect(
			store.admitWorkflowExecution({
				runId: "legacy-shadow-run",
				nodeId: "qa",
				executionId: "execLegacy",
				attempt: 1,
				family: "qa_verdict",
				now: "2026-07-15T00:00:00.000Z",
				expiresAt: "2026-07-15T00:05:00.000Z",
				absoluteDeadlineAt: "2026-07-15T01:00:00.000Z",
			}),
		).toMatchObject({ ok: true });
		writeMarker("execLegacy", "needs_review", false);

		const result = await tryReconcileComplete("execLegacy", deps());
		expect(result).toEqual({
			kind: "reconciled",
			status: "awaiting_review",
		});
		expect(store.getSession("execLegacy")?.status).toBe("awaiting_review");
		expect(readdirSync(markerDir)).not.toContain("execLegacy.json");
	});

	it("auto_approve + merged → completed through real FSM", async () => {
		await startRunning("execB", "iss-execB");
		setHistoricalQaRequiredSnapshot(store, {
			executionId: "execB",
			required: 0,
			reason: "marker parity fixture",
		});
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

	it("boot drain honors the slot directory and leaves production inventory untouched", async () => {
		const fakeHome = join(tmp, "production-home");
		const productionMarkerDir = join(
			fakeHome,
			".flywheel",
			"state",
			"complete-failed",
		);
		const productionQuarantineDir = `${productionMarkerDir}-quarantine`;
		mkdirSync(productionMarkerDir, { recursive: true });
		mkdirSync(productionQuarantineDir, { recursive: true });
		writeFileSync(
			join(productionMarkerDir, "production-decoy.json"),
			"production-bytes-must-not-move",
			"utf8",
		);
		writeFileSync(
			join(productionQuarantineDir, "existing.json"),
			"existing-quarantine-bytes",
			"utf8",
		);
		const beforeMarkers = readdirSync(productionMarkerDir);
		const beforeQuarantine = readdirSync(productionQuarantineDir);

		process.env.HOME = fakeHome;
		process.env.FLYWHEEL_COMPLETE_MARKER_DIR = markerDir;
		await startRunning("execSlot", "iss-execSlot");
		writeMarker("execSlot", "needs_review", false);

		const result = await reconcileCompleteFailedMarkers({
			store,
			bridgeBaseUrl: baseUrl,
			ingestToken: "ingest-secret",
			log: () => {},
		});

		expect(result).toEqual({
			scanned: 1,
			reconciled: 1,
			quarantined: 0,
			held: 0,
		});
		expect(store.getSession("execSlot")?.status).toBe("awaiting_review");
		expect(readdirSync(productionMarkerDir)).toEqual(beforeMarkers);
		expect(readdirSync(productionQuarantineDir)).toEqual(beforeQuarantine);
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
