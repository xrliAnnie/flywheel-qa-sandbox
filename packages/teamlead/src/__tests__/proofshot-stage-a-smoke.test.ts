/**
 * GEO-151 A7 — Stage A end-to-end smoke test.
 *
 * Wires the full Bridge-side chain in-process with mocked external boundaries
 * (MailboxTransport, ProofShot CLI, runtime.deliver). The point is to catch
 * any cross-commit wire drift early — a Codex review caught at the design
 * stage that correlation fields (`dedup_key` + `attempt`) must thread
 * unchanged from `stage_changed` through to the Lead inbox, and this test
 * proves the chain end-to-end.
 *
 * Chain under test:
 *   1. `stage_changed` event hits Bridge `handleProofShotAutoTrigger`.
 *   2. Handler writes the Runner instruction via `MailboxTransport.writeVerified`
 *      (mocked — captures arg shape).
 *   3. Wrapper would run `proofshot start/exec/stop` (here: we manually
 *      simulate the side effect by writing fixture artifacts + a manifest).
 *   4. Runner calls `flywheel-comm notify --paths-from <manifest>` (here: we
 *      invoke `notify()` directly with manifest + mocked `fetch`).
 *   5. The captured POST body is fed back into Bridge `handleArtifactEvent`
 *      (which is what the real Bridge `/events` route would do).
 *   6. Mocked `runtime.deliver` captures the LeadEventEnvelope.
 *   7. Assert correlation fields (`dedup_key`, `attempt`) match the original
 *      values from step 1 → step 2 → step 4 → step 6.
 *
 * Why not spin up a real HTTP server? The chain that matters is purely
 * in-process — POST /events handler is a thin wrapper over
 * `handleArtifactEvent`. We test that wrapper separately in
 * artifact-event.test.ts. This file tests the *correlation*.
 */

