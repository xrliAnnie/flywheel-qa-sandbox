import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfirmTokenStore } from "../bridge/fleet-admin.js";
import {
	type ManagementCanonicalBatch,
	ManagementChangeCoordinator,
} from "../bridge/management-change-coordinator.js";
import {
	buildTargetId,
	type ManagementTargetKind,
} from "../bridge/management-console-contract.js";
import {
	type ManagementResolvedTarget,
	type ManagementWriter,
	ManagementWriterRegistry,
	type ManagementWriterResult,
	preparedChange,
	rejectedPreflight,
} from "../bridge/management-writer.js";

const ORIGIN = "http://127.0.0.1:9931";

function fakeAudit(initialOk = true) {
	const rows: Array<Record<string, unknown>> = [];
	return {
		ok: initialOk,
		rows,
		record(row: Record<string, unknown>) {
			if (!this.ok) return false;
			rows.push(row);
			return true;
		},
	};
}

interface FakeWriter extends ManagementWriter {
	targets: Map<string, ManagementResolvedTarget>;
	applyCalls: string[];
	preflightCalls: string[];
	resultByTarget: Map<string, ManagementWriterResult>;
}

function fakeWriter(
	kind: ManagementTargetKind,
	values: Array<{
		identity: string;
		value: unknown;
		revision?: string;
		ack?: boolean;
	}>,
): FakeWriter {
	const targets = new Map<string, ManagementResolvedTarget>();
	for (const item of values) {
		const targetId = buildTargetId(kind, [item.identity]);
		targets.set(targetId, {
			targetId,
			kind,
			currentValue: item.value,
			sourceRevision: item.revision ?? `revision:${item.identity}`,
			writeCapability: {
				writable: true,
				consequence: kind === "cron" ? "reload-launchd" : "new-run",
				requiresAcknowledgement: item.ack ?? false,
			},
		});
	}
	const writer: FakeWriter = {
		id: `fake-${kind}`,
		kind,
		targets,
		applyCalls: [],
		preflightCalls: [],
		resultByTarget: new Map(),
		resolve: (targetId) => targets.get(targetId) ?? null,
		preflight: (target, desired, observed) => {
			writer.preflightCalls.push(target.targetId);
			if (observed !== target.sourceRevision) {
				return rejectedPreflight("stale_source", "stale fake source");
			}
			if (typeof desired !== "string") {
				return rejectedPreflight(
					"invalid_desired_value",
					"fake value must be string",
				);
			}
			return preparedChange({ writer, target, newValue: desired });
		},
		apply: async (change) => {
			writer.applyCalls.push(change.targetId);
			const configured = writer.resultByTarget.get(change.targetId);
			if (configured) return configured;
			const target = targets.get(change.targetId)!;
			target.currentValue = change.newValue;
			return { status: "applied" };
		},
	};
	return writer;
}

