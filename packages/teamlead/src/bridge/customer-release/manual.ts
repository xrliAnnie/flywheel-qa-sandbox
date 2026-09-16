import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
	deriveVetoBinding,
	type Manifest,
	type VetoBinding,
} from "flywheel-release-contract";
import {
	attemptBytes,
	attemptEvidenceRejection,
	equalBinding,
} from "./decisions.js";
import { isDiscordId } from "./notice.js";
import type { CustomerReleaseStore } from "./store.js";
import type {
	CustomerPrepareReceipt,
	CustomerReadyAttempt,
	CustomerReleasePermit,
} from "./types.js";

export interface ManualClaimAuthority {
	founderId: string | null;
	projectId: string;
	audience: string;
	activationEpoch: number;
	policyRevision: string;
	executionEnabled: boolean;
}

export interface ManualReleaseCard {
	activationEpoch: number;
	policyRevision: string;
	requestId: string;
	releaseId: string;
	channelId: string;
	applicationId: string;
	botUserId: string;
	founderId: string;
	messageDigest: string;
	expiresAt: number;
}
export interface ManualReleaseDelivery {
	messageId: string;
	messageDigest: string;
	channelId: string;
	applicationId: string;
	botUserId: string;
	founderId: string;
	verifiedAt: number;
	accessVerified: boolean;
	gatewayHealthy: boolean;
}
export interface ManualReleaseAction {
	interactionId: string;
	actorId: string;
	requestId: string;
	messageId: string;
	applicationId: string;
	channelId: string;
}
export interface ManualReleaseRequest {
	cycleId: string;
	card: ManualReleaseCard;
	binding: VetoBinding;
	status: "waiting" | "accepted" | "closed";
}
export interface ManualGoReceipt {
	interactionId: string;
	requestId: string;
	actorId: string;
	effectiveAt: number;
	result: "manual_ready";
}
const cardFields = [
	"activationEpoch",
	"policyRevision",
	"requestId",
	"releaseId",
	"channelId",
	"applicationId",
	"botUserId",
	"founderId",
	"messageDigest",
	"expiresAt",
] as const;
const actionFields = [
	"interactionId",
	"actorId",
	"requestId",
	"messageId",
	"applicationId",
	"channelId",
] as const;
function checkClock(now: number) {
	if (!Number.isSafeInteger(now) || now < 0)
		throw new Error("manual clock invalid");
}

/** Internal authenticated adapter boundary; independent binding never rewrites the auto cycle. */
export class CustomerManualReleaseStore {
	constructor(
		private readonly db: Database.Database,
		private readonly cycles: CustomerReleaseStore,
	) {}
	migrate(): void {
		this.db.exec(`CREATE TABLE IF NOT EXISTS customer_release_manual_requests (
			request_id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL REFERENCES customer_release_cycles(cycle_id),
			release_id TEXT NOT NULL UNIQUE, card_json TEXT NOT NULL, binding_json TEXT NOT NULL,
			prepare_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('waiting','accepted','closed')),
			go_receipt_json TEXT, delivery_json TEXT, created_at INTEGER NOT NULL
		);
		CREATE UNIQUE INDEX IF NOT EXISTS customer_release_manual_active ON customer_release_manual_requests(cycle_id) WHERE status IN ('waiting','accepted');
		CREATE TRIGGER IF NOT EXISTS customer_release_manual_immutable BEFORE UPDATE ON customer_release_manual_requests
		WHEN NEW.request_id != OLD.request_id OR NEW.cycle_id != OLD.cycle_id OR NEW.release_id != OLD.release_id
		 OR NEW.card_json != OLD.card_json OR NEW.binding_json != OLD.binding_json OR NEW.prepare_json != OLD.prepare_json
		 OR (OLD.go_receipt_json IS NOT NULL AND NEW.go_receipt_json IS NOT OLD.go_receipt_json)
		 OR (OLD.delivery_json IS NOT NULL AND NEW.delivery_json IS NOT OLD.delivery_json)
		BEGIN SELECT RAISE(ABORT, 'immutable manual request'); END;`);
	}
	acceptedForCycle(cycleId: string): ManualReleaseRequest | null {
		const row = this.db
			.prepare(
				"SELECT request_id AS id FROM customer_release_manual_requests WHERE cycle_id=? AND status='accepted' LIMIT 1",
			)
			.get(cycleId) as { id: string } | undefined;
		return row ? this.get(row.id) : null;
	}
	get(requestId: string): ManualReleaseRequest | null {
		const row = this.db
			.prepare(
				"SELECT cycle_id AS cycleId,card_json AS cardJson,binding_json AS bindingJson,status FROM customer_release_manual_requests WHERE request_id=?",
			)
			.get(requestId) as
			| {
					cycleId: string;
					cardJson: string;
					bindingJson: string;
					status: ManualReleaseRequest["status"];
			  }
			| undefined;
		return row
			? {
					cycleId: row.cycleId,
					card: JSON.parse(row.cardJson),
					binding: JSON.parse(row.bindingJson),
					status: row.status,
				}
			: null;
	}
	acceptedExecutions(): {
		request: ManualReleaseRequest;
		receipt: ManualGoReceipt;
	}[] {
		const rows = this.db
			.prepare(
				"SELECT r.request_id AS id,r.go_receipt_json AS receipt FROM customer_release_manual_requests r JOIN customer_release_cycles c ON c.cycle_id=r.cycle_id WHERE r.status='accepted' AND c.project_id='flywheel' AND c.state='manual_ready' ORDER BY r.created_at LIMIT 100",
			)
			.all() as { id: string; receipt: string }[];
		return rows.map((row) => ({
			request: this.get(row.id)!,
			receipt: JSON.parse(row.receipt),
		}));
	}

