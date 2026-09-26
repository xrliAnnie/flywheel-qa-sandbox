import { createHash } from "node:crypto";
import type { Database as BetterDb } from "better-sqlite3";
import { z } from "zod";
import type { StateStore } from "../StateStore.js";
import { ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES } from "../workflow-ledger-states.js";

const boundedText = z
	.string()
	.min(1)
	.max(4096)
	.regex(/^[^\p{Cc}]+$/u);
const identityText = boundedText.max(256);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const processIdentity = z
	.object({
		pid: positive.min(2),
		startIdentity: identityText,
		hostBootId: identityText,
	})
	.strict();
const bindingSchema = z
	.object({
		version: z.literal(1),
		adapter: z.enum([
			"codex-tmux",
			"claude-tmux",
			"kimi-tmux",
			"antigravity-tmux",
		]),
		pid: positive.min(2),
		pgid: positive.min(2),
		startIdentity: identityText,
		hostBootId: identityText,
		executable: boundedText,
		cwd: boundedText,
		nonce: identityText,
		nativeSessionId: identityText.nullable(),
		writers: z.array(processIdentity).max(4096),
	})
	.strict();

/** Accepted only from the Bridge's independent OS verifier, never an HTTP payload. */
export type ExecutionProcessBinding = z.infer<typeof bindingSchema>;
export interface ProcessOwnerIdentity {
	executionId: string;
	activationId: string | null;
	generation: number;
	ownerToken: string;
}
export interface ProcessSpawnPermit extends ProcessOwnerIdentity {
	spawnEpoch: number;
}
/** Bridge-internal result of cooperative drain followed by independent OS
 * verification. A released registry lease alone is never a stopped controller.
 * This input must not be exposed through Runner HTTP or CLI payloads. */
export interface ProcessOwnerDrainEvidence extends ProcessSpawnPermit {
	controller: z.infer<typeof processIdentity>;
	bindingDigest: string | null;
	controllerState: "stopped" | "absent" | "alive" | "unknown";
	groupState: "absent" | "alive" | "unknown";
	writersState: "absent" | "alive" | "unknown";
	observedAtMs: number;
	expiresAtMs: number;
}
interface MutationInput extends ProcessOwnerIdentity {
	lifecycleRevision: number;
	nowMs: number;
}
type SpawnMutation = MutationInput & { spawnEpoch: number };
type Result<T = object> = ({ ok: true } & T) | { ok: false; reason: string };
type LeaseStore = Pick<
	StateStore,
	| "getSession"
	| "getWorkflowActor"
	| "getWorkflowActivation"
	| "getWorkflowExecutionProcessBody"
	| "claimExecutionMutationLease"
	| "commitExecutionMutationLease"
>;

export interface ExecutionProcessOwnerRow {
	execution_id: string;
	activation_id: string | null;
	generation: number;
	owner_token: string;
	controller_pid: number;
	controller_start: string;
	host_boot_id: string;
	spawn_epoch: number;
	restart_in_progress: 0 | 1;
	spawn_inflight: 0 | 1;
	close_requested: 0 | 1;
	binding_json: string | null;
	binding_digest: string | null;
	owner_drained_at: string | null;
	owner_drained_receipt: string | null;
}

/** Identity and launch exclusivity only. This table never asserts alive/dead. */
export class ExecutionProcessOwnerStore {
	constructor(
		private readonly db: BetterDb,
		private readonly store: LeaseStore,
	) {}

	migrate(): void {
		this.db.exec(`CREATE TABLE IF NOT EXISTS execution_process_owner (
			execution_id TEXT PRIMARY KEY REFERENCES sessions(execution_id),
			activation_id TEXT,
			generation INTEGER NOT NULL CHECK (generation > 0),
			owner_token TEXT NOT NULL,
			controller_pid INTEGER NOT NULL CHECK (controller_pid > 1),
			controller_start TEXT NOT NULL,
			host_boot_id TEXT NOT NULL,
			spawn_epoch INTEGER NOT NULL DEFAULT 0 CHECK (spawn_epoch >= 0),
			restart_in_progress INTEGER NOT NULL DEFAULT 0 CHECK (restart_in_progress IN (0,1)),
			spawn_inflight INTEGER NOT NULL DEFAULT 0 CHECK (spawn_inflight IN (0,1)),
			close_requested INTEGER NOT NULL DEFAULT 0 CHECK (close_requested IN (0,1)),
			binding_json TEXT,
			binding_digest TEXT,
			owner_drained_at TEXT,
			owner_drained_receipt TEXT
		)`);
	}

