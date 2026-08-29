/**
 * FLY-871 R3 — rescue runtime: alert-row mapping, launchctl kickstart, the
 * runner revalidation seam, the W4 close+dispatch composition (running-only,
 * terminate-before-close, never dispatch onto a live tmux), and the full
 * buildRescueRuntime wiring.
 */

import { describe, expect, it, vi } from "vitest";
import {
	buildRescueRuntime,
	buildRescueSuccessorDispatchFields,
	leadLaunchdLabel,
	makeCloseAndDispatchSuccessor,
	makeKickstart,
	makeRunnerRevalidate,
	mapAlertThreadToPendingAlert,
} from "../bridge/rescue-runtime.js";
import type { AlertThreadRow, Session } from "../StateStore.js";

function alertRow(over: Partial<AlertThreadRow> = {}): AlertThreadRow {
	return {
		correlation_key: "flywheel|eng|runner_login_expired|exec-1",
		event_id: "runner-login-expired:exec-1:login_expired",
		episode_signature: null,
		thread_id: "t-1",
		root_message_id: "m-1",
		channel_id: "c-1",
		lead_id: "flywheel-eng-lead",
		project_name: "flywheel",
		event_type: "runner_login_expired",
		session_key: "exec-1",
		repair_status: "attempted",
		opened_at: "2026-07-05 00:00:00",
		resolved_at: null,
		...over,
	};
}

function session(over: Partial<Session> = {}): Session {
	return {
		execution_id: "exec-1",
		issue_id: "ISSUE-1",
		project_name: "flywheel",
		status: "running",
		session_role: "main",
		// only the fields the composition reads matter; cast to keep the fixture terse
		...over,
	} as unknown as Session;
}

describe("mapAlertThreadToPendingAlert", () => {
	it("maps a runner row (confirmed) — session_key is the execId, no suspicious marker", () => {
		const p = mapAlertThreadToPendingAlert(alertRow());
		expect(p).toEqual({
			correlationKey: "flywheel|eng|runner_login_expired|exec-1",
			eventType: "runner_login_expired",
			sessionKey: "exec-1",
			leadId: "flywheel-eng-lead",
			projectName: "flywheel",
			evidence: "runner-pane:login_expired",
		});
	});

	it("preserves the :suspicious marker so isConfirmed can refuse it", () => {
		const p = mapAlertThreadToPendingAlert(
			alertRow({ event_id: "runner-login-expired:exec-1:suspicious" }),
		);
		expect(p.evidence).toBe("runner-pane:suspicious");
	});

	it("maps a lead row — no session_key, evidence undefined (= confirmed)", () => {
		const p = mapAlertThreadToPendingAlert(
			alertRow({
				event_type: "login_expired",
				event_id: "abc123hash",
				session_key: null,
				lead_id: "mufasa-lead",
				project_name: "growth",
			}),
		);
		expect(p.eventType).toBe("login_expired");
		expect(p.sessionKey).toBeNull();
		expect(p.evidence).toBeUndefined();
	});
});

describe("leadLaunchdLabel + makeKickstart", () => {
	it("builds the launchd label from project + leadId", () => {
		expect(leadLaunchdLabel("flywheel", "mufasa-lead")).toBe(
			"com.flywheel.lead.flywheel-mufasa-lead",
		);
	});

	it("runs launchctl kickstart -k against gui/<uid>/<label> and returns true on exit 0", async () => {
		const exec = vi.fn(async () => ({ code: 0, stderr: "" }));
		const k = makeKickstart({ exec, uid: 501 });
		const ok = await k("flywheel", "mufasa-lead");
		expect(ok).toBe(true);
		expect(exec).toHaveBeenCalledWith("launchctl", [
			"kickstart",
			"-k",
			"gui/501/com.flywheel.lead.flywheel-mufasa-lead",
		]);
	});

	it("returns false (never throws) on a non-zero exit or a thrown exec", async () => {
		const k1 = makeKickstart({
			exec: async () => ({ code: 3, stderr: "no such" }),
		});
		expect(await k1("flywheel", "x")).toBe(false);
		const k2 = makeKickstart({
			exec: async () => {
				throw new Error("boom");
			},
		});
		expect(await k2("flywheel", "x")).toBe(false);
	});
});

