/**
 * FLY-314 — testable env parsing for the roundtable auto-thread feature.
 *
 * Default OFF: `FLYWHEEL_ROUNDTABLE_ENABLED` must be exactly "1" to enable. When
 * enabled, the identity fields (channel / bot token / bot user id) are REQUIRED —
 * a missing one throws (fail-loud, never run a half-configured poller). A bad
 * trigger mode degrades to `disabled` (warn) rather than bricking Bridge boot for
 * a typo in an optional feature.
 *
 * `cursorPath` expands a leading `~` HERE (FileInboundCursorStore does not expand it).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type {
	RoundtableTriggerConfig,
	RoundtableTriggerMode,
} from "./topic-trigger.js";

export interface RoundtableConfig {
	channelId: string;
	botToken: string;
	botUserId: string;
	triggerMode: RoundtableTriggerMode;
	trigger: RoundtableTriggerConfig;
	memberUserIds: string[];
	/** FLY-314: thread the poller bot's OWN top-level messages too (echo relax). */
	threadOwnBotMessages: boolean;
	pollIntervalMs: number;
	cursorPath: string;
}

const VALID_MODES: ReadonlySet<RoundtableTriggerMode> = new Set([
	"disabled",
	"explicit_prefix",
	"any_lead_mention",
	"broadcast",
	"any_top_level",
]);

const DEFAULT_PREFIXES = ["📋", "TOPIC:"];
const DEFAULT_MIN_MENTIONS = 2;
const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_CURSOR_PATH = "~/.flywheel/roundtable-inbound-cursor.json";

export function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

function splitCsv(raw: string | undefined): string[] {
	return (raw ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

type Env = Record<string, string | undefined>;

/**
 * Parse the roundtable config from env. Returns `undefined` when the feature is
 * OFF (the byte-compat path — Bridge constructs no poller). Throws when enabled
 * but missing a required identity field.
 */
export function loadRoundtableConfig(env: Env): RoundtableConfig | undefined {
	if (env.FLYWHEEL_ROUNDTABLE_ENABLED !== "1") return undefined;

	const channelId = (env.FLYWHEEL_ROUNDTABLE_CHANNEL_ID ?? "").trim();
	const botTokenEnv = (env.FLYWHEEL_ROUNDTABLE_BOT_TOKEN_ENV ?? "").trim();
	const botToken = botTokenEnv ? (env[botTokenEnv] ?? "").trim() : "";
	const botUserId = (env.FLYWHEEL_ROUNDTABLE_BOT_USER_ID ?? "").trim();

	const missing: string[] = [];
	if (!channelId) missing.push("FLYWHEEL_ROUNDTABLE_CHANNEL_ID");
	if (!botTokenEnv) missing.push("FLYWHEEL_ROUNDTABLE_BOT_TOKEN_ENV");
	else if (!botToken)
		missing.push(`${botTokenEnv} (resolved token value is empty)`);
	if (!botUserId) missing.push("FLYWHEEL_ROUNDTABLE_BOT_USER_ID");
	if (missing.length > 0) {
		throw new Error(
			`[roundtable] FLYWHEEL_ROUNDTABLE_ENABLED=1 but required config missing: ${missing.join(", ")}`,
		);
	}

	const modeRaw = (
		env.FLYWHEEL_ROUNDTABLE_TRIGGER_MODE ?? "disabled"
	).trim() as RoundtableTriggerMode;
	let triggerMode: RoundtableTriggerMode = modeRaw;
	if (!VALID_MODES.has(modeRaw)) {
		console.warn(
			`[roundtable] unknown FLYWHEEL_ROUNDTABLE_TRIGGER_MODE="${modeRaw}" — defaulting to "disabled" (no threads opened)`,
		);
		triggerMode = "disabled";
	}

	const prefixesRaw = splitCsv(env.FLYWHEEL_ROUNDTABLE_TRIGGER_PREFIXES);
	const prefixes = prefixesRaw.length > 0 ? prefixesRaw : DEFAULT_PREFIXES;

	const minMentionsParsed = Number.parseInt(
		(env.FLYWHEEL_ROUNDTABLE_MIN_MENTIONS ?? "").trim(),
		10,
	);
	const minMentions =
		Number.isFinite(minMentionsParsed) && minMentionsParsed > 0
			? minMentionsParsed
			: DEFAULT_MIN_MENTIONS;

	const leadUserIds = splitCsv(env.FLYWHEEL_ROUNDTABLE_LEAD_USER_IDS);
	const memberUserIds = splitCsv(env.FLYWHEEL_ROUNDTABLE_MEMBER_USER_IDS);

	const pollParsed = Number.parseInt(
		(env.FLYWHEEL_ROUNDTABLE_POLL_INTERVAL_MS ?? "").trim(),
		10,
	);
	const pollIntervalMs =
		Number.isFinite(pollParsed) && pollParsed > 0
			? pollParsed
			: DEFAULT_POLL_INTERVAL_MS;

	const cursorPath = expandTilde(
		(env.FLYWHEEL_ROUNDTABLE_INBOUND_CURSOR_PATH ?? "").trim() ||
			DEFAULT_CURSOR_PATH,
	);

	return {
		channelId,
		botToken,
		botUserId,
		triggerMode,
		trigger: { mode: triggerMode, prefixes, minMentions, leadUserIds },
		memberUserIds,
		threadOwnBotMessages: env.FLYWHEEL_ROUNDTABLE_THREAD_OWN_BOT === "1",
		pollIntervalMs,
		cursorPath,
	};
}