	get(executionId: string): ExecutionProcessOwnerRow | undefined {
		return this.db
			.prepare("SELECT * FROM execution_process_owner WHERE execution_id = ?")
			.get(executionId) as ExecutionProcessOwnerRow | undefined;
	}

	claim(
		input: MutationInput & { controller: z.infer<typeof processIdentity> },
	): Result {
		const controller = processIdentity.parse(input.controller);
		return this.mutate(input, () => {
			const fresh = this.fresh(input, true);
			if (fresh) return { ok: false, reason: fresh };
			const prior = this.get(input.executionId);
			if (prior) {
				if (this.sameOwner(prior, input)) {
					if (prior.close_requested || prior.owner_drained_at)
						return { ok: false, reason: "close_requested" };
					return prior.controller_pid === controller.pid &&
						prior.controller_start === controller.startIdentity &&
						prior.host_boot_id === controller.hostBootId
						? { ok: true }
						: { ok: false, reason: "controller_identity_changed" };
				}
				if (
					!prior.owner_drained_at ||
					!prior.owner_drained_receipt ||
					prior.spawn_inflight
				)
					return { ok: false, reason: "owner_not_drained" };
				if (
					input.generation <= prior.generation ||
					input.ownerToken === prior.owner_token
				)
					return { ok: false, reason: "generation_not_advanced" };
			}
			this.db
				.prepare(`INSERT INTO execution_process_owner
				(execution_id, activation_id, generation, owner_token, controller_pid, controller_start, host_boot_id)
				VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(execution_id) DO UPDATE SET
				activation_id = excluded.activation_id, generation = excluded.generation,
				owner_token = excluded.owner_token, controller_pid = excluded.controller_pid,
				controller_start = excluded.controller_start, host_boot_id = excluded.host_boot_id,
				spawn_epoch = 0, restart_in_progress = 0, spawn_inflight = 0,
				close_requested = 0, binding_json = NULL, binding_digest = NULL,
				owner_drained_at = NULL, owner_drained_receipt = NULL`)
				.run(
					input.executionId,
					input.activationId,
					input.generation,
					input.ownerToken,
					controller.pid,
					controller.startIdentity,
					controller.hostBootId,
				);
			return { ok: true };
		});
	}

	beginSpawn(input: SpawnMutation): Result<{ permit: ProcessSpawnPermit }> {
		return this.mutate(input, () => {
			const checked = this.checkOwner(input, true);
			if (!checked.ok) return checked;
			const row = checked.row;
			if (row.close_requested || row.owner_drained_at)
				return { ok: false, reason: "close_requested" };
			if (row.spawn_inflight) return { ok: false, reason: "spawn_inflight" };
			if (row.spawn_epoch > 0 && !row.restart_in_progress)
				return { ok: false, reason: "restart_not_started" };
			if (row.spawn_epoch === Number.MAX_SAFE_INTEGER)
				return { ok: false, reason: "spawn_epoch_exhausted" };
			this.db
				.prepare(
					"UPDATE execution_process_owner SET spawn_epoch = spawn_epoch + 1, spawn_inflight = 1 WHERE execution_id = ?",
				)
				.run(input.executionId);
			return {
				ok: true,
				permit: {
					executionId: input.executionId,
					activationId: input.activationId,
					generation: input.generation,
					ownerToken: input.ownerToken,
					spawnEpoch: row.spawn_epoch + 1,
				},
			};
		});
	}