	waitingCards(now: number): ManualReleaseRequest[] {
		checkClock(now);
		const rows = this.db
			.prepare(
				"SELECT r.request_id AS id FROM customer_release_manual_requests r JOIN customer_release_cycles c ON c.cycle_id=r.cycle_id WHERE r.status='waiting' AND c.project_id='flywheel' AND c.state='cancelled' AND json_extract(r.card_json,'$.expiresAt')>? ORDER BY r.created_at LIMIT 100",
			)
			.all(now) as { id: string }[];
		return rows.map((row) => this.get(row.id)!);
	}
	deliveryIntent(
		requestId: string,
	): { at: number; messageId: string | null } | null {
		const row = this.db
			.prepare(
				"SELECT happened_at AS at FROM customer_release_events WHERE event_id=? AND kind='manual_notice_sending'",
			)
			.get(`manual-send:${requestId}`) as { at: number } | undefined;
		if (!row) return null;
		const delivered = this.db
			.prepare(
				"SELECT reason FROM customer_release_events WHERE event_id=? AND kind='manual_notice_delivered'",
			)
			.get(`manual-delivery:${requestId}`) as { reason: string } | undefined;
		return {
			at: row.at,
			messageId: delivered ? JSON.parse(delivered.reason).messageId : null,
		};
	}
	startDelivery(requestId: string, now: number): boolean {
		checkClock(now);
		return this.db
			.transaction(() => {
				const request = this.get(requestId);
				if (
					!request ||
					request.status !== "waiting" ||
					request.card.expiresAt <= now ||
					this.cycles.get(request.cycleId)?.state !== "cancelled"
				)
					throw new Error("manual delivery unavailable");
				if (this.deliveryIntent(requestId)) return false;
				this.db
					.prepare(
						"INSERT INTO customer_release_events(event_id,cycle_id,kind,who,happened_at,reason) VALUES (?,?,'manual_notice_sending','system',?,?)",
					)
					.run(
						`manual-send:${requestId}`,
						request.cycleId,
						now,
						JSON.stringify({ requestId }),
					);
				return true;
			})
			.immediate();
	}
	recordDeliveredMessage(
		requestId: string,
		messageId: string,
		now: number,
	): void {
		checkClock(now);
		if (!isDiscordId(messageId)) throw new Error("manual delivery invalid");
		this.db
			.transaction(() => {
				const request = this.get(requestId),
					intent = this.deliveryIntent(requestId);
				if (
					!request ||
					request.status !== "waiting" ||
					!intent ||
					request.card.expiresAt <= now
				)
					throw new Error("manual delivery unavailable");
				if (intent.messageId) {
					if (intent.messageId !== messageId)
						throw new Error("manual delivery changed");
					return;
				}
				this.db
					.prepare(
						"INSERT INTO customer_release_events(event_id,cycle_id,kind,who,happened_at,reason) VALUES (?,?,'manual_notice_delivered','system',?,?)",
					)
					.run(
						`manual-delivery:${requestId}`,
						request.cycleId,
						now,
						JSON.stringify({ messageId }),
					);
			})
			.immediate();
	}

