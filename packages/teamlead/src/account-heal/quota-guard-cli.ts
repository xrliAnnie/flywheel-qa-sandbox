import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	compareAccountIdentity,
	type ExpectedAccountIdentity,
	expectedIdentityDigest,
	fetchProfileIdentity,
	identityDigest,
	type ProfileIdentityResult,
} from "./account-identity.js";
import {
	defaultStorePath,
	earliestReset,
	isAuthUnusable,
	isQuotaUsable,
	readStore,
	readStoreStrict,
	recordObservationInStore,
	syncActiveAccountInStore,
	syncFreshenedActiveAccountInStore,
	writeStore,
} from "./account-store.js";
import { type AccountsLock, withAccountsLock } from "./accounts-lock.js";
import { type LeaseProof, validateLeaseProof } from "./mkdir-lock.js";
import type { QuotaMonitorAlert } from "./quota-monitor.js";
import {
	type DeliveryReport,
	sendQuotaMonitorAlert,
} from "./quota-monitor-alert.js";
import {
	type PoolMonitorCredentialSnapshot,
	readPoolMonitorCredential,
	readPoolMonitorCredentialSnapshot,
} from "./quota-monitor-credentials.js";
import {
	type AccountUsageResult,
	fetchAccountUsage,
} from "./quota-usage-api.js";

export interface QuotaGuardCliDeps {
	now?: () => number;
	readCredential?: typeof readPoolMonitorCredential;
	readCredentialSnapshot?: typeof readPoolMonitorCredentialSnapshot;
	fetchUsage?: (accessToken: string) => Promise<AccountUsageResult>;
	fetchIdentity?: (accessToken: string) => Promise<ProfileIdentityResult>;
	readStdin?: () => string;
	withAccountsLock?: AccountsLock;
	lockPath?: string;
	alert?: (alert: QuotaMonitorAlert) => Promise<DeliveryReport>;
	log?: (message: string) => void;
}

interface GuardArgs {
	name?: string;
	pool?: string;
	store?: string;
	email?: string;
	uuid?: string;
}

function leaseFenceFromEnv(): (() => boolean) | null {
	const raw = process.env.FLYWHEEL_LEASE_PROOF;
	if (!raw) return null;
	try {
		const proof = JSON.parse(raw) as LeaseProof;
		return () => validateLeaseProof(proof);
	} catch {
		return () => false;
	}
}

function parseArgs(argv: string[]): GuardArgs {
	const out: GuardArgs = {};
	for (let index = 1; index < argv.length; index++) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (flag === "--name") {
			out.name = value;
			index++;
		} else if (flag === "--pool") {
			out.pool = value;
			index++;
		} else if (flag === "--store") {
			out.store = value;
			index++;
		} else if (flag === "--email") {
			out.email = value;
			index++;
		} else if (flag === "--uuid") {
			out.uuid = value;
			index++;
		}
	}
	return out;
}

function parseStrictActiveSyncArgs(
	argv: string[],
): { name: string; store?: string } | null {
	let name: string | undefined;
	let store: string | undefined;
	let freshened = false;
	const seen = new Set<string>();
	for (let index = 1; index < argv.length; index++) {
		const flag = argv[index] as string;
		if (seen.has(flag)) return null;
		seen.add(flag);
		if (flag === "--freshened") {
			freshened = true;
			continue;
		}
		if (flag !== "--name" && flag !== "--store") return null;
		const value = argv[++index];
		if (!value || value.startsWith("--")) return null;
		if (flag === "--name") name = value;
		else store = value;
	}
	return name && freshened ? { name, ...(store ? { store } : {}) } : null;
}

