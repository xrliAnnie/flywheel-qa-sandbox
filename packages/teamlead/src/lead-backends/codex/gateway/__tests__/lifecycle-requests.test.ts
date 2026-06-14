import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	executeClaimedRequest,
	executeConfirmedRequest,
	LifecycleRequestStore,
	makePostconditionCheck,
	recoverLifecycleRequests,
} from "../lifecycle-requests.js";

let dir: string;
let store: LifecycleRequestStore;
let nowMs = 1_000_000;
const now = () => nowMs;

const BASE = {
	requestId: "req-1",
	questionId: "q-1",
	action: "terminate",
	execId: "exec-1",
	lifecycleRevision: 3,
	nonce: "nonce-1",
	project: "geoforge3d",
	leadId: "product-lead",
	ttlMs: 600_000,
};

function dbPath(): string {
	return join(dir, "lifecycle-requests.db");
}

beforeEach(() => {
	nowMs = 1_000_000;
	dir = mkdtempSync(join(tmpdir(), "fly245-lifecycle-"));
	store = new LifecycleRequestStore(dbPath(), now);
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("LifecycleRequestStore — persistence (D-f)", () => {
	it("create → get roundtrip with full binding, state=requested", () => {
		store.create(BASE);
		const row = store.get("req-1");
		expect(row).toBeDefined();
		expect(row?.state).toBe("requested");
		expect(row?.questionId).toBe("q-1");
		expect(row?.action).toBe("terminate");
		expect(row?.execId).toBe("exec-1");
		expect(row?.lifecycleRevision).toBe(3);
		expect(row?.nonce).toBe("nonce-1");
		expect(row?.project).toBe("geoforge3d");
		expect(row?.leadId).toBe("product-lead");
		expect(row?.channelId).toBeNull();
		expect(row?.messageId).toBeNull();
		expect(row?.expiresAt).toBe(nowMs + 600_000);
	});

	it("duplicate requestId create throws (request ids are unique)", () => {
		store.create(BASE);
		expect(() => store.create(BASE)).toThrow();
	});

	it("setConfirmationMessage persists channel/message id across reopen", () => {
		store.create(BASE);
		store.setConfirmationMessage("req-1", "chan-9", "msg-42");
		store.close();
		store = new LifecycleRequestStore(dbPath(), now);
		const row = store.get("req-1");
		expect(row?.channelId).toBe("chan-9");
		expect(row?.messageId).toBe("msg-42");
		expect(row?.state).toBe("requested");
	});

	it("state survives reopen (the whole point: crash durability)", () => {
		store.create(BASE);
		expect(store.transition("req-1", "requested", "confirmed")).toBe(true);
		store.close();
		store = new LifecycleRequestStore(dbPath(), now);
		expect(store.get("req-1")?.state).toBe("confirmed");
	});
});

describe("LifecycleRequestStore — transitions (CAS + legality)", () => {
	it("legal chain requested→confirmed→claimed→executing→succeeded", () => {
		store.create(BASE);
		expect(store.transition("req-1", "requested", "confirmed")).toBe(true);
		expect(store.transition("req-1", "confirmed", "claimed")).toBe(true);
		expect(store.transition("req-1", "claimed", "executing")).toBe(true);
		expect(
			store.transition("req-1", "executing", "succeeded", "executed"),
		).toBe(true);
		const row = store.get("req-1");
		expect(row?.state).toBe("succeeded");
		expect(row?.outcome).toBe("executed");
	});

	it("CAS: transition from a stale from-state returns false, row unchanged", () => {
		store.create(BASE);
		expect(store.transition("req-1", "confirmed", "claimed")).toBe(false);
		expect(store.get("req-1")?.state).toBe("requested");
	});

	it("illegal transition (requested→succeeded) throws — not silently applied", () => {
		store.create(BASE);
		expect(() => store.transition("req-1", "requested", "succeeded")).toThrow(
			/illegal/i,
		);
	});

	it("terminal states reject further transitions", () => {
		store.create(BASE);
		store.transition("req-1", "requested", "failed_retryable", "expired");
		expect(() =>
			store.transition("req-1", "failed_retryable", "confirmed"),
		).toThrow(/illegal/i);
	});

	it("unknown requestId transition returns false", () => {
		expect(store.transition("nope", "requested", "confirmed")).toBe(false);
	});

	it("listNonTerminal returns requested/confirmed/claimed/executing/ambiguous, not succeeded/failed_retryable", () => {
		const mk = (id: string) => store.create({ ...BASE, requestId: id });
		mk("r-req");
		mk("r-conf");
		store.transition("r-conf", "requested", "confirmed");
		mk("r-claim");
		store.transition("r-claim", "requested", "confirmed");
		store.transition("r-claim", "confirmed", "claimed");
		mk("r-exec");
		store.transition("r-exec", "requested", "confirmed");
		store.transition("r-exec", "confirmed", "claimed");
		store.transition("r-exec", "claimed", "executing");
		mk("r-amb");
		store.transition("r-amb", "requested", "confirmed");
		store.transition("r-amb", "confirmed", "claimed");
		store.transition("r-amb", "claimed", "executing");
		store.transition("r-amb", "executing", "ambiguous", "timeout");
		mk("r-done");
		store.transition("r-done", "requested", "confirmed");
		store.transition("r-done", "confirmed", "claimed");
		store.transition("r-done", "claimed", "executing");
		store.transition("r-done", "executing", "succeeded");
		mk("r-dead");
		store.transition("r-dead", "requested", "failed_retryable", "expired");

		const ids = recoverIds(store.listNonTerminal());
		expect(ids).toEqual(
			expect.arrayContaining(["r-req", "r-conf", "r-claim", "r-exec", "r-amb"]),
		);
		expect(ids).not.toContain("r-done");
		expect(ids).not.toContain("r-dead");
	});
});

function recoverIds(rows: { requestId: string }[]): string[] {
	return rows.map((r) => r.requestId);
}

describe("recoverLifecycleRequests — restart decision matrix (plan §5.2)", () => {
	const reached = vi.fn(async () => "reached" as const);
	const notReachedIdem = vi.fn(async () => "retry_safe" as const);
	const reconfirm = vi.fn(async () => "needs_reconfirm" as const);

	beforeEach(() => {
		reached.mockClear();
		notReachedIdem.mockClear();
		reconfirm.mockClear();
	});

	it("requested + unexpired + message persisted → resume_observe (poll resumes from persisted ids)", async () => {
		store.create(BASE);
		store.setConfirmationMessage("req-1", "chan-1", "msg-1");
		const report = await recoverLifecycleRequests(store, {
			now,
			postcondition: reached,
		});
		expect(report).toEqual([
			expect.objectContaining({
				requestId: "req-1",
				decision: "resume_observe",
			}),
		]);
		expect(reached).not.toHaveBeenCalled();
	});

	it("requested + unexpired + NO message persisted → resend_confirmation", async () => {
		store.create(BASE);
		const report = await recoverLifecycleRequests(store, {
			now,
			postcondition: reached,
		});
		expect(report[0].decision).toBe("resend_confirmation");
	});

	it("requested past TTL → failed_retryable(expired), decision expired", async () => {
		store.create(BASE);
		nowMs += 600_001;
		const report = await recoverLifecycleRequests(store, {
			now,
			postcondition: reached,
		});
		expect(report[0].decision).toBe("expired");
		expect(store.get("req-1")?.state).toBe("failed_retryable");
		expect(store.get("req-1")?.outcome).toBe("expired");
	});

	it("confirmed + unexpired → resume_execute", async () => {
		store.create(BASE);
		store.transition("req-1", "requested", "confirmed");
		const report = await recoverLifecycleRequests(store, {
			now,
			postcondition: reached,
		});
		expect(report[0].decision).toBe("resume_execute");
	});

	it("confirmed past TTL → expired (consent never claimed, safe to kill)", async () => {
		store.create(BASE);
		store.transition("req-1", "requested", "confirmed");
		nowMs += 600_001;
		const report = await recoverLifecycleRequests(store, {
			now,
			postcondition: reached,
		});
		expect(report[0].decision).toBe("expired");
		expect(store.get("req-1")?.state).toBe("failed_retryable");
	});

	it("claimed + postcondition reached → succeeded WITHOUT replay (never blind-replays a claimed row)", async () => {
		store.create(BASE);
		store.transition("req-1", "requested", "confirmed");
		store.transition("req-1", "confirmed", "claimed");
		const report = await recoverLifecycleRequests(store, {
			now,
			postcondition: reached,
		});
		expect(report[0].decision).toBe("already_succeeded");
		expect(store.get("req-1")?.state).toBe("succeeded");
		expect(store.get("req-1")?.outcome).toBe("recovered_postcondition");
		expect(reached).toHaveBeenCalledTimes(1);
	});

	it("executing + postcondition retry_safe → retry_safe_reexecute (caller re-drives, row stays)", async () => {
		store.create(BASE);
		store.transition("req-1", "requested", "confirmed");
		store.transition("req-1", "confirmed", "claimed");
		store.transition("req-1", "claimed", "executing");
		const report = await recoverLifecycleRequests(store, {
			now,
			postcondition: notReachedIdem,
		});
		expect(report[0].decision).toBe("retry_safe_reexecute");
		expect(store.get("req-1")?.state).toBe("executing");
	});

	it("claimed + postcondition needs_reconfirm → ambiguous (no auto-retry of an irreversible action)", async () => {
		store.create(BASE);
		store.transition("req-1", "requested", "confirmed");
		store.transition("req-1", "confirmed", "claimed");
		const report = await recoverLifecycleRequests(store, {
			now,
			postcondition: reconfirm,
		});
		expect(report[0].decision).toBe("needs_reconfirm");
		expect(store.get("req-1")?.state).toBe("ambiguous");
	});

	it("postcondition THROWS → ambiguous (fail-closed, never assume success or retry)", async () => {
		store.create(BASE);
		store.transition("req-1", "requested", "confirmed");
		store.transition("req-1", "confirmed", "claimed");
		const report = await recoverLifecycleRequests(store, {
			now,
			postcondition: async () => {
				throw new Error("bridge down");
			},
		});
		expect(report[0].decision).toBe("needs_reconfirm");
		expect(store.get("req-1")?.state).toBe("ambiguous");
	});

	it("pre-existing ambiguous row → needs_reconfirm, postcondition NOT consulted again", async () => {
		store.create(BASE);
		store.transition("req-1", "requested", "confirmed");
		store.transition("req-1", "confirmed", "claimed");
		store.transition("req-1", "claimed", "executing");
		store.transition("req-1", "executing", "ambiguous", "timeout");
		const report = await recoverLifecycleRequests(store, {
			now,
			postcondition: reached,
		});
		expect(report[0].decision).toBe("needs_reconfirm");
		expect(reached).not.toHaveBeenCalled();
	});

	it("terminal rows are not surfaced", async () => {
		store.create(BASE);
		store.transition("req-1", "requested", "failed_retryable", "expired");
		const report = await recoverLifecycleRequests(store, {
			now,
			postcondition: reached,
		});
		expect(report).toEqual([]);
	});
});

describe("executeConfirmedRequest — verify→claim→re-check→dispatch (plan §5.2/§5.3)", () => {
	function deps(
		overrides: Partial<Parameters<typeof executeConfirmedRequest>[2]> = {},
	) {
		return {
			verify: vi.fn(() => ({ allowed: true, reason: "approved" as const })),
			claim: vi.fn(() => true),
			currentRevision: vi.fn((): number | undefined => 3),
			dispatch: vi.fn(async () => ({ kind: "success" as const })),
			...overrides,
		};
	}

	function mkConfirmed() {
		store.create(BASE);
		store.transition("req-1", "requested", "confirmed");
	}

	it("happy path: verify → claim → revision re-check → dispatch → succeeded", async () => {
		mkConfirmed();
		const d = deps();
		const res = await executeConfirmedRequest(store, "req-1", d);
		expect(res).toEqual({ executed: true, finalState: "succeeded" });
		expect(store.get("req-1")?.state).toBe("succeeded");
		// ordering: claim happens before dispatch; revision re-check after claim
		expect(d.verify).toHaveBeenCalledTimes(1);
		expect(d.claim).toHaveBeenCalledTimes(1);
		expect(d.currentRevision).toHaveBeenCalledTimes(1);
		expect(d.dispatch).toHaveBeenCalledTimes(1);
		expect(d.claim.mock.invocationCallOrder[0]).toBeLessThan(
			d.dispatch.mock.invocationCallOrder[0],
		);
		expect(d.currentRevision.mock.invocationCallOrder[0]).toBeGreaterThan(
			d.claim.mock.invocationCallOrder[0],
		);
		expect(d.currentRevision.mock.invocationCallOrder[0]).toBeLessThan(
			d.dispatch.mock.invocationCallOrder[0],
		);
	});

	it("verify denied → failed_retryable(verify:<reason>), claim & dispatch never called", async () => {
		mkConfirmed();
		const d = deps({
			verify: vi.fn(() => ({
				allowed: false,
				reason: "revision_stale" as const,
			})),
		});
		const res = await executeConfirmedRequest(store, "req-1", d);
		expect(res.executed).toBe(false);
		expect(store.get("req-1")?.state).toBe("failed_retryable");
		expect(store.get("req-1")?.outcome).toBe("verify:revision_stale");
		expect(d.claim).not.toHaveBeenCalled();
		expect(d.dispatch).not.toHaveBeenCalled();
	});

	it("verify THROWS → fail-closed failed_retryable, nothing consumed", async () => {
		mkConfirmed();
		const d = deps({
			verify: vi.fn(() => {
				throw new Error("db locked");
			}),
		});
		const res = await executeConfirmedRequest(store, "req-1", d);
		expect(res.executed).toBe(false);
		expect(store.get("req-1")?.state).toBe("failed_retryable");
		expect(d.claim).not.toHaveBeenCalled();
		expect(d.dispatch).not.toHaveBeenCalled();
	});

	it("claim lost (returns false) → failed_retryable(claim_lost), dispatch never called", async () => {
		mkConfirmed();
		const d = deps({ claim: vi.fn(() => false) });
		const res = await executeConfirmedRequest(store, "req-1", d);
		expect(res.executed).toBe(false);
		expect(store.get("req-1")?.outcome).toBe("claim_lost");
		expect(d.dispatch).not.toHaveBeenCalled();
	});

	it("revision stale AFTER claim → failed_retryable(revision_stale_post_claim), dispatch REFUSED", async () => {
		mkConfirmed();
		const d = deps({ currentRevision: vi.fn(() => 4) });
		const res = await executeConfirmedRequest(store, "req-1", d);
		expect(res.executed).toBe(false);
		expect(store.get("req-1")?.state).toBe("failed_retryable");
		expect(store.get("req-1")?.outcome).toBe("revision_stale_post_claim");
		expect(d.dispatch).not.toHaveBeenCalled();
	});

	it("revision unreadable AFTER claim → fail-closed, dispatch REFUSED", async () => {
		mkConfirmed();
		const d = deps({ currentRevision: vi.fn(() => undefined) });
		const res = await executeConfirmedRequest(store, "req-1", d);
		expect(res.executed).toBe(false);
		expect(d.dispatch).not.toHaveBeenCalled();
	});

	it("dispatch not_dispatched → failed_retryable (provably never reached the Bridge)", async () => {
		mkConfirmed();
		const d = deps({
			dispatch: vi.fn(async () => ({
				kind: "not_dispatched" as const,
				detail: "ECONNREFUSED",
			})),
		});
		const res = await executeConfirmedRequest(store, "req-1", d);
		expect(res.executed).toBe(false);
		expect(store.get("req-1")?.state).toBe("failed_retryable");
		expect(store.get("req-1")?.outcome).toContain("ECONNREFUSED");
	});

	it("dispatch unknown (timeout) → ambiguous — outcome unknown, never auto-replay", async () => {
		mkConfirmed();
		const d = deps({
			dispatch: vi.fn(async () => ({
				kind: "unknown" as const,
				detail: "timeout",
			})),
		});
		const res = await executeConfirmedRequest(store, "req-1", d);
		expect(res.executed).toBe(false);
		expect(store.get("req-1")?.state).toBe("ambiguous");
	});

	it("dispatch THROWS → ambiguous (fail-closed: the HTTP may have landed)", async () => {
		mkConfirmed();
		const d = deps({
			dispatch: vi.fn(async () => {
				throw new Error("socket hang up");
			}),
		});
		const res = await executeConfirmedRequest(store, "req-1", d);
		expect(res.executed).toBe(false);
		expect(store.get("req-1")?.state).toBe("ambiguous");
	});

	it("row not in confirmed state → refused without side effects", async () => {
		store.create(BASE);
		const d = deps();
		const res = await executeConfirmedRequest(store, "req-1", d);
		expect(res.executed).toBe(false);
		expect(d.verify).not.toHaveBeenCalled();
		expect(d.claim).not.toHaveBeenCalled();
	});
});

describe("executeClaimedRequest — recovery re-drive (claim already consumed)", () => {
	it("re-drives from executing state: revision re-check + dispatch, NO re-claim", async () => {
		store.create(BASE);
		store.transition("req-1", "requested", "confirmed");
		store.transition("req-1", "confirmed", "claimed");
		store.transition("req-1", "claimed", "executing");
		const dispatch = vi.fn(async () => ({ kind: "success" as const }));
		const currentRevision = vi.fn(() => 3);
		const res = await executeClaimedRequest(store, "req-1", {
			currentRevision,
			dispatch,
		});
		expect(res.executed).toBe(true);
		expect(store.get("req-1")?.state).toBe("succeeded");
		expect(currentRevision).toHaveBeenCalled();
	});

	it("re-drive from claimed state works too (crash between claim and executing write)", async () => {
		store.create(BASE);
		store.transition("req-1", "requested", "confirmed");
		store.transition("req-1", "confirmed", "claimed");
		const res = await executeClaimedRequest(store, "req-1", {
			currentRevision: () => 3,
			dispatch: async () => ({ kind: "success" as const }),
		});
		expect(res.executed).toBe(true);
		expect(store.get("req-1")?.state).toBe("succeeded");
	});

	it("stale revision on re-drive → refused (failed_retryable), dispatch not called", async () => {
		store.create(BASE);
		store.transition("req-1", "requested", "confirmed");
		store.transition("req-1", "confirmed", "claimed");
		const dispatch = vi.fn(async () => ({ kind: "success" as const }));
		const res = await executeClaimedRequest(store, "req-1", {
			currentRevision: () => 99,
			dispatch,
		});
		expect(res.executed).toBe(false);
		expect(dispatch).not.toHaveBeenCalled();
		expect(store.get("req-1")?.state).toBe("failed_retryable");
	});
});

describe("makePostconditionCheck — §5.2.1 action-specific verifiers", () => {
	it("terminate: session terminal or missing → reached; live → retry_safe (idempotent)", async () => {
		const check = makePostconditionCheck("terminate", {
			sessionStatus: async () => "terminated",
		});
		expect(await check()).toBe("reached");
		const gone = makePostconditionCheck("terminate", {
			sessionStatus: async () => undefined,
		});
		expect(await gone()).toBe("reached");
		const live = makePostconditionCheck("terminate", {
			sessionStatus: async () => "running",
		});
		expect(await live()).toBe("retry_safe");
	});

	it("reject/defer/shelve: status equals target → reached; else retry_safe", async () => {
		expect(
			await makePostconditionCheck("reject", {
				sessionStatus: async () => "rejected",
			})(),
		).toBe("reached");
		expect(
			await makePostconditionCheck("defer", {
				sessionStatus: async () => "awaiting_review",
			})(),
		).toBe("retry_safe");
		expect(
			await makePostconditionCheck("shelve", {
				sessionStatus: async () => "shelved",
			})(),
		).toBe("reached");
	});

	it("close_tmux/close_runner: resource absent → reached; present → retry_safe", async () => {
		expect(
			await makePostconditionCheck("close_tmux", {
				sessionStatus: async () => "completed",
				tmuxPresent: async () => false,
			})(),
		).toBe("reached");
		expect(
			await makePostconditionCheck("close_runner", {
				sessionStatus: async () => "completed",
				runnerPresent: async () => true,
			})(),
		).toBe("retry_safe");
	});

	it("retry (non-idempotent): needs_reconfirm until D2 wires the started-evidence reconciler", async () => {
		expect(
			await makePostconditionCheck("retry", {
				sessionStatus: async () => "running",
			})(),
		).toBe("needs_reconfirm");
	});

	it("probe failure → needs_reconfirm (fail-closed, never guess)", async () => {
		expect(
			await makePostconditionCheck("terminate", {
				sessionStatus: async () => {
					throw new Error("state db unreadable");
				},
			})(),
		).toBe("needs_reconfirm");
	});

	it("unknown action → needs_reconfirm (fail-closed)", async () => {
		expect(
			await makePostconditionCheck("frobnicate", {
				sessionStatus: async () => "running",
			})(),
		).toBe("needs_reconfirm");
	});
});
