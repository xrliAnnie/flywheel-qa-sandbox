import { describe, expect, it, vi } from "vitest";
import { SnapshotStorageError } from "../../snapshot-storage.js";
import { runSnapshotCommand } from "../snapshot.js";

describe("snapshot command", () => {
	it("prints the shared Data volume reading as JSON", async () => {
		const stdout = vi.fn();
		const reading = {
			disk_avail_gb: 19.999999999,
			disk: {
				volume: "/System/Volumes/Data",
				availBytes: 19_999_999_999,
				observedAt: "2026-09-08T12:00:00.000Z",
			},
		};

		expect(
			await runSnapshotCommand(["disk"], {
				readDataDisk: () => reading,
				stdout,
			}),
		).toBe(0);
		expect(JSON.parse(stdout.mock.calls[0]![0])).toEqual({
			ok: true,
			...reading,
		});
	});

	it("creates a repair snapshot only from the configured production database", async () => {
		const stdout = vi.fn();
		const createRepairSnapshot = vi.fn(async () => ({
			path: "/snapshots/repair.db",
			bytes: 4_096,
		}));

		expect(
			await runSnapshotCommand(
				[
					"repair",
					"--source",
					"/state/teamlead.db",
					"--issue",
					"FLY-2351",
					"--kind",
					"teamlead",
				],
				{
					env: { TEAMLEAD_DB_PATH: "/state/teamlead.db" },
					createRepairSnapshot,
					stdout,
				},
			),
		).toBe(0);
		expect(createRepairSnapshot).toHaveBeenCalledWith({
			source: "/state/teamlead.db",
			issueIdentifier: "FLY-2351",
			databaseKind: "teamlead",
			project: undefined,
		});
		expect(JSON.parse(stdout.mock.calls[0]![0])).toMatchObject({
			ok: true,
			path: "/snapshots/repair.db",
		});
	});

	it("retries the shared lock with bounded backoff", async () => {
		const sleep = vi.fn(async () => {});
		const createRepairSnapshot = vi
			.fn()
			.mockRejectedValueOnce(
				new SnapshotStorageError("snapshot_lock_busy", true),
			)
			.mockRejectedValueOnce(
				new SnapshotStorageError("snapshot_lock_busy", true),
			)
			.mockResolvedValue({ path: "/snapshots/repair.db", bytes: 4_096 });

		expect(
			await runSnapshotCommand(
				[
					"repair",
					"--source",
					"/state/teamlead.db",
					"--issue",
					"FLY-2351",
					"--kind",
					"teamlead",
				],
				{
					env: { TEAMLEAD_DB_PATH: "/state/teamlead.db" },
					createRepairSnapshot,
					sleep,
					stdout: vi.fn(),
				},
			),
		).toBe(0);
		expect(createRepairSnapshot).toHaveBeenCalledTimes(3);
		expect(sleep.mock.calls).toEqual([[1_000], [2_000]]);
	});

	it("binds runner snapshots to the authenticated current owner", async () => {
		const stdout = vi.fn();
		const owner = {
			kind: "workflow" as const,
			executionId: "exec-1",
			runId: "run-1",
			nodeId: "qa",
			attempt: 2,
			activationId: "activation-2",
		};
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ ok: true, owner }), { status: 200 }),
		);
		const createManagedSnapshot = vi.fn(async () => ({
			path: "/tmp/flywheel-snapshots/exec-1/teamlead.db",
			bytes: 4_096,
			owner,
		}));

		expect(
			await runSnapshotCommand(
				["runner", "--source", "/state/teamlead.db", "--kind", "teamlead"],
				{
					env: {
						FLYWHEEL_EXEC_ID: "exec-1",
						FLYWHEEL_STATE_DB_PATH: "/state/teamlead.db",
						FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:4200",
						TEAMLEAD_API_TOKEN: "test-token",
					},
					fetch,
					createManagedSnapshot,
					stdout,
				},
			),
		).toBe(0);
		expect(fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:4200/api/sessions/exec-1/snapshot-owner",
			{ headers: { Authorization: "Bearer test-token" } },
		);
		expect(createManagedSnapshot).toHaveBeenCalledWith({
			source: "/state/teamlead.db",
			owner,
			databaseKind: "teamlead",
			project: undefined,
		});
	});

	it("keeps manual prune dry-run unless --apply is explicit", async () => {
		const stdout = vi.fn();
		const pruneRepairSnapshots = vi.fn(async ({ dryRun }) => ({
			mode: dryRun ? "dry-run" : "apply",
			items: [],
		}));

		expect(
			await runSnapshotCommand(["prune"], {
				pruneRepairSnapshots,
				stdout,
			}),
		).toBe(0);
		expect(pruneRepairSnapshots).toHaveBeenCalledWith({
			dryRun: true,
			now: expect.any(Date),
		});
		expect(JSON.parse(stdout.mock.calls[0]![0])).toMatchObject({
			ok: true,
			mode: "dry-run",
		});
	});

	it("releases only the caller's authenticated current owner directory", async () => {
		const stdout = vi.fn();
		const owner = {
			kind: "session" as const,
			executionId: "exec-1",
			sessionStartedAt: "2026-09-08T12:00:00.000Z",
		};
		const cleanupRunnerSnapshots = vi.fn(async ({ authorize }) => {
			expect(await authorize(owner)).toBe(true);
			return { status: "deleted", bytesReleased: 4_096 };
		});

		expect(
			await runSnapshotCommand(["release"], {
				env: {
					FLYWHEEL_EXEC_ID: "exec-1",
					FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:4200",
					TEAMLEAD_API_TOKEN: "test-token",
				},
				fetch: async () =>
					new Response(JSON.stringify({ ok: true, owner }), { status: 200 }),
				cleanupRunnerSnapshots,
				stdout,
			}),
		).toBe(0);
		expect(cleanupRunnerSnapshots).toHaveBeenCalledWith({
			executionId: "exec-1",
			expectedOwner: owner,
			authorize: expect.any(Function),
		});
		expect(JSON.parse(stdout.mock.calls[0]![0])).toMatchObject({
			ok: true,
			status: "deleted",
		});
	});
});
