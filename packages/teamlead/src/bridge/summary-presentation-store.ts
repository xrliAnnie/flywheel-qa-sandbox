import { createHash, randomUUID } from "node:crypto";
import type { Database as BetterDb } from "better-sqlite3";

export const SUMMARY_PRESENTATION_CONTRACT_VERSION = 2;

export type SummaryPresentationRoundDisposition =
	| "eligible"
	| "claimed"
	| "historical_presented"
	| "historical_silent"
	| "needs_reconciliation";
export type SummaryPresentationGroupState =
	| "collecting"
	| "ready"
	| "silent"
	| "sending"
	| "sent"
	| "ambiguous";

export interface SummaryPresentationMigration {
	projectName: string;
	leadId: string;
	boundarySeq: number;
	sourceDigests: Record<string, string>;
	cursorSeq: number;
	state: "building" | "complete";
}

export interface SummaryPresentationRound {
	projectName: string;
	leadId: string;
	roundId: string;
	sourceSeq: number;
	slotStartMs: number;
	disposition: SummaryPresentationRoundDisposition;
	sourceDigest: string;
	evidenceRef: string | null;
}

export interface SummaryPresentationJournalRound {
	roundId: string;
	sourceSeq: number;
	slotStartMs: number;
	payload: string;
	sourceDigest: string;
}

export interface SummaryPresentationMember {
	projectName: string;
	leadId: string;
	roundId: string;
	groupId: string;
	sourceSeq: number;
	slotStartMs: number;
	businessState: "pending" | "complete" | "failed";
	outcome: unknown;
	evidenceRef: string | null;
}

export interface SummaryPresentationGroup {
	id: string;
	projectName: string;
	leadId: string;
	groupClaimSeq: number;
	state: SummaryPresentationGroupState;
	decisionReason: string | null;
	frozenText: string | null;
	frozenTextHash: string | null;
	outboundKey: string | null;
	messageId: string | null;
	lastError: string | null;
	diagnosticRef: string | null;
	createdAtMs: number;
	lastProgressAtMs: number;
}

export interface SummaryPresentationStaleSignal {
	kind: "collecting" | "sending" | "ambiguous" | "migration";
	diagnosticRef: string;
	internalRef: string;
}

export type BeginSummaryPresentationResult =
	| { result: "migration_required"; migrationState: "missing" | "building" }
	| { result: "empty" }
	| {
			result: "group";
			group: SummaryPresentationGroup;
			members: SummaryPresentationMember[];
	  };

const digest = (value: string): string =>
	createHash("sha256").update(value).digest("hex");

const canonicalSourceDigests = (value: Record<string, string>): string =>
	JSON.stringify(
		Object.fromEntries(
			Object.entries(value).sort(([left], [right]) =>
				left.localeCompare(right),
			),
		),
	);

function assertIdentity(projectName: string, leadId: string): void {
	if (!projectName.trim() || !leadId.trim()) {
		throw new Error("summary_presentation_invalid_identity");
	}
}

function assertSeq(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`summary_presentation_invalid_${label}`);
	}
}

function assertEvidenceRef(value: string | null | undefined): void {
	if (
		value != null &&
		(!/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,511}$/.test(value) ||
			value.includes(".."))
	) {
		throw new Error("summary_presentation_invalid_evidence_ref");
	}
}

function parseJsonObject(
	value: string,
	errorCode: string,
): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error(errorCode);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(errorCode);
	}
	return parsed as Record<string, unknown>;
}

function mapGroup(row: Record<string, unknown>): SummaryPresentationGroup {
	return {
		id: String(row.id),
		projectName: String(row.project_name),
		leadId: String(row.lead_id),
		groupClaimSeq: Number(row.group_claim_seq),
		state: row.state as SummaryPresentationGroupState,
		decisionReason: (row.decision_reason as string | null) ?? null,
		frozenText: (row.frozen_text as string | null) ?? null,
		frozenTextHash: (row.frozen_text_hash as string | null) ?? null,
		outboundKey: (row.outbound_key as string | null) ?? null,
		messageId: (row.message_id as string | null) ?? null,
		lastError: (row.last_error as string | null) ?? null,
		diagnosticRef: (row.diagnostic_ref as string | null) ?? null,
		createdAtMs: Number(row.created_at_ms),
		lastProgressAtMs: Number(row.last_progress_at_ms),
	};
}

function mapMember(row: Record<string, unknown>): SummaryPresentationMember {
	return {
		projectName: String(row.project_name),
		leadId: String(row.lead_id),
		roundId: String(row.round_id),
		groupId: String(row.group_id),
		sourceSeq: Number(row.source_seq),
		slotStartMs: Number(row.slot_start_ms),
		businessState:
			row.business_state as SummaryPresentationMember["businessState"],
		outcome:
			typeof row.outcome_json === "string"
				? JSON.parse(row.outcome_json)
				: null,
		evidenceRef: (row.evidence_ref as string | null) ?? null,
	};
}

