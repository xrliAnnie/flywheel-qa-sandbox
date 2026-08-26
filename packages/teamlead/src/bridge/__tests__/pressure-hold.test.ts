/**
 * FLY-1082 (Task 2.2): the pressure-hold chain — durable StateStore row,
 * runner-admission `pressure_hold` deferral, and the per-kind escalation
 * policy (legacy byte-compat + the swap slow-variable window).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
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

describe("StateStore admission_pause", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("persists a bounded lease and expires it from the reader clock", () => {
		const now = "2026-08-05T12:00:00.000Z";
		expect(
			store.setAdmissionPause({
				durationSeconds: 1_800,
				setBy: "restart-services",
				reason: "deploy",
				now,
			}),
		).toMatchObject({
			active: true,
			remainingSeconds: 1_800,
		});
		expect(store.getAdmissionPause(now)).toMatchObject({
			active: true,
			remainingSeconds: 1_800,
			set_by: "restart-services",
			reason: "deploy",
		});
		expect(store.getAdmissionPause("2026-08-05T12:30:00.001Z")).toMatchObject({
			active: false,
			remainingSeconds: 0,
		});
	});

	it("caps the operator lease at one hour and resume is idempotent", () => {
		expect(() =>
			store.setAdmissionPause({
				durationSeconds: 3_601,
				setBy: "operator",
				reason: "too-long",
				now: "2026-08-05T12:00:00.000Z",
			}),
		).toThrow("durationSeconds");
		store.setAdmissionPause({
			durationSeconds: 60,
			setBy: "operator",
			reason: "maintenance",
			now: "2026-08-05T12:00:00.000Z",
		});
		expect(store.clearAdmissionPause()).toBe(true);
		expect(store.clearAdmissionPause()).toBe(false);
		expect(store.getAdmissionPause()).toBeUndefined();
	});

	it("claims one Lead alert after five minutes and retries only failed delivery", () => {
		store.setAdmissionPause({
			durationSeconds: 1_800,
			setBy: "restart-services",
			reason: "deploy",
			now: "2026-08-05T12:00:00.000Z",
		});
		expect(
			store.claimAdmissionPauseAlert({
				now: "2026-08-05T12:04:59.999Z",
				minAgeMs: 5 * 60_000,
			}),
		).toBeUndefined();
		const first = store.claimAdmissionPauseAlert({
			now: "2026-08-05T12:05:00.000Z",
			minAgeMs: 5 * 60_000,
		});
		expect(first).toMatchObject({
			set_at: "2026-08-05T12:00:00.000Z",
			reason: "deploy",
		});
		expect(
			store.claimAdmissionPauseAlert({
				now: "2026-08-05T12:05:01.000Z",
				minAgeMs: 5 * 60_000,
			}),
		).toBeUndefined();
		expect(
			store.finishAdmissionPauseAlert({
				setAt: first!.set_at,
				outcome: "failed",
			}),
		).toBe(true);
		const retry = store.claimAdmissionPauseAlert({
			now: "2026-08-05T12:05:02.000Z",
			minAgeMs: 5 * 60_000,
		});
		expect(retry).toBeDefined();
		expect(
			store.finishAdmissionPauseAlert({
				setAt: retry!.set_at,
				outcome: "sent",
			}),
		).toBe(true);
		expect(
			store.claimAdmissionPauseAlert({
				now: "2026-08-05T12:06:00.000Z",
				minAgeMs: 5 * 60_000,
			}),
		).toBeUndefined();
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

describe("RunnerAdmissionController admission pause", () => {
	it("operator pause wins before resource probes and carries Retry-After", () => {
		const controller = RunnerAdmissionController.alwaysDefer();
		controller.setAdmissionPauseProbe(() => ({
			detail: "operator deployment pause",
			retryAfterSeconds: 73,
		}));
		expect(controller.tryAdmit()).toEqual({
			admit: false,
			reason: "admission_paused",
			detail: "operator deployment pause",
			retryAfterSeconds: 73,
		});
	});

	it("expired pause admits immediately", () => {
		const controller = RunnerAdmissionController.alwaysAdmit();
		controller.setAdmissionPauseProbe(() => null);
		expect(controller.tryAdmit()).toEqual({ admit: true });
	});

	it("a throwing pause probe fails open with an explicit operational warning", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const controller = RunnerAdmissionController.alwaysAdmit();
		controller.setAdmissionPauseProbe(() => {
			throw new Error("state db unavailable");
		});

		expect(controller.tryAdmit()).toEqual({ admit: true });
		expect(warn).toHaveBeenCalledWith(
			"[runner-admission] admission pause probe failed; failing open: state db unavailable",
		);
		warn.mockRestore();
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

	it("swap: unset/invalid → 30 min; timeout never auto-escalates", () => {
		const p = policyForKind("swap_pressure_high", {} as NodeJS.ProcessEnv);
		expect(p.timeoutMs).toBe(30 * 60_000);
		expect(p.retryOnReconcile).toBe(false);
		const overridden = policyForKind("swap_pressure_high", {
			FLYWHEEL_SWAP_PRESSURE_TIMEOUT_MIN: "45",
		} as unknown as NodeJS.ProcessEnv);
		expect(overridden.timeoutMs).toBe(45 * 60_000);
		for (const invalid of ["0", "-1", "NaN", "Infinity", ""] as const) {
			expect(
				policyForKind("swap_pressure_high", {
					FLYWHEEL_SWAP_PRESSURE_TIMEOUT_MIN: invalid,
				} as unknown as NodeJS.ProcessEnv).timeoutMs,
			).toBe(30 * 60_000);
		}
		const oneMinute = policyForKind("swap_pressure_high", {
			FLYWHEEL_SWAP_PRESSURE_TIMEOUT_MIN: "1",
		} as unknown as NodeJS.ProcessEnv);
		expect(oneMinute.timeoutMs).toBe(60_000);
		expect(
			decideTicketEscalation(
				{
					ticket_status: "MONITORING",
					attempt_count: 0,
					first_seen_at: "2026-07-09 21:00:00",
					acked_at: null,
				},
				Date.parse("2026-07-09T21:01:01Z"),
				oneMinute,
			),
		).toBe("none");
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
		expect(decideTicketEscalation(row, t0)).toBe("retry");
		// Swap policy: none — attempts stay at 1, including after the timeout.
		const swapPolicy = policyForKind(
			"swap_pressure_high",
			{} as NodeJS.ProcessEnv,
		);
		expect(decideTicketEscalation(row, t0, swapPolicy)).toBe("none");
		const past = Date.parse("2026-07-09T21:31:00Z");
		expect(decideTicketEscalation(row, past, swapPolicy)).toBe("none");
	});
});
