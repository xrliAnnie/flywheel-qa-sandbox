/**
 * FLY-1082 (Task 2.2): the pressure-hold chain — durable StateStore row,
 * runner-admission `pressure_hold` deferral, and the per-kind escalation
 * policy (legacy byte-compat + the swap slow-variable window).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import { RunnerAdmissionController } from "../runner-admission.js";
import {
	DEFAULT_TICKET_ESCALATION_POLICY,
	decideTicketEscalation,
	policyForKind,
} from "../ticket-escalation.js";

describe("StateStore fleet_pressure_hold", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("set is idempotent — the first setter owns the episode", () => {
		expect(
			store.setFleetPressureHold({ setBy: "swap-sensor", watermark: "85%" }),
		).toBe(true);
		expect(
			store.setFleetPressureHold({ setBy: "someone-else", watermark: "90%" }),
		).toBe(false);
		const hold = store.getFleetPressureHold();
		expect(hold?.set_by).toBe("swap-sensor");
		expect(hold?.watermark).toBe("85%");
	});

	it("clear is idempotent and lifts the hold", () => {
		store.setFleetPressureHold({ setBy: "swap-sensor" });
		expect(store.clearFleetPressureHold()).toBe(true);
		expect(store.clearFleetPressureHold()).toBe(false);
		expect(store.getFleetPressureHold()).toBeUndefined();
	});
});

describe("RunnerAdmissionController pressure_hold (Task 2.2)", () => {
	it("hold present → defer with the typed pressure_hold reason", () => {
		const controller = RunnerAdmissionController.alwaysAdmit();
		controller.setPressureHoldProbe(() => "swap 90% — hold active");
		const decision = controller.tryAdmit();
		expect(decision).toEqual({
			admit: false,
			reason: "pressure_hold",
			detail: "swap 90% — hold active",
		});
	});

	it("hold lifted → admits again (reversible hand brake)", () => {
		const controller = RunnerAdmissionController.alwaysAdmit();
		let held: string | null = "holding";
		controller.setPressureHoldProbe(() => held);
		expect(controller.tryAdmit().admit).toBe(false);
		held = null;
		expect(controller.tryAdmit().admit).toBe(true);
	});

	it("a throwing probe fails OPEN (never halts dispatch)", () => {
		const controller = RunnerAdmissionController.alwaysAdmit();
		controller.setPressureHoldProbe(() => {
			throw new Error("db gone");
		});
		expect(controller.tryAdmit().admit).toBe(true);
	});

	it("no probe wired = byte-compat (resource-only admission)", () => {
		expect(RunnerAdmissionController.alwaysAdmit().tryAdmit().admit).toBe(true);
		expect(RunnerAdmissionController.alwaysDefer().tryAdmit()).toMatchObject({
			reason: "load_pressure",
		});
	});
});

describe("policyForKind (Task 2.2 per-kind escalation)", () => {
	it("legacy kinds resolve to the locked T2 defaults byte-for-byte", () => {
		for (const kind of [
			"rate_limit",
			"pane_hash_stuck",
			"runner_stuck_unhandled",
			"infra_bot_down", // kickstart retry IS meaningful — default policy
		]) {
			expect(policyForKind(kind, {} as NodeJS.ProcessEnv)).toEqual(
				DEFAULT_TICKET_ESCALATION_POLICY,
			);
		}
	});

	it("swap: 30-min default window, env-overridable, no reconcile retry", () => {
		const p = policyForKind("swap_pressure_high", {} as NodeJS.ProcessEnv);
		expect(p.timeoutMs).toBe(30 * 60_000);
		expect(p.retryOnReconcile).toBe(false);
		const overridden = policyForKind("swap_pressure_high", {
			FLYWHEEL_SWAP_PRESSURE_TIMEOUT_MIN: "45",
		} as unknown as NodeJS.ProcessEnv);
		expect(overridden.timeoutMs).toBe(45 * 60_000);
	});

	it("tmux_server_lost / bridge_abnormal_exit: single-shot remediation — no reconcile retry", () => {
		for (const kind of ["tmux_server_lost", "bridge_abnormal_exit"]) {
			const p = policyForKind(kind, {} as NodeJS.ProcessEnv);
			expect(p.retryOnReconcile).toBe(false);
			expect(p.timeoutMs).toBe(DEFAULT_TICKET_ESCALATION_POLICY.timeoutMs);
		}
	});

	it("retryOnReconcile=false: REPAIRING under budget returns none (not retry) — the slow-variable fix", () => {
		const row = {
			ticket_status: "REPAIRING",
			attempt_count: 1,
			first_seen_at: "2026-07-09 21:00:00",
			acked_at: null,
		};
		const t0 = Date.parse("2026-07-09T21:01:00Z");
		// Legacy default: retry.
		expect(decideTicketEscalation(row, t0, true)).toBe("retry");
		// Swap policy: none — attempts stay at 1, only the 30-min window escalates.
		const swapPolicy = policyForKind(
			"swap_pressure_high",
			{} as NodeJS.ProcessEnv,
		);
		expect(decideTicketEscalation(row, t0, true, swapPolicy)).toBe("none");
		const past = Date.parse("2026-07-09T21:31:00Z");
		expect(decideTicketEscalation(row, past, true, swapPolicy)).toBe(
			"escalate",
		);
	});
});
