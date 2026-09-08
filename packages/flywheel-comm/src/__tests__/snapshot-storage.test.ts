import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cleanupRunnerSnapshots,
	createManagedSnapshot,
	createRepairSnapshot,
	inspectManagedSnapshotDirectories,
	isOperatorSnapshotOwnerDead,
	pruneRepairSnapshots,
	readDataDisk,
	readManagedSnapshotOwner,
	withOperatorSnapshots,
} from "../snapshot-storage.js";

describe("snapshot storage", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "fly2351-storage-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("reads the macOS Data volume from bavail bytes", () => {
		const statfs = vi.fn(() => ({ bavail: 5n, bsize: 4_000_000_000n }));

		expect(
			readDataDisk({
				platform: "darwin",
				statfs,
				now: () => new Date("2026-09-08T12:00:00.000Z"),
			}),
		).toEqual({
			disk_avail_gb: 20,
			disk: {
				volume: "/System/Volumes/Data",
				availBytes: 20_000_000_000,
				observedAt: "2026-09-08T12:00:00.000Z",
			},
		});
		expect(statfs).toHaveBeenCalledWith("/System/Volumes/Data", {
			bigint: true,
		});
	});

	it("reports unsupported platforms without falling back to the root volume", () => {
		const statfs = vi.fn();

		expect(readDataDisk({ platform: "linux", statfs })).toEqual({
			disk_avail_gb: null,
			disk: {
				volume: "/System/Volumes/Data",
				availBytes: null,
				observedAt: null,
				unavailable: ["structural: data_volume_unsupported"],
			},
		});
		expect(statfs).not.toHaveBeenCalled();
	});

	it("reports a missing macOS Data volume as structurally unavailable", () => {
		expect(
			readDataDisk({
				platform: "darwin",
				statfs: () => {
					throw Object.assign(new Error("missing"), { code: "ENOENT" });
				},
			}),
		).toMatchObject({
			disk_avail_gb: null,
			disk: {
				availBytes: null,
				observedAt: null,
				unavailable: ["structural: data_volume_missing"],
			},
		});
	});

	it("does not lose precision when the filesystem byte count is unsafe", () => {
		expect(
			readDataDisk({
				platform: "darwin",
				statfs: () => ({
					bavail: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
					bsize: 1n,
				}),
			}),
		).toMatchObject({
			disk_avail_gb: null,
			disk: {
				availBytes: null,
				observedAt: null,
				unavailable: ["transient: data_volume_invalid"],
			},
		});
	});

	it("refuses a repair snapshot before writing when Data avail is below five times the source reservation", async () => {
		const source = join(root, "source.db");
		const db = new Database(source);
		db.exec(
			"CREATE TABLE evidence (value TEXT); INSERT INTO evidence VALUES ('ok')",
		);
		const reservation = Math.max(
			statSync(source).size,
			Number(db.pragma("page_count", { simple: true })) *
				Number(db.pragma("page_size", { simple: true })),
		);
		db.close();

		await expect(
			createRepairSnapshot(
				{
					source,
					issueIdentifier: "FLY-2351",
					databaseKind: "teamlead",
				},
				{
					stateRoot: root,
					readDataDisk: () => ({
						disk_avail_gb: (reservation * 5 - 1) / 1_000_000_000,
						disk: {
							volume: "/System/Volumes/Data",
							availBytes: reservation * 5 - 1,
							observedAt: "2026-09-08T12:00:00.000Z",
						},
					}),
				},
			),
		).rejects.toMatchObject({
			reason: "insufficient_data_volume",
		});
		const repairs = join(root, "patrol-repairs");
		expect(
			(existsSync(repairs)
				? readdirSync(repairs, { recursive: true }).map(String)
				: []
			).some((path) => path.endsWith(".db")),
		).toBe(false);
	});

	it("creates a consistent repair snapshot when Data avail equals five times the reservation", async () => {
		const source = join(root, "source.db");
		const db = new Database(source);
		db.exec(
			"CREATE TABLE evidence (value TEXT); INSERT INTO evidence VALUES ('ok')",
		);
		const reservation = Math.max(
			statSync(source).size,
			Number(db.pragma("page_count", { simple: true })) *
				Number(db.pragma("page_size", { simple: true })),
		);
		db.close();

		const result = await createRepairSnapshot(
			{
				source,
				issueIdentifier: "FLY-2351",
				databaseKind: "teamlead",
			},
			{
				stateRoot: root,
				now: () => new Date("2026-09-08T12:00:00.000Z"),
				readDataDisk: () => ({
					disk_avail_gb: (reservation * 5) / 1_000_000_000,
					disk: {
						volume: "/System/Volumes/Data",
						availBytes: reservation * 5,
						observedAt: "2026-09-08T12:00:00.000Z",
					},
				}),
			},
		);

		expect(result.path).toContain(
			"FLY-2351__teamlead-global__2026-09-08T12:00:00.000Z__",
		);
		expect(result.bytes).toBeLessThanOrEqual(reservation);
		const snapshot = new Database(result.path, {
			readonly: true,
			fileMustExist: true,
		});
		expect(snapshot.prepare("SELECT value FROM evidence").pluck().get()).toBe(
			"ok",
		);
		snapshot.close();
	});

	it("rejects a symlink source instead of following it", async () => {
		const actual = join(root, "actual.db");
		new Database(actual).close();
		const source = join(root, "source.db");
		symlinkSync(actual, source);

		await expect(
			createRepairSnapshot(
				{
					source,
					issueIdentifier: "FLY-2351",
					databaseKind: "teamlead",
				},
				{ stateRoot: root },
			),
		).rejects.toMatchObject({ reason: "invalid_source" });
	});

	it("fails retryably without writing when the shared snapshot lock is busy", async () => {
		const source = join(root, "source.db");
		const db = new Database(source);
		db.exec("CREATE TABLE evidence (value TEXT)");
		db.close();
		mkdirSync(join(root, "state", "snapshot-storage.lock"), {
			recursive: true,
		});

		await expect(
			createRepairSnapshot(
				{
					source,
					issueIdentifier: "FLY-2351",
					databaseKind: "teamlead",
				},
				{ stateRoot: root, lockTimeoutMs: 0 },
			),
		).rejects.toMatchObject({
			reason: "snapshot_lock_busy",
			retryable: true,
		});
		expect(existsSync(join(root, "patrol-repairs"))).toBe(false);
	});

	it("creates runner copies only inside the execution-owned snapshot directory", async () => {
		const source = join(root, "source.db");
		const db = new Database(source);
		db.exec(
			"CREATE TABLE evidence (value TEXT); INSERT INTO evidence VALUES ('ok')",
		);
		db.close();
		const managedRoot = join(root, "flywheel-snapshots");
		const owner = {
			kind: "workflow" as const,
			executionId: "db6e2cf5-d7df-4b87-9feb-2def287d71e0",
			runId: "4e86edef-4b6c-4781-b9d6-70aaea3e0e1c",
			nodeId: "implement",
			attempt: 1,
			activationId: "activation-1",
		};

		const result = await createManagedSnapshot(
			{ source, owner, databaseKind: "teamlead" },
			{
				stateRoot: root,
				managedRoot,
				readDataDisk: () => ({
					disk_avail_gb: 100,
					disk: {
						volume: "/System/Volumes/Data",
						availBytes: 100_000_000_000,
						observedAt: "2026-09-08T12:00:00.000Z",
					},
				}),
			},
		);

		expect(result.path.startsWith(join(managedRoot, owner.executionId))).toBe(
			true,
		);
		expect(result.owner).toEqual(owner);
		expect(
			JSON.parse(
				readFileSync(
					join(managedRoot, owner.executionId, ".owner.json"),
					"utf8",
				),
			),
		).toEqual({ version: 1, ...owner });
	});

	it("keeps the 24-hour and per-group latest repair snapshots as a union", async () => {
		const repairs = join(root, "patrol-repairs");
		mkdirSync(repairs, { mode: 0o700 });
		const names = {
			oldest:
				"FLY-1__teamlead-global__2026-09-06T12:00:00.000Z__11111111-1111-4111-8111-111111111111.db",
			latestOld:
				"FLY-1__teamlead-global__2026-09-07T06:00:00.000Z__22222222-2222-4222-8222-222222222222.db",
			recent:
				"FLY-2__comm-flywheel__2026-09-08T11:00:00.000Z__33333333-3333-4333-8333-333333333333.db",
			exact24h:
				"FLY-2__comm-flywheel__2026-09-07T12:00:00.000Z__44444444-4444-4444-8444-444444444444.db",
			unmapped: "FLY-2080-request-legacy.db",
		};
		for (const name of Object.values(names)) {
			writeFileSync(join(repairs, name), name);
		}

		const dryRun = await pruneRepairSnapshots(
			{ dryRun: true, now: new Date("2026-09-08T12:00:00.000Z") },
			{ stateRoot: root },
		);
		expect(
			dryRun.items.find((item) => item.path === names.oldest),
		).toMatchObject({ action: "delete", reason: "expired" });
		expect(
			dryRun.items.find((item) => item.path === names.latestOld),
		).toMatchObject({ action: "keep", reason: "latest_in_group" });
		expect(
			dryRun.items.find((item) => item.path === names.exact24h),
		).toMatchObject({ action: "keep", reason: "within_24h" });
		expect(dryRun.unmapped_bytes).toBe(Buffer.byteLength(names.unmapped));
		expect(
			Object.values(names).every((name) => existsSync(join(repairs, name))),
		).toBe(true);

		await pruneRepairSnapshots(
			{ dryRun: false, now: new Date("2026-09-08T12:00:00.000Z") },
			{ stateRoot: root },
		);
		expect(existsSync(join(repairs, names.oldest))).toBe(false);
		for (const name of [
			names.latestOld,
			names.recent,
			names.exact24h,
			names.unmapped,
		]) {
			expect(existsSync(join(repairs, name))).toBe(true);
		}
	});

	it("prunes an old legacy snapshot only when its explicit identity map still matches", async () => {
		const repairs = join(root, "patrol-repairs");
		mkdirSync(repairs, { mode: 0o700 });
		const legacyName = "FLY-2080-request-legacy.db";
		const legacyPath = join(repairs, legacyName);
		writeFileSync(legacyPath, "legacy");
		const legacyStat = statSync(legacyPath, { bigint: true });
		writeFileSync(
			join(repairs, "legacy-map.json"),
			JSON.stringify({
				version: 1,
				entries: [
					{
						basename: legacyName,
						size: Number(legacyStat.size),
						mtimeNs: legacyStat.mtimeNs.toString(),
						device: legacyStat.dev.toString(),
						inode: legacyStat.ino.toString(),
						issueIdentifier: "FLY-1",
						databaseKind: "teamlead",
						project: "global",
						createdAt: "2026-09-06T12:00:00.000Z",
						provenance: "repair receipt 1",
					},
				],
			}),
		);
		const latest =
			"FLY-1__teamlead-global__2026-09-07T06:00:00.000Z__22222222-2222-4222-8222-222222222222.db";
		writeFileSync(join(repairs, latest), "latest");

		const result = await pruneRepairSnapshots(
			{ dryRun: false, now: new Date("2026-09-08T12:00:00.000Z") },
			{ stateRoot: root },
		);

		expect(result.items.find((item) => item.path === legacyName)).toMatchObject(
			{
				action: "delete",
				reason: "expired",
			},
		);
		expect(existsSync(legacyPath)).toBe(false);
		expect(existsSync(join(repairs, latest))).toBe(true);
	});

	it("removes an execution directory only after fresh owner authorization", async () => {
		const source = join(root, "source.db");
		const db = new Database(source);
		db.exec("CREATE TABLE evidence (value TEXT)");
		db.close();
		const managedRoot = join(root, "flywheel-snapshots");
		const owner = {
			kind: "session" as const,
			executionId: "db6e2cf5-d7df-4b87-9feb-2def287d71e0",
			sessionStartedAt: "2026-09-08T12:00:00.000Z",
		};
		await createManagedSnapshot(
			{ source, owner, databaseKind: "teamlead" },
			{
				stateRoot: root,
				managedRoot,
				readDataDisk: () => ({
					disk_avail_gb: 100,
					disk: {
						volume: "/System/Volumes/Data",
						availBytes: 100_000_000_000,
						observedAt: "2026-09-08T12:00:00.000Z",
					},
				}),
			},
		);
		const authorize = vi.fn(
			async (freshOwner) => freshOwner.executionId === owner.executionId,
		);

		const result = await cleanupRunnerSnapshots(
			{ executionId: owner.executionId, expectedOwner: owner, authorize },
			{ stateRoot: root, managedRoot },
		);

		expect(result.status).toBe("deleted");
		expect(result.bytesReleased).toBeGreaterThan(0);
		expect(authorize).toHaveBeenCalledWith(owner);
		expect(existsSync(join(managedRoot, owner.executionId))).toBe(false);
	});

	it("reads an owned directory without accepting a caller-supplied path", () => {
		const managedRoot = join(root, "flywheel-snapshots");
		const executionId = "db6e2cf5-d7df-4b87-9feb-2def287d71e0";
		const owner = {
			kind: "session" as const,
			executionId,
			sessionStartedAt: "2026-09-08T12:00:00.000Z",
		};
		const directory = join(managedRoot, executionId);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		writeFileSync(
			join(directory, ".owner.json"),
			`${JSON.stringify({ version: 1, ...owner })}\n`,
			{ mode: 0o600 },
		);

		expect(readManagedSnapshotOwner(executionId, { managedRoot })).toEqual(
			owner,
		);
		expect(() =>
			readManagedSnapshotOwner("../escape", { managedRoot }),
		).toThrowError("invalid_snapshot_owner");
		writeFileSync(join(directory, "snapshot.db"), "evidence", { mode: 0o600 });
		expect(inspectManagedSnapshotDirectories({ managedRoot })).toEqual([
			expect.objectContaining({ owner, bytes: expect.any(Number) }),
		]);
	});

	it("allows exactly 2GB of managed files and rejects one byte more", async () => {
		const source = join(root, "source.db");
		const db = new Database(source);
		db.exec("CREATE TABLE evidence (value TEXT)");
		const reservation = Math.max(
			statSync(source).size,
			Number(db.pragma("page_count", { simple: true })) *
				Number(db.pragma("page_size", { simple: true })),
		);
		db.close();
		const managedRoot = join(root, "flywheel-snapshots");
		mkdirSync(managedRoot, { mode: 0o700 });
		const disk = () => ({
			disk_avail_gb: 100,
			disk: {
				volume: "/System/Volumes/Data",
				availBytes: 100_000_000_000,
				observedAt: "2026-09-08T12:00:00.000Z",
			},
		});
		const seedOwnedDirectory = (executionId: string, extraByte: number) => {
			const owner = {
				kind: "session" as const,
				executionId,
				sessionStartedAt: "2026-09-08T12:00:00.000Z",
			};
			const directory = join(managedRoot, executionId);
			mkdirSync(directory, { mode: 0o700 });
			const ownerPath = join(directory, ".owner.json");
			writeFileSync(
				ownerPath,
				`${JSON.stringify({ version: 1, ...owner })}\n`,
				{
					mode: 0o600,
				},
			);
			const filler = join(directory, "existing.bin");
			writeFileSync(filler, "");
			truncateSync(
				filler,
				2_000_000_000 - statSync(ownerPath).size - reservation + extraByte,
			);
			return owner;
		};
		const exactOwner = seedOwnedDirectory(
			"11111111-1111-4111-8111-111111111111",
			0,
		);
		const overOwner = seedOwnedDirectory(
			"22222222-2222-4222-8222-222222222222",
			1,
		);

		await expect(
			createManagedSnapshot(
				{ source, owner: exactOwner, databaseKind: "teamlead" },
				{ stateRoot: root, managedRoot, readDataDisk: disk },
			),
		).resolves.toMatchObject({ owner: exactOwner });
		await expect(
			createManagedSnapshot(
				{ source, owner: overOwner, databaseKind: "teamlead" },
				{ stateRoot: root, managedRoot, readDataDisk: disk },
			),
		).rejects.toMatchObject({ reason: "managed_snapshot_budget_exceeded" });
	});

	it("releases operator snapshots in finally without impersonating a runner", async () => {
		const source = join(root, "source.db");
		const db = new Database(source);
		db.exec("CREATE TABLE evidence (value TEXT)");
		db.close();
		const managedRoot = join(root, "flywheel-snapshots");
		let executionDir = "";

		await expect(
			withOperatorSnapshots(
				{ label: "test-analysis" },
				async ({ owner, createSnapshot }) => {
					expect(owner.kind).toBe("operator");
					expect(owner.executionId.startsWith("operator-")).toBe(true);
					executionDir = join(managedRoot, owner.executionId);
					await createSnapshot({ source, databaseKind: "teamlead" });
					expect(existsSync(executionDir)).toBe(true);
					throw new Error("analysis failed");
				},
				{
					stateRoot: root,
					managedRoot,
					uid: 501,
					pid: 123,
					processStartIdentity: () => "start-identity",
					readDataDisk: () => ({
						disk_avail_gb: 100,
						disk: {
							volume: "/System/Volumes/Data",
							availBytes: 100_000_000_000,
							observedAt: "2026-09-08T12:00:00.000Z",
						},
					}),
				},
			),
		).rejects.toThrow("analysis failed");
		expect(existsSync(executionDir)).toBe(false);
	});

	it("reclaims an operator owner only after death or PID-reuse proof", () => {
		const owner = {
			kind: "operator" as const,
			executionId: "operator-1",
			uid: 501,
			pid: 123,
			processStartIdentity: "original-start",
			createdAt: "2026-09-08T12:00:00.000Z",
			label: "analysis",
		};
		expect(
			isOperatorSnapshotOwnerDead(owner, {
				uid: 501,
				signalProcess: () => {
					throw Object.assign(new Error("gone"), { code: "ESRCH" });
				},
			}),
		).toBe(true);
		expect(
			isOperatorSnapshotOwnerDead(owner, {
				uid: 501,
				signalProcess: () => {},
				processStartIdentity: () => "reused-start",
			}),
		).toBe(true);
		expect(
			isOperatorSnapshotOwnerDead(owner, {
				uid: 501,
				signalProcess: () => {},
				processStartIdentity: () => "original-start",
			}),
		).toBe(false);
	});
});
