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
import { ALERT_EVENT_TYPES } from "../../LeadAlertNotifier.js";
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
	"bridge_abnormal_exit",
	"infra_bot_down",
	"zombie_session_backlog",
] as const;

describe("FLY-1082 kind contract (Task 1.1)", () => {
	it("every kind in the union has a contract entry (runtime exhaustiveness)", () => {
		for (const kind of ALERT_EVENT_TYPES) {
			expect(
				KIND_CONTRACTS[kind],
				`missing contract for ${kind}`,
			).toBeDefined();
		}
	});

	it("the 5 fleet kinds are in the union with the planned contracts", () => {
		for (const kind of FLEET_KINDS) {
			expect(ALERT_EVENT_TYPES).toContain(kind);
		}
		expect(KIND_CONTRACTS.swap_pressure_high.arc).toBe("auto");
		expect(KIND_CONTRACTS.tmux_server_lost.arc).toBe("auto");
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

	it("escalatesAtEnqueue: exactly the none_escalate kinds (legacy special case + zombie)", () => {
		// Legacy: runner_lead_pending_unhandled landed directly ESCALATED before
		// this contract existed (infra-alert-wiring special case) — the contract
		// must reproduce that, and add ONLY zombie_session_backlog.
		const expected = new Set([
			"runner_lead_pending_unhandled",
			"zombie_session_backlog",
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

	it("the shell leg can emit the fleet kinds (bridge_abnormal_exit is load-bearing)", () => {
		const allow = shellAllowlist();
		for (const kind of FLEET_KINDS) {
			expect(allow.has(kind), `shell allowlist missing "${kind}"`).toBe(true);
		}
	});
});
