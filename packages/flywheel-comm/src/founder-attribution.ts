/**
 * FLY-945 Fix D/E — the SINGLE definition of "who counts as a founder-side
 * approval writer" on an approve_to_ship gate response.
 *
 * Trusted `response.from_agent` values:
 *   - the canonical founder Discord id (FLY-799 text / ✅-reaction writes);
 *   - "bridge"                 — dashboard `/api/actions/approve`
 *                                (approveExecution; the endpoint itself is
 *                                governed by the FLY-175 contract/enforce);
 *   - "bridge-founder-consent" — the FLY-175 enforce-path gate-response
 *                                router after a PASSING founder-consent
 *                                evaluation (Fix E writes this attribution).
 *
 * Everything else — a Lead id (respond.ts pass-through / audit_only), the
 * FLY-605 non-gated relay agent ("founder-bridge-auto", which must never
 * appear on a ship gate), an unknown writer — is NOT founder-attributed.
 *
 * Consumed by:
 *   - flywheel-comm verify-approval (Fix E read-side gate);
 *   - the Bridge's external-merge reconcile (Fix D path 2 narrow recovery).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const TRUSTED_BRIDGE_APPROVAL_WRITERS = new Set([
	"bridge",
	"bridge-founder-consent",
]);

const FOUNDER_ID_KEY = "DISCORD_OWNER_USER_ID";
const ATTRIBUTION_GATE_KEY = "FLYWHEEL_FOUNDER_ATTRIBUTION_GATE";

/** True when `from` is a founder-side approval writer. */
export function isTrustedApprovalAttribution(
	from: string | undefined,
	founderId: string | undefined,
): boolean {
	if (!from) return false;
	if (TRUSTED_BRIDGE_APPROVAL_WRITERS.has(from)) return true;
	return !!founderId && from === founderId;
}

const DISCORD_SNOWFLAKE_RE = /^\d{17,20}$/;

/**
 * FLY-945 Fix E (Codex code R1 HIGH): the trusted set above is only meaningful
 * if untrusted callers cannot WRITE those names. `flywheel-comm respond
 * --lead <x>` and the gate-response router's `leadId` are caller-controlled —
 * without this guard, `--lead bridge` / `--lead bridge-founder-consent` /
 * `--lead <founder snowflake>` would forge a verify-passable approval and
 * re-open the Lead self-approval door.
 *
 * Reserved = the exact bridge writer names, plus ANYTHING shaped like a
 * Discord snowflake (the founder id's shape — real Lead agent ids are names
 * like "flywheel-eng-lead", never bare 17-20-digit numbers, so this rejects
 * founder-id spoofing without having to resolve the id at every call site).
 * Every caller-controlled approve_to_ship write path must refuse these; only
 * server-internal writers (approveExecution → "bridge", the FLY-799 gate
 * writer → the verified founder id, the enforce-path router →
 * "bridge-founder-consent") may use them.
 */
export function isReservedApprovalAttribution(from: string): boolean {
	return (
		TRUSTED_BRIDGE_APPROVAL_WRITERS.has(from) || DISCORD_SNOWFLAKE_RE.test(from)
	);
}

/**
 * Read the last uncommented `KEY=` value from `.env` content (same local
 * parser verify-approval uses for the codex hard gate — no cross-package dep).
 */
function readEnvValueFromContent(
	content: string,
	key: string,
): string | undefined {
	const re = new RegExp(`^\\s*(?:export\\s+)?${key}=(.*)$`);
	let val: string | undefined;
	for (const line of content.split("\n")) {
		if (/^\s*#/.test(line)) continue;
		const m = line.match(re);
		if (m) val = m[1];
	}
	return val;
}

/**
 * Resolve the canonical founder Discord id, LIVE from `~/.flywheel/.env`
 * (FLY-827 pattern: a runner CLI's inherited process.env is a stale spawn
 * snapshot). Precedence: explicit test env (key present) → `.env` →
 * inherited process env. Returns undefined when unconfigured — callers
 * treat that as feature-off (documented honest boundary: a project without
 * a Discord founder cannot be attribution-gated).
 */
export function resolveFounderId(args: {
	argsEnv?: NodeJS.ProcessEnv;
	processEnv: NodeJS.ProcessEnv;
	dotenvPath?: string;
}): string | undefined {
	if (args.argsEnv && FOUNDER_ID_KEY in args.argsEnv) {
		return args.argsEnv[FOUNDER_ID_KEY]?.trim() || undefined;
	}
	const path = args.dotenvPath ?? join(homedir(), ".flywheel", ".env");
	try {
		const content = readFileSync(path, "utf-8");
		const v = readEnvValueFromContent(content, FOUNDER_ID_KEY)?.trim();
		if (v) return v;
	} catch {
		/* fall through */
	}
	return args.processEnv[FOUNDER_ID_KEY]?.trim() || undefined;
}

/**
 * FLY-945 Fix E kill-switch. Precedence:
 *   1. explicit test env (key present in argsEnv);
 *   2. PROCESS env (key present) — this is how QA rooms bypass: slots share
 *      the production `~/.flywheel/.env` (which resolves a real founder id),
 *      so an env-file-first read could never be slot-overridden. Production
 *      never spawns with this key set, so the codex-gate stale-snapshot
 *      re-arm hazard does not apply here;
 *   3. `~/.flywheel/.env` (live; key-absent = ON);
 *   4. unreadable `.env` → ON (default).
 */
export function resolveFounderAttributionGateOn(args: {
	argsEnv?: NodeJS.ProcessEnv;
	processEnv: NodeJS.ProcessEnv;
	dotenvPath?: string;
}): boolean {
	if (args.argsEnv && ATTRIBUTION_GATE_KEY in args.argsEnv) {
		return args.argsEnv[ATTRIBUTION_GATE_KEY] !== "0";
	}
	if (ATTRIBUTION_GATE_KEY in args.processEnv) {
		return args.processEnv[ATTRIBUTION_GATE_KEY] !== "0";
	}
	const path = args.dotenvPath ?? join(homedir(), ".flywheel", ".env");
	try {
		const content = readFileSync(path, "utf-8");
		return readEnvValueFromContent(content, ATTRIBUTION_GATE_KEY) !== "0";
	} catch {
		return true;
	}
}
