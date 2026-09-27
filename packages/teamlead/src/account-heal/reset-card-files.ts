/**
 * FLY-2896 — the three hand-off files between the quota daemon and the Bridge.
 *
 *   reset-card-proposal.json  daemon-only writer
 *   reset-card-consent.json   Bridge-only writer
 *   reset-card-audit.jsonl    daemon-only, append-only
 *
 * Single writer per file, so no lock. Writes are temp → fsync(file) → rename →
 * fsync(parent). Reads refuse symlinks, oversized files, unknown keys and
 * non-canonical instants. "Absent" (ENOENT) is kept strictly apart from
 * "present but invalid": the caller fails closed on the latter.
 */

import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BlockedEpisode } from "./quota-monitor-state.js";
import { parseBlockedEpisode } from "./quota-monitor-state.js";
import { GRANT_ID, LIMIT_KEYS, type LimitKey } from "./reset-card-contract.js";
import { proposalDigest } from "./reset-card-select.js";

export const MAX_STATE_FILE_BYTES = 16 * 1024;
export const MAX_AUDIT_BYTES = 1024 * 1024;

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const SNOWFLAKE = /^[0-9]{15,22}$/;
export const SAFE_REASON = /^[a-z][a-z0-9_:]{0,95}$/;
export const VALID_ACCOUNT_NAME = /^(?!\.)(?!.*\.\.)[A-Za-z0-9._-]{1,64}$/;
const RENDERED_FOR = /^[0-9a-f-]{36}:[a-z_]{1,40}$/;

