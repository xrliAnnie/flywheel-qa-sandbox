import { execFile as nodeExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ProfileIdentity } from "./account-identity.js";
import type { MonitorCredential } from "./quota-monitor.js";

const execFileAsync = promisify(nodeExecFile);
const PROFILE_NAME = /^(?!\.)(?!.*\.\.)[A-Za-z0-9._-]+$/;

type ExecFileFn = (
	file: string,
	args: string[],
) => Promise<{ stdout: string; stderr: string }>;

export interface KeychainCredentialOptions {
	securityBin?: string;
	account?: string;
	service?: string;
	keychain?: string;
	execFile?: ExecFileFn;
}

export interface PoolMonitorCredentialSnapshot extends MonitorCredential {
	/** SHA-256 of the exact credential file bytes used for the probe. */
	rawDigest: string;
}

function parseMonitorCredential(raw: string): MonitorCredential | null {
	try {
		const parsed = JSON.parse(raw) as {
			claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown };
		};
		const accessToken = parsed?.claudeAiOauth?.accessToken;
		const expiresAt = parsed?.claudeAiOauth?.expiresAt;
		if (
			typeof accessToken !== "string" ||
			accessToken.length === 0 ||
			typeof expiresAt !== "number" ||
			!Number.isFinite(expiresAt)
		) {
			return null;
		}
		return { accessToken, expiresAt };
	} catch {
		return null;
	}
}

export async function readKeychainMonitorCredential(
	opts: KeychainCredentialOptions = {},
): Promise<MonitorCredential | null> {
	const exec = opts.execFile ?? (execFileAsync as ExecFileFn);
	const args = [
		"find-generic-password",
		"-a",
		opts.account ??
			process.env.FLYWHEEL_CLAUDE_KEYCHAIN_ACCOUNT ??
			process.env.USER ??
			"",
		"-s",
		opts.service ??
			process.env.FLYWHEEL_CLAUDE_KEYCHAIN_SERVICE ??
			"Claude Code-credentials",
		"-w",
	];
	const keychain = opts.keychain ?? process.env.FLYWHEEL_CLAUDE_KEYCHAIN;
	if (keychain) args.push(keychain);
	try {
		const { stdout } = await exec(
			opts.securityBin ??
				process.env.FLYWHEEL_CLAUDE_SECURITY_BIN ??
				"security",
			args,
		);
		const raw = stdout.trim();
		const credential = parseMonitorCredential(raw);
		return credential === null
			? null
			: {
					...credential,
					rawDigest: createHash("sha256").update(raw).digest("hex"),
				};
	} catch {
		return null;
	}
}

function readRegularFile(path: string): string | null {
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink()) return null;
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

export function readPoolMonitorCredential(
	poolDir: string,
	name: string,
): MonitorCredential | null {
	const snapshot = readPoolMonitorCredentialSnapshot(poolDir, name);
	return snapshot === null
		? null
		: { accessToken: snapshot.accessToken, expiresAt: snapshot.expiresAt };
}

export function readPoolMonitorCredentialSnapshot(
	poolDir: string,
	name: string,
): PoolMonitorCredentialSnapshot | null {
	if (!PROFILE_NAME.test(name)) return null;
	try {
		const profileStat = lstatSync(join(poolDir, name));
		if (!profileStat.isDirectory() || profileStat.isSymbolicLink()) return null;
	} catch {
		return null;
	}
	const raw = readRegularFile(join(poolDir, name, ".credentials.json"));
	if (raw === null) return null;
	const credential = parseMonitorCredential(raw);
	return credential === null
		? null
		: {
				...credential,
				rawDigest: createHash("sha256").update(raw).digest("hex"),
			};
}

export function readActiveProfileName(poolDir: string): string | null {
	const raw = readRegularFile(join(poolDir, ".active"));
	if (raw === null) return null;
	const name = raw.trim();
	return PROFILE_NAME.test(name) ? name : null;
}

export function listPoolAccounts(poolDir: string): string[] {
	try {
		return readdirSync(poolDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && PROFILE_NAME.test(entry.name))
			.map((entry) => entry.name)
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
}

/** Read the trusted, immutable identity anchor for one concrete pool profile. */
export function readPoolProfileIdentity(
	poolDir: string,
	name: string,
): ProfileIdentity | null {
	if (!PROFILE_NAME.test(name)) return null;
	try {
		const profileStat = lstatSync(join(poolDir, name));
		if (!profileStat.isDirectory() || profileStat.isSymbolicLink()) return null;
		const path = join(poolDir, name, "identity-anchor.json");
		const stat = lstatSync(path);
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			![0o400, 0o600].includes(stat.mode & 0o777) ||
			(process.getuid !== undefined && stat.uid !== process.getuid())
		) {
			return null;
		}
		const value = JSON.parse(readFileSync(path, "utf8")) as Record<
			string,
			unknown
		>;
		const keys = Object.keys(value).sort();
		const expected = [
			"accountUuid",
			"anchoredAt",
			"anchoredBy",
			"confirmedBy",
			"email",
		].sort();
		if (
			keys.length !== expected.length ||
			keys.some((key, index) => key !== expected[index]) ||
			Object.values(value).some(
				(item) =>
					typeof item !== "string" ||
					item.length === 0 ||
					Array.from(item).some((character) => {
						const code = character.charCodeAt(0);
						return code < 32 || code === 127;
					}),
			)
		) {
			return null;
		}
		const uuid = String(value.accountUuid).trim().toLowerCase();
		const email = String(value.email).trim().toLowerCase();
		if (!uuid || !email) return null;
		return { uuid, email };
	} catch {
		return null;
	}
}

export function resolvePoolProfileIdentity(
	poolDir: string,
	identity: ProfileIdentity,
): string | null {
	const matches = listPoolAccounts(poolDir).filter((name) => {
		const anchored = readPoolProfileIdentity(poolDir, name);
		return (
			anchored?.uuid === identity.uuid && anchored.email === identity.email
		);
	});
	return matches.length === 1 ? matches[0]! : null;
}