	prepare(
		cycleId: string,
		manifest: unknown,
		proof: CustomerPrepareReceipt,
		card: ManualReleaseCard,
		now: number,
	): ManualReleaseRequest {
		checkClock(now);
		if (
			!card ||
			!Number.isSafeInteger(card.activationEpoch) ||
			card.activationEpoch < 0 ||
			typeof card.policyRevision !== "string" ||
			!/^[a-f0-9]{64}$/.test(card.policyRevision) ||
			Object.keys(card).some(
				(key) => !(cardFields as readonly string[]).includes(key),
			) ||
			!/^[a-f0-9]{32}$/.test(card.requestId) ||
			!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(card.releaseId) ||
			!/^[a-f0-9]{64}$/.test(card.messageDigest) ||
			![
				card.channelId,
				card.applicationId,
				card.botUserId,
				card.founderId,
			].every(isDiscordId) ||
			!Number.isSafeInteger(card.expiresAt) ||
			card.expiresAt <= now
		)
			throw new Error("manual card invalid");
		const binding = deriveVetoBinding(manifest as Manifest, card.releaseId);
		if (
			!proof ||
			proof.equivalenceVerified !== true ||
			!/^[1-9]\d{0,19}$/.test(proof.workflowRunId) ||
			proof.readbackSha256 !== binding.releasePayloadSha256 ||
			Object.keys(proof).some(
				(key) =>
					!["workflowRunId", "equivalenceVerified", "readbackSha256"].includes(
						key,
					),
			)
		)
			throw new Error("manual preparation invalid");
		const cardJson = JSON.stringify(
			Object.fromEntries(cardFields.map((key) => [key, card[key]])),
		);
		return this.db
			.transaction(() => {
				const prior = this.get(card.requestId);
				if (prior) {
					if (
						prior.cycleId !== cycleId ||
						JSON.stringify(prior.card) !== cardJson ||
						JSON.stringify(prior.binding) !== JSON.stringify(binding)
					)
						throw new Error("manual request replay mismatch");
					return prior;
				}
				if (
					this.db
						.prepare("SELECT 1 FROM customer_release_cycles WHERE release_id=?")
						.get(card.releaseId)
				)
					throw new Error("release identity already reserved");
				const cycle = this.cycles.get(cycleId);
				if (
					!cycle ||
					cycle.state !== "cancelled" ||
					cycle.releaseId === card.releaseId
				)
					throw new Error("manual cycle invalid");
				this.db
					.prepare(
						"UPDATE customer_release_manual_requests SET status='closed' WHERE cycle_id=? AND status IN ('waiting','accepted')",
					)
					.run(cycleId);
				this.db
					.prepare(
						"INSERT INTO customer_release_manual_requests VALUES (?,?,?,?,?,?,'waiting',NULL,NULL,?)",
					)
					.run(
						card.requestId,
						cycleId,
						card.releaseId,
						cardJson,
						JSON.stringify(binding),
						JSON.stringify(proof),
						now,
					);
				this.db
					.prepare(
						"INSERT INTO customer_release_events(event_id,cycle_id,kind,who,happened_at,reason) VALUES (?,?,'manual_artifact_prepared','system',?,?)",
					)
					.run(
						`manual:${card.requestId}:prepared`,
						cycleId,
						now,
						card.requestId,
					);
				return this.get(card.requestId)!;
			})
			.immediate();
	}
	claim(
		requestId: string,
		input: CustomerReadyAttempt,
		manifest: unknown,
		now: number,
		readAuthority: () => ManualClaimAuthority,
		evaluate: () => string,
	): CustomerReleasePermit | null {
		checkClock(now);
		const bytes = attemptBytes(input),
			attempt = structuredClone(input);
		return this.db
			.transaction(() => {
				const old = this.db
					.prepare(
						"SELECT attempt_json AS bytes,permit_json AS permit FROM customer_release_decisions WHERE attempt_id=?",
					)
					.get(attempt.attemptId) as
					| { bytes: string; permit: string }
					| undefined;
				if (old) {
					const permit = JSON.parse(old.permit) as CustomerReleasePermit;
					if (old.bytes !== bytes || permit.manualRequestId !== requestId)
						throw new Error("manual attempt replay mismatch");
					return permit;
				}
				const request = this.get(requestId);
				if (!request || request.status !== "accepted") return null;
				const { cycleId, card, binding } = request;
				const go = this.db
					.prepare(
						"SELECT a.interaction_id AS id FROM customer_release_manual_requests r JOIN customer_release_actions a ON a.receipt_json=r.go_receipt_json AND a.cycle_id=r.cycle_id WHERE r.request_id=? AND a.action='go' AND a.actor_id=? AND json_extract(a.action_json,'$.requestId')=?",
					)
					.get(requestId, card.founderId, requestId);
				if (!go) return null;
				const cycle = this.cycles.get(cycleId);
				if (!cycle || cycle.state !== "manual_ready") return null;
				const validAuthority = () => {
					const authority = readAuthority();
					return (
						authority.executionEnabled === true &&
						authority.founderId === card.founderId &&
						authority.projectId === cycle.projectId &&
						authority.policyRevision === card.policyRevision &&
						authority.activationEpoch === card.activationEpoch &&
						authority.audience === attempt.audience &&
						attempt.activationEpoch === card.activationEpoch
					);
				};
				let verdictId = "",
					valid = false;
				try {
					valid =
						validAuthority() &&
						attemptEvidenceRejection(attempt, now) === null &&
						attempt.cycleId === cycleId &&
						attempt.projectId === cycle.projectId &&
						now < card.expiresAt &&
						equalBinding(attempt.fullBinding, binding) &&
						attempt.readbackSha256 === binding.releasePayloadSha256 &&
						equalBinding(
							deriveVetoBinding(manifest as Manifest, binding.releaseId),
							binding,
						);
					if (valid) {
						verdictId = evaluate();
						valid = validAuthority();
					}
				} catch {
					valid = false;
				}
				const after = this.cycles.get(cycleId);
				if (
					!after ||
					after.revision !== cycle.revision ||
					after.state !== "manual_ready"
				)
					return null;
				const verdict = valid
					? (this.db
							.prepare(
								"SELECT verdict_id AS id,base_version AS base,state,reasons_json AS reasons,evaluated_at AS at FROM release_readiness_verdicts WHERE subject_commit=? ORDER BY evaluated_at DESC,rowid DESC LIMIT 1",
							)
							.get(binding.sourceCommit) as
							| {
									id: string;
									base: string;
									state: string;
									reasons: string;
									at: string;
							  }
							| undefined)
					: undefined;
				let reasons: unknown[] = [];
				try {
					reasons = verdict ? JSON.parse(verdict.reasons) : [];
				} catch {
					valid = false;
				}
				if (
					!valid ||
					!verdict ||
					verdict.id !== verdictId ||
					verdict.base !== binding.releaseVersion ||
					!["green", "hold", "unknown"].includes(verdict.state) ||
					!Number.isFinite(Date.parse(verdict.at)) ||
					Date.parse(verdict.at) > now ||
					now - Date.parse(verdict.at) > 30_000 ||
					!Array.isArray(reasons)
				) {
					this.cycles.cancel(
						cycleId,
						cycle.revision,
						"manual_claim_evidence_invalid",
						now,
					);
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
					trigger:
						verdict.state === "green" ? "founder_go" : "founder_override",
					actor: card.founderId,
					manualRequestId: requestId,
					readiness: { state: verdict.state, reasons },
					verdictId,
					evidenceRevision: cycle.revision,
					claimedAt: now,
					notAfter: Math.min(now + 30_000, card.expiresAt),
				};
				this.db
					.prepare(
						"INSERT INTO customer_release_decisions VALUES (?,?,?,?,?,?)",
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
						"UPDATE customer_release_cycles SET state='committing',revision=revision+1,latest_verdict_id=? WHERE cycle_id=? AND revision=? AND state='manual_ready'",
					)
					.run(verdictId, cycleId, cycle.revision);
				if (changed.changes !== 1) throw new Error("manual revision conflict");
				this.db
					.prepare(
						"INSERT INTO customer_release_events(event_id,cycle_id,kind,who,happened_at,reason) VALUES (?,?,'release_claimed',?,?,?)",
					)
					.run(
						`${cycleId}:${cycle.revision + 1}:release_claimed`,
						cycleId,
						card.founderId,
						now,
						permit.decisionId,
					);
				return permit;
			})
			.immediate();
	}

