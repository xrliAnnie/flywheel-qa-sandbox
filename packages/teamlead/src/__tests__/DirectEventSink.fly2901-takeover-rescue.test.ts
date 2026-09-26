/**
 * FLY-2901 §4.0 / §4.5: DirectEventSink is the Bridge-local authority for the
 * two checked takeover-rescue workflow events. The WorktreeManager transaction
 * awaits these methods; a throw stops the takeover before any destructive step,
 * so every guard here (run binding, strict payload shape, cross-check against
 * the recorded rescue) is a hard gate rather than a best-effort warning.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type EventEnvelope,
	TAKEOVER_CLEANED_EVENT_KIND,
	TAKEOVER_RESCUE_SCHEMA,
	TAKEOVER_RESCUED_EVENT_KIND,
	type TakeoverCleanedEventPayload,
	type TakeoverRescueEventPayload,
	takeoverCleanedEventUid,
	takeoverRescueEventUid,
} from "flywheel-edge-worker";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../bridge/types.js";
import {
	DirectEventSink,
	type TakeoverRescuedAlertHook,
} from "../DirectEventSink.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";
import { buildWorkflowRunSnapshotV2 } from "../workflow-run-snapshot.js";

const testProjects = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/flywheel-fly2901",
		leads: [],
	},
] as unknown as ProjectEntry[];

const testConfig = {
	host: "127.0.0.1",
	port: 0,
	dbPath: ":memory:",
	ingestToken: "ingest-secret",
	notificationChannel: "test-channel",
	defaultLeadAgentId: "lead",
	stuckThresholdMinutes: 15,
	stuckCheckIntervalMs: 300000,
	orphanThresholdMinutes: 60,
	discordBotToken: "bot-token",
} as unknown as BridgeConfig;

const WORKFLOW_ON = {
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
};

const EXEC = "exec-1";
const RUN_ID = `run-${EXEC}`;
const NODE_ID = "execute";
const CANONICAL_PATH = "/tmp/flywheel-fly2901/worktrees/flywheel-FLY-2901";
const OTHER_PATH = "/tmp/flywheel-fly2901/worktrees/flywheel-FLY-2902";
const TARGET = "a".repeat(40);
const TIP = "b".repeat(40);
const MANIFEST_SHA = "c".repeat(64);

const env: EventEnvelope = {
	executionId: EXEC,
	issueId: "FLY-2901",
	projectName: "flywheel",
};

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.restoreAllMocks();
});

/** Bind `executionId` to a v2 workflow run node so the run id resolves. */
function bindGeneralizedExecution(
	store: StateStore,
	executionId: string,
): void {
	const root = mkdtempSync(join(tmpdir(), "fly2901-sink-agents-"));
	mkdirSync(join(root, "agents"));
	writeFileSync(join(root, "agents", "generic.md"), "Execute.\n");
	const snapshot = buildWorkflowRunSnapshotV2({
		template: { id: "test", revision: 1 },
		canonicalRoot: root,
		manifest: {
			schema_version: 2,
			nodes: [
				{
					id: NODE_ID,
					type: "generic",
					vendor: "codex",
					model: "gpt-5.6-sol",
					effort: "low",
					agent_file: "agents/generic.md",
				},
				{ id: "founder_gate", type: "gate" },
			],
			edges: [
				{
					id: "done",
					from: NODE_ID,
					to: "founder_gate",
					condition: "node_done",
				},
			],
			loops: [],
			terminal_gate: {
				node: "founder_gate",
				predicate: "founder_approved",
			},
			ship_claims: ["founder_approved"],
		},
	});
	rmSync(root, { recursive: true, force: true });
	store.createWorkflowRun({
		runId: `run-${executionId}`,
		issueId: "FLY-2901",
		projectName: "flywheel",
		snapshotJson: JSON.stringify(snapshot),
		claimsReadEnrolled: false,
	});
	expect(
		store.admitGeneralizedWorkflowExecution({
			runId: `run-${executionId}`,
			nodeId: NODE_ID,
			executionId,
			attempt: 1,
			now: "2026-09-25T00:00:00.000Z",
			expiresAt: "2026-09-25T00:05:00.000Z",
			absoluteDeadlineAt: "2026-09-25T01:00:00.000Z",
			env: WORKFLOW_ON,
		}),
	).toMatchObject({ ok: true });
	store.upsertSession({
		execution_id: executionId,
		issue_id: "FLY-2901",
		project_name: "flywheel",
		status: "running",
		issue_identifier: "FLY-2901",
	});
}

