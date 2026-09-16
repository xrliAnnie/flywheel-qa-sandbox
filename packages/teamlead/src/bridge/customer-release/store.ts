import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
	deriveBetaCandidate,
	deriveVetoBinding,
	type Manifest,
} from "flywheel-release-contract";
import { CustomerReleaseAccounting } from "./accounting.js";
import { CustomerReleaseActivationStore } from "./activation-store.js";
import { attemptBytes, claimRejection, equalBinding } from "./decisions.js";
import type {
	ReleaseWorkflowBinding,
	ReleaseWorkflowRequest,
} from "./github.js";
import { CustomerManualReleaseStore } from "./manual.js";
import {
	customerNoticeFields,
	isDiscordId,
	validNoticeIntent,
} from "./notice.js";
import {
	type PersistedCustomerReadiness,
	preparationRejection,
} from "./policy.js";
import { customerReleaseReport } from "./report.js";
import { validateAttemptResult } from "./results.js";
import type {
	CustomerActionReceipt,
	CustomerAttemptResult,
	CustomerClaimActivation,
	CustomerDeliveryReceipt,
	CustomerNotice,
	CustomerNoticeIntent,
	CustomerPrepareReceipt,
	CustomerReadyAttempt,
	CustomerReleaseCycle,
	CustomerReleaseEvent,
	CustomerReleasePermit,
	CustomerReleaseReservation,
	CustomerReleaseState,
	CustomerVetoAction,
} from "./types.js";

const cycleSelect = `cycle_id AS cycleId, project_id AS projectId, slot_date AS slotDate,
 week_start AS weekStart, release_id AS releaseId, frozen_beta_json AS frozenBetaJson,
 binding_json AS bindingJson, policy_revision AS policyRevision, activation_epoch AS activationEpoch,
 state, revision, window_opened_at AS windowOpenedAt, deadline_at AS deadlineAt, claim_not_after AS claimNotAfter,
 cancel_reason AS cancelReason, invalidated_event_seq AS invalidatedEventSeq, latest_verdict_id AS latestVerdictId, created_at AS createdAt`;

function identifier(value: string): boolean {
	return (
		typeof value === "string" &&
		/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value)
	);
}
function clock(value: number): void {
	if (!Number.isSafeInteger(value) || value < 0)
		throw new Error("customer release clock invalid");
}
function weekStart(slotDate: string): string {
	if (typeof slotDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(slotDate))
		throw new Error("customer release date invalid");
	const date = new Date(`${slotDate}T00:00:00.000Z`);
	if (
		!Number.isFinite(date.getTime()) ||
		date.toISOString().slice(0, 10) !== slotDate
	)
		throw new Error("customer release date invalid");
	date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
	return date.toISOString().slice(0, 10);
}