export const PROPOSAL_STATUSES = [
	"awaiting_consent",
	"executing",
	"redeem_unconfirmed",
	"grant_already_used",
	"redeem_confirmed",
	"recovered_without_proven_redeem",
	"switching",
	"switch_committed",
	"settled",
	"switched",
	"switched_unverified",
	"redeemed_switch_failed",
	"redeem_ambiguous",
	"cancelled",
	"rejected",
	"expired",
	"post_failed",
	"failed",
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const TERMINAL_STATUSES: ReadonlySet<ProposalStatus> = new Set([
	"switched",
	"switched_unverified",
	"redeemed_switch_failed",
	"redeem_ambiguous",
	"cancelled",
	"rejected",
	"expired",
	"post_failed",
	"failed",
]);

export function isTerminalStatus(status: ProposalStatus): boolean {
	return TERMINAL_STATUSES.has(status);
}

export const CONSENT_STATES = [
	"pending_post",
	"posted",
	"approved",
	"rejected",
	"expired",
	"post_failed",
	"superseded",
] as const;
export type ConsentState = (typeof CONSENT_STATES)[number];

export interface WindowReading {
	fiveHPct: number;
	sevenDPct: number;
	fiveHResetAt: string | null;
	sevenDResetAt: string | null;
}

export type ProposalRunway =
	| { fiveHourMinutes: number }
	| { unknown: "too_early" | "no_reset_time" };

/** Display snapshot only; never participates in candidate selection. */
export interface ProposalAccountRow {
	name: string;
	fiveHPct: number | null;
	sevenDPct: number | null;
	recoveryAt: string | null;
	/** null means unread, [] means observed to have no cards. */
	cards: Array<{ count: number; endsAt: string | null }> | null;
}

export interface ResetCardProposal {
	/** Optional for proposals written before the founder message v4 rollout. */
	accountRows?: ProposalAccountRow[];
	schemaVersion: 1;
	proposalId: string;
	episodeKey: string;
	createdAt: string;
	expiresAt: string;
	status: ProposalStatus;
	statusReason: string | null;
	statusAt: string;
	active: WindowReading & {
		name: string;
		generation: number;
		drivingWindow: "5h" | "7d";
		/** The live switch line (trigger5hPct) the card promises to wait for. */
		switchAtPct: number;
	};
	target: WindowReading & {
		name: string;
		recoveryAt: string;
		exhausted: LimitKey[];
	};
	grant: {
		id: string;
		endsAt: string | null;
		clears: LimitKey[];
		resetsLeftBefore: number;
		cardsLeftTotal: number;
	};
	runway: ProposalRunway;
	digest: string;
	redeem: null | {
		requestId: string;
		startedAt: string;
		result: string | null;
		cause: string | null;
		resetsLeftAfter: number | null;
		unconfirmedChecks: number;
	};
	switchIntent: null | {
		from: string;
		to: string;
		generationBefore: number;
		expectedGeneration: number;
		trigger: { scope: "5h" | "weekly" | "both"; resetAt: string };
		targetDigest: string;
		verifiedAt: string | null;
	};
	blockedEpisodeAtSwitch: BlockedEpisode | null;
}

export interface ResetCardConsent {
	schemaVersion: 1;
	proposalId: string;
	digest: string;
	state: ConsentState;
	reason: string | null;
	channelId: string | null;
	messageId: string | null;
	postedAt: string | null;
	decidedAt: string | null;
	founderId: string | null;
	outcomeRenderedFor: string | null;
}

export interface AuditIntentRow {
	at: string;
	kind: "intent";
	proposalId: string;
	target: string;
	grantId: string;
	requestId: string;
}

/** FLY-2896 F1: an intent provably never POSTed (proposal never reached executing). */
export interface AuditVoidedRow {
	at: string;
	kind: "voided";
	proposalId: string;
	requestId: string;
	reason: "aborted_before_post";
}

export interface AuditTerminalRow {
	at: string;
	kind: "terminal";
	proposalId: string;
	episodeKey: string;
	outcome: ProposalStatus;
	reason: string | null;
	active: { name: string; fiveHPct: number; sevenDPct: number };
	target: {
		name: string;
		before: { fiveHPct: number; sevenDPct: number };
		after: { fiveHPct: number; sevenDPct: number } | null;
	};
	grant: {
		id: string;
		resetsLeftBefore: number;
		resetsLeftAfter: number | null;
	};
	requestId: string | null;
	redeemResult: string | null;
	redeemProven: boolean | null;
	consent: {
		state: ConsentState;
		founderId: string | null;
		decidedAt: string | null;
		channelId: string | null;
		messageId: string | null;
	} | null;
	switch: { outcome: string; generation: number | null } | null;
}

export type AuditRow = AuditIntentRow | AuditVoidedRow | AuditTerminalRow;

export type FileRead<T> =
	| { status: "absent" }
	| { status: "ok"; value: T }
	| { status: "invalid"; reason: string };

/** The synchronous fs surface this module touches; tests inject a recorder. */
export interface ResetCardFs {
	lstatSync: typeof nodeFs.lstatSync;
	readFileSync: typeof nodeFs.readFileSync;
	mkdirSync: typeof nodeFs.mkdirSync;
	openSync: typeof nodeFs.openSync;
	writeSync: typeof nodeFs.writeSync;
	fsyncSync: typeof nodeFs.fsyncSync;
	closeSync: typeof nodeFs.closeSync;
	renameSync: typeof nodeFs.renameSync;
	unlinkSync: typeof nodeFs.unlinkSync;
	chmodSync: typeof nodeFs.chmodSync;
}

const realFs: ResetCardFs = {
	lstatSync: nodeFs.lstatSync,
	readFileSync: nodeFs.readFileSync,
	mkdirSync: nodeFs.mkdirSync,
	openSync: nodeFs.openSync,
	writeSync: nodeFs.writeSync,
	fsyncSync: nodeFs.fsyncSync,
	closeSync: nodeFs.closeSync,
	renameSync: nodeFs.renameSync,
	unlinkSync: nodeFs.unlinkSync,
	chmodSync: nodeFs.chmodSync,
};

export function defaultResetCardDir(
	env: Record<string, string | undefined> = process.env,
	home: string = homedir(),
): string {
	const stateDir = env.FLYWHEEL_STATE_DIR?.trim() || join(home, ".flywheel");
	return join(stateDir, "claude-quota");
}

// ---------------------------------------------------------------------------
// Validation

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
	const allowed = new Set(keys);
	return Object.keys(value).every((key) => allowed.has(key));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
	return onlyKeys(value, keys) && keys.every((key) => key in value);
}

