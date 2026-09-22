import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { Database } from "better-sqlite3";
import {
	type CodexQuotaBindingV1,
	parseCodexQuotaBindingV1,
} from "flywheel-core";
import type {
	CodexQuotaAvailabilitySnapshot,
	CodexQuotaManualReason,
} from "../codex-quota/availability.js";
import {
	type CodexQuotaObservation,
	selectCodexQuotaCandidate,
} from "../codex-quota/candidate-selector.js";
import type { CodexSwitchNotificationSnapshot } from "../codex-quota/switch-notification.js";

export type CodexQuotaRoot = {
	rootKey: string;
	accountKey: string;
	profile: string;
	generation: number;
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
/** The StateStore connection owns every quota transaction; never a second DB. */
export class CodexQuotaStore {
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
   CREATE TABLE IF NOT EXISTS codex_quota_signal_event(event_key TEXT PRIMARY KEY,source TEXT NOT NULL,source_event_id TEXT NOT NULL,execution_id TEXT NOT NULL,binding_id TEXT,root_key TEXT,generation INTEGER,observed_at TEXT NOT NULL,payload_digest TEXT NOT NULL,disposition TEXT NOT NULL,reason_codes_json TEXT NOT NULL,evaluated_at TEXT,initial_disposition TEXT,initial_reason_codes_json TEXT,initial_evaluated_at TEXT);
   CREATE INDEX IF NOT EXISTS codex_quota_signal_source ON codex_quota_signal_event(source,source_event_id,execution_id);
   CREATE INDEX IF NOT EXISTS codex_quota_signal_root_generation ON codex_quota_signal_event(root_key,generation,disposition);
   CREATE TABLE IF NOT EXISTS codex_quota_capacity_fact(root_key TEXT NOT NULL,generation INTEGER NOT NULL,evidence_digest TEXT NOT NULL,status TEXT NOT NULL,observation_json TEXT NOT NULL,evidence_ref TEXT NOT NULL,observed_at TEXT NOT NULL,resolved_at TEXT,resolution_evidence_ref TEXT,resolution_observation_json TEXT,PRIMARY KEY(root_key,generation,evidence_digest));
   CREATE TABLE IF NOT EXISTS codex_quota_legacy_batch(batch_id TEXT PRIMARY KEY,migration_key TEXT NOT NULL UNIQUE,state TEXT NOT NULL,total_count INTEGER NOT NULL DEFAULT 0,manual_count INTEGER NOT NULL DEFAULT 0,guarded_count INTEGER NOT NULL DEFAULT 0,skipped_count INTEGER NOT NULL DEFAULT 0,failed_count INTEGER NOT NULL DEFAULT 0,sealed_at TEXT);
   CREATE TABLE IF NOT EXISTS codex_quota_legacy_member(batch_id TEXT NOT NULL,source TEXT NOT NULL,source_ref TEXT NOT NULL,run_id TEXT,node_id TEXT,attempt INTEGER,execution_id TEXT,incident_id TEXT,result TEXT NOT NULL DEFAULT 'pending',reason TEXT,event_key TEXT,attempt_count INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(batch_id,source,source_ref));
   CREATE INDEX IF NOT EXISTS codex_quota_legacy_member_result ON codex_quota_legacy_member(batch_id,result,source,source_ref);
   CREATE INDEX IF NOT EXISTS codex_quota_legacy_workflow_held ON workflow_run(status,current_node_id,run_id);
  `);
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
	}): void {
		if (
			!["school", "personal", "business"].includes(input.profile) ||
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
					"INSERT INTO codex_quota_external_generation VALUES(?,?,?,?,?,?)",
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
		})();
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
			!["school", "personal", "business"].includes(input.profile) ||
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
			this.getIncident(incidentId)?.probe_result !== "ok"
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
			![input.from, input.to].every((p) =>
				["school", "personal", "business"].includes(p),
			) ||
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
		observations: readonly CodexQuotaObservation[];
		observedAt: number;
		nextAttemptAt: number;
	}): void {
		this.db.transaction(() => {
			const incident = this.getIncident(input.incidentId);
			if (!incident) throw new Error("quota_incident_missing");
			const observationJson = canonicalCapacityObservation(input.observations);
			if (
				selectCodexQuotaCandidate(JSON.parse(observationJson), {
					now: input.observedAt,
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
			this.enqueueOutbox({
				incidentId: input.incidentId,
				kind: "founder_alert",
				destination: "founder",
				payload: {
					vendor: "codex",
					reason: "pool_exhausted",
					incidentId: input.incidentId,
					nextAttemptAt: input.nextAttemptAt,
				},
			});
		})();
	}
	hasCurrentCapacityGuard(incidentId: string, now = Date.now()): boolean {
		const incident = this.getIncident(incidentId);
		if (!incident || !Number.isFinite(now)) return false;
		const row = this.db
			.prepare(
				// Deliberately latest-only: an older positive sample must not outvote
				// the newest unresolved sample after its reset window elapsed.
				"SELECT observation_json FROM codex_quota_capacity_fact WHERE root_key=? AND generation=? AND resolved_at IS NULL ORDER BY observed_at DESC,evidence_digest DESC LIMIT 1",
			)
			.get(incident.root_key, incident.generation) as
			| { observation_json: string }
			| undefined;
		if (!row) return false;
		try {
			return (
				selectCodexQuotaCandidate(JSON.parse(row.observation_json), { now })
					.kind === "pool_exhausted"
			);
		} catch {
			return false;
		}
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
