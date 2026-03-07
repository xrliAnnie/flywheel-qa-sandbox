import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { StateStore } from "../StateStore.js";
import { createBridgeApp } from "../bridge/plugin.js";
import { formatNotification } from "../bridge/event-route.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { Session } from "../StateStore.js";
import type http from "node:http";

const testProjects: ProjectEntry[] = [
	{ projectName: "geoforge3d", projectRoot: "/tmp/geoforge3d", projectRepo: "xrliAnnie/GeoForge3D" },
];

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		ingestToken: "ingest-secret",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		...overrides,
	};
}

function makeEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		event_id: `evt-${Math.random().toString(36).slice(2)}`,
		execution_id: "exec-1",
		issue_id: "issue-1",
		project_name: "geoforge3d",
		event_type: "session_started",
		payload: { issueIdentifier: "GEO-95", issueTitle: "Test issue" },
		...overrides,
	};
}

describe("Event route", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		const config = makeConfig();
		const app = createBridgeApp(store, testProjects, config);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
	});

	it("POST /events with valid session_started creates session", async () => {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(makeEvent()),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);

		const session = store.getSession("exec-1");
		expect(session).toBeDefined();
		expect(session!.status).toBe("running");
		expect(session!.issue_identifier).toBe("GEO-95");
	});

	it("POST /events with session_completed (needs_review) sets awaiting_review", async () => {
		// First create session
		await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer ingest-secret" },
			body: JSON.stringify(makeEvent()),
		});

		// Then complete it
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer ingest-secret" },
			body: JSON.stringify(makeEvent({
				event_id: "evt-completed",
				event_type: "session_completed",
				payload: {
					decision: { route: "needs_review", reasoning: "has changes" },
					evidence: { commitCount: 3, filesChangedCount: 6, linesAdded: 120, linesRemoved: 45 },
					summary: "Refactored auth",
				},
			})),
		});
		expect(res.status).toBe(200);

		const session = store.getSession("exec-1");
		expect(session!.status).toBe("awaiting_review");
		expect(session!.commit_count).toBe(3);
	});

	it("POST /events with session_failed records error", async () => {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer ingest-secret" },
			body: JSON.stringify(makeEvent({
				event_type: "session_failed",
				payload: { error: "deployment timeout" },
			})),
		});
		expect(res.status).toBe(200);

		const session = store.getSession("exec-1");
		expect(session!.status).toBe("failed");
		expect(session!.last_error).toBe("deployment timeout");
	});

	it("POST /events with duplicate event_id returns ok + duplicate", async () => {
		const event = makeEvent({ event_id: "dup-1" });

		await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer ingest-secret" },
			body: JSON.stringify(event),
		});

		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer ingest-secret" },
			body: JSON.stringify(event),
		});
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.duplicate).toBe(true);
	});

	it("POST /events with missing fields returns 400", async () => {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer ingest-secret" },
			body: JSON.stringify({ event_id: "e1" }),
		});
		expect(res.status).toBe(400);
	});

	it("POST /events with invalid auth returns 401", async () => {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
			body: JSON.stringify(makeEvent()),
		});
		expect(res.status).toBe(401);
	});

	it("POST /events with auto_approve triggers auto merge (mock)", async () => {
		// The auto-merge will fail because ApproveHandler can't run 'gh' in tests
		// but the status flow should be: awaiting_review → (merge attempt)
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer ingest-secret" },
			body: JSON.stringify(makeEvent({
				event_type: "session_completed",
				payload: {
					decision: { route: "auto_approve" },
					evidence: { commitCount: 1 },
				},
			})),
		});
		expect(res.status).toBe(200);

		const session = store.getSession("exec-1");
		// Status should be awaiting_review (merge failed in test env — no gh CLI)
		expect(session!.status).toBe("awaiting_review");
		expect(session!.decision_route).toBe("auto_approve");
	});
});

describe("formatNotification", () => {
	const baseSession: Session = {
		execution_id: "e1",
		issue_id: "i1",
		project_name: "p",
		status: "awaiting_review",
		issue_identifier: "GEO-95",
		issue_title: "Refactor auth",
		commit_count: 3,
		lines_added: 120,
		lines_removed: 45,
		decision_route: "needs_review",
		decision_reasoning: "has changes",
	};

	it("needs_review notification", () => {
		const msg = formatNotification(baseSession, "session_completed");
		expect(msg).toContain("[Review Required]");
		expect(msg).toContain("GEO-95");
		expect(msg).toContain("3 commits");
	});

	it("auto_approve notification", () => {
		const msg = formatNotification({ ...baseSession, decision_route: "auto_approve" }, "session_completed");
		expect(msg).toContain("[Auto-merged]");
	});

	it("blocked notification", () => {
		const msg = formatNotification({ ...baseSession, decision_route: "blocked" }, "session_completed");
		expect(msg).toContain("[Blocked]");
	});

	it("failed notification", () => {
		const msg = formatNotification({ ...baseSession, last_error: "timeout" }, "session_failed");
		expect(msg).toContain("[Failed]");
		expect(msg).toContain("timeout");
	});

	it("started notification", () => {
		const msg = formatNotification(baseSession, "session_started");
		expect(msg).toContain("[Started]");
	});
});
