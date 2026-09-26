import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type BetterSqlite3 from "better-sqlite3";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import type { EventEnvelope } from "flywheel-edge-worker";
import { afterEach, expect, it, vi } from "vitest";
import {
	EventFilter,
	leadNotificationDecision,
} from "../bridge/EventFilter.js";
import {
	initializeFlagStore,
	storeLeadStageChangedAuditEnabled,
	storeLeadTokenSavingsEnabled,
} from "../bridge/flag-store-runtime.js";
import {
	ClaudeLeadDeliveryAdapter,
	type LeadDeliveryBatch,
} from "../bridge/lead-delivery-adapter.js";
import {
	canonicalLeadEventDeliveryId,
	enqueueLeadEvent,
} from "../bridge/lead-event-queue.js";
import { LeadInboxLoop } from "../bridge/lead-inbox-loop.js";
import type { LeadEventEnvelope } from "../bridge/lead-runtime.js";
import { DEFAULT_MAILBOX_QUEUE_CONFIG } from "../bridge/mailbox-queue-config.js";
import { createBridgeApp } from "../bridge/plugin.js";
import { RuntimeRegistry } from "../bridge/runtime-registry.js";
import type { BridgeConfig } from "../bridge/types.js";
import { DirectEventSink } from "../DirectEventSink.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const FIXTURE = join(
	ROOT,
	"packages/teamlead/src/__tests__/fixtures/fly2912-evening",
);
const EVIDENCE = join(
	ROOT,
	"engineering/doc/FLY-2912-quiet-notification-expansion/evidence",
);
const LEAD = "flywheel-eng-lead";
const PROJECT = "flywheel";
const TARGETS = new Set([
	"stage_changed",
	"session_started",
	"session_monitoring_reestablished",
	"workflow_replacement_eligibility",
]);
const iso = (value: string) => `${value.replace(" ", "T")}Z`;
const hash = (value: unknown) =>
	createHash("sha256")
		.update(typeof value === "string" ? value : JSON.stringify(value))
		.digest("hex");
function jsonl<T>(file: string): T[] {
	return readFileSync(join(FIXTURE, file), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as T);
}
type Input = {
	event_id: string;
	event_type: string;
	seq: number;
	created_at: string;
	payload: string;
	delivery_disposition: "model" | "audit_only";
	session_key: string;
};
type RawStage = {
	event_id: string;
	execution_id: string;
	issue_id: string;
	project_name: string;
	source: string;
	ts: string;
	payload: string;
};
type IndexEntry = {
	inputIndex: number;
	eventId: string;
	unresolved: string[];
	producerRaw: {
		directCandidates: {
			eventId: string;
			sourceAt: string;
			rawPayloadAvailable: boolean;
			notificationDelayMs: number;
		}[];
	};
};
const inputs = jsonl<Input>("lead-events-v2.jsonl");
const rawStages = new Map(
	jsonl<RawStage>("session-events-v2.jsonl").map((row) => [row.event_id, row]),
);
const index = (
	JSON.parse(readFileSync(join(FIXTURE, "replay-index.json"), "utf8")) as {
		entries: IndexEntry[];
	}
).entries;

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

it("retains the seven hash-frozen exports and all 257 ordered inputs", () => {
	const manifest = JSON.parse(
		readFileSync(join(FIXTURE, "manifest.json"), "utf8"),
	);
	expect(manifest.files).toHaveLength(7);
	for (const file of manifest.files) {
		const content = readFileSync(join(FIXTURE, file.file), "utf8");
		expect(hash(content)).toBe(file.fixtureSha256);
		expect(content.trim().split("\n")).toHaveLength(file.rows);
	}
	expect(inputs).toHaveLength(257);
	expect(index.map((row) => row.eventId)).toEqual(
		inputs.map((row) => row.event_id),
	);
	expect(new Set(inputs.map((row) => row.event_id)).size).toBe(257);
	expect(
		inputs.filter((row) => row.delivery_disposition === "model"),
	).toHaveLength(169);
});

/**
 * A carries the observed source disposition at the producer append boundary;
 * it is not an execution of an unavailable historical binary. B/C use current
 * producers with the exported stage ingress unchanged. Evidence gaps are report
 * metadata, never injected into classifier input. No review/dispatch/probe
 * authority is synthesized from export-time mutable records. Historical stage\n * obligation absence is explicitly unknown at the proof boundary.
 */
