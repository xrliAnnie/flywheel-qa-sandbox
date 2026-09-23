import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BridgeVoiceClient,
	VoiceLease,
} from "../../../voice-codex/src/bridge-client.js";
import {
	VoiceHandoffError,
	VoiceHandoffService,
	type VoiceMailboxSettlement,
} from "../bridge/voice-handoff.js";
import { voiceSessionAuthMiddleware } from "../bridge/voice-session-auth.js";
import { createVoiceSessionRouter } from "../bridge/voice-session-routes.js";
import { StateStore, type VoiceSessionRow } from "../StateStore.js";

const NOW = "2026-09-23T12:00:00.000Z";
const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const MASTER = "master-token";
const INGEST = "ingest-token";
let root: string;
let store: StateStore;
let server: Server | undefined;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "fly2799-handoff-"));
	store = await StateStore.create(join(root, "teamlead.db"));
});

afterEach(
	() =>
		new Promise<void>((resolve) => {
			const finish = () => {
				store.close();
				rmSync(root, { recursive: true, force: true });
				resolve();
			};
			if (!server) return finish();
			server.close(finish);
			server = undefined;
		}),
);

function liveSession(): { session: VoiceSessionRow; leaseToken: string } {
	store.reserveVoiceSession({
		sessionId: SESSION_ID,
		mode: "meeting",
		projectName: "flywheel",
		leadId: "raya",
		guildId: "100000000000000001",
		voiceChannelId: "100000000000000002",
		voiceBotUserId: "100000000000000003",
		meetingId: "20000000-0000-4000-8000-000000000001",
		requestedBy: "master",
		credentialTier: "master",
		createdAt: NOW,
	});
	store.updateVoiceProvisioning({
		sessionId: SESSION_ID,
		expectedStep: "reserved",
		nextStep: "done",
		nextState: "desired",
		updatedAt: NOW,
	});
	const claim = store.claimVoiceSession({
		sessionId: SESSION_ID,
		daemonBootId: "boot-a",
		now: NOW,
		leaseTtlMs: 60_000,
	});
	if (!claim) throw new Error("claim failed");
	store.setVoiceSessionState({
		sessionId: SESSION_ID,
		leaseToken: claim.leaseToken,
		state: "warming",
		now: NOW,
	});
	store.setVoiceSessionState({
		sessionId: SESSION_ID,
		leaseToken: claim.leaseToken,
		state: "live",
		now: NOW,
	});
	return {
		session: store.getVoiceSession(SESSION_ID)!,
		leaseToken: claim.leaseToken,
	};
}

function utterance(
	leaseToken: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		sessionId: SESSION_ID,
		leaseToken,
		transcriptId: "transcript-a",
		utteranceId: "utterance-a",
		sessionGeneration: 1,
		sequence: 1,
		source: "room_audio" as const,
		role: "user" as const,
		text: "请给 FLY-2799 开一个后续单",
		final: true,
		attribution: { kind: "known" as const, speakerUserId: "founder" },
		captureDigest: "c".repeat(64),
		...overrides,
	};
}

function service(
	options: {
		enqueue?: ReturnType<typeof vi.fn>;
		inspect?: (deliveryId: string) => VoiceMailboxSettlement;
		now?: () => string;
		deliveryCanReconcile?: boolean;
		authority?: () => boolean;
	} = {},
) {
	const enqueue =
		options.enqueue ??
		vi.fn(async (envelope) => ({
			queued: true as const,
			deliveryId: `lead_event:${envelope.leadId}:${envelope.eventId}`,
			seq: envelope.seq,
			outcome: "inserted" as const,
		}));
	return {
		enqueue,
		service: new VoiceHandoffService({
			store,
			now: options.now ?? (() => NOW),
			founderUserIds: () => ["founder"],
			validateAuthorityBinding: options.authority ?? (() => true),
			enqueueLeadEvent: enqueue,
			inspectDeliveryState:
				options.inspect ?? (() => ({ kind: "absent" as const })),
			deliveryCanReconcile: options.deliveryCanReconcile,
		}),
	};
}

function handoff(leaseToken: string, overrides: Record<string, unknown> = {}) {
	return {
		sessionId: SESSION_ID,
		leaseToken,
		intentKind: "create_issue" as const,
		payload: { title: "跟进 FLY-2799", quote: "给 FLY-2799 开一个后续单" },
		transcriptId: "transcript-a",
		originalText: "请给 FLY-2799 开一个后续单",
		idempotencyKey: "action-a",
		authorityBinding: { issueId: "FLY-2799", epoch: 3 },
		...overrides,
	};
}