describe("makeRunnerRevalidate", () => {
	it("confirmed when the live pane still classifies as login_expired", async () => {
		const r = makeRunnerRevalidate({
			captureRunnerPane: async () => "…\nPlease run /login\n",
			classify: async () => ({ category: "login_expired" }),
		});
		expect(await r("exec-1")).toEqual({
			confirmed: true,
			category: "login_expired",
		});
	});

	it("not confirmed when the runner recovered (healthy/other)", async () => {
		const r = makeRunnerRevalidate({
			captureRunnerPane: async () => "⏵⏵ bypass permissions · ctx 40%",
			classify: async () => ({ category: "healthy" }),
		});
		expect(await r("exec-1")).toEqual({
			confirmed: false,
			category: "healthy",
		});
	});

	it("THROWS when the pane cannot be captured (⇒ rescueRunner escalates, never closes)", async () => {
		const r = makeRunnerRevalidate({
			captureRunnerPane: async () => null,
			classify: async () => ({ category: "login_expired" }),
		});
		await expect(r("exec-1")).rejects.toThrow(/capture failed/i);
	});

	it("classifies only the recent region (last N lines)", async () => {
		const classify = vi.fn(async () => ({ category: "healthy" }));
		const pane = Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n");
		const r = makeRunnerRevalidate({
			captureRunnerPane: async () => pane,
			classify,
			recentLines: 5,
		});
		await r("exec-1");
		expect(classify).toHaveBeenCalledWith(
			"line45\nline46\nline47\nline48\nline49",
		);
	});
});

describe("makeCloseAndDispatchSuccessor (W4)", () => {
	function deps(over: Record<string, unknown> = {}) {
		return {
			getSession: vi.fn(() => session()),
			terminateForRescue: vi.fn(() => ({ ok: true })),
			closeRunner: vi.fn(async () => ({ closed: true })),
			startSuccessor: vi.fn(async () => "exec-2"),
			...over,
		};
	}

	it("terminates → closes → dispatches a resumed successor (in order)", async () => {
		const order: string[] = [];
		const d = deps({
			terminateForRescue: vi.fn(() => {
				order.push("terminate");
				return { ok: true };
			}),
			closeRunner: vi.fn(async () => {
				order.push("close");
				return { closed: true };
			}),
			startSuccessor: vi.fn(async () => {
				order.push("start");
				return "exec-2";
			}),
		});
		const fn = makeCloseAndDispatchSuccessor(d);
		expect(await fn("exec-1")).toBe("exec-2");
		expect(order).toEqual(["terminate", "close", "start"]);
	});

	it("refuses a session that is not `running` (never terminates/closes)", async () => {
		const d = deps({
			getSession: vi.fn(() => session({ status: "completed" })),
		});
		const fn = makeCloseAndDispatchSuccessor(d);
		expect(await fn("exec-1")).toBeNull();
		expect(d.terminateForRescue).not.toHaveBeenCalled();
		expect(d.closeRunner).not.toHaveBeenCalled();
		expect(d.startSuccessor).not.toHaveBeenCalled();
	});

	it("returns null (no session)", async () => {
		const d = deps({ getSession: vi.fn(() => undefined) });
		expect(await makeCloseAndDispatchSuccessor(d)("nope")).toBeNull();
		expect(d.startSuccessor).not.toHaveBeenCalled();
	});

	it("refuses (no dispatch) when the FSM terminate fails", async () => {
		const d = deps({
			terminateForRescue: vi.fn(() => ({ ok: false, error: "fsm" })),
		});
		expect(await makeCloseAndDispatchSuccessor(d)("exec-1")).toBeNull();
		expect(d.closeRunner).not.toHaveBeenCalled();
		expect(d.startSuccessor).not.toHaveBeenCalled();
	});

	it("NEVER dispatches a successor onto a live tmux when close fails", async () => {
		const d = deps({
			closeRunner: vi.fn(async () => ({ closed: false, error: "tmux busy" })),
		});
		expect(await makeCloseAndDispatchSuccessor(d)("exec-1")).toBeNull();
		expect(d.startSuccessor).not.toHaveBeenCalled();
	});

	it("returns null when the successor dispatch throws (rescueRunner retries/escalates)", async () => {
		const d = deps({
			startSuccessor: vi.fn(async () => {
				throw new Error("Run already in progress");
			}),
		});
		expect(await makeCloseAndDispatchSuccessor(d)("exec-1")).toBeNull();
	});
});

