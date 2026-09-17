import { randomUUID } from "node:crypto";
import { closeSync, lstatSync, openSync } from "node:fs";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { ArtifactRecord } from "./artifacts.js";
import { canonical, contentDigest, parseStrictJson } from "./canonical.js";
import { artifactSchema, freezeWrite } from "./contracts.js";
import { openWriteLedger } from "./migrations.js";
import { cursorJson, type ObserverCursor } from "./pagination.js";
import { dispatchPermitSchema } from "./permit.js";

export type WriteNotification = {
	eventId: string;
	receiptId: string | null;
	eventKind: string;
	proposalId: string;
	expiry: number;
	attemptCount: number;
	projectId: string;
	leadId: string;
	contentDigest: string;
};

type Frozen = ReturnType<typeof freezeWrite>;
const id = z.string().min(1).max(256);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const decisionSchema = z
	.object({
		receiptId: id,
		proposalId: id,
		contentDigest: digest,
		purpose: z.literal("xiaohongshu_founder_write"),
		decision: z.enum(["approved", "rejected"]),
		founderId: id,
		founderConfigVersion: time.min(1),
		founderMessageId: id,
		guildId: id,
		channelId: id,
		cardId: id,
		messageDigest: digest,
		messageCreatedAt: time,
		observedAt: time,
		expiresAt: time,
	})
	.strict();
type Decision = z.infer<typeof decisionSchema>;
export type WriteIdentity = Frozen["account"] & {
	requesterUid: number;
	projectId: string;
	leadId: string;
	authorityPolicyVersion: number;
	founderConfigVersion: number;
};
export type ClaimRequest = {
	proposalId: string;
	receiptId: string;
	contentDigest: string;
	activationId: string;
	executeRequestId: string;
	leaseId: string;
	identity: WriteIdentity;
};
export type ClaimResult =
	| { kind: "claimed"; attemptId: string }
	| { kind: "existing"; attemptId: string; state: string }
	| { kind: "denied"; code: string };
type ProposalRow = {
	proposal_id: string;
	frozen_json: string;
	content_digest: string;
	expires_at: number;
	state: string;
	created_at: number;
	card_id: string | null;
	guild_id: string | null;
	channel_id: string | null;
	preview_manifest_json: string | null;
};
type DecisionRow = {
	receipt_id: string;
	content_digest: string;
	founder_config_version: number;
	expires_at: number;
	consumed_at: number | null;
	decision: string;
	observed_at: number;
	purpose: string;
};
type AttemptRow = { attempt_id: string; state: string; activation_id: string };

