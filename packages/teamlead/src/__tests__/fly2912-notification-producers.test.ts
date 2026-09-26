import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type BetterSqlite3 from "better-sqlite3";
import type { EventEnvelope } from "flywheel-edge-worker";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventFilter } from "../bridge/EventFilter.js";
import type { RuntimeRegistry } from "../bridge/runtime-registry.js";
import type { BridgeConfig } from "../bridge/types.js";
import { DirectEventSink } from "../DirectEventSink.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";
import {
	legacyWorkflowSeeds,
	pinLegacyWorkflowSeedAgents,
} from "./fixtures/legacy-workflow-manifests.js";

const disposers: Array<() => void> = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const dispose of disposers.splice(0)) dispose();
});
const WORKFLOW_ON = {
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
};
const envelope: EventEnvelope = {
	executionId: "exec-start",
	issueId: "FLY-2912-test",
	projectName: "flywheel",
	issueIdentifier: "FLY-2912-test",
	runnerBackend: "codex-tmux",
	docTier: "full",
	codexSkip: false,
};
const lead = {
	agentId: "test-lead",
	chatChannel: "test-channel",
	match: { labels: [] },
};
const projects = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/fly2912",
		projectRepo: "test/test",
		leads: [lead],
	},
] as ProjectEntry[];
function setFlag(store: StateStore, enabled: boolean) {
	expect(
		store.applyScopedFlagValueChange({
			name: "lead_token_savings",
			scope: "flywheel",
			op: "set",
			rawTo: enabled ? "1" : "0",
			expectedChangeSeq: store.getFlagValueChangeSeq(
				"lead_token_savings",
				"flywheel",
			),
			actor: "test",
			reason: "notification producer test",
		}).ok,
	).toBe(true);
}
async function harness(
	enabled = true,
	registryPresent = true,
	configOverrides: Partial<BridgeConfig> = {},
	entryKind = true,
) {
	const dir = mkdtempSync(join(tmpdir(), "fly2912-start-"));
	const store = await StateStore.create(join(dir, "state.db"));
	disposers.push(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	setFlag(store, enabled);
	const seed = pinLegacyWorkflowSeedAgents(
		legacyWorkflowSeeds().find((item) => item.templateId === "tpl_eng_heavy")!,
	);
	store.importWorkflowTemplateSeed(seed);
	store.materializeWorkflowRun({
		...(entryKind ? { entryKind: "pipeline_dag_v1" as const } : {}),
		canonicalRoot: fileURLToPath(new URL("../../../../", import.meta.url)),
		runId: "run-start",
		issueId: envelope.issueId,
		projectName: envelope.projectName,
		taskCategory: "code",
		templateId: seed.templateId,
		claimsReadEnrolled: true,
		actor: "test-lead",
		env: WORKFLOW_ON,
		startReservation: {
			idempotencyKey: "start",
			selectionDigest: "selection",
			nodeId: "design",
			attempt: 1,
			executionId: envelope.executionId,
			createdAt: "2026-09-26T04:00:00.000Z",
		},
	});
	expect(
		store.admitGeneralizedWorkflowExecution({
			runId: "run-start",
			nodeId: "design",
			executionId: envelope.executionId,
			attempt: 1,
			now: "2026-09-26T04:00:00.000Z",
			expiresAt: "2026-09-26T08:00:00.000Z",
			absoluteDeadlineAt: "2026-09-27T04:00:00.000Z",
			env: WORKFLOW_ON,
		}),
	).toMatchObject({ ok: true });
	const dispatch = vi.fn(async () => ({ delivered: true }));
	const registry = {
		resolveWithLead: () => ({ lead, runtime: {} }),
		dispatchLeadEvent: dispatch,
	} as unknown as RuntimeRegistry;
	const config = {
		chatThreadsEnabled: false,
		...configOverrides,
	} as BridgeConfig;
	const sink = new DirectEventSink(
		store,
		config,
		projects,
		new EventFilter(),
		registryPresent ? registry : undefined,
	);
	const rows = () =>
		(
			(store as unknown as { db: { raw: BetterSqlite3.Database } }).db.raw
				.prepare("SELECT seq FROM lead_events WHERE lead_id=? ORDER BY seq")
				.all("test-lead") as { seq: number }[]
		).map((row) => store.getLeadEventBySeq(row.seq)!);
	return { store, sink, dispatch, rows, config };
}

describe("FLY-2912 DirectEventSink startup", () => {
	it("records pure initial startup with proof, no adapter or fake delivery receipt", async () => {
		const { store, sink, dispatch, rows } = await harness();
		await sink.emitStarted(envelope);
		await sink.flush();
		expect(store.getSession(envelope.executionId)?.status).toBe("running");
		expect(rows()).toHaveLength(1);
		expect(rows()[0]).toMatchObject({
			delivery_disposition: "audit_only",
			notification_policy_version: "notification-v2",
			notification_reason: "startup_notice",
		});
		expect(rows()[0].delivered_at).toBeUndefined();
		expect(rows()[0].acked_at).toBeUndefined();
		expect(dispatch).not.toHaveBeenCalled();
		expect(
			store
				.getEventsByExecution(envelope.executionId)
				.filter((event) => event.event_type === "lead_notification_proof"),
		).toHaveLength(1);
	});
	it("keeps a registration with missing dispatch intent immediate", async () => {
		const { sink, dispatch } = await harness(true, true, {}, false);
		await sink.emitStarted(envelope);
		await sink.flush();
		expect(dispatch).toHaveBeenCalledOnce();
	});

	it("evidence read failures preserve registered startup delivery", async () => {
		const { store, sink, dispatch } = await harness();
		vi.spyOn(store, "listWorkflowSideEffects").mockImplementation(() => {
			throw new Error("evidence unavailable");
		});
		await sink.emitStarted(envelope);
		await sink.flush();
		expect(dispatch).toHaveBeenCalledOnce();
	});

	it("never quiets against a conflicting preexisting proof row", async () => {
		const { store, sink, dispatch, rows } = await harness();
		store.insertEvent({
			event_id:
				"direct-started:exec-start:activation:exec-start:run-start:design:1:proof",
			execution_id: envelope.executionId,
			issue_id: envelope.issueId,
			project_name: envelope.projectName,
			event_type: "lead_notification_proof",
			source: "runner",
			payload: { kind: "startup" },
		});
		await sink.emitStarted(envelope);
		await sink.flush();
		expect(dispatch).toHaveBeenCalledOnce();
		expect(rows()[0]).toMatchObject({
			delivery_disposition: "model",
			notification_reason: "proof_record_conflict",
		});
	});

	it("OFF preserves new startup delivery", async () => {
		const { sink, dispatch, rows } = await harness(false);
		await sink.emitStarted(envelope);
		await sink.flush();
		expect(dispatch).toHaveBeenCalledOnce();
		expect(rows()[0].delivery_disposition).toBe("model");
	});
	it.each([{ retryPredecessor: "prior" }, { runAttempt: 2 }])(
		"keeps handoff startup immediate: %j",
		async (extra) => {
			const { sink, dispatch } = await harness();
			await sink.emitStarted({ ...envelope, ...extra });
			await sink.flush();
			expect(dispatch).toHaveBeenCalledOnce();
		},
	);
	it("keeps arbitrary summary and failed thread setup immediate", async () => {
		const { store, sink, dispatch } = await harness(true, true, {
			chatThreadsEnabled: true,
		});
		store.upsertSession({
			execution_id: envelope.executionId,
			issue_id: envelope.issueId,
			project_name: envelope.projectName,
			status: "running",
			summary: "FYI can you reply?",
		});
		await sink.emitStarted(envelope);
		await sink.flush();
		expect(dispatch).toHaveBeenCalledOnce();
	});
	it("deduplicates the same activation across sink instances and ON to OFF", async () => {
		const { store, sink, dispatch, rows, config } = await harness();
		await sink.emitStarted(envelope);
		await sink.flush();
		setFlag(store, false);
		const registry = {
			resolveWithLead: () => ({ lead, runtime: {} }),
			dispatchLeadEvent: dispatch,
		} as unknown as RuntimeRegistry;
		const resumed = new DirectEventSink(
			store,
			config,
			projects,
			new EventFilter(),
			registry,
		);
		await resumed.emitStarted(envelope);
		await resumed.flush();
		expect(rows()).toHaveLength(1);
		expect(dispatch).not.toHaveBeenCalled();
	});
	it("records quiet startup without registry but preserves OFF absence", async () => {
		const on = await harness(true, false);
		await on.sink.emitStarted(envelope);
		await on.sink.flush();
		expect(on.rows()).toHaveLength(1);
		const off = await harness(false, false);
		await off.sink.emitStarted(envelope);
		await off.sink.flush();
		expect(off.rows()).toHaveLength(0);
	});
	it("retains an actionable ON startup as pending when the registry is unavailable", async () => {
		const { sink, rows, dispatch } = await harness(true, false, {}, false);
		await sink.emitStarted(envelope);
		await sink.flush();
		expect(rows()).toHaveLength(1);
		expect(rows()[0]).toMatchObject({ delivery_disposition: "model" });
		expect(rows()[0]?.delivered_at).toBeUndefined();
		expect(dispatch).not.toHaveBeenCalled();
	});
	it("retains failed try-body diagnostics while finally still delivers", async () => {
		const { sink, dispatch } = await harness();
		vi.spyOn(
			sink as unknown as { persistProofShotConfig: () => void },
			"persistProofShotConfig",
		).mockImplementation(() => {
			throw new Error("proofshot failure");
		});
		await expect(sink.emitStarted(envelope)).rejects.toThrow(
			"proofshot failure",
		);
		await sink.flush();
		expect(dispatch).toHaveBeenCalledOnce();
	});
	it("preserves upsert failure before finally without inventing a notification", async () => {
		const { store, sink, dispatch, rows } = await harness();
		vi.spyOn(store, "upsertSession").mockImplementation(() => {
			throw new Error("registration failed");
		});
		await expect(sink.emitStarted(envelope)).rejects.toThrow(
			"registration failed",
		);
		await sink.flush();
		expect(dispatch).not.toHaveBeenCalled();
		expect(rows()).toHaveLength(0);
	});
});