describe("durable voice utterances", () => {
	it("replays the same transcript receipt and rejects a changed body or lease", () => {
		const { leaseToken } = liveSession();
		const h = service();
		const first = h.service.recordUtterance(utterance(leaseToken));
		expect(first).toMatchObject({
			status: "inserted",
			receipt: {
				sessionId: SESSION_ID,
				transcriptId: "transcript-a",
				contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
				receiptId: expect.stringMatching(/^[a-f0-9]{64}$/),
			},
		});
		expect(h.service.recordUtterance(utterance(leaseToken))).toMatchObject({
			status: "replayed",
			receipt: first.receipt,
		});
		expect(() =>
			h.service.recordUtterance(
				utterance(leaseToken, { text: "changed same transcript id" }),
			),
		).toThrow("voice_transcript_conflict");
		expect(() => h.service.recordUtterance(utterance("wrong-lease"))).toThrow(
			"voice_lease_conflict",
		);
	});

	it("persists partial and unknown speech but never authorizes it", async () => {
		const { leaseToken } = liveSession();
		const h = service();
		for (const input of [
			utterance(leaseToken, {
				transcriptId: "partial",
				final: false,
			}),
			utterance(leaseToken, {
				transcriptId: "unknown",
				attribution: { kind: "unknown", reason: "input_gap" },
			}),
			utterance(leaseToken, {
				transcriptId: "nonfounder",
				attribution: { kind: "known", speakerUserId: "guest" },
			}),
		]) {
			h.service.recordUtterance(input);
		}
		for (const transcriptId of [
			"partial",
			"unknown",
			"nonfounder",
			"missing",
		]) {
			await expect(
				h.service.handoff(handoff(leaseToken, { transcriptId })),
			).rejects.toBeInstanceOf(VoiceHandoffError);
		}
		expect(h.enqueue).not.toHaveBeenCalled();
	});

	it("rejects a stale or forged authority binding before dispatch", async () => {
		const { leaseToken } = liveSession();
		const h = service({ authority: () => false });
		h.service.recordUtterance(utterance(leaseToken));
		await expect(h.service.handoff(handoff(leaseToken))).rejects.toThrow(
			"voice_authority_binding_invalid",
		);
		expect(h.enqueue).not.toHaveBeenCalled();
	});
});

