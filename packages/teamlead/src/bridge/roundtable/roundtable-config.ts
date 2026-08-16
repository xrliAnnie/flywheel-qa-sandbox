/**
 * FLY-314 — testable env parsing for the roundtable auto-thread feature.
 *
 * FLY-1243: `FLYWHEEL_ROUNDTABLE_ENABLED` retired (固化 default-on). The
 * roundtable channel id (`FLYWHEEL_ROUNDTABLE_CHANNEL_ID`) is now the de-facto
 * switch: absent ⇒ `undefined` (byte-compat OFF for deployments that never
 * configured roundtable — QA slots / sub / joycon). Once the channel is set, the
 * remaining identity fields (bot token / bot user id) are REQUIRED — a missing
 * one throws (fail-loud, never run a half-configured poller). A bad trigger mode
 * degrades to `disabled` (warn) rather than bricking Bridge boot for a typo in an
 * optional feature.
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
	/** FLY-576: founder Discord id (from DISCORD_OWNER_USER_ID) — always pulled
	 * into each topic thread as a member, like issue threads' ownerUserId. Undefined
	 * when the env is unset/malformed (degrades to mentions-only; never throws). */
	founderUserId?: string;
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
	// FLY-1243: the channel id is the de-facto switch now that the ENABLED flag
	// is retired. Unset ⇒ this deployment never configured roundtable ⇒ OFF.
	const channelId = (env.FLYWHEEL_ROUNDTABLE_CHANNEL_ID ?? "").trim();
	if (!channelId) return undefined;
	const botTokenEnv = (env.FLYWHEEL_ROUNDTABLE_BOT_TOKEN_ENV ?? "").trim();
	const botToken = botTokenEnv ? (env[botTokenEnv] ?? "").trim() : "";
	const botUserId = (env.FLYWHEEL_ROUNDTABLE_BOT_USER_ID ?? "").trim();

	// channelId is guaranteed present here (the early return above is the switch);
	// once configured, the remaining identity fields are REQUIRED — fail-loud.
	const missing: string[] = [];
	if (!botTokenEnv) missing.push("FLYWHEEL_ROUNDTABLE_BOT_TOKEN_ENV");
	else if (!botToken)
		missing.push(`${botTokenEnv} (resolved token value is empty)`);
	if (!botUserId) missing.push("FLYWHEEL_ROUNDTABLE_BOT_USER_ID");
	if (missing.length > 0) {
		throw new Error(
			`[roundtable] FLYWHEEL_ROUNDTABLE_CHANNEL_ID set but required config missing: ${missing.join(", ")}`,
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

	// FLY-576: the founder is always pulled into each topic thread as a member —
	// reuse the SAME source the (already-working) issue threads use
	// (DISCORD_OWNER_USER_ID). Parsed fail-open: unset/malformed → undefined →
	// degrade to mentions-only membership, never throw. Only reached when the
	// feature is ENABLED (the early return above guards byte-compat OFF).
	const founderRaw = (env.DISCORD_OWNER_USER_ID ?? "").trim();
	const founderUserId = /^\d{17,20}$/.test(founderRaw) ? founderRaw : undefined;

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
		founderUserId,
		threadOwnBotMessages: false,
		pollIntervalMs,
		cursorPath,
	};
}
