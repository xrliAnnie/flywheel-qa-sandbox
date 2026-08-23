/**
 * FLY-945 Fix D/E — the SINGLE definition of "who counts as a founder-side
 * approval writer" on an approve_to_ship gate response.
 *
 * Trusted `response.from_agent` values:
 *   - the canonical founder Discord id (FLY-799 text / ✅-reaction writes);
 *   - "bridge"                 — dashboard `/api/actions/approve`
 *                                (approveExecution; the endpoint itself is
 *                                governed by the FLY-175 contract/enforce);
 *   - "bridge-founder-consent" — historical FLY-175 enforce-path rows only;
 *                                FLY-1981 forbids fresh writes while retaining
 *                                read-side trust for existing approvals.
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
const LEGACY_FOUNDER_ID_KEY = "FLYWHEEL_FOUNDER_USER_ID";
const FOUNDER_ID_MISMATCH_ERROR =
	"Founder identity mismatch: DISCORD_OWNER_USER_ID does not match the configured founder identity; remove the founder override or set it to the same Discord user ID";

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
 * server-internal writers (approveExecution → "bridge" and the FLY-799 gate
 * writer → the verified founder id) may use active names. The historical
 * "bridge-founder-consent" name remains reserved but cannot be minted anew.
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
 * Resolve one source's founder identity using the same policy as Teamlead's
 * founder-consent config: canonical first, legacy fallback, mismatch rejected.
 * Values are deliberately omitted from the error because they are identities.
 */
function resolveFounderIdFromSource(
	canonicalRaw: string | undefined,
	legacyRaw: string | undefined,
): string | undefined {
	const canonical = canonicalRaw?.trim() || undefined;
	const legacy = legacyRaw?.trim() || undefined;
	if (canonical && legacy && canonical !== legacy) {
		throw new Error(FOUNDER_ID_MISMATCH_ERROR);
	}
	return canonical ?? legacy;
}

/**
 * Resolve the canonical founder Discord id, LIVE from `~/.flywheel/.env`
 * (FLY-827 pattern: a runner CLI's inherited process.env is a stale spawn
 * snapshot). Precedence: explicit test env (either identity key present) →
 * `.env` → inherited process env. Canonical and legacy values are always
 * evaluated together within one source; values from different precedence
 * layers are never combined. Returns undefined when unconfigured — callers
 * retain the documented honest boundary for projects without a Discord founder.
 */
export function resolveFounderId(args: {
	argsEnv?: NodeJS.ProcessEnv;
	processEnv: NodeJS.ProcessEnv;
	dotenvPath?: string;
}): string | undefined {
	if (
		args.argsEnv &&
		(FOUNDER_ID_KEY in args.argsEnv || LEGACY_FOUNDER_ID_KEY in args.argsEnv)
	) {
		return resolveFounderIdFromSource(
			args.argsEnv[FOUNDER_ID_KEY],
			args.argsEnv[LEGACY_FOUNDER_ID_KEY],
		);
	}
	const path = args.dotenvPath ?? join(homedir(), ".flywheel", ".env");
	let dotenvContent: string | undefined;
	try {
		dotenvContent = readFileSync(path, "utf-8");
	} catch {
		/* missing/unreadable dotenv falls through */
	}
	if (dotenvContent !== undefined) {
		const dotenvFounderId = resolveFounderIdFromSource(
			readEnvValueFromContent(dotenvContent, FOUNDER_ID_KEY),
			readEnvValueFromContent(dotenvContent, LEGACY_FOUNDER_ID_KEY),
		);
		if (dotenvFounderId) return dotenvFounderId;
	}
	return resolveFounderIdFromSource(
		args.processEnv[FOUNDER_ID_KEY],
		args.processEnv[LEGACY_FOUNDER_ID_KEY],
	);
}