async function harness() {
	const dir = mkdtempSync(join(tmpdir(), "fly2901-sink-"));
	const dbPath = join(dir, "state.db");
	const store = await StateStore.create(dbPath);
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		store.close();
	};
	cleanups.push(() => {
		close();
		rmSync(dir, { recursive: true, force: true });
	});
	bindGeneralizedExecution(store, EXEC);
	const sink = new DirectEventSink(store, testConfig, testProjects);
	return { store, sink, dbPath, close };
}

function rescuePayload(
	overrides: Partial<TakeoverRescueEventPayload> = {},
): TakeoverRescueEventPayload {
	return {
		schema: TAKEOVER_RESCUE_SCHEMA,
		runId: RUN_ID,
		successorExec: EXEC,
		manifestPath:
			"/tmp/flywheel-fly2901/state/takeover-rescue/run/exec/stamp/manifest.json",
		manifestSha256: MANIFEST_SHA,
		canonicalPath: CANONICAL_PATH,
		branch: "flywheel-FLY-2901",
		generationBefore: "gen-1",
		class: "dirty",
		target: TARGET,
		fingerprint3: "fp3",
		rescues: [
			{
				kind: "dirty",
				localRef: `refs/flywheel/rescue/${RUN_ID}/pred/${EXEC}/stamp/dirty`,
				remoteBranch: "flywheel-rescue/FLY-2901/pred8-succ8-stamp-dirty",
				tip: TIP,
			},
		],
		nestedMoves: [],
		...overrides,
	};
}

function rescueUid(payload: TakeoverRescueEventPayload): string {
	return takeoverRescueEventUid({
		runId: payload.runId,
		successorExec: payload.successorExec,
		// The producer includes every preserved tip (the target too), so the
		// sink must not recompute the UID from rescue refs alone.
		tips: [...payload.rescues.map((rescue) => rescue.tip), payload.target],
		target: payload.target,
	});
}

function cleanedPayload(
	rescueEventUid: string,
	rescue: TakeoverRescueEventPayload,
	overrides: Partial<TakeoverCleanedEventPayload> = {},
): TakeoverCleanedEventPayload {
	return {
		schema: TAKEOVER_RESCUE_SCHEMA,
		rescueEventUid,
		manifestSha256: rescue.manifestSha256,
		canonicalPath: rescue.canonicalPath,
		target: rescue.target,
		generationAfter: "gen-1",
		completedBy: EXEC,
		...overrides,
	};
}

async function recordRescue(
	sink: DirectEventSink,
	payload: TakeoverRescueEventPayload,
): Promise<string> {
	const eventUid = rescueUid(payload);
	await sink.recordTakeoverRescue(env, { runId: RUN_ID, eventUid, payload });
	return eventUid;
}

