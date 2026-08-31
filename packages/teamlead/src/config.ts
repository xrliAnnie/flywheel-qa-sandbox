import { homedir } from "node:os";
import { join } from "node:path";
import { isAllowedLoopbackHostname } from "flywheel-comm/lead-lease";
import { normalizeOptionalBearer } from "flywheel-config";
import { parseFounderConsentConfig } from "./bridge/founder-consent/config.js";
import { RunnerAdmissionController } from "./bridge/runner-admission.js";
import type { BridgeConfig } from "./bridge/types.js";

export type { BridgeConfig };

function parsePositiveInt(
	value: string | undefined,
	fallback: number,
	name: string,
): number {
	if (value === undefined) return fallback;
	const n = parseInt(value, 10);
	if (!Number.isFinite(n) || n < 1) {
		throw new Error(`Invalid ${name}: ${value} (must be a positive integer)`);
	}
	return n;
}

export function loadConfig(): BridgeConfig {
	const host = process.env.TEAMLEAD_HOST ?? "127.0.0.1";
	if (!isAllowedLoopbackHostname(host)) {
		throw new Error(
			`TEAMLEAD_HOST must be loopback (127.0.0.1, localhost, or ::1), got: ${host}`,
		);
	}

	const port = parseInt(process.env.TEAMLEAD_PORT ?? "9876", 10);
	if (!Number.isFinite(port) || port < 1 || port > 65535) {
		throw new Error(`Invalid TEAMLEAD_PORT: ${process.env.TEAMLEAD_PORT}`);
	}

	const stuckThresholdMinutes = parsePositiveInt(
		process.env.TEAMLEAD_STUCK_THRESHOLD,
		15,
		"TEAMLEAD_STUCK_THRESHOLD",
	);
	const orphanThresholdMinutes = parsePositiveInt(
		process.env.TEAMLEAD_ORPHAN_THRESHOLD,
		60,
		"TEAMLEAD_ORPHAN_THRESHOLD",
	);
	if (orphanThresholdMinutes <= stuckThresholdMinutes) {
		throw new Error(
			`TEAMLEAD_ORPHAN_THRESHOLD (${orphanThresholdMinutes}) must be greater than TEAMLEAD_STUCK_THRESHOLD (${stuckThresholdMinutes})`,
		);
	}

	// FLY-162: reply-by-issue routes post as the Discord bot. If the feature
	// is enabled but TEAMLEAD_API_TOKEN is missing/empty, the routes would be
	// exposed unauthenticated — fail-startup rather than emit a warning. See
	// plan §4.3 + Codex Round 2 issue #2.
	const apiTokenRaw = process.env.TEAMLEAD_API_TOKEN;
	if (apiTokenRaw !== undefined && apiTokenRaw !== apiTokenRaw.trim()) {
		throw new Error(
			"TEAMLEAD_API_TOKEN must not contain outer whitespace (trim the configured value; refusing to start)",
		);
	}
	const apiToken = normalizeOptionalBearer(apiTokenRaw);
	const ingestToken = normalizeOptionalBearer(
		process.env.TEAMLEAD_INGEST_TOKEN,
	);
	if (apiToken && ingestToken && apiToken === ingestToken) {
		throw new Error(
			"TEAMLEAD_INGEST_TOKEN must differ from TEAMLEAD_API_TOKEN (refusing to start)",
		);
	}
	const replyByIssueEnabled =
		process.env.TEAMLEAD_REPLY_BY_ISSUE_ENABLED === "true";
	if (replyByIssueEnabled && (!apiToken || apiToken.length === 0)) {
		throw new Error(
			"TEAMLEAD_REPLY_BY_ISSUE_ENABLED=true requires TEAMLEAD_API_TOKEN to be set (refusing to expose Discord bot post route unauthenticated)",
		);
	}

	// FLY-162 Layer 2: reply-guard route classifies a Lead's chat channel /
	// threads to decide whether a plugin reply may post issue content at the
	// top level. Like reply-by-issue, the route must not be exposed
	// unauthenticated — fail-startup if enabled without a token.
	const replyGuardEnabled = process.env.TEAMLEAD_REPLY_GUARD_ENABLED === "true";
	if (replyGuardEnabled && (!apiToken || apiToken.length === 0)) {
		throw new Error(
			"TEAMLEAD_REPLY_GUARD_ENABLED=true requires TEAMLEAD_API_TOKEN to be set (refusing to expose the reply-guard route unauthenticated)",
		);
	}
	// FLY-1018 M4: scoped token for the gemini-agent tool surface. Two
	// fail-closed rules (plan §4, Codex R1-2):
	//   - scoped == master → the "scoped" credential is a full-privilege
	//     token in disguise; boot-time refusal is the only place that
	//     window can be closed. Error names both envs.
	//   - scoped set but master unset → today's middleware no-ops without a
	//     master token (everything already unauthenticated), so scoping is
	//     meaningless; log ERROR and IGNORE rather than inventing a new
	//     bare-token posture.
	const geminiAgentTokenRaw = process.env.TEAMLEAD_GEMINI_AGENT_TOKEN;
	let geminiAgentToken: string | undefined;
	const scoped = normalizeOptionalBearer(geminiAgentTokenRaw);
	if (scoped) {
		if (apiToken && scoped === apiToken) {
			throw new Error(
				"TEAMLEAD_GEMINI_AGENT_TOKEN must differ from TEAMLEAD_API_TOKEN — a scoped token equal to the master token is a full-privilege credential in disguise (refusing to start)",
			);
		}
		if (!apiToken) {
			console.error(
				"[config] ERROR: TEAMLEAD_GEMINI_AGENT_TOKEN is set but TEAMLEAD_API_TOKEN is not — scoped token IGNORED (without a master token the /api surface is unauthenticated; configure TEAMLEAD_API_TOKEN first)",
			);
		} else {
			if (ingestToken && scoped === ingestToken) {
				throw new Error(
					"TEAMLEAD_GEMINI_AGENT_TOKEN must differ from TEAMLEAD_INGEST_TOKEN (refusing to start)",
				);
			}
			geminiAgentToken = scoped;
		}
	}

	// FLY-2076: the duty surface is deliberately isolated from every existing
	// Bridge credential. Claw receives this bearer and no broader API token.
	const alertDutyToken = normalizeOptionalBearer(
		process.env.FLYWHEEL_ALERT_DUTY_TOKEN,
	);
	if (alertDutyToken) {
		const collisions: Array<[string, string | undefined]> = [
			["TEAMLEAD_API_TOKEN", apiToken],
			["TEAMLEAD_INGEST_TOKEN", ingestToken],
			["TEAMLEAD_GEMINI_AGENT_TOKEN", geminiAgentToken],
		];
		for (const [name, token] of collisions) {
			if (token && token === alertDutyToken) {
				throw new Error(
					`FLYWHEEL_ALERT_DUTY_TOKEN must differ from ${name} (refusing to start)`,
				);
			}
		}
	}

	// Configured team prefixes the guard counts as issue tokens (default
	// FLY,GEO). Normalized to uppercase; empties dropped.
	const issuePrefixes = (process.env.TEAMLEAD_ISSUE_PREFIXES ?? "FLY,GEO")
		.split(",")
		.map((s) => s.trim().toUpperCase())
		.filter((s) => s.length > 0);
	// Codex code-review LOW: when the guard is enabled, an empty or
	// unscannable prefix list silently disables enforcement (the scanner
	// requires `[A-Za-z]{2,}` — see reply-guard.ts). Fail-startup instead of
	// running a guard that can never match.
	if (replyGuardEnabled) {
		if (issuePrefixes.length === 0) {
			throw new Error(
				"TEAMLEAD_REPLY_GUARD_ENABLED=true but TEAMLEAD_ISSUE_PREFIXES is empty after parsing — the guard would never match any issue token",
			);
		}
		const bad = issuePrefixes.filter((p) => !/^[A-Z]{2,}$/.test(p));
		if (bad.length > 0) {
			throw new Error(
				`TEAMLEAD_ISSUE_PREFIXES contains prefixes the scanner can never match (need >=2 letters, A-Z only): ${bad.join(", ")}`,
			);
		}
	}

	return {
		host,
		port,
		dbPath:
			process.env.TEAMLEAD_DB_PATH ??
			join(homedir(), ".flywheel", "teamlead.db"),
		ingestToken,
		apiToken,
		alertDutyToken,
		notificationChannel:
			process.env.TEAMLEAD_NOTIFICATION_CHANNEL ?? "CD5QZVAP6",
		defaultLeadAgentId: (() => {
			const val = process.env.TEAMLEAD_DEFAULT_LEAD_AGENT?.trim();
			if (!val) {
				throw new Error(
					"TEAMLEAD_DEFAULT_LEAD_AGENT is required and must identify one canonical Lead",
				);
			}
			return val;
		})(),
		stuckThresholdMinutes,
		stuckCheckIntervalMs: parsePositiveInt(
			process.env.TEAMLEAD_STUCK_INTERVAL,
			300_000,
			"TEAMLEAD_STUCK_INTERVAL",
		),
		orphanThresholdMinutes,
		discordBotToken: process.env.DISCORD_BOT_TOKEN,
		linearApiKey: process.env.LINEAR_API_KEY,
		discordGuildId: process.env.DISCORD_GUILD_ID,
		// FLY-123 WS-D (P4): the TEAMLEAD_MAX_CONCURRENT_RUNNERS hard cap is
		// retired. Admission is pure resource pressure (load + memory), tunable
		// via FLYWHEEL_RUNNER_LOAD_PER_CORE / FLYWHEEL_RUNNER_MIN_FREE_MEM_MB.
		runnerAdmission: RunnerAdmissionController.fromEnv(),
		// FLY-91: Chat thread feature flag (env: TEAMLEAD_CHAT_THREADS_ENABLED=true)
		chatThreadsEnabled: process.env.TEAMLEAD_CHAT_THREADS_ENABLED === "true",
		discordOwnerUserId: process.env.DISCORD_OWNER_USER_ID,
		// FLY-162: Reply-by-issue routes feature flag (env: TEAMLEAD_REPLY_BY_ISSUE_ENABLED=true).
		// Validation (must have apiToken) happens above.
		replyByIssueEnabled,
		// FLY-162 Layer 2: reply-guard route feature flag + configured issue
		// prefixes. Validation (must have apiToken) happens above.
		replyGuardEnabled,
		issuePrefixes,
		// FLY-175 Track 2: mandatory production founder-consent policy. Identity
		// resolves from canonical DISCORD_OWNER_USER_ID (with a compatibility
		// fallback), and the decision mode is permanently audit_only.
		founderConsent: parseFounderConsentConfig(process.env),
		// FLY-1018 M4: scoped gemini-agent token (validated above; undefined
		// when unset, invalid-without-master, or blank — byte-compatible).
		geminiAgentToken,
	};
}
