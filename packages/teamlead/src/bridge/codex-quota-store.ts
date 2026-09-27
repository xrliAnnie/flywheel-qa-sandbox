import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { Database } from "better-sqlite3";
import {
	isCodexIdentityLabel,
	isCodexSlotName,
} from "flywheel-claude-runner/bin/codex-account-core.mjs";
import {
	type CodexQuotaBindingV1,
	type CodexQuotaContinueDecision,
	type CodexQuotaContinueReconciliation,
	type CodexQuotaResumeAuthorization,
	parseCodexQuotaBindingV1,
} from "flywheel-core";
import type {
	CodexQuotaAvailabilitySnapshot,
	CodexQuotaManualReason,
} from "../codex-quota/availability.js";
import {
	type CodexQuotaObservation,
	latestPoolObservations,
	selectCodexQuotaCandidate,
} from "../codex-quota/candidate-selector.js";
import {
	buildPoolExhaustedAlertSnapshot,
	type PoolExhaustedAlertDetails,
} from "../codex-quota/pool-exhausted-alert.js";
import type { CodexSwitchNotificationSnapshot } from "../codex-quota/switch-notification.js";

export type CodexQuotaRoot = {
	rootKey: string;
	accountKey: string;
	profile: string;
	generation: number;
};
export type CodexPoolExhaustionFact = {
	rootKey: string;
	generation: number;
	evidenceDigest: string;
	evidenceRef: string;
	observedAt: string;
	observation: readonly CodexQuotaObservation[];
};
export type CodexQuotaIncidentState =
	| "prepared"
	| "installing"
	| "committed"
	| "recovering"
	| "settled"
	| "retry_wait"
	| "pool_exhausted"
	| "probe_failed"
	| "identity_uncertain";
/** FLY-2900 §2.2: one standby carrier row per execution. */
export type CodexQuotaStandbyState =
	| "standby"
	| "resuming"
	| "fallback_prepared"
	| "released"
	| "closed";
export interface CodexQuotaStandbyRow {
	execution_id: string;
	run_id: string;
	node_id: string;
	attempt: number;
	activation_id: string | null;
	entry_seq: number;
	trigger_signal_seq: number;
	source_event_id: string;
	root_key: string | null;
	generation: number | null;
	binding_id: string | null;
	state: CodexQuotaStandbyState;
	resume_phase: "launching" | "identity_verified" | "continuing" | null;
	continue_attempt_id: string | null;
	continue_turn_id: string | null;
	permit_id: string | null;
	resume_attempt: number;
	mechanical_failures: number;
	capacity_rejections: number;
	reconcile_failures: number;
	owner_claim_id: string | null;
	lease_expires_at: string | null;
	fallback_attempt: number;
	fallback_execution_id: string | null;
	fallback_vendor: "codex" | "claude" | null;
	fallback_reason: string | null;
	checkpoint_commit: string | null;
	release_reason: string | null;
	last_error_code: string | null;
	entered_at: string;
	updated_at: string;
}
export type CodexQuotaResumeAuditAction =
	| "standby_entered"
	| "resume_started"
	| "identity_verified"
	| "continue_started"
	| "resumed"
	| "resume_failed"
	| "capacity_rejected"
	| "fallback_prepared"
	| "fallback_committed"
	| "fallback_reverted"
	| "fallback_blocked"
	| "released"
	| "standby_overdue";
/** FLY-2900 §2.3: one durable capacity permit. */
export interface CodexQuotaCapacityPermitRow {
	permit_id: string;
	root_key: string;
	generation: number;
	kind: "switch_committed" | "reading_confirmed";
	account_key: string;
	profile: string;
	covers_signal_seq: number;
	evidence_ref: string;
	created_at: string;
}
/** FLY-2900 §3.2: the reading fields a reading-confirmed permit may rely on. */
export interface CodexReadingEvidence {
	name: string;
	identityKey?: string;
	observedAt: string | null;
	fiveH: { usedPercent: number; resetAt: string | null } | null;
	weekly: { usedPercent: number; resetAt: string | null } | null;
	requestSeq?: number;
}
export type CodexReadingPermitOutcome =
	| { outcome: "issued" | "exists"; permit: CodexQuotaCapacityPermitRow }
	| { outcome: "not_needed" }
	| { outcome: "refused"; reason: string; needsRefresh: boolean };
/** FLY-2900 §3.2: a reading older than this cannot open a permit. */
export const CODEX_READING_PERMIT_FRESH_MS = 5 * 60_000;
const READING_PERMIT_FUTURE_SKEW_MS = 60_000;
/**
 * FLY-2900 §3.3: a signal that voids a permit — any later wall on the
 * permit's root at its generation or newer, or any unbound wall.
 */
const RELEVANT_SIGNAL_AFTER = `SELECT 1 FROM codex_quota_signal_event s
	WHERE COALESCE(s.signal_seq,0) > p.covers_signal_seq
	  AND ((s.root_key=p.root_key AND s.generation>=p.generation) OR s.root_key IS NULL)`;
/** FLY-2900 §6: non-quota relaunch failures under one permit before fallback. */
export const CODEX_QUOTA_MECHANICAL_BUDGET = 2;
/** FLY-2900 §6: consecutive unreadable reconciliations before the Lead hears. */
const CODEX_QUOTA_RECONCILE_ALERT_AFTER = 3;
/** Owner claim ids are `<owner prefix>:<nonce>`, bounded and printable. */
const CODEX_QUOTA_CLAIM_ID = /^[A-Za-z0-9_.-]+(:[A-Za-z0-9_.-]+)+$/;
/** Bounded machine code; never a path, email or free text. */
export const CODEX_QUOTA_MACHINE_CODE = /^[a-z0-9_:.-]{1,80}$/;
export type CodexQuotaSignalSource =
	| "runner_terminal"
	| "review_exec"
	| "legacy_backfill"
	| "legacy_incident";
const LEGACY_MIGRATION_KEY = "FLY-2676:v1";
const LEGACY_BATCH_ID = "codex-quota-legacy:FLY-2676:v1";
// Bound startup write-lock time even if an unexpectedly large old fleet exists.
const LEGACY_FREEZE_LIMIT = 10_000;
const LEGACY_MEMBER_MAX_ATTEMPTS = 3;
// Historical v1 capacity rows had no pool envelope and always represented this pool.
const LEGACY_CODEX_QUOTA_POOL = ["business", "personal", "school"] as const;
export interface CodexQuotaPoolMember {
	profile: string;
	accountKey: string;
}
function quotaSignalEventKey(
	source: CodexQuotaSignalSource,
	executionId: string,
	sourceEventId: string,
): string {
	return `codex-quota-event:v1:${createHash("sha256")
		.update(JSON.stringify([source, executionId, sourceEventId]))
		.digest("hex")}`;
}
function quotaSignalPayloadDigest(input: {
	source: CodexQuotaSignalSource;
	sourceEventId: string;
	executionId: string;
	bindingId?: string;
	nodeId?: string;
	attempt?: number;
}): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				source: input.source,
				sourceEventId: input.sourceEventId,
				executionId: input.executionId,
				bindingId: input.bindingId ?? null,
				nodeId: input.nodeId ?? null,
				attempt: input.attempt ?? null,
			}),
		)
		.digest("hex");
}
function canonicalCapacityObservation(
	observations: readonly CodexQuotaObservation[],
): string {
	return JSON.stringify(
		observations
			.map((observation) => ({
				profile: observation.profile,
				accountKey: observation.accountKey,
				observedAt: observation.observedAt,
				identityVerified: observation.identityVerified,
				authHealth: observation.authHealth,
				scopeKnown: observation.scopeKnown,
				windows: observation.windows
					.map((window) => ({
						usedPercent: window.usedPercent,
						resetsAt: window.resetsAt,
					}))
					.sort(
						(a, b) =>
							a.usedPercent - b.usedPercent ||
							(a.resetsAt ?? -1) - (b.resetsAt ?? -1),
					),
				...(observation.reached === undefined
					? {}
					: { reached: observation.reached }),
				...(observation.lastRefresh === undefined
					? {}
					: { lastRefresh: observation.lastRefresh }),
				...(observation.credentialFingerprint === undefined
					? {}
					: { credentialFingerprint: observation.credentialFingerprint }),
			}))
			.sort(
				(a, b) =>
					a.profile.localeCompare(b.profile) ||
					a.accountKey.localeCompare(b.accountKey),
			),
	);
}

function validPoolMembers(
	value: unknown,
): value is readonly CodexQuotaPoolMember[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every(
			(member) =>
				typeof member === "object" &&
				member !== null &&
				isCodexSlotName((member as CodexQuotaPoolMember).profile) &&
				typeof (member as CodexQuotaPoolMember).accountKey === "string" &&
				(member as CodexQuotaPoolMember).accountKey.length > 0,
		) &&
		new Set(
			value.map(
				(member) =>
					`${(member as CodexQuotaPoolMember).profile}\0${(member as CodexQuotaPoolMember).accountKey}`,
			),
		).size === value.length &&
		new Set(value.map((member) => (member as CodexQuotaPoolMember).profile))
			.size === value.length
	);
}