describe("FLY-2901 DirectEventSink takeover-rescue capability", () => {
	it("records a rescue as a checked run event and loads it back as pending", async () => {
		const { sink, store } = await harness();
		const payload = rescuePayload();
		const eventUid = await recordRescue(sink, payload);

		const pending = await sink.loadPendingTakeoverRescue(env, {
			runId: RUN_ID,
			canonicalPath: CANONICAL_PATH,
		});
		expect(pending).toEqual([{ eventUid, seq: expect.any(Number), payload }]);

		const rows = store
			.listWorkflowRunEvents(RUN_ID)
			.filter((row) => row.kind === TAKEOVER_RESCUED_EVENT_KIND);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			event_uid: eventUid,
			node_id: NODE_ID,
			execution_id: EXEC,
			payload,
		});
	});

	it("drops a rescue from pending once its cleaned event exists", async () => {
		const { sink, store } = await harness();
		const payload = rescuePayload();
		const eventUid = await recordRescue(sink, payload);
		await sink.recordTakeoverCleaned(env, {
			runId: RUN_ID,
			rescueEventUid: eventUid,
			payload: cleanedPayload(eventUid, payload),
		});

		expect(
			await sink.loadPendingTakeoverRescue(env, {
				runId: RUN_ID,
				canonicalPath: CANONICAL_PATH,
			}),
		).toEqual([]);
		const cleaned = store
			.listWorkflowRunEvents(RUN_ID)
			.find((row) => row.kind === TAKEOVER_CLEANED_EVENT_KIND);
		expect(cleaned).toMatchObject({
			event_uid: takeoverCleanedEventUid(eventUid),
			node_id: NODE_ID,
			execution_id: EXEC,
			payload: cleanedPayload(eventUid, payload),
		});
	});

	it("filters pending rescues by exact canonical path", async () => {
		const { sink } = await harness();
		await recordRescue(sink, rescuePayload());

		expect(
			await sink.loadPendingTakeoverRescue(env, {
				runId: RUN_ID,
				canonicalPath: OTHER_PATH,
			}),
		).toEqual([]);
		expect(
			await sink.loadPendingTakeoverRescue(env, {
				runId: RUN_ID,
				canonicalPath: `${CANONICAL_PATH}/`,
			}),
		).toEqual([]);
	});

	it("orders multiple pending rescues by seq", async () => {
		const { sink } = await harness();
		const first = rescuePayload();
		const second = rescuePayload({
			target: "d".repeat(40),
			manifestSha256: "e".repeat(64),
		});
		const firstUid = await recordRescue(sink, first);
		const secondUid = await recordRescue(sink, second);

		const pending = await sink.loadPendingTakeoverRescue(env, {
			runId: RUN_ID,
			canonicalPath: CANONICAL_PATH,
		});
		expect(pending.map((entry) => entry.eventUid)).toEqual([
			firstUid,
			secondUid,
		]);
		expect(pending[0]!.seq).toBeLessThan(pending[1]!.seq);
	});

	it("treats an identical replay as idempotent", async () => {
		const { sink, store } = await harness();
		const payload = rescuePayload();
		const eventUid = await recordRescue(sink, payload);
		await expect(recordRescue(sink, payload)).resolves.toBe(eventUid);

		expect(
			store
				.listWorkflowRunEvents(RUN_ID)
				.filter((row) => row.kind === TAKEOVER_RESCUED_EVENT_KIND),
		).toHaveLength(1);
	});

	it("refuses a different payload under the same event uid", async () => {
		const { sink } = await harness();
		const payload = rescuePayload();
		const eventUid = await recordRescue(sink, payload);

		await expect(
			sink.recordTakeoverRescue(env, {
				runId: RUN_ID,
				eventUid,
				payload: rescuePayload({ fingerprint3: "fp3-changed" }),
			}),
		).rejects.toThrow(`workflow_event_uid_conflict:${eventUid}`);
	});

	it("refuses every method when the runId is not the execution's bound run", async () => {
		const { sink } = await harness();
		const payload = rescuePayload({ runId: "run-foreign" });
		const eventUid = rescueUid(payload);

		await expect(
			sink.loadPendingTakeoverRescue(env, {
				runId: "run-foreign",
				canonicalPath: CANONICAL_PATH,
			}),
		).rejects.toThrow(/takeover_rescue_run_mismatch/);
		await expect(
			sink.recordTakeoverRescue(env, {
				runId: "run-foreign",
				eventUid,
				payload,
			}),
		).rejects.toThrow(/takeover_rescue_run_mismatch/);
		await expect(
			sink.recordTakeoverCleaned(env, {
				runId: "run-foreign",
				rescueEventUid: eventUid,
				payload: cleanedPayload(eventUid, payload),
			}),
		).rejects.toThrow(/takeover_rescue_run_mismatch/);

		// An execution with no workflow run at all is refused the same way.
		await expect(
			sink.loadPendingTakeoverRescue(
				{ ...env, executionId: "exec-unbound" },
				{ runId: RUN_ID, canonicalPath: CANONICAL_PATH },
			),
		).rejects.toThrow(/takeover_rescue_run_unbound/);
	});

	it("refuses a payload whose identity fields do not match the bound run/execution", async () => {
		const { sink } = await harness();
		const foreignRun = rescuePayload({ runId: "run-other" });
		await expect(
			sink.recordTakeoverRescue(env, {
				runId: RUN_ID,
				eventUid: rescueUid(foreignRun),
				payload: foreignRun,
			}),
		).rejects.toThrow(/takeover_rescue_payload_invalid:.*runId/);

		const foreignExec = rescuePayload({ successorExec: "exec-2" });
		await expect(
			sink.recordTakeoverRescue(env, {
				runId: RUN_ID,
				eventUid: rescueUid(foreignExec),
				payload: foreignExec,
			}),
		).rejects.toThrow(/takeover_rescue_payload_invalid:.*successorExec/);
	});

	it.each<[string, () => unknown, string]>([
		[
			"wrong schema",
			() => rescuePayload({ schema: "fly-2901.takeover-rescue.v0" as never }),
			"schema",
		],
		[
			"uppercase manifest sha",
			() => rescuePayload({ manifestSha256: "C".repeat(64) }),
			"manifestSha256",
		],
		["short target oid", () => rescuePayload({ target: "abc" }), "target"],
		[
			"unknown class",
			() => rescuePayload({ class: "spooky" as never }),
			"class",
		],
		[
			"relative canonical path",
			() => rescuePayload({ canonicalPath: "worktrees/x" }),
			"canonicalPath",
		],
		[
			"rescue ref with bad tip",
			() =>
				rescuePayload({
					rescues: [
						{
							kind: "head",
							localRef: "refs/flywheel/rescue/x",
							remoteBranch: "flywheel-rescue/x",
							tip: "nope",
						},
					],
				}),
			"rescues",
		],
		[
			"rescue ref with unknown kind",
			() =>
				rescuePayload({
					rescues: [
						{
							kind: "stash" as never,
							localRef: "refs/flywheel/rescue/x",
							remoteBranch: "flywheel-rescue/x",
							tip: TIP,
						},
					],
				}),
			"rescues",
		],
		[
			"nested move with unknown mode",
			() =>
				rescuePayload({
					nestedMoves: [
						{
							relPath: "vendor/x",
							source: `${CANONICAL_PATH}/vendor/x`,
							destination: "/tmp/flywheel-fly2901/state/nested/vendor/x",
							mode: "copy" as never,
							head: null,
							statusDigest: "digest",
						},
					],
				}),
			"nestedMoves",
		],
		[
			"unknown top-level key",
			() => ({ ...rescuePayload(), extra: true }),
			"extra",
		],
		["non-object payload", () => "not-a-payload", "object"],
	])("refuses a malformed rescue payload (%s)", async (_label, make, hint) => {
		const { sink, store } = await harness();
		await expect(
			sink.recordTakeoverRescue(env, {
				runId: RUN_ID,
				eventUid: rescueUid(rescuePayload()),
				payload: make() as TakeoverRescueEventPayload,
			}),
		).rejects.toThrow(new RegExp(`takeover_rescue_payload_invalid:.*${hint}`));
		expect(
			store
				.listWorkflowRunEvents(RUN_ID)
				.filter((row) => row.kind === TAKEOVER_RESCUED_EVENT_KIND),
		).toHaveLength(0);
	});

	it("refuses an event uid that is not the rescued-kind prefix plus 64 hex", async () => {
		const { sink } = await harness();
		for (const eventUid of [
			"worktree_takeover_rescued:abc",
			`worktree_takeover_cleaned:${"f".repeat(64)}`,
			`worktree_takeover_rescued:${"F".repeat(64)}`,
		]) {
			await expect(
				sink.recordTakeoverRescue(env, {
					runId: RUN_ID,
					eventUid,
					payload: rescuePayload(),
				}),
			).rejects.toThrow(/takeover_rescue_event_uid_invalid/);
		}
	});

	it("throws (does not skip) when a stored rescue payload is malformed", async () => {
		const { sink, store } = await harness();
		store.appendWorkflowRunEventChecked({
			runId: RUN_ID,
			eventUid: `worktree_takeover_rescued:${"9".repeat(64)}`,
			kind: TAKEOVER_RESCUED_EVENT_KIND,
			nodeId: NODE_ID,
			executionId: EXEC,
			payload: {
				schema: TAKEOVER_RESCUE_SCHEMA,
				canonicalPath: CANONICAL_PATH,
			},
		});

		await expect(
			sink.loadPendingTakeoverRescue(env, {
				runId: RUN_ID,
				canonicalPath: OTHER_PATH,
			}),
		).rejects.toThrow(/takeover_rescue_payload_invalid/);
	});

	it("refuses a cleaned receipt whose fields disagree with the recorded rescue", async () => {
		const { sink, store } = await harness();
		const payload = rescuePayload();
		const eventUid = await recordRescue(sink, payload);

		for (const overrides of [
			{ manifestSha256: "0".repeat(64) },
			{ canonicalPath: OTHER_PATH },
			{ target: "1".repeat(40) },
			{ rescueEventUid: `worktree_takeover_rescued:${"2".repeat(64)}` },
		] satisfies Partial<TakeoverCleanedEventPayload>[]) {
			await expect(
				sink.recordTakeoverCleaned(env, {
					runId: RUN_ID,
					rescueEventUid: eventUid,
					payload: cleanedPayload(eventUid, payload, overrides),
				}),
			).rejects.toThrow(/takeover_cleaned_mismatch/);
		}
		expect(
			store
				.listWorkflowRunEvents(RUN_ID)
				.filter((row) => row.kind === TAKEOVER_CLEANED_EVENT_KIND),
		).toHaveLength(0);
	});

	it("refuses a cleaned receipt for a rescue event that does not exist in the run", async () => {
		const { sink } = await harness();
		const payload = rescuePayload();
		const missingUid = rescueUid(payload);
		await expect(
			sink.recordTakeoverCleaned(env, {
				runId: RUN_ID,
				rescueEventUid: missingUid,
				payload: cleanedPayload(missingUid, payload),
			}),
		).rejects.toThrow(/takeover_rescue_event_missing/);
	});

	describe("Lead INFO alert after cleanup", () => {
		async function alertHarness(
			rescueClass: TakeoverRescueEventPayload["class"],
		) {
			const { sink, store } = await harness();
			const hook = vi.fn<TakeoverRescuedAlertHook>(async () => undefined);
			sink.turnBeltReconciler = {
				current: undefined,
				alertWorktreeTakeoverRescued: hook,
			};
			const payload = rescuePayload({
				class: rescueClass,
				nestedMoves:
					rescueClass === "nested_repo"
						? [
								{
									relPath: "vendor/x",
									source: `${CANONICAL_PATH}/vendor/x`,
									destination: "/tmp/flywheel-fly2901/state/nested/vendor/x",
									mode: "rename",
									head: "f".repeat(40),
									statusDigest: "digest",
								},
							]
						: [],
			});
			const eventUid = await recordRescue(sink, payload);
			const cleaned = cleanedPayload(eventUid, payload);
			const record = () =>
				sink.recordTakeoverCleaned(env, {
					runId: RUN_ID,
					rescueEventUid: eventUid,
					payload: cleaned,
				});
			return { sink, store, hook, payload, eventUid, record };
		}

		it.each(["head_diverged", "nested_repo"] as const)(
			"fires exactly once for %s and not on a deduped replay",
			async (rescueClass) => {
				const { hook, payload, eventUid, record, store } =
					await alertHarness(rescueClass);
				await record();
				expect(hook).toHaveBeenCalledOnce();
				expect(hook).toHaveBeenCalledWith({
					session: expect.objectContaining({
						execution_id: EXEC,
						issue_identifier: "FLY-2901",
					}),
					rescueEventUid: eventUid,
					rescue: payload,
				});

				await record();
				expect(hook).toHaveBeenCalledOnce();
				expect(
					store
						.listWorkflowRunEvents(RUN_ID)
						.filter((row) => row.kind === TAKEOVER_CLEANED_EVENT_KIND),
				).toHaveLength(1);
			},
		);

		it("does not fire for a dirty-class rescue", async () => {
			const { hook, record } = await alertHarness("dirty");
			await record();
			expect(hook).not.toHaveBeenCalled();
		});

		it("logs and swallows an alert-hook failure after the cleaned event landed", async () => {
			const { hook, record, store, eventUid } =
				await alertHarness("head_diverged");
			hook.mockRejectedValueOnce(new Error("discord down"));
			const errorSpy = vi
				.spyOn(console, "error")
				.mockImplementation(() => undefined);

			await expect(record()).resolves.toBeUndefined();
			expect(hook).toHaveBeenCalledOnce();
			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining("discord down"),
			);
			expect(
				store
					.listWorkflowRunEvents(RUN_ID)
					.find((row) => row.event_uid === takeoverCleanedEventUid(eventUid)),
			).toBeDefined();
		});

		it("is a silent no-op when no hook is wired", async () => {
			const { sink } = await harness();
			const payload = rescuePayload({ class: "head_diverged" });
			const eventUid = await recordRescue(sink, payload);
			await expect(
				sink.recordTakeoverCleaned(env, {
					runId: RUN_ID,
					rescueEventUid: eventUid,
					payload: cleanedPayload(eventUid, payload),
				}),
			).resolves.toBeUndefined();
		});
	});

	it("survives a Bridge restart: a new sink over the same StateStore file still sees the pending rescue", async () => {
		const { sink, dbPath, close } = await harness();
		const payload = rescuePayload();
		const eventUid = await recordRescue(sink, payload);
		close();

		const reopened = await StateStore.create(dbPath);
		cleanups.push(() => reopened.close());
		const restarted = new DirectEventSink(reopened, testConfig, testProjects);

		const pending = await restarted.loadPendingTakeoverRescue(env, {
			runId: RUN_ID,
			canonicalPath: CANONICAL_PATH,
		});
		expect(pending).toEqual([{ eventUid, seq: expect.any(Number), payload }]);

		// The re-entering dispatch closes the loop through the fresh instance.
		await restarted.recordTakeoverCleaned(env, {
			runId: RUN_ID,
			rescueEventUid: eventUid,
			payload: cleanedPayload(eventUid, payload),
		});
		expect(
			await restarted.loadPendingTakeoverRescue(env, {
				runId: RUN_ID,
				canonicalPath: CANONICAL_PATH,
			}),
		).toEqual([]);
	});
});
