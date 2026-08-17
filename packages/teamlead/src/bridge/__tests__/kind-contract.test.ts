/**
 * FLY-1082 (Task 1.1/1.2): the kind contract — every alert kind MUST have an
 * owner and an explicit ARC posture ((a) auto+remediation or (b) no-ARC
 * escalate / human-by-design). Violations fail LOUD at Bridge startup.
 *
 * Also the two-face drift guard (Task 1.2): the lead-alert.sh kind allowlist
 * and the TS union are separate "faces" of the same contract — this suite
 * reads the actual shell script line so an edit to either side without the
 * other fails here, not in production.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	ALERT_EVENT_TYPES,
	INFORMATIONAL_KINDS,
} from "../../LeadAlertNotifier.js";
import { QUOTA_MONITOR_MANUAL_TICKET_KINDS } from "../AlertChannelHub.js";
import {
	escalatesAtEnqueue,
	KIND_CONTRACTS,
	type KindContract,
	validateKindContracts,
} from "../kind-contract.js";
import {
	ownerRegistryFromEnv,
	resolveTicketOwner,
} from "../ticket-owner-map.js";

const FLEET_KINDS = [
	"swap_pressure_high",
	"tmux_server_lost",
	"tmux_hold",
	"tmux_split_brain",
	"bridge_abnormal_exit",
	"infra_bot_down",
	"zombie_session_backlog",
] as const;

const QUOTA_MONITOR_KINDS = [
	"account_switched",
	"machine_account_conflict",
	"model_cap_switched",
	"model_cap_unknown",
	"model_cap_persistent_unknown",
	"model_bench_malformed",
	"quota_choice",
	"quota_switch_confirmation",
	"account_switch_degraded",
	"quota_no_target",
	"quota_blocked_recovered",
	"quota_read_blind",
	"account_switch_failed",
	"account_identity_mismatch",
	"quota_revive_stuck",
	"quota_monitor_down",
] as const;

const QUOTA_INFORMATIONAL_KINDS = new Set([
	"account_switched",
	"model_cap_switched",
	"model_cap_unknown",
	"quota_switch_confirmation",
	"quota_blocked_recovered",
	"workflow_route_input_rejected",
	"cmux_flag_state",
	"flag_scan_failed",
	"flag_scan_no_clock",
]);
const QUOTA_GUARD_KINDS = ["quota_guard_bypassed"] as const;

const REVIEW_GOVERNANCE_KINDS = [
	"review_advisory_pass",
	"review_ruling_recorded",
	"review_ruling_disputed",
	"review_ruling_notify_failed",
] as const;

const LEAD_IDENTITY_KINDS = [
	"lead_dual_active",
	"lead_dual_active_sensor_degraded",
	"lead_lease_store_broken",
	"lead_lease_bypass_used",
	"lead_lease_would_block",
	"lead_lease_control_broken",
	"lead_identity_source_broken",
	"lead_backend_drift",
] as const;

const CMUX_SYNC_KINDS = [
	"cmux_cleanup",
	"cmux_flag_state",
	"tmux_rescue_hold",
] as const;

const DISCORD_PLUGIN_KINDS = ["discord_plugin_integrity_failed"] as const;

describe("FLY-1082 kind contract (Task 1.1)", () => {
	it("every kind in the union has a contract entry (runtime exhaustiveness)", () => {
		for (const kind of ALERT_EVENT_TYPES) {
			expect(
				KIND_CONTRACTS[kind],
				`missing contract for ${kind}`,
			).toBeDefined();
		}
	});

	it("the fleet kinds are in the union with the planned contracts", () => {
		for (const kind of FLEET_KINDS) {
			expect(ALERT_EVENT_TYPES).toContain(kind);
		}
		expect(KIND_CONTRACTS.swap_pressure_high.arc).toBe("auto");
		expect(KIND_CONTRACTS.tmux_server_lost.arc).toBe("auto");
		expect(KIND_CONTRACTS.tmux_hold).toMatchObject({
			owner: "claude",
			arc: "human_by_design",
		});
		expect(KIND_CONTRACTS.tmux_split_brain).toMatchObject({
			owner: "founder_direct",
			arc: "human_by_design",
		});
		expect(KIND_CONTRACTS.bridge_abnormal_exit.arc).toBe("auto");
		expect(KIND_CONTRACTS.infra_bot_down).toMatchObject({
			owner: "cross_by_provider",
			arc: "auto",
		});
		// Zombie backlog: reaping is FLY-1066's job — (b)-type by design, with the
		// remediation reference naming where the real fix lands.
		expect(KIND_CONTRACTS.zombie_session_backlog).toMatchObject({
			owner: "claude",
			arc: "none_escalate",
			remediationRef: "FLY-1066",
		});
	});

	it("FLY-1182 quota-monitor kinds have explicit no-ARC contracts and quota choice stays human-owned", () => {
		for (const kind of QUOTA_MONITOR_KINDS) {
			expect(ALERT_EVENT_TYPES).toContain(kind);
			if (kind === "quota_choice") {
				expect(KIND_CONTRACTS[kind]).toEqual({
					owner: "founder_direct",
					arc: "human_by_design",
				});
			} else {
				expect(KIND_CONTRACTS[kind]).toEqual({
					owner: "claude",
					arc: "human_by_design",
				});
			}
		}
	});

	it("FLY-1252 quota bypass is actionable, Claude-owned, and human-by-design", () => {
		for (const kind of QUOTA_GUARD_KINDS) {
			expect(ALERT_EVENT_TYPES).toContain(kind);
			expect(KIND_CONTRACTS[kind]).toEqual({
				owner: "claude",
				arc: "human_by_design",
			});
			expect(INFORMATIONAL_KINDS.has(kind)).toBe(false);
		}
	});

	it("FLY-1402 legacy rules loading is a Claude-owned human audit event", () => {
		expect(ALERT_EVENT_TYPES).toContain("rules_bundle_legacy");
		expect(
			(KIND_CONTRACTS as Record<string, KindContract>).rules_bundle_legacy,
		).toEqual({
			owner: "claude",
			arc: "human_by_design",
		});
	});

	it("FLY-1570 keeps legacy chase kinds human-only", () => {
		for (const kind of [
			"pane_hash_stuck",
			"runner_stuck_unhandled",
			"runner_throttle_stalled",
		] as const) {
			expect(KIND_CONTRACTS[kind]).toEqual({
				owner: "claude",
				arc: "human_by_design",
			});
		}
	});

	it("FLY-1364 cmux/rescue kinds have the exact approved contracts", () => {
		for (const kind of CMUX_SYNC_KINDS) {
			expect(ALERT_EVENT_TYPES).toContain(kind);
			expect(KIND_CONTRACTS[kind]).toEqual({
				owner: "claude",
				arc: "human_by_design",
			});
		}
		expect(INFORMATIONAL_KINDS.has("cmux_flag_state")).toBe(true);
		expect(INFORMATIONAL_KINDS.has("cmux_cleanup")).toBe(false);
		expect(INFORMATIONAL_KINDS.has("tmux_rescue_hold")).toBe(false);
	});

	it("FLY-1676 routes Discord fork integrity failures to a human-owned ticket", () => {
		for (const kind of DISCORD_PLUGIN_KINDS) {
			expect(ALERT_EVENT_TYPES).toContain(kind);
			expect(KIND_CONTRACTS[kind]).toEqual({
				owner: "claude",
				arc: "human_by_design",
			});
			expect(INFORMATIONAL_KINDS.has(kind)).toBe(false);
		}
	});

	it("routes review governance audit events to a human-owned contract", () => {
		for (const kind of REVIEW_GOVERNANCE_KINDS) {
			expect(ALERT_EVENT_TYPES).toContain(kind);
			expect(KIND_CONTRACTS[kind]).toEqual({
				owner: "claude",
				arc: "human_by_design",
			});
		}
	});

	it("keeps the frozen root-only notice kinds informational", () => {
		expect(INFORMATIONAL_KINDS).toEqual(QUOTA_INFORMATIONAL_KINDS);
	});

	it("FLY-1182 explicitly classifies every actionable quota kind as a manual daemon-state ticket", () => {
		expect(QUOTA_MONITOR_MANUAL_TICKET_KINDS).toEqual(
			new Set(
				QUOTA_MONITOR_KINDS.filter(
					(kind) => !QUOTA_INFORMATIONAL_KINDS.has(kind),
				),
			),
		);
	});

	it("M5 migration phase one keeps legacy usage_limit ARC intact", () => {
		expect(KIND_CONTRACTS.usage_limit).toEqual({
			owner: "cross_by_provider",
			arc: "auto",
			remediationRef:
				"account-switch repair (FLY-696, gated FLYWHEEL_ACCOUNT_SELF_HEAL)",
		});
	});

	it("shipped table passes startup validation", () => {
		expect(() => validateKindContracts()).not.toThrow();
	});

	it("a missing kind fails validation naming the kind", () => {
		const doctored = { ...KIND_CONTRACTS } as Record<string, KindContract>;
		delete doctored.swap_pressure_high;
		expect(() => validateKindContracts(doctored)).toThrow(/swap_pressure_high/);
	});

	it("arc=auto without remediationRef fails validation naming the kind", () => {
		const doctored: Record<string, KindContract> = {
			...KIND_CONTRACTS,
			tmux_server_lost: { owner: "claude", arc: "auto" },
		};
		expect(() => validateKindContracts(doctored)).toThrow(/tmux_server_lost/);
	});

	it("arc=auto owned by founder_direct fails validation (a bot must own an auto kind)", () => {
		const doctored: Record<string, KindContract> = {
			...KIND_CONTRACTS,
			pane_hash_stuck: {
				owner: "founder_direct",
				arc: "auto",
				remediationRef: "x",
			},
		};
		expect(() => validateKindContracts(doctored)).toThrow(/pane_hash_stuck/);
	});

	it("escalatesAtEnqueue: exactly the none_escalate kinds", () => {
		// Legacy: runner_lead_pending_unhandled landed directly ESCALATED before
		// this contract existed (infra-alert-wiring special case) — the contract
		// must reproduce that, and add ONLY zombie_session_backlog.
		const expected = new Set([
			"runner_lead_pending_unhandled",
			"zombie_session_backlog",
			"delivery_dead_letter",
			"inbox_loop_stalled",
			"mailbox_dead_letter",
			// FLY-1586: a quarantined legacy row withholds a real notification;
			// it escalates at enqueue for the same reason inbox_loop_stalled does.
			"legacy_row_quarantined",
			"stale_approved_ship_dead",
		]);
		for (const kind of ALERT_EVENT_TYPES) {
			expect(escalatesAtEnqueue(kind), kind).toBe(expected.has(kind));
		}
	});

	it("contract owner agrees with resolveTicketOwner for EVERY kind (no table↔route drift)", () => {
		const reg = ownerRegistryFromEnv({
			FLYWHEEL_CLAUDE_INFRA_BOT_USER_ID: "111111111111111111",
			FLYWHEEL_INFRA_BOT_USER_ID: "222222222222222222",
		} as NodeJS.ProcessEnv);
		for (const kind of ALERT_EVENT_TYPES) {
			const contract = KIND_CONTRACTS[kind];
			const asClaude = resolveTicketOwner(kind, "claude", reg);
			const asCodex = resolveTicketOwner(kind, "codex", reg);
			switch (contract.owner) {
				case "founder_direct":
					expect(asClaude.kind, kind).toBe("none");
					break;
				case "cross_by_provider":
					expect(asClaude, kind).toMatchObject({
						kind: "infra_bot",
						side: "codex",
					});
					expect(asCodex, kind).toMatchObject({
						kind: "infra_bot",
						side: "claude",
					});
					break;
				case "claude":
					expect(asClaude, kind).toMatchObject({
						kind: "infra_bot",
						side: "claude",
					});
					expect(asCodex, kind).toMatchObject({
						kind: "infra_bot",
						side: "claude",
					});
					break;
				default:
					throw new Error(`unhandled owner ${contract.owner} for ${kind}`);
			}
		}
	});
});

describe("FLY-1082 TS union ↔ lead-alert.sh allowlist drift guard (Task 1.2)", () => {
	// Kinds that predate the TS union parity convention — shell-only, never
	// drained through the TS path. Grandfathered; do NOT add to this list.
	const SHELL_ONLY_LEGACY = new Set([
		"companion_config_error",
		"external_config_error",
	]);

	function shellAllowlist(): Set<string> {
		const here = dirname(fileURLToPath(import.meta.url));
		const script = readFileSync(
			join(here, "../../../../../scripts/lead-alert.sh"),
			"utf-8",
		);
		// The allowlist is the `case "$KIND"` arm listing kinds joined by `|`
		// and terminated by `) ;;`.
		const m = script.match(/^\s*([a-z_]+(?:\|[a-z_]+)+\)) ;;$/m);
		expect(
			m,
			"could not locate the kind allowlist arm in lead-alert.sh",
		).not.toBeNull();
		return new Set((m as RegExpMatchArray)[1].replace(/\)$/, "").split("|"));
	}

	function shellInformationalKinds(): Set<string> {
		const here = dirname(fileURLToPath(import.meta.url));
		const script = readFileSync(
			join(here, "../../../../../scripts/lead-alert.sh"),
			"utf-8",
		);
		const m = script.match(/^INFORMATIONAL_KINDS="([a-z_ ]*)"$/m);
		expect(
			m,
			"could not locate INFORMATIONAL_KINDS mirror in lead-alert.sh",
		).not.toBeNull();
		return new Set((m as RegExpMatchArray)[1].split(/\s+/).filter(Boolean));
	}

	it("every shell-allowlisted kind (minus grandfathered) is in the TS union", () => {
		const union = new Set<string>(ALERT_EVENT_TYPES);
		for (const kind of shellAllowlist()) {
			if (SHELL_ONLY_LEGACY.has(kind)) continue;
			expect(
				union.has(kind),
				`shell kind "${kind}" missing from TS union`,
			).toBe(true);
		}
	});

	it("all FLY-1309 kinds exist on both the TS and shell faces", () => {
		const allow = shellAllowlist();
		for (const kind of LEAD_IDENTITY_KINDS) {
			expect(ALERT_EVENT_TYPES).toContain(kind);
			expect(
				allow.has(kind),
				`FLY-1309 kind "${kind}" missing from shell allowlist`,
			).toBe(true);
		}
	});

	it("all FLY-1364 kinds exist on both the TS and shell faces", () => {
		const allow = shellAllowlist();
		for (const kind of CMUX_SYNC_KINDS) {
			expect(ALERT_EVENT_TYPES).toContain(kind);
			expect(
				allow.has(kind),
				`FLY-1364 kind "${kind}" missing from shell allowlist`,
			).toBe(true);
		}
	});

	it("FLY-1501 restart-storm hold is present on both faces with a human investigation contract", () => {
		expect(ALERT_EVENT_TYPES).toContain("restart_storm_hold");
		expect(shellAllowlist()).toContain("restart_storm_hold");
		expect(KIND_CONTRACTS).toMatchObject({
			restart_storm_hold: {
				owner: "claude",
				arc: "human_by_design",
			},
		});
	});

	it("the shell leg can emit the fleet kinds (bridge_abnormal_exit is load-bearing)", () => {
		const allow = shellAllowlist();
		for (const kind of FLEET_KINDS) {
			expect(allow.has(kind), `shell allowlist missing "${kind}"`).toBe(true);
		}
	});

	it("the shell leg can emit every quota-monitor kind", () => {
		const allow = shellAllowlist();
		for (const kind of QUOTA_MONITOR_KINDS) {
			expect(allow.has(kind), `shell allowlist missing "${kind}"`).toBe(true);
		}
	});

	it("the shell leg can emit the quota-guard bypass audit kind", () => {
		const allow = shellAllowlist();
		for (const kind of QUOTA_GUARD_KINDS) {
			expect(allow.has(kind), `shell allowlist missing "${kind}"`).toBe(true);
		}
	});

	it("TS and shell informational-kind mirrors stay exactly in sync", () => {
		expect(shellInformationalKinds()).toEqual(INFORMATIONAL_KINDS);
	});

	it("registers work-kind input reminders as Claude-owned informational notices", () => {
		expect(KIND_CONTRACTS.workflow_route_input_rejected).toEqual({
			owner: "claude",
			arc: "human_by_design",
		});
		expect(INFORMATIONAL_KINDS.has("workflow_route_input_rejected")).toBe(true);
	});
});
