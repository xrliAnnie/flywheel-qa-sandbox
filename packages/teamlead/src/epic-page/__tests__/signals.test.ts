import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type EpicPageSignalFacts, StateStore } from "../../StateStore.js";
import { readSignals } from "../signals.js";

const NOW = new Date("2026-09-05T04:00:00.000Z");
const ITEMS = [{ uuid: "issue-uuid", identifier: "FLY-2143" }];
const stores: StateStore[] = [];

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

function stateFacts(
	overrides?: Partial<EpicPageSignalFacts>,
): EpicPageSignalFacts {
	return {
		execution_ids: ["exec-full-identity"],
		signals: [
			{
				kind: "declared_blocked",
				execution_id: "exec-full-identity",
				since: "2026-09-05T01:00:00.000Z",
			},
			{
				kind: "run_held",
				execution_id: "run-fallback-identity",
				run_id: "run-fallback-identity",
				since: "2026-09-05T01:30:00.000Z",
			},
		],
		...overrides,
	};
}

describe("FLY-2143 Epic signal aggregation", () => {
	it("combines all five kinds and falls back to the run id for held-run identity", () => {
		const close = vi.fn();
		const listEpicPageSignals = vi.fn(() => ({
			signals: [
				{
					kind: "runner_stopped" as const,
					execution_id: "exec-full-identity",
					since: "2026-09-05T02:00:00.000Z",
					reason: "quota" as const,
					question_id_present: true as const,
				},
				{
					kind: "question_pending" as const,
					execution_id: "exec-full-identity",
					since: "2026-09-05T02:30:00.000Z",
					question_id_present: true as const,
				},
				{
					kind: "waiting_founder" as const,
					execution_id: "exec-full-identity",
					since: "2026-09-05T03:00:00.000Z",
					question_id_present: true as const,
				},
			],
			truncated: false,
		}));
		const result = readSignals(
			{
				stateStore: {
					getEpicPageSignalFacts: vi.fn(() => stateFacts()),
				},
				openCommReadonly: () => ({ close, listEpicPageSignals }),
				commDbPathForProject: (project) => `/comm/${project}.db`,
			},
			{
				projectName: "flywheel",
				items: ITEMS,
				now: NOW,
			},
		);

		expect(listEpicPageSignals).toHaveBeenCalledWith({
			executionIds: ["exec-full-identity"],
			createdAfter: "2026-08-22T04:00:00.000Z",
			limit: 3,
		});
		expect(close).toHaveBeenCalledOnce();
		expect(result[0]?.signals.map(({ kind }) => kind).sort()).toEqual([
			"declared_blocked",
			"question_pending",
			"run_held",
			"runner_stopped",
			"waiting_founder",
		]);
		expect(
			result[0]?.signals.find(({ kind }) => kind === "run_held")?.execution_id8,
		).toBe("run-fall");
		expect(result[0]?.signal_sources).toMatchObject({
			statestore: { value: { signals: 2 } },
			commdb: { value: { signals: 3 } },
		});
	});

	it("fails CommDB soft, closes it after a query error, and preserves StateStore signals", () => {
		const close = vi.fn();
		const result = readSignals(
			{
				stateStore: { getEpicPageSignalFacts: () => stateFacts() },
				openCommReadonly: () => ({
					close,
					listEpicPageSignals: () => {
						throw new Error("database busy SENTINEL");
					},
				}),
				commDbPathForProject: () => "/comm/flywheel.db",
			},
			{ projectName: "flywheel", items: ITEMS, now: NOW },
		);

		expect(close).toHaveBeenCalledOnce();
		expect(result[0]?.signals.map(({ kind }) => kind)).toEqual([
			"declared_blocked",
			"run_held",
		]);
		expect(result[0]?.signal_sources.commdb).toMatchObject({
			value: null,
			missing: { reason: "commdb_error" },
		});
		expect(JSON.stringify(result)).not.toContain("SENTINEL");
	});

	it("reports StateStore failure and treats truncated CommDB output as missing", () => {
		const result = readSignals(
			{
				stateStore: {
					getEpicPageSignalFacts: () => {
						throw new Error("StateStore SENTINEL");
					},
				},
				openCommReadonly: () => ({
					close() {},
					listEpicPageSignals: () => ({ signals: [], truncated: true }),
				}),
				commDbPathForProject: () => "/comm/flywheel.db",
			},
			{ projectName: "flywheel", items: ITEMS, now: NOW },
		);

		expect(result[0]?.signals).toEqual([]);
		expect(result[0]?.signal_sources.statestore).toMatchObject({
			value: null,
			missing: { reason: "statestore_error" },
		});
		expect(result[0]?.signal_sources.commdb).toMatchObject({
			value: null,
			missing: { reason: "commdb_truncated" },
		});
		expect(JSON.stringify(result)).not.toContain("SENTINEL");
	});

	it("resolves execution-prefix collisions deterministically before exposing id8", () => {
		const rows = [
			{
				kind: "runner_stopped" as const,
				execution_id: "collision-b",
				since: "2026-09-05T02:00:00.000Z",
				reason: "blocked" as const,
				question_id_present: true as const,
			},
			{
				kind: "runner_stopped" as const,
				execution_id: "collision-a",
				since: "2026-09-05T02:00:00.000Z",
				reason: "error" as const,
				question_id_present: true as const,
			},
		];
		const run = (signals: typeof rows) =>
			readSignals(
				{
					stateStore: {
						getEpicPageSignalFacts: () =>
							stateFacts({
								execution_ids: ["collision-a", "collision-b"],
								signals: [],
							}),
					},
					openCommReadonly: () => ({
						close() {},
						listEpicPageSignals: () => ({ signals, truncated: false }),
					}),
					commDbPathForProject: () => "/comm/flywheel.db",
				},
				{ projectName: "flywheel", items: ITEMS, now: NOW },
			)[0]?.signals;

		expect(run(rows)).toEqual(run([...rows].reverse()));
		expect(run(rows)).toEqual([
			{
				kind: "runner_stopped",
				since: "2026-09-05T02:00:00.000Z",
				execution_id8: "collisio",
				reason: "error",
				provenance: {
					kind: "commdb",
					table: "mailbox",
					key: { execution_id: "collision-a" },
				},
				observed_at: NOW.toISOString(),
			},
		]);
	});

	it("reads the latest blocked session and lexically first held run from StateStore", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.upsertSession({
			execution_id: "exec-blocked-long",
			issue_id: "issue-uuid",
			issue_identifier: "FLY-2143",
			project_name: "flywheel",
			status: "blocked",
			started_at: "2026-09-05T00:30:00.000Z",
			last_activity_at: "2026-09-05T01:00:00.000Z",
		});
		for (const [runId, issueId] of [
			["run-z", "issue-uuid"],
			["run-a", "FLY-2143"],
		] as const) {
			store.createWorkflowRun({
				runId,
				issueId,
				projectName: "flywheel",
				claimsReadEnrolled: true,
			});
		}
		const raw = (store as unknown as { db: { raw: Database.Database } }).db.raw;
		raw
			.prepare(
				"UPDATE workflow_run SET status = 'held', created_at = ? WHERE run_id IN ('run-a', 'run-z')",
			)
			.run("2026-09-05T01:30:00.000Z");

		expect(
			store.getEpicPageSignalFacts("flywheel", ["issue-uuid", "FLY-2143"]),
		).toEqual({
			execution_ids: ["exec-blocked-long"],
			signals: [
				{
					kind: "declared_blocked",
					execution_id: "exec-blocked-long",
					since: "2026-09-05T01:00:00Z",
				},
				{
					kind: "run_held",
					execution_id: "run-a",
					run_id: "run-a",
					since: "2026-09-05T01:30:00Z",
				},
			],
		});
	});
});
