import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LeadLeaseStore, LeaseStoreError } from "../lead-lease.js";
import { LeadLeaseModeStore } from "../lead-lease-mode.js";

describe("FLY-1309 LeadLeaseStore", () => {
	const IDENTITY_DIGEST = "a".repeat(64);
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1309-lease-"));
		dbPath = join(dir, "lead-lease.db");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function open(alive: ReadonlySet<string> = new Set()) {
		return new LeadLeaseStore(dbPath, {
			processAliveWithStart: (pid, start) => alive.has(`${pid}:${start}`),
		});
	}

	function openWithTupleStates(
		states: Readonly<Record<string, "alive" | "dead" | "sensor_error">>,
	) {
		return new LeadLeaseStore(dbPath, {
			processTupleState: (pid, start) => states[`${pid}:${start}`] ?? "dead",
		});
	}

	const supervisor1 = {
		leadKey: "flywheel-eng-lead",
		project: "flywheel",
		leadId: "eng-lead",
		identityDigest: IDENTITY_DIGEST,
		supervisorPid: 100,
		supervisorStart: "Thu Jul 16 01:00:00 2026",
		acquiredBy: "test",
		now: "2026-07-16T08:00:00.000Z",
	};

	it("acquires unbound generation 1, then bind commits holder and immutable history", () => {
		const store = open();

		expect(store.acquire(supervisor1)).toEqual({
			status: "acquired",
			generation: 1,
		});
		expect(store.getLease(supervisor1.leadKey)).toMatchObject({
			generation: 1,
			holderPid: 100,
			holderStart: supervisor1.supervisorStart,
			boundAt: null,
		});

		expect(
			store.bind({
				leadKey: supervisor1.leadKey,
				generation: 1,
				expectedSupervisorPid: 100,
				expectedSupervisorStart: supervisor1.supervisorStart,
				identityDigest: IDENTITY_DIGEST,
				panePid: 200,
				paneStart: "Thu Jul 16 01:00:01 2026",
				now: "2026-07-16T08:00:01.000Z",
			}),
		).toEqual({ status: "bound", generation: 1 });
		expect(store.getLease(supervisor1.leadKey)).toMatchObject({
			holderPid: 200,
			holderStart: "Thu Jul 16 01:00:01 2026",
			boundAt: "2026-07-16T08:00:01.000Z",
		});
		expect(store.getGenerationHistory(supervisor1.leadKey, 1)).toMatchObject({
			holderPid: 200,
			holderStart: "Thu Jul 16 01:00:01 2026",
		});
		expect(
			store.validate({
				leaseKey: supervisor1.leadKey,
				generation: 1,
				identityDigest: IDENTITY_DIGEST,
			}),
		).toEqual({ valid: true, reason: "current_bound" });
		store.close();
	});

	it("rejects a late generation-1 bind after generation 2 was acquired", () => {
		const store = open();
		store.acquire(supervisor1);
		const second = store.acquire({
			...supervisor1,
			supervisorPid: 101,
			supervisorStart: "Thu Jul 16 01:01:00 2026",
			now: "2026-07-16T08:01:00.000Z",
		});
		expect(second).toEqual({ status: "acquired", generation: 2 });

		expect(
			store.bind({
				leadKey: supervisor1.leadKey,
				generation: 1,
				expectedSupervisorPid: 100,
				expectedSupervisorStart: supervisor1.supervisorStart,
				identityDigest: IDENTITY_DIGEST,
				panePid: 200,
				paneStart: "Thu Jul 16 01:00:01 2026",
				now: "2026-07-16T08:01:01.000Z",
			}),
		).toEqual({ status: "stale_generation", generation: 1 });
		expect(store.getLease(supervisor1.leadKey)).toMatchObject({
			generation: 2,
			holderPid: 101,
			boundAt: null,
		});
		expect(store.getGenerationHistory(supervisor1.leadKey, 1)).toBeUndefined();
		expect(store.getGenerationHistory(supervisor1.leadKey, 2)).toBeUndefined();
		store.close();
	});

	it("rejects stale ABA claims even when the old pane is still alive", () => {
		const store = open(new Set(["200:old-pane"]));
		store.acquire(supervisor1);
		store.bind({
			leadKey: supervisor1.leadKey,
			generation: 1,
			expectedSupervisorPid: 100,
			expectedSupervisorStart: supervisor1.supervisorStart,
			identityDigest: IDENTITY_DIGEST,
			panePid: 200,
			paneStart: "old-pane",
			now: "2026-07-16T08:00:01.000Z",
		});
		store.close();

		const takeover = open();
		expect(
			takeover.acquire({
				...supervisor1,
				supervisorPid: 101,
				supervisorStart: "new-supervisor",
			}),
		).toEqual({ status: "acquired", generation: 2 });
		expect(
			takeover.validate({
				leaseKey: supervisor1.leadKey,
				generation: 1,
				identityDigest: IDENTITY_DIGEST,
			}),
		).toEqual({ valid: false, reason: "stale_generation" });
		takeover.close();
	});

	it("makes repeated acquire by the same unbound supervisor idempotent", () => {
		const store = open();
		expect(store.acquire(supervisor1)).toEqual({
			status: "acquired",
			generation: 1,
		});
		expect(store.acquire(supervisor1)).toEqual({
			status: "idempotent",
			generation: 1,
		});
		expect(store.getLease(supervisor1.leadKey)?.generation).toBe(1);
		store.close();
	});

	it("re-stamps a changed identity digest only after the previous bound generation is dead", () => {
		const holderStart = "old-holder";
		const initial = open();
		initial.acquire(supervisor1);
		initial.bind({
			leadKey: supervisor1.leadKey,
			generation: 1,
			expectedSupervisorPid: supervisor1.supervisorPid,
			expectedSupervisorStart: supervisor1.supervisorStart,
			identityDigest: IDENTITY_DIGEST,
			panePid: 200,
			paneStart: holderStart,
		});
		initial.close();

		const changedDigest = "b".repeat(64);
		const restarted = openWithTupleStates({
			[`100:${supervisor1.supervisorStart}`]: "dead",
			[`200:${holderStart}`]: "dead",
		});
		expect(
			restarted.acquire({
				...supervisor1,
				identityDigest: changedDigest,
				supervisorPid: 101,
				supervisorStart: "new-supervisor",
			}),
		).toEqual({ status: "acquired", generation: 2 });
		expect(restarted.getLease(supervisor1.leadKey)).toMatchObject({
			identityDigest: changedDigest,
			generation: 2,
			supervisorPid: 101,
		});
		restarted.close();
	});

	it.each([
		["supervisor", `100:${supervisor1.supervisorStart}`],
		["holder", "200:old-holder"],
	])(
		"denies identity re-stamp while the previous %s tuple is alive",
		(_label, liveTuple) => {
			const initial = open();
			initial.acquire(supervisor1);
			initial.bind({
				leadKey: supervisor1.leadKey,
				generation: 1,
				expectedSupervisorPid: supervisor1.supervisorPid,
				expectedSupervisorStart: supervisor1.supervisorStart,
				identityDigest: IDENTITY_DIGEST,
				panePid: 200,
				paneStart: "old-holder",
			});
			initial.close();

			const contender = openWithTupleStates({ [liveTuple]: "alive" });
			expect(
				contender.acquire({
					...supervisor1,
					identityDigest: "b".repeat(64),
					supervisorPid: 101,
					supervisorStart: "new-supervisor",
				}),
			).toEqual({
				status: "denied_identity_drift_live",
				generation: 1,
			});
			expect(contender.getLease(supervisor1.leadKey)).toMatchObject({
				identityDigest: IDENTITY_DIGEST,
				generation: 1,
			});
			contender.close();
		},
	);

	it("keeps identity re-stamp fail closed when prior tuple liveness is unprovable", () => {
		const initial = open();
		initial.acquire(supervisor1);
		initial.close();

		const contender = openWithTupleStates({
			[`100:${supervisor1.supervisorStart}`]: "sensor_error",
		});
		expect(
			contender.acquire({
				...supervisor1,
				identityDigest: "b".repeat(64),
				supervisorPid: 101,
				supervisorStart: "new-supervisor",
			}),
		).toEqual({
			status: "denied_identity_drift_sensor_degraded",
			generation: 1,
		});
		contender.close();
	});

	it("denies a different supervisor while the unbound acquiring supervisor is alive", () => {
		const store = open(new Set([`100:${supervisor1.supervisorStart}`]));
		expect(store.acquire(supervisor1)).toEqual({
			status: "acquired",
			generation: 1,
		});
		expect(
			store.acquire({
				...supervisor1,
				supervisorPid: 101,
				supervisorStart: "Thu Jul 16 01:00:02 2026",
			}),
		).toEqual({ status: "denied_holder_alive", generation: 1 });
		expect(store.getLease(supervisor1.leadKey)).toMatchObject({
			generation: 1,
			holderPid: 100,
			boundAt: null,
		});
		store.close();
	});

	it("surfaces an orphan when the supervisor is dead but its bound pane is alive", () => {
		const holder = "Thu Jul 16 01:00:01 2026";
		const initial = open();
		initial.acquire(supervisor1);
		initial.bind({
			leadKey: supervisor1.leadKey,
			generation: 1,
			expectedSupervisorPid: 100,
			expectedSupervisorStart: supervisor1.supervisorStart,
			identityDigest: IDENTITY_DIGEST,
			panePid: 200,
			paneStart: holder,
			now: "2026-07-16T08:00:01.000Z",
		});
		initial.close();

		const contender = open(new Set([`200:${holder}`]));
		expect(
			contender.acquire({
				...supervisor1,
				supervisorPid: 101,
				supervisorStart: "new-supervisor",
			}),
		).toEqual({
			status: "holder_orphaned",
			generation: 1,
			holderPid: 200,
			holderStart: holder,
			supervisorPid: 100,
			supervisorStart: supervisor1.supervisorStart,
		});
		contender.close();
	});

	it("treats PID reuse with a mismatched lstart as dead and advances generation", () => {
		const initial = open();
		initial.acquire(supervisor1);
		initial.bind({
			leadKey: supervisor1.leadKey,
			generation: 1,
			expectedSupervisorPid: 100,
			expectedSupervisorStart: supervisor1.supervisorStart,
			identityDigest: IDENTITY_DIGEST,
			panePid: 200,
			paneStart: "old-start",
			now: "2026-07-16T08:00:01.000Z",
		});
		initial.close();

		const reused = open(new Set(["200:new-start"]));
		expect(
			reused.acquire({
				...supervisor1,
				supervisorPid: 101,
				supervisorStart: "new-supervisor",
			}),
		).toEqual({ status: "acquired", generation: 2 });
		reused.close();
	});

	it("does not validate the current generation until bind commits", () => {
		const store = open();
		store.acquire(supervisor1);
		expect(
			store.validate({
				leaseKey: supervisor1.leadKey,
				generation: 1,
				identityDigest: IDENTITY_DIGEST,
			}),
		).toEqual({ valid: false, reason: "unbound" });
		store.close();
	});

	it("records audit rows and only prunes rows already materialized", () => {
		const store = open();
		const pending = store.appendAudit({
			leadKey: supervisor1.leadKey,
			event: "would_block",
			detail: "stale_generation",
			createdAt: "2026-07-16T08:00:00.000Z",
		});
		const materialized = store.appendAudit({
			leadKey: supervisor1.leadKey,
			event: "blocked",
			detail: "missing_claim",
			createdAt: "2026-07-16T08:00:01.000Z",
		});
		store.markAuditMaterialized([materialized], "2026-07-16T08:01:00.000Z");

		expect(store.pruneMaterializedAudit(0)).toBe(1);
		expect(store.listPendingAudit().map((row) => row.id)).toEqual([pending]);
		store.close();
	});

	it("wraps an unusable database path as LeaseStoreError", () => {
		const unusable = join(dir, "directory.db");
		writeFileSync(unusable, "not a sqlite database");
		expect(() => new LeadLeaseStore(unusable)).toThrow(LeaseStoreError);
	});
});

