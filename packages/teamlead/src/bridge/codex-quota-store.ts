import { isAbsolute } from "node:path";
import type { Database } from "better-sqlite3";
import {
	type CodexQuotaBindingV1,
	parseCodexQuotaBindingV1,
} from "flywheel-core";

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
/** The StateStore connection owns every quota transaction; never a second DB. */
export class CodexQuotaStore {
	constructor(private readonly db: Database) {}
	migrate(): void {
		this.db.exec(`
   CREATE TABLE IF NOT EXISTS codex_quota_legacy_start(start_key TEXT PRIMARY KEY,project_name TEXT NOT NULL,issue_id TEXT NOT NULL,execution_id TEXT NOT NULL UNIQUE,request_digest TEXT NOT NULL,request_context TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TRIGGER IF NOT EXISTS codex_quota_legacy_start_no_update BEFORE UPDATE ON codex_quota_legacy_start BEGIN SELECT RAISE(ABORT, 'quota legacy reservation is append-only'); END;
   CREATE TRIGGER IF NOT EXISTS codex_quota_legacy_start_no_delete BEFORE DELETE ON codex_quota_legacy_start BEGIN SELECT RAISE(ABORT, 'quota legacy reservation is append-only'); END;
   CREATE TABLE IF NOT EXISTS codex_quota_root(root_key TEXT PRIMARY KEY,account_key TEXT NOT NULL,profile TEXT NOT NULL,generation INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS codex_quota_install_material(incident_id TEXT PRIMARY KEY,profile TEXT NOT NULL,account_key TEXT NOT NULL,prior_auth_digest TEXT NOT NULL,installed_auth_digest TEXT NOT NULL,recovery_material_path TEXT NOT NULL,recorded_at TEXT NOT NULL);
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
					"INSERT INTO codex_quota_install_material VALUES(?,?,?,?,?,?,?) ON CONFLICT(incident_id) DO UPDATE SET profile=excluded.profile,account_key=excluded.account_key,prior_auth_digest=excluded.prior_auth_digest,installed_auth_digest=excluded.installed_auth_digest,recovery_material_path=excluded.recovery_material_path,recorded_at=excluded.recorded_at",
				)
				.run(
					input.incidentId,
					input.profile,
					input.accountKey,
					input.priorAuthDigest,
					input.installedAuthDigest,
					input.recoveryMaterialPath,
					now,
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
					input.now ?? new Date().toISOString(),
					input.authDigest,
					root.generation + 1,
					input.incidentId,
				);
			this.enqueueOutbox({
				incidentId: input.incidentId,
				kind: "switch_notification",
				destination: "founder",
				payload: { reason: "switch_succeeded" },
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
		this.db
			.prepare(
				"UPDATE codex_quota_incident SET state=?,failure_code=?,next_attempt_at=? WHERE incident_id=?",
			)
			.run(state, failureCode ?? null, nextAttemptAt ?? null, incidentId);
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
	enqueueOutbox(input: {
		incidentId: string;
		kind:
			| "founder_alert"
			| "lead_summary"
			| "lead_diagnostic"
			| "switch_notification";
		eventId?: string;
		destination: string;
		payload: Record<string, unknown>;
	}): void {
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
	/** Only an exact failed current activation plus its retry hold is eligible. */
	backfillHistoricalQuotaFailures(limit = 1000): number {
		return this.db.transaction(() => {
			const rows = this.db
				.prepare(`
                SELECT r.run_id,n.node_id,n.attempt,n.execution_id FROM workflow_run r
                JOIN workflow_run_node n ON n.run_id=r.run_id AND n.node_id=r.current_node_id
                JOIN sessions s ON s.execution_id=n.execution_id
                WHERE r.status='held' AND s.status IN ('failed','terminated','stopped')
                AND s.last_error='goal ended non-complete: usageLimited'
                AND n.attempt=(SELECT MAX(latest.attempt) FROM workflow_run_node latest WHERE latest.run_id=n.run_id AND latest.node_id=n.node_id)
                AND NOT EXISTS (SELECT 1 FROM codex_quota_target t WHERE t.old_execution_id=n.execution_id)
                AND NOT EXISTS (SELECT 1 FROM codex_quota_outbox o WHERE o.event_id='codex:unbound:' || n.execution_id || ':lead_diagnostic')
                AND EXISTS (SELECT 1 FROM workflow_run_event e WHERE e.run_id=r.run_id AND e.execution_id=n.execution_id AND e.node_id=n.node_id AND e.kind='retry_limit_escalated'
                  AND NOT EXISTS (SELECT 1 FROM workflow_run_event later WHERE later.run_id=r.run_id AND later.seq>e.seq AND later.kind IN ('run_held_by_operator','run_terminated','run_terminated_by_operator','run_terminated_by_supersession','run_completed','run_cancelled','run_shipped','land_held','unlaunched_admission_rolled_back','unlaunched_admission_held','rework_activation_stalled_held','rework_pane_loss_handoff','rework_retry_exhausted','completion_receipt_missing','retry_limit_escalated','environment_failure_escalated','loop_limit_escalated','rework_suppressed_idle_spin','workflow_gate_origin_preflight_terminal')))
                ORDER BY r.run_id LIMIT ?
            `)
				.all(Math.min(1000, Math.max(1, Math.floor(limit)))) as {
				run_id: string;
				node_id: string;
				attempt: number;
				execution_id: string;
			}[];
			for (const row of rows) {
				const bindings = this.getRunnerBindings(row.execution_id).filter(
					(b) => b.runId === row.run_id,
				);
				this.recordSignal({
					executionId: row.execution_id,
					bindingId: bindings.length === 1 ? bindings[0]!.bindingId : undefined,
					nodeId: row.node_id,
					attempt: row.attempt,
				});
			}
			return rows.length;
		})();
	}

	recordSignal(input: {
		executionId: string;
		bindingId?: string;
		nodeId?: string;
		attempt?: number;
		now?: string;
	}): string | null {
		return this.db.transaction(() => {
			const now = input.now ?? new Date().toISOString();
			const b = input.bindingId ? this.getBinding(input.bindingId) : undefined;
			if (input.bindingId && (!b || b.executionId !== input.executionId))
				throw new Error("quota_binding_mismatch");
			const incidentId = b
				? `codex:${b.credentialRootKey}:${b.generation}`
				: null;
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
	isPaused(rootKey: string): boolean {
		return !!this.db
			.prepare(
				"SELECT 1 FROM codex_quota_incident WHERE root_key=? AND generation >= COALESCE((SELECT generation FROM codex_quota_root WHERE root_key=codex_quota_incident.root_key),generation) AND state NOT IN ('committed','recovering','settled') LIMIT 1",
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
		const roots = this.db
			.prepare(
				"SELECT root_key FROM codex_quota_binding WHERE execution_id=? AND purpose='runner'",
			)
			.all(executionId) as { root_key: string }[];
		if (roots.some((r) => this.isPaused(r.root_key))) return true;
		return !!this.db
			.prepare(
				"SELECT 1 FROM codex_quota_execution_pause p JOIN codex_quota_incident i ON i.incident_id=p.incident_id WHERE p.execution_id=? AND i.generation >= COALESCE((SELECT generation FROM codex_quota_root WHERE root_key=i.root_key),i.generation) AND i.state NOT IN ('committed','recovering','settled')",
			)
			.get(executionId);
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