/** All mutations share StateStore's SQLite connection; no transport work in transactions. */
export class CustomerReleaseStore {
	readonly manual: CustomerManualReleaseStore;
	readonly activation: CustomerReleaseActivationStore;
	readonly accounting: CustomerReleaseAccounting;
	report(now: number) {
		return customerReleaseReport(this.db, now);
	}
	constructor(private readonly db: Database.Database) {
		this.manual = new CustomerManualReleaseStore(db, this);
		this.activation = new CustomerReleaseActivationStore(db, this);
		this.accounting = new CustomerReleaseAccounting(db);
	}
	migrate(): void {
		this.db
			.transaction(() =>
				this.db.exec(`
			CREATE TABLE IF NOT EXISTS customer_release_cycles (
				cycle_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, slot_date TEXT NOT NULL,
				week_start TEXT NOT NULL, release_id TEXT NOT NULL UNIQUE,
				frozen_beta_json TEXT NOT NULL, binding_json TEXT,
				policy_revision TEXT NOT NULL, activation_epoch INTEGER NOT NULL,
				state TEXT NOT NULL CHECK(state IN ('evaluating','preparing','notice_pending','window_open','awaiting_attempt','committing','commit_unknown','cancelled','manual_ready','published')),
				revision INTEGER NOT NULL DEFAULT 0, window_opened_at INTEGER, deadline_at INTEGER,
				cancel_reason TEXT, invalidated_event_seq INTEGER, created_at INTEGER NOT NULL,
				UNIQUE(project_id, slot_date), UNIQUE(project_id, week_start)
			);
			CREATE UNIQUE INDEX IF NOT EXISTS customer_release_one_unresolved
				ON customer_release_cycles(project_id) WHERE state IN ('committing','commit_unknown');
			CREATE TABLE IF NOT EXISTS customer_release_events (
				seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
				cycle_id TEXT NOT NULL REFERENCES customer_release_cycles(cycle_id),
				kind TEXT NOT NULL, who TEXT NOT NULL, happened_at INTEGER NOT NULL, reason TEXT
			);
			CREATE TRIGGER IF NOT EXISTS customer_release_frozen_identity
			BEFORE UPDATE ON customer_release_cycles
			WHEN NEW.cycle_id != OLD.cycle_id OR NEW.project_id != OLD.project_id OR NEW.slot_date != OLD.slot_date
			 OR NEW.week_start != OLD.week_start OR NEW.release_id != OLD.release_id OR NEW.frozen_beta_json != OLD.frozen_beta_json
			 OR NEW.policy_revision != OLD.policy_revision OR NEW.activation_epoch != OLD.activation_epoch
			 OR (OLD.binding_json IS NOT NULL AND NEW.binding_json IS NOT OLD.binding_json)
			 OR (OLD.window_opened_at IS NOT NULL AND NEW.window_opened_at IS NOT OLD.window_opened_at)
			 OR (OLD.invalidated_event_seq IS NOT NULL AND NEW.invalidated_event_seq IS NOT OLD.invalidated_event_seq)
			BEGIN SELECT RAISE(ABORT, 'customer release immutable identity'); END;
			CREATE TRIGGER IF NOT EXISTS customer_release_event_immutable
			BEFORE UPDATE ON customer_release_events
			BEGIN SELECT RAISE(ABORT, 'customer release immutable event'); END;
			CREATE TABLE IF NOT EXISTS customer_release_notices (
				cycle_id TEXT PRIMARY KEY REFERENCES customer_release_cycles(cycle_id), notice_id TEXT NOT NULL UNIQUE,
				intent_json TEXT NOT NULL, binding_digest TEXT NOT NULL, prepare_receipt_json TEXT NOT NULL,
				send_state TEXT NOT NULL CHECK(send_state IN ('intent','sending','uncertain','delivered','rejected')),
				message_id TEXT, delivered_at INTEGER, access_probe_at INTEGER
			);
			CREATE TRIGGER IF NOT EXISTS customer_release_notice_immutable
			BEFORE UPDATE ON customer_release_notices
			WHEN NEW.cycle_id != OLD.cycle_id OR NEW.notice_id != OLD.notice_id OR NEW.intent_json != OLD.intent_json
			 OR NEW.binding_digest != OLD.binding_digest OR NEW.prepare_receipt_json != OLD.prepare_receipt_json
			 OR (OLD.message_id IS NOT NULL AND NEW.message_id IS NOT OLD.message_id)
			 OR (OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS NOT OLD.delivered_at)
			BEGIN SELECT RAISE(ABORT, 'customer release immutable notice'); END;
			CREATE TRIGGER IF NOT EXISTS customer_release_deadline_immutable
			BEFORE UPDATE ON customer_release_cycles
			WHEN OLD.deadline_at IS NOT NULL AND NEW.deadline_at IS NOT OLD.deadline_at
			BEGIN SELECT RAISE(ABORT, 'customer release immutable deadline'); END;
			CREATE TABLE IF NOT EXISTS customer_release_attempt_results (
				attempt_id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL REFERENCES customer_release_cycles(cycle_id),
				kind TEXT NOT NULL CHECK(kind IN ('unknown','no_write','published','fenced')),
				result_json TEXT NOT NULL, cycle_state TEXT NOT NULL, observed_at INTEGER NOT NULL
			);
			CREATE TRIGGER IF NOT EXISTS customer_release_result_immutable
			BEFORE UPDATE ON customer_release_attempt_results
			WHEN OLD.kind != 'unknown' OR NEW.attempt_id != OLD.attempt_id OR NEW.cycle_id != OLD.cycle_id
			BEGIN SELECT RAISE(ABORT, 'customer release immutable result'); END;
			CREATE TABLE IF NOT EXISTS customer_release_decisions (
				decision_id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL REFERENCES customer_release_cycles(cycle_id),
				attempt_id TEXT NOT NULL UNIQUE, attempt_json TEXT NOT NULL, permit_json TEXT NOT NULL,
				claimed_at INTEGER NOT NULL
			);
			CREATE TRIGGER IF NOT EXISTS customer_release_decision_immutable
			BEFORE UPDATE ON customer_release_decisions
			BEGIN SELECT RAISE(ABORT, 'customer release immutable decision'); END;
			CREATE TABLE IF NOT EXISTS customer_release_actions (
				interaction_id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL REFERENCES customer_release_cycles(cycle_id),
				action TEXT NOT NULL, actor_id TEXT NOT NULL, binding_digest TEXT NOT NULL,
				action_json TEXT NOT NULL, receipt_json TEXT NOT NULL, received_at INTEGER NOT NULL
			);
			CREATE TRIGGER IF NOT EXISTS customer_release_action_immutable
			BEFORE UPDATE ON customer_release_actions
			BEGIN SELECT RAISE(ABORT, 'customer release immutable action'); END;
		`),
			)
			.immediate();
		const columns = this.db
			.prepare("PRAGMA table_info(customer_release_cycles)")
			.all() as { name: string }[];
		if (!columns.some((column) => column.name === "latest_verdict_id")) {
			this.db.exec(
				"ALTER TABLE customer_release_cycles ADD COLUMN latest_verdict_id TEXT",
			);
		}
		if (!columns.some((column) => column.name === "claim_not_after")) {
			this.db.exec(
				"ALTER TABLE customer_release_cycles ADD COLUMN claim_not_after INTEGER",
			);
		}
		this.db.exec(`CREATE TRIGGER IF NOT EXISTS customer_release_claim_deadline_immutable
			BEFORE UPDATE ON customer_release_cycles WHEN OLD.claim_not_after IS NOT NULL AND NEW.claim_not_after IS NOT OLD.claim_not_after
			BEGIN SELECT RAISE(ABORT, 'customer release immutable claim deadline'); END;`);
		this.manual.migrate();
		this.activation.migrate();
		this.accounting.migrate();
	}
	/** Oldest unresolved durable decision takes priority over every new claim. */
	unresolvedDecision(projectId: string): CustomerReleasePermit | null {
		if (!identifier(projectId))
			throw new Error("customer release project invalid");
		const row = this.db
			.prepare(`SELECT d.permit_json AS permitJson
			FROM customer_release_decisions d JOIN customer_release_cycles c ON c.cycle_id=d.cycle_id
			LEFT JOIN customer_release_attempt_results r ON r.attempt_id=d.attempt_id
			WHERE c.project_id=? AND c.state IN ('committing','commit_unknown')
			AND (r.attempt_id IS NULL OR r.kind='unknown')
			ORDER BY d.claimed_at,d.rowid LIMIT 1`)
			.get(projectId) as { permitJson: string } | undefined;
		return row ? (JSON.parse(row.permitJson) as CustomerReleasePermit) : null;
	}
	/** Scope intervention to this claim: earlier manual negatives remain audit history. */
	hasPostClaimIntervention(permit: CustomerReleasePermit): boolean {
		return !!this.db
			.prepare(`SELECT 1 FROM customer_release_events
			WHERE cycle_id=? AND kind='post_claim_intervention'
			AND seq > (SELECT seq FROM customer_release_events WHERE cycle_id=?
			AND kind='release_claimed' AND reason=? LIMIT 1) LIMIT 1`)
			.get(permit.cycleId, permit.cycleId, permit.decisionId);
	}
	forWeek(projectId: string, week: string): CustomerReleaseCycle | null {
		if (!identifier(projectId) || !/^\d{4}-\d{2}-\d{2}$/.test(week))
			throw new Error("customer release week invalid");
		const row = this.db
			.prepare(
				"SELECT cycle_id AS id FROM customer_release_cycles WHERE project_id=? AND week_start=?",
			)
			.get(projectId, week) as { id: string } | undefined;
		return row ? this.get(row.id) : null;
	}
	get(cycleId: string): CustomerReleaseCycle | null {
		const row = this.db
			.prepare(
				`SELECT ${cycleSelect} FROM customer_release_cycles WHERE cycle_id=?`,
			)
			.get(cycleId) as
			| (Omit<CustomerReleaseCycle, "frozenBeta" | "binding"> & {
					frozenBetaJson: string;
					bindingJson: string | null;
			  })
			| undefined;
		if (!row) return null;
		const { frozenBetaJson, bindingJson, ...cycle } = row;
		return {
			...cycle,
			frozenBeta: JSON.parse(frozenBetaJson),
			binding: bindingJson === null ? null : JSON.parse(bindingJson),
		};
	}
	startWorkflowDispatch(
		cycleId: string,
		binding: ReleaseWorkflowBinding,
		request: ReleaseWorkflowRequest,
		now: number,
	): boolean {
		clock(now);
		if (
			!/^[a-f0-9]{64}$/.test(request.dispatchId) ||
			!Number.isSafeInteger(request.createdAt) ||
			request.createdAt < 0 ||
			request.createdAt > now ||
			Object.keys(binding).some(
				(key) =>
					![
						"repository",
						"repositoryId",
						"workflowId",
						"workflowPath",
						"reviewedSha",
					].includes(key),
			) ||
			Object.keys(request).some(
				(key) => !["dispatchId", "createdAt", "inputs"].includes(key),
			) ||
			Object.keys(request.inputs).some(
				(key) =>
					![
						"mode",
						"release-id",
						"beta",
						"source-release-id",
						"source-binding-digest",
						"operation",
						"cycle-id",
						"binding-digest",
						"attempt-id",
					].includes(key),
			) ||
			Object.values(request.inputs).some(
				(value) => typeof value !== "string" || value.length > 128,
			)
		)
			throw new Error("workflow dispatch identity invalid");
		const payload = JSON.stringify({
			binding: Object.fromEntries(
				Object.entries(binding).sort(([a], [b]) => a.localeCompare(b)),
			),
			request: {
				dispatchId: request.dispatchId,
				createdAt: request.createdAt,
				inputs: Object.fromEntries(
					Object.entries(request.inputs).sort(([a], [b]) => a.localeCompare(b)),
				),
			},
		});
		if (payload.length > 4096)
			throw new Error("workflow dispatch identity invalid");
		return this.db
			.transaction(() => {
				const eventId = `dispatch:${request.dispatchId}`;
				const old = this.db
					.prepare(
						"SELECT cycle_id AS cycleId,kind,reason FROM customer_release_events WHERE event_id=?",
					)
					.get(eventId) as
					| { cycleId: string; kind: string; reason: string }
					| undefined;
				if (old) {
					if (
						old.cycleId !== cycleId ||
						old.kind !== "workflow_dispatch_started" ||
						old.reason !== payload
					)
						throw new Error("workflow dispatch replay mismatch");
					return false;
				}
				const cycle = this.get(cycleId),
					input = request.inputs;
				if (!cycle) throw new Error("workflow cycle missing");
				const manual = this.manual.acceptedForCycle(cycleId);
				const pending = this.unresolvedDecision(cycle.projectId);
				const allowed =
					binding.workflowPath === ".github/workflows/payload-promote.yml"
						? (input.mode === "prepare" &&
								input.beta === cycle.frozenBeta.betaVersion &&
								((cycle.state === "preparing" &&
									input["release-id"] === cycle.releaseId) ||
									(cycle.state === "cancelled" &&
										input["release-id"] !== cycle.releaseId))) ||
							(input.mode === "rebind" &&
								cycle.state === "cancelled" &&
								input["source-release-id"] === cycle.releaseId &&
								input["release-id"] !== cycle.releaseId)
						: binding.workflowPath ===
								".github/workflows/payload-auto-release.yml" &&
							input["cycle-id"] === cycleId &&
							((input.operation === "execute" &&
								((cycle.state === "awaiting_attempt" &&
									input["release-id"] === cycle.releaseId) ||
									(cycle.state === "manual_ready" &&
										input["release-id"] === manual?.card.releaseId))) ||
								(input.operation === "fence" &&
									["committing", "commit_unknown"].includes(cycle.state) &&
									pending?.cycleId === cycleId &&
									input["attempt-id"] === pending.attemptId &&
									input["release-id"] === pending.fullBinding.releaseId));
				if (!allowed) throw new Error("workflow dispatch state rejected");
				this.db
					.prepare(
						"INSERT INTO customer_release_events(event_id,cycle_id,kind,who,happened_at,reason) VALUES (?,?,'workflow_dispatch_started','system',?,?)",
					)
					.run(eventId, cycleId, now, payload);
				return true;
			})
			.immediate();
	}
	events(cycleId: string): CustomerReleaseEvent[] {
		return this.db
			.prepare(`SELECT seq,event_id AS eventId,cycle_id AS cycleId,kind,who,happened_at AS "when",reason
			FROM customer_release_events WHERE cycle_id=? ORDER BY seq`)
			.all(cycleId) as CustomerReleaseEvent[];
	}
	private event(
		cycleId: string,
		kind: string,
		revision: number,
		now: number,
		reason: string | null,
	): number {
		return Number(
			this.db
				.prepare(`INSERT INTO customer_release_events(event_id,cycle_id,kind,who,happened_at,reason)
			VALUES (?,?,?,'system',?,?)`)
				.run(`${cycleId}:${revision}:${kind}`, cycleId, kind, now, reason)
				.lastInsertRowid,
		);
	}
	manualIntakeDigest(cycleId: string): string | null {
		const row = this.db
			.prepare(
				"SELECT reason FROM customer_release_events WHERE event_id=? AND kind='manual_intake'",
			)
			.get(`manual-intake:${cycleId}`) as { reason: string } | undefined;
		return row?.reason ?? null;
	}
	reserveManualIntake(
		input: CustomerReleaseReservation,
		requestDigest: string,
	): CustomerReleaseCycle {
		if (input.projectId !== "flywheel" || !/^[a-f0-9]{64}$/.test(requestDigest))
			throw new Error("manual intake invalid");
		return this.db
			.transaction(() => {
				const existing = this.forWeek(
					input.projectId,
					weekStart(input.slotDate),
				);
				if (existing) {
					if (
						existing.releaseId === input.releaseId &&
						this.manualIntakeDigest(existing.cycleId) === requestDigest
					)
						return existing;
					throw new Error("manual intake week already consumed");
				}
				const cycle = this.reserve(input);
				this.cancel(cycle.cycleId, cycle.revision, "manual_intake", input.now);
				this.db
					.prepare(
						"INSERT INTO customer_release_events(event_id,cycle_id,kind,who,happened_at,reason) VALUES (?,?,'manual_intake','system',?,?)",
					)
					.run(
						`manual-intake:${cycle.cycleId}`,
						cycle.cycleId,
						input.now,
						requestDigest,
					);
				return this.get(cycle.cycleId)!;
			})
			.immediate();
	}