describe("FLY-1309 independent lease mode control plane", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1309-mode-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("defaults to audit_only and atomically persists enforce independently of lease DB", () => {
		const modePath = join(dir, "lead-lease-mode.json");
		const dbPath = join(dir, "lead-lease.db");
		const modes = new LeadLeaseModeStore(modePath, {});
		expect(modes.read()).toEqual({ mode: "audit_only", source: "default" });
		modes.set("enforce", "test", "2026-07-16T08:00:00.000Z");

		const lease = new LeadLeaseStore(dbPath, {
			processAliveWithStart: () => false,
		});
		lease.close();
		rmSync(dbPath, { force: true });
		rmSync(`${dbPath}-wal`, { force: true });
		rmSync(`${dbPath}-shm`, { force: true });
		const rebuilt = new LeadLeaseStore(dbPath, {
			processAliveWithStart: () => false,
		});

		expect(modes.read()).toEqual({ mode: "enforce", source: "file" });
		expect(
			rebuilt.validate({
				leaseKey: "flywheel-eng-lead",
				generation: 1,
				identityDigest: "a".repeat(64),
			}),
		).toEqual({
			valid: false,
			reason: "missing_lease",
		});
		rebuilt.close();
	});

	it("treats a corrupt control file as enforce rather than falling open", () => {
		const modePath = join(dir, "lead-lease-mode.json");
		writeFileSync(modePath, "{broken");
		const modes = new LeadLeaseModeStore(modePath, {});
		expect(modes.read()).toEqual({
			mode: "enforce",
			source: "corrupt_file",
			error: expect.any(String),
		});
	});

	it("allows the explicit environment seam to override the file for tests", () => {
		const modePath = join(dir, "lead-lease-mode.json");
		const modes = new LeadLeaseModeStore(modePath, {
			FLYWHEEL_LEAD_LEASE_MODE: "off",
		});
		modes.set("enforce", "test", "2026-07-16T08:00:00.000Z");
		expect(modes.read()).toEqual({ mode: "off", source: "environment" });
	});
});