async function replay(world: "A" | "B" | "C") {
	const directory = mkdtempSync(join(tmpdir(), `fly2912-evening-${world}-`));
	const previousCommDir = process.env.FLYWHEEL_COMM_DIR;
	process.env.FLYWHEEL_COMM_DIR = join(directory, "project-comm");
	const store = await StateStore.create(join(directory, "state.db"));
	const sql = (store as unknown as { db: { raw: BetterSqlite3.Database } }).db
		.raw;
	const queue = new MailboxQueue(join(directory, "comm.db"));
	const registry = new RuntimeRegistry();
	initializeFlagStore(store, {});
	expect(
		store.applyScopedFlagValueChange({
			name: "lead_token_savings",
			scope: PROJECT,
			op: "set",
			rawTo: world === "C" ? "0" : "1",
			expectedChangeSeq: store.getFlagValueChangeSeq(
				"lead_token_savings",
				PROJECT,
			),
			actor: "isolated-replay",
			reason: `FLY-2912 replay world ${world}`,
		}).ok,
	).toBe(true);
	expect(storeLeadTokenSavingsEnabled({ store }, PROJECT)).toBe(world !== "C");
	const lead = {
		agentId: LEAD,
		chatChannel: "replay-isolated-channel",
		match: { labels: [] },
	};
	const projects: ProjectEntry[] = [
		{ projectName: PROJECT, projectRoot: directory, leads: [lead] },
	];
	const config: BridgeConfig = {
		host: "127.0.0.1",
		port: 0,
		dbPath: join(directory, "state.db"),
		ingestToken: "replay-local-only",
		notificationChannel: "replay-isolated-channel",
		defaultLeadAgentId: LEAD,
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
		chatThreadsEnabled: false,
	};
	const enqueuedAt = new Map<string, string>();
	registry.register(lead, {
		type: "commdb",
		deliver: async () => {
			throw new Error("replay must use durable queue");
		},
		sendBootstrap: async () => {},
		shutdown: async () => {},
		health: async () => ({
			status: "healthy",
			lastDeliveredSeq: null,
			lastDeliveryAt: null,
		}),
	});
	registry.setAuditOnlyPredicate((envelope) =>
		store.isLeadEventAuditOnly(envelope.seq, envelope.leadId),
	);
	registry.setLeadEventEnqueuer((envelope, content) => {
		const receipt = enqueueLeadEvent({ queue, envelope, content });
		enqueuedAt.set(receipt.deliveryId, new Date().toISOString());
		return receipt;
	});
	const app = createBridgeApp(
		store,
		projects,
		config,
		undefined,
		undefined,
		undefined,
		undefined,
		new EventFilter(),
		undefined,
		registry,
	);
	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`;
	const sink = new DirectEventSink(
		store,
		config,
		projects,
		new EventFilter(),
		registry,
	);
	let source: Input | undefined;
	const originalAppend = store.appendLeadEvent.bind(store);
	const originalNotification = store.appendLeadNotification.bind(store);
	const sourcePolicy = vi
		.spyOn(store, "appendLeadNotification")
		.mockImplementation((input) => {
			if (!source) throw new Error("source record missing");
			if (world === "A")
				return originalAppend(
					input.binding.leadId,
					input.binding.eventId,
					input.eventType,
					source.payload,
					source.session_key,
					source.delivery_disposition,
				);
			// A fresh fixture session is not evidence that historical obligations were
			// absent. Substitute the explicit unknown authority at the proof boundary,
			// then run the real policy and persistence. Never alter producer ingress.
			if (input.evidence?.kind === "stage") {
				const evidence = {
					...input.evidence,
					proof: {
						...input.evidence.proof,
						action: { state: "unknown" as const },
					},
				};
				return originalNotification({
					...input,
					evidence,
					decision: leadNotificationDecision(
						input.eventType,
						JSON.parse(rawStages.get(source.event_id)!.payload),
						evidence,
						{
							binding: input.binding,
							enabled: storeLeadTokenSavingsEnabled({ store }, PROJECT),
							categoryEnabled: storeLeadStageChangedAuditEnabled(
								{ store },
								PROJECT,
							),
							projection: JSON.parse(input.payload),
						},
					),
				});
			}
			return originalNotification(input);
		});
	const records: Array<Record<string, unknown>> = [];
	const batches: Array<{
		batchId: string;
		memberIds: string[];
		memberContentSha256: string[];
		acceptedAt: string;
		payloadSha256: string;
		receiptStatus: string;
	}> = [];
	const inboxPath = join(directory, "claude", "inbox.json");
	const sidecarPath = join(directory, "claude", "receipts.json");
	mkdirSync(join(directory, "claude"));
	const concrete = new ClaudeLeadDeliveryAdapter({ inboxPath, sidecarPath });
	try {
		let now = new Date(iso(inputs[0]!.created_at));
		let batchOrdinal = 0;
		const loop = new LeadInboxLoop({
			queue,
			leadId: LEAD,
			ownerEpoch: `isolated-replay-${world}`,
			hasLiveSession: () => false,
			handleProtocol: async () => ({ disposition: "not_expected" }),
			now: () => now,
			queueConfig: () => DEFAULT_MAILBOX_QUEUE_CONFIG,
			batchIdFactory: () =>
				`replay-${world}-${String(++batchOrdinal).padStart(4, "0")}`,
			adapter: {
				deliverBatch: async (batch: LeadDeliveryBatch) => {
					const receipt = await concrete.deliverBatch(batch);
					batches.push({
						batchId: batch.batchId,
						memberIds: batch.members.map((member) => member.deliveryId),
						memberContentSha256: batch.members.map((member) =>
							hash(member.content),
						),
						acceptedAt: now.toISOString(),
						payloadSha256: hash(batch.modelPayload),
						receiptStatus: receipt.status,
					});
					return receipt;
				},
			},
			markAuditDelivered: (row) => {
				if (row.source_ref)
					store.markLeadEventDelivered(Number(row.source_ref));
			},
		});
		for (const [ordinal, input] of inputs.entries()) {
			source = input;
			const projection = JSON.parse(input.payload) as Record<string, unknown>;
			const currentTime = iso(input.created_at);
			now = new Date(currentTime);
			vi.setSystemTime(now);
			const raw = rawStages.get(input.event_id);
			const priorSeq = Number(
				(
					sql
						.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM lead_events")
						.get() as { n: number }
				).n,
			);
			let path: string;
			let ingressAdaptation: Record<string, unknown> | null = null;
			if (
				input.event_type === "stage_changed" ||
				input.event_type === "session_started"
			) {
				const executionId = String(projection.execution_id);
				const issueId = String(projection.issue_id);
				const direct = index[ordinal]!.producerRaw.directCandidates[0];
				// Only exported display/action fields are restored. No workflow node,
				// dispatch purpose, reviewer, obligation closure or alert is synthesized.
				store.upsertSession({
					execution_id: executionId,
					issue_id: issueId,
					project_name: PROJECT,
					status: "running",
					issue_identifier: String(projection.issue_identifier ?? issueId),
					issue_title:
						typeof projection.issue_title === "string"
							? projection.issue_title
							: undefined,
					summary:
						typeof projection.summary === "string"
							? projection.summary
							: undefined,
					decision_route:
						typeof projection.decision_route === "string"
							? projection.decision_route
							: undefined,
					session_role:
						typeof projection.session_role === "string"
							? projection.session_role
							: "main",
					started_at: direct?.sourceAt,
				});
				if (input.event_type === "stage_changed") {
					expect(raw).toBeDefined();
					ingressAdaptation = {
						originalRenderedProjection: projection,
						missingAuthority: index[ordinal]!.unresolved,
					};
					const response = await fetch(url, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: "Bearer replay-local-only",
						},
						body: JSON.stringify({
							event_id: input.event_id,
							execution_id: executionId,
							issue_id: issueId,
							project_name: PROJECT,
							event_type: "stage_changed",
							source: raw!.source,
							payload: JSON.parse(raw!.payload),
						}),
					});
					expect(response.status).toBe(200);
					path = "actual_http_stage_producer_original_ingress";
				} else {
					expect(direct?.rawPayloadAvailable).toBe(false);
					const envelope: EventEnvelope = {
						executionId,
						issueId,
						projectName: PROJECT,
						issueIdentifier: String(projection.issue_identifier ?? issueId),
						issueTitle:
							typeof projection.issue_title === "string"
								? projection.issue_title
								: undefined,
						sessionRole:
							typeof projection.session_role === "string"
								? projection.session_role
								: undefined,
					};
					await sink.emitStarted(envelope);
					await sink.flush();
					path =
						"actual_DirectEventSink_emitStarted_flush_identity_and_display_only_unknown_dispatch";
				}
			} else {
				// Missing raw monitoring/replacement input cannot manufacture a probe,
				// episode or schedule. Preserve the canonical row as a model candidate.
				const disposition =
					world === "A" ? input.delivery_disposition : "model";
				const seq = store.appendLeadEvent(
					LEAD,
					input.event_id,
					input.event_type,
					input.payload,
					input.session_key,
					disposition,
				);
				if (disposition === "model")
					await registry.dispatchLeadEvent({
						eventId: input.event_id,
						seq,
						event: {
							...projection,
							event_type: input.event_type,
						} as unknown as LeadEventEnvelope["event"],
						sessionKey: input.session_key,
						leadId: LEAD,
						timestamp: currentTime,
					});
				path = "canonical_journal_ingress_raw_producer_unavailable";
			}
			const added = sql
				.prepare("SELECT seq FROM lead_events WHERE seq>? ORDER BY seq")
				.all(priorSeq) as { seq: number }[];
			expect(added, `one canonical lead row for input ${ordinal}`).toHaveLength(
				1,
			);
			const row = store.getLeadEventBySeq(added[0]!.seq)!;
			const event = JSON.parse(row.payload) as LeadEventEnvelope["event"];
			const deliveryId = canonicalLeadEventDeliveryId({
				eventId: row.event_id,
				seq: row.seq,
				event,
				sessionKey: input.session_key,
				leadId: LEAD,
				timestamp: currentTime,
			});
			const membership = queue.getById(deliveryId);
			expect(Boolean(membership)).toBe(row.delivery_disposition === "model");
			if (row.delivery_disposition === "audit_only") {
				expect(row.delivered_at).toBeUndefined();
				expect(row.acked_at).toBeUndefined();
			}
			const session =
				typeof projection.execution_id === "string"
					? store.getSession(projection.execution_id)
					: undefined;
			records.push({
				inputIndex: ordinal,
				originalEventId: input.event_id,
				originalSeq: input.seq,
				originalCreatedAt: input.created_at,
				eventType: input.event_type,
				eventId: row.event_id,
				seq: row.seq,
				producerPath: path,
				originalRawEventId:
					raw?.event_id ??
					index[ordinal]!.producerRaw.directCandidates[0]?.eventId ??
					null,
				originalRawPayloadSha256: raw ? hash(raw.payload) : null,
				originalProjectionSha256: hash(input.payload),
				historicalEvidenceMetadata: ingressAdaptation,
				beforeDisposition: input.delivery_disposition,
				afterDisposition: row.delivery_disposition,
				proofRef: row.notification_proof_ref ?? null,
				reason:
					row.notification_reason ??
					(world === "A"
						? "observed_source_journal_disposition"
						: "raw_producer_unavailable_conservative_model"),
				unresolved: TARGETS.has(input.event_type)
					? index[ordinal]!.unresolved
					: [],
				deliveryId: membership ? deliveryId : null,
				enqueuedAt: enqueuedAt.get(deliveryId) ?? null,
				actionableEnqueueLatencyMs: membership
					? Date.parse(enqueuedAt.get(deliveryId)!) - Date.parse(currentTime)
					: null,
				businessSideEffectSha256: hash({
					rawStage: raw ? JSON.parse(raw.payload) : null,
					session: session
						? {
								executionId: session.execution_id,
								issueId: session.issue_id,
								projectName: session.project_name,
								status: session.status,
								stage: session.session_stage,
							}
						: null,
				}),
				batchId: null,
				adapterWakeRequestId: null,
				observedModelTurnIdentity: null,
			});
			// Same-second exported inputs share an inbox tick.
			// Never count an end-of-window backlog drain as a wake timeline.
			if (inputs[ordinal + 1]?.created_at !== input.created_at) {
				for (
					let tick = 0;
					tick < 257 &&
					batches.reduce((sum, batch) => sum + batch.memberIds.length, 0) <
						records.filter((record) => record.deliveryId !== null).length;
					tick++
				) {
					const firstNewBatch = batches.length;
					const result = await loop.tick();
					expect(result.ok).toBe(true);
					expect(
						result.modelConsumed,
						"deterministic ready queue must make progress",
					).toBeGreaterThan(0);
					// Synthetic healthy recipient: settle only the model batches just
					// submitted, so advancing history does not manufacture lease retries.
					// This is a harness assumption, not observed model consumption.
					for (const batch of batches.slice(firstNewBatch)) {
						expect(
							queue.ackBatchByRecipient({
								batchId: batch.batchId.replace(/#r\d+$/, ""),
								fromAgent: LEAD,
								now: now.toISOString(),
							}),
						).toBe("applied");
					}
				}
			}
		}
		const expectedMembers = records.filter(
			(record) => record.deliveryId !== null,
		).length;
		const actualIds = batches.flatMap((batch) => batch.memberIds);
		expect(new Set(actualIds).size).toBe(expectedMembers);
		const inbox = readFileSync(inboxPath, "utf8");
		const transportReceipts = readFileSync(sidecarPath, "utf8");
		expect(
			(JSON.parse(inbox) as Array<{ text: string }>).map((member) =>
				hash(member.text),
			),
		).toEqual(batches.flatMap((batch) => batch.memberContentSha256));
		for (const record of records) {
			if (!record.deliveryId) continue;
			const transportDeliveryId = `${record.deliveryId}#r0`;
			const batch = batches.find((candidate) =>
				candidate.memberIds.includes(transportDeliveryId),
			)!;
			expect(batch).toBeDefined();
			expect(transportReceipts).toContain(transportDeliveryId);
			record.transportDeliveryId = transportDeliveryId;
			record.batchId = batch.batchId;
			record.adapterWakeRequestId = `claude-mailbox-submit:${batch.batchId}`;
		}
		return {
			world,
			policy:
				world === "A"
					? "source_observed_disposition_at_append_boundary_not_historical_binary"
					: world === "B"
						? "v2_on_conservative_unknown_historical_authority"
						: "v2_off_new_events",
			counts: {
				input_events: records.length,
				model_candidates: expectedMembers,
				accepted_batches: batches.length,
				adapter_wake_requests: batches.length,
				observed_model_turns: null,
				actionable_latency: {
					metric: "enqueue_latency_ms_in_deterministic_input_tick",
					max: Math.max(
						...records
							.filter((record) => record.deliveryId)
							.map((record) => Number(record.actionableEnqueueLatencyMs)),
					),
				},
				unresolved_target_inputs: records.filter(
					(record) => (record.unresolved as string[]).length > 0,
				).length,
			},
			producerCalls: {
				http_stage: 80,
				DirectEventSink_emitStarted_flush: 21,
				canonicalJournalMissingRaw: 156,
			},
			records,
			batches,
		};
	} finally {
		sourcePolicy?.mockRestore();
		await sink.flush();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		queue.close();
		store.close();
		if (previousCommDir === undefined) delete process.env.FLYWHEEL_COMM_DIR;
		else process.env.FLYWHEEL_COMM_DIR = previousCommDir;
		rmSync(directory, { recursive: true, force: true });
	}
}