function canonicalCapacityEvidence(
	pool: readonly CodexQuotaPoolMember[],
	observations: readonly CodexQuotaObservation[],
): string {
	return JSON.stringify({
		v: 2,
		pool: [...pool].sort(
			(a, b) =>
				a.profile.localeCompare(b.profile) ||
				a.accountKey.localeCompare(b.accountKey),
		),
		observations: JSON.parse(canonicalCapacityObservation(observations)),
	});
}
/** FLY-2869: Codex readings older than this mean the pipeline stopped. */
const READING_STALE_AFTER_MS = 30 * 60_000;
const READING_FUTURE_SKEW_MS = 60_000;
/** FLY-2869: a manual-switch snapshot larger than this is stored as null. */
const MANUAL_SWITCH_NOTIFICATION_MAX_BYTES = 16 * 1024;
/** The StateStore connection owns every quota transaction; never a second DB. */
export class CodexQuotaStore {
	currentCodexPoolMembers?: () => readonly CodexQuotaPoolMember[];
	constructor(private readonly db: Database) {}
	migrate(): void {
		this.db.exec(`
   CREATE TABLE IF NOT EXISTS codex_quota_legacy_start(start_key TEXT PRIMARY KEY,project_name TEXT NOT NULL,issue_id TEXT NOT NULL,execution_id TEXT NOT NULL UNIQUE,request_digest TEXT NOT NULL,request_context TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TRIGGER IF NOT EXISTS codex_quota_legacy_start_no_update BEFORE UPDATE ON codex_quota_legacy_start BEGIN SELECT RAISE(ABORT, 'quota legacy reservation is append-only'); END;
   CREATE TRIGGER IF NOT EXISTS codex_quota_legacy_start_no_delete BEFORE DELETE ON codex_quota_legacy_start BEGIN SELECT RAISE(ABORT, 'quota legacy reservation is append-only'); END;
   CREATE TABLE IF NOT EXISTS codex_quota_root(root_key TEXT PRIMARY KEY,account_key TEXT NOT NULL,profile TEXT NOT NULL,generation INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS codex_quota_install_material(incident_id TEXT PRIMARY KEY,profile TEXT NOT NULL,account_key TEXT NOT NULL,prior_auth_digest TEXT NOT NULL,installed_auth_digest TEXT NOT NULL,recovery_material_path TEXT NOT NULL,recorded_at TEXT NOT NULL,resolution TEXT NOT NULL DEFAULT 'pending',resolved_at TEXT,notification_json TEXT);
   CREATE TABLE IF NOT EXISTS codex_quota_binding(binding_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, run_id TEXT, purpose TEXT NOT NULL, account_key TEXT NOT NULL, profile TEXT NOT NULL, generation INTEGER NOT NULL, root_key TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS codex_quota_binding_execution ON codex_quota_binding(execution_id);
   CREATE TABLE IF NOT EXISTS codex_quota_incident(incident_id TEXT PRIMARY KEY, root_key TEXT NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL, first_seen_at TEXT NOT NULL, next_attempt_at TEXT, selection_id TEXT, target_profile TEXT, probe_result TEXT, probe_at TEXT, prior_auth_digest TEXT, installed_auth_digest TEXT, installed_generation INTEGER, failure_code TEXT, UNIQUE(root_key,generation));
   CREATE TABLE IF NOT EXISTS codex_quota_target(incident_id TEXT NOT NULL,target_kind TEXT NOT NULL,target_id TEXT NOT NULL,run_id TEXT,node_id TEXT,attempt INTEGER,old_execution_id TEXT NOT NULL,state TEXT NOT NULL,terminate_key TEXT,start_key TEXT,start_request_json TEXT,new_run_id TEXT,new_execution_id TEXT,last_error TEXT,PRIMARY KEY(incident_id,target_kind,target_id));
   CREATE TABLE IF NOT EXISTS codex_quota_observation(root_key TEXT NOT NULL,account_key TEXT NOT NULL,limit_id TEXT NOT NULL,profile TEXT NOT NULL,observed_at TEXT NOT NULL,primary_window_json TEXT,secondary_window_json TEXT,auth_health TEXT,credential_fingerprint TEXT,last_refresh TEXT,invalid_reason TEXT,PRIMARY KEY(root_key,account_key,limit_id));
   CREATE TABLE IF NOT EXISTS codex_quota_admission_wait(start_key TEXT PRIMARY KEY,run_id TEXT,execution_id TEXT NOT NULL,node_id TEXT,root_key TEXT,generation INTEGER,dispatch_json TEXT,request_context TEXT,state TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS codex_quota_external_generation(root_key TEXT NOT NULL,generation INTEGER NOT NULL,account_key TEXT NOT NULL,profile TEXT NOT NULL,auth_digest TEXT NOT NULL,observed_at TEXT NOT NULL,PRIMARY KEY(root_key,generation));
   CREATE TABLE IF NOT EXISTS codex_quota_review_model(binding_id TEXT PRIMARY KEY,model TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS codex_quota_switch_audit(switch_id TEXT PRIMARY KEY,incident_id TEXT NOT NULL,at TEXT NOT NULL,from_profile TEXT NOT NULL,to_profile TEXT NOT NULL,reason TEXT NOT NULL,probe_result TEXT NOT NULL,installed_auth_digest TEXT);
   CREATE TABLE IF NOT EXISTS codex_quota_outbox_attempt(event_id TEXT PRIMARY KEY,attempted_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS codex_quota_outbox(event_id TEXT PRIMARY KEY,incident_id TEXT,kind TEXT NOT NULL,destination TEXT NOT NULL,payload_json TEXT NOT NULL,delivery_state TEXT NOT NULL DEFAULT 'pending',receipt_id TEXT);
   CREATE TABLE IF NOT EXISTS codex_quota_execution_pause(execution_id TEXT PRIMARY KEY,incident_id TEXT,reason TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS codex_quota_manual_disposition(incident_id TEXT PRIMARY KEY,reason TEXT NOT NULL,recorded_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS codex_quota_reading_episode(episode_id TEXT PRIMARY KEY,stale_since TEXT NOT NULL,baseline_observed_at TEXT,opened_at TEXT NOT NULL,alerted_at TEXT,closed_at TEXT);
   CREATE UNIQUE INDEX IF NOT EXISTS codex_quota_reading_episode_open ON codex_quota_reading_episode((1)) WHERE closed_at IS NULL;
   CREATE TABLE IF NOT EXISTS codex_quota_signal_event(event_key TEXT PRIMARY KEY,source TEXT NOT NULL,source_event_id TEXT NOT NULL,execution_id TEXT NOT NULL,binding_id TEXT,root_key TEXT,generation INTEGER,observed_at TEXT NOT NULL,payload_digest TEXT NOT NULL,disposition TEXT NOT NULL,reason_codes_json TEXT NOT NULL,evaluated_at TEXT,initial_disposition TEXT,initial_reason_codes_json TEXT,initial_evaluated_at TEXT);
   CREATE INDEX IF NOT EXISTS codex_quota_signal_source ON codex_quota_signal_event(source,source_event_id,execution_id);
   CREATE INDEX IF NOT EXISTS codex_quota_signal_root_generation ON codex_quota_signal_event(root_key,generation,disposition);
   CREATE TABLE IF NOT EXISTS codex_quota_capacity_fact(root_key TEXT NOT NULL,generation INTEGER NOT NULL,evidence_digest TEXT NOT NULL,status TEXT NOT NULL,observation_json TEXT NOT NULL,evidence_ref TEXT NOT NULL,observed_at TEXT NOT NULL,resolved_at TEXT,resolution_evidence_ref TEXT,resolution_observation_json TEXT,PRIMARY KEY(root_key,generation,evidence_digest));
   CREATE TABLE IF NOT EXISTS codex_quota_legacy_batch(batch_id TEXT PRIMARY KEY,migration_key TEXT NOT NULL UNIQUE,state TEXT NOT NULL,total_count INTEGER NOT NULL DEFAULT 0,manual_count INTEGER NOT NULL DEFAULT 0,guarded_count INTEGER NOT NULL DEFAULT 0,skipped_count INTEGER NOT NULL DEFAULT 0,failed_count INTEGER NOT NULL DEFAULT 0,sealed_at TEXT);
   CREATE TABLE IF NOT EXISTS codex_quota_legacy_member(batch_id TEXT NOT NULL,source TEXT NOT NULL,source_ref TEXT NOT NULL,run_id TEXT,node_id TEXT,attempt INTEGER,execution_id TEXT,incident_id TEXT,result TEXT NOT NULL DEFAULT 'pending',reason TEXT,event_key TEXT,attempt_count INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(batch_id,source,source_ref));
   CREATE INDEX IF NOT EXISTS codex_quota_legacy_member_result ON codex_quota_legacy_member(batch_id,result,source,source_ref);
   CREATE INDEX IF NOT EXISTS codex_quota_legacy_workflow_held ON workflow_run(status,current_node_id,run_id);
   CREATE TABLE IF NOT EXISTS codex_quota_sequence(name TEXT PRIMARY KEY,value INTEGER NOT NULL CHECK(value>=0));
   CREATE TABLE IF NOT EXISTS codex_quota_standby(execution_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,node_id TEXT NOT NULL,attempt INTEGER NOT NULL CHECK(attempt>0),activation_id TEXT,entry_seq INTEGER NOT NULL CHECK(entry_seq>0),trigger_signal_seq INTEGER NOT NULL CHECK(trigger_signal_seq>=0),source_event_id TEXT NOT NULL,root_key TEXT,generation INTEGER,binding_id TEXT,state TEXT NOT NULL CHECK(state IN ('standby','resuming','fallback_prepared','released','closed')),resume_phase TEXT CHECK(resume_phase IS NULL OR resume_phase IN ('launching','identity_verified','continuing')),continue_attempt_id TEXT,continue_turn_id TEXT,permit_id TEXT,resume_attempt INTEGER NOT NULL DEFAULT 0 CHECK(resume_attempt BETWEEN 0 AND 2),mechanical_failures INTEGER NOT NULL DEFAULT 0 CHECK(mechanical_failures>=0),capacity_rejections INTEGER NOT NULL DEFAULT 0 CHECK(capacity_rejections>=0),reconcile_failures INTEGER NOT NULL DEFAULT 0 CHECK(reconcile_failures>=0),owner_claim_id TEXT,lease_expires_at TEXT,fallback_attempt INTEGER NOT NULL DEFAULT 0 CHECK(fallback_attempt BETWEEN 0 AND 3),fallback_execution_id TEXT,fallback_vendor TEXT CHECK(fallback_vendor IS NULL OR fallback_vendor IN ('codex','claude')),fallback_reason TEXT,checkpoint_commit TEXT,release_reason TEXT,last_error_code TEXT,entered_at TEXT NOT NULL,updated_at TEXT NOT NULL,CHECK((state='resuming')=(resume_phase IS NOT NULL)));
   CREATE INDEX IF NOT EXISTS codex_quota_standby_state ON codex_quota_standby(state,trigger_signal_seq);
   CREATE TABLE IF NOT EXISTS codex_quota_capacity_permit(permit_id TEXT PRIMARY KEY,root_key TEXT NOT NULL,generation INTEGER NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('switch_committed','reading_confirmed')),account_key TEXT NOT NULL,profile TEXT NOT NULL,covers_signal_seq INTEGER NOT NULL CHECK(covers_signal_seq>=0),evidence_ref TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(root_key,generation,kind,covers_signal_seq));
   CREATE TABLE IF NOT EXISTS codex_quota_dispatch_demand(new_execution_id TEXT PRIMARY KEY,source_execution_id TEXT NOT NULL,entry_seq INTEGER NOT NULL,fallback_attempt INTEGER NOT NULL CHECK(fallback_attempt BETWEEN 1 AND 2),vendor TEXT NOT NULL CHECK(vendor IN ('codex','claude')),model TEXT NOT NULL,effort TEXT NOT NULL,reason TEXT NOT NULL CHECK(reason IN ('resume_attempts_exhausted','codex_quota_fallback')),same_vendor_evidence_json TEXT NOT NULL,pool_evidence_ref TEXT,source_node_state TEXT NOT NULL DEFAULT 'running',state TEXT NOT NULL CHECK(state IN ('prepared','committed','reverted')),revert_reason TEXT,created_at TEXT NOT NULL,updated_at TEXT,UNIQUE(source_execution_id,entry_seq,fallback_attempt));
   CREATE TABLE IF NOT EXISTS codex_quota_resume_output_proof(claim_id TEXT PRIMARY KEY,permit_id TEXT NOT NULL,execution_id TEXT NOT NULL,binding_id TEXT NOT NULL,continue_attempt_id TEXT NOT NULL,session_id TEXT NOT NULL,auth_digest TEXT NOT NULL,identity_seq INTEGER NOT NULL,output_seq INTEGER,proved_at TEXT);
   CREATE TABLE IF NOT EXISTS codex_quota_resume_audit(event_uid TEXT PRIMARY KEY,at TEXT NOT NULL,execution_id TEXT NOT NULL,run_id TEXT,issue_id TEXT,node_id TEXT,attempt INTEGER,action TEXT NOT NULL CHECK(action IN ('standby_entered','resume_started','identity_verified','continue_started','resumed','resume_failed','capacity_rejected','fallback_prepared','fallback_committed','fallback_reverted','fallback_blocked','released','standby_overdue')),permit_kind TEXT,from_profile TEXT,to_profile TEXT,vendor TEXT,detail_code TEXT);
   CREATE INDEX IF NOT EXISTS codex_quota_resume_audit_execution ON codex_quota_resume_audit(execution_id,at);
   CREATE INDEX IF NOT EXISTS codex_quota_resume_audit_action ON codex_quota_resume_audit(action,at);
  `);
		const signalColumns = new Set(
			(
				this.db
					.prepare("PRAGMA table_info(codex_quota_signal_event)")
					.all() as { name: string }[]
			).map((column) => column.name),
		);
		if (!signalColumns.has("signal_seq"))
			this.db.exec(
				"ALTER TABLE codex_quota_signal_event ADD COLUMN signal_seq INTEGER",
			);
		this.db.exec(
			"CREATE INDEX IF NOT EXISTS codex_quota_signal_seq ON codex_quota_signal_event(signal_seq)",
		);
		// FLY-2900 §4.3: every operator close intent and every writer that moves
		// a run to a terminal status releases its parked executions in the same
		// statement's transaction, so a prepared intent stops a claim at once.
		// Re-created on every open, after any workflow table rebuild.
		this.db.exec(`
			CREATE TRIGGER IF NOT EXISTS codex_quota_standby_release_close_intent_insert
			AFTER INSERT ON workflow_operator_close_intent
			WHEN NEW.stage IN ('prepared','committed')
			BEGIN
				UPDATE codex_quota_standby
				   SET state='released',resume_phase=NULL,release_reason='operator_close_intent',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
				 WHERE execution_id=NEW.execution_id AND state IN ('standby','resuming','fallback_prepared');
			END;
			CREATE TRIGGER IF NOT EXISTS codex_quota_standby_release_close_intent_update
			AFTER UPDATE OF stage ON workflow_operator_close_intent
			WHEN NEW.stage IN ('prepared','committed')
			BEGIN
				UPDATE codex_quota_standby
				   SET state='released',resume_phase=NULL,release_reason='operator_close_intent',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
				 WHERE execution_id=NEW.execution_id AND state IN ('standby','resuming','fallback_prepared');
			END;
			CREATE TRIGGER IF NOT EXISTS codex_quota_standby_release_run_terminal
			AFTER UPDATE OF status ON workflow_run
			WHEN NEW.status IN ('terminated','completed') AND OLD.status IS NOT NEW.status
			BEGIN
				UPDATE codex_quota_standby
				   SET state='released',resume_phase=NULL,release_reason='run_' || NEW.status,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
				 WHERE run_id=NEW.run_id AND state IN ('standby','resuming','fallback_prepared');
			END;
		`);
		const externalColumns = new Set(
			(
				this.db
					.prepare("PRAGMA table_info(codex_quota_external_generation)")
					.all() as { name: string }[]
			).map((column) => column.name),
		);
		// FLY-2900: NULL is a manual canonical switch; 'reading_confirmed' is a
		// same-account generation opened by post-wall recovery evidence.
		if (!externalColumns.has("reason"))
			this.db.exec(
				"ALTER TABLE codex_quota_external_generation ADD COLUMN reason TEXT",
			);
		const installMaterialColumns = new Set(
			(
				this.db
					.prepare("PRAGMA table_info(codex_quota_install_material)")
					.all() as {
					name: string;
				}[]
			).map((column) => column.name),
		);
		if (!installMaterialColumns.has("resolution"))
			this.db.exec(
				"ALTER TABLE codex_quota_install_material ADD COLUMN resolution TEXT NOT NULL DEFAULT 'pending'",
			);
		if (!installMaterialColumns.has("resolved_at"))
			this.db.exec(
				"ALTER TABLE codex_quota_install_material ADD COLUMN resolved_at TEXT",
			);
		if (!installMaterialColumns.has("notification_json"))
			this.db.exec(
				"ALTER TABLE codex_quota_install_material ADD COLUMN notification_json TEXT",
			);
		// Upgrade the only durable legacy rollback evidence before later retry
		// state changes can overwrite its incident failure_code.
		this.db.exec(`
			UPDATE codex_quota_install_material
			SET resolution='rolled_back',resolved_at=COALESCE(resolved_at,recorded_at)
			WHERE resolution='pending'
			  AND EXISTS (
				SELECT 1 FROM codex_quota_incident i
				WHERE i.incident_id=codex_quota_install_material.incident_id
				  AND i.failure_code='installation_rolled_back'
			  )
		`);
	}
	reserveLegacyStart(input: {
		startKey: string;
		projectName: string;
		issueId: string;
		executionId: string;
		requestDigest: string;
		requestContext: string;
	}): { execution_id: string; request_context: string } {
		return this.db.transaction(() => {
			const prior = this.db
				.prepare("SELECT * FROM codex_quota_legacy_start WHERE start_key=?")
				.get(input.startKey) as
				| {
						project_name: string;
						issue_id: string;
						execution_id: string;
						request_digest: string;
						request_context: string;
				  }
				| undefined;
			if (prior) {
				if (
					prior.project_name !== input.projectName ||
					prior.issue_id !== input.issueId ||
					prior.request_digest !== input.requestDigest
				)
					throw new Error("quota_legacy_start_conflict");
				return prior;
			}
			this.db
				.prepare("INSERT INTO codex_quota_legacy_start VALUES(?,?,?,?,?,?,?)")
				.run(
					input.startKey,
					input.projectName,
					input.issueId,
					input.executionId,
					input.requestDigest,
					input.requestContext,
					new Date().toISOString(),
				);
			return {
				execution_id: input.executionId,
				request_context: input.requestContext,
			};
		})();
	}
	enqueueLegacyAdmissionWait(input: {
		startKey: string;
		rootKey: string;
		generation: number;
	}): void {
		this.db.transaction(() => {
			const reservation = this.db
				.prepare("SELECT * FROM codex_quota_legacy_start WHERE start_key=?")
				.get(input.startKey) as
				| { execution_id: string; request_context: string }
				| undefined;
			if (!reservation) throw new Error("quota_legacy_start_missing");
			const prior = this.getAdmissionWait(input.startKey);
			if (prior && prior.execution_id !== reservation.execution_id)
				throw new Error("quota_waiter_conflict");
			this.db
				.prepare(
					"INSERT OR IGNORE INTO codex_quota_admission_wait(start_key,execution_id,root_key,generation,dispatch_json,request_context,state,created_at) VALUES(?,?,?,?,?,?,'waiting',?)",
				)
				.run(
					input.startKey,
					reservation.execution_id,
					input.rootKey,
					input.generation,
					JSON.stringify({ vendor: "codex" }),
					reservation.request_context,
					new Date().toISOString(),
				);
		})();
	}
	initializeRoot(root: CodexQuotaRoot): void {
		if (
			!Number.isSafeInteger(root.generation) ||
			root.generation < 1 ||
			!root.rootKey ||
			!root.accountKey ||
			!root.profile
		)
			throw new Error("invalid_quota_root");
		this.db
			.prepare("INSERT OR IGNORE INTO codex_quota_root VALUES(?,?,?,?)")
			.run(root.rootKey, root.accountKey, root.profile, root.generation);
		const current = this.getRoot(root.rootKey)!;
		if (
			current.accountKey !== root.accountKey ||
			current.profile !== root.profile ||
			current.generation !== root.generation
		)
			throw new Error("quota_root_identity_conflict");
	}
	reconcileExternalRoot(input: {
		rootKey: string;
		expectedGeneration: number;
		accountKey: string;
		profile: string;
		authDigest: string;
		/** FLY-2869: the N1 snapshot for this manual switch, built by the caller. */
		notification?: CodexSwitchNotificationSnapshot | null;
	}): void {
		if (
			!isCodexIdentityLabel(input.profile) ||
			!input.accountKey ||
			!/^[a-f0-9]{64}$/.test(input.authDigest)
		)
			throw new Error("invalid_quota_external_identity");
		this.db.transaction(() => {
			const root = this.getRoot(input.rootKey);
			if (
				!root ||
				root.generation !== input.expectedGeneration ||
				!Number.isSafeInteger(root.generation + 1)
			)
				throw new Error("quota_generation_conflict");
			if (
				root.accountKey === input.accountKey &&
				root.profile === input.profile
			)
				return;
			if (
				this.db
					.prepare(
						"SELECT 1 FROM codex_quota_incident WHERE root_key=? AND state='installing' LIMIT 1",
					)
					.get(input.rootKey)
			)
				throw new Error("quota_installation_pending");
			this.db
				.prepare(
					"INSERT INTO codex_quota_external_generation(root_key,generation,account_key,profile,auth_digest,observed_at) VALUES(?,?,?,?,?,?)",
				)
				.run(
					input.rootKey,
					root.generation + 1,
					input.accountKey,
					input.profile,
					input.authDigest,
					new Date().toISOString(),
				);
			this.db
				.prepare(
					"UPDATE codex_quota_root SET account_key=?,profile=?,generation=? WHERE root_key=?",
				)
				.run(
					input.accountKey,
					input.profile,
					root.generation + 1,
					input.rootKey,
				);
			this.db
				.prepare(
					"UPDATE codex_quota_incident SET state='identity_uncertain',selection_id=NULL,failure_code='canonical_identity_changed' WHERE root_key=? AND generation<=? AND state NOT IN ('committed','recovering','settled')",
				)
				.run(input.rootKey, root.generation);
			// FLY-2869: someone switched the canonical account by hand. Tell
			// #notifications in the same shape as an automatic switch, exactly once
			// per generation (same transaction, generation-keyed event id).
			const generation = root.generation + 1;
			const serialized =
				input.notification == null ? null : JSON.stringify(input.notification);
			this.enqueueOutbox({
				incidentId: null,
				kind: "switch_notification",
				eventId: `codex:${input.rootKey}:${generation}:manual_switch`,
				destination: "founder",
				payload: {
					reason: "manual_switch",
					rootKey: input.rootKey,
					generation,
					notification:
						serialized !== null &&
						serialized.length <= MANUAL_SWITCH_NOTIFICATION_MAX_BYTES
							? serialized
							: null,
				},
			});
		})();
	}
	/**
	 * FLY-2869: the durable "Codex readings stopped" state machine. Health is
	 * derived here from the newest observation, never trusted from a caller.
	 * One open episode at most; it survives restarts, alerts once after 30
	 * minutes of staleness and closes on the next healthy reading.
	 */
	observeCodexReadingPipeline(input: {
		nowIso: string;
		latestObservedAt: string | null;
		failureCode: string | null;
	}): void {
		const nowMs = Date.parse(input.nowIso);
		const observedMs =
			input.latestObservedAt === null
				? null
				: Date.parse(input.latestObservedAt);
		if (
			!Number.isFinite(nowMs) ||
			(observedMs !== null &&
				(!Number.isFinite(observedMs) ||
					observedMs > nowMs + READING_FUTURE_SKEW_MS))
		)
			throw new Error("invalid_reading_pipeline_input");
		const failureCode =
			typeof input.failureCode === "string" &&
			/^[a-z0-9_:.-]{1,80}$/i.test(input.failureCode)
				? input.failureCode
				: null;
		const healthy =
			observedMs !== null && nowMs - observedMs <= READING_STALE_AFTER_MS;
		const nowIso = new Date(nowMs).toISOString();
		this.db.transaction(() => {
			const open = this.db
				.prepare(
					"SELECT episode_id,stale_since,baseline_observed_at,alerted_at FROM codex_quota_reading_episode WHERE closed_at IS NULL",
				)
				.get() as
				| {
						episode_id: string;
						stale_since: string;
						baseline_observed_at: string | null;
						alerted_at: string | null;
				  }
				| undefined;
			if (healthy) {
				if (open)
					this.db
						.prepare(
							"UPDATE codex_quota_reading_episode SET closed_at=? WHERE episode_id=?",
						)
						.run(nowIso, open.episode_id);
				return;
			}
			const baseline =
				observedMs === null ? null : new Date(observedMs).toISOString();
			const episode = open ?? {
				episode_id: randomUUID(),
				stale_since: baseline ?? nowIso,
				baseline_observed_at: baseline,
				alerted_at: null,
			};
			if (!open)
				this.db
					.prepare(
						"INSERT INTO codex_quota_reading_episode(episode_id,stale_since,baseline_observed_at,opened_at) VALUES(?,?,?,?)",
					)
					.run(
						episode.episode_id,
						episode.stale_since,
						episode.baseline_observed_at,
						nowIso,
					);
			const staleMs = nowMs - Date.parse(episode.stale_since);
			if (episode.alerted_at !== null || staleMs <= READING_STALE_AFTER_MS)
				return;
			this.db
				.prepare(
					"UPDATE codex_quota_reading_episode SET alerted_at=? WHERE episode_id=?",
				)
				.run(nowIso, episode.episode_id);
			this.enqueueOutbox({
				incidentId: null,
				kind: "reading_stale",
				eventId: `codex-quota-reading-stale:${episode.episode_id}`,
				destination: "lead",
				payload: {
					episodeId: episode.episode_id,
					staleSince: episode.stale_since,
					baselineObservedAt: episode.baseline_observed_at,
					failureCode,
					staleMinutesAtAlert: Math.floor(staleMs / 60_000),
				},
			});
		})();
	}
	/** FLY-2869: the durable record of one manual canonical switch. */
	getExternalGeneration(
		rootKey: string,
		generation: number,
	):
		| {
				rootKey: string;
				generation: number;
				accountKey: string;
				profile: string;
				observedAt: string;
		  }
		| undefined {
		const row = this.db
			.prepare(
				"SELECT root_key,generation,account_key,profile,observed_at FROM codex_quota_external_generation WHERE root_key=? AND generation=?",
			)
			.get(rootKey, generation) as
			| {
					root_key: string;
					generation: number;
					account_key: string;
					profile: string;
					observed_at: string;
			  }
			| undefined;
		return row
			? {
					rootKey: row.root_key,
					generation: row.generation,
					accountKey: row.account_key,
					profile: row.profile,
					observedAt: row.observed_at,
				}
			: undefined;
	}
	getRoot(rootKey: string): CodexQuotaRoot | undefined {
		const r = this.db
			.prepare("SELECT * FROM codex_quota_root WHERE root_key=?")
			.get(rootKey) as
			| {
					root_key: string;
					account_key: string;
					profile: string;
					generation: number;
			  }
			| undefined;
		return r
			? {
					rootKey: r.root_key,
					accountKey: r.account_key,
					profile: r.profile,
					generation: r.generation,
				}
			: undefined;
	}
	recordInstalling(input: {
		incidentId: string;
		profile: string;
		accountKey: string;
		priorAuthDigest: string;
		installedAuthDigest: string;
		recoveryMaterialPath: string;
		notification?: CodexSwitchNotificationSnapshot;
		now?: string;
	}): void {
		if (
			!isCodexSlotName(input.profile) ||
			!input.accountKey ||
			!isAbsolute(input.recoveryMaterialPath) ||
			!input.priorAuthDigest ||
			!input.installedAuthDigest
		)
			throw new Error("invalid_quota_installation");
		let notificationJson: string | null = null;
		try {
			const encoded =
				input.notification === undefined
					? null
					: JSON.stringify(input.notification);
			if (encoded !== null && encoded.length <= 16_384)
				notificationJson = encoded;
		} catch {
			// Notification evidence can degrade to n/a; it must never block install.
		}
		this.db.transaction(() => {
			const incident = this.getIncident(input.incidentId);
			if (
				!incident ||
				["committed", "recovering", "settled"].includes(String(incident.state))
			)
				throw new Error("quota_installation_conflict");
			const root = this.getRoot(String(incident.root_key));
			if (!root || root.generation !== incident.generation)
				throw new Error("quota_generation_conflict");
			const now = input.now ?? new Date().toISOString();
			this.recordSwitchAudit({
				switchId: `${input.incidentId}:install:${input.installedAuthDigest}`,
				incidentId: input.incidentId,
				at: now,
				from: root.profile,
				to: input.profile,
				reason: "usage_limit",
				probeResult: "ok",
				installedAuthDigest: input.installedAuthDigest,
			});
			this.db
				.prepare(
					"INSERT INTO codex_quota_install_material(incident_id,profile,account_key,prior_auth_digest,installed_auth_digest,recovery_material_path,recorded_at,resolution,resolved_at,notification_json) VALUES(?,?,?,?,?,?,?,'pending',NULL,?) ON CONFLICT(incident_id) DO UPDATE SET profile=excluded.profile,account_key=excluded.account_key,prior_auth_digest=excluded.prior_auth_digest,installed_auth_digest=excluded.installed_auth_digest,recovery_material_path=excluded.recovery_material_path,recorded_at=excluded.recorded_at,resolution='pending',resolved_at=NULL,notification_json=excluded.notification_json",
				)
				.run(
					input.incidentId,
					input.profile,
					input.accountKey,
					input.priorAuthDigest,
					input.installedAuthDigest,
					input.recoveryMaterialPath,
					now,
					notificationJson,
				);
			this.db
				.prepare(
					"UPDATE codex_quota_incident SET state='installing',target_profile=?,probe_result='ok',probe_at=?,prior_auth_digest=?,installed_auth_digest=? WHERE incident_id=?",
				)
				.run(
					input.profile,
					now,
					input.priorAuthDigest,
					input.installedAuthDigest,
					input.incidentId,
				);
		})();
	}
	getInstallationMaterial(incidentId: string):
		| {
				profile: string;
				accountKey: string;
				priorAuthDigest: string;
				installedAuthDigest: string;
				recoveryMaterialPath: string;
				recordedAt: string;
				resolution: "pending" | "installed" | "rolled_back";
				resolvedAt: string | null;
				notificationJson: string | null;
		  }
		| undefined {
		const row = this.db
			.prepare("SELECT * FROM codex_quota_install_material WHERE incident_id=?")
			.get(incidentId) as Record<string, string> | undefined;
		return row
			? {
					profile: row.profile!,
					accountKey: row.account_key!,
					priorAuthDigest: row.prior_auth_digest!,
					installedAuthDigest: row.installed_auth_digest!,
					recoveryMaterialPath: row.recovery_material_path!,
					recordedAt: row.recorded_at!,
					resolution: row.resolution as "pending" | "installed" | "rolled_back",
					resolvedAt: row.resolved_at ?? null,
					notificationJson: row.notification_json ?? null,
				}
			: undefined;
	}
	commitGeneration(input: {
		incidentId: string;
		expectedGeneration: number;
		accountKey: string;
		profile: string;
		authDigest: string;
		probeResult: string;
		now?: string;
	}): void {
		if (input.probeResult !== "ok")
			throw new Error("quota_probe_not_successful");
		this.db.transaction(() => {
			const incident = this.getIncident(input.incidentId);
			if (!incident) throw new Error("quota_incident_missing");
			const root = this.getRoot(String(incident.root_key));
			if (
				!root ||
				root.generation !== input.expectedGeneration ||
				!Number.isSafeInteger(root.generation + 1)
			)
				throw new Error("quota_generation_conflict");
			const material = this.getInstallationMaterial(input.incidentId);
			if (
				incident.state !== "installing" ||
				!material ||
				material.profile !== input.profile ||
				material.accountKey !== input.accountKey ||
				material.installedAuthDigest !== input.authDigest
			)
				throw new Error("quota_installation_not_recorded");
			const committedAt = input.now ?? new Date().toISOString();
			this.db
				.prepare(
					"UPDATE codex_quota_root SET account_key=?,profile=?,generation=? WHERE root_key=?",
				)
				.run(
					input.accountKey,
					input.profile,
					root.generation + 1,
					root.rootKey,
				);
			this.db
				.prepare(
					"UPDATE codex_quota_incident SET state='committed',target_profile=?,probe_result='ok',probe_at=?,installed_auth_digest=?,installed_generation=? WHERE incident_id=?",
				)
				.run(
					input.profile,
					committedAt,
					input.authDigest,
					root.generation + 1,
					input.incidentId,
				);
			this.db
				.prepare(
					"UPDATE codex_quota_install_material SET resolution='installed',resolved_at=? WHERE incident_id=? AND resolution='pending'",
				)
				.run(committedAt, input.incidentId);
			// FLY-2900 §3.2: a committed switch is recovery evidence for every
			// wall recorded so far against this root (or unbound).
			this.insertPermit({
				kind: "switch_committed",
				rootKey: root.rootKey,
				generation: root.generation + 1,
				accountKey: input.accountKey,
				profile: input.profile,
				coversSignalSeq: this.maxRootSignalSeqBelow(
					root.rootKey,
					Number.MAX_SAFE_INTEGER,
				),
				evidenceRef: `selection:${String(incident.selection_id ?? input.incidentId)}`,
				now: committedAt,
			});
			this.enqueueOutbox({
				incidentId: input.incidentId,
				kind: "switch_notification",
				destination: "founder",
				payload: {
					reason: "switch_succeeded",
					notification: material.notificationJson,
				},
			});
		})();
	}
	/** Persist the observed source reset before probing, including across install recovery. */
	recordSourceReset(incidentId: string, resetsAt: number | null): void {
		this.db
			.prepare(
				"UPDATE codex_quota_outbox SET payload_json=json_set(payload_json,'$.resetsAt',?) WHERE event_id=?",
			)
			.run(resetsAt, `${incidentId}:usage_limit`);
	}
	getIncident(incidentId: string): Record<string, unknown> | undefined {
		return this.db
			.prepare("SELECT * FROM codex_quota_incident WHERE incident_id=?")
			.get(incidentId) as Record<string, unknown> | undefined;
	}
	setIncidentState(
		incidentId: string,
		state: Exclude<CodexQuotaIncidentState, "committed">,
		failureCode?: string,
		nextAttemptAt?: string,
	): void {
		if (
			(state === "recovering" || state === "settled") &&
			this.getIncident(incidentId)?.probe_result !== "ok" &&
			!this.getResumeOutputRecoveryPermit(incidentId)
		)
			throw new Error("quota_probe_not_successful");
		this.db.transaction(() => {
			if (failureCode === "installation_rolled_back")
				this.db
					.prepare(
						"UPDATE codex_quota_install_material SET resolution='rolled_back',resolved_at=? WHERE incident_id=? AND resolution='pending'",
					)
					.run(new Date().toISOString(), incidentId);
			this.db
				.prepare(
					"UPDATE codex_quota_incident SET state=?,failure_code=?,next_attempt_at=? WHERE incident_id=?",
				)
				.run(state, failureCode ?? null, nextAttemptAt ?? null, incidentId);
		})();
	}
	updateTarget(
		incidentId: string,
		targetKind: string,
		targetId: string,
		patch: {
			state?:
				| "waiting"
				| "terminating"
				| "terminated"
				| "starting"
				| "queued"
				| "recovered"
				| "abandoned";
			terminate_key?: string;
			start_key?: string;
			start_request_json?: string;
			new_run_id?: string;
			new_execution_id?: string;
			last_error?: string;
		},
	): void {
		const allowed = [
			"state",
			"terminate_key",
			"start_key",
			"start_request_json",
			"new_run_id",
			"new_execution_id",
			"last_error",
		];
		const entries = Object.entries(patch);
		if (entries.some(([key]) => !allowed.includes(key)))
			throw new Error("invalid_quota_target_patch");
		if (!entries.length) return;
		this.db
			.prepare(
				`UPDATE codex_quota_target SET ${entries.map(([key]) => `${key}=?`).join(",")} WHERE incident_id=? AND target_kind=? AND target_id=?`,
			)
			.run(
				...entries.map(([, value]) => value),
				incidentId,
				targetKind,
				targetId,
			);
	}
	enqueueOutbox(
		input:
			| {
					incidentId: string | null;
					kind: "automation_disabled";
					eventId: string;
					destination: string;
					payload: Record<string, unknown>;
			  }
			| {
					// FLY-2869: a manual switch has no incident; its generation keys it.
					incidentId: null;
					kind: "switch_notification";
					eventId: string;
					destination: string;
					payload: Record<string, unknown>;
			  }
			| {
					// FLY-2900: one issue-thread line per resume / fallback outcome.
					incidentId: null;
					kind: "resume_notice";
					eventId: string;
					destination: string;
					payload: Record<string, unknown>;
			  }
			| {
					// FLY-2869: one "readings stopped" alert per durable episode.
					incidentId: null;
					kind: "reading_stale";
					eventId: string;
					destination: string;
					payload: Record<string, unknown>;
			  }
			| {
					incidentId: string;
					kind:
						| "founder_alert"
						| "lead_summary"
						| "lead_diagnostic"
						| "switch_notification";
					eventId?: string;
					destination: string;
					payload: Record<string, unknown>;
			  },
	): void {
		this.db
			.prepare(
				"INSERT OR IGNORE INTO codex_quota_outbox(event_id,incident_id,kind,destination,payload_json) VALUES(?,?,?,?,?)",
			)
			.run(
				input.eventId ?? `${input.incidentId}:${input.kind}`,
				input.incidentId,
				input.kind,
				input.destination,
				JSON.stringify(input.payload),
			);
	}
	claimSelection(incidentId: string, evidenceKey: string): boolean {
		return (
			this.db
				.prepare(
					"UPDATE codex_quota_incident SET selection_id=? WHERE incident_id=? AND state NOT IN ('installing','committed','recovering','settled') AND (selection_id IS NULL OR selection_id<>?)",
				)
				.run(evidenceKey, incidentId, evidenceKey).changes === 1
		);
	}
	registerReviewModel(bindingId: string, model: string): void {
		if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model))
			throw new Error("invalid_quota_review_model");
		this.db.transaction(() => {
			if (this.getBinding(bindingId)?.purpose !== "review")
				throw new Error("quota_review_binding_missing");
			const prior = this.getReviewModel(bindingId);
			if (prior && prior !== model)
				throw new Error("quota_review_model_conflict");
			this.db
				.prepare("INSERT OR IGNORE INTO codex_quota_review_model VALUES(?,?)")
				.run(bindingId, model);
		})();
	}
	getReviewModel(bindingId: string): string | undefined {
		return (
			this.db
				.prepare(
					"SELECT model FROM codex_quota_review_model WHERE binding_id=?",
				)
				.get(bindingId) as { model: string } | undefined
		)?.model;
	}
	recordSwitchAudit(input: {
		switchId: string;
		incidentId: string;
		at?: string;
		from: string;
		to: string;
		reason: string;
		probeResult: string;
		installedAuthDigest?: string;
	}): void {
		if (
			!isCodexIdentityLabel(input.from) ||
			!isCodexSlotName(input.to) ||
			!["ok", "failed", "unknown"].includes(input.probeResult) ||
			!/^[a-z_]{1,80}$/.test(input.reason)
		)
			throw new Error("invalid_quota_audit");
		this.db
			.prepare(
				"INSERT OR IGNORE INTO codex_quota_switch_audit VALUES(?,?,?,?,?,?,?,?)",
			)
			.run(
				input.switchId,
				input.incidentId,
				input.at ?? new Date().toISOString(),
				input.from,
				input.to,
				input.reason,
				input.probeResult,
				input.installedAuthDigest ?? null,
			);
	}
	listSwitchAudit(): Record<string, unknown>[] {
		return this.db
			.prepare(`SELECT a.*,i.installed_generation,i.installed_auth_digest AS committed_digest,
            (SELECT COUNT(*) FROM codex_quota_target t WHERE t.incident_id=a.incident_id) AS target_count,
            (SELECT COUNT(*) FROM codex_quota_target t WHERE t.incident_id=a.incident_id AND t.state='recovered') AS recovered_count
            FROM codex_quota_switch_audit a LEFT JOIN codex_quota_incident i ON i.incident_id=a.incident_id ORDER BY a.at DESC,a.rowid DESC LIMIT 1024`)
			.all() as Record<string, unknown>[];
	}
	claimOutboxAttempt(
		eventId: string,
		now: number,
	): { replay: boolean } | undefined {
		return this.db.transaction(() => {
			const row = this.db
				.prepare(
					"SELECT delivery_state FROM codex_quota_outbox WHERE event_id=?",
				)
				.get(eventId) as { delivery_state: string } | undefined;
			if (!row || row.delivery_state !== "pending") return undefined;
			const prior = this.db
				.prepare(
					"SELECT attempted_at FROM codex_quota_outbox_attempt WHERE event_id=?",
				)
				.get(eventId) as { attempted_at: number } | undefined;
			if (prior && now - prior.attempted_at < 30 * 60_000) return undefined;
			this.db
				.prepare(
					"INSERT INTO codex_quota_outbox_attempt VALUES(?,?) ON CONFLICT(event_id) DO UPDATE SET attempted_at=excluded.attempted_at",
				)
				.run(eventId, now);
			return { replay: !!prior };
		})();
	}
	markOutboxDelivered(eventId: string, receiptId: string): void {
		this.db
			.prepare(
				"UPDATE codex_quota_outbox SET delivery_state='delivered',receipt_id=? WHERE event_id=?",
			)
			.run(receiptId, eventId);
	}
	registerBinding(input: CodexQuotaBindingV1): void {
		const binding = parseCodexQuotaBindingV1(input);
		if (!binding) throw new Error("invalid_quota_binding");
		const old = this.getBinding(binding.bindingId);
		if (old) {
			if (JSON.stringify(old) !== JSON.stringify(binding))
				throw new Error("quota_binding_conflict");
			return;
		}
		this.db
			.prepare("INSERT INTO codex_quota_binding VALUES(?,?,?,?,?,?,?,?,?)")
			.run(
				binding.bindingId,
				binding.executionId,
				binding.runId,
				binding.purpose,
				binding.accountKey,
				binding.profile,
				binding.generation,
				binding.credentialRootKey,
				new Date().toISOString(),
			);
	}
	getBinding(id: string): CodexQuotaBindingV1 | undefined {
		const r = this.db
			.prepare("SELECT * FROM codex_quota_binding WHERE binding_id=?")
			.get(id) as Record<string, unknown> | undefined;
		if (!r) return;
		return parseCodexQuotaBindingV1({
			bindingId: r.binding_id,
			executionId: r.execution_id,
			runId: r.run_id,
			purpose: r.purpose,
			accountKey: r.account_key,
			profile: r.profile,
			generation: r.generation,
			credentialRootKey: r.root_key,
		});
	}
	/**
	 * Freeze the pre-FLY-2676 population once, then consume at most 1000 members
	 * per maintenance pass. Historical rows deliberately share one summary N11.
	 */
	backfillHistoricalQuotaFailures(limit = 1000): number {
		const passLimit = Math.min(1000, Math.max(1, Math.floor(limit)));
		return this.db.transaction(() => {
			let batch = this.db
				.prepare("SELECT * FROM codex_quota_legacy_batch WHERE migration_key=?")
				.get(LEGACY_MIGRATION_KEY) as Record<string, unknown> | undefined;
			if (!batch) {
				const historical = this.db
					.prepare(`
                    SELECT r.run_id,n.node_id,n.attempt,n.execution_id,
                      'legacy:' || r.run_id || ':' || n.node_id || ':' || n.attempt || ':' || n.execution_id AS source_ref
                    FROM workflow_run r
                    JOIN workflow_run_node n ON n.run_id=r.run_id AND n.node_id=r.current_node_id
                    JOIN sessions s ON s.execution_id=n.execution_id
                    WHERE r.status='held' AND s.status IN ('failed','terminated','stopped')
                    AND s.last_error='goal ended non-complete: usageLimited'
                    AND n.attempt=(SELECT MAX(latest.attempt) FROM workflow_run_node latest WHERE latest.run_id=n.run_id AND latest.node_id=n.node_id)
                    AND NOT EXISTS (SELECT 1 FROM codex_quota_target t WHERE t.old_execution_id=n.execution_id)
                    AND NOT EXISTS (SELECT 1 FROM codex_quota_outbox o WHERE o.event_id='codex:unbound:' || n.execution_id || ':lead_diagnostic')
                    AND NOT EXISTS (SELECT 1 FROM codex_quota_signal_event q WHERE q.source='legacy_backfill' AND q.source_event_id='legacy:' || r.run_id || ':' || n.node_id || ':' || n.attempt || ':' || n.execution_id AND q.execution_id=n.execution_id)
                    AND EXISTS (SELECT 1 FROM workflow_run_event e WHERE e.run_id=r.run_id AND e.execution_id=n.execution_id AND e.node_id=n.node_id AND e.kind='retry_limit_escalated'
                      AND NOT EXISTS (SELECT 1 FROM workflow_run_event later WHERE later.run_id=r.run_id AND later.seq>e.seq AND later.kind IN ('run_held_by_operator','run_terminated','run_terminated_by_operator','run_terminated_by_supersession','run_completed','run_cancelled','run_shipped','land_held','unlaunched_admission_rolled_back','unlaunched_admission_held','rework_activation_stalled_held','rework_pane_loss_handoff','rework_retry_exhausted','completion_receipt_missing','retry_limit_escalated','environment_failure_escalated','loop_limit_escalated','rework_suppressed_idle_spin','workflow_gate_origin_preflight_terminal')))
                    ORDER BY r.run_id,n.node_id,n.attempt,n.execution_id LIMIT ?
                `)
					.all(LEGACY_FREEZE_LIMIT + 1) as {
					run_id: string;
					node_id: string;
					attempt: number;
					execution_id: string;
					source_ref: string;
				}[];
				const remainingCapacity = Math.max(
					0,
					LEGACY_FREEZE_LIMIT -
						Math.min(historical.length, LEGACY_FREEZE_LIMIT),
				);
				const incidents = this.db
					.prepare(`
                    SELECT incident_id,root_key,generation
                    FROM codex_quota_incident
                    WHERE failure_code='readiness_failed'
                      AND state IN ('prepared','retry_wait','probe_failed','identity_uncertain','pool_exhausted')
                      AND NOT EXISTS (SELECT 1 FROM codex_quota_manual_disposition m WHERE m.incident_id=codex_quota_incident.incident_id)
                    ORDER BY first_seen_at,incident_id LIMIT ?
                `)
					.all(remainingCapacity + 1) as {
					incident_id: string;
					root_key: string;
					generation: number;
				}[];
				const overflow =
					historical.length > LEGACY_FREEZE_LIMIT ||
					incidents.length > remainingCapacity;
				const frozenHistorical = historical.slice(0, LEGACY_FREEZE_LIMIT);
				const frozenIncidents = incidents.slice(0, remainingCapacity);
				this.db
					.prepare(
						"INSERT INTO codex_quota_legacy_batch(batch_id,migration_key,state,total_count) VALUES(?,?,'collecting',0)",
					)
					.run(LEGACY_BATCH_ID, LEGACY_MIGRATION_KEY);
				const insert = this.db.prepare(
					"INSERT INTO codex_quota_legacy_member(batch_id,source,source_ref,run_id,node_id,attempt,execution_id,incident_id,result,reason) VALUES(?,?,?,?,?,?,?,?,?,?)",
				);
				for (const row of frozenHistorical)
					insert.run(
						LEGACY_BATCH_ID,
						"legacy_backfill",
						row.source_ref,
						row.run_id,
						row.node_id,
						row.attempt,
						row.execution_id,
						null,
						"pending",
						null,
					);
				for (const row of frozenIncidents)
					insert.run(
						LEGACY_BATCH_ID,
						"legacy_incident",
						row.incident_id,
						null,
						null,
						null,
						`legacy-incident:${row.incident_id}`,
						row.incident_id,
						"pending",
						null,
					);
				if (overflow)
					insert.run(
						LEGACY_BATCH_ID,
						"freeze_guard",
						`limit:${LEGACY_FREEZE_LIMIT}`,
						null,
						null,
						null,
						null,
						null,
						"skipped",
						"legacy_freeze_limit_exceeded",
					);
				this.db
					.prepare(
						"UPDATE codex_quota_legacy_batch SET total_count=(SELECT COUNT(*) FROM codex_quota_legacy_member WHERE batch_id=?) WHERE batch_id=?",
					)
					.run(LEGACY_BATCH_ID, LEGACY_BATCH_ID);
				batch = this.db
					.prepare("SELECT * FROM codex_quota_legacy_batch WHERE batch_id=?")
					.get(LEGACY_BATCH_ID) as Record<string, unknown>;
			}
			if (batch.state === "sealed") return 0;
			const members = this.db
				.prepare(
					"SELECT * FROM codex_quota_legacy_member WHERE batch_id=? AND result='pending' ORDER BY source,source_ref LIMIT ?",
				)
				.all(LEGACY_BATCH_ID, passLimit) as Record<string, unknown>[];
			for (const member of members) {
				try {
					if (member.source === "legacy_backfill")
						this.processLegacyBackfillMember(member);
					else if (member.source === "legacy_incident")
						this.processLegacyIncidentMember(member);
					else throw new Error("legacy_member_source_invalid");
				} catch {
					const attemptCount = Number(member.attempt_count) + 1;
					this.db
						.prepare(
							"UPDATE codex_quota_legacy_member SET attempt_count=?,result=?,reason=? WHERE batch_id=? AND source=? AND source_ref=?",
						)
						.run(
							attemptCount,
							attemptCount >= LEGACY_MEMBER_MAX_ATTEMPTS
								? "skipped"
								: "pending",
							attemptCount >= LEGACY_MEMBER_MAX_ATTEMPTS
								? "legacy_member_skipped_after_3_failures"
								: "legacy_member_processing_failed",
							LEGACY_BATCH_ID,
							member.source,
							member.source_ref,
						);
				}
			}
			this.sealLegacyBatchIfComplete();
			return members.length;
		})();
	}

	private processLegacyBackfillMember(member: Record<string, unknown>): void {
		const row = this.db
			.prepare(`
                SELECT r.run_id,n.node_id,n.attempt,n.execution_id FROM workflow_run r
                JOIN workflow_run_node n ON n.run_id=r.run_id AND n.node_id=r.current_node_id
                JOIN sessions s ON s.execution_id=n.execution_id
                WHERE r.run_id=? AND n.node_id=? AND n.attempt=? AND n.execution_id=?
                  AND r.status='held' AND s.status IN ('failed','terminated','stopped')
                  AND s.last_error='goal ended non-complete: usageLimited'
                  AND n.attempt=(SELECT MAX(latest.attempt) FROM workflow_run_node latest WHERE latest.run_id=n.run_id AND latest.node_id=n.node_id)
                  AND NOT EXISTS (SELECT 1 FROM codex_quota_target t WHERE t.old_execution_id=n.execution_id)
                  AND EXISTS (SELECT 1 FROM workflow_run_event e WHERE e.run_id=r.run_id AND e.execution_id=n.execution_id AND e.node_id=n.node_id AND e.kind='retry_limit_escalated'
                    AND NOT EXISTS (SELECT 1 FROM workflow_run_event later WHERE later.run_id=r.run_id AND later.seq>e.seq AND later.kind IN ('run_held_by_operator','run_terminated','run_terminated_by_operator','run_terminated_by_supersession','run_completed','run_cancelled','run_shipped','land_held','unlaunched_admission_rolled_back','unlaunched_admission_held','rework_activation_stalled_held','rework_pane_loss_handoff','rework_retry_exhausted','completion_receipt_missing','retry_limit_escalated','environment_failure_escalated','loop_limit_escalated','rework_suppressed_idle_spin','workflow_gate_origin_preflight_terminal')))
            `)
			.get(
				member.run_id,
				member.node_id,
				member.attempt,
				member.execution_id,
			) as
			| {
					run_id: string;
					node_id: string;
					attempt: number;
					execution_id: string;
			  }
			| undefined;
		if (!row) {
			this.finishLegacyMember(
				member,
				"skipped",
				"legacy_source_no_longer_held",
			);
			return;
		}
		const bindings = this.getRunnerBindings(row.execution_id).filter(
			(binding) => binding.runId === row.run_id,
		);
		const binding = bindings.length === 1 ? bindings[0] : undefined;
		this.recordSignal({
			executionId: row.execution_id,
			bindingId: binding?.bindingId,
			nodeId: row.node_id,
			attempt: row.attempt,
			source: "legacy_backfill",
			sourceEventId: String(member.source_ref),
			availability: {
				mode: "manual",
				reasons: ["legacy_capacity_evidence_missing"],
				revision: 0,
				checkedAt: new Date().toISOString(),
			},
			suppressNotification: true,
		});
		const signal = this.db
			.prepare(
				"SELECT event_key,disposition FROM codex_quota_signal_event WHERE source='legacy_backfill' AND source_event_id=? AND execution_id=?",
			)
			.get(member.source_ref, row.execution_id) as {
			event_key: string;
			disposition: string;
		};
		if (signal.disposition !== "manual") {
			this.finishLegacyMember(
				member,
				"skipped",
				"legacy_source_already_automatic",
			);
			return;
		}
		const guarded =
			binding &&
			this.hasRootGenerationSafetyGuard(
				binding.credentialRootKey,
				binding.generation,
			);
		this.finishLegacyMember(
			member,
			guarded ? "guarded" : "manual",
			guarded
				? "current_capacity_or_install_guard"
				: "legacy_capacity_evidence_missing",
			signal.event_key,
		);
	}

	private processLegacyIncidentMember(member: Record<string, unknown>): void {
		const incidentId = String(member.incident_id);
		const incident = this.getIncident(incidentId);
		if (!incident) {
			this.finishLegacyMember(member, "skipped", "legacy_incident_missing");
			return;
		}
		const rootKey = String(incident.root_key);
		const generation = Number(incident.generation);
		if (this.hasRootGenerationSafetyGuard(rootKey, generation)) {
			this.finishLegacyMember(
				member,
				"guarded",
				"current_capacity_or_install_guard",
			);
			return;
		}
		if (!this.canRecordManualDisposition(incidentId)) {
			this.finishLegacyMember(
				member,
				"guarded",
				"ambiguous_install_or_recovery_guard",
			);
			return;
		}
		const source = "legacy_incident" as const;
		const sourceEventId = incidentId;
		const executionId = `legacy-incident:${incidentId}`;
		const eventKey = quotaSignalEventKey(source, executionId, sourceEventId);
		const now = new Date().toISOString();
		this.db
			.prepare(
				"INSERT OR IGNORE INTO codex_quota_signal_event(event_key,source,source_event_id,execution_id,binding_id,root_key,generation,observed_at,payload_digest,disposition,reason_codes_json) VALUES(?,?,?,?,NULL,?,?,?,?,'pending','[]')",
			)
			.run(
				eventKey,
				source,
				sourceEventId,
				executionId,
				rootKey,
				generation,
				now,
				quotaSignalPayloadDigest({ source, sourceEventId, executionId }),
			);
		this.finishSignalManual({
			eventKey,
			incidentId,
			source,
			sourceEventId,
			executionId,
			binding: undefined,
			reasons: ["legacy_capacity_evidence_missing"],
			now,
			suppressNotification: true,
		});
		this.finishLegacyMember(
			member,
			"manual",
			"legacy_capacity_evidence_missing",
			eventKey,
		);
	}

	private finishLegacyMember(
		member: Record<string, unknown>,
		result: "manual" | "guarded" | "skipped",
		reason: string,
		eventKey?: string,
	): void {
		this.db
			.prepare(
				"UPDATE codex_quota_legacy_member SET result=?,reason=?,event_key=?,attempt_count=attempt_count+1 WHERE batch_id=? AND source=? AND source_ref=? AND result='pending'",
			)
			.run(
				result,
				reason,
				eventKey ?? null,
				LEGACY_BATCH_ID,
				member.source,
				member.source_ref,
			);
	}

	private sealLegacyBatchIfComplete(): void {
		const pending = this.db
			.prepare(
				"SELECT 1 FROM codex_quota_legacy_member WHERE batch_id=? AND result='pending' LIMIT 1",
			)
			.get(LEGACY_BATCH_ID);
		if (pending) return;
		const totals = this.db
			.prepare(`
                SELECT COUNT(*) AS total_count,
                  SUM(CASE WHEN result='manual' THEN 1 ELSE 0 END) AS manual_count,
                  SUM(CASE WHEN result='guarded' THEN 1 ELSE 0 END) AS guarded_count,
                  SUM(CASE WHEN result='skipped' THEN 1 ELSE 0 END) AS skipped_count,
                  SUM(CASE WHEN reason IN ('legacy_freeze_limit_exceeded','legacy_member_skipped_after_3_failures') THEN 1 ELSE 0 END) AS failed_count
                FROM codex_quota_legacy_member WHERE batch_id=?
            `)
			.get(LEGACY_BATCH_ID) as Record<string, number>;
		const sealedAt = new Date().toISOString();
		this.db
			.prepare(
				"UPDATE codex_quota_legacy_batch SET state='sealed',total_count=?,manual_count=?,guarded_count=?,skipped_count=?,failed_count=?,sealed_at=? WHERE batch_id=? AND state='collecting'",
			)
			.run(
				Number(totals.total_count),
				Number(totals.manual_count),
				Number(totals.guarded_count),
				Number(totals.skipped_count),
				Number(totals.failed_count),
				sealedAt,
				LEGACY_BATCH_ID,
			);
		if (Number(totals.total_count) === 0) return;
		const reasons = this.db
			.prepare(
				"SELECT reason,COUNT(*) AS count FROM codex_quota_legacy_member WHERE batch_id=? AND reason IS NOT NULL GROUP BY reason ORDER BY reason",
			)
			.all(LEGACY_BATCH_ID) as { reason: string; count: number }[];
		this.enqueueOutbox({
			incidentId: null,
			kind: "automation_disabled",
			eventId: `${LEGACY_BATCH_ID}:N11:summary`,
			destination: "lead",
			payload: {
				scope: "legacy_batch",
				batchId: LEGACY_BATCH_ID,
				totalCount: Number(totals.total_count),
				manualCount: Number(totals.manual_count),
				guardedCount: Number(totals.guarded_count),
				skippedCount: Number(totals.skipped_count),
				failedCount: Number(totals.failed_count),
				reasonCounts: Object.fromEntries(
					reasons.map((row) => [row.reason, Number(row.count)]),
				),
				manualUntilGenerationChange: Number(totals.manual_count) > 0,
				sealedAt,
			},
		});
	}

	/**
	 * FLY-2900: the single quota causal counter. Signals and reading requests
	 * draw from it inside synchronous StateStore transactions, so "a reading
	 * was requested after a wall" is a pure integer comparison.
	 */
	allocateCausalSeq(): number {
		return this.db.transaction(() => {
			this.db
				.prepare(
					"INSERT INTO codex_quota_sequence(name,value) VALUES('quota_causal',1) ON CONFLICT(name) DO UPDATE SET value=value+1",
				)
				.run();
			const row = this.db
				.prepare(
					"SELECT value FROM codex_quota_sequence WHERE name='quota_causal'",
				)
				.get() as { value: number };
			if (!Number.isSafeInteger(row.value) || row.value < 1)
				throw new Error("quota_causal_sequence_invalid");
			return row.value;
		})();
	}
	/** Causal number of one recorded signal; a legacy row without one is 0. */
	signalSeqFor(
		source: CodexQuotaSignalSource,
		executionId: string,
		sourceEventId: string,
	): number | null {
		const row = this.db
			.prepare(
				"SELECT COALESCE(signal_seq,0) AS seq FROM codex_quota_signal_event WHERE event_key=?",
			)
			.get(quotaSignalEventKey(source, executionId, sourceEventId)) as
			| { seq: number }
			| undefined;
		return row ? Number(row.seq) : null;
	}
	getStandby(executionId: string): CodexQuotaStandbyRow | undefined {
		return this.db
			.prepare("SELECT * FROM codex_quota_standby WHERE execution_id=?")
			.get(executionId) as CodexQuotaStandbyRow | undefined;
	}
	listStandby(
		states: readonly CodexQuotaStandbyState[] = [
			"standby",
			"resuming",
			"fallback_prepared",
		],
	): CodexQuotaStandbyRow[] {
		if (!states.length) return [];
		return this.db
			.prepare(
				`SELECT * FROM codex_quota_standby WHERE state IN (${states.map(() => "?").join(",")}) ORDER BY trigger_signal_seq,execution_id`,
			)
			.all(...states) as CodexQuotaStandbyRow[];
	}
	/** FLY-2900 §2.7: standby entries of one (run,node,attempt) since an instant. */
	countStandbyEntriesSince(input: {
		runId: string;
		nodeId: string;
		attempt: number;
		since: string;
	}): number {
		return Number(
			(
				this.db
					.prepare(
						"SELECT COUNT(*) AS n FROM codex_quota_resume_audit WHERE action='standby_entered' AND run_id=? AND node_id=? AND attempt=? AND at>=?",
					)
					.get(input.runId, input.nodeId, input.attempt, input.since) as {
					n: number;
				}
			).n,
		);
	}
	/**
	 * FLY-2900 §2.6: append one resume audit row. The uid is scoped by the
	 * execution, its standby entry and the action, numbered in arrival order.
	 */
	appendResumeAudit(input: {
		executionId: string;
		entrySeq: number;
		action: CodexQuotaResumeAuditAction;
		at: string;
		runId?: string | null;
		issueId?: string | null;
		nodeId?: string | null;
		attempt?: number | null;
		permitKind?: string | null;
		fromProfile?: string | null;
		toProfile?: string | null;
		vendor?: string | null;
		detailCode?: string | null;
	}): string {
		const detail =
			input.detailCode == null
				? null
				: CODEX_QUOTA_MACHINE_CODE.test(input.detailCode)
					? input.detailCode
					: "invalid_detail_code";
		const prefix = `${input.executionId}:${input.entrySeq}:${input.action}:`;
		const n =
			Number(
				(
					this.db
						.prepare(
							"SELECT COUNT(*) AS n FROM codex_quota_resume_audit WHERE execution_id=? AND substr(event_uid,1,?)=?",
						)
						.get(input.executionId, prefix.length, prefix) as { n: number }
				).n,
			) + 1;
		const eventUid = `${prefix}${n}`;
		this.db
			.prepare(
				"INSERT INTO codex_quota_resume_audit(event_uid,at,execution_id,run_id,issue_id,node_id,attempt,action,permit_kind,from_profile,to_profile,vendor,detail_code) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
			)
			.run(
				eventUid,
				input.at,
				input.executionId,
				input.runId ?? null,
				input.issueId ?? null,
				input.nodeId ?? null,
				input.attempt ?? null,
				input.action,
				input.permitKind ?? null,
				input.fromProfile ?? null,
				input.toProfile ?? null,
				input.vendor ?? null,
				detail,
			);
		return eventUid;
	}
	listResumeAudit(executionId?: string): Record<string, unknown>[] {
		return (
			executionId === undefined
				? this.db
						.prepare(
							"SELECT * FROM codex_quota_resume_audit ORDER BY at,rowid LIMIT 2048",
						)
						.all()
				: this.db
						.prepare(
							"SELECT * FROM codex_quota_resume_audit WHERE execution_id=? ORDER BY at,rowid",
						)
						.all(executionId)
		) as Record<string, unknown>[];
	}
	/**
	 * FLY-2900 §3.3: the newest permit a parked execution qualifies for right
	 * now: current root generation, covers its trigger, not voided by a later
	 * relevant wall. Unbound carriers may use any root's current permit.
	 */
	eligiblePermitFor(
		executionId: string,
	): CodexQuotaCapacityPermitRow | undefined {
		const row = this.getStandby(executionId);
		if (!row) return undefined;
		return this.db
			.prepare(
				`SELECT p.* FROM codex_quota_capacity_permit p
				   JOIN codex_quota_root r ON r.root_key=p.root_key AND r.generation=p.generation
				    AND r.account_key=p.account_key AND r.profile=p.profile
				  WHERE p.covers_signal_seq >= ?
				    AND (? IS NULL OR p.root_key = ?)
				    AND NOT EXISTS (${RELEVANT_SIGNAL_AFTER})
				  ORDER BY p.covers_signal_seq DESC, p.created_at DESC, p.permit_id DESC
				  LIMIT 1`,
			)
			.get(row.trigger_signal_seq, row.root_key, row.root_key) as
			| CodexQuotaCapacityPermitRow
			| undefined;
	}
	/** A permit is still valid for its root's current generation (§3.3 sequence fences). */
	isPermitCurrent(permitId: string): boolean {
		return !!this.db
			.prepare(
				`SELECT 1 FROM codex_quota_capacity_permit p
				   JOIN codex_quota_root r ON r.root_key=p.root_key AND r.generation=p.generation
				    AND r.account_key=p.account_key AND r.profile=p.profile
				  WHERE p.permit_id=? AND NOT EXISTS (${RELEVANT_SIGNAL_AFTER})`,
			)
			.get(permitId);
	}
	getPermit(permitId: string): CodexQuotaCapacityPermitRow | undefined {
		return this.db
			.prepare("SELECT * FROM codex_quota_capacity_permit WHERE permit_id=?")
			.get(permitId) as CodexQuotaCapacityPermitRow | undefined;
	}
	/** Durable probe-equivalent proof. Never fabricates installation material or a probe result. */
	getResumeOutputRecoveryPermit(
		incidentId: string,
	): Record<string, unknown> | undefined {
		const incident = this.getIncident(incidentId);
		if (!incident) return undefined;
		const proof = this.db
			.prepare(`SELECT p.root_key,p.generation AS installed_generation,
			proof.auth_digest AS installed_auth_digest,proof.claim_id,proof.output_seq
			FROM codex_quota_resume_output_proof proof
			JOIN codex_quota_capacity_permit p ON p.permit_id=proof.permit_id
			JOIN codex_quota_root r ON r.root_key=p.root_key AND r.generation=p.generation
			 AND r.account_key=p.account_key AND r.profile=p.profile
			JOIN codex_quota_binding b ON b.binding_id=proof.binding_id
			 AND b.execution_id=proof.execution_id AND b.root_key=p.root_key
			 AND b.generation=p.generation AND b.account_key=p.account_key AND b.profile=p.profile
			WHERE p.root_key=? AND p.generation>? AND p.kind='reading_confirmed'
			 AND proof.output_seq>proof.identity_seq AND proof.identity_seq>p.covers_signal_seq
			 AND NOT EXISTS (${RELEVANT_SIGNAL_AFTER})
			ORDER BY proof.output_seq DESC LIMIT 1`)
			.get(incident.root_key, incident.generation) as
			| Record<string, unknown>
			| undefined;
		return proof
			? {
					...incident,
					...proof,
					state: "settled",
					recovery_proof_kind: "resume_output",
				}
			: undefined;
	}
	/** Highest signal number recorded against a root (or unbound), below a bound. */
	private maxRootSignalSeqBelow(rootKey: string, bound: number): number {
		return Number(
			(
				this.db
					.prepare(
						"SELECT COALESCE(MAX(COALESCE(signal_seq,0)),0) AS seq FROM codex_quota_signal_event WHERE (root_key=? OR root_key IS NULL) AND COALESCE(signal_seq,0) < ?",
					)
					.get(rootKey, bound) as { seq: number }
			).seq,
		);
	}
	private insertPermit(input: {
		kind: CodexQuotaCapacityPermitRow["kind"];
		rootKey: string;
		generation: number;
		accountKey: string;
		profile: string;
		coversSignalSeq: number;
		evidenceRef: string;
		now: string;
	}): CodexQuotaCapacityPermitRow {
		const permitId = `${input.kind}:${input.rootKey}:${input.generation}:${input.coversSignalSeq}`;
		this.db
			.prepare(
				"INSERT OR IGNORE INTO codex_quota_capacity_permit(permit_id,root_key,generation,kind,account_key,profile,covers_signal_seq,evidence_ref,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
			)
			.run(
				permitId,
				input.rootKey,
				input.generation,
				input.kind,
				input.accountKey,
				input.profile,
				input.coversSignalSeq,
				input.evidenceRef,
				input.now,
			);
		return this.getPermit(permitId)!;
	}
	/**
	 * FLY-2900 §3.2: turn one post-wall reading of the canonical account into a
	 * permit. The reading must be the canonical login, requested after every
	 * pending wall (causal sequence, not wall clock), fresh, with both windows
	 * known and below 100 %, and no relevant wall may have landed after its
	 * request. When this generation itself walled, a same-account generation is
	 * opened (manual switches already moved the generation).
	 */
	issueReadingConfirmedPermit(input: {
		rootKey: string;
		expectedGeneration: number;
		authDigest: string;
		reading: CodexReadingEvidence | undefined;
		activeAccount: string | null;
		nowMs: number;
	}): CodexReadingPermitOutcome {
		return this.db.transaction((): CodexReadingPermitOutcome => {
			const refuse = (
				reason: string,
				needsRefresh = false,
			): CodexReadingPermitOutcome => ({
				outcome: "refused",
				reason,
				needsRefresh,
			});
			const root = this.getRoot(input.rootKey);
			if (!root || root.generation !== input.expectedGeneration)
				return refuse("generation_moved");
			const parked = this.db
				.prepare(
					"SELECT execution_id,trigger_signal_seq FROM codex_quota_standby WHERE state='standby' AND (root_key=? OR root_key IS NULL) ORDER BY trigger_signal_seq",
				)
				.all(root.rootKey) as {
				execution_id: string;
				trigger_signal_seq: number;
			}[];
			const pending = parked.filter(
				(row) => !this.eligiblePermitFor(row.execution_id),
			);
			if (pending.length === 0) {
				const permit = parked[0]
					? this.eligiblePermitFor(parked[0].execution_id)
					: undefined;
				return permit
					? { outcome: "exists", permit }
					: { outcome: "not_needed" };
			}
			const evidence = input.reading;
			if (!evidence) return refuse("reading_missing", true);
			if (
				evidence.name !== root.profile ||
				evidence.identityKey !== root.accountKey
			)
				return refuse("reading_identity_mismatch");
			if (input.activeAccount !== root.profile)
				return refuse("reading_not_active");
			const requestSeq = evidence.requestSeq;
			if (
				requestSeq === undefined ||
				!Number.isSafeInteger(requestSeq) ||
				requestSeq < 1
			)
				return refuse("reading_unsequenced", true);
			const maxTrigger = Math.max(
				...pending.map((row) => row.trigger_signal_seq),
			);
			if (requestSeq <= maxTrigger)
				return refuse("reading_predates_wall", true);
			const observedMs =
				evidence.observedAt === null
					? Number.NaN
					: Date.parse(evidence.observedAt);
			if (
				!Number.isFinite(observedMs) ||
				observedMs > input.nowMs + READING_PERMIT_FUTURE_SKEW_MS ||
				input.nowMs - observedMs > CODEX_READING_PERMIT_FRESH_MS
			)
				return refuse("reading_stale", true);
			if (evidence.fiveH === null || evidence.weekly === null)
				return refuse("reading_window_unknown");
			if (
				evidence.fiveH.usedPercent >= 100 ||
				evidence.weekly.usedPercent >= 100
			)
				return refuse("reading_exhausted");
			if (
				this.db
					.prepare(
						"SELECT 1 FROM codex_quota_signal_event WHERE COALESCE(signal_seq,0) >= ? AND ((root_key=? AND generation>=?) OR root_key IS NULL) LIMIT 1",
					)
					.get(requestSeq, root.rootKey, root.generation)
			)
				return refuse("reading_superseded", true);
			const nowIso = new Date(input.nowMs).toISOString();
			let generation = root.generation;
			const walledThisGeneration = !!this.db
				.prepare(
					"SELECT 1 FROM codex_quota_signal_event WHERE root_key=? AND generation=? AND signal_seq IS NOT NULL LIMIT 1",
				)
				.get(root.rootKey, root.generation);
			if (walledThisGeneration) {
				if (
					!Number.isSafeInteger(root.generation + 1) ||
					this.db
						.prepare(
							"SELECT 1 FROM codex_quota_incident WHERE root_key=? AND state='installing' LIMIT 1",
						)
						.get(root.rootKey)
				)
					return refuse("installation_pending");
				generation = root.generation + 1;
				this.db
					.prepare(
						"INSERT INTO codex_quota_external_generation(root_key,generation,account_key,profile,auth_digest,observed_at,reason) VALUES(?,?,?,?,?,?,'reading_confirmed')",
					)
					.run(
						root.rootKey,
						generation,
						root.accountKey,
						root.profile,
						input.authDigest,
						nowIso,
					);
				this.db
					.prepare(
						"UPDATE codex_quota_root SET generation=? WHERE root_key=? AND generation=?",
					)
					.run(generation, root.rootKey, root.generation);
			}
			// Readings permit a fresh attempt; only a verified process's successful
			// output can authorize recovery of admission/review/legacy casualties.

			const digest = createHash("sha256")
				.update(
					JSON.stringify({
						observedAt: evidence.observedAt,
						fiveH: evidence.fiveH,
						weekly: evidence.weekly,
					}),
				)
				.digest("hex")
				.slice(0, 16);
			const permit = this.insertPermit({
				kind: "reading_confirmed",
				rootKey: root.rootKey,
				generation,
				accountKey: root.accountKey,
				profile: root.profile,
				coversSignalSeq: this.maxRootSignalSeqBelow(root.rootKey, requestSeq),
				evidenceRef: `reading:${requestSeq}:${digest}`,
				now: nowIso,
			});
			return { outcome: "issued", permit };
		})();
	}
	/**
	 * FLY-2900 §3.3/§4.1: the workflow fences a parked execution must still pass
	 * to be relaunched — run active, node live on this execution, no operator
	 * close intent. Returns the refusal code, or null.
	 */
	standbyWorkflowFence(row: CodexQuotaStandbyRow): string | null {
		const run = this.db
			.prepare("SELECT status FROM workflow_run WHERE run_id=?")
			.get(row.run_id) as { status: string } | undefined;
		if (!run || run.status !== "active") return "run_not_active";
		const node = this.db
			.prepare(
				"SELECT state,execution_id FROM workflow_run_node WHERE run_id=? AND node_id=? AND attempt=?",
			)
			.get(row.run_id, row.node_id, row.attempt) as
			| { state: string; execution_id: string | null }
			| undefined;
		if (
			!node ||
			node.execution_id !== row.execution_id ||
			(node.state !== "admitted" && node.state !== "running")
		)
			return "node_not_live";
		if (
			this.db
				.prepare(
					"SELECT 1 FROM workflow_operator_close_intent WHERE execution_id=? AND stage IN ('prepared','committed')",
				)
				.get(row.execution_id)
		)
			return "operator_close_intent";
		return null;
	}
	/**
	 * FLY-2900 §6 step 2: claim a permit for one parked execution. CAS
	 * standby→resuming, bind the permit and attempt, keep (or mint) the durable
	 * continue id, and register a binding for the relaunched process on the
	 * current root generation so a later wall is attributed to it.
	 */
	claimResume(input: {
		executionId: string;
		ownerClaimId: string;
		now: string;
		leaseMs: number;
	}):
		| {
				ok: true;
				authorization: CodexQuotaResumeAuthorization;
				continueAttemptId: string;
				continueAttemptFresh: boolean;
				permit: CodexQuotaCapacityPermitRow;
				bindingId: string;
		  }
		| { ok: false; reason: string } {
		if (!CODEX_QUOTA_CLAIM_ID.test(input.ownerClaimId))
			throw new Error("invalid_quota_claim_id");
		return this.db.transaction(() => {
			const row = this.getStandby(input.executionId);
			if (!row || row.state !== "standby")
				return { ok: false as const, reason: "not_standby" };
			if (row.mechanical_failures >= CODEX_QUOTA_MECHANICAL_BUDGET)
				return { ok: false as const, reason: "mechanical_budget_exhausted" };
			const fence = this.standbyWorkflowFence(row);
			if (fence) return { ok: false as const, reason: fence };
			const permit = this.eligiblePermitFor(input.executionId);
			if (!permit) return { ok: false as const, reason: "no_permit" };
			const root = this.getRoot(permit.root_key);
			if (!root || root.generation !== permit.generation)
				return { ok: false as const, reason: "no_permit" };
			const samePermit = row.permit_id === permit.permit_id;
			const mechanicalFailures = samePermit ? row.mechanical_failures : 0;
			const resumeAttempt = mechanicalFailures + 1;
			const continueAttemptFresh = row.continue_attempt_id === null;
			const continueAttemptId = row.continue_attempt_id ?? randomUUID();
			const bindingId = randomUUID();
			this.registerBinding({
				bindingId,
				executionId: row.execution_id,
				runId: row.run_id,
				purpose: "runner",
				accountKey: root.accountKey,
				profile: root.profile,
				generation: root.generation,
				credentialRootKey: root.rootKey,
			});
			const leaseExpiresAt = new Date(
				Date.parse(input.now) + input.leaseMs,
			).toISOString();
			const changed = this.db
				.prepare(
					"UPDATE codex_quota_standby SET state='resuming',resume_phase='launching',permit_id=?,resume_attempt=?,mechanical_failures=?,continue_attempt_id=?,continue_turn_id=NULL,owner_claim_id=?,lease_expires_at=?,root_key=?,generation=?,binding_id=?,last_error_code=NULL,updated_at=? WHERE execution_id=? AND state='standby'",
				)
				.run(
					permit.permit_id,
					resumeAttempt,
					mechanicalFailures,
					continueAttemptId,
					input.ownerClaimId,
					leaseExpiresAt,
					root.rootKey,
					root.generation,
					bindingId,
					input.now,
					row.execution_id,
				).changes;
			if (changed !== 1) return { ok: false as const, reason: "claim_race" };
			this.appendResumeAudit({
				executionId: row.execution_id,
				entrySeq: row.entry_seq,
				action: "resume_started",
				at: input.now,
				runId: row.run_id,
				nodeId: row.node_id,
				attempt: row.attempt,
				permitKind: permit.kind,
				toProfile: root.profile,
				detailCode: `attempt_${resumeAttempt}`,
			});
			return {
				ok: true as const,
				authorization: {
					executionId: row.execution_id,
					claimId: input.ownerClaimId,
					entrySeq: row.entry_seq,
					resumeAttempt,
				},
				continueAttemptId,
				continueAttemptFresh,
				permit,
				bindingId,
			};
		})();
	}
	/**
	 * FLY-2900 §4.1 validateActiveAuthorization: the exact live claim, entry and
	 * attempt, an unexpired lease, a permit that still satisfies the §3.3
	 * sequence fences, and the workflow fences. Deliberately not the pre-claim
	 * mechanical budget.
	 */
	activeResumeClaim(
		authorization: CodexQuotaResumeAuthorization | undefined,
		nowMs = Date.now(),
	): CodexQuotaStandbyRow | undefined {
		if (!authorization) return undefined;
		const row = this.getStandby(authorization.executionId);
		if (
			!row ||
			row.state !== "resuming" ||
			row.owner_claim_id !== authorization.claimId ||
			row.entry_seq !== authorization.entrySeq ||
			row.resume_attempt !== authorization.resumeAttempt ||
			(authorization.resumeAttempt !== 1 && authorization.resumeAttempt !== 2)
		)
			return undefined;
		const leaseMs =
			row.lease_expires_at === null
				? Number.NaN
				: Date.parse(row.lease_expires_at);
		if (!Number.isFinite(leaseMs) || leaseMs <= nowMs) return undefined;
		if (!row.permit_id || !this.isPermitCurrent(row.permit_id))
			return undefined;
		const permit = this.getPermit(row.permit_id);
		if (!permit || permit.covers_signal_seq < row.trigger_signal_seq)
			return undefined;
		if (this.standbyWorkflowFence(row)) return undefined;
		return row;
	}
	/** FLY-2900 §3.2: the binding a live claim registered for its relaunch. */
	claimedResumeBinding(
		authorization: CodexQuotaResumeAuthorization,
	): CodexQuotaBindingV1 | null {
		const row = this.activeResumeClaim(authorization);
		if (!row?.binding_id) return null;
		const binding = this.getBinding(row.binding_id);
		return binding && binding.executionId === row.execution_id ? binding : null;
	}
	resumeVerificationStatus(
		authorization: CodexQuotaResumeAuthorization,
	): "pending" | "accepted" | "rejected" {
		const row = this.getStandby(authorization.executionId);
		if (
			!row ||
			row.state !== "resuming" ||
			row.owner_claim_id !== authorization.claimId
		)
			return "rejected";
		if (!this.activeResumeClaim(authorization)) return "rejected";
		return row.resume_phase === "identity_verified" ||
			row.resume_phase === "continuing"
			? "accepted"
			: "pending";
	}
	markResumeIdentityVerified(
		authorization: CodexQuotaResumeAuthorization,
		now: string,
		evidence?: { sessionId: string; authDigest?: string },
	): boolean {
		return this.db.transaction(() => {
			const row = this.activeResumeClaim(authorization, Date.parse(now));
			if (!row || row.resume_phase !== "launching") return false;
			const permit = row.permit_id ? this.getPermit(row.permit_id) : undefined;
			if (
				permit?.kind === "reading_confirmed" &&
				row.binding_id &&
				row.continue_attempt_id &&
				evidence?.sessionId &&
				evidence.sessionId.length <= 256 &&
				/^[0-9a-f]{64}$/.test(evidence.authDigest ?? "")
			) {
				this.db
					.prepare(`INSERT INTO codex_quota_resume_output_proof
					(claim_id,permit_id,execution_id,binding_id,continue_attempt_id,session_id,auth_digest,identity_seq)
					VALUES(?,?,?,?,?,?,?,?)`)
					.run(
						row.owner_claim_id,
						permit.permit_id,
						row.execution_id,
						row.binding_id,
						row.continue_attempt_id,
						evidence.sessionId,
						evidence.authDigest,
						this.allocateCausalSeq(),
					);
			}
			this.db
				.prepare(
					"UPDATE codex_quota_standby SET resume_phase='identity_verified',updated_at=? WHERE execution_id=? AND owner_claim_id=? AND state='resuming' AND resume_phase='launching'",
				)
				.run(now, row.execution_id, authorization.claimId);
			this.appendResumeAudit({
				executionId: row.execution_id,
				entrySeq: row.entry_seq,
				action: "identity_verified",
				at: now,
				runId: row.run_id,
				nodeId: row.node_id,
				attempt: row.attempt,
			});
			return true;
		})();
	}
	markContinueStarted(
		authorization: CodexQuotaResumeAuthorization,
		turnId: string,
		now: string,
	): boolean {
		if (!turnId || turnId.length > 256) return false;
		return this.db.transaction(() => {
			const row = this.activeResumeClaim(authorization, Date.parse(now));
			if (!row || row.resume_phase !== "identity_verified") return false;
			this.db
				.prepare(
					"UPDATE codex_quota_standby SET resume_phase='continuing',continue_turn_id=?,updated_at=? WHERE execution_id=? AND owner_claim_id=? AND state='resuming' AND resume_phase='identity_verified'",
				)
				.run(turnId, now, row.execution_id, authorization.claimId);
			this.appendResumeAudit({
				executionId: row.execution_id,
				entrySeq: row.entry_seq,
				action: "continue_started",
				at: now,
				runId: row.run_id,
				nodeId: row.node_id,
				attempt: row.attempt,
			});
			return true;
		})();
	}
	/**
	 * FLY-2900 §6 step 4: the single success settlement. Closes the carrier,
	 * marks every unsettled FLY-2465 runner target of this execution recovered
	 * (whatever incident), audits `resumed` and enqueues the thread notice.
	 * Only two proofs reach it, both under the live claim: the continue turn's
	 * first model output (`requireTurn` + `turnId`) and a `thread/read`
	 * reconciliation that proved the carried continue produced output.
	 */
	settleResumeSuccess(input: {
		authorization: CodexQuotaResumeAuthorization;
		turnId?: string;
		requireTurn: boolean;
		now: string;
	}): boolean {
		return this.db.transaction(() => {
			const row = this.activeResumeClaim(
				input.authorization,
				Date.parse(input.now),
			);
			if (
				!row ||
				!["identity_verified", "continuing"].includes(row.resume_phase ?? "")
			)
				return false;
			if (
				input.requireTurn &&
				(row.resume_phase !== "continuing" ||
					!input.turnId ||
					row.continue_turn_id !== input.turnId)
			)
				return false;
			const changed = this.db
				.prepare(
					"UPDATE codex_quota_standby SET state='closed',resume_phase=NULL,owner_claim_id=NULL,lease_expires_at=NULL,continue_attempt_id=NULL,continue_turn_id=NULL,last_error_code=NULL,updated_at=? WHERE execution_id=? AND state='resuming' AND owner_claim_id IS ?",
				)
				.run(input.now, row.execution_id, row.owner_claim_id).changes;
			if (changed !== 1) return false;
			this.db
				.prepare(
					"UPDATE codex_quota_target SET state='recovered',last_error=NULL WHERE old_execution_id=? AND target_kind='runner' AND state NOT IN ('recovered','abandoned')",
				)
				.run(row.execution_id);
			const permit = row.permit_id ? this.getPermit(row.permit_id) : undefined;
			if (permit?.kind === "reading_confirmed") {
				// An observed first output proves this live claim. A carried turn
				// additionally needs its original identity under the SAME permit,
				// credential bytes and thread, never today's identity for an old turn.
				this.db
					.prepare(`UPDATE codex_quota_resume_output_proof AS proof
					SET output_seq=?,proved_at=? WHERE claim_id=? AND permit_id=?
					AND (? OR EXISTS (SELECT 1 FROM codex_quota_resume_output_proof prior
					 WHERE prior.claim_id<>proof.claim_id AND prior.permit_id=proof.permit_id
					 AND prior.continue_attempt_id=proof.continue_attempt_id
					 AND prior.auth_digest=proof.auth_digest AND prior.session_id=proof.session_id
					 AND prior.identity_seq<proof.identity_seq))`)
					.run(
						this.allocateCausalSeq(),
						input.now,
						row.owner_claim_id,
						permit.permit_id,
						input.requireTurn ? 1 : 0,
					);
				for (const incident of this.listIncidents()) {
					if (
						incident.root_key !== permit.root_key ||
						Number(incident.generation) >= permit.generation ||
						["installing", "committed", "recovering"].includes(
							String(incident.state),
						) ||
						!this.getResumeOutputRecoveryPermit(String(incident.incident_id))
					)
						continue;
					this.setIncidentState(String(incident.incident_id), "settled");
				}
			}
			const standbyMs = Date.parse(input.now) - Date.parse(row.entered_at);
			this.appendResumeAudit({
				executionId: row.execution_id,
				entrySeq: row.entry_seq,
				action: "resumed",
				at: input.now,
				runId: row.run_id,
				nodeId: row.node_id,
				attempt: row.attempt,
				permitKind: permit?.kind ?? null,
				toProfile: permit?.profile ?? null,
				vendor: "codex",
			});
			this.enqueueOutbox({
				incidentId: null,
				kind: "resume_notice",
				eventId: `codex-standby-resumed:${row.execution_id}:${row.entry_seq}`,
				destination: "issue_thread",
				payload: {
					notice: "resumed",
					executionId: row.execution_id,
					runId: row.run_id,
					nodeId: row.node_id,
					entrySeq: row.entry_seq,
					permitKind: permit?.kind ?? null,
					toProfile: permit?.profile ?? null,
					standbyMs: Number.isFinite(standbyMs) ? Math.max(0, standbyMs) : null,
				},
			});
			return true;
		})();
	}
	/**
	 * FLY-2900: the resumed body completed its node before any success proof
	 * was recorded (e.g. the first-output settlement was lost in a crash).
	 * The carrier closes so nothing relaunches a finished execution, but a
	 * completion is not first-output evidence: no `resumed` audit, no thread
	 * notice. Runs inside the terminal-signal transaction.
	 */
	closeResumingOnCompletion(executionId: string, now: string): boolean {
		return (
			this.db
				.prepare(
					"UPDATE codex_quota_standby SET state='closed',resume_phase=NULL,owner_claim_id=NULL,lease_expires_at=NULL,continue_attempt_id=NULL,continue_turn_id=NULL,last_error_code='completed_while_resuming',updated_at=? WHERE execution_id=? AND state='resuming'",
				)
				.run(now, executionId).changes === 1
		);
	}
	/**
	 * FLY-2900 §6 step 7 + §3.1/§6 step 6: send a resuming carrier back to
	 * standby. mechanical → counts against this permit's budget; capacity →
	 * counts capacity_rejections only; neutral (restart, unreadable history)
	 * counts nothing. The continue id is cleared only when its outcome is
	 * determined. `executionId` alone settles whatever claim is live (terminal
	 * signal path); `authorization` settles only that claim.
	 */
	failResume(input: {
		authorization?: CodexQuotaResumeAuthorization;
		executionId?: string;
		kind: "mechanical" | "capacity" | "neutral";
		detailCode: string;
		continueDetermined: boolean;
		now: string;
	}): { ok: true; mechanicalFailures: number } | { ok: false } {
		const executionId =
			input.authorization?.executionId ?? input.executionId ?? "";
		const detail = CODEX_QUOTA_MACHINE_CODE.test(input.detailCode)
			? input.detailCode
			: "resume_failed";
		return this.db.transaction(() => {
			const row = this.getStandby(executionId);
			if (!row || row.state !== "resuming") return { ok: false as const };
			if (
				input.authorization &&
				row.owner_claim_id !== input.authorization.claimId
			)
				return { ok: false as const };
			const mechanicalFailures =
				row.mechanical_failures + (input.kind === "mechanical" ? 1 : 0);
			this.db
				.prepare(
					`UPDATE codex_quota_standby SET state='standby',resume_phase=NULL,owner_claim_id=NULL,lease_expires_at=NULL,
					   mechanical_failures=?,capacity_rejections=capacity_rejections+?,
					   continue_attempt_id=CASE WHEN ? THEN NULL ELSE continue_attempt_id END,
					   continue_turn_id=NULL,last_error_code=?,updated_at=?
					 WHERE execution_id=? AND state='resuming' AND owner_claim_id IS ?`,
				)
				.run(
					mechanicalFailures,
					input.kind === "capacity" ? 1 : 0,
					input.continueDetermined ? 1 : 0,
					detail,
					input.now,
					row.execution_id,
					row.owner_claim_id,
				);
			this.appendResumeAudit({
				executionId: row.execution_id,
				entrySeq: row.entry_seq,
				action:
					input.kind === "capacity" ? "capacity_rejected" : "resume_failed",
				at: input.now,
				runId: row.run_id,
				nodeId: row.node_id,
				attempt: row.attempt,
				detailCode: detail,
			});
			return { ok: true as const, mechanicalFailures };
		})();
	}
	/** FLY-2900 §6 step 5: settle what the runner learned about a carried continue. */
	reconcileContinue(input: {
		authorization: CodexQuotaResumeAuthorization;
		outcome: CodexQuotaContinueReconciliation;
		now: string;
	}): CodexQuotaContinueDecision {
		const row = this.activeResumeClaim(
			input.authorization,
			Date.parse(input.now),
		);
		if (!row || row.continue_attempt_id === null)
			return { action: "abort", reason: "claim_lost" };
		switch (input.outcome.kind) {
			case "absent":
				return {
					action: "send",
					continueAttemptId: row.continue_attempt_id,
					settled: false,
				};
			case "proven":
				return this.settleResumeSuccess({
					authorization: input.authorization,
					requireTurn: false,
					now: input.now,
				})
					? { action: "send", continueAttemptId: randomUUID(), settled: true }
					: { action: "abort", reason: "claim_lost" };
			case "failed_before_output":
				this.failResume({
					authorization: input.authorization,
					kind: input.outcome.usageLimited ? "capacity" : "mechanical",
					detailCode: input.outcome.usageLimited
						? "continue_turn_failed_before_output:usage_limit_exceeded"
						: "continue_turn_failed_before_output",
					continueDetermined: true,
					now: input.now,
				});
				return {
					action: "abort",
					reason: input.outcome.usageLimited
						? "capacity_rejected"
						: "continue_turn_failed_before_output",
				};
			case "unavailable": {
				this.failResume({
					authorization: input.authorization,
					kind: "neutral",
					detailCode: "continue_reconcile_unavailable",
					continueDetermined: false,
					now: input.now,
				});
				const failures = Number(
					(
						this.db
							.prepare(
								"UPDATE codex_quota_standby SET reconcile_failures=reconcile_failures+1 WHERE execution_id=? RETURNING reconcile_failures",
							)
							.get(row.execution_id) as { reconcile_failures: number }
					).reconcile_failures,
				);
				if (failures >= CODEX_QUOTA_RECONCILE_ALERT_AFTER)
					this.enqueueOutbox({
						incidentId: `codex-standby:${row.execution_id}`,
						kind: "lead_diagnostic",
						eventId: `codex-standby-reconcile:${row.execution_id}:${row.entry_seq}`,
						destination: "lead",
						payload: {
							reason: "continue_reconcile_unavailable",
							executionId: row.execution_id,
							runId: row.run_id,
							nodeId: row.node_id,
							failures,
						},
					});
				return { action: "abort", reason: "continue_reconcile_unavailable" };
			}
		}
	}
	renewResumeLease(
		authorization: CodexQuotaResumeAuthorization,
		now: string,
		leaseMs: number,
	): boolean {
		return (
			this.db
				.prepare(
					"UPDATE codex_quota_standby SET lease_expires_at=?,updated_at=? WHERE execution_id=? AND owner_claim_id=? AND state='resuming' AND entry_seq=? AND resume_attempt=?",
				)
				.run(
					new Date(Date.parse(now) + leaseMs).toISOString(),
					now,
					authorization.executionId,
					authorization.claimId,
					authorization.entrySeq,
					authorization.resumeAttempt,
				).changes === 1
		);
	}
	/**
	 * FLY-2900 §6 step 7: claims left by an earlier Bridge process go back to
	 * standby without counting a failure and keep their continue id; the next
	 * relaunch reaps the orphan daemon first and reconciles.
	 */
	recoverAbandonedClaims(ownerPrefix: string, now: string): string[] {
		return this.db.transaction(() => {
			const rows = (
				this.db
					.prepare(
						"SELECT * FROM codex_quota_standby WHERE state='resuming' AND (owner_claim_id IS NULL OR substr(owner_claim_id,1,?)<>?)",
					)
					.all(
						ownerPrefix.length + 1,
						`${ownerPrefix}:`,
					) as CodexQuotaStandbyRow[]
			).map((row) => row.execution_id);
			for (const executionId of rows)
				this.failResume({
					executionId,
					kind: "neutral",
					detailCode: "bridge_restarted",
					continueDetermined: false,
					now,
				});
			return rows;
		})();
	}
	/**
	 * FLY-2900 §4.3: released carriers that still name the claim that was
	 * relaunching them — that claim's process may be alive (its owner never
	 * got to reap it, e.g. the Bridge died right after the release).
	 */
	listReleasedResumeOwners(): CodexQuotaStandbyRow[] {
		return this.db
			.prepare(
				"SELECT * FROM codex_quota_standby WHERE state='released' AND owner_claim_id IS NOT NULL ORDER BY execution_id",
			)
			.all() as CodexQuotaStandbyRow[];
	}
	/** FLY-2900 §4.3: the released claim's process is proven gone. */
	clearReleasedResumeOwner(
		executionId: string,
		claimId: string,
		now: string,
	): boolean {
		return (
			this.db
				.prepare(
					"UPDATE codex_quota_standby SET owner_claim_id=NULL,lease_expires_at=NULL,updated_at=? WHERE execution_id=? AND state='released' AND owner_claim_id=?",
				)
				.run(now, executionId, claimId).changes === 1
		);
	}
	/**
	 * FLY-2900 §4.3: flip live carriers to released (idempotent). Returns the
	 * rows as they were before the flip; each one is finalized immediately.
	 */
	releaseStandby(input: {
		executionId?: string;
		runId?: string;
		reason: string;
		now: string;
	}): CodexQuotaStandbyRow[] {
		if (
			(input.executionId === undefined) === (input.runId === undefined) ||
			!CODEX_QUOTA_MACHINE_CODE.test(input.reason)
		)
			throw new Error("invalid_quota_standby_release");
		const rows = (
			input.executionId !== undefined
				? this.db
						.prepare(
							"SELECT * FROM codex_quota_standby WHERE execution_id=? AND state IN ('standby','resuming','fallback_prepared')",
						)
						.all(input.executionId)
				: this.db
						.prepare(
							"SELECT * FROM codex_quota_standby WHERE run_id=? AND state IN ('standby','resuming','fallback_prepared')",
						)
						.all(input.runId)
		) as CodexQuotaStandbyRow[];
		const flip = this.db.prepare(
			"UPDATE codex_quota_standby SET state='released',resume_phase=NULL,release_reason=?,updated_at=? WHERE execution_id=? AND state IN ('standby','resuming','fallback_prepared')",
		);
		const released: CodexQuotaStandbyRow[] = [];
		for (const row of rows) {
			if (flip.run(input.reason, input.now, row.execution_id).changes !== 1)
				continue;
			released.push(row);
			this.finalizeReleasedRow(row.execution_id, input.now);
		}
		return released;
	}
	/**
	 * FLY-2900 §4.3: settle what a release owes — FLY-2465 runner targets of the
	 * execution become abandoned and one `released` audit row is written per
	 * entry. Also completes releases flipped by the schema triggers.
	 */
	finalizeReleasedStandby(now: string, executionId?: string): number {
		const rows = (
			executionId === undefined
				? this.db
						.prepare(
							"SELECT execution_id FROM codex_quota_standby WHERE state='released'",
						)
						.all()
				: this.db
						.prepare(
							"SELECT execution_id FROM codex_quota_standby WHERE state='released' AND execution_id=?",
						)
						.all(executionId)
		) as { execution_id: string }[];
		let finalized = 0;
		for (const row of rows)
			if (this.finalizeReleasedRow(row.execution_id, now)) finalized += 1;
		return finalized;
	}
	private finalizeReleasedRow(executionId: string, now: string): boolean {
		const row = this.getStandby(executionId);
		if (!row || row.state !== "released") return false;
		this.abandonRunnerTargets(executionId, "standby_released");
		const prefix = `${executionId}:${row.entry_seq}:released:`;
		if (
			this.db
				.prepare(
					"SELECT 1 FROM codex_quota_resume_audit WHERE execution_id=? AND substr(event_uid,1,?)=? LIMIT 1",
				)
				.get(executionId, prefix.length, prefix)
		)
			return false;
		this.appendResumeAudit({
			executionId,
			entrySeq: row.entry_seq,
			action: "released",
			at: now,
			runId: row.run_id,
			nodeId: row.node_id,
			attempt: row.attempt,
			detailCode: row.release_reason,
		});
		return true;
	}
	/**
	 * FLY-2900 §4.2 / C7: does the standby carrier own this FLY-2465 runner
	 * target? Only when every wall the incident recorded for the execution is
	 * covered by the carrier's current entry (signal_seq ≤ trigger). Returns
	 * the disposition the recovery must take: leave it to the carrier, or the
	 * settlement the carrier already implies.
	 */
	standbyTargetDisposition(
		incidentId: string,
		executionId: string,
	): "carrier" | "recovered" | "abandoned" | null {
		const row = this.getStandby(executionId);
		const incident = this.getIncident(incidentId);
		if (!row || !incident) return null;
		const latest = Number(
			(
				this.db
					.prepare(
						"SELECT COALESCE(MAX(COALESCE(signal_seq,0)),0) AS seq FROM codex_quota_signal_event WHERE execution_id=? AND root_key=? AND generation=?",
					)
					.get(executionId, incident.root_key, incident.generation) as {
					seq: number;
				}
			).seq,
		);
		if (latest > row.trigger_signal_seq) return null;
		if (
			row.state === "standby" ||
			row.state === "resuming" ||
			row.state === "fallback_prepared"
		)
			return "carrier";
		if (row.state === "released") return "abandoned";
		return row.fallback_execution_id ? "abandoned" : "recovered";
	}
	/** FLY-2465 runner targets of one execution that no incident has settled. */
	abandonRunnerTargets(executionId: string, lastError: string): number {
		return this.db
			.prepare(
				"UPDATE codex_quota_target SET state='abandoned',last_error=? WHERE old_execution_id=? AND target_kind='runner' AND state NOT IN ('recovered','abandoned')",
			)
			.run(lastError, executionId).changes;
	}
	/**
	 * FLY-2900 §3.1: settle one runner usage-limit wall against the carrier.
	 * Runs inside the caller's terminal-signal transaction.
	 *  - enter: a new standby entry (closed → standby bumps entry_seq and resets
	 *    every per-entry budget);
	 *  - refresh: already parked; only the trigger moves forward;
	 *  - capacity_rejected: the resumed process hit the wall again; back to
	 *    standby without touching mechanical_failures, the old permit is void
	 *    because the trigger moved past it.
	 */
	settleStandbyWall(input: {
		disposition: "enter" | "refresh" | "capacity_rejected";
		executionId: string;
		runId: string;
		nodeId: string;
		attempt: number;
		activationId: string | null;
		issueId: string | null;
		sourceEventId: string;
		signalSeq: number;
		rootKey: string | null;
		generation: number | null;
		bindingId: string | null;
		now: string;
	}): { entrySeq: number } {
		const prior = this.getStandby(input.executionId);
		if (input.disposition === "refresh") {
			if (!prior) throw new Error("quota_standby_missing");
			this.db
				.prepare(
					"UPDATE codex_quota_standby SET trigger_signal_seq=MAX(trigger_signal_seq,?),updated_at=? WHERE execution_id=? AND state IN ('standby','fallback_prepared')",
				)
				.run(input.signalSeq, input.now, input.executionId);
			return { entrySeq: prior.entry_seq };
		}
		if (input.disposition === "capacity_rejected") {
			if (!prior || prior.state !== "resuming")
				throw new Error("quota_standby_not_resuming");
			this.db
				.prepare(
					"UPDATE codex_quota_standby SET state='standby',resume_phase=NULL,trigger_signal_seq=MAX(trigger_signal_seq,?),capacity_rejections=capacity_rejections+1,owner_claim_id=NULL,lease_expires_at=NULL,continue_attempt_id=NULL,continue_turn_id=NULL,root_key=COALESCE(?,root_key),generation=COALESCE(?,generation),binding_id=COALESCE(?,binding_id),last_error_code='capacity_rejected',updated_at=? WHERE execution_id=? AND state='resuming'",
				)
				.run(
					input.signalSeq,
					input.rootKey,
					input.generation,
					input.bindingId,
					input.now,
					input.executionId,
				);
			this.appendResumeAudit({
				executionId: input.executionId,
				entrySeq: prior.entry_seq,
				action: "capacity_rejected",
				at: input.now,
				runId: input.runId,
				issueId: input.issueId,
				nodeId: input.nodeId,
				attempt: input.attempt,
				detailCode: "usage_limited",
			});
			return { entrySeq: prior.entry_seq };
		}
		if (prior && prior.state !== "closed")
			throw new Error("quota_standby_entry_conflict");
		const entrySeq = (prior?.entry_seq ?? 0) + 1;
		this.db
			.prepare(
				`INSERT INTO codex_quota_standby(execution_id,run_id,node_id,attempt,activation_id,entry_seq,trigger_signal_seq,source_event_id,root_key,generation,binding_id,state,entered_at,updated_at)
				 VALUES(?,?,?,?,?,?,?,?,?,?,?,'standby',?,?)
				 ON CONFLICT(execution_id) DO UPDATE SET run_id=excluded.run_id,node_id=excluded.node_id,attempt=excluded.attempt,activation_id=excluded.activation_id,entry_seq=excluded.entry_seq,trigger_signal_seq=excluded.trigger_signal_seq,source_event_id=excluded.source_event_id,root_key=excluded.root_key,generation=excluded.generation,binding_id=excluded.binding_id,state='standby',resume_phase=NULL,continue_attempt_id=NULL,continue_turn_id=NULL,permit_id=NULL,resume_attempt=0,mechanical_failures=0,capacity_rejections=0,reconcile_failures=0,owner_claim_id=NULL,lease_expires_at=NULL,fallback_attempt=0,fallback_execution_id=NULL,fallback_vendor=NULL,fallback_reason=NULL,checkpoint_commit=NULL,release_reason=NULL,last_error_code=NULL,entered_at=excluded.entered_at,updated_at=excluded.updated_at
				 WHERE codex_quota_standby.state='closed'`,
			)
			.run(
				input.executionId,
				input.runId,
				input.nodeId,
				input.attempt,
				input.activationId,
				entrySeq,
				input.signalSeq,
				input.sourceEventId,
				input.rootKey,
				input.generation,
				input.bindingId,
				input.now,
				input.now,
			);
		this.appendResumeAudit({
			executionId: input.executionId,
			entrySeq,
			action: "standby_entered",
			at: input.now,
			runId: input.runId,
			issueId: input.issueId,
			nodeId: input.nodeId,
			attempt: input.attempt,
		});
		return { entrySeq };
	}
	/** FLY-2900: parked without a process (standby / fallback prepared); not resuming. */
	isCodexQuotaParkedWithoutProcess(executionId: string): boolean {
		return !!this.db
			.prepare(
				"SELECT 1 FROM codex_quota_standby WHERE execution_id=? AND state IN ('standby','fallback_prepared')",
			)
			.get(executionId);
	}
	/** FLY-2900: the one predicate every "running but no process" consumer asks. */
	isCodexQuotaStandby(executionId: string): boolean {
		return !!this.db
			.prepare(
				"SELECT 1 FROM codex_quota_standby WHERE execution_id=? AND state IN ('standby','resuming','fallback_prepared')",
			)
			.get(executionId);
	}
	recordSignal(input: {
		executionId: string;
		bindingId?: string;
		nodeId?: string;
		attempt?: number;
		now?: string;
		source?: CodexQuotaSignalSource;
		sourceEventId?: string;
		availability?: CodexQuotaAvailabilitySnapshot;
		suppressNotification?: boolean;
	}): string | null {
		return this.db.transaction(() => {
			const now = input.now ?? new Date().toISOString();
			const b = input.bindingId ? this.getBinding(input.bindingId) : undefined;
			if (input.bindingId && (!b || b.executionId !== input.executionId))
				throw new Error("quota_binding_mismatch");
			const incidentId = b
				? `codex:${b.credentialRootKey}:${b.generation}`
				: null;
			if (
				(input.source === undefined) !== (input.sourceEventId === undefined) ||
				(input.availability !== undefined &&
					(!input.source || !input.sourceEventId))
			)
				throw new Error("invalid_quota_signal_identity");
			if (input.source && input.sourceEventId) {
				const eventKey = quotaSignalEventKey(
					input.source,
					input.executionId,
					input.sourceEventId,
				);
				const payloadDigest = quotaSignalPayloadDigest({
					source: input.source,
					sourceEventId: input.sourceEventId,
					executionId: input.executionId,
					bindingId: input.bindingId,
					nodeId: input.nodeId,
					attempt: input.attempt,
				});
				const prior = this.db
					.prepare(
						"SELECT payload_digest FROM codex_quota_signal_event WHERE event_key=?",
					)
					.get(eventKey) as { payload_digest: string } | undefined;
				if (prior) {
					if (prior.payload_digest !== payloadDigest)
						throw new Error("quota_signal_event_conflict");
					return incidentId;
				}
				this.db
					.prepare(
						"INSERT INTO codex_quota_signal_event(event_key,source,source_event_id,execution_id,binding_id,root_key,generation,observed_at,payload_digest,disposition,reason_codes_json) VALUES(?,?,?,?,?,?,?,?,?,'pending','[]')",
					)
					.run(
						eventKey,
						input.source,
						input.sourceEventId,
						input.executionId,
						b?.bindingId ?? null,
						b?.credentialRootKey ?? null,
						b?.generation ?? null,
						now,
						payloadDigest,
					);
				this.db
					.prepare(
						"UPDATE codex_quota_signal_event SET signal_seq=? WHERE event_key=?",
					)
					.run(this.allocateCausalSeq(), eventKey);
				const stickyManual =
					incidentId !== null && this.isIncidentManual(incidentId);
				const availability = input.availability ?? {
					mode: "automatic" as const,
					reasons: [],
					revision: 0,
					checkedAt: now,
				};
				if (availability.mode === "manual" || stickyManual) {
					const reasons: CodexQuotaManualReason[] =
						availability.mode === "manual"
							? [...availability.reasons]
							: ["manual_handoff"];
					this.finishSignalManual({
						eventKey,
						incidentId,
						source: input.source,
						sourceEventId: input.sourceEventId,
						executionId: input.executionId,
						binding: b,
						reasons,
						now,
						suppressNotification: input.suppressNotification,
					});
					return incidentId;
				}
				this.db
					.prepare(
						"UPDATE codex_quota_signal_event SET disposition='automatic',reason_codes_json='[]',evaluated_at=?,initial_disposition='automatic',initial_reason_codes_json='[]',initial_evaluated_at=? WHERE event_key=?",
					)
					.run(now, now, eventKey);
			}
			if (b?.purpose === "runner") {
				this.db
					.prepare(
						"INSERT OR IGNORE INTO codex_quota_execution_pause VALUES(?,?,?,?)",
					)
					.run(input.executionId, incidentId, "usage_limit", now);
			}
			// Unknown provenance is diagnostic only; it cannot authorize an account or execution fence.
			if (!b || !incidentId) {
				this.enqueueOutbox({
					incidentId: `codex:unbound:${input.executionId}`,
					kind: "lead_diagnostic",
					destination: "lead",
					payload: {
						reason: "identity_uncertain",
						executionId: input.executionId,
					},
				});
				return null;
			}
			this.db
				.prepare(
					"INSERT OR IGNORE INTO codex_quota_incident(incident_id,root_key,generation,state,first_seen_at) VALUES(?,?,?,'prepared',?)",
				)
				.run(incidentId, b.credentialRootKey, b.generation, now);
			this.db
				.prepare(
					"INSERT OR IGNORE INTO codex_quota_target(incident_id,target_kind,target_id,run_id,node_id,attempt,old_execution_id,state) VALUES(?,?,?,?,?,?,?,'waiting')",
				)
				.run(
					incidentId,
					b.purpose,
					b.purpose === "runner" ? (b.runId ?? b.executionId) : b.bindingId,
					b.runId,
					input.nodeId ?? null,
					input.attempt ?? null,
					b.executionId,
				);
			this.db
				.prepare(
					"INSERT OR IGNORE INTO codex_quota_outbox(event_id,incident_id,kind,destination,payload_json) VALUES(?,?,'usage_limit','lead',?)",
				)
				.run(
					`${incidentId}:usage_limit`,
					incidentId,
					JSON.stringify({
						vendor: "codex",
						incidentId,
						rootKey: b.credentialRootKey,
						generation: b.generation,
						profile: b.profile,
						accountKey: b.accountKey,
					}),
				);
			return incidentId;
		})();
	}
	private finishSignalManual(input: {
		eventKey: string;
		incidentId: string | null;
		source: CodexQuotaSignalSource;
		sourceEventId: string;
		executionId: string;
		binding: CodexQuotaBindingV1 | undefined;
		reasons: CodexQuotaManualReason[];
		now: string;
		suppressNotification?: boolean;
	}): void {
		const reasons = input.reasons.length
			? [...new Set(input.reasons)]
			: (["manual_handoff"] satisfies CodexQuotaManualReason[]);
		const reasonsJson = JSON.stringify(reasons);
		this.db
			.prepare(
				"UPDATE codex_quota_signal_event SET disposition='manual',reason_codes_json=?,evaluated_at=?,initial_disposition=COALESCE(initial_disposition,'manual'),initial_reason_codes_json=COALESCE(initial_reason_codes_json,?),initial_evaluated_at=COALESCE(initial_evaluated_at,?) WHERE event_key=?",
			)
			.run(reasonsJson, input.now, reasonsJson, input.now, input.eventKey);
		if (
			input.incidentId &&
			this.canRecordManualDisposition(input.incidentId, Date.parse(input.now))
		) {
			this.db
				.prepare(
					"INSERT OR IGNORE INTO codex_quota_manual_disposition VALUES(?,?,?)",
				)
				.run(input.incidentId, reasons[0], input.now);
			this.db
				.prepare(
					"UPDATE codex_quota_outbox SET delivery_state='superseded',payload_json=json_set(payload_json,'$.supersededBy',?) WHERE incident_id=? AND kind='founder_alert' AND delivery_state='pending' AND json_extract(payload_json,'$.reason')='quota_pause_expired'",
				)
				.run(
					input.suppressNotification
						? `${LEGACY_BATCH_ID}:N11:summary`
						: `${input.eventKey}:N11`,
					input.incidentId,
				);
		}
		if (input.suppressNotification) return;
		this.enqueueOutbox({
			incidentId: input.incidentId,
			kind: "automation_disabled",
			eventId: `${input.eventKey}:N11`,
			destination: "lead",
			payload: {
				scope: "event",
				eventKey: input.eventKey,
				source: input.source,
				sourceEventId: input.sourceEventId,
				executionId: input.executionId,
				reasons,
				evaluatedAt: input.now,
				...(input.binding
					? {
							bindingId: input.binding.bindingId,
							rootKey: input.binding.credentialRootKey,
							generation: input.binding.generation,
						}
					: {}),
			},
		});
	}
	private canRecordManualDisposition(
		incidentId: string,
		now = Date.now(),
	): boolean {
		const incident = this.getIncident(incidentId);
		if (
			incident &&
			["installing", "committed", "recovering"].includes(String(incident.state))
		)
			return false;
		if (
			incident &&
			this.hasUncertainInstallationGuard(
				String(incident.incident_id),
				incident.state,
			)
		)
			return false;
		if (this.hasCurrentCapacityGuard(incidentId, now)) return false;
		return !this.db
			.prepare(
				"SELECT 1 FROM codex_quota_target WHERE incident_id=? AND (terminate_key IS NOT NULL OR start_key IS NOT NULL OR state IN ('terminating','terminated','starting','queued','recovered')) LIMIT 1",
			)
			.get(incidentId);
	}
	recordPoolExhausted(input: {
		incidentId: string;
		pool: readonly CodexQuotaPoolMember[];
		observations: readonly CodexQuotaObservation[];
		observedAt: number;
		nextAttemptAt: number;
	}): void {
		this.db.transaction(() => {
			const incident = this.getIncident(input.incidentId);
			if (!incident) throw new Error("quota_incident_missing");
			if (!validPoolMembers(input.pool))
				throw new Error("quota_capacity_pool_invalid");
			const poolNames = input.pool.map((member) => member.profile);
			const observationJson = canonicalCapacityEvidence(
				input.pool,
				input.observations,
			);
			if (
				selectCodexQuotaCandidate(input.observations, {
					now: input.observedAt,
					pool: poolNames,
				}).kind !== "pool_exhausted"
			)
				throw new Error("quota_capacity_fact_not_exhausted");
			const digest = createHash("sha256").update(observationJson).digest("hex");
			this.db
				.prepare(
					"INSERT OR IGNORE INTO codex_quota_capacity_fact(root_key,generation,evidence_digest,status,observation_json,evidence_ref,observed_at) VALUES(?,? ,?,'exhausted',?,?,?)",
				)
				.run(
					incident.root_key,
					incident.generation,
					digest,
					observationJson,
					digest,
					new Date(input.observedAt).toISOString(),
				);
			this.setIncidentState(
				input.incidentId,
				"pool_exhausted",
				"pool_exhausted",
				new Date(input.nextAttemptAt).toISOString(),
			);
			// FLY-2830: freeze who comes back when, from exactly this evidence, so
			// the founder alert (and any replay of it) never reads a later fact.
			const alertSnapshot = buildPoolExhaustedAlertSnapshot(
				latestPoolObservations(input.observations, poolNames).filter(
					(observation) => observation !== undefined,
				),
				input.observedAt,
			);
			if (alertSnapshot === null)
				console.warn(
					`[codex-quota] pool_exhausted_snapshot_dropped incident=${input.incidentId}`,
				);
			this.enqueueOutbox({
				incidentId: input.incidentId,
				kind: "founder_alert",
				destination: "founder",
				payload: {
					vendor: "codex",
					reason: "pool_exhausted",
					incidentId: input.incidentId,
					nextAttemptAt: input.nextAttemptAt,
					...(alertSnapshot === null
						? {}
						: {
								alertSnapshot,
								alertDetails: this.poolExhaustedAlertDetails(
									input.incidentId,
									incident.target_profile,
								),
							}),
				},
			});
		})();
	}
	/**
	 * FLY-2830 R1: the trigger/run line as of the exhaustion fact, frozen into
	 * the alert payload (same inputs the outbox used to read live).
	 */
	private poolExhaustedAlertDetails(
		incidentId: string,
		targetProfile: unknown,
	): PoolExhaustedAlertDetails {
		let source = "unknown";
		let resetAt: string | null = null;
		try {
			const row = this.listOutbox().find(
				(item) => item.event_id === `${incidentId}:usage_limit`,
			);
			const data = JSON.parse(String(row?.payload_json ?? "{}"));
			if (isCodexIdentityLabel(data.profile)) source = data.profile;
			if (typeof data.resetsAt === "number" && Number.isFinite(data.resetsAt))
				resetAt = new Date(data.resetsAt).toISOString();
		} catch {
			/* unknown source/reset */
		}
		const runs = this.listTargets(incidentId).filter(
			(target) => target.target_kind === "runner",
		);
		return {
			source,
			resetAt,
			target: isCodexSlotName(targetProfile) ? String(targetProfile) : "none",
			affectedRuns: runs.length,
			restartedRuns: runs.filter((target) => target.state === "recovered")
				.length,
		};
	}
	private latestCapacityEvidence(incidentId: string): {
		legacy: boolean;
		observations: readonly CodexQuotaObservation[];
		storedPool: readonly CodexQuotaPoolMember[];
	} | null {
		const incident = this.getIncident(incidentId);
		if (!incident) return null;
		const row = this.db
			.prepare(
				// Deliberately latest-only: an older positive sample must not outvote
				// the newest unresolved sample after its reset window elapsed.
				"SELECT observation_json FROM codex_quota_capacity_fact WHERE root_key=? AND generation=? AND resolved_at IS NULL ORDER BY observed_at DESC,evidence_digest DESC LIMIT 1",
			)
			.get(incident.root_key, incident.generation) as
			| { observation_json: string }
			| undefined;
		if (!row) return null;
		try {
			const parsed: unknown = JSON.parse(row.observation_json);
			const legacy = Array.isArray(parsed);
			const observations = legacy
				? (parsed as CodexQuotaObservation[])
				: typeof parsed === "object" &&
						parsed !== null &&
						(parsed as { v?: unknown }).v === 2 &&
						Array.isArray((parsed as { observations?: unknown }).observations)
					? (parsed as { observations: CodexQuotaObservation[] }).observations
					: null;
			const storedPool = legacy
				? observations?.map(({ profile, accountKey }) => ({
						profile,
						accountKey,
					}))
				: (parsed as { pool?: unknown }).pool;
			if (!observations || !validPoolMembers(storedPool)) return null;
			return { legacy, observations, storedPool };
		} catch {
			return null;
		}
	}
	hasNewPoolMember(incidentId: string): boolean {
		const evidence = this.latestCapacityEvidence(incidentId);
		if (!evidence || !this.currentCodexPoolMembers) return false;
		try {
			const current = this.currentCodexPoolMembers();
			if (!validPoolMembers(current)) return false;
			const storedKeys = new Set(
				evidence.storedPool.map(
					(member) => `${member.profile}\0${member.accountKey}`,
				),
			);
			return current.some(
				(member) => !storedKeys.has(`${member.profile}\0${member.accountKey}`),
			);
		} catch {
			return false;
		}
	}
	hasCurrentCapacityGuard(incidentId: string, now = Date.now()): boolean {
		if (!Number.isFinite(now)) return false;
		const evidence = this.latestCapacityEvidence(incidentId);
		if (!evidence) return false;
		const { legacy, observations, storedPool } = evidence;
		try {
			let current: readonly CodexQuotaPoolMember[];
			try {
				current = this.currentCodexPoolMembers?.() ?? storedPool;
				if (!validPoolMembers(current)) return true;
			} catch {
				return true;
			}
			const storedKeys = new Set(
				storedPool.map((member) => `${member.profile}\0${member.accountKey}`),
			);
			if (
				current.some(
					(member) =>
						!storedKeys.has(`${member.profile}\0${member.accountKey}`),
				)
			)
				return false;
			const currentKeys = new Set(
				current.map((member) => `${member.profile}\0${member.accountKey}`),
			);
			const replayPool = storedPool.filter((member) =>
				currentKeys.has(`${member.profile}\0${member.accountKey}`),
			);
			if (replayPool.length === 0) return true;
			const replayKeys = new Set(
				replayPool.map((member) => `${member.profile}\0${member.accountKey}`),
			);
			const replay = observations.filter((observation) =>
				replayKeys.has(`${observation.profile}\0${observation.accountKey}`),
			);
			return (
				selectCodexQuotaCandidate(replay, {
					now,
					pool: legacy
						? LEGACY_CODEX_QUOTA_POOL.filter((profile) =>
								replayPool.some((member) => member.profile === profile),
							)
						: replayPool.map((member) => member.profile),
				}).kind === "pool_exhausted"
			);
		} catch {
			return false;
		}
	}
	getCurrentPoolExhaustionFact(
		rootKey: string,
		now = Date.now(),
	): CodexPoolExhaustionFact | undefined {
		const root = this.getRoot(rootKey);
		if (!root || !Number.isFinite(now)) return undefined;
		const incident = this.db
			.prepare(
				"SELECT incident_id FROM codex_quota_incident WHERE root_key=? AND generation=? LIMIT 1",
			)
			.get(rootKey, root.generation) as { incident_id: string } | undefined;
		if (
			!incident ||
			!this.currentCodexPoolMembers ||
			!this.hasCurrentCapacityGuard(incident.incident_id, now)
		)
			return undefined;
		const evidence = this.latestCapacityEvidence(incident.incident_id);
		if (!evidence) return undefined;
		let currentPool: readonly CodexQuotaPoolMember[];
		try {
			currentPool = this.currentCodexPoolMembers();
		} catch {
			return undefined;
		}
		if (!validPoolMembers(currentPool)) return undefined;
		const currentKeys = new Set(
			currentPool.map((member) => `${member.profile}\0${member.accountKey}`),
		);
		const observation = evidence.observations.filter((member) =>
			currentKeys.has(`${member.profile}\0${member.accountKey}`),
		);
		const row = this.db
			.prepare(
				"SELECT generation,evidence_digest,evidence_ref,observed_at FROM codex_quota_capacity_fact WHERE root_key=? AND generation=? AND resolved_at IS NULL ORDER BY observed_at DESC,evidence_digest DESC LIMIT 1",
			)
			.get(rootKey, root.generation) as
			| {
					generation: number;
					evidence_digest: string;
					evidence_ref: string;
					observed_at: string;
			  }
			| undefined;
		if (!row) return undefined;
		return {
			rootKey,
			generation: row.generation,
			evidenceDigest: row.evidence_digest,
			evidenceRef: row.evidence_ref,
			observedAt: row.observed_at,
			observation,
		};
	}
	resolveCapacityFacts(input: {
		incidentId: string;
		observations: readonly CodexQuotaObservation[];
		observedAt: number;
	}): void {
		const incident = this.getIncident(input.incidentId);
		if (!incident) throw new Error("quota_incident_missing");
		const observationJson = canonicalCapacityObservation(input.observations);
		const digest = createHash("sha256").update(observationJson).digest("hex");
		this.db
			.prepare(
				"UPDATE codex_quota_capacity_fact SET resolved_at=?,resolution_evidence_ref=?,resolution_observation_json=? WHERE root_key=? AND generation=? AND resolved_at IS NULL",
			)
			.run(
				new Date(input.observedAt).toISOString(),
				digest,
				observationJson,
				incident.root_key,
				incident.generation,
			);
	}
	isIncidentManual(incidentId: string): boolean {
		return !!this.db
			.prepare(
				"SELECT 1 FROM codex_quota_manual_disposition WHERE incident_id=?",
			)
			.get(incidentId);
	}
	isRootGenerationManual(rootKey: string, generation: number): boolean {
		if (!Number.isInteger(generation) || generation < 0) return false;
		return this.isIncidentManual(`codex:${rootKey}:${generation}`);
	}
	isBindingManual(bindingId: string): boolean {
		const binding = this.getBinding(bindingId);
		if (!binding) return false;
		return !!this.db
			.prepare(
				"SELECT 1 FROM codex_quota_signal_event WHERE binding_id=? AND disposition='manual' LIMIT 1",
			)
			.get(bindingId);
	}
	handoffIncidentManual(
		incidentId: string,
		reasons: CodexQuotaManualReason[],
		now = new Date().toISOString(),
	): void {
		this.db.transaction(() => {
			const incident = this.getIncident(incidentId);
			if (!incident) throw new Error("quota_incident_missing");
			for (const row of this.db
				.prepare(
					"SELECT * FROM codex_quota_signal_event WHERE root_key=? AND generation=?",
				)
				.all(incident.root_key, incident.generation) as Record<
				string,
				unknown
			>[]) {
				const binding = row.binding_id
					? this.getBinding(String(row.binding_id))
					: undefined;
				this.finishSignalManual({
					eventKey: String(row.event_key),
					incidentId,
					source: String(row.source) as CodexQuotaSignalSource,
					sourceEventId: String(row.source_event_id),
					executionId: String(row.execution_id),
					binding,
					reasons,
					now,
				});
			}
			this.db
				.prepare(
					"UPDATE codex_quota_outbox SET delivery_state='superseded',payload_json=json_set(payload_json,'$.supersededBy',?) WHERE incident_id=? AND kind='founder_alert' AND delivery_state='pending' AND json_extract(payload_json,'$.reason')='quota_pause_expired'",
				)
				.run(`${incidentId}:N11`, incidentId);
		})();
	}
	isPaused(rootKey: string): boolean {
		return !!this.db
			.prepare(
				"SELECT 1 FROM codex_quota_incident i WHERE root_key=? AND generation >= COALESCE((SELECT generation FROM codex_quota_root WHERE root_key=i.root_key),generation) AND state NOT IN ('committed','recovering','settled') AND NOT EXISTS (SELECT 1 FROM codex_quota_manual_disposition m WHERE m.incident_id=i.incident_id) LIMIT 1",
			)
			.get(rootKey);
	}
	isExecutionPaused(executionId: string): boolean {
		if (
			this.db
				.prepare(
					"SELECT 1 FROM codex_quota_target WHERE old_execution_id=? AND target_kind='runner' AND state NOT IN ('recovered','abandoned') LIMIT 1",
				)
				.get(executionId)
		)
			return true;
		if (
			this.db
				.prepare(
					"SELECT 1 FROM codex_quota_signal_event s JOIN codex_quota_root r ON r.root_key=s.root_key WHERE s.execution_id=? AND s.source='runner_terminal' AND s.binding_id IS NOT NULL AND s.disposition IN ('pending','manual') AND s.generation>=r.generation LIMIT 1",
				)
				.get(executionId)
		)
			return true;
		return !!this.db
			.prepare(
				"SELECT 1 FROM codex_quota_execution_pause p JOIN codex_quota_incident i ON i.incident_id=p.incident_id WHERE p.execution_id=? AND i.generation >= COALESCE((SELECT generation FROM codex_quota_root WHERE root_key=i.root_key),i.generation) AND i.state NOT IN ('committed','recovering','settled')",
			)
			.get(executionId);
	}
	hasRootSafetyGuard(
		rootKey: string,
		now = Date.now(),
		includeCapacity = true,
	): boolean {
		const root = this.getRoot(rootKey);
		if (!root) return false;
		return this.hasRootGenerationSafetyGuard(
			rootKey,
			root.generation,
			now,
			includeCapacity,
		);
	}
	hasRootGenerationSafetyGuard(
		rootKey: string,
		generation: number,
		now = Date.now(),
		includeCapacity = true,
	): boolean {
		if (!Number.isInteger(generation) || generation < 0) return false;
		const incidents = this.db
			.prepare(
				"SELECT incident_id,state FROM codex_quota_incident WHERE root_key=? AND generation=? AND state NOT IN ('committed','recovering','settled')",
			)
			.all(rootKey, generation) as {
			incident_id: string;
			state: string;
		}[];
		for (const incident of incidents) {
			if (
				this.hasUncertainInstallationGuard(
					incident.incident_id,
					incident.state,
				) ||
				(includeCapacity &&
					this.hasCurrentCapacityGuard(incident.incident_id, now)) ||
				this.db
					.prepare(
						"SELECT 1 FROM codex_quota_target WHERE incident_id=? AND (terminate_key IS NOT NULL OR start_key IS NOT NULL OR state IN ('terminating','terminated','starting','queued')) LIMIT 1",
					)
					.get(incident.incident_id)
			)
				return true;
		}
		return false;
	}
	private hasUncertainInstallationGuard(
		incidentId: string,
		state: unknown,
	): boolean {
		if (state === "installing") return true;
		return this.getInstallationMaterial(incidentId)?.resolution === "pending";
	}
	enqueueAdmissionWait(input: {
		startKey: string;
		rootKey: string;
		generation: number;
		dispatchJson: string;
		requestContext: string;
		now?: string;
	}): Record<string, unknown> {
		return this.db.transaction(() => {
			const reservation = this.db
				.prepare(
					"SELECT * FROM workflow_start_reservation WHERE idempotency_key=?",
				)
				.get(input.startKey) as Record<string, unknown> | undefined;
			if (!reservation) throw new Error("quota_start_reservation_missing");
			const prior = this.getAdmissionWait(input.startKey);
			if (prior) return prior;
			this.db
				.prepare(
					"INSERT INTO codex_quota_admission_wait VALUES(?,?,?,?,?,?,?,?,?,?)",
				)
				.run(
					input.startKey,
					reservation.run_id,
					reservation.execution_id,
					reservation.node_id,
					input.rootKey,
					input.generation,
					input.dispatchJson,
					input.requestContext,
					"waiting",
					input.now ?? new Date().toISOString(),
				);
			return this.getAdmissionWait(input.startKey)!;
		})();
	}
	getAdmissionWait(startKey: string): Record<string, unknown> | undefined {
		return this.db
			.prepare("SELECT * FROM codex_quota_admission_wait WHERE start_key=?")
			.get(startKey) as Record<string, unknown> | undefined;
	}
	listAdmissionWaits(): Record<string, unknown>[] {
		return this.db
			.prepare(
				"SELECT * FROM codex_quota_admission_wait WHERE state IN ('waiting','resuming') ORDER BY created_at",
			)
			.all() as Record<string, unknown>[];
	}
	setAdmissionWaitState(
		startKey: string,
		state: "resuming" | "released" | "abandoned",
	): void {
		this.db
			.prepare(
				"UPDATE codex_quota_admission_wait SET state=? WHERE start_key=? AND state IN ('waiting','resuming')",
			)
			.run(state, startKey);
	}
	listIncidents(): Record<string, unknown>[] {
		return this.db
			.prepare("SELECT * FROM codex_quota_incident ORDER BY first_seen_at")
			.all() as Record<string, unknown>[];
	}
	listTargets(incidentId: string): Record<string, unknown>[] {
		return this.db
			.prepare("SELECT * FROM codex_quota_target WHERE incident_id=?")
			.all(incidentId) as Record<string, unknown>[];
	}
	listOutbox(): Record<string, unknown>[] {
		return this.db
			.prepare("SELECT * FROM codex_quota_outbox ORDER BY event_id")
			.all() as Record<string, unknown>[];
	}
	getRunnerBindings(executionId: string): CodexQuotaBindingV1[] {
		return (
			this.db
				.prepare(
					"SELECT binding_id FROM codex_quota_binding WHERE execution_id=? AND purpose='runner'",
				)
				.all(executionId) as { binding_id: string }[]
		)
			.map((row) => this.getBinding(row.binding_id)!)
			.filter(Boolean);
	}
}