function readFreshenedIdentityProof(
	deps: QuotaGuardCliDeps,
): { email: string; uuid?: string } | null {
	const raw = (deps.readStdin ?? (() => readFileSync(0, "utf8")))();
	if (Buffer.byteLength(raw) > 4096) return null;
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const keys = Object.keys(parsed).sort();
		if (
			keys.some((key) => key !== "email" && key !== "uuid") ||
			typeof parsed.email !== "string"
		) {
			return null;
		}
		const email = validEmail(parsed.email);
		const uuid =
			typeof parsed.uuid === "string"
				? parsed.uuid.trim().toLowerCase()
				: undefined;
		if (email === null || (parsed.uuid !== undefined && !uuid)) return null;
		return { email, ...(uuid ? { uuid } : {}) };
	} catch {
		return null;
	}
}

function defaultAccountsLockPath(): string {
	return (
		process.env.FLYWHEEL_CLAUDE_ACCOUNTS_LOCK ??
		join(homedir(), ".flywheel", "claude-accounts.lock")
	);
}

function safeAccessToken(raw: string): string | null {
	const token = raw.trim();
	return token.length > 0 && !/\s/.test(token) ? token : null;
}

function validEmail(raw: string): string | null {
	const email = raw.trim().toLowerCase();
	return /^[^\s@]+@[^\s@]+$/.test(email) ? email : null;
}

async function runIdentityVerify(
	argv: string[],
	deps: QuotaGuardCliDeps,
	log: (message: string) => void,
): Promise<number> {
	const { name, store } = parseArgs(argv);
	const storePath = store ?? defaultStorePath();
	if (!name) {
		log("identity verify: missing target name");
		return 35;
	}
	const accountStore = readStoreStrict(storePath);
	const matching = accountStore?.accounts.filter(
		(entry) => entry.name === name,
	);
	const expected = matching?.length === 1 ? matching[0]?.identity : undefined;
	if (!expected) {
		log(`identity verify: expected identity unavailable for '${name}'`);
		return 35;
	}
	const token = safeAccessToken(
		(deps.readStdin ?? (() => readFileSync(0, "utf8")))(),
	);
	if (token === null) {
		log("identity verify: credential unavailable");
		return 35;
	}

	let result: ProfileIdentityResult;
	try {
		result = await (deps.fetchIdentity ?? fetchProfileIdentity)(token);
	} catch {
		result = { error: "profile_network" };
	}
	if ("error" in result) {
		log(`identity verify: ${result.error}`);
		return result.error === "profile_unauthorized" ? 38 : 35;
	}
	const comparison = compareAccountIdentity(expected, result);
	if (comparison === "match") {
		log(
			`identity verify: match for '${name}' expectedKey=${expectedIdentityDigest(expected)}`,
		);
		return 0;
	}
	log(
		`identity verify: mismatch for '${name}' expectedKey=${expectedIdentityDigest(expected)} actualDigest=${identityDigest(result)}`,
	);
	return 34;
}

type IdentitySetResult =
	| "set"
	| "invalid_input"
	| "invalid_store"
	| "missing_account"
	| "write_failed";

async function runIdentitySet(
	argv: string[],
	deps: QuotaGuardCliDeps,
	log: (message: string) => void,
): Promise<number> {
	const { name, email: rawEmail, uuid: rawUuid, store } = parseArgs(argv);
	const email = rawEmail === undefined ? null : validEmail(rawEmail);
	const uuid = rawUuid?.trim().toLowerCase();
	if (!name || email === null || (rawUuid !== undefined && !uuid)) {
		log("identity set: invalid input");
		return 33;
	}
	const storePath = store ?? defaultStorePath();
	const lockPath = deps.lockPath ?? defaultAccountsLockPath();
	const lock = deps.withAccountsLock ?? withAccountsLock;
	const result = await lock<IdentitySetResult>(lockPath, async () => {
		const current = readStoreStrict(storePath);
		if (current === null) return "invalid_store";
		const matches = current.accounts
			.map((entry, index) => ({ entry, index }))
			.filter(({ entry }) => entry.name === name);
		if (matches.length !== 1) return "missing_account";
		const selected = matches[0];
		if (!selected) return "missing_account";
		current.accounts[selected.index] = {
			...selected.entry,
			identity: {
				email,
				...(uuid ? { uuid } : {}),
				setAt: new Date((deps.now ?? Date.now)()).toISOString(),
			},
		};
		try {
			writeStore(current, storePath);
			return "set";
		} catch {
			return "write_failed";
		}
	});
	if (result.kind !== "ok") {
		log(`identity set: lock result=${result.kind}`);
		return 33;
	}
	log(`identity set: result=${result.value}; name=${name}`);
	return result.value === "set" ? 0 : 33;
}

