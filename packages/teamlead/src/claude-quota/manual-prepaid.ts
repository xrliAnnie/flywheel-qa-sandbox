import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";

const MAX_BYTES = 64 * 1024;
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9 ._@-]{0,63}$/;

export interface ClaudeManualPrepaidEntry {
	account: string;
	confirmedBy: string;
	confirmedAt: string;
	cards: Array<{ expiresAt: string }>;
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

export function defaultClaudeManualPrepaidPath(
	env: Record<string, string | undefined> = process.env,
	home: string = homedir(),
): string {
	const stateDir = env.FLYWHEEL_STATE_DIR?.trim() || join(home, ".flywheel");
	return join(stateDir, "claude-quota", "manual-prepaid.json");
}

export function readClaudeManualPrepaid(
	path: string,
	stateDir: string,
): ClaudeManualPrepaidEntry[] | null {
	const root = resolve(stateDir);
	const target = resolve(path);
	let raw: string;
	try {
		const location = relative(realpathSync(root), realpathSync(target));
		if (
			location.startsWith("..") ||
			location === "" ||
			location.startsWith("/")
		) {
			return null;
		}
		const stat = lstatSync(target);
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			(stat.mode & 0o022) !== 0 ||
			(typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
			stat.size > MAX_BYTES
		) {
			return null;
		}
		raw = readFileSync(target, "utf8");
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (
		!record(parsed) ||
		parsed.version !== 1 ||
		!Array.isArray(parsed.accounts)
	) {
		return null;
	}
	if (parsed.accounts.length > 64) return null;
	const result: ClaudeManualPrepaidEntry[] = [];
	for (const value of parsed.accounts) {
		if (
			!record(value) ||
			typeof value.account !== "string" ||
			!ACCOUNT.test(value.account) ||
			typeof value.confirmedBy !== "string" ||
			!ACTOR.test(value.confirmedBy) ||
			!instant(value.confirmedAt) ||
			!Array.isArray(value.cards) ||
			value.cards.length > 128
		) {
			return null;
		}
		const cards: Array<{ expiresAt: string }> = [];
		for (const card of value.cards) {
			if (!record(card) || !instant(card.expiresAt)) return null;
			cards.push({ expiresAt: card.expiresAt });
		}
		cards.sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
		result.push({
			account: value.account,
			confirmedBy: value.confirmedBy,
			confirmedAt: value.confirmedAt,
			cards,
		});
	}
	const names = result.map((entry) => entry.account);
	return new Set(names).size === names.length ? result : null;
}
