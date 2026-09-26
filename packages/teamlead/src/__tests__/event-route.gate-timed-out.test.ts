/**
 * FLY-159 — `gate_timed_out` event route integration tests.
 *
 * Two concerns covered:
 *
 * 1. **Payload propagation** (Codex R1 Issue 9): event-route.ts:1229+ rebuilds
 *    HookPayload from session row and would otherwise drop the
 *    `checkpoint / waited_ms / original_message / timeout_behavior /
 *    timeout_behavior_source / question_id` fields. This test posts a
 *    fully-formed `gate_timed_out` event and asserts those fields make it into
 *    the LeadEventEnvelope delivered to the runtime.
 *
 * 2. **Guardrail delivery retry** (Codex R2 Issue 1): event-route.ts:1281+
 *    previously called `.then(markLeadEventDelivered)` unconditionally; when
 *    the runtime returned `{delivered: false}` the row was wrongly marked
 *    delivered and `HeartbeatService.retryUndeliveredGuardrailEvents` could
 *    never see it. This test asserts:
 *      - on `{delivered: false}` the row stays undelivered and
 *        `recordDeliveryFailure` increments `delivery_attempts`,
 *      - on `{delivered: true}` the row is marked delivered,
 *      - and that non-guardrail events keep the legacy best-effort behavior
 *        (mark-delivered even on failure).
 */

import type http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LeadEventEnvelope } from "../bridge/lead-runtime.js";
import { createBridgeApp } from "../bridge/plugin.js";
import { RuntimeRegistry } from "../bridge/runtime-registry.js";
import type { BridgeConfig } from "../bridge/types.js";
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

function makeConfig(): BridgeConfig {
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
	};
}

function makeRegistry(deliverResult: { delivered: boolean; error?: string }) {
	const envelopes: LeadEventEnvelope[] = [];
	const mockRuntime = {
		type: "commdb" as const,
		deliver: vi.fn(async (env: LeadEventEnvelope) => {
			envelopes.push(env);
			return deliverResult;
		}),
		sendBootstrap: vi.fn(async () => {}),
		health: vi.fn(async () => ({
			status: "healthy" as const,
			lastDeliveryAt: null,
			lastDeliveredSeq: 0,
		})),
		shutdown: vi.fn(async () => {}),
	};
	const registry = new RuntimeRegistry();
	for (const project of testProjects) {
		for (const lead of project.leads) {
			registry.register(lead, mockRuntime);
		}
	}
	return { registry, mockRuntime, envelopes };
}

/** Plant a session row so event-route's session lookup succeeds. */
function plantSession(store: StateStore) {
	store.upsertSession({
		execution_id: "exec-fly159",
		issue_id: "issue-fly159",
		project_name: "geoforge3d",
		status: "running",
		issue_identifier: "FLY-159",
		issue_title: "Gate timeout",
	});
}

function makeGateTimedOutEvent() {
	return {
		event_id: `evt-${Math.random().toString(36).slice(2)}`,
		execution_id: "exec-fly159",
		issue_id: "issue-fly159",
		project_name: "geoforge3d",
		event_type: "gate_timed_out",
		source: "flywheel-comm",
		payload: {
			checkpoint: "brainstorm",
			exec_id: "exec-fly159",
			lead_id: "product-lead",
			waited_ms: 172_800_000,
			original_message: "My understanding of the task",
			timeout_behavior: "fail-close",
			timeout_behavior_source: "default",
			question_id: "question-uuid-1",
		},
	};
}