describe("unified management change coordinator", () => {
	let dir: string;
	let batchCounter: number;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "management-coordinator-"));
		batchCounter = 0;
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function coordinator(input: {
		writers: ManagementWriter[];
		audit?: ReturnType<typeof fakeAudit>;
		tokens?: ConfirmTokenStore;
		snapshotRevision?: () => string;
		reconcileAccepted?: (
			writerId: string,
			details: unknown,
		) => ManagementWriterResult | null;
	}) {
		const audit = input.audit ?? fakeAudit();
		return {
			audit,
			coordinator: new ManagementChangeCoordinator({
				registry: new ManagementWriterRegistry(input.writers),
				tokens: input.tokens ?? new ConfirmTokenStore(),
				audit: audit as never,
				journalDir: dir,
				snapshotRevision:
					input.snapshotRevision ?? (() => "snapshot:authoritative"),
				newBatchId: () => `management-batch-${++batchCounter}`,
				now: () => new Date("2026-07-14T20:00:00.000Z"),
				reconcileAccepted: input.reconcileAccepted,
			}),
		};
	}

	it("stages a deterministic server-canonical plan with zero mutations and explicit no-ops", async () => {
		const runner = fakeWriter("runner", [
			{ identity: "a", value: "old-a" },
			{ identity: "b", value: "same-b" },
		]);
		const { coordinator: c, audit } = coordinator({ writers: [runner] });
		const [a, b] = [...runner.targets.keys()];
		const result = await c.stage(
			{
				changes: [
					{
						targetId: b!,
						desiredValue: "same-b",
						observedRevision: "revision:b",
					},
					{
						targetId: a!,
						desiredValue: "new-a",
						observedRevision: "revision:a",
					},
				],
			},
			ORIGIN,
		);
		expect(result.code).toBe(200);
		const body = result.body as {
			batch: ManagementCanonicalBatch;
			confirmToken: string;
		};
		expect(body.confirmToken).toBeTypeOf("string");
		expect(body.batch).toMatchObject({
			origin: ORIGIN,
			snapshotRevision: "snapshot:authoritative",
			changes: [
				{
					targetId: a,
					oldValue: "old-a",
					newValue: "new-a",
					writerId: "fake-runner",
					consequence: "new-run",
				},
			],
			noOps: [{ targetId: b }],
		});
		expect(runner.applyCalls).toEqual([]);
		expect(audit.rows).toHaveLength(1);
		expect(audit.rows[0]).toMatchObject({ event: "staged" });
	});

	it("accepts only the three per-item request fields and rejects unknown/readonly/duplicate conflicts without a token", async () => {
		const runner = fakeWriter("runner", [{ identity: "a", value: "old" }]);
		const { coordinator: c } = coordinator({ writers: [runner] });
		const targetId = [...runner.targets.keys()][0]!;
		for (const changes of [
			[
				{
					targetId,
					desiredValue: "new",
					observedRevision: "revision:a",
					projectRoot: "/forged",
				},
			],
			[
				{
					targetId,
					desiredValue: "new",
					observedRevision: "revision:a",
				},
				{
					targetId,
					desiredValue: "different",
					observedRevision: "revision:a",
				},
			],
		]) {
			const result = await c.stage({ changes: changes as never }, ORIGIN);
			expect(result.code).toBe(400);
			expect(result.body).not.toHaveProperty("confirmToken");
		}
		const unknown = await c.stage(
			{
				changes: [
					{
						targetId: buildTargetId("runner", ["missing"]),
						desiredValue: "new",
						observedRevision: "revision:missing",
					},
				],
			},
			ORIGIN,
		);
		expect(unknown).toMatchObject({ code: 400 });
	});

	it("requires acknowledgement before issuing a token for high-risk consequences", async () => {
		const cron = fakeWriter("cron", [
			{ identity: "schedule", value: "old", ack: true },
		]);
		const { coordinator: c, audit } = coordinator({ writers: [cron] });
		const targetId = [...cron.targets.keys()][0]!;
		const request = {
			changes: [
				{
					targetId,
					desiredValue: "new",
					observedRevision: "revision:schedule",
				},
			],
		};
		const first = await c.stage(request, ORIGIN);
		expect(first).toMatchObject({
			code: 200,
			body: { confirmationRequired: true },
		});
		expect(first.body).not.toHaveProperty("confirmToken");
		expect(audit.rows).toEqual([]);
		const confirmed = await c.stage({ ...request, acknowledged: true }, ORIGIN);
		expect(confirmed.body).toHaveProperty("confirmToken");
	});

	it("re-preflights every source before the first write and fail-closes audit errors", async () => {
		const runner = fakeWriter("runner", [
			{ identity: "a", value: "old-a" },
			{ identity: "b", value: "old-b" },
		]);
		const audit = fakeAudit();
		const { coordinator: c } = coordinator({ writers: [runner], audit });
		const [a, b] = [...runner.targets.keys()];
		const staged = await c.stage(
			{
				changes: [
					{
						targetId: a!,
						desiredValue: "new-a",
						observedRevision: "revision:a",
					},
					{
						targetId: b!,
						desiredValue: "new-b",
						observedRevision: "revision:b",
					},
				],
			},
			ORIGIN,
		);
		const body = staged.body as {
			batch: ManagementCanonicalBatch;
			confirmToken: string;
		};
		runner.targets.get(b!)!.sourceRevision = "revision:drifted";
		const drift = await c.apply(
			{ batch: body.batch, confirmToken: body.confirmToken },
			ORIGIN,
		);
		expect(drift.code).toBe(409);
		expect(runner.applyCalls).toEqual([]);

		const fresh = coordinator({ writers: [runner], audit });
		runner.targets.get(b!)!.sourceRevision = "revision:b";
		const stagedAgain = await fresh.coordinator.stage(
			{
				changes: [
					{
						targetId: a!,
						desiredValue: "new-a",
						observedRevision: "revision:a",
					},
				],
			},
			ORIGIN,
		);
		audit.ok = false;
		const again = stagedAgain.body as {
			batch: ManagementCanonicalBatch;
			confirmToken: string;
		};
		const denied = await fresh.coordinator.apply(
			{ batch: again.batch, confirmToken: again.confirmToken },
			ORIGIN,
		);
		expect(denied.code).toBe(503);
		expect(runner.applyCalls).toEqual([]);
	});

	it("binds token to canonical origin, rejects replay, and persists truthful partial per-item results", async () => {
		const runner = fakeWriter("runner", [
			{ identity: "a", value: "old-a" },
			{ identity: "b", value: "old-b" },
		]);
		const [a, b] = [...runner.targets.keys()];
		runner.resultByTarget.set(b!, {
			status: "partial",
			reason: "runtime failed and rollback failed",
		});
		const { coordinator: c } = coordinator({ writers: [runner] });
		const staged = await c.stage(
			{
				changes: [
					{
						targetId: a!,
						desiredValue: "new-a",
						observedRevision: "revision:a",
					},
					{
						targetId: b!,
						desiredValue: "new-b",
						observedRevision: "revision:b",
					},
				],
			},
			ORIGIN,
		);
		const body = staged.body as {
			batch: ManagementCanonicalBatch;
			confirmToken: string;
		};
		const wrongOrigin = await c.apply(
			{ batch: body.batch, confirmToken: body.confirmToken },
			"http://127.0.0.1:9999",
		);
		expect(wrongOrigin.code).toBe(401);

		const restaged = await c.stage(
			{
				changes: body.batch.changes.map((change) => ({
					targetId: change.targetId,
					desiredValue: change.newValue,
					observedRevision: change.sourceRevision,
				})),
			},
			ORIGIN,
		);
		const ready = restaged.body as {
			batch: ManagementCanonicalBatch;
			confirmToken: string;
		};
		const applied = await c.apply(
			{ batch: ready.batch, confirmToken: ready.confirmToken },
			ORIGIN,
		);
		expect(applied).toMatchObject({
			code: 200,
			body: { status: "partially-applied" },
		});
		expect(runner.applyCalls).toEqual(
			ready.batch.changes.map((change) => change.targetId),
		);
		const replay = await c.apply(
			{ batch: ready.batch, confirmToken: ready.confirmToken },
			ORIGIN,
		);
		expect(replay.code).toBe(401);

		const recreated = coordinator({ writers: [runner] }).coordinator;
		const progress = recreated.listProgress();
		const persisted = progress.find(
			(candidate) => candidate.batchId === ready.batch.batchId,
		);
		expect(persisted).toMatchObject({
			batchId: ready.batch.batchId,
			status: "partially-applied",
		});
		expect(persisted?.items.find((item) => item.targetId === a)).toMatchObject({
			status: "applied",
		});
		expect(persisted?.items.find((item) => item.targetId === b)).toMatchObject({
			status: "partial",
		});
	});

	it("serializes accepted-result reconciliation behind an in-flight apply", async () => {
		const accepted = fakeWriter("lead", [
			{ identity: "accepted", value: "old-accepted" },
		]);
		const delayed = fakeWriter("runner", [
			{ identity: "delayed", value: "old-delayed" },
		]);
		accepted.apply = async () => ({
			status: "accepted",
			details: { batchId: "child-1" },
		});
		let releaseDelayed!: () => void;
		const delayedGate = new Promise<void>((resolve) => {
			releaseDelayed = resolve;
		});
		delayed.apply = async (change) => {
			await delayedGate;
			delayed.targets.get(change.targetId)!.currentValue = change.newValue;
			return { status: "applied" };
		};
		const { coordinator: c } = coordinator({
			writers: [accepted, delayed],
			reconcileAccepted: () => ({ status: "applied" }),
		});
		const changes = [
			...accepted.targets.values(),
			...delayed.targets.values(),
		].map((target) => ({
			targetId: target.targetId,
			desiredValue: `new-${target.kind}`,
			observedRevision: target.sourceRevision,
		}));
		const staged = await c.stage({ changes }, ORIGIN);
		const applying = c.apply(staged.body as never, ORIGIN);
		await new Promise((resolve) => setTimeout(resolve, 0));
		let reconciled = false;
		const reconciling = c.reconcileProgress().then(() => {
			reconciled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(reconciled).toBe(false);

		releaseDelayed();
		await applying;
		await reconciling;
		expect(c.listProgress()[0]).toMatchObject({
			status: "applied",
			items: [{ status: "applied" }, { status: "applied" }],
		});
	});
});