	reserve(input: CustomerReleaseReservation): CustomerReleaseCycle {
		clock(input.now);
		if (
			!identifier(input.projectId) ||
			!identifier(input.releaseId) ||
			!Number.isSafeInteger(input.activationEpoch) ||
			input.activationEpoch < 0 ||
			!/^[a-f0-9]{64}$/.test(input.policyRevision)
		)
			throw new Error("customer release identity invalid");
		const week = weekStart(input.slotDate);
		return this.db
			.transaction(() => {
				// Replay comes before candidate inspection: later betas cannot replace a reserved cycle.
				const existing = this.db
					.prepare(
						"SELECT cycle_id AS id FROM customer_release_cycles WHERE project_id=? AND week_start=?",
					)
					.get(input.projectId, week) as { id: string } | undefined;
				if (existing) return this.get(existing.id)!;
				if (
					this.db
						.prepare(
							"SELECT 1 FROM customer_release_manual_requests WHERE release_id=?",
						)
						.get(input.releaseId)
				)
					throw new Error("release identity already reserved");
				const candidate = deriveBetaCandidate(
					input.manifest as Manifest,
					input.betaVersion,
				);
				const cycleId = createHash("sha256")
					.update(JSON.stringify([input.projectId, input.slotDate]))
					.digest("hex");
				this.db
					.prepare(`INSERT INTO customer_release_cycles(cycle_id,project_id,slot_date,week_start,release_id,frozen_beta_json,policy_revision,activation_epoch,state,created_at)
				VALUES (?,?,?,?,?,?,?,?,'evaluating',?)`)
					.run(
						cycleId,
						input.projectId,
						input.slotDate,
						week,
						input.releaseId,
						JSON.stringify(candidate),
						input.policyRevision,
						input.activationEpoch,
						input.now,
					);
				this.event(cycleId, "cycle_reserved", 0, input.now, null);
				return this.get(cycleId)!;
			})
			.immediate();
	}
	cycleForNotice(noticeId: string): CustomerReleaseCycle | null {
		if (!/^[a-f0-9]{32}$/.test(noticeId)) return null;
		const row = this.db
			.prepare(
				"SELECT cycle_id AS cycleId FROM customer_release_notices WHERE notice_id=?",
			)
			.get(noticeId) as { cycleId: string } | undefined;
		return row ? this.get(row.cycleId) : null;
	}
	notice(cycleId: string): CustomerNotice | null {
		const row = this.db
			.prepare(
				"SELECT intent_json AS intentJson,binding_digest AS bindingDigest,send_state AS sendState,message_id AS messageId,delivered_at AS deliveredAt FROM customer_release_notices WHERE cycle_id=?",
			)
			.get(cycleId) as
			| (Pick<
					CustomerNotice,
					"bindingDigest" | "sendState" | "messageId" | "deliveredAt"
			  > & { intentJson: string })
			| undefined;
		if (!row) return null;
		const { intentJson, ...receipt } = row;
		return { ...JSON.parse(intentJson), ...receipt };
	}
	completePreparation(
		cycleId: string,
		revision: number,
		manifest: unknown,
		proof: CustomerPrepareReceipt,
		intent: CustomerNoticeIntent,
		now: number,
	): boolean {
		clock(now);
		return this.db
			.transaction(() => {
				const cycle = this.get(cycleId);
				if (
					!cycle ||
					cycle.state !== "preparing" ||
					cycle.revision !== revision ||
					cycle.invalidatedEventSeq !== null
				)
					return false;
				let binding: NonNullable<CustomerReleaseCycle["binding"]>;
				try {
					binding = deriveVetoBinding(manifest as Manifest, cycle.releaseId);
				} catch {
					this.cancel(cycleId, revision, "artifact_invalid", now);
					return false;
				}
				if (
					!proof ||
					proof.equivalenceVerified !== true ||
					typeof proof.workflowRunId !== "string" ||
					!/^[1-9]\d{0,19}$/.test(proof.workflowRunId) ||
					Object.keys(proof).some(
						(key) =>
							![
								"workflowRunId",
								"equivalenceVerified",
								"readbackSha256",
							].includes(key),
					) ||
					proof.readbackSha256 !== binding.releasePayloadSha256 ||
					binding.betaVersion !== cycle.frozenBeta.betaVersion ||
					binding.betaPayloadSha256 !== cycle.frozenBeta.betaPayloadSha256 ||
					binding.sourceCommit !== cycle.frozenBeta.sourceCommit ||
					!validNoticeIntent(intent) ||
					intent.deadlineAt - now < intent.minimumVetoMinutes * 60_000
				) {
					this.cancel(cycleId, revision, "preparation_evidence_invalid", now);
					return false;
				}
				const bindingJson = JSON.stringify(binding);
				this.db
					.prepare(
						"INSERT INTO customer_release_notices(cycle_id,notice_id,intent_json,binding_digest,prepare_receipt_json,send_state) VALUES (?,?,?,?,?,'intent')",
					)
					.run(
						cycleId,
						intent.noticeId,
						JSON.stringify(intent),
						createHash("sha256").update(bindingJson).digest("hex"),
						JSON.stringify(proof),
					);
				const changed = this.db
					.prepare(
						"UPDATE customer_release_cycles SET binding_json=?,state='notice_pending',revision=revision+1,deadline_at=?,claim_not_after=? WHERE cycle_id=? AND revision=? AND state='preparing' AND binding_json IS NULL",
					)
					.run(
						bindingJson,
						intent.deadlineAt,
						intent.claimNotAfter,
						cycleId,
						revision,
					);
				if (changed.changes !== 1)
					throw new Error("customer release revision conflict");
				this.event(cycleId, "artifact_prepared", revision + 1, now, null);
				return true;
			})
			.immediate();
	}
	startNotice(cycleId: string, now: number): boolean {
		clock(now);
		return this.db
			.transaction(() => {
				const cycle = this.get(cycleId),
					notice = this.notice(cycleId);
				if (
					!cycle ||
					cycle.state !== "notice_pending" ||
					cycle.invalidatedEventSeq !== null ||
					!notice ||
					notice.sendState !== "intent" ||
					now < notice.noticeAt
				)
					return false;
				if (notice.deadlineAt - now < notice.minimumVetoMinutes * 60_000) {
					this.cancel(cycleId, cycle.revision, "notice_late", now);
					return false;
				}
				return (
					this.db
						.prepare(
							"UPDATE customer_release_notices SET send_state='sending' WHERE cycle_id=? AND send_state='intent'",
						)
						.run(cycleId).changes === 1
				);
			})
			.immediate();
	}
	markNoticeUncertain(cycleId: string): boolean {
		return (
			this.db
				.prepare(
					"UPDATE customer_release_notices SET send_state='uncertain' WHERE cycle_id=? AND send_state='sending'",
				)
				.run(cycleId).changes === 1
		);
	}
	openWindow(
		cycleId: string,
		receipt: CustomerDeliveryReceipt,
		now: number,
	): boolean {
		clock(now);
		return this.db
			.transaction(() => {
				const cycle = this.get(cycleId),
					notice = this.notice(cycleId);
				if (
					!cycle ||
					cycle.state !== "notice_pending" ||
					cycle.invalidatedEventSeq !== null ||
					cycle.windowOpenedAt !== null ||
					!notice ||
					!["sending", "uncertain"].includes(notice.sendState)
				)
					return false;
				if (
					!receipt ||
					customerNoticeFields.some(
						(field) => receipt[field] !== notice[field],
					) ||
					!isDiscordId(receipt.messageId) ||
					receipt.accessVerified !== true ||
					receipt.gatewayHealthy !== true ||
					!Number.isSafeInteger(receipt.verifiedAt) ||
					receipt.verifiedAt > now ||
					now - receipt.verifiedAt > 30_000 ||
					now < notice.noticeAt ||
					notice.deadlineAt - now < notice.minimumVetoMinutes * 60_000
				) {
					this.cancel(cycleId, cycle.revision, "notice_delivery_invalid", now);
					this.db
						.prepare(
							"UPDATE customer_release_notices SET send_state='rejected' WHERE cycle_id=?",
						)
						.run(cycleId);
					return false;
				}
				this.db
					.prepare(
						"UPDATE customer_release_notices SET send_state='delivered',message_id=?,delivered_at=?,access_probe_at=? WHERE cycle_id=?",
					)
					.run(receipt.messageId, now, receipt.verifiedAt, cycleId);
				const changed = this.db
					.prepare(
						"UPDATE customer_release_cycles SET state='window_open',window_opened_at=?,revision=revision+1 WHERE cycle_id=? AND revision=? AND state='notice_pending' AND window_opened_at IS NULL",
					)
					.run(now, cycleId, cycle.revision);
				if (changed.changes !== 1)
					throw new Error("customer release revision conflict");
				this.event(cycleId, "window_opened", cycle.revision + 1, now, null);
				return true;
			})
			.immediate();
	}
	veto(
		cycleId: string,
		action: CustomerVetoAction,
		canonicalFounderId: string | null,
		now: number,
	): CustomerActionReceipt {
		clock(now);
		const fields = [
			"interactionId",
			"actorId",
			"applicationId",
			"channelId",
			"messageId",
			"noticeId",
			"bindingDigest",
		] as const;
		if (
			!action ||
			typeof action !== "object" ||
			Object.keys(action).some(
				(key) => !(fields as readonly string[]).includes(key),
			) ||
			![
				action.interactionId,
				action.actorId,
				action.applicationId,
				action.channelId,
				action.messageId,
			].every(isDiscordId) ||
			!/^[a-f0-9]{32}$/.test(action.noticeId) ||
			!/^[a-f0-9]{64}$/.test(action.bindingDigest)
		)
			throw new Error("veto binding rejected");
		const actionJson = JSON.stringify(
			Object.fromEntries(fields.map((key) => [key, action[key]])),
		);
		return this.db
			.transaction(() => {
				// Idempotent retries return the original durable result before current eligibility checks.
				const existing = this.db
					.prepare(
						"SELECT cycle_id AS cycleId,action_json AS actionJson,receipt_json AS receiptJson FROM customer_release_actions WHERE interaction_id=?",
					)
					.get(action.interactionId) as
					| { cycleId: string; actionJson: string; receiptJson: string }
					| undefined;
				if (existing) {
					if (
						existing.cycleId !== cycleId ||
						existing.actionJson !== actionJson
					)
						throw new Error("veto binding rejected");
					return JSON.parse(existing.receiptJson) as CustomerActionReceipt;
				}
				const cycle = this.get(cycleId),
					notice = this.notice(cycleId);
				if (
					!cycle ||
					!notice ||
					!cycle.binding ||
					canonicalFounderId !== notice.founderId ||
					action.actorId !== canonicalFounderId ||
					action.noticeId !== notice.noticeId ||
					action.applicationId !== notice.applicationId ||
					action.channelId !== notice.channelId ||
					action.messageId !== notice.messageId ||
					action.bindingDigest !== notice.bindingDigest
				)
					throw new Error("veto binding rejected");
				const result = this.invalidate(
					cycleId,
					cycle.revision,
					"founder_veto",
					now,
				);
				const receipt: CustomerActionReceipt = {
					interactionId: action.interactionId,
					cycleId,
					actorId: action.actorId,
					effectiveAt: now,
					result: result === "post_claim" ? "post_claim" : "cancelled",
				};
				if (result === "unchanged" && cycle.state !== "cancelled")
					throw new Error("veto state rejected");
				this.db
					.prepare(
						"INSERT INTO customer_release_actions(interaction_id,cycle_id,action,actor_id,binding_digest,action_json,receipt_json,received_at) VALUES (?,?,'veto',?,?,?,?,?)",
					)
					.run(
						action.interactionId,
						cycleId,
						action.actorId,
						action.bindingDigest,
						actionJson,
						JSON.stringify(receipt),
						now,
					);
				this.db
					.prepare(
						"INSERT INTO customer_release_events(event_id,cycle_id,kind,who,happened_at,reason) VALUES (?,?,'founder_veto',?,?,?)",
					)
					.run(
						`veto:${action.interactionId}`,
						cycleId,
						action.actorId,
						now,
						receipt.result,
					);
				return receipt;
			})
			.immediate();
	}
	/** T10 prepares the executor; this is deliberately not a publication authorization. */
	awaitAttempt(
		cycleId: string,
		revision: number,
		receipt: CustomerDeliveryReceipt,
		now: number,
		evaluate: () => string,
	): boolean {
		clock(now);
		return this.db
			.transaction(() => {
				const current = this.get(cycleId),
					notice = this.notice(cycleId);
				if (
					!current ||
					current.state !== "window_open" ||
					current.revision !== revision ||
					current.invalidatedEventSeq !== null ||
					current.deadlineAt === null ||
					now < current.deadlineAt
				)
					return false;
				if (
					!notice ||
					notice.sendState !== "delivered" ||
					current.claimNotAfter === null ||
					now > current.claimNotAfter ||
					!receipt ||
					customerNoticeFields.some(
						(field) => receipt[field] !== notice[field],
					) ||
					receipt.messageId !== notice.messageId ||
					receipt.accessVerified !== true ||
					receipt.gatewayHealthy !== true ||
					!Number.isSafeInteger(receipt.verifiedAt) ||
					receipt.verifiedAt > now ||
					now - receipt.verifiedAt > 30_000
				) {
					this.cancel(
						cycleId,
						revision,
						"attempt_window_or_delivery_invalid",
						now,
					);
					return false;
				}
				let verdictId: string;
				try {
					verdictId = evaluate();
				} catch {
					this.cancel(cycleId, revision, "readiness_evaluation_failed", now);
					return false;
				}
				const after = this.get(cycleId);
				if (
					!after ||
					after.revision !== revision ||
					after.state !== "window_open" ||
					after.invalidatedEventSeq !== null
				)
					return false;
				const verdict = this.db
					.prepare(`SELECT verdict_id AS verdictId, subject_commit AS sourceCommit, base_version AS baseVersion,
				local_deployed_sha AS localDeployedSha,state,evaluated_at AS evaluatedAt FROM release_readiness_verdicts WHERE subject_commit=? ORDER BY evaluated_at DESC,rowid DESC LIMIT 1`)
					.get(current.frozenBeta.sourceCommit) as
					| PersistedCustomerReadiness
					| undefined;
				const rejection = preparationRejection(
					current.frozenBeta,
					verdict,
					verdictId,
					now,
				);
				if (rejection) {
					this.cancel(cycleId, revision, rejection, now);
					return false;
				}
				const changed = this.db
					.prepare(
						"UPDATE customer_release_cycles SET state='awaiting_attempt',revision=revision+1,latest_verdict_id=? WHERE cycle_id=? AND revision=? AND state='window_open' AND invalidated_event_seq IS NULL",
					)
					.run(verdictId, cycleId, revision);
				if (changed.changes !== 1)
					throw new Error("customer release revision conflict");
				this.db
					.prepare(
						"UPDATE customer_release_notices SET access_probe_at=? WHERE cycle_id=?",
					)
					.run(receipt.verifiedAt, cycleId);
				this.event(cycleId, "attempt_requested", revision + 1, now, null);
				return true;
			})
			.immediate();
	}
	private claimActivation(
		cycle: CustomerReleaseCycle,
		read: () => CustomerClaimActivation,
	): CustomerClaimActivation {
		const activation = read();
		const state = this.activation.get();
		const grant = state?.enableReceiptId
			? (this.db
					.prepare(
						"SELECT epoch,payload_json AS payload FROM customer_release_activation_events WHERE event_id=? AND kind='enabled'",
					)
					.get(state.enableReceiptId) as
					| { epoch: number; payload: string }
					| undefined)
			: undefined;
		if (
			!state?.enabled ||
			!grant ||
			grant.epoch !== state.epoch ||
			JSON.parse(grant.payload).actorId !== activation.founderId ||
			state.enableReceiptId !== activation.enableReceiptId ||
			state.identity.founderId !== activation.founderId ||
			activation.founderId !== this.notice(cycle.cycleId)?.founderId ||
			state.identity.projectId !== cycle.projectId ||
			state.identity.policyRevision !== cycle.policyRevision ||
			state.identity.audience !== activation.audience ||
			state.epoch !== cycle.activationEpoch ||
			!/^[a-f0-9]{64}$/.test(activation.evidenceBundleDigest) ||
			state.evidenceBundleDigest !== activation.evidenceBundleDigest
		)
			throw new Error("enable receipt invalid");
		return activation;
	}
	/** T11: persist before exposing any permit. Network probes happen before this synchronous transaction. */
	claimAuto(
		cycleId: string,
		revision: number,
		input: CustomerReadyAttempt,
		manifest: unknown,
		receipt: CustomerDeliveryReceipt,
		now: number,
		readActivation: () => CustomerClaimActivation,
		evaluate: () => string,
	): CustomerReleasePermit | null {
		clock(now);
		const bytes = attemptBytes(input);
		// Retain unknown binding fields for validation, but detach from caller mutations during collection.
		const attempt = structuredClone(input);
		return this.db
			.transaction(() => {
				const existing = this.db
					.prepare(
						"SELECT cycle_id AS cycleId,attempt_json AS attemptJson,permit_json AS permitJson FROM customer_release_decisions WHERE attempt_id=?",
					)
					.get(attempt.attemptId) as
					| { cycleId: string; attemptJson: string; permitJson: string }
					| undefined;
				if (existing) {
					if (existing.cycleId !== cycleId || existing.attemptJson !== bytes)
						throw new Error("attempt replay mismatch");
					return JSON.parse(existing.permitJson) as CustomerReleasePermit;
				}
				const cycle = this.get(cycleId),
					notice = this.notice(cycleId);
				if (
					!cycle ||
					cycle.state !== "awaiting_attempt" ||
					cycle.revision !== revision ||
					cycle.invalidatedEventSeq !== null
				)
					return null;
				let rejection: string | null = null;
				let verdictId = "";
				try {
					rejection = claimRejection(
						cycle,
						attempt,
						this.claimActivation(cycle, readActivation),
						now,
					);
					if (
						!rejection &&
						!equalBinding(
							deriveVetoBinding(manifest as Manifest, cycle.releaseId),
							attempt.fullBinding,
						)
					)
						rejection = "manifest_binding_invalid";
					if (
						!rejection &&
						(!notice ||
							notice.sendState !== "delivered" ||
							!receipt ||
							customerNoticeFields.some(
								(field) => receipt[field] !== notice[field],
							) ||
							receipt.messageId !== notice.messageId ||
							receipt.accessVerified !== true ||
							receipt.gatewayHealthy !== true ||
							!Number.isSafeInteger(receipt.verifiedAt) ||
							receipt.verifiedAt > now ||
							now - receipt.verifiedAt > 30_000)
					)
						rejection = "claim_delivery_invalid";
					if (!rejection) {
						verdictId = evaluate();
						rejection = claimRejection(
							cycle,
							attempt,
							this.claimActivation(cycle, readActivation),
							now,
						);
					}
				} catch {
					rejection = "claim_evidence_failed";
				}
				const after = this.get(cycleId);
				// A veto or source failure during collect must survive; never roll it back on revision conflict.
				if (
					!after ||
					after.revision !== revision ||
					after.state !== "awaiting_attempt" ||
					after.invalidatedEventSeq !== null
				)
					return null;
				if (!rejection) {
					const verdict = this.db
						.prepare(`SELECT verdict_id AS verdictId, subject_commit AS sourceCommit, base_version AS baseVersion,
				 local_deployed_sha AS localDeployedSha,state,evaluated_at AS evaluatedAt FROM release_readiness_verdicts WHERE subject_commit=? ORDER BY evaluated_at DESC,rowid DESC LIMIT 1`)
						.get(cycle.frozenBeta.sourceCommit) as
						| PersistedCustomerReadiness
						| undefined;
					rejection = preparationRejection(
						cycle.frozenBeta,
						verdict,
						verdictId,
						now,
					);
				}
				if (rejection) {
					this.cancel(cycleId, revision, rejection, now);
					return null;
				}
				if (
					this.db
						.prepare(
							"SELECT 1 FROM customer_release_cycles WHERE project_id=? AND state IN ('committing','commit_unknown')",
						)
						.get(cycle.projectId)
				)
					return null;
				const permit: CustomerReleasePermit = {
					...attempt,
					decisionId: randomUUID(),
					action: "commit",
					trigger: "silence_auto",
					actor: "system",
					verdictId,
					evidenceRevision: revision,
					claimedAt: now,
					notAfter: Math.min(now + 30_000, cycle.claimNotAfter!),
				};
				this.db
					.prepare(
						"INSERT INTO customer_release_decisions(decision_id,cycle_id,attempt_id,attempt_json,permit_json,claimed_at) VALUES (?,?,?,?,?,?)",
					)
					.run(
						permit.decisionId,
						cycleId,
						attempt.attemptId,
						bytes,
						JSON.stringify(permit),
						now,
					);
				const changed = this.db
					.prepare(
						"UPDATE customer_release_cycles SET state='committing',revision=revision+1,latest_verdict_id=? WHERE cycle_id=? AND revision=? AND state='awaiting_attempt' AND invalidated_event_seq IS NULL",
					)
					.run(verdictId, cycleId, revision);
				if (changed.changes !== 1)
					throw new Error("customer release revision conflict");
				this.event(
					cycleId,
					"release_claimed",
					revision + 1,
					now,
					permit.decisionId,
				);
				return permit;
			})
			.immediate();
	}
	/** T12-T16: record authenticated endpoint evidence, never infer success from workflow status. */
	recordAttemptResult(
		cycleId: string,
		result: CustomerAttemptResult,
		now: number,
	): CustomerReleaseState {
		clock(now);
		return this.db
			.transaction(() => {
				const decision = this.db
					.prepare(
						"SELECT permit_json AS permitJson FROM customer_release_decisions WHERE attempt_id=? AND cycle_id=?",
					)
					.get(result.attemptId, cycleId) as { permitJson: string } | undefined;
				if (!decision) throw new Error("release decision missing");
				const permit = JSON.parse(decision.permitJson) as CustomerReleasePermit;
				validateAttemptResult(result, permit);
				const prior = this.db
					.prepare(
						"SELECT kind,cycle_state AS cycleState FROM customer_release_attempt_results WHERE attempt_id=?",
					)
					.get(result.attemptId) as
					| { kind: string; cycleState: CustomerReleaseState }
					| undefined;
				if (prior && (prior.kind !== "unknown" || result.kind === "unknown")) {
					if (prior.kind !== result.kind)
						throw new Error("release result contradicts terminal evidence");
					return prior.cycleState;
				}
				const cycle = this.get(cycleId);
				const latest = this.db
					.prepare(
						"SELECT attempt_id AS id FROM customer_release_decisions WHERE cycle_id=? ORDER BY rowid DESC LIMIT 1",
					)
					.get(cycleId) as { id: string } | undefined;
				if (
					!cycle ||
					!["committing", "commit_unknown"].includes(cycle.state) ||
					latest?.id !== result.attemptId
				)
					throw new Error("release result state invalid");
				let state: CustomerReleaseState;
				let reason: string | null = null;
				if (result.kind === "unknown") state = "commit_unknown";
				else if (result.kind === "published") state = "published";
				else if (result.kind === "fenced") {
					state = "cancelled";
					reason = "artifact_fenced";
				} else {
					const count = this.db
						.prepare(
							"SELECT count(*) AS n FROM customer_release_decisions WHERE cycle_id=? AND json_extract(permit_json,'$.manualRequestId') IS ?",
						)
						.get(cycleId, permit.manualRequestId ?? null) as { n: number };
					const negative = permit.manualRequestId
						? !!this.db
								.prepare(
									"SELECT 1 FROM customer_release_events WHERE cycle_id=? AND kind='post_claim_intervention' AND seq > (SELECT seq FROM customer_release_events WHERE cycle_id=? AND kind='release_claimed' AND reason=?) LIMIT 1",
								)
								.get(cycleId, cycleId, permit.decisionId)
						: cycle.invalidatedEventSeq !== null;
					reason = negative
						? "post_claim_negative"
						: count.n >= 4
							? "retry_exhausted"
							: null;
					state = reason
						? "cancelled"
						: permit.manualRequestId
							? "manual_ready"
							: "awaiting_attempt";
				}
				this.db
					.prepare(
						"INSERT INTO customer_release_attempt_results(attempt_id,cycle_id,kind,result_json,cycle_state,observed_at) VALUES (?,?,?,?,?,?) ON CONFLICT(attempt_id) DO UPDATE SET kind=excluded.kind,result_json=excluded.result_json,cycle_state=excluded.cycle_state,observed_at=excluded.observed_at",
					)
					.run(
						result.attemptId,
						cycleId,
						result.kind,
						JSON.stringify(result),
						state,
						now,
					);
				const kind =
					result.kind === "published"
						? "release_published"
						: result.kind === "unknown"
							? "commit_unknown"
							: result.kind === "fenced"
								? "release_fenced"
								: "attempt_no_write";
				const seq = this.event(
					cycleId,
					kind,
					cycle.revision + 1,
					now,
					reason ?? permit.decisionId,
				);
				const changed = this.db
					.prepare(
						"UPDATE customer_release_cycles SET state=?,revision=revision+1,cancel_reason=?,invalidated_event_seq=COALESCE(invalidated_event_seq,?) WHERE cycle_id=? AND revision=? AND state=?",
					)
					.run(
						state,
						reason,
						state === "cancelled" ? seq : null,
						cycleId,
						cycle.revision,
						cycle.state,
					);
				if (changed.changes !== 1)
					throw new Error("customer release revision conflict");
				return state;
			})
			.immediate();
	}
	/** Evaluate synchronously under the same write transaction as the durable prepare intent. */
	beginPreparation(
		cycleId: string,
		revision: number,
		now: number,
		evaluate: () => string,
	): boolean {
		clock(now);
		return this.db
			.transaction(() => {
				const current = this.get(cycleId);
				if (
					!current ||
					current.state !== "evaluating" ||
					current.revision !== revision ||
					current.invalidatedEventSeq !== null
				)
					return false;
				let verdictId: string;
				try {
					verdictId = evaluate();
				} catch {
					this.cancel(cycleId, revision, "readiness_evaluation_failed", now);
					return false;
				}
				// Source ingestion can synchronously invalidate this cycle while collecting evidence.
				// Preserve that committed intent rather than throwing and rolling back its transaction.
				const afterEvaluation = this.get(cycleId);
				if (
					!afterEvaluation ||
					afterEvaluation.revision !== revision ||
					afterEvaluation.state !== "evaluating" ||
					afterEvaluation.invalidatedEventSeq !== null
				)
					return false;
				const verdict = this.db
					.prepare(`SELECT verdict_id AS verdictId, subject_commit AS sourceCommit, base_version AS baseVersion,
				local_deployed_sha AS localDeployedSha, state, evaluated_at AS evaluatedAt FROM release_readiness_verdicts
				WHERE subject_commit=? ORDER BY evaluated_at DESC,rowid DESC LIMIT 1`)
					.get(current.frozenBeta.sourceCommit) as
					| PersistedCustomerReadiness
					| undefined;
				const rejection = preparationRejection(
					current.frozenBeta,
					verdict,
					verdictId,
					now,
				);
				if (rejection) {
					this.cancel(cycleId, revision, rejection, now);
					return false;
				}
				const changed = this.db
					.prepare(
						"UPDATE customer_release_cycles SET state='preparing',revision=revision+1,latest_verdict_id=? WHERE cycle_id=? AND revision=? AND state='evaluating' AND invalidated_event_seq IS NULL",
					)
					.run(verdictId, cycleId, revision);
				if (changed.changes !== 1)
					throw new Error("customer release revision conflict");
				this.event(cycleId, "prepare_requested", revision + 1, now, null);
				return true;
			})
			.immediate();
	}
	/** A lifecycle/Gateway failure cancels preclaims and flags exposed permits for exact recovery. */
	invalidateRuntime(
		reason: string,
		now: number,
		scope: "all" | "automatic" = "all",
	): void {
		clock(now);
		if (!identifier(reason)) throw new Error("customer release reason invalid");
		this.db
			.transaction(() => {
				const rows = this.db
					.prepare(
						`SELECT cycle_id AS id,revision FROM customer_release_cycles c
                        WHERE project_id='flywheel' AND state IN ('evaluating','preparing','notice_pending','window_open','awaiting_attempt','manual_ready','committing','commit_unknown')
                        AND (? = 'all' OR (state != 'manual_ready' AND (state NOT IN ('committing','commit_unknown') OR
                          (SELECT json_extract(permit_json,'$.manualRequestId') FROM customer_release_decisions d
                           WHERE d.cycle_id=c.cycle_id ORDER BY rowid DESC LIMIT 1) IS NULL)))`,
					)
					.all(scope) as { id: string; revision: number }[];
				for (const row of rows)
					this.invalidate(row.id, row.revision, reason, now);
			})
			.immediate();
	}
	/** Called by the release runtime at startup, never by a read-only StateStore opener. */
	recoverAfterRestart(projectId: string, now: number): CustomerReleaseCycle[] {
		clock(now);
		if (!identifier(projectId))
			throw new Error("customer release project invalid");
		return this.db
			.transaction(() => {
				const pending = this.db
					.prepare(
						"SELECT cycle_id AS id,revision FROM customer_release_cycles WHERE project_id=? AND state IN ('evaluating','preparing','notice_pending','window_open','awaiting_attempt','manual_ready')",
					)
					.all(projectId) as { id: string; revision: number }[];
				for (const row of pending)
					this.cancel(row.id, row.revision, "bridge_restart", now);
				const unresolved = this.db
					.prepare(
						"SELECT cycle_id AS id FROM customer_release_cycles WHERE project_id=? AND state IN ('committing','commit_unknown') ORDER BY created_at,cycle_id",
					)
					.all(projectId) as { id: string }[];
				return unresolved.map((row) => this.get(row.id)!);
			})
			.immediate();
	}

