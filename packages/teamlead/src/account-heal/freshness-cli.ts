/**
 * FLY-871 R1/C2 — the freshness helper CLI, invoked by `flywheel-claude-profile
 * use` inside its Keychain-write critical section (bash shells out to it before
 * writing a NON-ACTIVE target). Contract is EXIT-CODE based (no secrets on the
 * wire): the credential is read from the pool file by the helper itself; only
 * non-secret names cross this boundary.
 *
 *   verify --name <target> --active <active-or-empty> --pool <poolDir>
 *
 * Exit codes (bash maps these — see flywheel-claude-profile `freshness_guard`):
 *   0  → refreshed (pool credential rotated + written back; safe to switch)
 *   30 → stale     (refresh refused/failed → DON'T switch; try a candidate)
 *   31 → error     (bad usage / active-refusal / unexpected → fail-closed)
 */

import { fileURLToPath } from "node:url";
import { verifyPoolCredential } from "./freshness.js";

export interface FreshnessCliDeps {
	verify?: typeof verifyPoolCredential;
	log?: (msg: string) => void;
}

function parseArgs(argv: string[]): {
	name?: string;
	active?: string;
	pool?: string;
} {
	const out: { name?: string; active?: string; pool?: string } = {};
	for (let i = 1; i < argv.length; i++) {
		const flag = argv[i];
		const val = argv[i + 1];
		if (flag === "--name") {
			out.name = val;
			i++;
		} else if (flag === "--active") {
			out.active = val;
			i++;
		} else if (flag === "--pool") {
			out.pool = val;
			i++;
		}
	}
	return out;
}

/** Pure entry — returns the process exit code. Never throws. */
export async function runFreshnessCli(
	argv: string[],
	deps: FreshnessCliDeps = {},
): Promise<number> {
	const verify = deps.verify ?? verifyPoolCredential;
	const log = deps.log ?? ((m: string) => process.stderr.write(`${m}\n`));

	if (argv[0] !== "verify") {
		log("usage: freshness verify --name <t> --active <a> --pool <dir>");
		return 31;
	}
	const { name, active, pool } = parseArgs(argv);
	if (!name || pool === undefined) {
		log("freshness: missing --name / --pool");
		return 31;
	}
	try {
		const verdict = await verify({
			name,
			// empty string → no active account
			activeName: active && active.length > 0 ? active : null,
			poolDir: pool,
		});
		if (verdict.fresh === "refreshed") return 0;
		log(`freshness: '${name}' is STALE — ${verdict.reason}`);
		return 30;
	} catch (err) {
		// Active-account refusal or any unexpected error → fail-closed (31).
		log(
			`freshness: refusing '${name}' — ${err instanceof Error ? err.message : String(err)}`,
		);
		return 31;
	}
}

// Direct execution (`node freshness-cli.js verify …`).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	runFreshnessCli(process.argv.slice(2))
		.then((code) => process.exit(code))
		.catch(() => process.exit(31));
}