	go(
		requestId: string,
		action: ManualReleaseAction,
		delivery: ManualReleaseDelivery | null,
		canonicalFounderId: string | null,
		now: number,
	): ManualGoReceipt {
		checkClock(now);
		if (
			!action ||
			Object.keys(action).some(
				(key) => !(actionFields as readonly string[]).includes(key),
			) ||
			action.requestId !== requestId ||
			![
				action.interactionId,
				action.actorId,
				action.messageId,
				action.applicationId,
				action.channelId,
			].every(isDiscordId)
		)
			throw new Error("manual action invalid");
		const bytes = JSON.stringify(
			Object.fromEntries(actionFields.map((key) => [key, action[key]])),
		);
		return this.db
			.transaction(() => {
				const old = this.db
					.prepare(
						"SELECT action_json AS actionJson,receipt_json AS receiptJson,action FROM customer_release_actions WHERE interaction_id=?",
					)
					.get(action.interactionId) as
					| { actionJson: string; receiptJson: string; action: string }
					| undefined;
				if (old) {
					if (old.action !== "go" || old.actionJson !== bytes)
						throw new Error("manual action replay mismatch");
					return JSON.parse(old.receiptJson) as ManualGoReceipt;
				}
				const request = this.get(requestId);
				if (!request || request.status !== "waiting")
					throw new Error("manual request unavailable");
				const { card, binding, cycleId } = request;
				const cycle = this.cycles.get(cycleId);
				if (
					!cycle ||
					cycle.state !== "cancelled" ||
					now >= card.expiresAt ||
					action.actorId !== canonicalFounderId ||
					canonicalFounderId !== card.founderId ||
					action.applicationId !== card.applicationId ||
					action.channelId !== card.channelId ||
					!delivery ||
					delivery.messageId !== action.messageId ||
					[
						"channelId",
						"applicationId",
						"botUserId",
						"founderId",
						"messageDigest",
					].some(
						(key) =>
							delivery[key as keyof ManualReleaseDelivery] !==
							card[key as keyof ManualReleaseCard],
					) ||
					delivery.accessVerified !== true ||
					delivery.gatewayHealthy !== true ||
					!Number.isSafeInteger(delivery.verifiedAt) ||
					delivery.verifiedAt > now ||
					now - delivery.verifiedAt > 30_000
				)
					throw new Error("manual go evidence invalid");
				const receipt: ManualGoReceipt = {
					interactionId: action.interactionId,
					requestId,
					actorId: action.actorId,
					effectiveAt: now,
					result: "manual_ready",
				};
				this.db
					.prepare(
						"INSERT INTO customer_release_actions VALUES (?,?,'go',?,?,?,?,?)",
					)
					.run(
						action.interactionId,
						cycleId,
						action.actorId,
						createHash("sha256").update(JSON.stringify(binding)).digest("hex"),
						bytes,
						JSON.stringify(receipt),
						now,
					);
				this.db
					.prepare(
						"UPDATE customer_release_manual_requests SET status='accepted',go_receipt_json=?,delivery_json=? WHERE request_id=? AND status='waiting'",
					)
					.run(JSON.stringify(receipt), JSON.stringify(delivery), requestId);
				const changed = this.db
					.prepare(
						"UPDATE customer_release_cycles SET state='manual_ready',revision=revision+1 WHERE cycle_id=? AND revision=? AND state='cancelled'",
					)
					.run(cycleId, cycle.revision);
				if (changed.changes !== 1) throw new Error("manual revision conflict");
				this.db
					.prepare(
						"INSERT INTO customer_release_events(event_id,cycle_id,kind,who,happened_at,reason) VALUES (?,?,'founder_go',?,?,?)",
					)
					.run(
						`manual:${action.interactionId}:go`,
						cycleId,
						action.actorId,
						now,
						requestId,
					);
				return receipt;
			})
			.immediate();
	}
}
