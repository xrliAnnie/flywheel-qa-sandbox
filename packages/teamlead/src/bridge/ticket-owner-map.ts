/**
 * FLY-927 (Task 2.1): kind → OWNER map for the alert ticket queue.
 *
 * Iron laws (PRD §10.0 CH-1, Annie 2026-07-06 locked):
 *  - ONE owner per ticket — exactly one bot is @-mentioned; the other never
 *    touches it (the FLY-267 mention-gate enforces "not @'d ⇒ hands off").
 *  - Nobody rescues their own side — Claude account/auth problems @ the CODEX
 *    bot, Codex account/auth problems @ the CLAUDE bot (cross assignment;
 *    server-side `actorBackend !== provider` enforces it on the action route).
 *  - Provider-agnostic problems (stuck / throttle-stall / infra) default to
 *    the CLAUDE bot (the resident workhorse, CMP-2).
 *
 * Owner env ids unset ⇒ `userId: null` ⇒ the caller renders the label without
 * a ping. The ticket remains NEW for explicit duty handling.
 */

import type { AlertEventType } from "../LeadAlertNotifier.js";

export type TicketProvider = "claude" | "codex" | "unknown";

export type TicketOwner =
	| { kind: "infra_bot"; side: "claude" | "codex"; userId: string | null }
	| { kind: "lead"; leadId: string }
	| { kind: "none" };

export interface OwnerRegistry {
	/** FLYWHEEL_CLAUDE_INFRA_BOT_USER_ID (T3 / FLY-928; null until deployed). */
	claudeBotUserId: string | null;
	/** FLYWHEEL_INFRA_BOT_USER_ID (the Codex Infra Bot — existing env). */
	codexBotUserId: string | null;
}

const SNOWFLAKE = /^\d{17,20}$/;

/** Registry from env, snowflake-validated (malformed ⇒ null = no ping). */
export function ownerRegistryFromEnv(env: NodeJS.ProcessEnv): OwnerRegistry {
	const read = (name: string): string | null => {
		const v = env[name]?.trim();
		return v && SNOWFLAKE.test(v) ? v : null;
	};
	return {
		claudeBotUserId: read("FLYWHEEL_CLAUDE_INFRA_BOT_USER_ID"),
		codexBotUserId: read("FLYWHEEL_INFRA_BOT_USER_ID"),
	};
}

/**
 * Account/auth kinds — the CROSS-assignment family ("nobody rescues their own
 * side"): the ticket's provider decides which bot owns it.
 */
const ACCOUNT_AUTH_KINDS: ReadonlySet<AlertEventType> = new Set<AlertEventType>(
	["usage_limit", "login_expired", "rate_limit", "runner_login_expired"],
);

/**
 * FLY-1082 (Task 1.3): the full cross-assignment family. `infra_bot_down`
 * reuses the account/auth cross pattern with a different provider source: the
 * DEAD bot's side rides `metadata.infraBotDown.provider` (an explicit event
 * field — there is no runner session to derive from), and the OTHER side owns
 * the ticket. Dead claude bot → @codex bot; dead codex bot → @claude bot.
 */
const CROSS_PROVIDER_KINDS: ReadonlySet<AlertEventType> =
	new Set<AlertEventType>([...ACCOUNT_AUTH_KINDS, "infra_bot_down"]);

