import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../StateStore.js";

describe("FLY-2919 execution process owner", () => {
	let store: StateStore;
	let root: string;
	let revision: number;
	const owner = {
		executionId: "exec-1",
		activationId: null,
		generation: 1,
		ownerToken: "owner-1",
		controller: {
			pid: 100,
			startIdentity: "controller-start",
			hostBootId: "boot-1",
		},
	};
	const binding = {
		version: 1 as const,
		adapter: "codex-tmux" as const,
		pid: 200,
		pgid: 200,
		startIdentity: "daemon-start",
		hostBootId: "boot-1",
		executable: "/bin/codex",
		cwd: "/work/FLY-2919",
		nonce: "spawn-nonce-1",
		nativeSessionId: null,
		writers: [],
	};
	const owners = () => {
		expect(store.executionProcessOwners).toBeDefined();
		return store.executionProcessOwners;
	};
	const claim = () =>
		owners().claim({ ...owner, lifecycleRevision: revision, nowMs: 1_000 });
	const spawn = () =>
		owners().beginSpawn({
			...owner,
			lifecycleRevision: revision,
			spawnEpoch: 0,
			nowMs: 1_001,
		});

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "fly2919-owner-"));
		store = await StateStore.create(join(root, "fixture.db"));
		store.upsertSession({
			execution_id: owner.executionId,
			issue_id: "FLY-2919",
			project_name: "fixture",
			status: "running",
		});
		revision = store.getLifecycleRevision(owner.executionId);
	});
	afterEach(() => {
		store.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("retains an in-flight spawn after reopen and past mutation-lease TTL", async () => {
		expect(claim()).toMatchObject({ ok: true });
		const result = spawn();
		expect(result).toMatchObject({
			ok: true,
			permit: { spawnEpoch: 1, ownerToken: "owner-1" },
		});
		store.close();
		store = await StateStore.create(join(root, "fixture.db"));
		expect(owners().get("exec-1")).toMatchObject({
			spawn_inflight: 1,
			spawn_epoch: 1,
		});
		expect(
			owners().beginSpawn({
				...owner,
				lifecycleRevision: revision,
				spawnEpoch: 1,
				nowMs: 121_002,
			}),
		).toMatchObject({ ok: false, reason: "spawn_inflight" });
		expect(
			owners().claim({
				...owner,
				ownerToken: "owner-2",
				lifecycleRevision: revision,
				nowMs: 121_003,
			}),
		).toMatchObject({ ok: false, reason: "owner_not_drained" });
	});

	it("an owner claim without a native spawn permit never authorizes spawning", () => {
		claim();
		expect(owners().authorizeSpawn({ ...owner, spawnEpoch: 0 }, revision)).toBe(
			false,
		);
	});

	it("closes a permit while preserving its newborn binding for recovery", () => {
		claim();
		const result = spawn();
		if (!result.ok) throw new Error("fixture spawn refused");
		expect(owners().authorizeSpawn(result.permit, revision)).toBe(true);
		expect(
			owners().requestClose({
				...result.permit,
				lifecycleRevision: revision,
				nowMs: 1_002,
			}),
		).toMatchObject({ ok: true });
		expect(owners().authorizeSpawn(result.permit, revision)).toBe(false);
		const accepted = owners().acceptSpawn({
			...result.permit,
			lifecycleRevision: revision,
			nowMs: 1_003,
			binding,
		});
		expect(accepted).toMatchObject({ ok: true });
		expect(owners().get("exec-1")).toMatchObject({
			close_requested: 1,
			spawn_inflight: 0,
			binding_json: JSON.stringify(binding),
		});
		expect(owners().authorizeSpawn(result.permit, revision)).toBe(false);
	});

	it("allows same-owner restart only after the preceding spawn has been accepted", () => {
		claim();
		const result = spawn();
		if (!result.ok) throw new Error("fixture spawn refused");
		const input = {
			...result.permit,
			lifecycleRevision: revision,
			nowMs: 1_002,
		};
		expect(owners().beginRestart(input)).toMatchObject({
			ok: false,
			reason: "spawn_inflight",
		});
		expect(owners().acceptSpawn({ ...input, binding })).toMatchObject({
			ok: true,
		});
		expect(owners().beginSpawn(input)).toMatchObject({
			ok: false,
			reason: "restart_not_started",
		});
		expect(owners().beginRestart(input)).toMatchObject({ ok: true });
		expect(owners().beginSpawn(input)).toMatchObject({
			ok: true,
			permit: { spawnEpoch: 2 },
		});
		expect(owners().authorizeSpawn(result.permit, revision)).toBe(false);
		expect(owners().acceptSpawn({ ...input, binding })).toMatchObject({
			ok: false,
			reason: "spawn_epoch_changed",
		});
	});

	it("lease contention refuses only this mutation and leaves the owner restartable", () => {
		claim();
		const lease = store.claimExecutionMutationLease("exec-1", revision, {
			holder: "fixture-other",
			nowMs: 1_000,
			ttlMs: 60_000,
		});
		if (!lease.ok) throw new Error("fixture lease refused");
		expect(spawn()).toMatchObject({ ok: false, reason: "lease_held" });
		expect(owners().get("exec-1")).toMatchObject({
			close_requested: 0,
			spawn_epoch: 0,
		});
		store.commitExecutionMutationLease(
			"exec-1",
			lease.claimToken,
			revision,
			1_002,
		);
		expect(spawn()).toMatchObject({ ok: true });
	});

	it.each(["session", "revision", "owner", "generation", "activation"])(
		"refuses stale %s before opening a spawn permit",
		(kind) => {
			claim();
			const input = {
				...owner,
				lifecycleRevision: revision,
				spawnEpoch: 0,
				nowMs: 1_001,
			};
			if (kind === "session") input.executionId = "missing";
			if (kind === "revision") input.lifecycleRevision += 1;
			if (kind === "owner") input.ownerToken = "foreign";
			if (kind === "generation") input.generation += 1;
			if (kind === "activation")
				Object.assign(input, { activationId: "foreign-activation" });
			expect(owners().beginSpawn(input).ok).toBe(false);
			expect(owners().get("exec-1")).toMatchObject({
				spawn_inflight: 0,
				spawn_epoch: 0,
			});
		},
	);

	it.each(["pid", "pgid", "boot", "oversize"])(
		"invalid %s binding leaves the spawn in flight",
		(kind) => {
			claim();
			const result = spawn();
			if (!result.ok) throw new Error("fixture spawn refused");
			const invalid = { ...binding };
			if (kind === "pid") invalid.pid = 0;
			if (kind === "pgid") invalid.pgid = 0;
			if (kind === "boot") invalid.hostBootId = "different-boot";
			if (kind === "oversize") invalid.nonce = "x".repeat(100_000);
			expect(() =>
				owners().acceptSpawn({
					...result.permit,
					lifecycleRevision: revision,
					nowMs: 1_002,
					binding: invalid,
				}),
			).toThrow();
			expect(owners().get("exec-1")).toMatchObject({
				spawn_inflight: 1,
				binding_json: null,
			});
		},
	);

	const drainFixture = () => {
		claim();
		const started = spawn();
		if (!started.ok) throw new Error("fixture spawn refused");
		const input = {
			...started.permit,
			lifecycleRevision: revision,
			nowMs: 1_010,
		};
		const accepted = owners().acceptSpawn({ ...input, binding });
		if (!accepted.ok) throw new Error("fixture identity refused");
		owners().requestClose(input);
		return {
			...input,
			evidence: {
				...started.permit,
				controller: owner.controller,
				bindingDigest: accepted.bindingDigest,
				controllerState: "stopped" as const,
				groupState: "absent" as const,
				writersState: "absent" as const,
				observedAtMs: 1_005,
				expiresAtMs: 11_005,
			},
			reason: "process_retirement",
		};
	};

	it.each([
		"valid",
		"expired",
		"foreign_claim",
		"foreign_binding",
		"not_drained",
	])("same-generation reown requires exact %s recovery authority", (kind) => {
		const prior = drainFixture();
		if (kind !== "not_drained")
			expect(owners().recordDrained(prior).ok).toBe(true);
		const claim = store.claimCodexRecovery("exec-1", revision, {
			holder: "reowner",
			nowMs: 1100,
			ttlMs: 1000,
		});
		if (!claim.ok) throw new Error(`fixture recovery refused:${claim.reason}`);
		const input = {
			...owner,
			ownerToken: "owner-2",
			controller: { ...owner.controller, pid: 101 },
			lifecycleRevision: revision,
			nowMs: kind === "expired" ? 2100 : 1101,
			recoveryClaimToken: claim.claimToken,
			recovery: {
				claimToken: kind === "foreign_claim" ? "foreign" : claim.claimToken,
				priorOwnerToken: owner.ownerToken,
				priorSpawnEpoch: prior.spawnEpoch,
				priorBindingDigest:
					kind === "foreign_binding" ? "foreign" : prior.evidence.bindingDigest,
			},
		};
		const result = owners().claim(input);
		if (kind === "valid") {
			expect(result).toEqual({ ok: true });
			expect(owners().beginSpawn({ ...input, spawnEpoch: 1 })).toMatchObject({
				ok: true,
				permit: { spawnEpoch: 2, ownerToken: "owner-2" },
			});
			expect(store.getCodexRecoveryEpisode("exec-1")?.claimToken).toBe(
				claim.claimToken,
			);
		} else expect(result.ok).toBe(false);
	});

	it("replays a persisted drain after evidence expiry without granting a foreign identity its receipt", async () => {
		const input = drainFixture();
		const result = owners().recordDrained(input);
		expect(result.ok).toBe(true);
		store.close();
		store = await StateStore.create(join(root, "fixture.db"));
		const replay = { ...input, nowMs: 60_000 };
		expect(owners().recordDrained(replay)).toEqual(result);
		expect(
			owners().recordDrained({
				...replay,
				evidence: { ...input.evidence, ownerToken: "foreign-owner" },
			}),
		).toMatchObject({ ok: false, reason: "drain_identity_changed" });
	});

	it("persists exact drained evidence and admits only the approved next generation", async () => {
		const input = drainFixture();
		expect(owners().recordDrained).toBeTypeOf("function");
		const result = owners().recordDrained(input);
		expect(result).toMatchObject({ ok: true, receipt: expect.any(String) });
		if (!result.ok) throw new Error("fixture drain refused");
		expect(owners().recordDrained({ ...input, nowMs: 1_011 })).toEqual(result);
		store.close();
		store = await StateStore.create(join(root, "fixture.db"));
		expect(owners().get("exec-1")).toMatchObject({
			close_requested: 1,
			owner_drained_receipt: result.receipt,
		});
		expect(owners().authorizeSpawn(input, revision)).toBe(false);
		expect(
			owners().claim({
				...owner,
				ownerToken: "owner-2",
				lifecycleRevision: revision,
				nowMs: 1_012,
			}),
		).toMatchObject({ ok: false, reason: "generation_not_advanced" });
		// Fixture for an approved resume: the existing workflow owns generation allocation.
		const db = new Database(join(root, "fixture.db"));
		try {
			db.prepare(
				"INSERT INTO workflow_actor (execution_id, project_name, issue_id, role, created_at) VALUES (?, 'fixture', 'FLY-2919', 'implement', ?)",
			).run("exec-1", new Date(1_012).toISOString());
			db.prepare(
				"INSERT INTO workflow_execution_binding (activation_id, execution_id, run_id, node_id, attempt, mode, bound_at) VALUES ('activation-2', ?, 'run-1', 'implement', 2, 'wake', ?)",
			).run("exec-1", new Date(1_012).toISOString());
			db.prepare(
				"INSERT INTO workflow_execution_runtime (execution_id, run_id, node_id, attempt, vendor, model, effort, resolved_family, capabilities_digest, created_at) VALUES (?, 'run-1', 'implement', 2, 'codex', 'fixture', 'fixture', 'codex', ?, ?)",
			).run("exec-1", "a".repeat(64), new Date(1_012).toISOString());
			db.prepare(
				"INSERT INTO workflow_execution_process_body (execution_id, generation, state, started_at, updated_at) VALUES (?, 2, 'resuming', ?, ?)",
			).run(
				"exec-1",
				new Date(1_012).toISOString(),
				new Date(1_012).toISOString(),
			);
		} finally {
			db.close();
		}
		expect(
			owners().claim({
				...owner,
				activationId: "activation-2",
				generation: 2,
				ownerToken: "owner-2",
				lifecycleRevision: revision,
				nowMs: 1_013,
			}),
		).toEqual({ ok: true });
		expect(owners().recordDrained(input).ok).toBe(false);
		expect(owners().requestClose(input).ok).toBe(false);
		expect(owners().get("exec-1")).toMatchObject({
			owner_token: "owner-2",
			generation: 2,
			close_requested: 0,
			owner_drained_receipt: null,
		});
	});

	it("rolls back both the owner write and lease acquisition when the final lease CAS fails", () => {
		const commit = vi
			.spyOn(store, "commitExecutionMutationLease")
			.mockReturnValueOnce({ ok: false, reason: "stale_revision" });
		expect(claim).toThrow("process_owner_mutation_commit:stale_revision");
		expect(owners().get("exec-1")).toBeUndefined();
		commit.mockRestore();
		expect(claim()).toEqual({ ok: true });
	});

	it.each([
		"expired",
		"future",
		"owner",
		"epoch",
		"binding",
		"controller",
		"released_only",
		"group_alive",
		"writers_unknown",
	])("refuses %s drain evidence", (kind) => {
		const input = drainFixture();
		if (kind === "expired") input.nowMs = input.evidence.expiresAtMs;
		if (kind === "future") input.evidence.observedAtMs = input.nowMs + 1;
		if (kind === "owner") input.evidence.ownerToken = "foreign-owner";
		if (kind === "epoch") input.evidence.spawnEpoch += 1;
		if (kind === "binding") input.evidence.bindingDigest = "f".repeat(64);
		if (kind === "controller")
			input.evidence.controller = {
				...owner.controller,
				startIdentity: "reused-controller-pid",
			};
		if (kind === "released_only")
			Object.assign(input.evidence, { controllerState: "released" });
		if (kind === "group_alive")
			Object.assign(input.evidence, { groupState: "alive" });
		if (kind === "writers_unknown")
			Object.assign(input.evidence, { writersState: "unknown" });
		expect(owners().recordDrained).toBeTypeOf("function");
		expect(owners().recordDrained(input).ok).toBe(false);
		expect(owners().get("exec-1")).toMatchObject({
			owner_drained_at: null,
			owner_drained_receipt: null,
		});
	});

	it("cannot drain an unresolved native spawn even after close and lease expiry", () => {
		claim();
		const started = spawn();
		if (!started.ok) throw new Error("fixture spawn refused");
		const input = {
			...started.permit,
			lifecycleRevision: revision,
			nowMs: 121_001,
		};
		owners().requestClose(input);
		expect(owners().recordDrained).toBeTypeOf("function");
		expect(
			owners().recordDrained({
				...input,
				reason: "terminate",
				evidence: {
					...started.permit,
					controller: owner.controller,
					bindingDigest: null,
					controllerState: "stopped",
					groupState: "absent",
					writersState: "absent",
					observedAtMs: 121_000,
					expiresAtMs: 131_000,
				},
			}),
		).toMatchObject({ ok: false, reason: "spawn_inflight" });
		expect(owners().get("exec-1")).toMatchObject({
			spawn_inflight: 1,
			owner_drained_receipt: null,
		});
	});
});