export function isCanonicalInstant(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const ms = Date.parse(value);
	return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

const nullableInstant = (value: unknown): value is string | null =>
	value === null || isCanonicalInstant(value);
const pct = (value: unknown): value is number =>
	typeof value === "number" &&
	Number.isFinite(value) &&
	value >= 0 &&
	value <= 10_000;
const int = (value: unknown, max = 1_000_000_000): value is number =>
	typeof value === "number" &&
	Number.isSafeInteger(value) &&
	value >= 0 &&
	value <= max;
const accountName = (value: unknown): value is string =>
	typeof value === "string" && VALID_ACCOUNT_NAME.test(value);
const uuid = (value: unknown): value is string =>
	typeof value === "string" && UUID.test(value);
const hex64 = (value: unknown): value is string =>
	typeof value === "string" && HEX64.test(value);
const snowflake = (value: unknown): value is string | null =>
	value === null || (typeof value === "string" && SNOWFLAKE.test(value));
const safeReason = (value: unknown): value is string | null =>
	value === null || (typeof value === "string" && SAFE_REASON.test(value));
const LIMIT_KEY_SET: ReadonlySet<unknown> = new Set(LIMIT_KEYS);
const limitKeys = (value: unknown): value is LimitKey[] =>
	Array.isArray(value) &&
	value.length <= LIMIT_KEYS.length &&
	value.every((key) => LIMIT_KEY_SET.has(key)) &&
	new Set(value).size === value.length;

const WINDOW_KEYS = ["fiveHPct", "sevenDPct", "fiveHResetAt", "sevenDResetAt"];

function validWindows(value: Record<string, unknown>): boolean {
	return (
		pct(value.fiveHPct) &&
		pct(value.sevenDPct) &&
		nullableInstant(value.fiveHResetAt) &&
		nullableInstant(value.sevenDResetAt)
	);
}

const PROPOSAL_KEYS = [
	"schemaVersion",
	"proposalId",
	"episodeKey",
	"createdAt",
	"expiresAt",
	"status",
	"statusReason",
	"statusAt",
	"active",
	"target",
	"grant",
	"runway",
	"digest",
	"redeem",
	"switchIntent",
	"blockedEpisodeAtSwitch",
];
const PROPOSAL_STATUS_SET: ReadonlySet<unknown> = new Set(PROPOSAL_STATUSES);
const CONSENT_STATE_SET: ReadonlySet<unknown> = new Set(CONSENT_STATES);

function validRunway(value: unknown): boolean {
	if (!record(value)) return false;
	if ("fiveHourMinutes" in value) {
		return (
			exactKeys(value, ["fiveHourMinutes"]) && int(value.fiveHourMinutes, 300)
		);
	}
	return (
		exactKeys(value, ["unknown"]) &&
		(value.unknown === "too_early" || value.unknown === "no_reset_time")
	);
}

function validRedeem(value: unknown): boolean {
	if (value === null) return true;
	return (
		record(value) &&
		exactKeys(value, [
			"requestId",
			"startedAt",
			"result",
			"cause",
			"resetsLeftAfter",
			"unconfirmedChecks",
		]) &&
		uuid(value.requestId) &&
		isCanonicalInstant(value.startedAt) &&
		safeReason(value.result) &&
		safeReason(value.cause) &&
		(value.resetsLeftAfter === null || int(value.resetsLeftAfter, 1000)) &&
		int(value.unconfirmedChecks, 3)
	);
}

function validSwitchIntent(value: unknown): boolean {
	if (value === null) return true;
	if (
		!record(value) ||
		!exactKeys(value, [
			"from",
			"to",
			"generationBefore",
			"expectedGeneration",
			"trigger",
			"targetDigest",
			"verifiedAt",
		]) ||
		!record(value.trigger) ||
		!exactKeys(value.trigger, ["scope", "resetAt"])
	) {
		return false;
	}
	return (
		accountName(value.from) &&
		accountName(value.to) &&
		int(value.generationBefore) &&
		int(value.expectedGeneration) &&
		value.expectedGeneration === (value.generationBefore as number) + 1 &&
		(value.trigger.scope === "5h" ||
			value.trigger.scope === "weekly" ||
			value.trigger.scope === "both") &&
		isCanonicalInstant(value.trigger.resetAt) &&
		hex64(value.targetDigest) &&
		nullableInstant(value.verifiedAt)
	);
}

/** The digest-bound core: everything the founder consented to. */
export function proposalDigestCore(
	p: Pick<
		ResetCardProposal,
		| "proposalId"
		| "episodeKey"
		| "expiresAt"
		| "active"
		| "target"
		| "grant"
		| "accountRows"
	>,
): unknown {
	return {
		...(p.accountRows === undefined ? {} : { accountRows: p.accountRows }),
		proposalId: p.proposalId,
		episodeKey: p.episodeKey,
		expiresAt: p.expiresAt,
		active: {
			name: p.active.name,
			generation: p.active.generation,
			drivingWindow: p.active.drivingWindow,
			// The card promises "switch at N%": she consented to that line too.
			switchAtPct: p.active.switchAtPct,
		},
		target: {
			name: p.target.name,
			recoveryAt: p.target.recoveryAt,
			exhausted: [...p.target.exhausted].sort(),
		},
		grant: {
			id: p.grant.id,
			endsAt: p.grant.endsAt,
			clears: [...p.grant.clears].sort(),
			cardsLeftTotal: p.grant.cardsLeftTotal,
		},
	};
}

export function computeProposalDigest(
	p: Parameters<typeof proposalDigestCore>[0],
): string {
	return proposalDigest(proposalDigestCore(p));
}

function validAccountRows(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.length <= 64 &&
		value.every(
			(row) =>
				record(row) &&
				exactKeys(row, [
					"name",
					"fiveHPct",
					"sevenDPct",
					"recoveryAt",
					"cards",
				]) &&
				accountName(row.name) &&
				(row.fiveHPct === null || pct(row.fiveHPct)) &&
				(row.sevenDPct === null || pct(row.sevenDPct)) &&
				nullableInstant(row.recoveryAt) &&
				(row.cards === null ||
					(Array.isArray(row.cards) &&
						row.cards.length <= 128 &&
						row.cards.every(
							(card) =>
								record(card) &&
								exactKeys(card, ["count", "endsAt"]) &&
								int(card.count, 1000) &&
								nullableInstant(card.endsAt),
						))),
		) &&
		new Set(value.map((row) => row.name)).size === value.length
	);
}