/** Kinds with NO bot owner. */
const NO_OWNER_KINDS: ReadonlySet<AlertEventType> = new Set<AlertEventType>([
	// Permissions are a HUMAN decision (PRD §4.3 precedent) — straight to
	// needs_human, never bot-owned.
	"permission_blocked",
	// FLY-637-ext ladder output: the owner-first response ALREADY happened (K
	// nudge rounds); re-@'ing the Lead would fight the approved thresholds. The
	// Hub still records a NEW ticket without an automatic mention or escalation.
	"runner_lead_pending_unhandled",
	// FLY-1279: the canonical founder issue-thread page already landed before
	// this best-effort mirror fires; no infra bot should re-own the occurrence.
	"delivery_dead_letter",
	// FLY-1373: the alert is already founder-directed; no infra bot should
	// create a second response loop for the consume loop itself.
	"inbox_loop_stalled",
	// FLY-1573: dead mailbox rows require an explicit replay/discard/reassign
	// decision, so the founder-directed alert must not acquire an infra-bot ARC.
	"mailbox_dead_letter",
	// FLY-1586: same family as inbox_loop_stalled — a REAL notification is being
	// held back and only a human can decide replay vs discard. An infra bot has
	// no way to know whether the withheld message still matters.
	"legacy_row_quarantined",
	"stale_approved_ship_dead",
	// FLY-1285: choosing between conflicting tmux generations is explicitly a
	// founder decision; neither infra bot may guess and signal a candidate.
	"tmux_split_brain",
	// Paid-model choices are intentionally never delegated to an infra bot.
	"quota_choice",
	// FLY-2177: this is issue progress owned by the issue's human lane. If its
	// bound thread cannot be resolved, retain the durable ticket without
	// assigning an infra bot that cannot decide the review's next action.
	"review_job_failed",
]);

/**
 * The one owner for a ticket. `provider` derivation is the caller's job
 * (Lead = ProjectConfig backend; Runner = sessions.adapter_type; unknown when
 * unresolvable — see `deriveTicketProvider`).
 */
export function resolveTicketOwner(
	eventType: AlertEventType,
	provider: TicketProvider,
	reg: OwnerRegistry,
): TicketOwner {
	if (NO_OWNER_KINDS.has(eventType)) return { kind: "none" };
	if (CROSS_PROVIDER_KINDS.has(eventType)) {
		// Cross assignment; unknown provider defaults to the Claude workhorse.
		if (provider === "claude") {
			return { kind: "infra_bot", side: "codex", userId: reg.codexBotUserId };
		}
		return { kind: "infra_bot", side: "claude", userId: reg.claudeBotUserId };
	}
	// Everything else (provider-agnostic infra kinds + the issue-progress
	// fail-safe tickets): the Claude workhorse by default.
	return { kind: "infra_bot", side: "claude", userId: reg.claudeBotUserId };
}

/**
 * Provider derivation from what the emission context knows. Lead-side alerts
 * pass the lead's configured backend (absent = the Claude default); runner-side
 * alerts pass sessions.adapter_type (claude-tmux / codex-* / antigravity-tmux /
 * kimi-tmux). Anything unrecognizable ⇒ "unknown" (owner map then defaults to
 * the Claude bot — main-force default, per the PRD @-routing rule).
 */
export function deriveTicketProvider(input: {
	leadBackend?: string | null;
	adapterType?: string | null;
}): TicketProvider {
	const probe = (s: string): TicketProvider | null => {
		const v = s.toLowerCase();
		if (v.includes("codex")) return "codex";
		if (v.includes("claude")) return "claude";
		return null;
	};
	if (input.adapterType) {
		return probe(input.adapterType) ?? "unknown";
	}
	if (input.leadBackend !== undefined) {
		// A lead with NO explicit backend is a Claude lead (the default).
		if (input.leadBackend == null || input.leadBackend === "") return "claude";
		return probe(input.leadBackend) ?? "unknown";
	}
	return "unknown";
}

/**
 * The 🎫-header face of an owner (feeds `AlertTicketContext`): a validated
 * user id when a ping is possible, else a human-readable label; `none` renders
 * the — placeholder.
 */
export function ownerTicketFace(owner: TicketOwner): {
	ownerUserId: string | null;
	ownerLabel: string;
} {
	switch (owner.kind) {
		case "infra_bot":
			return {
				ownerUserId: owner.userId,
				ownerLabel: owner.side === "claude" ? "claude bot" : "codex bot",
			};
		case "lead":
			return { ownerUserId: null, ownerLabel: owner.leadId };
		case "none":
			return { ownerUserId: null, ownerLabel: "" };
	}
}