	beginRestart(input: SpawnMutation): Result {
		return this.mutate(input, () => {
			const checked = this.checkOwner(input, true);
			if (!checked.ok) return checked;
			if (checked.row.close_requested || checked.row.owner_drained_at)
				return { ok: false, reason: "close_requested" };
			if (checked.row.spawn_inflight)
				return { ok: false, reason: "spawn_inflight" };
			if (!checked.row.binding_digest)
				return { ok: false, reason: "binding_missing" };
			this.db
				.prepare(
					"UPDATE execution_process_owner SET restart_in_progress = 1 WHERE execution_id = ?",
				)
				.run(input.executionId);
			return { ok: true };
		});
	}

	acceptSpawn(
		input: SpawnMutation & { binding: ExecutionProcessBinding },
	): Result<{ bindingDigest: string }> {
		// Bound and validate BEFORE taking a lease; malformed input cannot strand one.
		if (Buffer.byteLength(JSON.stringify(input.binding)) > 1024 * 1024)
			throw new Error("process_binding_oversize");
		const binding = bindingSchema.parse(input.binding);
		return this.mutate(input, () => {
			const checked = this.checkOwner(input, false);
			if (!checked.ok) return checked;
			if (
				binding.hostBootId !== checked.row.host_boot_id ||
				binding.writers.some(
					(writer) => writer.hostBootId !== binding.hostBootId,
				)
			)
				throw new Error("process_binding_boot_mismatch");
			const bindingJson = JSON.stringify(binding);
			const digest = createHash("sha256")
				.update(
					JSON.stringify([
						input.executionId,
						input.activationId,
						input.generation,
						input.ownerToken,
						input.spawnEpoch,
						binding,
					]),
				)
				.digest("hex");
			if (!checked.row.spawn_inflight)
				return checked.row.binding_digest === digest
					? { ok: true, bindingDigest: digest }
					: { ok: false, reason: "spawn_not_inflight" };
			// Even a close racing admission must retain the newborn's identity for
			// cleanup/restart recovery. close_requested continues to veto all work.
			this.db
				.prepare(`UPDATE execution_process_owner SET binding_json = ?, binding_digest = ?,
				spawn_inflight = 0, restart_in_progress = 0 WHERE execution_id = ?`)
				.run(bindingJson, digest, input.executionId);
			return { ok: true, bindingDigest: digest };
		});
	}

	requestClose(input: SpawnMutation): Result {
		return this.mutate(input, () => {
			const checked = this.checkOwner(input, false);
			if (!checked.ok) return checked;
			this.db
				.prepare(
					"UPDATE execution_process_owner SET close_requested = 1 WHERE execution_id = ?",
				)
				.run(input.executionId);
			return { ok: true };
		});
	}

	recordDrained(
		input: SpawnMutation & {
			evidence: ProcessOwnerDrainEvidence;
			reason: string;
		},
	): Result<{ receipt: string }> {
		const reason = identityText.parse(input.reason);
		return this.mutate(input, () => {
			const checked = this.checkOwner(input, false);
			if (!checked.ok) return checked;
			const row = checked.row;
			if (row.spawn_inflight) return { ok: false, reason: "spawn_inflight" };
			if (!row.close_requested)
				return { ok: false, reason: "owner_not_closed" };
			const evidence = input.evidence;
			if (
				!this.sameOwner(row, evidence) ||
				evidence.spawnEpoch !== row.spawn_epoch ||
				evidence.bindingDigest !== row.binding_digest ||
				evidence.controller.pid !== row.controller_pid ||
				evidence.controller.startIdentity !== row.controller_start ||
				evidence.controller.hostBootId !== row.host_boot_id
			)
				return { ok: false, reason: "drain_identity_changed" };
			if (
				!Number.isSafeInteger(evidence.observedAtMs) ||
				evidence.observedAtMs < 0 ||
				!Number.isSafeInteger(evidence.expiresAtMs) ||
				evidence.observedAtMs > input.nowMs ||
				evidence.expiresAtMs <= input.nowMs ||
				evidence.expiresAtMs - evidence.observedAtMs > 10_000
			)
				return { ok: false, reason: "drain_evidence_expired" };
			if (
				(evidence.controllerState !== "stopped" &&
					evidence.controllerState !== "absent") ||
				evidence.groupState !== "absent" ||
				evidence.writersState !== "absent"
			)
				return { ok: false, reason: "drain_unconfirmed" };
			if (row.owner_drained_receipt && row.owner_drained_at)
				return { ok: true, receipt: row.owner_drained_receipt };
			const receipt = createHash("sha256")
				.update(JSON.stringify({ version: 1, evidence, reason }))
				.digest("hex");
			this.db
				.prepare(`UPDATE execution_process_owner SET
				owner_drained_at = ?, owner_drained_receipt = ?, restart_in_progress = 0
				WHERE execution_id = ?`)
				.run(new Date(input.nowMs).toISOString(), receipt, input.executionId);
			return { ok: true, receipt };
		});
	}