export function validateProposal(value: unknown): ResetCardProposal | null {
	if (
		!record(value) ||
		!exactKeys(
			value,
			"accountRows" in value
				? [...PROPOSAL_KEYS, "accountRows"]
				: PROPOSAL_KEYS,
		)
	)
		return null;
	if ("accountRows" in value && !validAccountRows(value.accountRows))
		return null;
	const { active, target, grant } = value;
	if (
		value.schemaVersion !== 1 ||
		!uuid(value.proposalId) ||
		!hex64(value.episodeKey) ||
		!isCanonicalInstant(value.createdAt) ||
		!isCanonicalInstant(value.expiresAt) ||
		!PROPOSAL_STATUS_SET.has(value.status) ||
		!safeReason(value.statusReason) ||
		!isCanonicalInstant(value.statusAt) ||
		!hex64(value.digest) ||
		!validRunway(value.runway) ||
		!validRedeem(value.redeem) ||
		!validSwitchIntent(value.switchIntent)
	) {
		return null;
	}
	if (
		!record(active) ||
		!exactKeys(active, [
			...WINDOW_KEYS,
			"name",
			"generation",
			"drivingWindow",
			"switchAtPct",
		]) ||
		!validWindows(active) ||
		!accountName(active.name) ||
		!int(active.generation) ||
		(active.drivingWindow !== "5h" && active.drivingWindow !== "7d") ||
		!pct(active.switchAtPct) ||
		(active.switchAtPct as number) > 100
	) {
		return null;
	}
	if (
		!record(target) ||
		!exactKeys(target, [...WINDOW_KEYS, "name", "recoveryAt", "exhausted"]) ||
		!validWindows(target) ||
		!accountName(target.name) ||
		!isCanonicalInstant(target.recoveryAt) ||
		!limitKeys(target.exhausted)
	) {
		return null;
	}
	if (
		!record(grant) ||
		!exactKeys(grant, [
			"id",
			"endsAt",
			"clears",
			"resetsLeftBefore",
			"cardsLeftTotal",
		]) ||
		typeof grant.id !== "string" ||
		!GRANT_ID.test(grant.id) ||
		!nullableInstant(grant.endsAt) ||
		!limitKeys(grant.clears) ||
		!int(grant.resetsLeftBefore, 1000) ||
		!int(grant.cardsLeftTotal, 128_000)
	) {
		return null;
	}
	const blocked = parseBlockedEpisode(value.blockedEpisodeAtSwitch);
	if (blocked === undefined) return null;
	const proposal = {
		...(value as unknown as ResetCardProposal),
		blockedEpisodeAtSwitch: blocked,
	};
	// The digest is recomputed, not trusted: a hand-edited core cannot keep it.
	if (computeProposalDigest(proposal) !== proposal.digest) return null;
	return proposal;
}

