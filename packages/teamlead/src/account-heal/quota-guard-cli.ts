import { fileURLToPath } from "node:url";
import {
	defaultStorePath,
	earliestReset,
	isAuthUnusable,
	isQuotaUsable,
	readStore,
	recordObservationInStore,
	syncActiveAccountInStore,
} from "./account-store.js";
import { type LeaseProof, validateLeaseProof } from "./mkdir-lock.js";
import { readPoolMonitorCredential } from "./quota-monitor-credentials.js";
import {
	type AccountUsageResult,
	fetchAccountUsage,
} from "./quota-usage-api.js";

export interface QuotaGuardCliDeps {
	now?: () => number;
	readCredential?: typeof readPoolMonitorCredential;
	fetchUsage?: (accessToken: string) => Promise<AccountUsageResult>;
	log?: (message: string) => void;
}

interface GuardArgs {
	name?: string;
	pool?: string;
	store?: string;
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
		}
	}
	return out;
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
	const window =
		usage.sevenD.pct >= 100
			? `weekly resets ${usage.sevenD.resetsAt}`
			: `5h resets ${usage.fiveH.resetsAt}`;
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
	lines.push(
		"Emergency override: FLYWHEEL_CLAUDE_QUOTA_BYPASS=1 (logged + alerts the Lead)",
	);
	return lines.join("\n");
}

/** Pure CLI entry: 0=quota available, 32=exhausted, 33=unknown/error. */
export async function runQuotaGuardCli(
	argv: string[],
	deps: QuotaGuardCliDeps = {},
): Promise<number> {
	const log =
		deps.log ?? ((message: string) => process.stderr.write(`${message}\n`));
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
			"usage: quota-guard check --name <target> --pool <dir> [--store <path>] | active-sync --name <active> [--store <path>]",
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