import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notify } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ArtifactEmittedEvent,
	handleArtifactEvent,
} from "../bridge/artifact-event.js";
import { getProofShotParams } from "../bridge/proofshot-session.js";
import { handleProofShotAutoTrigger } from "../bridge/proofshot-trigger.js";
import type { RuntimeRegistry } from "../bridge/runtime-registry.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const testProjects: ProjectEntry[] = [
	{
		projectName: "GeoForge3D",
		projectRoot: "/tmp/proofshot-stage-a-smoke",
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

// Capture mailbox writes from handleProofShotAutoTrigger.
const mailboxWrites: Array<{
	leadName: string;
	recipient: string;
	payload: {
		from: string;
		to: string;
		content: string;
		metadata?: Record<string, unknown>;
	};
}> = [];

vi.mock("../mailbox/MailboxTransport.js", () => ({
	MailboxTransport: vi.fn().mockImplementation(() => ({
		writeVerified: vi.fn(async (args) => {
			mailboxWrites.push(args);
			return {
				flywheelId: args.payload?.metadata?.flywheelId,
				idempotent: false,
				wroteAt: Date.now(),
			};
		}),
	})),
}));

vi.mock("flywheel-agent-team-transport", () => ({
	AgentTeamTransportFactory: { fromEnv: vi.fn(() => ({})) },
}));

// Capture Lead-side runtime.deliver invocations.
interface DeliveredEnvelope {
	seq: number;
	event: Record<string, unknown>;
	sessionKey: string;
	leadId: string;
	timestamp: string;
}
const deliveredEnvelopes: DeliveredEnvelope[] = [];

function makeRegistry(): RuntimeRegistry {
	return {
		resolveWithLead: vi.fn(() => ({
			runtime: {
				deliver: vi.fn(async (env: DeliveredEnvelope) => {
					deliveredEnvelopes.push(env);
					return { delivered: true };
				}),
			},
			lead: testProjects[0]!.leads[0]!,
		})),
	} as unknown as RuntimeRegistry;
}

describe("GEO-151 Stage A — end-to-end smoke (handler → wrapper → notify → artifact-event)", () => {
	let store: StateStore;
	let tmpHome: string;
	let originalHome: string | undefined;
	let originalBridgeUrl: string | undefined;
	let captureDir: string;
	let manifestPath: string;

	const execId = "exec-smoke-12345678";
	const issueId = "issue-smoke-1";
	const stage = "test";

	beforeEach(async () => {
		mailboxWrites.length = 0;
		deliveredEnvelopes.length = 0;
		store = await StateStore.create(":memory:");
		tmpHome = join(tmpdir(), `psm-${Date.now()}-${Math.random()}`);
		mkdirSync(tmpHome, { recursive: true });
		originalHome = process.env.HOME;
		process.env.HOME = tmpHome;
		originalBridgeUrl = process.env.FLYWHEEL_BRIDGE_URL;
		process.env.FLYWHEEL_BRIDGE_URL = "http://127.0.0.1:8088";
		process.env.FLYWHEEL_COMM_BACKEND = "mailbox";

		// Fixture artifact dir under allowed prefix
		captureDir = join("/tmp", "flywheel-screens", `smoke-${Date.now()}`);
		mkdirSync(captureDir, { recursive: true });
		manifestPath = join(captureDir, "manifest.json");

		// Seed session with proofshot config (DirectEventSink.emitStarted would
		// normally do this — short-circuit for the smoke test).
		store.upsertSession({
			execution_id: execId,
			issue_id: issueId,
			project_name: "GeoForge3D",
			status: "running",
			started_at: "2026-05-21T00:00:00",
			last_activity_at: "2026-05-21T00:00:00",
			heartbeat_at: "2026-05-21T00:00:00",
			issue_identifier: "GEO-151",
			issue_title: "ProofShot smoke",
			session_role: "main",
		});
		store.setSessionParams(execId, {
			proofshot: {
				config: {
					enabled: true,
					dev_command: "pnpm dev",
					capture_stages: [stage],
					vision_default: true,
				},
			},
		});
	});

	afterEach(() => {
		store.close();
		process.env.HOME = originalHome;
		process.env.FLYWHEEL_BRIDGE_URL = originalBridgeUrl;
		delete process.env.FLYWHEEL_COMM_BACKEND;
		try {
			rmSync(tmpHome, { recursive: true, force: true });
		} catch {}
		try {
			rmSync(captureDir, { recursive: true, force: true });
		} catch {}
	});

	it("threads dedup_key + attempt unchanged through stage_changed → mailbox → manifest → notify → artifact_delivery", async () => {
		// STEP 1: Bridge handleProofShotAutoTrigger fires on stage_changed.
		await handleProofShotAutoTrigger(
			store,
			testProjects,
			{ execution_id: execId, issue_id: issueId, project_name: "GeoForge3D" },
			stage,
		);

		// STEP 2: One mailbox write. Capture correlation from metadata.
		expect(mailboxWrites).toHaveLength(1);
		const mbox = mailboxWrites[0]!;
		const meta = mbox.payload.metadata!;
		expect(meta.dedupKey).toBe(`${execId}|${stage}|ui`);
		expect(meta.attempt).toBe(1);
		expect(meta.captureKind).toBe("ui");
		expect(meta.stage).toBe(stage);
		expect(mbox.payload.from).toBe("bridge");
		expect(mbox.payload.to).toBe(`runner-${execId.slice(0, 8)}`);
		// Instruction template includes --dedup-key + --attempt flags.
		expect(mbox.payload.content).toContain(
			`--dedup-key "${execId}|${stage}|ui"`,
		);
		expect(mbox.payload.content).toContain("--attempt 1");
		expect(mbox.payload.content).toContain("flywheel-comm notify --paths-from");

		// State machine: pending after the write.
		{
			const params = store.getSessionParams(execId);
			const proofs = getProofShotParams(params);
			const run = proofs.runs?.[`${execId}|${stage}|ui`];
			expect(run?.state).toBe("pending");
			expect(run?.attempt).toBe(1);
		}

		// STEP 3: Simulate the wrapper running ProofShot + writing artifacts.
		// We just write a SUMMARY + one PNG into captureDir, and the manifest
		// — same shape as the real wrapper would produce (wire JSON).
		const summaryPath = join(captureDir, "SUMMARY.md");
		const pngPath = join(captureDir, "step-00.png");
		writeFileSync(summaryPath, "## summary");
		writeFileSync(pngPath, "PNG-FAKE");
		writeFileSync(
			manifestPath,
			JSON.stringify({
				selected: [summaryPath, pngPath],
				dropped: [],
				totalTokens: 2000,
				captureKind: "ui",
				execId,
				issue_id: issueId,
				project_name: "GeoForge3D",
				stage,
				dedup_key: `${execId}|${stage}|ui`,
				attempt: 1,
			}),
		);

		// STEP 4: Runner-side notify. Mock fetch + capture POST body.
		const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> =
			[];
		const fetchMock = vi.fn(
			async (url: string | URL | Request, init?: RequestInit) => {
				const body =
					typeof init?.body === "string"
						? (JSON.parse(init.body) as Record<string, unknown>)
						: {};
				fetchCalls.push({ url: String(url), body });
				return new Response("", { status: 200 });
			},
		) as unknown as typeof fetch;
		const dbPath = join(tmpHome, "comm.db");
		const notifyResult = await notify({
			kind: "artifact",
			pathsFrom: manifestPath,
			dbPath,
			fetchFn: fetchMock,
		});
		expect(notifyResult.posted).toBe(true);
		expect(fetchCalls).toHaveLength(1);
		const postBody = fetchCalls[0]!.body;
		const postPayload = postBody.payload as Record<string, unknown>;
		// Correlation preserved end-to-end so far.
		expect(postPayload.dedup_key).toBe(`${execId}|${stage}|ui`);
		expect(postPayload.attempt).toBe(1);

		// STEP 5: Feed the POST body into Bridge handleArtifactEvent (this is
		// what the real /events POST route does — see event-route.ts).
		const registry = makeRegistry();
		const artifactEvent: ArtifactEmittedEvent = {
			event_id: postBody.event_id as string,
			execution_id: postBody.execution_id as string,
			issue_id: postBody.issue_id as string,
			project_name: postBody.project_name as string,
			payload: postPayload,
		};
		const result = await handleArtifactEvent(
			store,
			testProjects,
			registry,
			artifactEvent,
		);
		expect(result.handled).toBe(true);
		expect(result.delivered).toBe(true);

		// STEP 6: One LeadEventEnvelope delivered with correlation preserved.
		expect(deliveredEnvelopes).toHaveLength(1);
		const env = deliveredEnvelopes[0]!;
		expect(env.leadId).toBe("product-lead");
		const ev = env.event;
		expect(ev.event_type).toBe("artifact_delivery");
		expect(ev.execution_id).toBe(execId);
		expect(ev.issue_id).toBe(issueId);
		expect(ev.dedup_key).toBe(`${execId}|${stage}|ui`);
		expect(ev.attempt).toBe(1);
		expect(ev.paths).toEqual([summaryPath, pngPath].map((p) => realpath(p)));
		expect(ev.kind).toBe("ui");
		// chat_thread_id is undefined because we didn't seed a chat thread —
		// formatter renders "(no chat_thread_id resolved)" but the field is undefined.
		expect(ev.chat_thread_id).toBeUndefined();

		// STEP 7: completion advanced because attempt matched.
		{
			const params = store.getSessionParams(execId);
			const proofs = getProofShotParams(params);
			const run = proofs.runs?.[`${execId}|${stage}|ui`];
			expect(run?.state).toBe("completed");
		}
	});

	it("idempotent: re-firing handleProofShotAutoTrigger before artifact arrives → second skipped (active pending within TTL)", async () => {
		await handleProofShotAutoTrigger(
			store,
			testProjects,
			{ execution_id: execId, issue_id: issueId, project_name: "GeoForge3D" },
			stage,
		);
		await handleProofShotAutoTrigger(
			store,
			testProjects,
			{ execution_id: execId, issue_id: issueId, project_name: "GeoForge3D" },
			stage,
		);
		// Only one mailbox write — second call short-circuited.
		expect(mailboxWrites).toHaveLength(1);
	});

	it("stale artifact (wrong attempt) does NOT mark run completed", async () => {
		// Manually seed run at attempt=2; artifact event claims attempt=1 (stale).
		store.setSessionParams(execId, {
			proofshot: {
				config: { enabled: true, capture_stages: [stage] },
				runs: {
					[`${execId}|${stage}|ui`]: {
						state: "pending",
						dedupKey: `${execId}|${stage}|ui`,
						attempt: 2,
						updatedAt: Date.now(),
						lastError: null,
					},
				},
			},
		});

		const registry = makeRegistry();
		await handleArtifactEvent(store, testProjects, registry, {
			event_id: "evt-stale",
			execution_id: execId,
			issue_id: issueId,
			project_name: "GeoForge3D",
			payload: {
				kind: "ui",
				paths: ["/tmp/flywheel-screens/x.png"],
				dedup_key: `${execId}|${stage}|ui`,
				attempt: 1, // stale!
			},
		});

		// Lead still got the message (we don't drop delivery, just don't
		// mark completion on the wrong run).
		expect(deliveredEnvelopes).toHaveLength(1);
		// But the run record stays pending at attempt=2.
		const params = store.getSessionParams(execId);
		const proofs = getProofShotParams(params);
		const run = proofs.runs?.[`${execId}|${stage}|ui`];
		expect(run?.state).toBe("pending");
		expect(run?.attempt).toBe(2);
	});
});

// Local helper — realpath wrapper to keep test assertions readable.
// notify normalizes paths via realpath; tests need the same form to compare.
// On macOS /tmp resolves to /private/tmp.
function realpath(p: string): string {
	return realpathSync(p);
}