it("replays every source through isolated producer/store/queue/concrete adapter worlds without inventing authority", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	const transportedStagePayloads: Array<{ eventId: string; payload: unknown }> =
		[];
	const originalFetch = globalThis.fetch;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
		const event = JSON.parse(String(init?.body));
		transportedStagePayloads.push({
			eventId: event.event_id,
			payload: event.payload,
		});
		return originalFetch(url, init);
	});
	const worlds = [];
	for (const world of ["A", "B", "C"] as const)
		worlds.push(await replay(world));
	for (const sent of transportedStagePayloads)
		expect(
			sent.payload,
			`unaltered historical ingress ${sent.eventId}`,
		).toEqual(JSON.parse(rawStages.get(sent.eventId)!.payload));
	for (const world of worlds) {
		expect(
			new Set(world.batches.map((batch) => batch.acceptedAt)).size,
		).toBeGreaterThan(1);
		for (const record of world.records) {
			if (!record.deliveryId) continue;
			const batch = world.batches.find(
				(item) => item.batchId === record.batchId,
			)!;
			expect(Date.parse(batch.acceptedAt)).toBe(
				Date.parse(iso(String(record.originalCreatedAt))),
			);
		}
	}
	expect(worlds.map((world) => world.counts.input_events)).toEqual([
		257, 257, 257,
	]);
	expect(worlds[0]!.counts.model_candidates).toBe(169);
	expect(worlds[1]!.counts.model_candidates).toBe(257);
	expect(worlds[2]!.counts.model_candidates).toBe(257);
	const [baseline, enabled, disabled] = worlds;
	expect(enabled!.records.map((row) => row.eventId)).toEqual(
		disabled!.records.map((row) => row.eventId),
	);
	expect(enabled!.records.map((row) => row.businessSideEffectSha256)).toEqual(
		disabled!.records.map((row) => row.businessSideEffectSha256),
	);
	for (const [ordinal, before] of baseline!.records.entries()) {
		if (before.afterDisposition !== "model") continue;
		expect(enabled!.records[ordinal]!.afterDisposition).toBe("model");
		expect(enabled!.records[ordinal]!.actionableEnqueueLatencyMs).toBe(
			before.actionableEnqueueLatencyMs,
		);
	}

	const carrier = JSON.parse(
		readFileSync(join(EVIDENCE, "carrier-observation.json"), "utf8"),
	) as {
		inputTimeline: Array<{
			uuid: string;
			timestamp: string;
			sourceEventSeqs: number[];
		}>;
	};
	const bindingRows = jsonl<{
		execution_id: string;
		bound_at: string;
		mode: string;
		attempt: number;
	}>("execution-binding-v3.jsonl");
	const sourceBySeq = new Map(inputs.map((input) => [input.seq, input]));
	const enabledBySeq = new Map(
		enabled!.records.map((row) => [row.originalSeq, row]),
	);
	const observedCohorts = carrier.inputTimeline.map((input) => {
		const matched = input.sourceEventSeqs
			.map((seq) => sourceBySeq.get(seq))
			.filter((row): row is Input => !!row);
		const completeSourceJoin =
			matched.length > 0 && matched.length === input.sourceEventSeqs.length;
		// This is only a ceiling: type/binding alone does not prove quiet eligibility.
		const onlyPotentialQuietTypes =
			completeSourceJoin &&
			matched.every(
				(row) =>
					row.event_type === "stage_changed" ||
					row.event_type === "session_started",
			);
		const temporallyBoundCandidate =
			onlyPotentialQuietTypes &&
			matched.every((row) => {
				const payload = JSON.parse(row.payload);
				return bindingRows.some(
					(binding) =>
						binding.execution_id === payload.execution_id &&
						Date.parse(binding.bound_at) <= Date.parse(iso(row.created_at)) &&
						(row.event_type !== "session_started" ||
							(binding.mode === "spawn" && binding.attempt === 1)),
				);
			});
		const retainedByConservativeReplay =
			!completeSourceJoin ||
			matched.some(
				(row) => enabledBySeq.get(row.seq)?.afterDisposition !== "audit_only",
			);
		return {
			inputId: input.uuid,
			at: input.timestamp,
			sourceSeqs: input.sourceEventSeqs,
			matchedWindowSeqs: matched.map((row) => row.seq),
			completeSourceJoin,
			onlyPotentialQuietTypes,
			temporallyBoundCandidate,
			retainedByConservativeReplay,
		};
	});
	expect(observedCohorts).toHaveLength(99);
	expect(
		observedCohorts.filter((row) => !row.matchedWindowSeqs.length),
	).toHaveLength(32);
	expect(
		observedCohorts.filter((row) => row.onlyPotentialQuietTypes),
	).toHaveLength(12);
	expect(
		observedCohorts.filter((row) => row.temporallyBoundCandidate),
	).toHaveLength(7);
	for (const cohort of observedCohorts.filter((row) => !row.completeSourceJoin))
		expect(cohort.retainedByConservativeReplay).toBe(true);
	const observedInputAnalysis = {
		metric: "historical consumed user inputs, not sleep-to-awake transitions",
		beforeObserved: observedCohorts.length,
		afterObserved: null,
		conservativeRetainedOriginalCohorts: observedCohorts.filter(
			(row) => row.retainedByConservativeReplay,
		).length,
		noWindowSourceJoin: 32,
		conditionalEstimateRetainedOriginalCohorts: observedCohorts.filter(
			(row) => !row.temporallyBoundCandidate,
		).length,
		optimisticFloorRetainedOriginalCohorts: observedCohorts.filter(
			(row) => !row.onlyPotentialQuietTypes,
		).length,
		newModelEventsNotPresentInBaseline: enabled!.records
			.filter(
				(row) =>
					row.beforeDisposition === "audit_only" &&
					row.afterDisposition === "model",
			)
			.map((row) => ({
				seq: row.originalSeq,
				at: row.originalCreatedAt,
				reason: row.reason,
				unresolved: row.unresolved,
			})),
		limitations: [
			"99 is observed historical consumed inputs. Counterfactual cohort counts hold the original input membership/timing fixed and exclude new model events; they are not a net after-wake total.",
			"92 is conditional on all missing startup/owner/action proofs becoming available for the seven structurally bound cohorts; 87 ignores authority for all twelve target-only cohorts. Neither number is measured savings.",
			"Unknown/unjoined traffic stays present. Newly immediate events and counterfactual carrier busy/idle timing prevent computing a production after-wake count.",
		],
		cohorts: observedCohorts,
	};
	const result = {
		schemaVersion: 2,
		scope: "chronological_source_tick_replay_with_explicit_historical_gaps",
		windowUtc: ["2026-09-26T01:30:00Z", "2026-09-26T04:00:00Z"],
		project: PROJECT,
		lead: LEAD,
		fixtureManifestSha256: hash(
			readFileSync(join(FIXTURE, "manifest.json"), "utf8"),
		),
		acceptance: {
			complete: false,
			reason:
				"Historical temporal authority is missing; conservative model retention is neither savings evidence nor a demonstrated production behavior regression. Real model consumption is not exercised by a durable mailbox adapter receipt.",
		},
		assumptions: [
			"Same 257 ordered inputs; separate shared temporary DB per world; Date follows each original input timestamp.",
			"No workflow dispatch purpose, historical reviewer, pending-action closure, probe episode, or carrier busy/idle state is fabricated.",
			"Stage ingress is exactly the exported raw payload. Historical obligation state is absent from the export: at appendLeadNotification the replay replaces the synthetic session proof action with unknown and re-runs the real policy. This explicit proof-boundary substitution prevents treating an empty fixture database as evidence of no historical tasks; no field is added to the ingress.",
			"Direct startup uses emitStarted+flush and known identities/display fields; unknown workflow identity uses stable set-once source started_at fallback, with original IDs retained.",
			"World A carries recorded source dispositions at the producer append boundary; it does not execute a missing historical binary.",
			"All model rows enter the durable queue on their input tick. Same-second inputs share a tick, drained immediately with default batching and the concrete Claude mailbox adapter. The assumed carrier is always idle: these are chronological submissions, not historical busy/idle transitions.",
			"adapter_wake_requests counts actual deliverBatch invocations, not physical wakes or model rounds; observed_model_turns remains null.",
			"A synthetic healthy recipient ACKs submitted model batches within each input tick to exclude invented lease-expiry retries. Audit-only rows receive no ACK. This assumption is identical in all worlds and is not a real carrier receipt.",
			"156 inputs lack raw producer ingress and use canonical journal ingress. Synthetic producer-positive tests remain outside the 257 denominator.",
			"Canonical journal ingress uses the authoritative outer event_type column when it is absent from the rendered payload; original payload hashes remain unchanged.",
		],
		historicalCarrierEvidence:
			"engineering/doc/FLY-2912-quiet-notification-expansion/evidence/carrier-observation.json",
		observedInputAnalysis,
		worlds,
	};
	if (process.env.FLY2912_WRITE_REPLAY_RESULT === "1")
		writeFileSync(
			join(EVIDENCE, "replay-result.json"),
			`${JSON.stringify(result, null, 2)}\n`,
		);
}, 180_000);
