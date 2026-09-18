import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
	SUMMARY_PRESENTATION_CONTRACT_VERSION,
	type SummaryPresentationJournalRound,
	type SummaryPresentationMigration,
	type SummaryPresentationStore,
} from "./summary-presentation-store.js";

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

export interface SummaryPresentationLegacyRow {
	line: number;
	raw: string;
	value: Record<string, unknown>;
}

export interface SummaryPresentationParsedJsonLines {
	rows: SummaryPresentationLegacyRow[];
	malformed: Array<{ line: number; raw: string }>;
}

export interface ResolvedSummaryPresentationMigrationInputs {
	workspaceRoot: string;
	ledgerPath: string;
	decisionsPath: string | null;
	ledger: SummaryPresentationParsedJsonLines;
	decisions: SummaryPresentationParsedJsonLines;
	journal: SummaryPresentationJournalRound[];
	boundarySeq: number;
	sourceDigests: {
		journal: string;
		legacyLedger: string;
		migrationDecisions: string;
	};
}

export interface SummaryPresentationMigrationResult {
	state: "building" | "complete";
	boundarySeq: number;
	cursorSeq: number;
	processed: number;
	dispositions: Record<
		| "eligible"
		| "historical_presented"
		| "historical_silent"
		| "needs_reconciliation",
		number
	>;
	sourceDigests: Record<string, string>;
}

export interface RunSummaryPresentationMigrationInput {
	store: SummaryPresentationStore;
	projectName: string;
	leadId: string;
	workspaceRoot: string;
	ledgerPath?: string;
	decisionsPath?: string;
	maxRows?: number;
	nowMs?: number;
	resolved?: ResolvedSummaryPresentationMigrationInputs;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function assertManagedSource(
	workspaceRoot: string,
	requestedPath: string,
	optional: boolean,
): string | null {
	const root = realpathSync(workspaceRoot);
	const candidate = isAbsolute(requestedPath)
		? requestedPath
		: resolve(root, requestedPath);
	if (!existsSync(candidate)) {
		if (optional) return null;
		throw new Error(
			`summary_presentation_migration_source_missing:${requestedPath}`,
		);
	}
	const metadata = lstatSync(candidate);
	if (!metadata.isFile() || metadata.isSymbolicLink()) {
		throw new Error(
			`summary_presentation_migration_source_invalid:${requestedPath}`,
		);
	}
	if (metadata.size > MAX_SOURCE_BYTES) {
		throw new Error(
			`summary_presentation_migration_source_too_large:${requestedPath}`,
		);
	}
	const canonical = realpathSync(candidate);
	const fromRoot = relative(root, canonical);
	if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
		throw new Error(
			`summary_presentation_migration_source_outside_workspace:${requestedPath}`,
		);
	}
	return canonical;
}

function parseJsonLines(path: string | null): {
	rows: SummaryPresentationLegacyRow[];
	malformed: Array<{ line: number; raw: string }>;
} {
	if (!path) return { rows: [], malformed: [] };
	const rows: SummaryPresentationLegacyRow[] = [];
	const malformed: Array<{ line: number; raw: string }> = [];
	for (const [index, rawLine] of readFileSync(path, "utf8")
		.split(/\r?\n/u)
		.entries()) {
		const raw = rawLine.trim();
		if (!raw) continue;
		try {
			const value = JSON.parse(raw) as unknown;
			if (!value || typeof value !== "object" || Array.isArray(value)) {
				malformed.push({ line: index + 1, raw });
				continue;
			}
			rows.push({
				line: index + 1,
				raw,
				value: value as Record<string, unknown>,
			});
		} catch {
			malformed.push({ line: index + 1, raw });
		}
	}
	return { rows, malformed };
}