interface IdentityAuditSnapshot {
	name: string;
	expected: ExpectedAccountIdentity;
	expectedDigest: string;
	credential: PoolMonitorCredentialSnapshot;
}

type IdentityAuditProbe = IdentityAuditSnapshot & {
	result: ProfileIdentityResult;
};

type IdentityAuditStatus =
	| "match"
	| "mismatch"
	| "unknown_missing"
	| "profile_network"
	| "profile_malformed"
	| "profile_unauthorized"
	| "fingerprint_changed";

function auditExit(statuses: IdentityAuditStatus[]): number {
	if (statuses.includes("mismatch")) return 34;
	if (statuses.includes("profile_unauthorized")) return 38;
	if (statuses.some((status) => status !== "match")) return 35;
	return 0;
}

async function runIdentityAudit(
	argv: string[],
	deps: QuotaGuardCliDeps,
	log: (message: string) => void,
): Promise<number> {
	const { pool, store } = parseArgs(argv);
	if (!pool) {
		log("identity audit: missing pool path");
		return 35;
	}
	const shouldMark = argv.includes("--mark");
	const storePath = store ?? defaultStorePath();
	const lockPath = deps.lockPath ?? defaultAccountsLockPath();
	const lock = deps.withAccountsLock ?? withAccountsLock;
	const readSnapshot =
		deps.readCredentialSnapshot ?? readPoolMonitorCredentialSnapshot;

	const first = await lock<{
		snapshots: IdentityAuditSnapshot[];
		statuses: Map<string, IdentityAuditStatus>;
	}>(lockPath, async () => {
		const current = readStoreStrict(storePath);
		if (current === null) {
			return {
				snapshots: [],
				statuses: new Map([["store", "profile_malformed" as const]]),
			};
		}
		const snapshots: IdentityAuditSnapshot[] = [];
		const statuses = new Map<string, IdentityAuditStatus>();
		for (const account of current.accounts) {
			if (account.identity === undefined) {
				statuses.set(account.name, "unknown_missing");
				continue;
			}
			const credential = readSnapshot(pool, account.name);
			if (credential === null) {
				statuses.set(account.name, "unknown_missing");
				continue;
			}
			snapshots.push({
				name: account.name,
				expected: account.identity,
				expectedDigest: expectedIdentityDigest(account.identity),
				credential,
			});
		}
		return { snapshots, statuses };
	});
	if (first.kind !== "ok") {
		log(`identity audit: first lock result=${first.kind}`);
		return 35;
	}

	const probes: IdentityAuditProbe[] = [];
	for (const snapshot of first.value.snapshots) {
		let result: ProfileIdentityResult;
		try {
			result = await (deps.fetchIdentity ?? fetchProfileIdentity)(
				snapshot.credential.accessToken,
			);
		} catch {
			result = { error: "profile_network" };
		}
		probes.push({ ...snapshot, result });
	}

	const second = await lock<{
		statuses: Map<string, IdentityAuditStatus>;
		writeFailed: boolean;
	}>(lockPath, async () => {
		const current = readStoreStrict(storePath);
		if (current === null) {
			return {
				statuses: new Map([["store", "profile_malformed" as const]]),
				writeFailed: false,
			};
		}
		const statuses = new Map(first.value.statuses);
		let changed = false;
		for (const probe of probes) {
			const matches = current.accounts
				.map((entry, index) => ({ entry, index }))
				.filter(({ entry }) => entry.name === probe.name);
			const selected = matches.length === 1 ? matches[0] : undefined;
			const credential = readSnapshot(pool, probe.name);
			if (
				selected === undefined ||
				selected.entry.identity === undefined ||
				credential === null ||
				credential.rawDigest !== probe.credential.rawDigest ||
				expectedIdentityDigest(selected.entry.identity) !== probe.expectedDigest
			) {
				statuses.set(probe.name, "fingerprint_changed");
				continue;
			}
			if ("error" in probe.result) {
				statuses.set(probe.name, probe.result.error);
				continue;
			}
			const comparison = compareAccountIdentity(
				selected.entry.identity,
				probe.result,
			);
			statuses.set(probe.name, comparison);
			if (!shouldMark) continue;
			if (comparison === "mismatch") {
				selected.entry.identityMismatch = {
					actualDigest: identityDigest(probe.result),
					markedBy: "audit",
					markedAt: new Date((deps.now ?? Date.now)()).toISOString(),
				};
				changed = true;
			} else if (selected.entry.identityMismatch !== undefined) {
				const { identityMismatch: _, ...withoutMismatch } = selected.entry;
				current.accounts[selected.index] = withoutMismatch;
				changed = true;
			}
		}
		if (!changed) return { statuses, writeFailed: false };
		try {
			writeStore(current, storePath);
			return { statuses, writeFailed: false };
		} catch {
			return { statuses, writeFailed: true };
		}
	});
	if (second.kind !== "ok" || second.value.writeFailed) {
		log(
			`identity audit: second lock result=${second.kind}${second.kind === "ok" ? "; write_failed=true" : ""}`,
		);
		return 35;
	}
	for (const [name, status] of second.value.statuses) {
		log(`identity audit: name=${name}; result=${status}`);
	}
	return auditExit([...second.value.statuses.values()]);
}