const CONSENT_KEYS = [
	"schemaVersion",
	"proposalId",
	"digest",
	"state",
	"reason",
	"channelId",
	"messageId",
	"postedAt",
	"decidedAt",
	"founderId",
	"outcomeRenderedFor",
];

export function validateConsent(value: unknown): ResetCardConsent | null {
	if (!record(value) || !exactKeys(value, CONSENT_KEYS)) return null;
	if (
		value.schemaVersion !== 1 ||
		!uuid(value.proposalId) ||
		!hex64(value.digest) ||
		!CONSENT_STATE_SET.has(value.state) ||
		!safeReason(value.reason) ||
		!snowflake(value.channelId) ||
		!snowflake(value.messageId) ||
		!nullableInstant(value.postedAt) ||
		!nullableInstant(value.decidedAt) ||
		!snowflake(value.founderId) ||
		!(
			value.outcomeRenderedFor === null ||
			(typeof value.outcomeRenderedFor === "string" &&
				RENDERED_FOR.test(value.outcomeRenderedFor))
		)
	) {
		return null;
	}
	return value as unknown as ResetCardConsent;
}

function validPair(
	value: unknown,
): value is { fiveHPct: number; sevenDPct: number } {
	return (
		record(value) &&
		exactKeys(value, ["fiveHPct", "sevenDPct"]) &&
		pct(value.fiveHPct) &&
		pct(value.sevenDPct)
	);
}

export function validateAuditRow(value: unknown): AuditRow | null {
	if (!record(value)) return null;
	if (value.kind === "intent") {
		return exactKeys(value, [
			"at",
			"kind",
			"proposalId",
			"target",
			"grantId",
			"requestId",
		]) &&
			isCanonicalInstant(value.at) &&
			uuid(value.proposalId) &&
			accountName(value.target) &&
			typeof value.grantId === "string" &&
			GRANT_ID.test(value.grantId) &&
			uuid(value.requestId)
			? (value as unknown as AuditIntentRow)
			: null;
	}
	if (value.kind === "voided") {
		return exactKeys(value, [
			"at",
			"kind",
			"proposalId",
			"requestId",
			"reason",
		]) &&
			isCanonicalInstant(value.at) &&
			uuid(value.proposalId) &&
			uuid(value.requestId) &&
			value.reason === "aborted_before_post"
			? (value as unknown as AuditVoidedRow)
			: null;
	}
	if (value.kind !== "terminal") return null;
	if (
		!exactKeys(value, [
			"at",
			"kind",
			"proposalId",
			"episodeKey",
			"outcome",
			"reason",
			"active",
			"target",
			"grant",
			"requestId",
			"redeemResult",
			"redeemProven",
			"consent",
			"switch",
		]) ||
		!isCanonicalInstant(value.at) ||
		!uuid(value.proposalId) ||
		!hex64(value.episodeKey) ||
		!PROPOSAL_STATUS_SET.has(value.outcome) ||
		!isTerminalStatus(value.outcome as ProposalStatus) ||
		!safeReason(value.reason) ||
		!(value.requestId === null || uuid(value.requestId)) ||
		!safeReason(value.redeemResult) ||
		!(value.redeemProven === null || typeof value.redeemProven === "boolean")
	) {
		return null;
	}
	const { active, target, grant, consent } = value;
	const sw = value.switch;
	if (
		!record(active) ||
		!exactKeys(active, ["name", "fiveHPct", "sevenDPct"]) ||
		!accountName(active.name) ||
		!pct(active.fiveHPct) ||
		!pct(active.sevenDPct) ||
		!record(target) ||
		!exactKeys(target, ["name", "before", "after"]) ||
		!accountName(target.name) ||
		!validPair(target.before) ||
		!(target.after === null || validPair(target.after)) ||
		!record(grant) ||
		!exactKeys(grant, ["id", "resetsLeftBefore", "resetsLeftAfter"]) ||
		typeof grant.id !== "string" ||
		!GRANT_ID.test(grant.id) ||
		!int(grant.resetsLeftBefore, 1000) ||
		!(grant.resetsLeftAfter === null || int(grant.resetsLeftAfter, 1000))
	) {
		return null;
	}
	if (
		consent !== null &&
		!(
			record(consent) &&
			exactKeys(consent, [
				"state",
				"founderId",
				"decidedAt",
				"channelId",
				"messageId",
			]) &&
			CONSENT_STATE_SET.has(consent.state) &&
			snowflake(consent.founderId) &&
			nullableInstant(consent.decidedAt) &&
			snowflake(consent.channelId) &&
			snowflake(consent.messageId)
		)
	) {
		return null;
	}
	if (
		sw !== null &&
		!(
			record(sw) &&
			exactKeys(sw, ["outcome", "generation"]) &&
			typeof sw.outcome === "string" &&
			SAFE_REASON.test(sw.outcome) &&
			(sw.generation === null || int(sw.generation))
		)
	) {
		return null;
	}
	return value as unknown as AuditTerminalRow;
}