	authorizeSpawn(
		permit: ProcessSpawnPermit,
		lifecycleRevision: number,
	): boolean {
		const checked = this.checkOwner(
			{ ...permit, lifecycleRevision, nowMs: 0 },
			true,
		);
		return (
			checked.ok &&
			checked.row.close_requested === 0 &&
			checked.row.owner_drained_at === null
		);
	}

	private sameOwner(
		row: ExecutionProcessOwnerRow,
		input: ProcessOwnerIdentity,
	): boolean {
		return (
			row.execution_id === input.executionId &&
			row.activation_id === input.activationId &&
			row.generation === input.generation &&
			row.owner_token === input.ownerToken
		);
	}

	private fresh(input: MutationInput, launch: boolean): string | undefined {
		const session = this.store.getSession(input.executionId);
		if (!session) return "session_missing";
		if ((session.lifecycle_revision ?? 0) !== input.lifecycleRevision)
			return "stale_revision";
		if (
			launch &&
			(ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES as readonly string[]).includes(
				session.status,
			)
		)
			return "session_terminal";
		const body = this.store.getWorkflowExecutionProcessBody(input.executionId);
		if ((body?.generation ?? 1) !== input.generation)
			return "generation_changed";
		if (launch && body && body.state !== "active" && body.state !== "resuming")
			return "process_body_not_startable";
		if (input.activationId === null) {
			if (this.store.getWorkflowActor(input.executionId))
				return "activation_missing";
		} else if (
			this.store.getWorkflowActivation(input.activationId)?.execution_id !==
			input.executionId
		)
			return "activation_changed";
		return undefined;
	}

	private checkOwner(
		input: SpawnMutation,
		launch: boolean,
	): Result<{ row: ExecutionProcessOwnerRow }> {
		const fresh = this.fresh(input, launch);
		if (fresh) return { ok: false, reason: fresh };
		const row = this.get(input.executionId);
		if (!row) return { ok: false, reason: "owner_missing" };
		if (!this.sameOwner(row, input))
			return { ok: false, reason: "owner_changed" };
		if (row.spawn_epoch !== input.spawnEpoch)
			return { ok: false, reason: "spawn_epoch_changed" };
		return { ok: true, row };
	}

	private mutate<T extends object>(
		input: MutationInput,
		operation: () => Result<T>,
	): Result<T> {
		identityText.parse(input.executionId);
		identityText.parse(input.ownerToken);
		if (input.activationId !== null) identityText.parse(input.activationId);
		positive.parse(input.generation);
		z.number()
			.int()
			.nonnegative()
			.max(Number.MAX_SAFE_INTEGER)
			.parse(input.lifecycleRevision);
		z.number()
			.int()
			.nonnegative()
			.max(Number.MAX_SAFE_INTEGER - 60_000)
			.parse(input.nowMs);
		return this.db
			.transaction((): Result<T> => {
				const lease = this.store.claimExecutionMutationLease(
					input.executionId,
					input.lifecycleRevision,
					{
						holder: `process-owner:${input.ownerToken}`,
						nowMs: input.nowMs,
						ttlMs: 60_000,
					},
				);
				if (!lease.ok) return { ok: false, reason: lease.reason };
				const result = operation();
				const committed = this.store.commitExecutionMutationLease(
					input.executionId,
					lease.claimToken,
					input.lifecycleRevision,
					input.nowMs,
				);
				if (!committed.ok)
					throw new Error(`process_owner_mutation_commit:${committed.reason}`);
				return result;
			})
			.immediate();
	}
}
