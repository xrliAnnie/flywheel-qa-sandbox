/**
 * FLY-96 Integration: Event routing through Bridge.
 *
 * Tests: POST /events → StateStore update → RuntimeRegistry routing.
 * Verifies that events are correctly routed to the right lead based on
 * project/label matching, and that StateStore reflects the expected state.
 */
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeadEventEnvelope } from "../bridge/lead-runtime.js";
import { createBridgeApp } from "../bridge/plugin.js";
import { RuntimeRegistry } from "../bridge/runtime-registry.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const testProjects: ProjectEntry[] = [
	{
		projectName: "test-proj",
		projectRoot: "/tmp/test-proj",
		projectRepo: "test/test-proj",
		leads: [
			{
				agentId: "lead-alpha",
				chatChannel: "chat-alpha",
				match: { labels: ["Frontend"] },
			},
			{
				agentId: "lead-beta",
				chatChannel: "chat-beta",
				match: { labels: ["Backend"] },
			},
		],
	},
];

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		ingestToken: "test-secret",
		notificationChannel: "test-channel",
		defaultLeadAgentId: "lead-alpha",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300_000,
		orphanThresholdMinutes: 60,
		...overrides,
	};
}

function createMockRuntime() {
	const envelopes: LeadEventEnvelope[] = [];
	return {
		envelopes,
		runtime: {
			type: "claude-discord" as const,
			deliver: vi.fn(async (env: LeadEventEnvelope) => {
				envelopes.push(env);
				return { delivered: true };
			}),
			sendBootstrap: vi.fn(async () => {}),
			health: vi.fn(async () => ({
				status: "healthy" as const,
				lastDeliveryAt: null,
				lastDeliveredSeq: 0,
			})),
			shutdown: vi.fn(async () => {}),
		},
	};
}

describe("FLY-96 Integration: Event routing", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let alphaRuntime: ReturnType<typeof createMockRuntime>;
	let betaRuntime: ReturnType<typeof createMockRuntime>;

	const ingestHeaders = {
		"Content-Type": "application/json",
		Authorization: "Bearer test-secret",
	};

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		alphaRuntime = createMockRuntime();
		betaRuntime = createMockRuntime();

		const registry = new RuntimeRegistry();
		for (const project of testProjects) {
			for (const lead of project.leads) {
				const rt =
					lead.agentId === "lead-alpha"
						? alphaRuntime.runtime
						: betaRuntime.runtime;
				registry.register(lead, rt);
			}
		}

		const app = createBridgeApp(
			store,
			testProjects,
			makeConfig(),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			registry,
		);
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

	it("routes Frontend-labelled event to lead-alpha", async () => {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify({
				event_id: "evt-route-1",
				execution_id: "exec-route-1",
				issue_id: "issue-route-1",
				project_name: "test-proj",
				event_type: "session_started",
				payload: {
					issueIdentifier: "TEST-1",
					issueTitle: "Frontend routing test",
					labels: ["Frontend"],
				},
			}),
		});
		expect(res.status).toBe(200);

		await new Promise((r) => setTimeout(r, 200));

		// Verify lead-alpha received the event
		expect(alphaRuntime.envelopes.length).toBeGreaterThanOrEqual(1);
		expect(alphaRuntime.envelopes[0].leadId).toBe("lead-alpha");
		expect(alphaRuntime.envelopes[0].event.issue_identifier).toBe("TEST-1");

		// Verify lead-beta did NOT receive it
		const betaForThisEvent = betaRuntime.envelopes.filter(
			(e) => e.event.issue_identifier === "TEST-1",
		);
		expect(betaForThisEvent.length).toBe(0);
	});

	it("routes Backend-labelled event to lead-beta", async () => {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify({
				event_id: "evt-route-2",
				execution_id: "exec-route-2",
				issue_id: "issue-route-2",
				project_name: "test-proj",
				event_type: "session_started",
				payload: {
					issueIdentifier: "TEST-2",
					issueTitle: "Backend routing test",
					labels: ["Backend"],
				},
			}),
		});
		expect(res.status).toBe(200);

		await new Promise((r) => setTimeout(r, 200));

		expect(betaRuntime.envelopes.length).toBeGreaterThanOrEqual(1);
		expect(betaRuntime.envelopes[0].leadId).toBe("lead-beta");
	});

	it("creates session in StateStore on session_started", async () => {
		await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify({
				event_id: "evt-state-1",
				execution_id: "exec-state-1",
				issue_id: "issue-state-1",
				project_name: "test-proj",
				event_type: "session_started",
				payload: {
					issueIdentifier: "TEST-3",
					issueTitle: "StateStore test",
				},
			}),
		});

		const session = store.getSession("exec-state-1");
		expect(session).toBeDefined();
		expect(session!.status).toBe("running");
		expect(session!.issue_identifier).toBe("TEST-3");
	});

	it("unknown project_name still ingests but does not route to any lead", async () => {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify({
				event_id: "evt-unknown-1",
				execution_id: "exec-unknown-1",
				issue_id: "issue-unknown-1",
				project_name: "nonexistent-project",
				event_type: "session_started",
				payload: { issueIdentifier: "TEST-99" },
			}),
		});
		expect(res.status).toBe(200);

		await new Promise((r) => setTimeout(r, 200));

		// No lead should have received the event
		const allEnvelopes = [
			...alphaRuntime.envelopes,
			...betaRuntime.envelopes,
		].filter((e) => e.event.issue_identifier === "TEST-99");
		expect(allEnvelopes.length).toBe(0);
	});

	it("missing auth token returns 401", async () => {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				event_id: "evt-noauth-1",
				execution_id: "exec-noauth-1",
				issue_id: "issue-noauth-1",
				project_name: "test-proj",
				event_type: "session_started",
				payload: {},
			}),
		});
		expect(res.status).toBe(401);
	});
});
