/**
 * FLY-871 R1/C2 — pool token freshness helper (probe-refresh guard).
 *
 * Roots out the 2026-07-04 logout incident: the switch executor wrote a STALE
 * pooled credential (its OAuth refresh-token family had been rotated out) into
 * the machine Keychain, logging out every live session. The guard: before a
 * NON-ACTIVE target is written to the Keychain, probe-refresh its pooled token
 * (OAuth `refresh_token` grant). Success → the ROTATED credential is written
 * back to the pool FIRST (else the guard itself would strand the switch), then
 * the caller switches. Refusal / error → the credential is treated as stale and
 * the caller must NOT switch to it (fail-closed).
 *
 * RED LINES (structural, asserted by tests — not just prose):
 *   - NEVER probe-refresh the ACTIVE account: its live session owns that token
 *     family, so a pool-side refresh would rotate it out from under a running
 *     session = re-create the incident. `verifyPoolCredential` THROWS when
 *     `name === activeName` (no fetch, no write). Callers additionally guard.
 *   - No static-ok pass: a future `expiresAt` is NOT trusted (the incident class
 *     is family-rotation, not access-token expiry). `expiresAt` is telemetry only.
 *   - The refresh_token never enters any process argv — this helper reads the
 *     credential FILE itself; only non-secret names cross the CLI boundary.
 *   - Fail-closed on anything unexpected (missing file, bad JSON, non-2xx,
 *     network error, timeout, invalid response) → `stale`, pool byte-unchanged.
 */