// ---------------------------------------------------------------------------
// Audit queries

/** The intent row this proposal wrote before its single POST, if any. */
export function auditIntentFor(
	rows: readonly AuditRow[],
	proposalId: string,
): AuditIntentRow | null {
	return (
		rows.find(
			(row): row is AuditIntentRow =>
				row.kind === "intent" && row.proposalId === proposalId,
		) ?? null
	);
}

export function isIntentVoided(
	rows: readonly AuditRow[],
	proposalId: string,
): boolean {
	return rows.some(
		(row) => row.kind === "voided" && row.proposalId === proposalId,
	);
}

export function hasTerminalRow(
	rows: readonly AuditRow[],
	proposalId: string,
): boolean {
	return rows.some(
		(row) => row.kind === "terminal" && row.proposalId === proposalId,
	);
}

/**
 * I2 dedup: once a `(target, grant)` pair has reached the moment before a POST,
 * it is never proposed again — unless that intent was voided as provably
 * never sent (F1).
 */
export function hasLiveIntentFor(
	rows: readonly AuditRow[],
	target: string,
	grantId: string,
): boolean {
	return rows.some(
		(row) =>
			row.kind === "intent" &&
			row.target === target &&
			row.grantId === grantId &&
			!isIntentVoided(rows, row.proposalId),
	);
}

// ---------------------------------------------------------------------------
// IO

export interface ResetCardFiles {
	readonly dir: string;
	readonly proposalPath: string;
	readonly consentPath: string;
	readonly auditPath: string;
	readProposal(): FileRead<ResetCardProposal>;
	writeProposal(proposal: ResetCardProposal): void;
	readConsent(): FileRead<ResetCardConsent>;
	writeConsent(consent: ResetCardConsent): void;
	readAudit(): FileRead<AuditRow[]>;
	appendAudit(row: AuditRow): void;
}

function errnoCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

