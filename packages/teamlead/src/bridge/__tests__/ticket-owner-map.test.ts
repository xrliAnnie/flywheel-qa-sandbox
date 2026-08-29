/**
 * FLY-927 (Task 2.1): kind × provider × registry owner matrix.
 */
import { describe, expect, it } from "vitest";
import { ALERT_EVENT_TYPES } from "../../LeadAlertNotifier.js";
import { TICKET_KINDS } from "../infra-event-router.js";
import {
	deriveTicketProvider,
	type OwnerRegistry,
	ownerRegistryFromEnv,
	ownerTicketFace,
	resolveTicketOwner,
} from "../ticket-owner-map.js";

const FULL: OwnerRegistry = {
	claudeBotUserId: "111111111111111111",
	codexBotUserId: "222222222222222222",
};
const EMPTY: OwnerRegistry = { claudeBotUserId: null, codexBotUserId: null };

describe("resolveTicketOwner (PRD CH-1 whitelist matrix)", () => {
	it("CROSS: claude account/auth problems @ the CODEX bot", () => {
		for (const kind of [
			"usage_limit",
			"login_expired",
			"rate_limit",
			"runner_login_expired",
		] as const) {
			expect(resolveTicketOwner(kind, "claude", FULL)).toEqual({
				kind: "infra_bot",
				side: "codex",
				userId: "222222222222222222",
			});
		}
	});

	it("CROSS: codex account/auth problems @ the CLAUDE bot", () => {
		expect(resolveTicketOwner("usage_limit", "codex", FULL)).toEqual({
			kind: "infra_bot",
			side: "claude",
			userId: "111111111111111111",
		});
	});

	it("unknown provider on account/auth kinds defaults to the Claude workhorse", () => {
		expect(resolveTicketOwner("login_expired", "unknown", FULL)).toEqual({
			kind: "infra_bot",
			side: "claude",
			userId: "111111111111111111",
		});
	});

	it("provider-agnostic kinds @ the Claude bot regardless of provider", () => {
		for (const kind of [
			"pane_hash_stuck",
			"crash_loop",
			"runner_stuck_unhandled",
			"runner_throttle_stalled",
			"tui_window_lost",
			"auto_qa_stuck",
			"codex_gate_blocked",
			"restart_guard_bypass",
			"bridge_boot_stale_checkout",
			"bridge_wrapper_fail",
		] as const) {
			for (const provider of ["claude", "codex", "unknown"] as const) {
				expect(resolveTicketOwner(kind, provider, FULL)).toEqual({
					kind: "infra_bot",
					side: "claude",
					userId: "111111111111111111",
				});
			}
		}
	});

	it("permission_blocked has NO owner (human decision)", () => {
		expect(resolveTicketOwner("permission_blocked", "claude", FULL)).toEqual({
			kind: "none",
		});
	});

	it("runner_lead_pending_unhandled has NO owner (ladder already exhausted)", () => {
		expect(
			resolveTicketOwner("runner_lead_pending_unhandled", "unknown", FULL),
		).toEqual({ kind: "none" });
	});

	it("registry unset ⇒ userId null (label-only, no ping, no T2 fallback)", () => {
		expect(resolveTicketOwner("usage_limit", "claude", EMPTY)).toEqual({
			kind: "infra_bot",
			side: "codex",
			userId: null,
		});
	});

	it("EVERY union kind resolves deterministically (never throws)", () => {
		for (const kind of ALERT_EVENT_TYPES) {
			for (const provider of ["claude", "codex", "unknown"] as const) {
				const owner = resolveTicketOwner(kind, provider, FULL);
				expect(["infra_bot", "lead", "none"]).toContain(owner.kind);
			}
		}
	});

	it("every TICKET_KIND except permission_blocked has a bot owner when registry is full", () => {
		for (const kind of TICKET_KINDS) {
			if (kind === "permission_blocked") continue;
			const owner = resolveTicketOwner(kind, "unknown", FULL);
			expect(owner.kind, kind).toBe("infra_bot");
		}
	});
});

describe("ownerRegistryFromEnv", () => {
	it("reads + snowflake-validates both ids", () => {
		expect(
			ownerRegistryFromEnv({
				FLYWHEEL_CLAUDE_INFRA_BOT_USER_ID: "111111111111111111",
				FLYWHEEL_INFRA_BOT_USER_ID: "222222222222222222",
			}),
		).toEqual(FULL);
	});
	it("malformed / unset ⇒ null", () => {
		expect(
			ownerRegistryFromEnv({
				FLYWHEEL_CLAUDE_INFRA_BOT_USER_ID: "not-a-snowflake",
			}),
		).toEqual(EMPTY);
		expect(ownerRegistryFromEnv({})).toEqual(EMPTY);
	});
});

describe("deriveTicketProvider", () => {
	it("runner adapter_type wins: claude-tmux/codex/kimi/antigravity", () => {
		expect(deriveTicketProvider({ adapterType: "claude-tmux" })).toBe("claude");
		expect(deriveTicketProvider({ adapterType: "codex-tmux" })).toBe("codex");
		expect(deriveTicketProvider({ adapterType: "kimi-tmux" })).toBe("unknown");
		expect(deriveTicketProvider({ adapterType: "antigravity-tmux" })).toBe(
			"unknown",
		);
	});
	it("lead backend: absent/empty = the Claude default; codex-app-server = codex", () => {
		expect(deriveTicketProvider({ leadBackend: null })).toBe("claude");
		expect(deriveTicketProvider({ leadBackend: "" })).toBe("claude");
		expect(deriveTicketProvider({ leadBackend: "codex-app-server" })).toBe(
			"codex",
		);
	});
	it("nothing known ⇒ unknown", () => {
		expect(deriveTicketProvider({})).toBe("unknown");
	});
});

describe("ownerTicketFace", () => {
	it("infra_bot with id → pingable; without id → label only", () => {
		expect(
			ownerTicketFace({
				kind: "infra_bot",
				side: "codex",
				userId: "222222222222222222",
			}),
		).toEqual({ ownerUserId: "222222222222222222", ownerLabel: "codex bot" });
		expect(
			ownerTicketFace({ kind: "infra_bot", side: "claude", userId: null }),
		).toEqual({ ownerUserId: null, ownerLabel: "claude bot" });
	});
	it("lead owner renders its id as the label (no ping)", () => {
		expect(
			ownerTicketFace({ kind: "lead", leadId: "flywheel-eng-lead" }),
		).toEqual({ ownerUserId: null, ownerLabel: "flywheel-eng-lead" });
	});
	it("none renders the — placeholder (empty label)", () => {
		expect(ownerTicketFace({ kind: "none" })).toEqual({
			ownerUserId: null,
			ownerLabel: "",
		});
	});
});