	/** Source failures invalidate automatic work; a fresh manual go can explicitly override B3. */
	invalidateSource(
		sourceCommit: string | null,
		reason: string,
		now: number,
	): void {
		this.invalidateSourceMatch(sourceCommit, reason, now, true);
	}
	invalidateDeployment(sourceCommit: string | null, now: number): void {
		this.invalidateSourceMatch(sourceCommit, "deployment_changed", now, false);
	}
	private invalidateSourceMatch(
		sourceCommit: string | null,
		reason: string,
		now: number,
		matches: boolean,
	): void {
		clock(now);
		if (sourceCommit !== null && !/^[a-f0-9]{40}$/.test(sourceCommit))
			throw new Error("release source identity invalid");
		this.db
			.transaction(() => {
				const rows = this.db
					.prepare(`SELECT cycle_id AS id,revision FROM customer_release_cycles c
				WHERE project_id='flywheel' AND state IN ('evaluating','preparing','notice_pending','window_open','awaiting_attempt','committing','commit_unknown','published')
				AND (? IS NULL OR (? = CASE WHEN state IN ('committing','commit_unknown','published')
				THEN COALESCE((SELECT json_extract(permit_json,'$.fullBinding.sourceCommit') FROM customer_release_decisions d WHERE d.cycle_id=c.cycle_id ORDER BY rowid DESC LIMIT 1),json_extract(frozen_beta_json,'$.sourceCommit'))
				ELSE json_extract(frozen_beta_json,'$.sourceCommit') END) = ?)`)
					.all(sourceCommit, sourceCommit, Number(matches)) as {
					id: string;
					revision: number;
				}[];
				for (const row of rows)
					this.invalidate(row.id, row.revision, reason, now);
			})
			.immediate();
	}

