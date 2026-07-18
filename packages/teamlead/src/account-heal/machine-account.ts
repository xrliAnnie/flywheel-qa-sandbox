import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountStore } from "./account-store.js";
import {
	listPoolAccounts,
	readActiveProfileName,
} from "./quota-monitor-credentials.js";

export type MachineAccountResolution =
	| { kind: "resolved"; name: string }
	| {
			kind: "conflict";
			activeMarker: string | null;
			identityAccount: string | null;
			ledgerAccount: string | null;
	  }
	| {
			kind: "untracked";
			identityEmail: string | null;
			activeMarker: string | null;
			ledgerAccount: string | null;
	  };

export interface ResolveMachineAccountOptions {
	poolDir: string;
	claudeJsonPath: string;
	store: AccountStore;
}

export function defaultMachinePoolDir(): string {
	return (
		process.env.FLYWHEEL_CLAUDE_PROFILES_DIR ??
		join(homedir(), ".flywheel", "claude-profiles")
	);
}

export function defaultClaudeJsonPath(): string {
	return process.env.FLYWHEEL_CLAUDE_JSON ?? join(homedir(), ".claude.json");
}

function readJsonObject(path: string): Record<string, unknown> | null {
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink()) return null;
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function identityEmail(path: string): string | null {
	const oauth = readJsonObject(path)?.oauthAccount;
	if (typeof oauth !== "object" || oauth === null || Array.isArray(oauth)) {
		return null;
	}
	const email = (oauth as Record<string, unknown>).emailAddress;
	return typeof email === "string" && email.length > 0 ? email : null;
}

function pooledIdentityEmail(poolDir: string, name: string): string | null {
	const email = readJsonObject(
		join(poolDir, name, "oauthAccount.json"),
	)?.emailAddress;
	return typeof email === "string" && email.length > 0 ? email : null;
}

/**
 * Resolve the one account all machine witnesses agree on. Missing, corrupt, or
 * divergent witnesses are not guessed through: callers may act only on
 * `resolved`.
 */
export function resolveMachineAccount(
	opts: ResolveMachineAccountOptions,
): MachineAccountResolution {
	const activeMarker = readActiveProfileName(opts.poolDir);
	const ledgerAccount = opts.store.activeAccount;
	const email = identityEmail(opts.claudeJsonPath);
	const poolNames = listPoolAccounts(opts.poolDir);
	const tracked = new Set(opts.store.accounts.map((account) => account.name));

	if (email === null) {
		return {
			kind: "conflict",
			activeMarker,
			identityAccount: null,
			ledgerAccount,
		};
	}

	const identityMatches = poolNames.filter(
		(name) => pooledIdentityEmail(opts.poolDir, name) === email,
	);
	if (identityMatches.length !== 1) {
		return {
			kind: "untracked",
			identityEmail: email,
			activeMarker,
			ledgerAccount,
		};
	}
	const identityAccount = identityMatches[0] as string;
	if (
		!tracked.has(identityAccount) ||
		activeMarker === null ||
		ledgerAccount === null ||
		!tracked.has(activeMarker) ||
		!tracked.has(ledgerAccount)
	) {
		return {
			kind: "untracked",
			identityEmail: email,
			activeMarker,
			ledgerAccount,
		};
	}

	if (identityAccount !== activeMarker || identityAccount !== ledgerAccount) {
		return {
			kind: "conflict",
			activeMarker,
			identityAccount,
			ledgerAccount,
		};
	}

	return { kind: "resolved", name: identityAccount };
}