describe("event-route gate_timed_out — payload propagation + guardrail retry", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	// FLY-493: the per-project CommDB is isolated to a fresh temp dir by the
	// package vitest.setup.ts (FLYWHEEL_COMM_DIR), so the Bridge gate handlers
	// never write gate questions to the LIVE comm.db (the gate-watcher reads it).

	async function startServer(
		deliverResult: { delivered: boolean; error?: string } = {
			delivered: true,
		},
	) {
		const mock = makeRegistry(deliverResult);
		store = await StateStore.create(":memory:");
		plantSession(store);
		const app = createBridgeApp(
			store,
			testProjects,
			makeConfig(),
			undefined, // broadcaster
			undefined, // transitionOpts
			undefined, // retryDispatcher
			undefined, // cipherWriter
			undefined, // eventFilter
			undefined, // forumTagUpdater
			mock.registry,
		);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;
		return mock;
	}

	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			});
		}
		if (store) store.close();
	});

	// ─── Case A: payload propagation ──────────────────────────────────────────
	it("Case A: gate_timed_out payload fields flow into LeadEventEnvelope", async () => {
		const { envelopes } = await startServer({ delivered: true });

		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(makeGateTimedOutEvent()),
		});
		expect(res.status).toBe(200);

		// Wait briefly for async delivery
		await new Promise((r) => setTimeout(r, 100));

		expect(envelopes.length).toBeGreaterThanOrEqual(1);
		const env = envelopes[0]!;
		expect(env.event.event_type).toBe("gate_timed_out");
		expect(env.event.checkpoint).toBe("brainstorm");
		expect(env.event.waited_ms).toBe(172_800_000);
		expect(env.event.original_message).toBe("My understanding of the task");
		expect(env.event.timeout_behavior).toBe("fail-close");
		expect(env.event.timeout_behavior_source).toBe("default");
		expect(env.event.question_id).toBe("question-uuid-1");
	});

	// ─── Case B: guardrail retry on deliver=false ────────────────────────────
	it("Case B: deliver returns {delivered:false} → row stays undelivered + recordDeliveryFailure", async () => {
		await startServer({ delivered: false, error: "stub-fail" });

		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(makeGateTimedOutEvent()),
		});
		expect(res.status).toBe(200);

		// Wait for the async deliver().then() callback to run
		await new Promise((r) => setTimeout(r, 100));

		// gate_timed_out is in GUARDRAIL_EVENT_TYPES → must remain undelivered
		// AND have at least one delivery_attempts increment (recordDeliveryFailure
		// called) so HeartbeatService.retryUndeliveredGuardrailEvents can pick
		// it up.
		const undelivered = store.getUndeliveredGuardrailEvents(
			"product-lead",
			["gate_timed_out"],
			3,
		);
		expect(undelivered.length).toBe(1);
		expect(undelivered[0]!.event_type).toBe("gate_timed_out");
		expect(undelivered[0]!.delivered_at).toBeUndefined();
		expect(undelivered[0]!.delivery_attempts).toBeGreaterThanOrEqual(1);
		expect(undelivered[0]!.last_delivery_error).toMatch(/stub-fail/);
	});

	// ─── Case C: deliver=true normal path still marks delivered ──────────────
	it("Case C: deliver returns {delivered:true} → row marked delivered", async () => {
		await startServer({ delivered: true });

		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(makeGateTimedOutEvent()),
		});
		expect(res.status).toBe(200);

		await new Promise((r) => setTimeout(r, 100));

		const undelivered = store.getUndeliveredGuardrailEvents(
			"product-lead",
			["gate_timed_out"],
			3,
		);
		expect(undelivered.length).toBe(0);
	});

	// ─── Case D: non-guardrail event keeps legacy best-effort behavior ───────
	it("Case D: non-guardrail event with deliver=false is still marked delivered (no retry path)", async () => {
		await startServer({ delivered: false, error: "stub-fail" });

		// Use action_executed — present in EventFilter but NOT in GUARDRAIL_EVENT_TYPES
		const nonGuardrailEvent = {
			event_id: `evt-${Math.random().toString(36).slice(2)}`,
			execution_id: "exec-fly159",
			issue_id: "issue-fly159",
			project_name: "geoforge3d",
			event_type: "action_executed",
			source: "test",
			payload: { action: "approve", action_target_status: "approved_to_ship" },
		};

		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(nonGuardrailEvent),
		});
		expect(res.status).toBe(200);

		await new Promise((r) => setTimeout(r, 100));

		// action_executed is NOT in GUARDRAIL_EVENT_TYPES → mark-delivered fallback applies
		const undelivered = store.getUndeliveredGuardrailEvents(
			"product-lead",
			["action_executed"],
			3,
		);
		expect(undelivered.length).toBe(0);
	});
});