	/** Internal invalidation seam; founder actions additionally require a durable action receipt. */
	invalidate(
		cycleId: string,
		revision: number,
		reason: string,
		now: number,
	): "cancelled" | "post_claim" | "unchanged" {
		clock(now);
		if (!identifier(reason)) throw new Error("customer release reason invalid");
		return this.db
			.transaction(() => {
				const current = this.get(cycleId);
				if (!current || current.revision !== revision) return "unchanged";
				if (
					!["committing", "commit_unknown", "published"].includes(current.state)
				) {
					return this.cancel(cycleId, revision, reason, now)
						? "cancelled"
						: "unchanged";
				}
				const seq = this.event(
					cycleId,
					"post_claim_intervention",
					revision + 1,
					now,
					reason,
				);
				const changed = this.db
					.prepare(
						"UPDATE customer_release_cycles SET revision=revision+1,invalidated_event_seq=COALESCE(invalidated_event_seq,?) WHERE cycle_id=? AND revision=? AND state=?",
					)
					.run(seq, cycleId, revision, current.state);
				if (changed.changes !== 1)
					throw new Error("customer release revision conflict");
				return "post_claim";
			})
			.immediate();
	}
	/** Cancellation never claims to undo a release permit that has already been exposed. */
	cancel(
		cycleId: string,
		revision: number,
		reason: string,
		now: number,
	): boolean {
		clock(now);
		if (!identifier(reason)) throw new Error("customer release reason invalid");
		return this.db
			.transaction(() => {
				const current = this.get(cycleId);
				if (
					!current ||
					current.revision !== revision ||
					![
						"evaluating",
						"preparing",
						"notice_pending",
						"window_open",
						"awaiting_attempt",
						"manual_ready",
					].includes(current.state)
				)
					return false;
				const seq = this.event(
					cycleId,
					"cycle_cancelled",
					revision + 1,
					now,
					reason,
				);
				const result = this.db
					.prepare(
						`UPDATE customer_release_cycles SET state='cancelled',revision=revision+1,cancel_reason=?,invalidated_event_seq=COALESCE(invalidated_event_seq,?) WHERE cycle_id=? AND revision=? AND state=?`,
					)
					.run(reason, seq, cycleId, revision, current.state);
				if (result.changes !== 1)
					throw new Error("customer release revision conflict");
				return true;
			})
			.immediate();
	}
}