import {
	closeSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";

/**
 * The documented Claude Code OAuth refresh endpoint + public client id (research
 * R-2). Env-overridable so the enablement-gate spike (S1) can pin the exact
 * contract WITHOUT a code change; a mismatch there fails closed (stale), never
 * a bad Keychain write. The client id is a public constant (embedded in the
 * Claude Code binary); no client_secret is used (public client + PKCE only at
 * first authorization, not on refresh).
 */
export const DEFAULT_REFRESH_ENDPOINT =
	"https://console.anthropic.com/v1/oauth/token";
export const DEFAULT_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const DEFAULT_TIMEOUT_MS = 10_000;

export type FreshnessVerdict =
	| { fresh: "refreshed"; expiresAt: number | null }
	| { fresh: "stale"; reason: string };

export interface VerifyPoolCredentialOpts {
	/** The pool profile to verify (its credential is probe-refreshed). */
	name: string;
	/** The currently-active account (.active) — NEVER pool-refreshed. */
	activeName: string | null;
	/** Pool root (FLYWHEEL_CLAUDE_PROFILES_DIR). */
	poolDir: string;
	/** Injectable for tests; defaults to global fetch. */
	fetchImpl?: typeof fetch;
	/** Injectable clock for the new expiresAt (default Date.now). */
	now?: () => number;
	/** OAuth token endpoint (default DEFAULT_REFRESH_ENDPOINT / env override). */
	refreshEndpoint?: string;
	/** OAuth public client id (default DEFAULT_OAUTH_CLIENT_ID / env override). */
	clientId?: string;
	/** Bounded network timeout in ms (default DEFAULT_TIMEOUT_MS). */
	timeoutMs?: number;
}

/** Thrown when asked to refresh the ACTIVE account — a structural red line. */
export class ActiveAccountRefreshRefused extends Error {
	constructor(name: string) {
		super(
			`refusing to pool-refresh the ACTIVE account '${name}' — its live session owns the token family (FLY-871 red line)`,
		);
		this.name = "ActiveAccountRefreshRefused";
	}
}

function credPath(poolDir: string, name: string): string {
	return join(poolDir, name, ".credentials.json");
}

/** Read + parse the pooled credential, refusing a symlinked file (tamper). */
function readPooledCredential(
	file: string,
): { raw: string; oauth: Record<string, unknown> } | null {
	let st: ReturnType<typeof lstatSync>;
	try {
		st = lstatSync(file);
	} catch {
		return null; // missing
	}
	if (st.isSymbolicLink() || !st.isFile()) return null; // fail-closed
	let raw: string;
	try {
		raw = readFileSync(file, "utf-8");
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	const oauth = (parsed as Record<string, unknown>).claudeAiOauth;
	if (oauth === null || typeof oauth !== "object" || Array.isArray(oauth)) {
		return null;
	}
	return { raw, oauth: oauth as Record<string, unknown> };
}

/** Atomically write the rotated credential back (0600, temp+fsync+rename). */
function writeBack(file: string, credObject: unknown): void {
	// Compact JSON only — bash kc_write refuses any whitespace (single-token
	// `security -i` rule). JSON.stringify with no spacer is compact.
	const body = JSON.stringify(credObject);
	const tmp = `${file}.fly871.${process.pid}`;
	const fd = openSync(tmp, "w", 0o600);
	try {
		writeSync(fd, body);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		renameSync(tmp, file);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			/* best-effort cleanup */
		}
		throw err;
	}
}

/**
 * Probe-refresh a pooled credential. Never touches the active account. On
 * success the rotated credential is written back BEFORE the verdict resolves.
 */
export async function verifyPoolCredential(
	opts: VerifyPoolCredentialOpts,
): Promise<FreshnessVerdict> {
	const {
		name,
		activeName,
		poolDir,
		fetchImpl = fetch,
		now = Date.now,
		refreshEndpoint = process.env.FLYWHEEL_CLAUDE_OAUTH_ENDPOINT ??
			DEFAULT_REFRESH_ENDPOINT,
		clientId = process.env.FLYWHEEL_CLAUDE_OAUTH_CLIENT_ID ??
			DEFAULT_OAUTH_CLIENT_ID,
		timeoutMs = DEFAULT_TIMEOUT_MS,
	} = opts;

	// RED LINE: never pool-refresh the active account — throw BEFORE any file
	// read or network call. Callers must also guard; this is the last-resort
	// structural stop.
	if (activeName !== null && name === activeName) {
		throw new ActiveAccountRefreshRefused(name);
	}

	const file = credPath(poolDir, name);
	const pooled = readPooledCredential(file);
	if (!pooled) {
		return { fresh: "stale", reason: "pooled credential missing / unreadable" };
	}
	const refreshToken = pooled.oauth.refreshToken;
	if (typeof refreshToken !== "string" || refreshToken.length === 0) {
		return { fresh: "stale", reason: "no refresh_token in pooled credential" };
	}

	// Bounded probe-refresh — the refresh_token travels in the request BODY, never
	// in argv or a URL. AbortSignal enforces the timeout.
	//
	// Codex R1 HIGH: the timeout MUST stay armed through the BODY read, not just
	// the headers. Clearing the timer before `resp.json()` left the body unbounded
	// — a server returning 200 headers then stalling the body would hang the helper
	// INSIDE the bash `use` critical section while the Node parent holds
	// claude-accounts.lock (which withMkdirLock breaks after 120s even with a LIVE
	// holder → another switch could interleave and double-write the Keychain). The
	// abort signal cancels the body stream too, so a stalled `resp.json()` rejects
	// on timeout → stale. So fetch + json() run inside ONE try and the timer is
	// cleared only in the finally that wraps both.
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	let payload: unknown;
	try {
		const resp = await fetchImpl(refreshEndpoint, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: clientId,
			}),
			signal: controller.signal,
		});
		if (!resp.ok) {
			return {
				fresh: "stale",
				reason: `refresh refused (HTTP ${resp.status})`,
			};
		}
		payload = await resp.json(); // bounded by the SAME signal (abort cancels body)
	} catch (err) {
		return {
			fresh: "stale",
			reason: `refresh request failed: ${err instanceof Error ? err.name : "error"}`,
		};
	} finally {
		clearTimeout(timer);
	}

	if (payload === null || typeof payload !== "object") {
		return { fresh: "stale", reason: "refresh response not an object" };
	}
	const p = payload as Record<string, unknown>;
	const newAccess = p.access_token;
	const newRefresh = p.refresh_token;
	const expiresIn = p.expires_in;
	if (
		typeof newAccess !== "string" ||
		newAccess.length === 0 ||
		typeof newRefresh !== "string" ||
		newRefresh.length === 0
	) {
		// The refresh_token family rotates: a response without BOTH new tokens is
		// unusable → stale (never write a half-rotated credential).
		return {
			fresh: "stale",
			reason: "refresh response missing rotated tokens",
		};
	}
	// Codex R1 MED: the OAuth refresh contract REQUIRES a finite POSITIVE
	// expires_in. A missing / non-finite / non-positive value is a malformed
	// response — treat it as stale (never write a credential with no expiresAt,
	// which would defeat downstream freshness reasoning, nor an already-expired one).
	if (
		typeof expiresIn !== "number" ||
		!Number.isFinite(expiresIn) ||
		expiresIn <= 0
	) {
		return {
			fresh: "stale",
			reason: "refresh response missing/invalid expires_in",
		};
	}
	const newExpiresAt = now() + Math.floor(expiresIn) * 1000;

	// Write the ROTATED credential back to the pool FIRST — preserve every other
	// field of claudeAiOauth, only swap the rotated three. Then return fresh.
	const nextOauth: Record<string, unknown> = {
		...pooled.oauth,
		accessToken: newAccess,
		refreshToken: newRefresh,
		expiresAt: newExpiresAt,
	};
	try {
		writeBack(file, { claudeAiOauth: nextOauth });
	} catch (err) {
		// We rotated the family on the server but couldn't persist it — the OLD
		// pooled refresh_token is now dead. Report stale (don't switch): the next
		// candidate is tried, and this account is flagged for re-login.
		return {
			fresh: "stale",
			reason: `rotated on server but pool write-back failed: ${
				err instanceof Error ? err.message : String(err)
			}`,
		};
	}
	return { fresh: "refreshed", expiresAt: newExpiresAt };
}
