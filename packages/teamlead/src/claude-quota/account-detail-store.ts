import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MAX_STORE_BYTES = 256 * 1024;
const MAX_ACCOUNTS = 64;
const ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_STATUS = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TIER_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_GRANTS = 128;
const MAX_GRANT_RESETS = 1000;

export interface ClaudePrepaidCard {
	source: "tranche" | "promo";
	expiresAt: string;
}

export interface ClaudePrepaidDetail {
	known: boolean;
	/** null means the endpoint did not expose card arrays; [] means checked and none. */
	cards: ClaudePrepaidCard[] | null;
}

/** FLY-2864: the live organization tier, same shape as PoolSubscriptionTier. */
export interface ClaudeTier {
	subscriptionType: string;
	rateLimitTier: string | null;
}

/** One usage-limit reset card ("cedar_ember" grant); no id or label is kept. */
export interface ClaudeResetGrant {
	resetsLeft: number;
	resetsTotal: number;
	endsAt: string | null;
}

export interface ClaudeResetGrants {
	/** true: `grants` is the authoritative list (possibly []). */
	known: boolean;
	/** Safe enum: why unknown, or the server's explicit "no_grant" when known. */
	reason: string | null;
	/** null whenever `known` is false. */
	grants: ClaudeResetGrant[] | null;
}

export interface ClaudeAccountDetailReading {
	name: string;
	observedAt: string | null;
	subscription: "active" | "canceled" | "unknown";
	usageStatus: string;
	prepaid: ClaudePrepaidDetail;
	/** FLY-2864: absent in pre-2864 files; null when the profile gave no valid type. */
	tier?: ClaudeTier | null;
	/** FLY-2864: absent in pre-2864 files and on first-round carry-forward rows. */
	resetGrants?: ClaudeResetGrants;
	note: string | null;
}

export interface ClaudeAccountDetailStore {
	version: 1;
	generatedAt: string;
	accounts: ClaudeAccountDetailReading[];
}

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function instant(value: unknown): value is string {
	return (
		typeof value === "string" &&
		Number.isFinite(Date.parse(value)) &&
		new Date(Date.parse(value)).toISOString() === value
	);
}

function validTier(value: unknown): boolean {
	return (
		value === null ||
		(record(value) &&
			typeof value.subscriptionType === "string" &&
			TIER_TOKEN.test(value.subscriptionType) &&
			(value.rateLimitTier === null ||
				(typeof value.rateLimitTier === "string" &&
					TIER_TOKEN.test(value.rateLimitTier))))
	);
}

function resetCount(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0 &&
		value <= MAX_GRANT_RESETS
	);
}

function validResetGrants(value: unknown): boolean {
	if (!record(value) || typeof value.known !== "boolean") return false;
	if (
		value.reason !== null &&
		(typeof value.reason !== "string" || !SAFE_STATUS.test(value.reason))
	) {
		return false;
	}
	if (!value.known) return value.grants === null;
	return (
		Array.isArray(value.grants) &&
		value.grants.length <= MAX_GRANTS &&
		value.grants.every(
			(grant) =>
				record(grant) &&
				resetCount(grant.resetsLeft) &&
				resetCount(grant.resetsTotal) &&
				grant.resetsLeft <= grant.resetsTotal &&
				(grant.endsAt === null || instant(grant.endsAt)),
		)
	);
}

function validReading(value: unknown): value is ClaudeAccountDetailReading {
	if (!record(value) || !record(value.prepaid)) return false;
	if ("tier" in value && !validTier(value.tier)) return false;
	if ("resetGrants" in value && !validResetGrants(value.resetGrants)) {
		return false;
	}
	const cards = value.prepaid.cards;
	if (cards !== null && !Array.isArray(cards)) return false;
	if (
		Array.isArray(cards) &&
		(cards.length > 128 ||
			!cards.every(
				(card) =>
					record(card) &&
					(card.source === "tranche" || card.source === "promo") &&
					instant(card.expiresAt),
			))
	) {
		return false;
	}
	return (
		typeof value.name === "string" &&
		ACCOUNT_NAME.test(value.name) &&
		(value.observedAt === null || instant(value.observedAt)) &&
		(value.subscription === "active" ||
			value.subscription === "canceled" ||
			value.subscription === "unknown") &&
		typeof value.usageStatus === "string" &&
		SAFE_STATUS.test(value.usageStatus) &&
		typeof value.prepaid.known === "boolean" &&
		(value.prepaid.known || cards === null) &&
		(value.note === null ||
			(typeof value.note === "string" && SAFE_STATUS.test(value.note)))
	);
}

export function defaultClaudeAccountDetailStorePath(
	env: Record<string, string | undefined> = process.env,
	home: string = homedir(),
): string {
	const stateDir = env.FLYWHEEL_STATE_DIR?.trim() || join(home, ".flywheel");
	return join(stateDir, "claude-quota", "account-details.json");
}

export function readClaudeAccountDetailStore(
	path: string,
): ClaudeAccountDetailStore | null {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	if (raw.length > MAX_STORE_BYTES) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (
		!record(parsed) ||
		parsed.version !== 1 ||
		!instant(parsed.generatedAt) ||
		!Array.isArray(parsed.accounts) ||
		parsed.accounts.length > MAX_ACCOUNTS ||
		!parsed.accounts.every(validReading)
	) {
		return null;
	}
	const names = (parsed.accounts as ClaudeAccountDetailReading[]).map(
		(account) => account.name,
	);
	return new Set(names).size === names.length
		? (parsed as unknown as ClaudeAccountDetailStore)
		: null;
}

export function writeClaudeAccountDetailStore(
	path: string,
	store: ClaudeAccountDetailStore,
): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.tmp-${process.pid}`;
	const handle = openSync(temp, "w", 0o600);
	try {
		writeSync(handle, `${JSON.stringify(store, null, 2)}\n`);
		fsyncSync(handle);
	} finally {
		closeSync(handle);
	}
	try {
		renameSync(temp, path);
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {
			/* temp is already gone */
		}
		throw error;
	}
}