describe("voice handoff state machine", () => {
	it("queues one intent to the bound Lead, replays it, and keeps queued distinct from committed", async () => {
		const { leaseToken } = liveSession();
		const h = service();
		h.service.recordUtterance(utterance(leaseToken));
		const first = await h.service.handoff(handoff(leaseToken));
		expect(first).toMatchObject({
			state: "dispatched",
			handoffId: expect.any(String),
			requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(store.getVoiceHandoff(first.handoffId)).toMatchObject({
			leadId: "raya",
			state: "dispatched",
			providerOperationId: expect.stringContaining(first.handoffId),
			deliveryId: expect.stringContaining(first.handoffId),
		});
		expect(h.enqueue).toHaveBeenCalledTimes(1);
		expect(await h.service.handoff(handoff(leaseToken))).toEqual(first);
		expect(h.enqueue).toHaveBeenCalledTimes(1);
		await expect(
			h.service.handoff(
				handoff(leaseToken, { payload: { title: "different" } }),
			),
		).rejects.toThrow("voice_handoff_idempotency_conflict");

		expect(
			h.service.recordExecution({
				handoffId: first.handoffId,
				providerOperationId: store.getVoiceHandoff(first.handoffId)!
					.providerOperationId!,
				finalState: "committed",
				evidence: { result: "test issue created" },
				at: NOW,
			}),
		).toMatchObject({ state: "committed" });
	});

	it("records an ambiguous I/O outcome and never blindly re-enqueues it", async () => {
		const { leaseToken } = liveSession();
		const enqueue = vi.fn(async () => {
			throw new Error("ack_lost");
		});
		const inspect = vi.fn(() => ({ kind: "archived_terminal" as const }));
		const h = service({ enqueue, inspect });
		h.service.recordUtterance(utterance(leaseToken));
		const receipt = await h.service.handoff(handoff(leaseToken));
		expect(receipt.state).toBe("ambiguous");
		expect(store.getVoiceHandoff(receipt.handoffId)).toMatchObject({
			state: "ambiguous",
			attemptToken: expect.any(String),
			providerOperationId: expect.any(String),
			lastDispatchError: "ack_lost",
			terminalReason: null,
		});
		expect(h.service.reconcileNext("reconciler-a")).toMatchObject({
			state: "ambiguous",
			lastReconcileResult: "archived_terminal",
		});
		expect(inspect).toHaveBeenCalledOnce();
		expect(enqueue).toHaveBeenCalledOnce();
	});

	it("recovers a crash before external I/O by inspection, never replay", () => {
		const { leaseToken } = liveSession();
		const beforeCrash = service();
		beforeCrash.service.recordUtterance(utterance(leaseToken));
		const authorized = store.authorizeVoiceHandoff({
			...handoff(leaseToken),
			founderUserIds: ["founder"],
			deliveryCanReconcile: true,
			now: NOW,
		});
		if (!("handoff" in authorized)) throw new Error(authorized.status);
		expect(authorized.handoff.state).toBe("dispatching");

		const inspect = vi.fn(() => ({ kind: "absent" as const }));
		const afterRestart = service({ inspect });
		expect(store.getVoiceHandoff(authorized.handoff.handoffId)?.state).toBe(
			"ambiguous",
		);
		expect(store.getVoiceHandoff(authorized.handoff.handoffId)).toMatchObject({
			lastDispatchError: "process_restarted_during_dispatch",
			terminalReason: null,
		});
		expect(
			afterRestart.service.reconcileNext("reconciler-restart"),
		).toMatchObject({ state: "ambiguous" });
		expect(afterRestart.enqueue).not.toHaveBeenCalled();
		expect(inspect).toHaveBeenCalledWith(
			authorized.handoff.deliveryId,
			expect.objectContaining({ handoffId: authorized.handoff.handoffId }),
		);
	});

	it("starts and stops the bounded production reconciler", async () => {
		const { leaseToken } = liveSession();
		const inspect = vi.fn(() => ({ kind: "absent" as const }));
		const h = service({
			enqueue: vi.fn(async () => {
				throw new Error("ack_lost");
			}),
			inspect,
		});
		h.service.recordUtterance(utterance(leaseToken));
		await h.service.handoff(handoff(leaseToken));

		h.service.startReconciler("bridge-a", 100);
		expect(inspect).toHaveBeenCalledOnce();
		h.service.stopReconciler();
	});

	it("uses a CAS recovery lease and reaches needs_human after 24 hours", async () => {
		let clock = NOW;
		const { leaseToken } = liveSession();
		const h = service({
			enqueue: vi.fn(async () => {
				throw new Error("unknown_delivery");
			}),
			now: () => clock,
		});
		h.service.recordUtterance(utterance(leaseToken));
		const receipt = await h.service.handoff(handoff(leaseToken));
		const first = store.claimVoiceHandoffReconciliation({
			owner: "worker-a",
			now: new Date(Date.parse(NOW) + 1_100).toISOString(),
			leaseMs: 10_000,
		});
		const second = store.claimVoiceHandoffReconciliation({
			owner: "worker-b",
			now: new Date(Date.parse(NOW) + 1_100).toISOString(),
			leaseMs: 10_000,
		});
		expect(first?.handoffId).toBe(receipt.handoffId);
		expect(second).toBeUndefined();

		clock = new Date(Date.parse(NOW) + 24 * 60 * 60_000 + 1).toISOString();
		store.releaseVoiceHandoffReconciliation({
			handoffId: first!.handoffId,
			claimToken: first!.claimToken!,
			stateVersion: first!.stateVersion,
			now: clock,
			settlement: { kind: "absent" },
		});
		expect(store.getVoiceHandoff(receipt.handoffId)).toMatchObject({
			state: "needs_human",
			terminalReason: "reconciliation_horizon_exhausted",
		});
	});

	it("rejects dispatch when the carrier has no pre-persistable query key", async () => {
		const { leaseToken } = liveSession();
		const h = service({ deliveryCanReconcile: false });
		h.service.recordUtterance(utterance(leaseToken));
		const receipt = await h.service.handoff(handoff(leaseToken));
		expect(receipt).toMatchObject({
			state: "rejected",
			reason: "carrier_not_reconcilable",
		});
		expect(h.enqueue).not.toHaveBeenCalled();
	});
});

describe("voice handoff HTTP authorization", () => {
	it("keeps utterance and handoff endpoints on the fail-closed master session router", async () => {
		const { leaseToken } = liveSession();
		const h = service();
		const app = express();
		app.use(express.json());
		app.use(
			"/api/voice/sessions",
			voiceSessionAuthMiddleware(MASTER, INGEST),
			createVoiceSessionRouter({
				store,
				leaseTtlMs: 60_000,
				leaseRenewMs: 4_000,
				now: () => NOW,
				resolveStart: () => {
					throw new Error("unused");
				},
				provisionSession: () => undefined,
				projectSession: () => ({}),
				voiceHandoffs: h.service,
			}),
		);
		server = createServer(app);
		await new Promise<void>((resolve) =>
			server!.listen(0, "127.0.0.1", resolve),
		);
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/voice/sessions/${SESSION_ID}`;
		const call = async (path: string, token: string, body: unknown) => {
			const response = await fetch(`${base}${path}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"X-Voice-Lease": leaseToken,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			});
			return { status: response.status, body: await response.json() };
		};
		expect(
			(await call("/utterances", INGEST, utterance(leaseToken))).status,
		).toBe(403);
		const body = { ...utterance(leaseToken) };
		delete (body as { sessionId?: string }).sessionId;
		delete (body as { leaseToken?: string }).leaseToken;
		expect(await call("/utterances", MASTER, body)).toMatchObject({
			status: 201,
			body: { receipt: { transcriptId: "transcript-a" } },
		});
		const forged = {
			...handoff(leaseToken),
			transcriptDurabilityReceipt: { forged: true },
		};
		delete (forged as { sessionId?: string }).sessionId;
		delete (forged as { leaseToken?: string }).leaseToken;
		expect(await call("/handoffs", MASTER, forged)).toMatchObject({
			status: 400,
			body: { error: "voice_handoff_invalid" },
		});
	});

	it("lets a fake trusted mode layer hand off only the selected action to the resident Lead", async () => {
		const { leaseToken } = liveSession();
		const h = service();
		const app = express();
		app.use(express.json());
		app.use(
			"/api/voice/sessions",
			voiceSessionAuthMiddleware(MASTER, INGEST),
			createVoiceSessionRouter({
				store,
				leaseTtlMs: 60_000,
				leaseRenewMs: 4_000,
				now: () => NOW,
				resolveStart: () => {
					throw new Error("unused");
				},
				provisionSession: () => undefined,
				projectSession: () => ({}),
				voiceHandoffs: h.service,
			}),
		);
		server = createServer(app);
		await new Promise<void>((resolve) =>
			server!.listen(0, "127.0.0.1", resolve),
		);
		const bridge = new BridgeVoiceClient({
			baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
			token: MASTER,
			httpTimeoutMs: 2_000,
		});
		const lease = new VoiceLease(() => 100);
		lease.install(100, 15_000, 2_000);
		const record = (input: {
			transcriptId: string;
			utteranceId: string;
			sequence: number;
			text: string;
		}) =>
			bridge.recordUtterance(SESSION_ID, leaseToken, lease, {
				...input,
				sessionGeneration: 1,
				source: "room_audio",
				role: "user",
				final: true,
				attribution: { kind: "known", speakerUserId: "founder" },
				captureDigest: input.sequence.toString(16).padStart(64, "0"),
			});
		await record({
			transcriptId: "transcript-casual",
			utteranceId: "utterance-casual",
			sequence: 1,
			text: "今天天气怎么样",
		});
		await record({
			transcriptId: "transcript-action",
			utteranceId: "utterance-action",
			sequence: 2,
			text: "请给 FLY-2799 开一个后续单",
		});

		// This explicit call stands in for the trusted 2796/2797 mode layer. The
		// engine and client do not classify or forward the casual utterance.
		const receipt = await bridge.handoffToLead(SESSION_ID, leaseToken, lease, {
			intentKind: "create_issue",
			payload: { title: "跟进 FLY-2799", quote: "开一个后续单" },
			transcriptId: "transcript-action",
			originalText: "请给 FLY-2799 开一个后续单",
			idempotencyKey: "action-a",
			authorityBinding: { issueId: "FLY-2799", epoch: 3 },
		});

		expect(receipt.state).toBe("dispatched");
		expect(h.enqueue).toHaveBeenCalledOnce();
		expect(h.enqueue).toHaveBeenCalledWith(
			expect.objectContaining({
				leadId: "raya",
				event: expect.objectContaining({
					voice_transcript_id: "transcript-action",
				}),
			}),
		);
		expect(JSON.stringify(h.enqueue.mock.calls)).not.toContain(
			"今天天气怎么样",
		);
	});
});