function mapRound(row: Record<string, unknown>): SummaryPresentationRound {
	return {
		projectName: String(row.project_name),
		leadId: String(row.lead_id),
		roundId: String(row.round_id),
		sourceSeq: Number(row.source_seq),
		slotStartMs: Number(row.slot_start_ms),
		disposition: row.disposition as SummaryPresentationRoundDisposition,
		sourceDigest: String(row.source_digest),
		evidenceRef: (row.evidence_ref as string | null) ?? null,
	};
}

export class SummaryPresentationStore {
	constructor(private readonly db: BetterDb) {}

	migrate(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS summary_presentation_migration (
				project_name TEXT NOT NULL,
				lead_id TEXT NOT NULL,
				contract_version INTEGER NOT NULL CHECK(contract_version = 2),
				migration_boundary_seq INTEGER NOT NULL CHECK(migration_boundary_seq >= 0),
				source_digests_json TEXT NOT NULL,
				cursor_seq INTEGER NOT NULL DEFAULT 0 CHECK(cursor_seq >= 0),
				state TEXT NOT NULL CHECK(state IN ('building','complete')),
				stale_alerted_at_ms INTEGER,
				created_at_ms INTEGER NOT NULL,
				updated_at_ms INTEGER NOT NULL,
				PRIMARY KEY(project_name, lead_id, contract_version)
			);
			CREATE TABLE IF NOT EXISTS summary_presentation_rounds (
				project_name TEXT NOT NULL,
				lead_id TEXT NOT NULL,
				round_id TEXT NOT NULL,
				source_seq INTEGER NOT NULL UNIQUE,
				slot_start_ms INTEGER NOT NULL CHECK(slot_start_ms >= 0),
				disposition TEXT NOT NULL CHECK(disposition IN
					('eligible','claimed','historical_presented','historical_silent','needs_reconciliation')),
				source_digest TEXT NOT NULL,
				evidence_ref TEXT,
				created_at_ms INTEGER NOT NULL,
				updated_at_ms INTEGER NOT NULL,
				PRIMARY KEY(project_name, lead_id, round_id)
			);
			CREATE INDEX IF NOT EXISTS idx_summary_presentation_rounds_eligible
				ON summary_presentation_rounds(project_name, lead_id, disposition, source_seq);
			CREATE TABLE IF NOT EXISTS summary_presentation_groups (
				id TEXT PRIMARY KEY,
				project_name TEXT NOT NULL,
				lead_id TEXT NOT NULL,
				contract_version INTEGER NOT NULL CHECK(contract_version = 2),
				group_claim_seq INTEGER NOT NULL CHECK(group_claim_seq > 0),
				state TEXT NOT NULL CHECK(state IN ('collecting','ready','silent','sending','sent','ambiguous')),
				decision_reason TEXT,
				frozen_text TEXT,
				frozen_text_hash TEXT,
				outbound_key TEXT UNIQUE,
				message_id TEXT,
				last_error TEXT,
				diagnostic_ref TEXT,
				stale_alerted_at_ms INTEGER,
				created_at_ms INTEGER NOT NULL,
				last_progress_at_ms INTEGER NOT NULL
			);
			CREATE UNIQUE INDEX IF NOT EXISTS idx_summary_presentation_one_active
				ON summary_presentation_groups(project_name, lead_id)
				WHERE state IN ('collecting','ready','sending');
			CREATE TABLE IF NOT EXISTS summary_presentation_members (
				project_name TEXT NOT NULL,
				lead_id TEXT NOT NULL,
				round_id TEXT NOT NULL,
				group_id TEXT NOT NULL REFERENCES summary_presentation_groups(id),
				source_seq INTEGER NOT NULL,
				slot_start_ms INTEGER NOT NULL,
				business_state TEXT NOT NULL DEFAULT 'pending'
					CHECK(business_state IN ('pending','complete','failed')),
				outcome_json TEXT,
				evidence_ref TEXT,
				updated_at_ms INTEGER NOT NULL,
				PRIMARY KEY(project_name, lead_id, round_id),
				UNIQUE(group_id, round_id)
			);
			CREATE INDEX IF NOT EXISTS idx_summary_presentation_members_group
				ON summary_presentation_members(group_id, slot_start_ms, source_seq);
		`);
		this.ensureColumn(
			"summary_presentation_migration",
			"stale_alerted_at_ms",
			"INTEGER",
		);
		this.ensureColumn(
			"summary_presentation_groups",
			"stale_alerted_at_ms",
			"INTEGER",
		);
	}

	beginMigration(input: {
		projectName: string;
		leadId: string;
		boundarySeq: number;
		sourceDigests: Record<string, string>;
		nowMs?: number;
	}): SummaryPresentationMigration {
		assertIdentity(input.projectName, input.leadId);
		assertSeq(input.boundarySeq, "boundary_seq");
		const nowMs = input.nowMs ?? Date.now();
		const digests = canonicalSourceDigests(input.sourceDigests);
		const existing = this.getMigration(input.projectName, input.leadId);
		if (existing) {
			if (existing.boundarySeq !== input.boundarySeq) {
				throw new Error("summary_presentation_migration_identity_conflict");
			}
			if (canonicalSourceDigests(existing.sourceDigests) !== digests) {
				if (existing.state === "complete") {
					throw new Error("summary_presentation_migration_sources_changed");
				}
				this.db.transaction(() => {
					this.db
						.prepare(
							`DELETE FROM summary_presentation_rounds
							 WHERE project_name = ? AND lead_id = ? AND source_seq <= ?
							   AND disposition IN ('eligible','needs_reconciliation')`,
						)
						.run(input.projectName, input.leadId, input.boundarySeq);
					this.db
						.prepare(
							`UPDATE summary_presentation_migration
							 SET source_digests_json = ?, cursor_seq = 0, updated_at_ms = ?
							 WHERE project_name = ? AND lead_id = ? AND contract_version = 2
							   AND state = 'building'`,
						)
						.run(digests, nowMs, input.projectName, input.leadId);
				})();
				return this.getMigration(input.projectName, input.leadId)!;
			}
			return existing;
		}
		this.db
			.prepare(
				`INSERT INTO summary_presentation_migration
				 (project_name, lead_id, contract_version, migration_boundary_seq,
				  source_digests_json, cursor_seq, state, created_at_ms, updated_at_ms)
				 VALUES (?, ?, 2, ?, ?, 0, 'building', ?, ?)`,
			)
			.run(
				input.projectName,
				input.leadId,
				input.boundarySeq,
				digests,
				nowMs,
				nowMs,
			);
		return this.getMigration(input.projectName, input.leadId)!;
	}

	getMigration(
		projectName: string,
		leadId: string,
	): SummaryPresentationMigration | null {
		const row = this.db
			.prepare(
				`SELECT * FROM summary_presentation_migration
				 WHERE project_name = ? AND lead_id = ? AND contract_version = 2`,
			)
			.get(projectName, leadId) as Record<string, unknown> | undefined;
		return row
			? {
					projectName: String(row.project_name),
					leadId: String(row.lead_id),
					boundarySeq: Number(row.migration_boundary_seq),
					sourceDigests: parseJsonObject(
						String(row.source_digests_json),
						"summary_presentation_invalid_migration_digests",
					) as Record<string, string>,
					cursorSeq: Number(row.cursor_seq),
					state: row.state as "building" | "complete",
				}
			: null;
	}

	classifyHistoricalRound(input: {
		projectName: string;
		leadId: string;
		roundId: string;
		sourceSeq: number;
		slotStartMs: number;
		disposition: Exclude<SummaryPresentationRoundDisposition, "claimed">;
		sourceDigest: string;
		evidenceRef?: string | null;
		nowMs?: number;
	}): SummaryPresentationRound {
		const migration = this.getMigration(input.projectName, input.leadId);
		if (!migration || migration.state !== "building") {
			throw new Error("summary_presentation_migration_not_building");
		}
		if (input.sourceSeq > migration.boundarySeq) {
			throw new Error("summary_presentation_historical_seq_out_of_range");
		}
		assertEvidenceRef(input.evidenceRef);
		this.assertJournalRound(input);
		const nowMs = input.nowMs ?? Date.now();
		this.db.transaction(() => {
			const existing = this.getRound(
				input.projectName,
				input.leadId,
				input.roundId,
			);
			if (existing) {
				if (
					existing.sourceSeq !== input.sourceSeq ||
					existing.disposition !== input.disposition ||
					existing.sourceDigest !== input.sourceDigest ||
					existing.evidenceRef !== (input.evidenceRef ?? null)
				) {
					throw new Error("summary_presentation_round_classification_conflict");
				}
			} else {
				this.db
					.prepare(
						`INSERT INTO summary_presentation_rounds
						 (project_name, lead_id, round_id, source_seq, slot_start_ms,
						  disposition, source_digest, evidence_ref, created_at_ms, updated_at_ms)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						input.projectName,
						input.leadId,
						input.roundId,
						input.sourceSeq,
						input.slotStartMs,
						input.disposition,
						input.sourceDigest,
						input.evidenceRef ?? null,
						nowMs,
						nowMs,
					);
			}
			this.db
				.prepare(
					`UPDATE summary_presentation_migration
					 SET cursor_seq = MAX(cursor_seq, ?), updated_at_ms = ?
					 WHERE project_name = ? AND lead_id = ? AND contract_version = 2`,
				)
				.run(input.sourceSeq, nowMs, input.projectName, input.leadId);
		})();
		return this.getRound(input.projectName, input.leadId, input.roundId)!;
	}

	completeMigration(input: {
		projectName: string;
		leadId: string;
		sourceDigests: Record<string, string>;
		nowMs?: number;
	}): SummaryPresentationMigration {
		const migration = this.getMigration(input.projectName, input.leadId);
		if (!migration) throw new Error("summary_presentation_migration_missing");
		if (
			canonicalSourceDigests(migration.sourceDigests) !==
			canonicalSourceDigests(input.sourceDigests)
		) {
			throw new Error("summary_presentation_migration_sources_changed");
		}
		const journal = this.db
			.prepare(
				`SELECT seq, event_id, payload FROM lead_events
				 WHERE lead_id = ? AND event_type = 'summary_absorption_round' AND seq <= ?
				 ORDER BY seq`,
			)
			.all(input.leadId, migration.boundarySeq) as Array<{
			seq: number;
			event_id: string;
			payload: string;
		}>;
		for (const row of journal) {
			const payload = parseJsonObject(
				row.payload,
				"summary_presentation_invalid_journal_payload",
			);
			if (payload.project_name !== input.projectName) continue;
			const classified = this.getRound(
				input.projectName,
				input.leadId,
				row.event_id,
			);
			if (!classified || classified.sourceSeq !== row.seq) {
				throw new Error(`summary_presentation_migration_gap:${row.seq}`);
			}
			if (classified.sourceDigest !== digest(row.payload)) {
				throw new Error(
					`summary_presentation_migration_digest_mismatch:${row.seq}`,
				);
			}
		}
		const nowMs = input.nowMs ?? Date.now();
		this.db
			.prepare(
				`UPDATE summary_presentation_migration
				 SET state = 'complete', cursor_seq = migration_boundary_seq, updated_at_ms = ?
				 WHERE project_name = ? AND lead_id = ? AND contract_version = 2`,
			)
			.run(nowMs, input.projectName, input.leadId);
		return this.getMigration(input.projectName, input.leadId)!;
	}

	listMigrationJournalRounds(
		projectName: string,
		leadId: string,
		options: { throughSeq?: number } = {},
	): SummaryPresentationJournalRound[] {
		assertIdentity(projectName, leadId);
		const throughSeq = options.throughSeq ?? Number.MAX_SAFE_INTEGER;
		assertSeq(throughSeq, "boundary_seq");
		const rows = this.db
			.prepare(
				`SELECT seq, event_id, payload FROM lead_events
				 WHERE lead_id = ? AND event_type = 'summary_absorption_round' AND seq <= ?
				 ORDER BY seq`,
			)
			.all(leadId, throughSeq) as Array<{
			seq: number;
			event_id: string;
			payload: string;
		}>;
		const result: SummaryPresentationJournalRound[] = [];
		for (const row of rows) {
			const payload = parseJsonObject(
				row.payload,
				"summary_presentation_invalid_journal_payload",
			);
			if (payload.project_name !== projectName) continue;
			if (payload.execution_id !== row.event_id) {
				throw new Error("summary_presentation_journal_identity_mismatch");
			}
			const parsedSlot = row.event_id.startsWith("summary-absorption:")
				? Date.parse(row.event_id.slice("summary-absorption:".length))
				: Number.NaN;
			const slotStartMs =
				typeof payload.slot_start_ms === "number" &&
				Number.isSafeInteger(payload.slot_start_ms) &&
				payload.slot_start_ms >= 0
					? payload.slot_start_ms
					: parsedSlot;
			if (!Number.isSafeInteger(slotStartMs) || slotStartMs < 0) {
				throw new Error("summary_presentation_invalid_slot_start_ms");
			}
			result.push({
				roundId: row.event_id,
				sourceSeq: row.seq,
				slotStartMs,
				payload: row.payload,
				sourceDigest: digest(row.payload),
			});
		}
		return result;
	}

	admitRound(input: {
		projectName: string;
		leadId: string;
		roundId: string;
		sourceSeq: number;
		slotStartMs: number;
		sourceDigest: string;
		nowMs?: number;
	}): SummaryPresentationRound {
		this.assertJournalRound(input);
		const journal = this.db
			.prepare("SELECT payload FROM lead_events WHERE seq = ?")
			.get(input.sourceSeq) as { payload: string };
		const payload = parseJsonObject(
			journal.payload,
			"summary_presentation_invalid_journal_payload",
		);
		if (payload.contract_version !== SUMMARY_PRESENTATION_CONTRACT_VERSION) {
			throw new Error("summary_presentation_round_contract_not_v2");
		}
		const nowMs = input.nowMs ?? Date.now();
		this.db
			.prepare(
				`INSERT INTO summary_presentation_rounds
				 (project_name, lead_id, round_id, source_seq, slot_start_ms,
				  disposition, source_digest, evidence_ref, created_at_ms, updated_at_ms)
				 VALUES (?, ?, ?, ?, ?, 'eligible', ?, NULL, ?, ?)
				 ON CONFLICT(project_name, lead_id, round_id) DO NOTHING`,
			)
			.run(
				input.projectName,
				input.leadId,
				input.roundId,
				input.sourceSeq,
				input.slotStartMs,
				input.sourceDigest,
				nowMs,
				nowMs,
			);
		const round = this.getRound(
			input.projectName,
			input.leadId,
			input.roundId,
		)!;
		if (
			round.sourceSeq !== input.sourceSeq ||
			round.sourceDigest !== input.sourceDigest
		) {
			throw new Error("summary_presentation_round_identity_conflict");
		}
		return round;
	}

	begin(
		projectName: string,
		leadId: string,
		nowMs = Date.now(),
	): BeginSummaryPresentationResult {
		assertIdentity(projectName, leadId);
		const migration = this.getMigration(projectName, leadId);
		if (!migration || migration.state !== "complete") {
			return {
				result: "migration_required",
				migrationState: migration ? "building" : "missing",
			};
		}
		return this.db.transaction(() => {
			const active = this.db
				.prepare(
					`SELECT * FROM summary_presentation_groups
					 WHERE project_name = ? AND lead_id = ?
					   AND state IN ('collecting','ready','sending') LIMIT 1`,
				)
				.get(projectName, leadId) as Record<string, unknown> | undefined;
			if (active) return this.groupResult(mapGroup(active));

			const eligible = this.db
				.prepare(
					`SELECT r.*, e.event_type, e.lead_id AS journal_lead_id, e.payload
					 FROM summary_presentation_rounds r
					 JOIN lead_events e ON e.seq = r.source_seq
					 WHERE r.project_name = ? AND r.lead_id = ?
					   AND r.disposition = 'eligible'
					 ORDER BY r.source_seq`,
				)
				.all(projectName, leadId) as Record<string, unknown>[];
			if (eligible.length === 0) return { result: "empty" as const };
			const groupClaimSeq = Math.max(
				...eligible.map((row) => Number(row.source_seq)),
			);
			const valid: SummaryPresentationRound[] = [];
			for (const row of eligible) {
				let matches =
					row.event_type === "summary_absorption_round" &&
					row.journal_lead_id === leadId;
				try {
					const payload = parseJsonObject(
						String(row.payload),
						"summary_presentation_invalid_journal_payload",
					);
					matches =
						matches &&
						payload.project_name === projectName &&
						payload.execution_id === row.round_id;
				} catch {
					matches = false;
				}
				if (!matches) {
					this.db
						.prepare(
							`UPDATE summary_presentation_rounds
							 SET disposition = 'needs_reconciliation', updated_at_ms = ?
							 WHERE source_seq = ? AND disposition = 'eligible'`,
						)
						.run(nowMs, row.source_seq);
					continue;
				}
				valid.push(mapRound(row));
			}
			if (valid.length === 0) return { result: "empty" as const };
			valid.sort(
				(left, right) =>
					left.slotStartMs - right.slotStartMs ||
					left.sourceSeq - right.sourceSeq,
			);
			const groupId = randomUUID();
			this.db
				.prepare(
					`INSERT INTO summary_presentation_groups
					 (id, project_name, lead_id, contract_version, group_claim_seq,
					  state, created_at_ms, last_progress_at_ms)
					 VALUES (?, ?, ?, 2, ?, 'collecting', ?, ?)`,
				)
				.run(groupId, projectName, leadId, groupClaimSeq, nowMs, nowMs);
			const insertMember = this.db.prepare(
				`INSERT INTO summary_presentation_members
				 (project_name, lead_id, round_id, group_id, source_seq, slot_start_ms,
				  business_state, updated_at_ms)
				 VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
			);
			const claimRound = this.db.prepare(
				`UPDATE summary_presentation_rounds
				 SET disposition = 'claimed', updated_at_ms = ?
				 WHERE project_name = ? AND lead_id = ? AND round_id = ?
				   AND disposition = 'eligible'`,
			);
			for (const round of valid) {
				insertMember.run(
					projectName,
					leadId,
					round.roundId,
					groupId,
					round.sourceSeq,
					round.slotStartMs,
					nowMs,
				);
				claimRound.run(nowMs, projectName, leadId, round.roundId);
			}
			return this.groupResult(this.getGroup(groupId)!);
		})();
	}

	record(input: {
		projectName: string;
		leadId: string;
		groupId: string;
		roundId: string;
		businessState: "complete" | "failed";
		outcome: unknown;
		evidenceRef: string;
		nowMs?: number;
	}): SummaryPresentationMember {
		assertEvidenceRef(input.evidenceRef);
		const outcomeJson = JSON.stringify(input.outcome);
		if (outcomeJson === undefined || outcomeJson.length > 32_000) {
			throw new Error("summary_presentation_invalid_outcome");
		}
		const nowMs = input.nowMs ?? Date.now();
		this.db.transaction(() => {
			const group = this.getGroup(input.groupId);
			if (
				!group ||
				group.projectName !== input.projectName ||
				group.leadId !== input.leadId ||
				group.state !== "collecting"
			) {
				throw new Error("summary_presentation_group_not_collecting");
			}
			const current = this.getMember(input.groupId, input.roundId);
			if (!current) throw new Error("summary_presentation_member_not_found");
			if (current.businessState !== "pending") {
				if (
					current.businessState !== input.businessState ||
					JSON.stringify(current.outcome) !== outcomeJson ||
					current.evidenceRef !== input.evidenceRef
				) {
					throw new Error("summary_presentation_member_record_conflict");
				}
				return;
			}
			this.db
				.prepare(
					`UPDATE summary_presentation_members
					 SET business_state = ?, outcome_json = ?, evidence_ref = ?, updated_at_ms = ?
					 WHERE group_id = ? AND round_id = ? AND business_state = 'pending'`,
				)
				.run(
					input.businessState,
					outcomeJson,
					input.evidenceRef,
					nowMs,
					input.groupId,
					input.roundId,
				);
			this.db
				.prepare(
					"UPDATE summary_presentation_groups SET last_progress_at_ms = ? WHERE id = ?",
				)
				.run(nowMs, input.groupId);
		})();
		return this.getMember(input.groupId, input.roundId)!;
	}

	prepareFinalize(input: {
		projectName: string;
		leadId: string;
		groupId: string;
		decision: "silent" | "substantive";
		reason: string;
		text?: string;
		nowMs?: number;
	}):
		| { result: "incomplete"; group: SummaryPresentationGroup }
		| { result: "silent"; group: SummaryPresentationGroup }
		| { result: "ready"; group: SummaryPresentationGroup } {
		const reason = input.reason.trim();
		if (!reason || reason.length > 1_000) {
			throw new Error("summary_presentation_invalid_decision_reason");
		}
		const text = input.text?.trim() ?? "";
		if (input.decision === "substantive" && (!text || text.length > 1_800)) {
			throw new Error("summary_presentation_invalid_text");
		}
		if (input.decision === "silent" && text) {
			throw new Error("summary_presentation_silent_has_text");
		}
		const nowMs = input.nowMs ?? Date.now();
		return this.db.transaction(() => {
			const group = this.getGroup(input.groupId);
			if (
				!group ||
				group.projectName !== input.projectName ||
				group.leadId !== input.leadId
			) {
				throw new Error("summary_presentation_group_not_found");
			}
			const expectedState = input.decision === "silent" ? "silent" : "ready";
			if (group.state !== "collecting") {
				if (
					group.state === expectedState ||
					(input.decision === "substantive" &&
						["sending", "sent", "ambiguous"].includes(group.state))
				) {
					if (
						group.decisionReason !== reason ||
						group.frozenText !==
							(input.decision === "substantive" ? text : null)
					) {
						throw new Error("summary_presentation_finalize_conflict");
					}
					return {
						result: input.decision === "silent" ? "silent" : "ready",
						group,
					} as const;
				}
				throw new Error("summary_presentation_group_not_finalizable");
			}
			const pending = this.db
				.prepare(
					"SELECT COUNT(*) AS count FROM summary_presentation_members WHERE group_id = ? AND business_state = 'pending'",
				)
				.get(input.groupId) as { count: number };
			if (pending.count > 0) return { result: "incomplete", group } as const;
			const hash = input.decision === "substantive" ? digest(text) : null;
			const outboundKey =
				input.decision === "substantive"
					? `summary-presentation:${input.groupId}`
					: null;
			this.db
				.prepare(
					`UPDATE summary_presentation_groups
					 SET state = ?, decision_reason = ?, frozen_text = ?, frozen_text_hash = ?,
					     outbound_key = ?, last_progress_at_ms = ?
					 WHERE id = ? AND state = 'collecting'`,
				)
				.run(
					expectedState,
					reason,
					input.decision === "substantive" ? text : null,
					hash,
					outboundKey,
					nowMs,
					input.groupId,
				);
			const updated = this.getGroup(input.groupId)!;
			return {
				result: input.decision === "silent" ? "silent" : "ready",
				group: updated,
			} as const;
		})();
	}

	markSending(groupId: string, nowMs = Date.now()): SummaryPresentationGroup {
		this.db
			.prepare(
				`UPDATE summary_presentation_groups SET state = 'sending', last_progress_at_ms = ?
				 WHERE id = ? AND state = 'ready'`,
			)
			.run(nowMs, groupId);
		const group = this.getGroup(groupId);
		if (!group || group.state !== "sending") {
			throw new Error("summary_presentation_group_not_sending");
		}
		return group;
	}

	markSent(
		groupId: string,
		messageId: string,
		nowMs = Date.now(),
	): SummaryPresentationGroup {
		if (!/^[1-9][0-9]{0,24}$/.test(messageId)) {
			throw new Error("summary_presentation_invalid_message_id");
		}
		this.db
			.prepare(
				`UPDATE summary_presentation_groups
				 SET state = 'sent', message_id = ?, last_error = NULL, last_progress_at_ms = ?
				 WHERE id = ? AND state = 'sending'`,
			)
			.run(messageId, nowMs, groupId);
		const group = this.getGroup(groupId);
		if (!group || group.state !== "sent") {
			throw new Error("summary_presentation_send_state_conflict");
		}
		return group;
	}

	markAmbiguous(
		groupId: string,
		input: { error: string; diagnosticRef: string; nowMs?: number },
	): SummaryPresentationGroup {
		assertEvidenceRef(input.diagnosticRef);
		const error = input.error.trim();
		if (!error || error.length > 2_000) {
			throw new Error("summary_presentation_invalid_send_error");
		}
		this.db
			.prepare(
				`UPDATE summary_presentation_groups
				 SET state = 'ambiguous', last_error = ?, diagnostic_ref = ?, last_progress_at_ms = ?
				 WHERE id = ? AND state = 'sending'`,
			)
			.run(error, input.diagnosticRef, input.nowMs ?? Date.now(), groupId);
		const group = this.getGroup(groupId);
		if (!group || group.state !== "ambiguous") {
			throw new Error("summary_presentation_send_state_conflict");
		}
		return group;
	}

	reconcileAmbiguous(input: {
		groupId: string;
		messageId: string;
		operator: string;
		reason: string;
		evidenceRef: string;
		nowMs?: number;
	}): SummaryPresentationGroup {
		assertEvidenceRef(input.evidenceRef);
		if (!input.operator.trim() || !input.reason.trim()) {
			throw new Error("summary_presentation_invalid_reconciliation");
		}
		if (!/^[1-9][0-9]{0,24}$/.test(input.messageId)) {
			throw new Error("summary_presentation_invalid_message_id");
		}
		const audit = JSON.stringify({
			operator: input.operator,
			reason: input.reason,
			evidenceRef: input.evidenceRef,
			reconciledAtMs: input.nowMs ?? Date.now(),
		});
		this.db
			.prepare(
				`UPDATE summary_presentation_groups
				 SET state = 'sent', message_id = ?, last_error = ?, last_progress_at_ms = ?
				 WHERE id = ? AND state = 'ambiguous'`,
			)
			.run(input.messageId, audit, input.nowMs ?? Date.now(), input.groupId);
		const group = this.getGroup(input.groupId);
		if (!group || group.state !== "sent") {
			throw new Error("summary_presentation_reconciliation_state_conflict");
		}
		return group;
	}

	claimStaleSignals(input: {
		projectName: string;
		leadId: string;
		nowMs?: number;
		cadenceMs: number;
	}): SummaryPresentationStaleSignal[] {
		assertIdentity(input.projectName, input.leadId);
		if (!Number.isSafeInteger(input.cadenceMs) || input.cadenceMs <= 0) {
			throw new Error("summary_presentation_invalid_cadence");
		}
		const nowMs = input.nowMs ?? Date.now();
		const staleBeforeMs = nowMs - input.cadenceMs * 2;
		return this.db.transaction(() => {
			const signals: SummaryPresentationStaleSignal[] = [];
			const groups = this.db
				.prepare(
					`SELECT id, state FROM summary_presentation_groups
					 WHERE project_name = ? AND lead_id = ?
					   AND state IN ('collecting','sending','ambiguous')
					   AND last_progress_at_ms <= ? AND stale_alerted_at_ms IS NULL
					 ORDER BY created_at_ms`,
				)
				.all(input.projectName, input.leadId, staleBeforeMs) as Array<{
				id: string;
				state: "collecting" | "sending" | "ambiguous";
			}>;
			for (const group of groups) {
				const claimed = this.db
					.prepare(
						`UPDATE summary_presentation_groups SET stale_alerted_at_ms = ?
						 WHERE id = ? AND stale_alerted_at_ms IS NULL`,
					)
					.run(nowMs, group.id);
				if (claimed.changes !== 1) continue;
				signals.push({
					kind: group.state,
					diagnosticRef: `summary-stale:${digest(`${input.projectName}:${input.leadId}:group:${group.id}`).slice(0, 20)}`,
					internalRef: `group:${group.id}`,
				});
			}
			const migration = this.db
				.prepare(
					`SELECT updated_at_ms FROM summary_presentation_migration
					 WHERE project_name = ? AND lead_id = ? AND contract_version = 2
					   AND state = 'building' AND updated_at_ms <= ?
					   AND stale_alerted_at_ms IS NULL`,
				)
				.get(input.projectName, input.leadId, staleBeforeMs) as
				| { updated_at_ms: number }
				| undefined;
			if (migration) {
				const claimed = this.db
					.prepare(
						`UPDATE summary_presentation_migration SET stale_alerted_at_ms = ?
						 WHERE project_name = ? AND lead_id = ? AND contract_version = 2
						   AND state = 'building' AND stale_alerted_at_ms IS NULL`,
					)
					.run(nowMs, input.projectName, input.leadId);
				if (claimed.changes === 1) {
					signals.push({
						kind: "migration",
						diagnosticRef: `summary-stale:${digest(`${input.projectName}:${input.leadId}:migration:v2`).slice(0, 20)}`,
						internalRef: "migration:v2",
					});
				}
			}
			return signals;
		})();
	}

	supportRecordMember(input: {
		projectName: string;
		leadId: string;
		groupId: string;
		roundId: string;
		operator: string;
		reason: string;
		evidenceRef: string;
		nowMs?: number;
	}): SummaryPresentationMember {
		if (!input.operator.trim() || !input.reason.trim()) {
			throw new Error("summary_presentation_invalid_support_record");
		}
		return this.record({
			projectName: input.projectName,
			leadId: input.leadId,
			groupId: input.groupId,
			roundId: input.roundId,
			businessState: "failed",
			outcome: {
				supportDisposition: "failed",
				operator: input.operator,
				reason: input.reason,
				recordedAtMs: input.nowMs ?? Date.now(),
			},
			evidenceRef: input.evidenceRef,
			nowMs: input.nowMs,
		});
	}

	getRound(
		projectName: string,
		leadId: string,
		roundId: string,
	): SummaryPresentationRound | null {
		const row = this.db
			.prepare(
				`SELECT * FROM summary_presentation_rounds
				 WHERE project_name = ? AND lead_id = ? AND round_id = ?`,
			)
			.get(projectName, leadId, roundId) as Record<string, unknown> | undefined;
		return row ? mapRound(row) : null;
	}

	getGroup(groupId: string): SummaryPresentationGroup | null {
		const row = this.db
			.prepare("SELECT * FROM summary_presentation_groups WHERE id = ?")
			.get(groupId) as Record<string, unknown> | undefined;
		return row ? mapGroup(row) : null;
	}

	listMembers(groupId: string): SummaryPresentationMember[] {
		return (
			this.db
				.prepare(
					`SELECT * FROM summary_presentation_members WHERE group_id = ?
					 ORDER BY slot_start_ms, source_seq`,
				)
				.all(groupId) as Record<string, unknown>[]
		).map(mapMember);
	}

	private getMember(
		groupId: string,
		roundId: string,
	): SummaryPresentationMember | null {
		const row = this.db
			.prepare(
				"SELECT * FROM summary_presentation_members WHERE group_id = ? AND round_id = ?",
			)
			.get(groupId, roundId) as Record<string, unknown> | undefined;
		return row ? mapMember(row) : null;
	}

	private groupResult(
		group: SummaryPresentationGroup,
	): Extract<BeginSummaryPresentationResult, { result: "group" }> {
		return { result: "group", group, members: this.listMembers(group.id) };
	}

	private assertJournalRound(input: {
		projectName: string;
		leadId: string;
		roundId: string;
		sourceSeq: number;
		slotStartMs: number;
		sourceDigest: string;
	}): void {
		assertIdentity(input.projectName, input.leadId);
		assertSeq(input.sourceSeq, "source_seq");
		assertSeq(input.slotStartMs, "slot_start_ms");
		const row = this.db
			.prepare(
				"SELECT lead_id, event_id, event_type, payload FROM lead_events WHERE seq = ?",
			)
			.get(input.sourceSeq) as
			| {
					lead_id: string;
					event_id: string;
					event_type: string;
					payload: string;
			  }
			| undefined;
		if (
			!row ||
			row.lead_id !== input.leadId ||
			row.event_id !== input.roundId ||
			row.event_type !== "summary_absorption_round" ||
			digest(row.payload) !== input.sourceDigest
		) {
			throw new Error("summary_presentation_journal_identity_mismatch");
		}
		const payload = parseJsonObject(
			row.payload,
			"summary_presentation_invalid_journal_payload",
		);
		if (
			payload.project_name !== input.projectName ||
			payload.execution_id !== input.roundId
		) {
			throw new Error("summary_presentation_journal_identity_mismatch");
		}
	}

	private ensureColumn(
		table: string,
		column: string,
		definition: string,
	): void {
		const columns = this.db
			.prepare(`PRAGMA table_info(${table})`)
			.all() as Array<{
			name: string;
		}>;
		if (!columns.some((entry) => entry.name === column)) {
			this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
		}
	}
}

export function summaryPresentationPayloadDigest(payload: string): string {
	return digest(payload);
}