const REPORT_LABEL = /^(?!\.)(?!.*\.\.)[A-Za-z0-9._-]+$/;
const REPORT_DIGEST = /^[a-f0-9]{64}$/;
const REPORT_CHECKPOINTS = new Set(["pre_write", "capture_back", "capture"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function runIdentityAlertFlush(
	deps: QuotaGuardCliDeps,
	log: (message: string) => void,
): Promise<number> {
	let value: unknown;
	try {
		value = JSON.parse((deps.readStdin ?? (() => readFileSync(0, "utf8")))());
	} catch {
		log("identity alert flush: ignored malformed report");
		return 0;
	}
	if (!isRecord(value) || !Array.isArray(value.identityChecks)) {
		log("identity alert flush: ignored malformed report");
		return 0;
	}
	const alert = deps.alert ?? ((input) => sendQuotaMonitorAlert(input));
	let index = 0;
	for (const check of value.identityChecks) {
		if (
			!isRecord(check) ||
			check.verdict !== "mismatch" ||
			typeof check.label !== "string" ||
			!REPORT_LABEL.test(check.label) ||
			typeof check.checkpoint !== "string" ||
			!REPORT_CHECKPOINTS.has(check.checkpoint) ||
			typeof check.expectedKey !== "string" ||
			!REPORT_DIGEST.test(check.expectedKey) ||
			typeof check.actualDigest !== "string" ||
			!REPORT_DIGEST.test(check.actualDigest)
		) {
			continue;
		}
		try {
			await alert({
				kind: "account_identity_mismatch",
				severity: "severe",
				title: "Claude account identity does not match its label",
				body: `label=${check.label}; checkpoint=${check.checkpoint}; expectedKey=${check.expectedKey}; actualDigest=${check.actualDigest}; source=manual`,
				signature: `account-identity-mismatch-manual-${check.label}-${check.actualDigest}-${(deps.now ?? Date.now)()}-${index}`,
			});
		} catch {
			log(`identity alert flush: delivery failed for label=${check.label}`);
		}
		index += 1;
	}
	return 0;
}

function ageText(ageMs: number): string {
	const minutes = Math.max(0, Math.floor(ageMs / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

function refusalMessage(
	name: string,
	usage: Extract<AccountUsageResult, { ok: unknown }>["ok"],
	storePath: string,
	nowMs: number,
): string {
	const store = readStore(storePath);
	// Reached only when a window is at 100%, so an open window is implied and a
	// null reset is a contract violation — say so instead of printing "null".
	const window =
		usage.sevenD.pct >= 100
			? `weekly resets ${usage.sevenD.resetsAt ?? "reset unavailable"}`
			: `5h resets ${usage.fiveH.resetsAt ?? "reset unavailable"}`;
	const lines = [
		`REFUSED: target '${name}' has no quota — 5h ${usage.fiveH.pct}% / 7d ${usage.sevenD.pct}% (${window})`,
		"Pool status (last observed by quota daemon or guard):",
	];

	const candidates: Array<{ name: string; observedAtMs: number; age: string }> =
		[];
	for (const entry of store.accounts) {
		const observedAtMs = entry.lastObservedAt
			? Date.parse(entry.lastObservedAt)
			: Number.NaN;
		const fiveHPct = entry.observedFiveHPct;
		const sevenDPct = entry.observedSevenDPct;
		const hasObservation =
			!Number.isNaN(observedAtMs) &&
			typeof fiveHPct === "number" &&
			typeof sevenDPct === "number";
		if (!hasObservation) {
			lines.push(
				`  ${entry.name}  ${entry.quotaExhaustedUntil ? `exhausted until ${entry.quotaExhaustedUntil}` : "(no observation data)"}`,
			);
			continue;
		}
		const ageMs = nowMs - observedAtMs;
		const stale = ageMs > 24 * 60 * 60_000;
		const age = ageText(ageMs);
		const exhausted = entry.quotaExhaustedUntil
			? ` exhausted until ${entry.quotaExhaustedUntil}`
			: "";
		lines.push(
			`  ${entry.name}  5h ${fiveHPct}% / 7d ${sevenDPct}%  ${stale ? "(stale) " : ""}observed ${age} ago${exhausted}`,
		);
		if (
			!stale &&
			!isAuthUnusable(entry) &&
			isQuotaUsable(entry, nowMs) &&
			fiveHPct < 100 &&
			sevenDPct < 100
		) {
			candidates.push({ name: entry.name, observedAtMs, age });
		}
	}

	candidates.sort((left, right) => right.observedAtMs - left.observedAtMs);
	const suggestion = candidates[0];
	if (suggestion) {
		lines.push(
			`Suggestion: flywheel-claude-profile use ${suggestion.name} (last observed with quota ${suggestion.age} ago; the command will re-verify)`,
		);
	} else {
		lines.push(
			`No recently observed account can be recommended; earliest reset: ${earliestReset(store) ?? "unknown"}`,
		);
	}
	return lines.join("\n");
}

/** Pure CLI entry: 0=quota available, 32=exhausted, 33=unknown/error. */
export async function runQuotaGuardCli(
	argv: string[],
	deps: QuotaGuardCliDeps = {},
): Promise<number> {
	const log =
		deps.log ?? ((message: string) => process.stderr.write(`${message}\n`));
	if (argv[0] === "identity-verify") {
		return runIdentityVerify(argv, deps, log);
	}
	if (argv[0] === "identity-set") {
		return runIdentitySet(argv, deps, log);
	}
	if (argv[0] === "identity-audit") {
		return runIdentityAudit(argv, deps, log);
	}
	if (argv[0] === "identity-alert-flush") {
		return runIdentityAlertFlush(deps, log);
	}
	if (argv[0] === "active-sync-strict") {
		const args = parseStrictActiveSyncArgs(argv);
		const proof = args ? readFreshenedIdentityProof(deps) : null;
		if (!args || !proof) {
			log("quota guard active-sync-strict: invalid input");
			return 47;
		}
		const fence = leaseFenceFromEnv();
		if (fence && !fence()) {
			log("FLYWHEEL_LOCK_LEASE_LOST active-sync-strict fenced");
			return 39;
		}
		const result = syncFreshenedActiveAccountInStore(
			args.store ?? defaultStorePath(),
			args.name,
			proof,
		);
		log(`quota guard active-sync-strict: result=${result}; name=${args.name}`);
		return result === "synced" || result === "noop" ? 0 : 47;
	}
	if (argv[0] === "active-sync") {
		const { name, store } = parseArgs(argv);
		const fence = leaseFenceFromEnv();
		if (fence && !fence()) {
			log("FLYWHEEL_LOCK_LEASE_LOST active-sync fenced");
			return 39;
		}
		const result =
			name && store
				? syncActiveAccountInStore(store, name)
				: name
					? syncActiveAccountInStore(defaultStorePath(), name)
					: "invalid_name";
		log(`quota guard active-sync: result=${result}; name=${name ?? "missing"}`);
		// This is a post-commit repair seam: Keychain remains authoritative and a
		// projection failure must never roll back an otherwise successful switch.
		return 0;
	}
	if (argv[0] !== "check") {
		log(
			"usage: quota-guard check --name <target> --pool <dir> [--store <path>] | active-sync --name <active> [--store <path>] | active-sync-strict --name <active> [--store <path>] --freshened | identity-verify --name <target> [--store <path>] | identity-set --name <target> --email <email> [--uuid <uuid>] [--store <path>] | identity-audit [--mark] --pool <dir> [--store <path>] | identity-alert-flush",
		);
		return 33;
	}
	const { name, pool, store } = parseArgs(argv);
	if (!name || !pool) {
		log("quota guard: missing --name / --pool");
		return 33;
	}

	const now = deps.now ?? Date.now;
	const credentialCheckedAtMs = now();
	const credential = (deps.readCredential ?? readPoolMonitorCredential)(
		pool,
		name,
	);
	if (credential === null || credential.expiresAt <= credentialCheckedAtMs) {
		log(`quota guard: credential missing or expired for '${name}'`);
		return 33;
	}

	let usage: AccountUsageResult;
	try {
		usage = await (deps.fetchUsage ?? fetchAccountUsage)(
			credential.accessToken,
		);
	} catch {
		log("quota guard: usage lookup failed: network");
		return 33;
	}
	if (!("ok" in usage)) {
		log(`quota guard: usage lookup failed: ${usage.error}`);
		return 33;
	}
	// The observation is the completed API response, not the request start. A
	// daemon write may land while the network request is in flight; stamping the
	// result afterward keeps last-observed-wins ordered by when facts were known.
	const observedAtMs = now();

	const storePath = store ?? defaultStorePath();
	const fence = leaseFenceFromEnv();
	if (fence && !fence()) {
		log("FLYWHEEL_LOCK_LEASE_LOST quota projection fenced");
		return 39;
	}
	const projection = recordObservationInStore(storePath, name, {
		fiveHPct: usage.ok.fiveH.pct,
		sevenDPct: usage.ok.sevenD.pct,
		fiveHResetAt: usage.ok.fiveH.resetsAt,
		sevenDResetAt: usage.ok.sevenD.resetsAt,
		observedAt: new Date(observedAtMs).toISOString(),
	});
	if (projection !== "updated" && projection !== "older_observation") {
		log(`quota guard: store projection failed: ${projection}`);
		return 33;
	}

	if (usage.ok.fiveH.pct >= 100 || usage.ok.sevenD.pct >= 100) {
		log(refusalMessage(name, usage.ok, storePath, observedAtMs));
		return 32;
	}
	return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	runQuotaGuardCli(process.argv.slice(2))
		.then((code) => process.exit(code))
		.catch(() => process.exit(33));
}
