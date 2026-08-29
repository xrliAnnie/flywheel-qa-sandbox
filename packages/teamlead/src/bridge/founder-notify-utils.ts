/**
 * FLY-605: shared helpers for the bidirectional founder ↔ runner in-thread relay
 * fallback (Part A founder-thread-notifier + Part B founder-reply-deliverer).
 */

/**
 * Parse a SQLite `datetime('now', …)` value ("YYYY-MM-DD HH:MM:SS", UTC) to
 * epoch ms. ISO-8601 strings (already containing "T") pass through Date.parse
 * unchanged — we MUST NOT append a second "Z" to them (Codex R1 #5). Returns
 * null for anything unparsable so callers fail safe.
 *
 * Mirrors the verified semantics of `parseSqliteUtcMs` in
 * `flywheel-comm/src/commands/verify-lifecycle-consent.ts` (kept local to avoid
 * a new cross-package export for a one-line helper).
 */
export function parseSqliteUtcMs(
	value: string | null | undefined,
): number | null {
	if (!value || typeof value !== "string") return null;
	const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
	const ms = Date.parse(iso);
	return Number.isNaN(ms) ? null : ms;
}

/**
 * A Discord snowflake id is a 17–20 digit decimal string. `DISCORD_OWNER_USER_ID`
 * is raw env (`config.ts`), so validate before using it in `allowed_mentions`
 * (a malformed value makes Discord reject the POST with 400) or for founder
 * author-matching (Codex R2 #4).
 */
export function isDiscordSnowflake(
	id: string | undefined | null,
): id is string {
	return typeof id === "string" && /^\d{17,20}$/.test(id);
}

/** Truncate to `max` chars, appending an ellipsis marker when cut. */
export function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1)}…`;
}

/** Discord snowflake epoch (2015-01-01T00:00:00Z) in ms. */
const DISCORD_EPOCH_MS = 1_420_070_400_000;

/** Epoch ms a Discord snowflake id was created (its high 42 bits encode the time). */
export function snowflakeToMs(id: string): number | null {
	try {
		return Number(BigInt(id) >> 22n) + DISCORD_EPOCH_MS;
	} catch {
		return null;
	}
}

/**
 * Smallest snowflake id at-or-after `epochMs` — used as the `?after=` lower
 * bound so a first-run thread scan starts from the oldest pending question's
 * creation time (NOT baseline-to-latest, which would miss already-posted founder
 * replies — Codex R1 #2). `after` is exclusive, so subtract 1ms to include a
 * reply sent at exactly that instant.
 */
export function msToSnowflakeLowerBound(epochMs: number): string {
	const clamped = Math.max(0, Math.floor(epochMs) - 1 - DISCORD_EPOCH_MS);
	return (BigInt(clamped) << 22n).toString();
}
