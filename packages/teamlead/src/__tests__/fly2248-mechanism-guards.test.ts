import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeliveryContractWatch } from "../bridge/delivery-contract/watch.js";
import { StateStore } from "../StateStore.js";

const stores: StateStore[] = [];
const commDbs: CommDB[] = [];
const enqueueUnboundAlert = (payload: { eventId: string }) => ({
	eventId: payload.eventId,
	state: "sent" as const,
});

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const db of commDbs.splice(0)) db.close();
});

function rawDb(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

function productionSources(): Array<{ path: string; source: string }> {
	const bridge = resolve(process.cwd(), "src/bridge");
	const contract = resolve(bridge, "delivery-contract");
	const paths = [
		...readdirSync(contract, { recursive: true })
			.filter((entry) => String(entry).endsWith(".ts"))
			.map((entry) => resolve(contract, String(entry))),
	];
	return paths.map((path) => ({ path, source: readFileSync(path, "utf8") }));
}

describe("FLY-2248 mechanism guards", () => {
	it("keeps the delivery implementation generic and exposes only the contract alert UID prefix", () => {
		for (const { path, source } of productionSources()) {
			expect(source, path).not.toMatch(/\b(?:qa|implement|design)\b/i);
		}
		const stateStore = readFileSync(
			resolve(process.cwd(), "src/StateStore.ts"),
			"utf8",
		);
		const prefixes = Array.from(
			stateStore.matchAll(
				/const escalationUid = `(delivery_contract_stalled):/g,
			),
			(match) => match[1],
		).sort();
		expect(prefixes).toEqual(["delivery_contract_stalled"]);
	});

	it("installs exactly three StateStore delivery tables, no CommDB delivery tables, and the one phase-wake clock", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		const stateTables = rawDb(store)
			.prepare(
				`SELECT name FROM sqlite_master
				  WHERE type = 'table' AND name LIKE 'workflow_delivery_%'
				  ORDER BY name`,
			)
			.all() as Array<{ name: string }>;
		expect(stateTables.map(({ name }) => name)).toEqual([
			"workflow_delivery_attempt",
			"workflow_delivery_contract_episode",
			"workflow_delivery_operation",
		]);
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		const rawComm = (commDb as unknown as { db: Database.Database }).db;
		expect(
			rawComm
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'workflow_delivery_%'",
				)
				.all(),
		).toEqual([]);
		const phaseColumns = rawComm
			.prepare("PRAGMA table_info(runner_phase_wakes)")
			.all() as Array<{ name: string }>;
		expect(
			phaseColumns.filter(({ name }) => name === "first_push_at"),
		).toHaveLength(1);
	});

	it("keeps attempt clocks set-once and rejects dangling lineage without mutation helpers", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		const rootId = "flywheel:FLY-2248:attempt-lock";
		const attemptId = `${rootId}:g1:a1`;
		expect(
			store.projectWorkflowDeliveryAttempt({
				rootId,
				attemptId,
				family: "mailbox",
				contractRef: { table: "mailbox", pk: "attempt-lock" },
				mintedAt: "2026-09-02T06:00:00.000Z",
				sentAt: "2026-09-02T06:01:00.000Z",
			}),
		).toEqual({ minted: 1, advanced: 1 });
		expect(
			store.projectWorkflowDeliveryAttempt({
				rootId,
				attemptId,
				family: "mailbox",
				contractRef: { table: "mailbox", pk: "attempt-lock" },
				mintedAt: "2026-09-02T06:00:00.000Z",
				sentAt: "2026-09-02T06:02:00.000Z",
			}),
		).toEqual({ minted: 0, advanced: 0 });
		expect(
			rawDb(store)
				.prepare(
					"SELECT sent_at FROM workflow_delivery_attempt WHERE attempt_id = ?",
				)
				.get(attemptId),
		).toEqual({ sent_at: "2026-09-02T06:01:00.000Z" });
		expect(() =>
			rawDb(store)
				.prepare(
					`INSERT INTO workflow_delivery_attempt (
					   root_id, generation, attempt, attempt_id, family,
					   contract_ref_json, parent_attempt_id, minted_at
					 ) VALUES (?, 2, 1, ?, 'mailbox', '{}', 'missing-parent', ?)`,
				)
				.run(
					`${rootId}:dangling`,
					`${rootId}:dangling:g2:a1`,
					"2026-09-02T06:03:00.000Z",
				),
		).toThrow(/foreign key/i);
		const stateStoreSource = readFileSync(
			resolve(process.cwd(), "src/StateStore.ts"),
			"utf8",
		);
		expect(stateStoreSource).not.toMatch(
			/DELETE\s+FROM\s+workflow_delivery_attempt/i,
		);
		expect(stateStoreSource).not.toMatch(
			/UPDATE\s+workflow_delivery_attempt[\s\S]{0,120}SET\s+attempt_id\s*=/i,
		);
	});

	it("scopes each delivery watch to its CommDB project", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		for (const projectName of ["flywheel", "sibling-project"]) {
			const rootId = `${projectName}:FLY-2248:mailbox:${projectName}`;
			store.projectWorkflowDeliveryAttempt({
				rootId,
				attemptId: `${rootId}:g1:a1`,
				family: "mailbox",
				contractRef: {
					table: "mailbox",
					pk: projectName,
					projectName,
					issueId: "FLY-2248",
				},
				mintedAt: "2026-09-02T06:00:00.000Z",
			});
		}

		const result = new DeliveryContractWatch({
			store,
			projectName: "flywheel",
			resolveAlertIdentity: ({ projectName }) => ({
				leadId: "configured-lead",
				projectName,
				leadResolution: "resolved",
			}),
			enqueueUnboundAlert,
		}).runPass("2026-09-02T06:10:00.001Z");

		expect(result).toEqual({ observed: 1, opened: 1, closed: 0, alerted: 1 });
		expect(
			rawDb(store)
				.prepare(
					"SELECT root_id FROM workflow_delivery_contract_episode ORDER BY root_id",
				)
				.all(),
		).toEqual([{ root_id: "flywheel:FLY-2248:mailbox:flywheel" }]);
	});

	it("continues the watch pass after one delivery attempt throws", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		for (const physicalId of ["poison", "healthy"]) {
			const rootId = `flywheel:FLY-2248:mailbox:${physicalId}`;
			store.projectWorkflowDeliveryAttempt({
				rootId,
				attemptId: `${rootId}:g1:a1`,
				family: "mailbox",
				contractRef: {
					table: "mailbox",
					pk: physicalId,
					projectName: "flywheel",
					issueId: "FLY-2248",
				},
				mintedAt: "2026-09-02T06:00:00.000Z",
			});
		}
		const observe = store.observeWorkflowDeliveryContract.bind(store);
		vi.spyOn(store, "observeWorkflowDeliveryContract").mockImplementation(
			(input) => {
				if (input.attempt.root_id.endsWith(":poison")) {
					throw new Error("poisoned delivery attempt");
				}
				return observe(input);
			},
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		const result = new DeliveryContractWatch({
			store,
			projectName: "flywheel",
			resolveAlertIdentity: ({ projectName }) => ({
				leadId: "configured-lead",
				projectName,
				leadResolution: "resolved",
			}),
			enqueueUnboundAlert,
		}).runPass("2026-09-02T06:10:00.001Z");

		expect(result).toEqual({ observed: 2, opened: 1, closed: 0, alerted: 1 });
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("flywheel:FLY-2248:mailbox:poison"),
		);
		expect(
			rawDb(store)
				.prepare(
					"SELECT root_id FROM workflow_delivery_contract_episode ORDER BY root_id",
				)
				.all(),
		).toEqual([{ root_id: "flywheel:FLY-2248:mailbox:healthy" }]);
	});

	it("baselines a pre-deployment native obligation exactly once", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.createWorkflowRun({
			runId: "run-baseline",
			issueId: "FLY-2248",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		const operation = store.ensureLandOperation({
			runId: "run-baseline",
			issueId: "FLY-2248",
			projectName: "flywheel",
			prNumber: 2248,
			approvedHead: "a".repeat(40),
			now: "2026-09-02T06:00:00.000Z",
		});
		rawDb(store)
			.prepare("DELETE FROM workflow_delivery_attempt WHERE family = 'land'")
			.run();

		expect(
			store.baselineWorkflowDeliveryContracts("2026-09-02T07:00:00.000Z"),
		).toEqual({ examined: 1, minted: 1 });
		expect(
			store
				.listLiveWorkflowDeliveryAttempts()
				.find(
					(row) =>
						row.family === "land" &&
						JSON.parse(row.contract_ref_json).pk === operation.operation_id,
				),
		).toMatchObject({
			minted_at: "2026-09-02T07:00:00.000Z",
			sent_at: "2026-09-02T07:00:00.000Z",
		});
		expect(
			store.baselineWorkflowDeliveryContracts("2026-09-02T08:00:00.000Z"),
		).toEqual({ examined: 1, minted: 0 });
		expect(
			store
				.listWorkflowRunEvents("run-baseline")
				.filter(({ kind }) => kind === "delivery_contract_baseline"),
		).toHaveLength(1);
	});

	it("keeps a land delivery identity stable while its run binding is backfilled", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.createWorkflowRun({
			runId: "run-land-backfill",
			issueId: "FLY-2248",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		const input = {
			issueId: "FLY-2248",
			projectName: "flywheel",
			prNumber: 2248,
			approvedHead: "b".repeat(40),
		};
		const first = store.ensureLandOperation({
			...input,
			now: "2026-09-02T06:00:00.000Z",
		});
		const rebound = store.ensureLandOperation({
			...input,
			runId: "run-land-backfill",
			now: "2026-09-02T06:01:00.000Z",
		});
		expect(rebound).toMatchObject({
			operation_id: first.operation_id,
			run_id: "run-land-backfill",
		});
		expect(
			store.baselineWorkflowDeliveryContracts("2026-09-02T06:01:30.000Z"),
		).toEqual({ examined: 1, minted: 0 });
		expect(
			store.ensureLandOperation({
				...input,
				now: "2026-09-02T06:02:00.000Z",
			}),
		).toMatchObject({ operation_id: first.operation_id });
		const attempt = store
			.listLiveWorkflowDeliveryAttempts()
			.find(({ family }) => family === "land");
		expect(attempt).toBeDefined();
		expect(JSON.parse(attempt!.contract_ref_json)).toEqual({
			table: "land_operation",
			pk: first.operation_id,
		});
		rawDb(store)
			.prepare("DELETE FROM workflow_delivery_attempt WHERE attempt_id = ?")
			.run(attempt!.attempt_id);
		expect(
			store.baselineWorkflowDeliveryContracts("2026-09-02T06:03:00.000Z"),
		).toEqual({ examined: 1, minted: 1 });
		expect(() =>
			store.ensureLandOperation({
				...input,
				runId: "run-land-backfill",
				now: "2026-09-02T06:04:00.000Z",
			}),
		).not.toThrow();
	});

	it("does not mint an open historical obligation after its workflow run completes", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.createWorkflowRun({
			runId: "run-completed-baseline",
			issueId: "FLY-2248",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		store.ensureLandOperation({
			runId: "run-completed-baseline",
			issueId: "FLY-2248",
			projectName: "flywheel",
			prNumber: 2248,
			approvedHead: "a".repeat(40),
			now: "2026-09-02T06:00:00.000Z",
		});
		const db = rawDb(store);
		db.prepare(
			"UPDATE workflow_run SET status = 'completed' WHERE run_id = ?",
		).run("run-completed-baseline");
		db.prepare(
			"DELETE FROM workflow_delivery_attempt WHERE family = 'land'",
		).run();

		expect(
			store.baselineWorkflowDeliveryContracts("2026-09-02T07:00:00.000Z"),
		).toEqual({ examined: 0, minted: 0 });
		expect(store.listLiveWorkflowDeliveryAttempts()).toEqual([]);
	});

	it("mounts baseline, projector, and watch in maintenance order", () => {
		const source = readFileSync(
			resolve(process.cwd(), "src/bridge/plugin.ts"),
			"utf8",
		);
		const reowner = source.indexOf(
			"codexSessionReowner.runPass(codexCandidateSnapshot)",
		);
		const baseline = source.indexOf(
			"baselineWorkflowDeliveryContracts",
			reowner,
		);
		const projector = source.indexOf("deliveryProjector.runPass", baseline);
		const watch = source.indexOf("deliveryContractWatch.runPass", projector);
		expect(
			[reowner, baseline, projector, watch].every((index) => index >= 0),
		).toBe(true);
		expect(reowner).toBeLessThan(baseline);
		expect(baseline).toBeLessThan(projector);
		expect(projector).toBeLessThan(watch);
		expect(source.match(/await drainSynchronousPages/g)).toHaveLength(3);
		expect(source).toContain(
			'deliveryOperations.runPass(deliveryNow, { lane: "stalled" })',
		);
	});
});
