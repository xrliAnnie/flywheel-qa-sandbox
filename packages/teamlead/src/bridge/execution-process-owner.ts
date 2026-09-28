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
		nonce: identityText.nullable(),
		legacyExecutionId: identityText.optional(),
		nativeSessionId: identityText.nullable(),
		writers: z.array(processIdentity).max(4096),
	})
	.strict()
	.refine(
		(binding) =>
			binding.legacyExecutionId === undefined
				? binding.nonce !== null
				: binding.adapter === "claude-tmux" &&
					binding.nonce === null &&
					binding.nativeSessionId !== null,
		"invalid_legacy_process_binding",
	);

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
export interface ProcessRecoveryAdmission {
	claimToken: string;
	priorOwnerToken: string;
	priorSpawnEpoch: number;
	priorBindingDigest: string | null;
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
	/** Reuse the still-current FLY-2211 reservation; never replace or settle it. */
	recoveryClaimToken?: string;
}
type SpawnMutation = MutationInput & { spawnEpoch: number };
type Result<T = object> = ({ ok: true } & T) | { ok: false; reason: string };
type LeaseStore = Pick<
	StateStore,
	| "getSession"
	| "getWorkflowActor"
	| "getWorkflowActivation"
	| "resolveCurrentWorkflowActivation"
	| "getWorkflowExecutionProcessBody"
	| "getCodexRecoveryEpisode"
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
	spawn_nonce: string | null;
	pending_pgid: number | null;
	binding_spawn_epoch: number | null;
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

		const columns = new Set(
			(
				this.db
					.prepare("PRAGMA table_info(execution_process_owner)")
					.all() as Array<{ name: string }>
			).map((column) => column.name),
		);
		for (const [name, type] of [
			["spawn_nonce", "TEXT"],
			["pending_pgid", "INTEGER"],
			["binding_spawn_epoch", "INTEGER"],
		] as const) {
			if (!columns.has(name))
				this.db.exec(
					`ALTER TABLE execution_process_owner ADD COLUMN ${name} ${type}`,
				);
		}
		this.db.exec(
			"UPDATE execution_process_owner SET binding_spawn_epoch = spawn_epoch WHERE binding_json IS NOT NULL AND binding_spawn_epoch IS NULL AND spawn_inflight = 0",
		);
	}

	/** Scheduling inventory, never a liveness verdict. Business-terminal labels
	 * cannot hide an owner until close/drain and the same-generation physical
	 * body settlement are recorded. Owner drain alone still needs convergence. */
	listObservationCandidates(): string[] {
		return (
			this.db
				.prepare(`SELECT owner.execution_id FROM execution_process_owner owner
			WHERE NOT (owner.close_requested = 1
			AND owner.owner_drained_receipt IS NOT NULL
			AND owner.spawn_inflight = 0 AND owner.restart_in_progress = 0
			AND (EXISTS (SELECT 1 FROM workflow_run_event projected
				WHERE projected.event_uid = 'body_death:' || owner.execution_id || ':' || owner.generation || ':projected')
			OR EXISTS (SELECT 1 FROM workflow_terminal_archive projected
				WHERE projected.source_table = 'workflow_run_event'
				AND json_extract(projected.row_json,'$.event_uid') = 'body_death:' || owner.execution_id || ':' || owner.generation || ':projected')
			OR EXISTS (SELECT 1 FROM session_events projected
				WHERE projected.event_id = 'body_death:' || owner.execution_id || ':' || owner.generation || ':projected')
			OR EXISTS (SELECT 1 FROM workflow_terminal_archive projected
				WHERE projected.source_table = 'session_events'
				AND json_extract(projected.row_json,'$.event_id') = 'body_death:' || owner.execution_id || ':' || owner.generation || ':projected')))
			UNION SELECT session.execution_id FROM sessions session
			WHERE session.adapter_type = 'claude-tmux'
			AND session.status IN ('running', 'ship_parked', 'awaiting_review', 'design_done', 'approved_to_ship', 'pending')
			AND NOT EXISTS (SELECT 1 FROM execution_process_owner owner WHERE owner.execution_id = session.execution_id)
			ORDER BY execution_id`)
				.all() as Array<{ execution_id: string }>
		).map((row) => row.execution_id);
	}

	get(executionId: string): ExecutionProcessOwnerRow | undefined {
		return this.db
			.prepare("SELECT * FROM execution_process_owner WHERE execution_id = ?")
			.get(executionId) as ExecutionProcessOwnerRow | undefined;
	}

	getBinding(executionId: string): ExecutionProcessBinding | undefined {
		return this.readBinding(executionId, false);
	}
	getPreviousBinding(executionId: string): ExecutionProcessBinding | undefined {
		return this.readBinding(executionId, true);
	}
	private readBinding(
		executionId: string,
		previous: boolean,
	): ExecutionProcessBinding | undefined {
		const row = this.get(executionId);
		if (
			!row?.binding_json ||
			Boolean(row.spawn_inflight) !== previous ||
			row.binding_spawn_epoch === null ||
			!row.binding_digest ||
			Buffer.byteLength(row.binding_json) > 1024 * 1024
		)
			return undefined;
		try {
			const binding = bindingSchema.parse(JSON.parse(row.binding_json));
			const digest = createHash("sha256")
				.update(
					JSON.stringify([
						row.execution_id,
						row.activation_id,
						row.generation,
						row.owner_token,
						row.binding_spawn_epoch,
						binding,
					]),
				)
				.digest("hex");
			return digest === row.binding_digest ? binding : undefined;
		} catch {
			return undefined;
		}
	}

	claim(
		input: MutationInput & {
			controller: z.infer<typeof processIdentity>;
			recovery?: ProcessRecoveryAdmission;
		},
	): Result {
		const controller = processIdentity.parse(input.controller);
		return this.mutate(input, () => {
			const fresh = this.fresh(input, true);
			if (fresh) return { ok: false, reason: fresh };
			const prior = this.get(input.executionId);
			let recovery = false;
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
				if (input.recovery && input.generation === prior.generation) {
					const claim = this.store.getCodexRecoveryEpisode(input.executionId);
					recovery = Boolean(
						claim &&
							claim.episodeState === "open" &&
							claim.claimToken === input.recovery.claimToken &&
							claim.acquiredAtMs !== null &&
							claim.acquiredAtMs <= input.nowMs &&
							claim.expiresAtMs !== null &&
							claim.expiresAtMs > input.nowMs &&
							claim.expectedLifecycleRevision === input.lifecycleRevision &&
							input.recovery.priorOwnerToken === prior.owner_token &&
							input.recovery.priorSpawnEpoch === prior.spawn_epoch &&
							input.recovery.priorBindingDigest === prior.binding_digest,
					);
					if (!recovery)
						return { ok: false, reason: "recovery_authority_changed" };
				}
				if (
					(input.generation <= prior.generation && !recovery) ||
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
    spawn_nonce = NULL, pending_pgid = NULL, binding_spawn_epoch = NULL,
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
			if (recovery && prior)
				this.db
					.prepare(
						"UPDATE execution_process_owner SET spawn_epoch = ?, restart_in_progress = 1 WHERE execution_id = ?",
					)
					.run(prior.spawn_epoch, input.executionId);
			return { ok: true };
		});
	}

	/** Internal live-process backfill only. OS discovery precedes this short CAS;
	 * it must never overwrite a registered owner or become a spawn permit. */
	adoptLegacyBinding(
		input: MutationInput & {
			binding: ExecutionProcessBinding;
			observedAtMs: number;
			expiresAtMs: number;
			isCurrent(): boolean;
		},
	): Result<{ bindingDigest: string }> {
		if (Buffer.byteLength(JSON.stringify(input.binding)) > 1024 * 1024)
			throw new Error("process_binding_oversize");
		const binding = bindingSchema.parse(input.binding);
		if (
			binding.legacyExecutionId !== input.executionId ||
			binding.adapter !== "claude-tmux" ||
			binding.nonce !== null
		)
			return { ok: false, reason: "legacy_binding_identity_changed" };
		return this.mutate<{ bindingDigest: string }>(input, () => {
			const invalid = this.fresh(input, false);
			if (invalid) return { ok: false, reason: invalid };
			if (this.get(input.executionId))
				return { ok: false, reason: "owner_exists" };
			const current = this.store.resolveCurrentWorkflowActivation(
				input.executionId,
			);
			if (
				input.activationId === null
					? current.kind !== "none"
					: current.kind !== "current" ||
						current.binding.activation_id !== input.activationId
			)
				return { ok: false, reason: "activation_changed" };
			if (
				this.store.getSession(input.executionId)?.adapter_type !== "claude-tmux"
			)
				return { ok: false, reason: "adapter_changed" };
			if (
				!Number.isSafeInteger(input.observedAtMs) ||
				!Number.isSafeInteger(input.expiresAtMs) ||
				input.observedAtMs < 0 ||
				input.observedAtMs > input.nowMs ||
				input.expiresAtMs <= input.nowMs ||
				input.expiresAtMs <= input.observedAtMs ||
				input.expiresAtMs - input.observedAtMs > 5000
			)
				return { ok: false, reason: "legacy_evidence_expired" };
			try {
				if (input.isCurrent() !== true)
					return { ok: false, reason: "legacy_authority_changed" };
			} catch {
				return { ok: false, reason: "legacy_authority_changed" };
			}
			const digest = createHash("sha256")
				.update(
					JSON.stringify([
						input.executionId,
						input.activationId,
						input.generation,
						input.ownerToken,
						1,
						binding,
					]),
				)
				.digest("hex");
			this.db
				.prepare(`INSERT INTO execution_process_owner
			 (execution_id, activation_id, generation, owner_token, controller_pid, controller_start, host_boot_id,
			 spawn_epoch, binding_spawn_epoch, binding_json, binding_digest)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`)
				.run(
					input.executionId,
					input.activationId,
					input.generation,
					input.ownerToken,
					binding.pid,
					binding.startIdentity,
					binding.hostBootId,
					JSON.stringify(binding),
					digest,
				);
			return { ok: true, bindingDigest: digest };
		});
	}

	beginSpawn(
		input: SpawnMutation & { nonce?: string },
	): Result<{ permit: ProcessSpawnPermit }> {
		const nonce =
			input.nonce === undefined
				? null
				: identityText.regex(/^[A-Za-z0-9_-]+$/).parse(input.nonce);
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
					"UPDATE execution_process_owner SET spawn_epoch = spawn_epoch + 1, spawn_inflight = 1, spawn_nonce = ?, pending_pgid = NULL WHERE execution_id = ?",
				)
				.run(nonce, input.executionId);
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
		if (binding.legacyExecutionId !== undefined)
			return { ok: false, reason: "legacy_binding_requires_adoption" };
		return this.mutate(input, () => {
			const checked = this.checkOwner(input, false);
			if (!checked.ok) return checked;
			if (
				(checked.row.spawn_nonce !== null &&
					binding.nonce !== checked.row.spawn_nonce) ||
				(checked.row.pending_pgid !== null &&
					binding.pgid !== checked.row.pending_pgid)
			)
				return { ok: false, reason: "spawn_identity_changed" };
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
				spawn_inflight = 0, restart_in_progress = 0, binding_spawn_epoch = ? WHERE execution_id = ?`)
				.run(bindingJson, digest, input.spawnEpoch, input.executionId);
			return { ok: true, bindingDigest: digest };
		});
	}

	noteSpawnGroup(input: SpawnMutation & { pgid: number }): Result {
		const pgid = positive.min(2).parse(input.pgid);
		return this.mutate(input, () => {
			const checked = this.checkOwner(input, false);
			if (!checked.ok) return checked;
			if (!checked.row.spawn_inflight)
				return { ok: false, reason: "spawn_not_inflight" };
			if (
				checked.row.pending_pgid !== null &&
				checked.row.pending_pgid !== pgid
			)
				return { ok: false, reason: "spawn_group_changed" };
			this.db
				.prepare(
					"UPDATE execution_process_owner SET pending_pgid = ? WHERE execution_id = ?",
				)
				.run(pgid, input.executionId);
			return { ok: true };
		});
	}
	/** Only an internal, independently sampled failed-native-spawn proof can close
	 * an in-flight permit. Ordinary drain evidence never clears this fence. */
	recordFailedSpawnDrained(
		input: SpawnMutation & {
			evidence: ProcessOwnerDrainEvidence & {
				nonce: string;
				pgid: number | null;
			};
			reason: string;
		},
	): Result<{ receipt: string }> {
		const reason = identityText.parse(input.reason);
		return this.mutate(input, () => {
			const checked = this.checkOwner(input, false);
			if (!checked.ok) return checked;
			const row = checked.row,
				e = input.evidence;
			if (!row.close_requested)
				return { ok: false, reason: "owner_not_closed" };
			if (
				!this.sameOwner(row, e) ||
				e.spawnEpoch !== row.spawn_epoch ||
				e.bindingDigest !== row.binding_digest ||
				e.controller.pid !== row.controller_pid ||
				e.controller.startIdentity !== row.controller_start ||
				e.controller.hostBootId !== row.host_boot_id ||
				!row.spawn_nonce ||
				e.nonce !== row.spawn_nonce ||
				e.pgid !== row.pending_pgid
			)
				return { ok: false, reason: "drain_identity_changed" };
			if (row.owner_drained_receipt && row.owner_drained_at)
				return { ok: true, receipt: row.owner_drained_receipt };
			if (!row.spawn_inflight)
				return { ok: false, reason: "spawn_not_inflight" };
			if (
				!Number.isSafeInteger(e.observedAtMs) ||
				e.observedAtMs < 0 ||
				!Number.isSafeInteger(e.expiresAtMs) ||
				e.observedAtMs > input.nowMs ||
				e.expiresAtMs <= input.nowMs ||
				e.expiresAtMs - e.observedAtMs > 10_000
			)
				return { ok: false, reason: "drain_evidence_expired" };
			if (
				(e.controllerState !== "stopped" && e.controllerState !== "absent") ||
				e.groupState !== "absent" ||
				e.writersState !== "absent"
			)
				return { ok: false, reason: "drain_unconfirmed" };
			const receipt = createHash("sha256")
				.update(JSON.stringify({ version: 1, evidence: e, reason }))
				.digest("hex");
			this.db
				.prepare(
					"UPDATE execution_process_owner SET spawn_inflight = 0, restart_in_progress = 0, owner_drained_at = ?, owner_drained_receipt = ? WHERE execution_id = ?",
				)
				.run(new Date(input.nowMs).toISOString(), receipt, input.executionId);
			return { ok: true, receipt };
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
			// A committed drain is a durable receipt, not a new death decision.
			// Replay still requires the exact current owner, epoch and binding.
			if (row.owner_drained_receipt && row.owner_drained_at)
				return { ok: true, receipt: row.owner_drained_receipt };
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
			checked.row.spawn_epoch > 0 &&
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
				if (input.recoveryClaimToken) {
					const reservation = this.db
						.prepare(
							`SELECT claim_token FROM recovery_claim WHERE execution_id = ? AND claim_token = ? AND lease_purpose = 'recovery' AND episode_state = 'open' AND acquired_at_ms <= ? AND expires_at_ms > ? AND expected_lifecycle_revision = ? AND exhaustion_kind IS NULL`,
						)
						.get(
							input.executionId,
							input.recoveryClaimToken,
							input.nowMs,
							input.nowMs,
							input.lifecycleRevision,
						);
					if (!reservation)
						return { ok: false, reason: "recovery_authority_changed" };
					return operation();
				}
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