function stringField(row: Record<string, unknown>, key: string): string | null {
	const value = row[key];
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validMessageId(value: unknown): value is string {
	return typeof value === "string" && /^[1-9][0-9]{0,24}$/u.test(value);
}

function evidenceRef(
	prefix: string,
	row: SummaryPresentationLegacyRow,
): string {
	return `${prefix}:${row.line}:${sha256(row.raw).slice(0, 20)}`;
}

export function classifyRound(input: {
	roundId: string;
	ledgerRows: SummaryPresentationLegacyRow[];
	decisionRows: SummaryPresentationLegacyRow[];
	ledgerMalformed: boolean;
}): {
	disposition:
		| "eligible"
		| "historical_presented"
		| "historical_silent"
		| "needs_reconciliation";
	evidenceRef: string;
} {
	const explicit = input.decisionRows.filter(
		(row) => stringField(row.value, "roundId") === input.roundId,
	);
	if (explicit.length > 1) {
		throw new Error(
			`summary_presentation_migration_decision_conflict:${input.roundId}`,
		);
	}
	const decision = explicit[0];
	if (decision) {
		const disposition = stringField(decision.value, "disposition");
		const operator = stringField(decision.value, "operator");
		const reason = stringField(decision.value, "reason");
		const suppliedEvidence = stringField(decision.value, "evidenceRef");
		if (
			!operator ||
			!reason ||
			!suppliedEvidence ||
			!["eligible", "historical_silent", "needs_reconciliation"].includes(
				disposition ?? "",
			)
		) {
			throw new Error(
				`summary_presentation_migration_decision_invalid:${input.roundId}`,
			);
		}
		const attempts = input.ledgerRows.some(
			(row) =>
				stringField(row.value, "roundId") === input.roundId &&
				["report_attempt", "report"].includes(
					stringField(row.value, "type") ?? "",
				),
		);
		if (disposition === "eligible" && attempts) {
			throw new Error(
				`summary_presentation_migration_eligible_has_send_attempt:${input.roundId}`,
			);
		}
		return {
			disposition: disposition as
				| "eligible"
				| "historical_silent"
				| "needs_reconciliation",
			evidenceRef: suppliedEvidence,
		};
	}

	const rows = input.ledgerRows.filter(
		(row) => stringField(row.value, "roundId") === input.roundId,
	);
	const presented = rows.find(
		(row) =>
			stringField(row.value, "type") === "report" &&
			validMessageId(row.value.messageId) &&
			validMessageId(row.value.channelId),
	);
	if (presented) {
		return {
			disposition: "historical_presented",
			evidenceRef: evidenceRef("legacy-report", presented),
		};
	}
	const silent = rows.find((row) => {
		const type = stringField(row.value, "type");
		const status = stringField(row.value, "status");
		const presentation = stringField(row.value, "presentation");
		const decisionValue = stringField(row.value, "decision");
		return (
			(type === "report" && status === "silent") ||
			(type === "round_complete" && presentation === "silent") ||
			(type === "summary_presentation" && decisionValue === "silent")
		);
	});
	if (silent) {
		return {
			disposition: "historical_silent",
			evidenceRef: evidenceRef("legacy-silent", silent),
		};
	}
	const basis = rows[0];
	return {
		disposition: "needs_reconciliation",
		evidenceRef: basis
			? evidenceRef("legacy-unknown", basis)
			: input.ledgerMalformed
				? `legacy-ledger-malformed:${sha256(input.roundId).slice(0, 20)}`
				: `legacy-evidence-absent:${sha256(input.roundId).slice(0, 20)}`,
	};
}

export function summaryPresentationBoundedSourceDigest(
	rows: SummaryPresentationLegacyRow[],
	malformed: Array<{ line: number; raw: string }>,
	roundIds: Set<string>,
): string {
	const relevant = rows
		.filter((row) => {
			const roundId = stringField(row.value, "roundId");
			return roundId !== null && roundIds.has(roundId);
		})
		.map((row) => `${row.line}:${row.raw}`);
	const bad = malformed.map((row) => `${row.line}:${row.raw}`);
	return sha256([...relevant, ...bad].sort().join("\n"));
}

export function resolveSummaryPresentationMigrationInputs(
	input: Pick<
		RunSummaryPresentationMigrationInput,
		| "store"
		| "projectName"
		| "leadId"
		| "workspaceRoot"
		| "ledgerPath"
		| "decisionsPath"
	>,
	existing: SummaryPresentationMigration | null,
): ResolvedSummaryPresentationMigrationInputs {
	const workspaceRoot = realpathSync(input.workspaceRoot);
	const ledgerPath = assertManagedSource(
		workspaceRoot,
		input.ledgerPath ?? "state/summary-merge-receipts.jsonl",
		false,
	);
	if (!ledgerPath) {
		throw new Error("summary_presentation_migration_ledger_missing");
	}
	const decisionsPath = assertManagedSource(
		workspaceRoot,
		input.decisionsPath ??
			"state/summary-presentation-migration-decisions.jsonl",
		true,
	);
	const ledger = parseJsonLines(ledgerPath);
	const decisions = parseJsonLines(decisionsPath);
	if (decisions.malformed.length > 0) {
		throw new Error(
			`summary_presentation_migration_decisions_malformed:${decisions.malformed[0]!.line}`,
		);
	}

	const journal = input.store.listMigrationJournalRounds(
		input.projectName,
		input.leadId,
		existing ? { throughSeq: existing.boundarySeq } : {},
	);
	const boundarySeq = existing?.boundarySeq ?? journal.at(-1)?.sourceSeq ?? 0;
	const roundIds = new Set(journal.map((row) => row.roundId));
	return {
		workspaceRoot,
		ledgerPath,
		decisionsPath,
		ledger,
		decisions,
		journal,
		boundarySeq,
		sourceDigests: {
			journal: sha256(
				journal
					.map((row) => `${row.sourceSeq}:${row.roundId}:${row.sourceDigest}`)
					.join("\n"),
			),
			legacyLedger: summaryPresentationBoundedSourceDigest(
				ledger.rows,
				ledger.malformed,
				roundIds,
			),
			migrationDecisions: decisionsPath
				? summaryPresentationBoundedSourceDigest(
						decisions.rows,
						decisions.malformed,
						roundIds,
					)
				: sha256("absent"),
		},
	};
}

export function runSummaryPresentationMigration(
	input: RunSummaryPresentationMigrationInput,
): SummaryPresentationMigrationResult {
	const existing = input.store.getMigration(input.projectName, input.leadId);
	if (existing?.state === "complete") {
		return {
			state: "complete",
			boundarySeq: existing.boundarySeq,
			cursorSeq: existing.cursorSeq,
			processed: 0,
			dispositions: {
				eligible: 0,
				historical_presented: 0,
				historical_silent: 0,
				needs_reconciliation: 0,
			},
			sourceDigests: existing.sourceDigests,
		};
	}
	const resolved =
		input.resolved ??
		resolveSummaryPresentationMigrationInputs(input, existing);
	const {
		ledger,
		decisions,
		journal: currentJournal,
		boundarySeq,
		sourceDigests,
	} = resolved;
	let migration = input.store.beginMigration({
		projectName: input.projectName,
		leadId: input.leadId,
		boundarySeq,
		sourceDigests,
		nowMs: input.nowMs,
	});
	if (migration.state === "complete") {
		return {
			state: "complete",
			boundarySeq,
			cursorSeq: migration.cursorSeq,
			processed: 0,
			dispositions: {
				eligible: 0,
				historical_presented: 0,
				historical_silent: 0,
				needs_reconciliation: 0,
			},
			sourceDigests,
		};
	}

	const maxRows = input.maxRows ?? Number.MAX_SAFE_INTEGER;
	if (!Number.isSafeInteger(maxRows) || maxRows < 1) {
		throw new Error("summary_presentation_migration_invalid_max_rows");
	}
	const dispositions = {
		eligible: 0,
		historical_presented: 0,
		historical_silent: 0,
		needs_reconciliation: 0,
	};
	let processed = 0;
	for (const journal of currentJournal) {
		if (journal.sourceSeq <= migration.cursorSeq) continue;
		if (processed >= maxRows) break;
		const confirmed = input.store.getRound(
			input.projectName,
			input.leadId,
			journal.roundId,
		);
		const journalPayload = JSON.parse(journal.payload) as Record<
			string,
			unknown
		>;
		const classification =
			confirmed?.disposition === "eligible" &&
			journalPayload.contract_version === SUMMARY_PRESENTATION_CONTRACT_VERSION
				? { disposition: "eligible" as const, evidenceRef: null }
				: confirmed &&
						["historical_presented", "historical_silent"].includes(
							confirmed.disposition,
						)
					? {
							disposition: confirmed.disposition as
								| "historical_presented"
								| "historical_silent",
							evidenceRef: confirmed.evidenceRef!,
						}
					: classifyRound({
							roundId: journal.roundId,
							ledgerRows: ledger.rows,
							decisionRows: decisions.rows,
							ledgerMalformed: ledger.malformed.length > 0,
						});
		input.store.classifyHistoricalRound({
			projectName: input.projectName,
			leadId: input.leadId,
			roundId: journal.roundId,
			sourceSeq: journal.sourceSeq,
			slotStartMs: journal.slotStartMs,
			disposition: classification.disposition,
			sourceDigest: journal.sourceDigest,
			evidenceRef: classification.evidenceRef,
			nowMs: input.nowMs,
		});
		dispositions[classification.disposition] += 1;
		processed += 1;
	}
	migration = input.store.getMigration(input.projectName, input.leadId)!;
	if (
		migration.cursorSeq === boundarySeq ||
		(boundarySeq === 0 && currentJournal.length === 0)
	) {
		migration = input.store.completeMigration({
			projectName: input.projectName,
			leadId: input.leadId,
			sourceDigests,
			nowMs: input.nowMs,
		});
	}
	return {
		state: migration.state,
		boundarySeq,
		cursorSeq: migration.cursorSeq,
		processed,
		dispositions,
		sourceDigests,
	};
}