/** Private authority writer. None of these methods are exposed on the ingress API. */
export class XhsWriteStore {
	private readonly database: Database.Database;
	private readonly generation: string;
	constructor(
		path: string,
		options: { initialize?: boolean; providerGeneration: string },
	) {
		this.generation = id.parse(options.providerGeneration);
		if (options.initialize) closeSync(openSync(path, "wx", 0o600));
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600)
			throw Error("durability_unavailable");
		const db = openWriteLedger(path, { provision: options.initialize });
		try {
			if (options.initialize) {
				db.transaction(() => {
					db.exec(
						"CREATE TABLE authority_metadata (singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation TEXT NOT NULL)",
					);
					db.prepare("INSERT INTO authority_metadata VALUES (1,?)").run(
						this.generation,
					);
				}).immediate();
			}
			const metadata = db
				.prepare("SELECT generation FROM authority_metadata WHERE singleton=1")
				.get() as { generation: string } | undefined;
			if (metadata?.generation !== this.generation)
				throw Error("generation_mismatch");
			this.database = db;
			// Private metadata migration: existing ledgers acquire a closed gate, never
			// infer activation from historical approval/consumption rows.
			this.transaction(() => {
				const columns = db.pragma("table_info(authority_metadata)") as {
					name: string;
				}[];
				if (!columns.some((c) => c.name === "write_enabled"))
					db.exec(
						"ALTER TABLE authority_metadata ADD COLUMN write_enabled INTEGER NOT NULL DEFAULT 0 CHECK(write_enabled IN (0,1))",
					);
				if (!columns.some((c) => c.name === "gate_updated_at"))
					db.exec(
						"ALTER TABLE authority_metadata ADD COLUMN gate_updated_at INTEGER NOT NULL DEFAULT 0 CHECK(gate_updated_at>=0)",
					);
			});
		} catch (error) {
			db.close();
			throw error;
		}
	}
	close(): void {
		if (this.database.open) this.database.close();
	}
	durability() {
		const db = this.database;
		return {
			journalMode: db.pragma("journal_mode", { simple: true }),
			synchronous: db.pragma("synchronous", { simple: true }),
			fullfsync: db.pragma("fullfsync", { simple: true }),
			checkpointFullfsync: db.pragma("checkpoint_fullfsync", { simple: true }),
			foreignKeys: db.pragma("foreign_keys", { simple: true }),
			busyTimeout: db.pragma("busy_timeout", { simple: true }),
		};
	}
	private transaction<T>(body: () => T): T {
		const db = this.database;
		const expected = {
			journalMode: "wal",
			synchronous: 2,
			fullfsync: 1,
			checkpointFullfsync: 1,
			foreignKeys: 1,
			busyTimeout: 5000,
		};
		const actual = this.durability();
		if (
			Object.entries(expected).some(
				([key, value]) => actual[key as keyof typeof actual] !== value,
			)
		)
			throw Error("durability_unavailable");
		db.exec("BEGIN IMMEDIATE");
		try {
			const result = body();
			db.exec("COMMIT");
			return result;
		} catch (error) {
			if (db.inTransaction) db.exec("ROLLBACK");
			throw error;
		}
	}
	private proposal(proposalId: string): ProposalRow | undefined {
		return this.database
			.prepare("SELECT * FROM xhs_write_proposal WHERE proposal_id=?")
			.get(proposalId) as ProposalRow | undefined;
	}
	private matches(row: ProposalRow, identity: WriteIdentity): boolean {
		const frozen = parseStrictJson(row.frozen_json) as Frozen;
		return (
			frozen.projectId === identity.projectId &&
			frozen.leadId === identity.leadId &&
			frozen.requesterUid === identity.requesterUid &&
			frozen.authorityPolicyVersion === identity.authorityPolicyVersion &&
			Object.entries(frozen.account).every(
				([key, value]) => identity[key as keyof WriteIdentity] === value,
			) &&
			frozen.account.providerGeneration === this.generation
		);
	}
	/** Private provider callback attribution; never accepts a replacement activation. */
	pinnedDispatch(proposalId: string) {
		id.parse(proposalId);
		const row = this.proposal(proposalId);
		if (!row || row.state !== "consumed") return null;
		const frozen = parseStrictJson(row.frozen_json) as Frozen;
		if (contentDigest(frozen) !== row.content_digest) return null;
		const attempt = this.database
			.prepare(
				"SELECT attempt_id,state,activation_id FROM xhs_write_attempt WHERE proposal_id=?",
			)
			.get(proposalId) as AttemptRow | undefined;
		if (
			!attempt ||
			!["claimed", "dispatch-admitted", "dispatched"].includes(attempt.state)
		)
			return null;
		return { frozen, activationId: attempt.activation_id };
	}
	/** Private preparation recovery; retains server-assigned ID/expiry on retry. */
	preparedRequest(prepareRequestId: string, identity: WriteIdentity) {
		id.parse(prepareRequestId);
		const row = this.database
			.prepare(
				"SELECT * FROM xhs_write_proposal WHERE project_id=? AND lead_id=? AND prepare_request_id=?",
			)
			.get(identity.projectId, identity.leadId, prepareRequestId) as
			| (ProposalRow & { supersedes_id: string | null })
			| undefined;
		if (!row) return null;
		if (!this.matches(row, identity)) throw Error("prepare_conflict");
		return {
			frozen: parseStrictJson(row.frozen_json) as Frozen,
			expiresAt: row.expires_at,
			state: row.state,
			supersedesProposalId: row.supersedes_id,
		};
	}
	/** Read-only recovery for a lost preparation response; never redelivers cards. */
	preparedStatus(prepareRequestId: string, identity: WriteIdentity) {
		id.parse(prepareRequestId);
		const row = this.database
			.prepare(
				"SELECT * FROM xhs_write_proposal WHERE project_id=? AND lead_id=? AND prepare_request_id=?",
			)
			.get(identity.projectId, identity.leadId, prepareRequestId) as
			| ProposalRow
			| undefined;
		if (!row || !this.matches(row, identity)) return null;
		return {
			proposalId: row.proposal_id,
			contentDigest: row.content_digest,
			state: row.state,
			expiresAt: row.expires_at,
			cardRef:
				row.preview_manifest_json !== null &&
				row.card_id &&
				row.guild_id &&
				row.channel_id
					? {
							guildId: row.guild_id,
							channelId: row.channel_id,
							messageId: row.card_id,
						}
					: null,
		};
	}
	prepare(
		input: {
			frozen: Frozen;
			prepareRequestId: string;
			expiresAt: number;
			supersedesProposalId?: string;
		},
		now: number,
	) {
		time.parse(now);
		time.parse(input.expiresAt);
		id.parse(input.prepareRequestId);
		const frozen = freezeWrite(input.frozen, now);
		if (
			frozen.account.providerGeneration !== this.generation ||
			input.expiresAt <= now
		)
			throw Error("prepare_invalid");
		const hash = contentDigest(frozen);
		return this.transaction(() => {
			const prior = this.database
				.prepare(
					"SELECT * FROM xhs_write_proposal WHERE project_id=? AND lead_id=? AND prepare_request_id=?",
				)
				.get(frozen.projectId, frozen.leadId, input.prepareRequestId) as
				| ProposalRow
				| undefined;
			if (prior) {
				if (
					prior.content_digest !== hash ||
					prior.expires_at !== input.expiresAt
				)
					throw Error("prepare_conflict");
				return { proposalId: prior.proposal_id, contentDigest: hash };
			}
			// Admission is durable and shares the insert transaction, so restarts or
			// concurrent clients cannot reset the founder-card budget. Failed delivery
			// retains its reservation; retrying that same request does not count again.
			const quota = this.database
				.prepare(`SELECT
 SUM(CASE WHEN state IN ('awaiting_delivery','awaiting_approval','approved') AND expires_at>? THEN 1 ELSE 0 END) AS pending,
 SUM(CASE WHEN created_at>? THEN 1 ELSE 0 END) AS recent
 FROM xhs_write_proposal WHERE project_id=? AND json_extract(frozen_json,'$.requesterUid')=?`)
				.get(now, now - 600000, frozen.projectId, frozen.requesterUid) as {
				pending: number | null;
				recent: number | null;
			};
			if ((quota.pending ?? 0) >= 3 || (quota.recent ?? 0) >= 3)
				throw Error("proposal_rate_limited");
			this.database
				.prepare(`INSERT INTO xhs_write_proposal
    (proposal_id,project_id,lead_id,prepare_request_id,frozen_json,content_digest,account_user_id,account_epoch,provider_generation,expires_at,state,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,'awaiting_delivery',?)`)
				.run(
					frozen.proposalId,
					frozen.projectId,
					frozen.leadId,
					input.prepareRequestId,
					canonical(frozen),
					hash,
					frozen.account.accountUserId,
					frozen.account.accountEpoch,
					this.generation,
					input.expiresAt,
					now,
				);
			for (const [ordinal, media] of frozen.media.entries()) {
				const artifact = this.database
					.prepare(
						"SELECT 1 FROM xhs_frozen_artifact WHERE artifact_id=? AND project_id=? AND sha256=? AND size=? AND mime=?",
					)
					.get(
						media.artifactId,
						frozen.projectId,
						media.sha256,
						media.sizeBytes,
						media.mimeType,
					);
				if (!artifact) throw Error("artifact_unverified");
				this.database
					.prepare("INSERT INTO xhs_write_media_ref VALUES (?,?,?)")
					.run(frozen.proposalId, ordinal, media.artifactId);
			}
			if (input.supersedesProposalId) {
				const old = this.proposal(input.supersedesProposalId);
				const identity = {
					...frozen.account,
					requesterUid: frozen.requesterUid,
					projectId: frozen.projectId,
					leadId: frozen.leadId,
					authorityPolicyVersion: frozen.authorityPolicyVersion,
					founderConfigVersion: 1,
				};
				if (
					!old ||
					old.proposal_id === frozen.proposalId ||
					!this.matches(old, identity) ||
					!["awaiting_delivery", "awaiting_approval", "approved"].includes(
						old.state,
					)
				)
					throw Error("supersede_denied");
				this.database
					.prepare(
						"UPDATE xhs_write_proposal SET state='superseded' WHERE proposal_id=?",
					)
					.run(old.proposal_id);
				this.database
					.prepare(
						"UPDATE xhs_write_proposal SET supersedes_id=? WHERE proposal_id=?",
					)
					.run(old.proposal_id, frozen.proposalId);
				this.database
					.prepare(
						"INSERT INTO xhs_write_event VALUES (?,NULL,?,'superseded','requester',?,?)",
					)
					.run(randomUUID(), old.proposal_id, hash, now);
			}
			return { proposalId: frozen.proposalId, contentDigest: hash };
		});
	}
	delivered(
		proposalId: string,
		card: {
			expectedContentDigest?: string;
			manifestJson?: string;
			previewDigest: string;
			cardId: string;
			challenge: string;
			guildId: string;
			channelId: string;
		},
		now: number,
	): void {
		time.parse(now);
		digest.parse(card.previewDigest);
		id.parse(card.cardId);
		id.parse(card.guildId);
		id.parse(card.channelId);
		if (!/^[A-Z0-9]{8}$/.test(card.challenge)) throw Error("invalid_challenge");
		this.transaction(() => {
			const proposal = this.proposal(proposalId);
			if (
				card.expectedContentDigest !== undefined &&
				(!proposal ||
					proposal.content_digest !== card.expectedContentDigest ||
					contentDigest(parseStrictJson(proposal.frozen_json)) !==
						card.expectedContentDigest)
			)
				throw Error("preview_unavailable");
			const changed = this.database
				.prepare(
					"UPDATE xhs_write_proposal SET state='awaiting_approval',preview_manifest_json=?,preview_digest=?,card_id=?,challenge=?,guild_id=?,channel_id=? WHERE proposal_id=? AND state='awaiting_delivery' AND expires_at>?",
				)
				.run(
					card.manifestJson ?? null,
					card.previewDigest,
					card.cardId,
					card.challenge,
					card.guildId,
					card.channelId,
					proposalId,
					now,
				);
			if (changed.changes !== 1) throw Error("preview_unavailable");
		});
	}
	recordDecision(input: Decision, assertAuthority?: () => void) {
		const decision = decisionSchema.parse(input);
		return this.transaction(() => {
			assertAuthority?.();
			const db = this.database;
			const previous = db
				.prepare(
					"SELECT receipt_id,observed_at FROM xhs_write_decision WHERE proposal_id=? OR founder_message_id=? OR receipt_id=?",
				)
				.get(
					decision.proposalId,
					decision.founderMessageId,
					decision.receiptId,
				) as { receipt_id: string; observed_at: number } | undefined;
			if (previous) {
				const event = db
					.prepare(
						"SELECT evidence_digest FROM xhs_write_event WHERE source_message_id=? AND event_kind='decision'",
					)
					.get(decision.founderMessageId) as
					| { evidence_digest: string }
					| undefined;
				if (
					previous.receipt_id !== decision.receiptId ||
					event?.evidence_digest !==
						contentDigest({ ...decision, observedAt: previous.observed_at })
				)
					throw Error("decision_conflict");
				return { receiptId: decision.receiptId, existing: true };
			}
			const row = this.proposal(decision.proposalId);
			if (!row || row.state !== "awaiting_approval")
				throw Error("preview_unavailable");
			if (
				row.content_digest !== decision.contentDigest ||
				contentDigest(parseStrictJson(row.frozen_json)) !==
					decision.contentDigest ||
				row.card_id !== decision.cardId ||
				row.guild_id !== decision.guildId ||
				row.channel_id !== decision.channelId
			)
				throw Error("decision_conflict");
			if (
				decision.messageCreatedAt < row.created_at ||
				decision.observedAt < decision.messageCreatedAt - 30000 ||
				decision.expiresAt >
					Math.min(row.expires_at, decision.messageCreatedAt + 15 * 60_000) ||
				decision.observedAt >= decision.expiresAt
			)
				throw Error("founder_receipt_expired");
			db.prepare(`INSERT INTO xhs_write_decision
    (receipt_id,proposal_id,founder_message_id,purpose,decision,founder_id,founder_config_version,guild_id,channel_id,card_id,message_digest,message_created_at,observed_at,expires_at,content_digest)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
				decision.receiptId,
				decision.proposalId,
				decision.founderMessageId,
				decision.purpose,
				decision.decision,
				decision.founderId,
				decision.founderConfigVersion,
				decision.guildId,
				decision.channelId,
				decision.cardId,
				decision.messageDigest,
				decision.messageCreatedAt,
				decision.observedAt,
				decision.expiresAt,
				decision.contentDigest,
			);
			db.prepare(
				"UPDATE xhs_write_proposal SET state=? WHERE proposal_id=?",
			).run(decision.decision, decision.proposalId);
			db.prepare(
				"INSERT INTO xhs_write_event VALUES (?,?,?,'decision','founder',?,?)",
			).run(
				randomUUID(),
				decision.founderMessageId,
				decision.proposalId,
				contentDigest(decision),
				decision.observedAt,
			);
			db.prepare(
				"INSERT INTO xhs_write_notification (event_id,receipt_id,event_kind,proposal_id,expiry,delivery_state) VALUES (?,?,?,?,?,'pending')",
			).run(
				`xhs-${decision.decision}:${decision.receiptId}`,
				decision.receiptId,
				decision.decision,
				decision.proposalId,
				decision.expiresAt,
			);
			return { receiptId: decision.receiptId, existing: false };
		});
	}

	/** Trusted authority lifecycle only, never an ingress operation. */
	setDispatchEnabled(enabled: boolean, now: number): void {
		time.parse(now);
		if (typeof enabled !== "boolean") throw Error("write_gate_invalid");
		this.transaction(() => {
			const changed = this.database
				.prepare(
					"UPDATE authority_metadata SET write_enabled=?,gate_updated_at=? WHERE singleton=1 AND generation=? AND gate_updated_at<=?",
				)
				.run(enabled ? 1 : 0, now, this.generation, now);
			if (changed.changes !== 1) throw Error("write_gate_invalid");
			if (enabled) return;
			this.database
				.prepare(
					"UPDATE xhs_write_attempt SET state='unknown',updated_at=MAX(updated_at,?) WHERE state='claimed'",
				)
				.run(now);
			const pending = this.database
				.prepare(
					"SELECT proposal_id,content_digest FROM xhs_write_proposal WHERE state IN ('preparing','awaiting_delivery','awaiting_approval','approved')",
				)
				.all() as { proposal_id: string; content_digest: string }[];
			for (const row of pending) {
				this.database
					.prepare(
						"UPDATE xhs_write_proposal SET state='revoked' WHERE proposal_id=?",
					)
					.run(row.proposal_id);
				this.database
					.prepare(
						"INSERT INTO xhs_write_event VALUES (?,NULL,?,'revoked','authority',?,?)",
					)
					.run(randomUUID(), row.proposal_id, row.content_digest, now);
				this.database
					.prepare(
						"INSERT OR IGNORE INTO xhs_write_notification(event_id,receipt_id,event_kind,proposal_id,expiry,delivery_state) VALUES (?,(SELECT receipt_id FROM xhs_write_decision WHERE proposal_id=?),'revoked',?,?,'pending')",
					)
					.run(
						`xhs-gate-revoked:${row.proposal_id}`,
						row.proposal_id,
						row.proposal_id,
						now,
					);
			}
		});
	}
	private dispatchEnabled(now: number, requireEnabled = true): boolean {
		const row = this.database
			.prepare(
				"SELECT write_enabled,gate_updated_at,generation FROM authority_metadata WHERE singleton=1",
			)
			.get() as
			| { write_enabled: number; gate_updated_at: number; generation: string }
			| undefined;
		return (
			row !== undefined &&
			(!requireEnabled || row.write_enabled === 1) &&
			row.generation === this.generation &&
			row.gate_updated_at <= now
		);
	}
	admitDispatch(
		permit: unknown,
		identity: WriteIdentity,
		activationId: string,
		keyId: string,
		now: number | (() => number),
	): Frozen | null {
		return this.dispatchCheck(permit, identity, activationId, keyId, now, true);
	}
	dispatchContext(
		permit: unknown,
		identity: WriteIdentity,
		activationId: string,
		keyId: string,
		now: number | (() => number),
	): Frozen | null {
		return this.dispatchCheck(
			permit,
			identity,
			activationId,
			keyId,
			now,
			false,
		);
	}
	private dispatchCheck(
		input: unknown,
		identity: WriteIdentity,
		activationId: string,
		keyId: string,
		now: number | (() => number),
		admit: boolean,
	): Frozen | null {
		const clock = typeof now === "function" ? now : () => now;
		time.parse(clock());
		const parsed = dispatchPermitSchema.safeParse(input);
		if (!parsed.success) return null;
		const p = parsed.data;
		return this.transaction(() => {
			const now = time.parse(clock());
			if (!this.dispatchEnabled(now, admit)) return null;
			if (
				p.issuedAt > now ||
				p.expiresAt <= now ||
				p.keyId !== keyId ||
				p.audience !== identity.providerInstanceId ||
				p.accountUserId !== identity.accountUserId ||
				p.accountEpoch !== identity.accountEpoch ||
				p.providerGeneration !== identity.providerGeneration
			)
				return null;
			const row = this.proposal(p.proposalId);
			if (
				!row ||
				row.state !== "consumed" ||
				!this.matches(row, identity) ||
				row.content_digest !== p.contentDigest ||
				contentDigest(parseStrictJson(row.frozen_json)) !== p.contentDigest ||
				row.expires_at < p.expiresAt
			)
				return null;
			const d = this.database
				.prepare(
					"SELECT * FROM xhs_write_decision WHERE receipt_id=? AND proposal_id=?",
				)
				.get(p.receiptId, p.proposalId) as
				| (DecisionRow & { attempt_id: string | null })
				| undefined;
			if (
				!d ||
				d.decision !== "approved" ||
				d.purpose !== "xiaohongshu_founder_write" ||
				d.content_digest !== p.contentDigest ||
				d.founder_config_version !== identity.founderConfigVersion ||
				d.attempt_id !== p.attemptId ||
				d.consumed_at === null ||
				d.consumed_at > p.issuedAt ||
				d.expires_at < p.expiresAt
			)
				return null;
			const a = this.database
				.prepare(
					"SELECT * FROM xhs_write_attempt WHERE attempt_id=? AND receipt_id=? AND proposal_id=?",
				)
				.get(p.attemptId, p.receiptId, p.proposalId) as
				| {
						state: string;
						activation_id: string;
						project_id: string;
						lead_id: string;
						content_digest: string;
						provider_generation: string;
						account_epoch: number;
						lease_id: string;
						started_at: number;
						updated_at: number;
				  }
				| undefined;
			if (
				!a ||
				a.activation_id !== activationId ||
				a.project_id !== identity.projectId ||
				a.lead_id !== identity.leadId ||
				a.content_digest !== p.contentDigest ||
				a.provider_generation !== p.providerGeneration ||
				a.account_epoch !== p.accountEpoch ||
				a.lease_id !== p.leaseId ||
				a.started_at > p.issuedAt ||
				a.updated_at > now ||
				!(
					admit ? ["claimed", "dispatch-admitted"] : ["dispatch-admitted"]
				).includes(a.state)
			)
				return null;
			const frozen = freezeWrite(parseStrictJson(row.frozen_json), now);
			if (admit && a.state === "claimed") {
				if (
					this.database
						.prepare(
							"UPDATE xhs_write_attempt SET state='dispatch-admitted',updated_at=? WHERE attempt_id=? AND state='claimed'",
						)
						.run(now, p.attemptId).changes !== 1
				)
					throw Error("dispatch_conflict");
			}
			return frozen;
		});
	}
	/** Private read for the coordinator; never project receipt/frozen internals to ingress. */
	executionRecord(
		proposalId: string,
		expectedDigest: string,
		identity: WriteIdentity,
		clock: number | (() => number),
	) {
		id.parse(proposalId);
		digest.parse(expectedDigest);
		return this.transaction(() => {
			const now = typeof clock === "function" ? clock() : clock;
			time.parse(now);
			const row = this.proposal(proposalId);
			if (!row || !this.matches(row, identity))
				throw Error("founder_receipt_invalid");
			const frozen = parseStrictJson(row.frozen_json) as Frozen;
			if (
				row.content_digest !== expectedDigest ||
				contentDigest(frozen) !== expectedDigest
			)
				throw Error("founder_content_digest_mismatch");
			const decision = this.database
				.prepare("SELECT * FROM xhs_write_decision WHERE proposal_id=?")
				.get(proposalId) as DecisionRow | undefined;
			if (
				!decision ||
				decision.decision !== "approved" ||
				decision.purpose !== "xiaohongshu_founder_write" ||
				decision.founder_config_version !== identity.founderConfigVersion ||
				decision.content_digest !== expectedDigest
			)
				throw Error("founder_receipt_invalid");
			const prior = this.database
				.prepare(
					"SELECT * FROM xhs_write_attempt WHERE receipt_id=? AND proposal_id=?",
				)
				.get(decision.receipt_id, proposalId) as AttemptRow | undefined;
			const record = {
				frozen,
				receiptId: decision.receipt_id,
				approvalExpiresAt: Math.min(row.expires_at, decision.expires_at),
				attempt: prior
					? {
							attemptId: prior.attempt_id,
							state: prior.state,
							activationId: prior.activation_id,
						}
					: null,
			};
			if (prior) return record;
			if (!this.dispatchEnabled(now)) throw Error("write_gate_closed");
			if (row.state !== "approved" || decision.consumed_at !== null)
				throw Error("founder_receipt_revoked");
			if (record.approvalExpiresAt <= now || now < decision.observed_at)
				throw Error("founder_receipt_expired");
			return record;
		});
	}
	claim(request: ClaimRequest, clock: number | (() => number)): ClaimResult {
		for (const value of [
			request.proposalId,
			request.receiptId,
			request.activationId,
			request.executeRequestId,
			request.leaseId,
		])
			id.parse(value);
		return this.transaction(() => {
			const now = typeof clock === "function" ? clock() : clock;
			time.parse(now);
			const deny = (code: string): ClaimResult => ({ kind: "denied", code });
			if (!this.dispatchEnabled(now)) return deny("write_gate_closed");
			const row = this.proposal(request.proposalId);
			if (!row || !this.matches(row, request.identity))
				return deny("founder_receipt_invalid");
			if (
				row.content_digest !== request.contentDigest ||
				contentDigest(parseStrictJson(row.frozen_json)) !==
					request.contentDigest
			)
				return deny("founder_content_digest_mismatch");
			const decision = this.database
				.prepare(
					"SELECT * FROM xhs_write_decision WHERE proposal_id=? AND receipt_id=?",
				)
				.get(request.proposalId, request.receiptId) as DecisionRow | undefined;
			if (
				!decision ||
				decision.decision !== "approved" ||
				decision.purpose !== "xiaohongshu_founder_write" ||
				decision.founder_config_version !==
					request.identity.founderConfigVersion ||
				decision.content_digest !== request.contentDigest
			)
				return deny("founder_receipt_invalid");
			const prior = this.database
				.prepare("SELECT * FROM xhs_write_attempt WHERE receipt_id=?")
				.get(request.receiptId) as AttemptRow | undefined;
			if (prior)
				return {
					kind: "existing",
					attemptId: prior.attempt_id,
					state: prior.state,
				};
			if (row.state !== "approved" || decision.consumed_at !== null)
				return deny("founder_receipt_revoked");
			if (
				Math.min(row.expires_at, decision.expires_at) <= now ||
				now < decision.observed_at
			)
				return deny("founder_receipt_expired");
			const attemptId = randomUUID();
			const changed = this.database
				.prepare(
					"UPDATE xhs_write_decision SET consumed_at=?,attempt_id=? WHERE receipt_id=? AND consumed_at IS NULL AND expires_at>?",
				)
				.run(now, attemptId, request.receiptId, now);
			if (changed.changes !== 1) throw Error("claim_conflict");
			if (
				this.database
					.prepare(
						"UPDATE xhs_write_proposal SET state='consumed' WHERE proposal_id=? AND state='approved'",
					)
					.run(request.proposalId).changes !== 1
			)
				throw Error("claim_conflict");
			this.database
				.prepare(`INSERT INTO xhs_write_attempt
    (attempt_id,receipt_id,proposal_id,project_id,lead_id,activation_id,execute_request_id,content_digest,provider_generation,account_epoch,lease_id,state,started_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'claimed',?,?)`)
				.run(
					attemptId,
					request.receiptId,
					request.proposalId,
					request.identity.projectId,
					request.identity.leadId,
					request.activationId,
					request.executeRequestId,
					request.contentDigest,
					this.generation,
					request.identity.accountEpoch,
					request.leaseId,
					now,
					now,
				);
			return { kind: "claimed", attemptId };
		});
	}
	cancel(proposalId: string, identity: WriteIdentity, now: number): string {
		time.parse(now);
		return this.transaction(() => {
			const row = this.proposal(proposalId);
			if (!row || !this.matches(row, identity)) return "denied";
			if (row.state === "consumed") return "already_started";
			if (
				!["awaiting_delivery", "awaiting_approval", "approved"].includes(
					row.state,
				)
			)
				return row.state;
			this.database
				.prepare(
					"UPDATE xhs_write_proposal SET state='revoked' WHERE proposal_id=?",
				)
				.run(proposalId);
			this.database
				.prepare(
					"INSERT INTO xhs_write_event VALUES (?,NULL,?,'revoked','requester',?,?)",
				)
				.run(randomUUID(), proposalId, row.content_digest, now);
			return "revoked";
		});
	}
	finish(
		attemptId: string,
		state: "unknown" | "failed" | "succeeded" | "succeeded-noop",
		now: number,
	): void {
		time.parse(now);
		if (!["unknown", "failed", "succeeded", "succeeded-noop"].includes(state))
			throw Error("invalid_attempt_state");
		this.transaction(() =>
			this.database
				.prepare(
					"UPDATE xhs_write_attempt SET state=?,updated_at=? WHERE attempt_id=? AND state IN ('claimed','dispatch-admitted','dispatched') AND updated_at<=?",
				)
				.run(state, now, attemptId, now),
		);
	}
	registerArtifact(record: ArtifactRecord): void {
		artifactSchema.parse({
			artifactId: record.artifactId,
			sha256: record.sha256,
			sizeBytes: record.sizeBytes,
			mimeType: record.mimeType,
		});
		id.parse(record.projectId);
		id.parse(record.inode);
		time.parse(record.createdAt);
		time.parse(record.retentionUntil);
		if (
			record.privatePath !== record.artifactId ||
			!/^[a-f0-9-]{36}$/.test(record.privatePath)
		)
			throw Error("artifact_unverified");
		this.transaction(() =>
			this.database
				.prepare("INSERT INTO xhs_frozen_artifact VALUES (?,?,?,?,?,?,?,?,?)")
				.run(
					record.artifactId,
					record.projectId,
					record.sha256,
					record.sizeBytes,
					record.mimeType,
					record.privatePath,
					record.inode,
					record.createdAt,
					record.retentionUntil,
				),
		);
	}
	matchingArtifact(
		projectId: string,
		expected: Pick<ArtifactRecord, "sha256" | "sizeBytes" | "mimeType">,
	): ArtifactRecord | null {
		id.parse(projectId);
		const row = this.database
			.prepare(
				"SELECT artifact_id FROM xhs_frozen_artifact WHERE project_id=? AND sha256=? AND size=? AND mime=? ORDER BY created_at,artifact_id LIMIT 1",
			)
			.get(projectId, expected.sha256, expected.sizeBytes, expected.mimeType) as
			| { artifact_id: string }
			| undefined;
		return row ? this.artifact(row.artifact_id, projectId) : null;
	}
	retainArtifact(
		artifactId: string,
		projectId: string,
		retentionUntil: number,
	): void {
		id.parse(artifactId);
		id.parse(projectId);
		time.parse(retentionUntil);
		this.transaction(() => {
			const result = this.database
				.prepare(
					"UPDATE xhs_frozen_artifact SET retention_until=MAX(retention_until,?) WHERE artifact_id=? AND project_id=?",
				)
				.run(retentionUntil, artifactId, projectId);
			if (result.changes !== 1) throw Error("artifact_unverified");
		});
	}
	artifact(artifactId: string, projectId: string): ArtifactRecord | null {
		return (
			(this.database
				.prepare(
					"SELECT artifact_id AS artifactId, project_id AS projectId, sha256, size AS sizeBytes, mime AS mimeType, private_path AS privatePath, inode, created_at AS createdAt, retention_until AS retentionUntil FROM xhs_frozen_artifact WHERE artifact_id=? AND project_id=?",
				)
				.get(artifactId, projectId) as ArtifactRecord | undefined) ?? null
		);
	}

	collectArtifacts(
		now: number,
		remove: (record: ArtifactRecord) => void,
	): number {
		time.parse(now);
		const day = 86400_000;
		const candidates = this.database
			.prepare(
				"SELECT artifact_id,project_id FROM xhs_frozen_artifact WHERE retention_until<=? ORDER BY created_at,artifact_id",
			)
			.all(now) as Array<{ artifact_id: string; project_id: string }>;
		let removed = 0;
		for (const candidate of candidates) {
			if (removed >= 100) break;
			const deleted = this.transaction(() => {
				const artifact = this.artifact(
					candidate.artifact_id,
					candidate.project_id,
				);
				if (!artifact || artifact.retentionUntil > now) return false;
				const refs = this.database
					.prepare(`SELECT p.state,p.expires_at,p.created_at,
                    a.state AS attempt_state,a.updated_at AS attempt_updated,
                    (SELECT MAX(created_at) FROM xhs_write_event WHERE proposal_id=p.proposal_id) AS last_event
                    FROM xhs_write_media_ref r JOIN xhs_write_proposal p ON p.proposal_id=r.proposal_id
                    LEFT JOIN xhs_write_attempt a ON a.proposal_id=p.proposal_id
                    WHERE r.artifact_id=?`)
					.all(artifact.artifactId) as Array<{
					state: string;
					expires_at: number;
					created_at: number;
					attempt_state: string | null;
					attempt_updated: number | null;
					last_event: number | null;
				}>;
				for (const ref of refs) {
					if (
						ref.attempt_state &&
						["claimed", "dispatch-admitted", "dispatched"].includes(
							ref.attempt_state,
						)
					)
						return false;
					if (ref.attempt_state === "unknown") {
						if (
							ref.attempt_updated === null ||
							now < ref.attempt_updated + 30 * day
						)
							return false;
						continue;
					}
					if (ref.state === "consumed" && ref.attempt_state === null)
						return false;
					const pending = [
						"preparing",
						"awaiting_delivery",
						"awaiting_approval",
						"approved",
					].includes(ref.state);
					if (pending && ref.expires_at > now) return false;
					const terminalAt =
						pending || ref.state === "expired"
							? Math.max(ref.expires_at, ref.last_event ?? 0)
							: Math.max(
									ref.created_at,
									ref.last_event ?? 0,
									ref.attempt_updated ?? 0,
								);
					if (now < terminalAt + 7 * day) return false;
				}
				// Remove and fsync files before metadata commits; never delete replay evidence.
				remove(artifact);
				this.database
					.prepare("DELETE FROM xhs_write_media_ref WHERE artifact_id=?")
					.run(artifact.artifactId);
				this.database
					.prepare("DELETE FROM xhs_frozen_artifact WHERE artifact_id=?")
					.run(artifact.artifactId);
				return true;
			});
			if (deleted) removed++;
		}
		return removed;
	}

	approvalRecord(proposalId: string) {
		return (
			(this.database
				.prepare(`SELECT card_id AS cardId, challenge, guild_id AS guildId, channel_id AS channelId,
            created_at AS createdAt,expires_at AS expiresAt,content_digest AS contentDigest,preview_digest AS previewDigest,
            preview_manifest_json AS manifestJson FROM xhs_write_proposal WHERE proposal_id=? AND preview_manifest_json IS NOT NULL`)
				.get(proposalId) as
				| {
						cardId: string;
						challenge: string;
						guildId: string;
						channelId: string;
						createdAt: number;
						expiresAt: number;
						contentDigest: string;
						previewDigest: string;
						manifestJson: string;
				  }
				| undefined) ?? null
		);
	}
	proposalForCard(
		channelId: string,
		cardId: string,
		identity: WriteIdentity,
	): string | null {
		const rows = this.database
			.prepare(`SELECT proposal_id FROM xhs_write_proposal
   WHERE channel_id=? AND card_id=? AND project_id=? AND lead_id=? LIMIT 2`)
			.all(channelId, cardId, identity.projectId, identity.leadId) as {
			proposal_id: string;
		}[];
		if (rows.length !== 1) return null;
		const proposalId = rows[0]!.proposal_id;
		return this.status(proposalId, identity) ? proposalId : null;
	}

	receiptForFounderMessage(messageId: string): string | null {
		return (
			(
				this.database
					.prepare(
						"SELECT receipt_id FROM xhs_write_decision WHERE founder_message_id=?",
					)
					.get(messageId) as { receipt_id: string } | undefined
			)?.receipt_id ?? null
		);
	}
	recordFounderRevocation(
		proposalId: string,
		message: { messageId: string; messageDigest: string; observedAt: number },
		assertAuthority: () => void,
	) {
		return this.transaction(() => {
			assertAuthority();
			const prior = this.database
				.prepare(
					"SELECT proposal_id,evidence_digest FROM xhs_write_event WHERE source_message_id=? AND event_kind='revoked'",
				)
				.get(message.messageId) as
				| { proposal_id: string; evidence_digest: string }
				| undefined;
			if (prior) {
				if (
					prior.proposal_id !== proposalId ||
					prior.evidence_digest !== message.messageDigest
				)
					throw Error("decision_conflict");
				return { existing: true, state: this.proposal(proposalId)?.state };
			}
			const row = this.proposal(proposalId);
			if (!row) throw Error("decision_conflict");
			if (row.state === "consumed")
				return { existing: false, state: "already_started" };
			if (!["awaiting_approval", "approved"].includes(row.state))
				throw Error("decision_conflict");
			this.database
				.prepare(
					"UPDATE xhs_write_proposal SET state='revoked' WHERE proposal_id=?",
				)
				.run(proposalId);
			this.database
				.prepare(
					"INSERT INTO xhs_write_event VALUES (?, ?, ?, 'revoked', 'founder', ?, ?)",
				)
				.run(
					randomUUID(),
					message.messageId,
					proposalId,
					message.messageDigest,
					message.observedAt,
				);
			this.database
				.prepare(`INSERT INTO xhs_write_notification
    (event_id,receipt_id,event_kind,proposal_id,expiry,delivery_state)
    VALUES (?,(SELECT receipt_id FROM xhs_write_decision WHERE proposal_id=?),'revoked',?,?,'pending')`)
				.run(
					`xhs-revoked:${proposalId}`,
					proposalId,
					proposalId,
					row.expires_at,
				);
			return { existing: false, state: "revoked" };
		});
	}

	/** Expiry and its outbox entry commit together; consumed attempts are immutable here. */
	expireProposals(now: number): number {
		time.parse(now);
		return this.transaction(() => {
			const rows = this.database
				.prepare(`SELECT p.proposal_id,p.content_digest,d.receipt_id,
    MIN(p.expires_at,COALESCE(d.expires_at,p.expires_at)) AS expiry
    FROM xhs_write_proposal p LEFT JOIN xhs_write_decision d USING(proposal_id)
    WHERE p.state IN ('preparing','awaiting_delivery','awaiting_approval','approved')
    AND MIN(p.expires_at,COALESCE(d.expires_at,p.expires_at))<=? LIMIT 100`)
				.all(now) as {
				proposal_id: string;
				content_digest: string;
				receipt_id: string | null;
				expiry: number;
			}[];
			for (const row of rows) {
				this.database
					.prepare(
						"UPDATE xhs_write_proposal SET state='expired' WHERE proposal_id=?",
					)
					.run(row.proposal_id);
				this.database
					.prepare(
						"UPDATE xhs_write_notification SET founder_state='suppressed' WHERE proposal_id=? AND founder_state='pending' AND event_kind IN ('approved','delivery_delayed')",
					)
					.run(row.proposal_id);
				this.database
					.prepare(
						"INSERT INTO xhs_write_event VALUES (?,NULL,?,'expired','authority',?,?)",
					)
					.run(randomUUID(), row.proposal_id, row.content_digest, now);
				this.database
					.prepare(
						"INSERT INTO xhs_write_notification (event_id,receipt_id,event_kind,proposal_id,expiry,delivery_state) VALUES (?,?,'expired',?,?,'pending')",
					)
					.run(
						`xhs-expired:${row.proposal_id}`,
						row.receipt_id,
						row.proposal_id,
						row.expiry,
					);
			}
			return rows.length;
		});
	}
	flagDelayedNotifications(now: number): number {
		time.parse(now);
		return this.transaction(
			() =>
				this.database
					.prepare(`INSERT OR IGNORE INTO xhs_write_notification
   (event_id,receipt_id,event_kind,proposal_id,expiry,delivery_state)
   SELECT 'xhs-delivery_delayed:'||d.receipt_id,d.receipt_id,'delivery_delayed',p.proposal_id,d.expires_at,'pending'
   FROM xhs_write_notification n JOIN xhs_write_decision d USING(receipt_id)
   JOIN xhs_write_proposal p ON p.proposal_id=d.proposal_id
   WHERE n.event_kind='approved' AND n.delivery_state='pending' AND p.state='approved'
   AND d.observed_at<=? AND MIN(d.expires_at,p.expires_at)>?`)
					.run(now - 60000, now).changes,
		);
	}
	private notifications(
		audience: "founder" | "bridge",
		scope?: Pick<WriteIdentity, "requesterUid" | "projectId" | "leadId">,
	): WriteNotification[] {
		const filter =
			audience === "founder"
				? "n.founder_state='pending'"
				: "n.delivery_state='pending'";
		return this.database
			.prepare(`SELECT n.event_id AS eventId,n.receipt_id AS receiptId,n.event_kind AS eventKind,
   n.proposal_id AS proposalId,n.expiry,n.attempt_count AS attemptCount,
   p.project_id AS projectId,p.lead_id AS leadId,p.content_digest AS contentDigest
   FROM xhs_write_notification n JOIN xhs_write_proposal p USING(proposal_id)
   WHERE ${filter}
   ${scope ? "AND p.project_id=? AND p.lead_id=? AND json_extract(p.frozen_json,'$.requesterUid')=?" : ""}
   AND (n.event_kind!='approved' OR p.state IN ('approved','consumed'))
   AND (n.event_kind!='delivery_delayed' OR (p.state='approved' AND EXISTS
    (SELECT 1 FROM xhs_write_notification approval WHERE approval.receipt_id=n.receipt_id
     AND approval.event_kind='approved' AND approval.delivery_state='pending')))
   ORDER BY n.rowid LIMIT 100`)
			.all(
				...(scope ? [scope.projectId, scope.leadId, scope.requesterUid] : []),
			) as WriteNotification[];
	}
	pendingFounderNotifications(): WriteNotification[] {
		return this.notifications("founder");
	}
	bridgeNotifications(
		scope: Pick<WriteIdentity, "requesterUid" | "projectId" | "leadId">,
	): WriteNotification[] {
		id.parse(scope.projectId);
		id.parse(scope.leadId);
		time.parse(scope.requesterUid);
		return this.notifications("bridge", scope);
	}
	recordFounderNotificationAttempt(eventId: string, delivered: boolean): void {
		id.parse(eventId);
		z.boolean().parse(delivered);
		this.transaction(() =>
			this.database
				.prepare(
					"UPDATE xhs_write_notification SET attempt_count=attempt_count+1,founder_state=? WHERE event_id=? AND founder_state='pending'",
				)
				.run(delivered ? "delivered" : "pending", eventId),
		);
	}
	ackBridgeNotification(
		eventId: string,
		scope: Pick<WriteIdentity, "requesterUid" | "projectId" | "leadId">,
	): void {
		id.parse(eventId);
		id.parse(scope.projectId);
		id.parse(scope.leadId);
		time.parse(scope.requesterUid);
		this.transaction(() =>
			this.database
				.prepare(
					`UPDATE xhs_write_notification SET delivery_state='delivered' WHERE event_id=?
 AND proposal_id IN (SELECT proposal_id FROM xhs_write_proposal
 WHERE project_id=? AND lead_id=? AND json_extract(frozen_json,'$.requesterUid')=?)`,
				)
				.run(eventId, scope.projectId, scope.leadId, scope.requesterUid),
		);
	}

	observerState(channelId: string, initialCursor: string): ObserverCursor {
		const initial = cursorJson({
			cursor: initialCursor,
			before: null,
			head: null,
			pending: [],
			collecting: true,
		});
		return this.transaction(() => {
			this.database
				.prepare("INSERT OR IGNORE INTO authority_observer_cursor VALUES (?,?)")
				.run(channelId, initial);
			const row = this.database
				.prepare(
					"SELECT state_json FROM authority_observer_cursor WHERE channel_id=?",
				)
				.get(channelId) as { state_json: string };
			const state = parseStrictJson(row.state_json) as ObserverCursor;
			cursorJson(state);
			return state;
		});
	}
	saveObserverState(
		channelId: string,
		expected: ObserverCursor,
		next: ObserverCursor,
	): void {
		this.transaction(() => {
			if (BigInt(next.cursor) < BigInt(expected.cursor))
				throw Error("observer_cursor_conflict");
			const result = this.database
				.prepare(
					"UPDATE authority_observer_cursor SET state_json=? WHERE channel_id=? AND state_json=?",
				)
				.run(cursorJson(next), channelId, cursorJson(expected));
			if (result.changes !== 1) throw Error("observer_cursor_conflict");
		});
	}

	review(
		proposalId: string,
	): { manifestJson: string; cardId: string; previewDigest: string } | null {
		return (
			(this.database
				.prepare(
					"SELECT preview_manifest_json AS manifestJson,card_id AS cardId,preview_digest AS previewDigest FROM xhs_write_proposal WHERE proposal_id=? AND preview_manifest_json IS NOT NULL",
				)
				.get(proposalId) as
				| { manifestJson: string; cardId: string; previewDigest: string }
				| undefined) ?? null
		);
	}

	status(proposalId: string, identity: WriteIdentity) {
		const row = this.proposal(proposalId);
		if (!row || !this.matches(row, identity)) return null;
		const attempt = this.database
			.prepare(
				"SELECT attempt_id,state FROM xhs_write_attempt WHERE proposal_id=?",
			)
			.get(proposalId) as AttemptRow | undefined;
		return {
			proposalId,
			contentDigest: row.content_digest,
			state: row.state,
			expiresAt: row.expires_at,
			attempt: attempt
				? { attemptId: attempt.attempt_id, state: attempt.state }
				: null,
		};
	}
}
