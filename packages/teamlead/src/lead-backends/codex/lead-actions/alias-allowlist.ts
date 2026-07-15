/**
 * FLY-350 — lead-actions MCP channel-alias allowlist (pure, fail-closed).
 *
 * The lead-actions MCP's `discord_send` tool takes a target
 * ALIAS ("chat" | "roundtable"), NEVER a raw channel id. This module resolves an
 * alias to a concrete channel id SERVER-SIDE (inside the out-of-sandbox MCP
 * child), so the model can only ever post to the channels the Lead is configured
 * for — it cannot smuggle an arbitrary channel id through the tool argument.
 *
 * Fail-closed semantics (R3#4 + code-review R2 HIGH-1):
 *   - ONLY "chat" / "roundtable" are valid targets — the approved-alias gate runs
 *     FIRST, so an explicit pin can never introduce a NEW alias name.
 *   - "chat" → the Lead's own chat channel. A "chat" pin, if present, must EQUAL
 *     the configured chat channel (it cannot redirect "chat" elsewhere).
 *   - "roundtable" → the single configured cross-department channel. If ZERO or
 *     MULTIPLE cross-dept channels are configured the bare "roundtable" alias is
 *     AMBIGUOUS and REJECTED — the operator must pin it
 *     (`FLYWHEEL_LEAD_ACTIONS_CHANNEL_ALIASES=roundtable:<id>`), and the pinned id
 *     MUST be one of the configured cross-dept channels (a pin disambiguates the
 *     set, it never points outside it).
 *   - any unrecognized alias, or a value that looks like a raw channel id (all
 *     digits) rather than an alias, → throws (the model must use an alias).
 *
 * Pure + dependency-free → exhaustively unit-tested. The MCP assembly glue
 * (lead-actions-main) calls this before every send.
 */

export interface ChannelAliasConfig {
	/** The Lead's own chat channel id (alias "chat"). */
	chatChannelId: string;
	/** Configured cross-department channel ids (alias "roundtable" when exactly one). */
	crossDeptChannelIds: string[];
	/**
	 * Optional explicit alias→channelId pins (from
	 * `FLYWHEEL_LEAD_ACTIONS_CHANNEL_ALIASES`). Pins only DISAMBIGUATE an APPROVED
	 * alias ("chat"/"roundtable") and are themselves constrained: a "roundtable"
	 * pin must be one of `crossDeptChannelIds`, a "chat" pin must equal
	 * `chatChannelId`. A pin can NEVER introduce a new alias name or point the
	 * model at a channel outside the configured set (R2 HIGH-1).
	 */
	explicitAliases?: Readonly<Record<string, string>>;
}

/** Error thrown when an alias cannot be resolved fail-closed. */
export class AliasResolutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AliasResolutionError";
	}
}

/** A channel id is a Discord snowflake — all digits. The model must NOT pass one
 * as a target (it must use an alias); this guards against that. */
function looksLikeRawChannelId(value: string): boolean {
	return /^\d{5,}$/.test(value);
}

/** The ONLY target aliases the model may pass. An explicit pin can ONLY
 * disambiguate one of these — it can never introduce a new alias name (R2 HIGH-1:
 * an explicit `dms:<id>` must NOT widen the send surface). */
export const APPROVED_ALIASES = ["chat", "roundtable"] as const;

/**
 * Resolve a model-supplied target alias to a concrete channel id, fail-closed.
 * Throws `AliasResolutionError` on anything ambiguous or unrecognized — the MCP
 * tool maps that to a tool error, never a silent wrong-channel send.
 *
 * The approved-alias check comes FIRST (R2 HIGH-1): only "chat"/"roundtable" are
 * ever valid targets. Explicit pins are consulted ONLY to disambiguate those, and
 * the pinned value is itself constrained — a "chat" pin must equal the configured
 * chat channel, a "roundtable" pin must be one of the configured cross-dept
 * channels — so an explicit map can never point the model at an arbitrary channel.
 */
export function resolveChannelAlias(
	target: string,
	cfg: ChannelAliasConfig,
): string {
	const alias = typeof target === "string" ? target.trim() : "";
	if (!alias) {
		throw new AliasResolutionError("target alias is required");
	}
	if (looksLikeRawChannelId(alias)) {
		throw new AliasResolutionError(
			`target must be an alias ("chat" | "roundtable"), not a raw channel id (${alias})`,
		);
	}
	// APPROVED-ALIAS GATE FIRST — an explicit pin can never introduce a new name.
	if (!(APPROVED_ALIASES as readonly string[]).includes(alias)) {
		throw new AliasResolutionError(
			`unknown target alias "${alias}" (allowed: ${APPROVED_ALIASES.map((a) => `"${a}"`).join(", ")})`,
		);
	}

	if (alias === "chat") {
		if (!cfg.chatChannelId) {
			throw new AliasResolutionError("chat channel id is not configured");
		}
		// A "chat" pin is allowed ONLY if it equals the configured chat channel
		// (it cannot redirect "chat" elsewhere — fail-closed).
		const pin = cfg.explicitAliases?.chat;
		if (pin !== undefined && pin !== cfg.chatChannelId) {
			throw new AliasResolutionError(
				`explicit "chat" pin (${pin}) does not match the configured chat channel (${cfg.chatChannelId}) — a pin cannot redirect "chat" (fail-closed)`,
			);
		}
		return cfg.chatChannelId;
	}

	// alias === "roundtable"
	const ids = cfg.crossDeptChannelIds ?? [];
	const pin = cfg.explicitAliases?.roundtable;
	if (pin !== undefined) {
		// A "roundtable" pin MUST be one of the configured cross-dept channels —
		// it disambiguates a multi-channel list, it never points outside it.
		if (!ids.includes(pin)) {
			throw new AliasResolutionError(
				`explicit "roundtable" pin (${pin}) is not one of the configured cross-department channels [${ids.join(", ")}] (fail-closed)`,
			);
		}
		return pin;
	}
	if (ids.length === 1) return ids[0]!;
	if (ids.length === 0) {
		throw new AliasResolutionError(
			'no cross-department channel configured — "roundtable" is unavailable ' +
				"(set FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS, or pin it via " +
				"FLYWHEEL_LEAD_ACTIONS_CHANNEL_ALIASES=roundtable:<id> where the id is " +
				"one of the configured cross-dept channels)",
		);
	}
	throw new AliasResolutionError(
		`"roundtable" is ambiguous — ${ids.length} cross-department channels are ` +
			"configured; pin the intended one (from that set) with " +
			"FLYWHEEL_LEAD_ACTIONS_CHANNEL_ALIASES=roundtable:<id>",
	);
}

/** Parse `FLYWHEEL_LEAD_ACTIONS_CHANNEL_ALIASES=a:1,b:2` into a map. Malformed
 * pairs are skipped (never throws — a bad alias config must not crash the MCP at
 * parse time; an unresolved alias fails closed at call time instead). */
export function parseExplicitAliases(
	raw: string | undefined,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const pair of (raw ?? "").split(",")) {
		const trimmed = pair.trim();
		if (!trimmed) continue;
		const idx = trimmed.indexOf(":");
		if (idx <= 0) continue;
		const name = trimmed.slice(0, idx).trim();
		const id = trimmed.slice(idx + 1).trim();
		if (name && id) out[name] = id;
	}
	return out;
}