export function makeResetCardFiles(
	dir: string = defaultResetCardDir(),
	fs: ResetCardFs = realFs,
): ResetCardFiles {
	const proposalPath = join(dir, "reset-card-proposal.json");
	const consentPath = join(dir, "reset-card-consent.json");
	const auditPath = join(dir, "reset-card-audit.jsonl");

	const ensureDir = (): void => {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const stat = fs.lstatSync(dir);
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			throw new Error("reset-card directory is not a plain directory");
		}
		if ((stat.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
	};

	const fsyncDir = (): void => {
		const handle = fs.openSync(dir, "r");
		try {
			fs.fsyncSync(handle);
		} finally {
			fs.closeSync(handle);
		}
	};

	const readBounded = (
		path: string,
		maxBytes: number,
	): { absent: true } | { raw: string } | { invalid: string } => {
		let stat: nodeFs.Stats;
		try {
			stat = fs.lstatSync(path);
		} catch (error) {
			return errnoCode(error) === "ENOENT"
				? { absent: true }
				: { invalid: "stat_failed" };
		}
		if (stat.isSymbolicLink() || !stat.isFile()) return { invalid: "not_file" };
		if (stat.size > maxBytes) return { invalid: "too_large" };
		try {
			const raw = fs.readFileSync(path, "utf8") as string;
			if (Buffer.byteLength(raw, "utf8") > maxBytes) {
				return { invalid: "too_large" };
			}
			return { raw };
		} catch (error) {
			return errnoCode(error) === "ENOENT"
				? { absent: true }
				: { invalid: "read_failed" };
		}
	};

	const readJson = <T>(
		path: string,
		validate: (value: unknown) => T | null,
	): FileRead<T> => {
		const read = readBounded(path, MAX_STATE_FILE_BYTES);
		if ("absent" in read) return { status: "absent" };
		if ("invalid" in read) return { status: "invalid", reason: read.invalid };
		let parsed: unknown;
		try {
			parsed = JSON.parse(read.raw);
		} catch {
			return { status: "invalid", reason: "not_json" };
		}
		const value = validate(parsed);
		return value === null
			? { status: "invalid", reason: "schema" }
			: { status: "ok", value };
	};

	const writeJsonAtomic = (path: string, value: unknown): void => {
		const body = `${JSON.stringify(value, null, 2)}\n`;
		if (Buffer.byteLength(body, "utf8") > MAX_STATE_FILE_BYTES) {
			throw new Error("reset-card state file exceeds its size bound");
		}
		ensureDir();
		const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
		const handle = fs.openSync(temp, "wx", 0o600);
		try {
			try {
				fs.writeSync(handle, body);
				fs.fsyncSync(handle);
			} finally {
				fs.closeSync(handle);
			}
			fs.renameSync(temp, path);
		} catch (error) {
			try {
				fs.unlinkSync(temp);
			} catch {
				/* already renamed or never created */
			}
			throw error;
		}
		fsyncDir();
	};

	return {
		dir,
		proposalPath,
		consentPath,
		auditPath,
		readProposal: () => readJson(proposalPath, validateProposal),
		writeProposal: (proposal) => {
			if (validateProposal(proposal) === null) {
				throw new Error("refusing to write an invalid reset-card proposal");
			}
			writeJsonAtomic(proposalPath, proposal);
		},
		readConsent: () => readJson(consentPath, validateConsent),
		writeConsent: (consent) => {
			if (validateConsent(consent) === null) {
				throw new Error("refusing to write an invalid reset-card consent");
			}
			writeJsonAtomic(consentPath, consent);
		},
		readAudit: () => {
			const read = readBounded(auditPath, MAX_AUDIT_BYTES);
			if ("absent" in read) return { status: "ok", value: [] };
			if ("invalid" in read) return { status: "invalid", reason: read.invalid };
			if (read.raw.length === 0) return { status: "ok", value: [] };
			// A final line without its newline is a torn append: fail closed.
			if (!read.raw.endsWith("\n")) {
				return { status: "invalid", reason: "truncated" };
			}
			const rows: AuditRow[] = [];
			for (const line of read.raw.slice(0, -1).split("\n")) {
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch {
					return { status: "invalid", reason: "line_not_json" };
				}
				const row = validateAuditRow(parsed);
				if (row === null) return { status: "invalid", reason: "line_schema" };
				rows.push(row);
			}
			return { status: "ok", value: rows };
		},
		appendAudit: (row) => {
			if (validateAuditRow(row) === null) {
				throw new Error("refusing to append an invalid reset-card audit row");
			}
			const line = `${JSON.stringify(row)}\n`;
			ensureDir();
			const existing = readBounded(auditPath, MAX_AUDIT_BYTES);
			if ("invalid" in existing) {
				throw new Error(`reset-card audit is unusable: ${existing.invalid}`);
			}
			const size =
				"raw" in existing ? Buffer.byteLength(existing.raw, "utf8") : 0;
			if (size + Buffer.byteLength(line, "utf8") > MAX_AUDIT_BYTES) {
				throw new Error("reset-card audit exceeds its size bound");
			}
			const created = "absent" in existing;
			const handle = fs.openSync(
				auditPath,
				nodeFs.constants.O_WRONLY |
					nodeFs.constants.O_APPEND |
					nodeFs.constants.O_CREAT |
					nodeFs.constants.O_NOFOLLOW,
				0o600,
			);
			try {
				fs.writeSync(handle, line);
				fs.fsyncSync(handle);
			} finally {
				fs.closeSync(handle);
			}
			if (created) fsyncDir();
		},
	};
}