describe("buildRescueRuntime wiring", () => {
	it("rescueLead reads live pending alerts (mapped) + kickstarts on a confirmed lead alert", async () => {
		const kickstart = vi.fn(async () => true);
		const rt = buildRescueRuntime({
			listPendingAlerts: () => [
				alertRow({
					event_type: "login_expired",
					event_id: "hash",
					session_key: null,
					lead_id: "mufasa-lead",
					project_name: "growth",
				}),
			],
			kickstart,
			captureLeadPane: async () => "⏵⏵ bypass permissions · healthy",
			sendEnterToLead: async () => {},
			isResumeMenu: () => false,
			revalidateRunner: async () => ({ confirmed: true }),
			closeAndDispatchSuccessor: async () => "exec-2",
			postEvidence: async () => {},
			audit: () => {},
			waitMs: async () => {},
		});
		const out = await rt.rescueLead({
			projectName: "growth",
			leadId: "mufasa-lead",
		});
		expect(out.ok).toBe(true);
		expect(kickstart).toHaveBeenCalledOnce();
	});

	it("postSwitchRescueSweep rescues every pending lead + runner from live rows", async () => {
		const kickstart = vi.fn(async () => true);
		const closeAndDispatchSuccessor = vi.fn(async () => "exec-2");
		const rt = buildRescueRuntime({
			listPendingAlerts: () => [
				alertRow({
					event_type: "login_expired",
					event_id: "hash",
					session_key: null,
					lead_id: "mufasa-lead",
					project_name: "growth",
				}),
				alertRow(), // runner exec-1
			],
			kickstart,
			captureLeadPane: async () => "healthy",
			sendEnterToLead: async () => {},
			isResumeMenu: () => false,
			revalidateRunner: async () => ({
				confirmed: true,
				category: "login_expired",
			}),
			closeAndDispatchSuccessor,
			postEvidence: async () => {},
			audit: () => {},
			waitMs: async () => {},
		});
		const outcomes = await rt.postSwitchRescueSweep();
		expect(outcomes).toHaveLength(2);
		expect(kickstart).toHaveBeenCalledOnce();
		expect(closeAndDispatchSuccessor).toHaveBeenCalledOnce();
		expect(outcomes.every((o) => o.ok)).toBe(true);
	});
});

// ── FLY-1224 (T4b) — phase-aware rescue-successor dispatch fields ──────────
describe("buildRescueSuccessorDispatchFields (FLY-1224 R1 #1 — the 6th lane)", () => {
	it("implement PHASE row with dispatch_model=NULL → full codex triple + shared-branch identity", () => {
		// The exact pre-fix bug shape: orchestrator-spawned phase rows persist NO
		// dispatch_model, so the old passthrough rescued a codex implement back
		// onto claude-tmux on an independent branch.
		const f = buildRescueSuccessorDispatchFields({
			chat_thread_role: "implement",
			session_role: "implement",
			dispatch_model: null,
		} as never);
		expect(f).toEqual({
			sessionRole: "implement",
			dispatchModel: "gpt-5.6-sol",
			dispatchVendor: "codex",
			dispatchEffort: "xhigh",
			ignoreRunnerLabelSelection: true,
			shareParentBranch: true,
		});
	});

	it("polluted row (chat_thread_role=implement, session_role=main) follows the DURABLE marker (R2 #3)", () => {
		const f = buildRescueSuccessorDispatchFields({
			chat_thread_role: "implement",
			session_role: "main",
			dispatch_model: null,
		} as never);
		expect(f.sessionRole).toBe("implement");
		expect(f.dispatchVendor).toBe("codex");
		expect(f.shareParentBranch).toBe(true);
	});

	it("qa PHASE row → claude triple (Opus, no effort) + shared-branch identity", () => {
		const f = buildRescueSuccessorDispatchFields({
			chat_thread_role: "qa",
			session_role: "qa",
			dispatch_model: null,
		} as never);
		expect(f.dispatchModel).toBe("claude-opus-4-8");
		expect(f.dispatchVendor).toBe("claude");
		expect(f.dispatchEffort).toBeUndefined();
		expect(f.shareParentBranch).toBe(true);
	});

	it("BYTE-COMPAT sentinel: a non-phase row passes its persisted fields verbatim", () => {
		const f = buildRescueSuccessorDispatchFields({
			chat_thread_role: "main",
			session_role: "main",
			dispatch_model: "claude-fable-5",
		} as never);
		expect(f).toEqual({
			sessionRole: "main",
			dispatchModel: "claude-fable-5",
		});
	});

	it("BYTE-COMPAT sentinel: a legacy row with NULL role/model stays all-undefined", () => {
		const f = buildRescueSuccessorDispatchFields({
			chat_thread_role: null,
			session_role: null,
			dispatch_model: null,
		} as never);
		expect(f).toEqual({
			sessionRole: undefined,
			dispatchModel: undefined,
		});
	});
});
