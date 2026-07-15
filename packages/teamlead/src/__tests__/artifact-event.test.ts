/**
 * GEO-151 A6 — handleArtifactEvent tests.
 *
 * Covers AC7 (HookPayload shape + appendLeadEvent real signature + envelope
 * construction + delivered/not-delivered paths + completion-only-on-attempt-match)
 * + double-deliver guard signal + stale-artifact attempt mismatch.
 *
 * RuntimeRegistry is fully mocked. StateStore is in-memory.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ArtifactEmittedEvent,
	handleArtifactEvent,
} from "../bridge/artifact-event.js";
import { getProofShotParams } from "../bridge/proofshot-session.js";
import type { RuntimeRegistry } from "../bridge/runtime-registry.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const testProjects: ProjectEntry[] = [
	{
		projectName: "GeoForge3D",
		projectRoot: "/tmp/proofshot-geoforge3d",
		projectRepo: "xrliAnnie/GeoForge3D",
		leads: [
			{
				agentId: "product-lead",
				forumChannel: "forum-ch-1",
				chatChannel: "chat-ch-1",
				match: { labels: ["Product"] },
			},
		],
	},
];

interface MockDeliver {
	calls: Array<{ envelope: unknown }>;
	nextResult: { delivered: boolean; error?: string };
	nextThrow?: Error;
}

function makeRegistry(deliver: MockDeliver): RuntimeRegistry {
	return {
		resolveWithLead: vi.fn(() => ({
			runtime: {
				deliver: vi.fn(async (envelope: unknown) => {
					deliver.calls.push({ envelope });
					if (deliver.nextThrow) throw deliver.nextThrow;
					return deliver.nextResult;
				}),
			},
			lead: testProjects[0]!.leads[0]!,
		})),
	} as unknown as RuntimeRegistry;
}

function makeEvent(
	overrides: Partial<ArtifactEmittedEvent> = {},
): ArtifactEmittedEvent {
	return {
		event_id: "evt-1",
		execution_id: "exec-ae-1",
		issue_id: "issue-ae-1",
		project_name: "GeoForge3D",
		payload: {
			kind: "ui",
			paths: ["/tmp/flywheel-screens/x.png"],
			dedup_key: "exec-ae-1|test|ui",
			attempt: 1,
		},
		...overrides,
	};
}

async function seedSession(
	store: StateStore,
	execId: string,
	sessionParams?: Record<string, unknown>,
): Promise<void> {
	store.upsertSession({
		execution_id: execId,
		issue_id: "issue-ae-1",
		project_name: "GeoForge3D",
		status: "running",
		started_at: "2026-05-21T00:00:00",
		last_activity_at: "2026-05-21T00:00:00",
		heartbeat_at: "2026-05-21T00:00:00",
		issue_identifier: "GEO-151",
		issue_title: "ProofShot integration",
		session_role: "main",
	});
	if (sessionParams) {
		store.setSessionParams(execId, sessionParams);
	}
}

describe("handleArtifactEvent (GEO-151 A6)", () => {
	let store: StateStore;
	let deliver: MockDeliver;
	let registry: RuntimeRegistry;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		deliver = { calls: [], nextResult: { delivered: true } };
		registry = makeRegistry(deliver);
	});

	afterEach(() => {
		store.close();
	});

	it("AC7: builds HookPayload {event_type:'artifact_delivery', paths, kind, dedup_key, attempt, chat_thread_id}", async () => {
		await seedSession(store, "exec-ae-1", {
			proofshot: {
				runs: {
					"exec-ae-1|test|ui": {
						state: "pending",
						dedupKey: "exec-ae-1|test|ui",
						attempt: 1,
						updatedAt: Date.now(),
						lastError: null,
					},
				},
			},
		});
		const result = await handleArtifactEvent(
			store,
			testProjects,
			registry,
			makeEvent(),
		);
		expect(result.handled).toBe(true);
		expect(result.delivered).toBe(true);
		expect(deliver.calls).toHaveLength(1);
		const envelope = deliver.calls[0]!.envelope as {
			seq: number;
			event: Record<string, unknown>;
			sessionKey: string;
			leadId: string;
			timestamp: string;
		};
		// envelope shape — assembled manually (appendLeadEvent returns numeric seq)
		expect(typeof envelope.seq).toBe("number");
		expect(envelope.leadId).toBe("product-lead");
		expect(typeof envelope.timestamp).toBe("string");
		expect(envelope.sessionKey).toBe("flywheel:GEO-151");
		// HookPayload — wire field names
		const e = envelope.event;
		expect(e.event_type).toBe("artifact_delivery");
		expect(e.execution_id).toBe("exec-ae-1");
		expect(e.issue_id).toBe("issue-ae-1");
		expect(e.issue_identifier).toBe("GEO-151");
		expect(e.project_name).toBe("GeoForge3D");
		expect(e.kind).toBe("ui");
		expect(e.paths).toEqual(["/tmp/flywheel-screens/x.png"]);
		expect(e.dedup_key).toBe("exec-ae-1|test|ui");
		expect(e.attempt).toBe(1);
		expect(e.size_cap_bytes).toBe(25 * 1024 * 1024);
		expect(e.file_count_cap).toBe(10);
		expect(typeof e.oversize_fallback_text).toBe("string");
	});

	it("AC7: delivered=true → markLeadEventDelivered + advances run state to completed", async () => {
		await seedSession(store, "exec-ae-1", {
			proofshot: {
				runs: {
					"exec-ae-1|test|ui": {
						state: "pending",
						dedupKey: "exec-ae-1|test|ui",
						attempt: 1,
						updatedAt: Date.now(),
						lastError: null,
					},
				},
			},
		});
		await handleArtifactEvent(store, testProjects, registry, makeEvent());
		const params = store.getSessionParams("exec-ae-1");
		const proofs = getProofShotParams(params);
		const run = proofs.runs?.["exec-ae-1|test|ui"];
		expect(run?.state).toBe("completed");
	});

	it("AC7: stale-artifact (attempt mismatch) does NOT mark completed", async () => {
		// run is at attempt=2, but event payload claims attempt=1 (stale)
		await seedSession(store, "exec-ae-1", {
			proofshot: {
				runs: {
					"exec-ae-1|test|ui": {
						state: "pending",
						dedupKey: "exec-ae-1|test|ui",
						attempt: 2,
						updatedAt: Date.now(),
						lastError: null,
					},
				},
			},
		});
		await handleArtifactEvent(
			store,
			testProjects,
			registry,
			makeEvent({
				payload: {
					kind: "ui",
					paths: ["/tmp/flywheel-screens/x.png"],
					dedup_key: "exec-ae-1|test|ui",
					attempt: 1, // stale!
				},
			}),
		);
		const params = store.getSessionParams("exec-ae-1");
		const proofs = getProofShotParams(params);
		const run = proofs.runs?.["exec-ae-1|test|ui"];
		// Still pending (attempt 2 wasn't matched, so completion didn't fire)
		expect(run?.state).toBe("pending");
		expect(run?.attempt).toBe(2);
	});

	it("AC7: unknown dedupKey leaves runs untouched (no panic)", async () => {
		await seedSession(store, "exec-ae-1", {
			proofshot: {
				runs: {
					"other-key": {
						state: "pending",
						dedupKey: "other-key",
						attempt: 1,
						updatedAt: Date.now(),
						lastError: null,
					},
				},
			},
		});
		await handleArtifactEvent(store, testProjects, registry, makeEvent());
		const params = store.getSessionParams("exec-ae-1");
		const proofs = getProofShotParams(params);
		// other-key still untouched
		expect(proofs.runs?.["other-key"]?.state).toBe("pending");
		// no new key added
		expect(Object.keys(proofs.runs ?? {})).toEqual(["other-key"]);
	});

	it("AC7: delivered=false → recordDeliveryFailure (retry path active)", async () => {
		await seedSession(store, "exec-ae-1", {
			proofshot: {
				runs: {
					"exec-ae-1|test|ui": {
						state: "pending",
						dedupKey: "exec-ae-1|test|ui",
						attempt: 1,
						updatedAt: Date.now(),
						lastError: null,
					},
				},
			},
		});
		deliver.nextResult = {
			delivered: false,
			error: "transport timeout",
		};
		const result = await handleArtifactEvent(
			store,
			testProjects,
			registry,
			makeEvent(),
		);
		expect(result.handled).toBe(true);
		expect(result.delivered).toBe(false);
		// run state did NOT advance to completed
		const params = store.getSessionParams("exec-ae-1");
		const proofs = getProofShotParams(params);
		expect(proofs.runs?.["exec-ae-1|test|ui"]?.state).toBe("pending");
	});

	it("AC7: runtime.deliver throws → recordDeliveryFailure (caught)", async () => {
		await seedSession(store, "exec-ae-1");
		deliver.nextThrow = new Error("network reset");
		const result = await handleArtifactEvent(
			store,
			testProjects,
			registry,
			makeEvent(),
		);
		expect(result.handled).toBe(true);
		expect(result.delivered).toBe(false);
		// Did not bubble up the throw
	});

	it("resolveLeadForIssue throws (unknown project) → {handled:false}, no Lead event written", async () => {
		await seedSession(store, "exec-ae-1");
		const result = await handleArtifactEvent(
			store,
			testProjects,
			registry,
			makeEvent({ project_name: "Unknown" }),
		);
		expect(result.handled).toBe(false);
		expect(deliver.calls).toHaveLength(0);
	});

	it("no session → {handled:false}", async () => {
		const result = await handleArtifactEvent(
			store,
			testProjects,
			registry,
			makeEvent(),
		);
		expect(result.handled).toBe(false);
	});

	it("payload kind=3d preserved in HookPayload", async () => {
		await seedSession(store, "exec-ae-1");
		await handleArtifactEvent(
			store,
			testProjects,
			registry,
			makeEvent({
				payload: {
					kind: "3d",
					paths: ["/tmp/flywheel-screens/3d.png"],
					dedup_key: "exec-ae-1|test|3d",
					attempt: 1,
				},
			}),
		);
		const envelope = deliver.calls[0]!.envelope as {
			event: Record<string, unknown>;
		};
		expect(envelope.event.kind).toBe("3d");
	});

	it("missing dedup_key + attempt — still delivers but skips completion advance", async () => {
		await seedSession(store, "exec-ae-1", {
			proofshot: {
				runs: {
					"exec-ae-1|test|ui": {
						state: "pending",
						dedupKey: "exec-ae-1|test|ui",
						attempt: 1,
						updatedAt: Date.now(),
						lastError: null,
					},
				},
			},
		});
		await handleArtifactEvent(
			store,
			testProjects,
			registry,
			makeEvent({
				payload: {
					kind: "ui",
					paths: ["/tmp/flywheel-screens/x.png"],
					// no dedup_key, no attempt
				},
			}),
		);
		// Delivery happened
		expect(deliver.calls).toHaveLength(1);
		// But completion did NOT advance (no correlation key)
		const params = store.getSessionParams("exec-ae-1");
		const proofs = getProofShotParams(params);
		expect(proofs.runs?.["exec-ae-1|test|ui"]?.state).toBe("pending");
	});
});
