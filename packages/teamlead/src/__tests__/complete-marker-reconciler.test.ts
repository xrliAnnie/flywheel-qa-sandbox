import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CODEX R1 MEDIUM: applyQuarantineFallback prefers the canonical applyTransition
// path; mock it so we can assert FSM-accept vs FSM-reject (fail-close) branches.
vi.mock("../applyTransition.js", () => ({
	applyTransition: vi.fn(() => ({ ok: true })),
}));

import { applyTransition } from "../applyTransition.js";
import {
	applyQuarantineFallback,
	buildLoopbackBaseUrl,
	expectedStatusFromMarker,
	reconcileCompleteFailedMarkers,
	tryReconcileComplete,
} from "../bridge/complete-marker-reconciler.js";

const mockedApplyTransition = vi.mocked(applyTransition);

type SessionRow = { status: string; project_name?: string };

/** Minimal in-memory StateStore stub matching the reconciler's usage. */
function makeStore(initial: Record<string, SessionRow> = {}) {
	const sessions = new Map<string, SessionRow>(Object.entries(initial));
	return {
		sessions,
		getSession: vi.fn((id: string) => sessions.get(id)),
		forceStatus: vi.fn(
			(id: string, status: string, _now: string, lastError?: string) => {
				const cur = sessions.get(id) ?? {};
				sessions.set(id, {
					...cur,
					status,
					last_error: lastError,
				} as SessionRow);
			},
		),
	};
}

function writeMarker(
	dir: string,
	execId: string,
	overrides: Record<string, unknown> = {},
): void {
	mkdirSync(dir, { recursive: true });
	const body = {
		event_id: `evt-${execId}`,
		execution_id: execId,
		issue_id: "iss-1",
		project_name: "geoforge3d",
		event_type: "session_completed",
		source: "flywheel-comm",
		payload: {
			decision: { route: "needs_review" },
			evidence: { landingStatus: undefined },
			sessionRole: "main",
		},
		...overrides,
	};
	writeFileSync(join(dir, `${execId}.json`), JSON.stringify(body), "utf8");
}

describe("buildLoopbackBaseUrl", () => {
	it("plain IPv4/host", () => {
		expect(buildLoopbackBaseUrl("127.0.0.1", 9876)).toBe(
			"http://127.0.0.1:9876",
		);
		expect(buildLoopbackBaseUrl("localhost", 1234)).toBe(
			"http://localhost:1234",
		);
	});
	it("brackets IPv6 (Codex R1 #5)", () => {
		expect(buildLoopbackBaseUrl("::1", 9876)).toBe("http://[::1]:9876");
	});
});

describe("expectedStatusFromMarker (event-route parity, Codex R2 #6)", () => {
	const mk = (route: string | undefined, merged: boolean) => ({
		event_id: "e",
		execution_id: "x",
		issue_id: "i",
		project_name: "p",
		event_type: "session_completed",
		payload: {
			decision: route ? { route } : {},
			evidence: merged
				? { landingStatus: { status: "merged" } }
				: { landingStatus: undefined },
		},
	});
	it("needs_review → awaiting_review; +merged → completed", () => {
		expect(expectedStatusFromMarker(mk("needs_review", false), "running")).toBe(
			"awaiting_review",
		);
		expect(expectedStatusFromMarker(mk("needs_review", true), "running")).toBe(
			"completed",
		);
	});
	it("auto_approve → awaiting_review; +merged → completed", () => {
		expect(expectedStatusFromMarker(mk("auto_approve", false), "running")).toBe(
			"awaiting_review",
		);
		expect(expectedStatusFromMarker(mk("auto_approve", true), "running")).toBe(
			"completed",
		);
	});
	it("blocked → blocked", () => {
		expect(expectedStatusFromMarker(mk("blocked", false), "running")).toBe(
			"blocked",
		);
	});
	// FLY-222 #1 (Codex code-review MED-1 + MED-2 parity): no_code marker maps to
	// completed ONLY from a running session; from any non-running state it is
	// null (quarantine), so a no_code marker can't clear a review-gated session.
	// FLY-493: pr_handoff marker behaves exactly like no_code (running→completed,
	// non-running→null) so a fail-close pr_handoff marker is reconciled, not
	// quarantined, and can never clear a review-gated session.
	it("pr_handoff from running → completed; from non-running → null", () => {
		expect(expectedStatusFromMarker(mk("pr_handoff", false), "running")).toBe(
			"completed",
		);
		expect(
			expectedStatusFromMarker(mk("pr_handoff", false), "awaiting_review"),
		).toBeNull();
		expect(
			expectedStatusFromMarker(mk("pr_handoff", false), "approved_to_ship"),
		).toBeNull();
		expect(
			expectedStatusFromMarker(mk("pr_handoff", false), undefined),
		).toBeNull();
	});
	// FLY-793 (Codex full-PR R1 #2): phase_design_complete marker must be
	// replayable (crash-safety for the Design→Implement handoff). Maps to the
	// non-terminal design_done from running; fail-closed (null) from any
	// non-running state, mirroring both sink guards.
	it("phase_design_complete from running → design_done; from non-running → null", () => {
		expect(
			expectedStatusFromMarker(mk("phase_design_complete", false), "running"),
		).toBe("design_done");
		expect(
			expectedStatusFromMarker(
				mk("phase_design_complete", false),
				"design_done",
			),
		).toBeNull();
		expect(
			expectedStatusFromMarker(mk("phase_design_complete", false), "completed"),
		).toBeNull();
		expect(
			expectedStatusFromMarker(mk("phase_design_complete", false), undefined),
		).toBeNull();
	});
	it("no_code from running → completed; from non-running → null", () => {
		expect(expectedStatusFromMarker(mk("no_code", false), "running")).toBe(
			"completed",
		);
		expect(
			expectedStatusFromMarker(mk("no_code", false), "awaiting_review"),
		).toBeNull();
		expect(
			expectedStatusFromMarker(mk("no_code", false), "approved_to_ship"),
		).toBeNull();
		expect(
			expectedStatusFromMarker(mk("no_code", false), undefined),
		).toBeNull();
	});
	it("FLY-208 5a (Codex PR-2 R1 HIGH): approved_to_ship + needs_review/auto_approve + NOT merged → completed (evidence-gap parity)", () => {
		// /events now unsticks approved_to_ship re-completions without merge
		// evidence to "completed". A stale "awaiting_review" expectation here
		// would quarantine a correctly-reconciled marker and the boot-drain
		// fallback could force the session to "failed" — a false failure on
		// the exact Bridge-down recovery path markers protect.
		expect(
			expectedStatusFromMarker(mk("needs_review", false), "approved_to_ship"),
		).toBe("completed");
		expect(
			expectedStatusFromMarker(mk("auto_approve", false), "approved_to_ship"),
		).toBe("completed");
		// Merged stays completed; blocked stays blocked (FSM edge added).
		expect(
			expectedStatusFromMarker(mk("needs_review", true), "approved_to_ship"),
		).toBe("completed");
		expect(
			expectedStatusFromMarker(mk("blocked", false), "approved_to_ship"),
		).toBe("blocked");
	});

	// FLY-945 Fix C: the recovery lap — approved_to_ship + needs_review whose
	// marker carries a NEW reviewQuestionId (≠ the row's current binding) maps
	// to awaiting_review (event-route re-opens the review window on replay);
	// the expectation copy MUST agree or the correctly-replayed marker gets
	// quarantined and boot drain can false-fail the session.
	it("FLY-945: approved_to_ship + needs_review + NEW marker questionId → awaiting_review", () => {
		const marker = mk("needs_review", false) as ReturnType<typeof mk> & {
			payload: Record<string, unknown>;
		};
		marker.payload.reviewQuestionId = "22222222-2222-2222-2222-222222222222";
		expect(
			expectedStatusFromMarker(
				marker,
				"approved_to_ship",
				"11111111-1111-1111-1111-111111111111",
			),
		).toBe("awaiting_review");
	});
	it("FLY-945: SAME / malformed / missing marker questionId → 5a completed (fail-safe)", () => {
		const same = mk("needs_review", false) as ReturnType<typeof mk> & {
			payload: Record<string, unknown>;
		};
		same.payload.reviewQuestionId = "11111111-1111-1111-1111-111111111111";
		expect(
			expectedStatusFromMarker(
				same,
				"approved_to_ship",
				"11111111-1111-1111-1111-111111111111",
			),
		).toBe("completed");
		const malformed = mk("needs_review", false) as ReturnType<typeof mk> & {
			payload: Record<string, unknown>;
		};
		malformed.payload.reviewQuestionId = "not a qid!!";
		expect(
			expectedStatusFromMarker(
				malformed,
				"approved_to_ship",
				"11111111-1111-1111-1111-111111111111",
			),
		).toBe("completed");
		// legacy call shape (no currentReviewQuestionId) + no marker qid → 5a
		expect(
			expectedStatusFromMarker(mk("needs_review", false), "approved_to_ship"),
		).toBe("completed");
	});
	it("FLY-945: auto_approve NEVER takes the recovery lap (needs_review only)", () => {
		const marker = mk("auto_approve", false) as ReturnType<typeof mk> & {
			payload: Record<string, unknown>;
		};
		marker.payload.reviewQuestionId = "22222222-2222-2222-2222-222222222222";
		expect(
			expectedStatusFromMarker(
				marker,
				"approved_to_ship",
				"11111111-1111-1111-1111-111111111111",
			),
		).toBe("completed");
	});

	it("undefined route + approved_to_ship → completed (natural completion)", () => {
		expect(
			expectedStatusFromMarker(mk(undefined, false), "approved_to_ship"),
		).toBe("completed");
	});
	it("undefined/invalid route without post-approve-ship → null (route guard would reject)", () => {
		expect(
			expectedStatusFromMarker(mk(undefined, false), "running"),
		).toBeNull();
		expect(
			expectedStatusFromMarker(mk("garbage", false), "running"),
		).toBeNull();
	});
});

describe("tryReconcileComplete", () => {
	let dir: string;
	let markerDir: string;
	let quarantineDir: string;

	beforeEach(() => {
		process.env.FLYWHEEL_MERGE_APPROVAL_GATE = "0"; // FLY-869: FSM tests bypass ship gate
		process.env.FLYWHEEL_QA_DONE_GATE = "0";
		dir = mkdtempSync(join(tmpdir(), "fly172-"));
		markerDir = join(dir, "complete-failed");
		quarantineDir = join(dir, "quarantine");
	});
	afterEach(() => {
		delete process.env.FLYWHEEL_MERGE_APPROVAL_GATE;
		delete process.env.FLYWHEEL_QA_DONE_GATE;
		rmSync(dir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	const baseDeps = (
		store: ReturnType<typeof makeStore>,
		fetchFn?: typeof fetch,
	) => ({
		store: store as never,
		bridgeBaseUrl: "http://127.0.0.1:9876",
		ingestToken: "tok",
		fetchFn,
		markerDir,
		quarantineDir,
		log: () => {},
	});

	it("absent when no marker", async () => {
		const store = makeStore();
		const r = await tryReconcileComplete("nope", baseDeps(store));
		expect(r.kind).toBe("absent");
	});

	it("FLY-208 5a regression (Codex PR-2 R1 HIGH): approved_to_ship + needs_review + ready_to_merge marker reconciles to completed — NO quarantine", async () => {
		// The evidence-gap unstick: /events maps this replay to "completed".
		// Pre-fix the reconciler expected "awaiting_review", saw "completed",
		// quarantined the marker, and boot drain could force the
		// successfully-unstuck session to "failed".
		writeMarker(markerDir, "execGap", {
			payload: {
				decision: { route: "needs_review" },
				evidence: { landingStatus: { status: "ready_to_merge", prNumber: 16 } },
				sessionRole: "main",
			},
		});
		const store = makeStore({ execGap: { status: "approved_to_ship" } });
		const fetchFn = vi.fn(async () => {
			// Replay through /events lands the 5a mapping.
			store.sessions.set("execGap", { status: "completed" });
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		});
		const r = await tryReconcileComplete(
			"execGap",
			baseDeps(store, fetchFn as never),
		);
		expect(r).toEqual({ kind: "reconciled", status: "completed" });
		// Marker deleted as reconciled; nothing quarantined.
		expect(readdirSync(markerDir)).not.toContain("execGap.json");
		expect(
			existsSync(quarantineDir) ? readdirSync(quarantineDir) : [],
		).toHaveLength(0);
		// Session keeps the unstuck terminal status.
		expect(store.sessions.get("execGap")?.status).toBe("completed");
	});

	it("reconciled: replay drives session to expected terminal, deletes marker", async () => {
		writeMarker(markerDir, "exec1"); // needs_review (no merge) → awaiting_review
		const store = makeStore({ exec1: { status: "running" } });
		const fetchFn = vi.fn(async () => {
			store.sessions.set("exec1", { status: "awaiting_review" });
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		});
		const r = await tryReconcileComplete(
			"exec1",
			baseDeps(store, fetchFn as never),
		);
		expect(r).toEqual({ kind: "reconciled", status: "awaiting_review" });
		expect(readdirSync(markerDir)).not.toContain("exec1.json");
		// auth header present
		const call = fetchFn.mock.calls[0]?.[1] as RequestInit;
		expect((call.headers as Record<string, string>).Authorization).toBe(
			"Bearer tok",
		);
	});

	it("duplicate_terminal: session already at expected → delete without replay", async () => {
		writeMarker(markerDir, "exec2"); // needs_review → awaiting_review
		const store = makeStore({ exec2: { status: "awaiting_review" } });
		const fetchFn = vi.fn();
		const r = await tryReconcileComplete(
			"exec2",
			baseDeps(store, fetchFn as never),
		);
		expect(r).toEqual({
			kind: "duplicate_terminal",
			status: "awaiting_review",
		});
		expect(fetchFn).not.toHaveBeenCalled();
		expect(readdirSync(markerDir)).not.toContain("exec2.json");
	});

	it("transient_failed on 5xx: keeps marker", async () => {
		writeMarker(markerDir, "exec3");
		const store = makeStore({ exec3: { status: "running" } });
		const fetchFn = vi.fn(async () => new Response("err", { status: 503 }));
		const r = await tryReconcileComplete(
			"exec3",
			baseDeps(store, fetchFn as never),
		);
		expect(r.kind).toBe("transient_failed");
		expect(readdirSync(markerDir)).toContain("exec3.json");
	});

	it("transient_failed on network error: keeps marker", async () => {
		writeMarker(markerDir, "exec3b");
		const store = makeStore({ exec3b: { status: "running" } });
		const fetchFn = vi.fn(async () => {
			throw new Error("ECONNREFUSED");
		});
		const r = await tryReconcileComplete(
			"exec3b",
			baseDeps(store, fetchFn as never),
		);
		expect(r.kind).toBe("transient_failed");
		expect(readdirSync(markerDir)).toContain("exec3b.json");
	});

	it("rejected: 200+warning (FSM/route reject), session stays running → quarantine (Codex R1 #3)", async () => {
		writeMarker(markerDir, "exec4"); // expected awaiting_review
		const store = makeStore({ exec4: { status: "running" } });
		const fetchFn = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ ok: true, warning: "invalid route skipped" }),
					{
						status: 200,
					},
				),
		);
		const r = await tryReconcileComplete(
			"exec4",
			baseDeps(store, fetchFn as never),
		);
		expect(r.kind).toBe("quarantined");
		if (r.kind === "quarantined") expect(r.reason).toBe("rejected");
		expect(readdirSync(markerDir)).not.toContain("exec4.json");
		expect(readdirSync(quarantineDir)).toContain("exec4.json");
	});

	it("duplicate_nonterminal: {duplicate:true} but still running → quarantine, not retried (Codex R2 #2)", async () => {
		writeMarker(markerDir, "exec5");
		const store = makeStore({ exec5: { status: "running" } });
		const fetchFn = vi.fn(
			async () =>
				new Response(JSON.stringify({ ok: true, duplicate: true }), {
					status: 200,
				}),
		);
		const r = await tryReconcileComplete(
			"exec5",
			baseDeps(store, fetchFn as never),
		);
		expect(r.kind).toBe("quarantined");
		if (r.kind === "quarantined")
			expect(r.reason).toBe("duplicate_nonterminal");
		expect(readdirSync(quarantineDir)).toContain("exec5.json");
	});

	it("invalid: corrupt JSON → quarantine", async () => {
		mkdirSync(markerDir, { recursive: true });
		writeFileSync(join(markerDir, "exec6.json"), "{ not json", "utf8");
		const store = makeStore({ exec6: { status: "running" } });
		const r = await tryReconcileComplete("exec6", baseDeps(store));
		expect(r.kind).toBe("quarantined");
		if (r.kind === "quarantined") expect(r.reason).toBe("invalid");
		expect(readdirSync(quarantineDir)).toContain("exec6.json");
	});

	it("invalid: filename execId mismatch payload → quarantine (Codex R1 #7)", async () => {
		writeMarker(markerDir, "exec7", { execution_id: "different" });
		const store = makeStore({ exec7: { status: "running" } });
		const r = await tryReconcileComplete("exec7", baseDeps(store));
		expect(r.kind).toBe("quarantined");
		if (r.kind === "quarantined") expect(r.reason).toBe("invalid");
	});

	it("unreplayable route (missing route, running) → quarantine before any POST", async () => {
		writeMarker(markerDir, "exec8", {
			payload: { decision: {}, evidence: {} },
		});
		const store = makeStore({ exec8: { status: "running" } });
		const fetchFn = vi.fn();
		const r = await tryReconcileComplete(
			"exec8",
			baseDeps(store, fetchFn as never),
		);
		expect(r.kind).toBe("quarantined");
		if (r.kind === "quarantined") expect(r.reason).toBe("rejected");
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("path-traversal execId → absent (guard)", async () => {
		const store = makeStore();
		const r = await tryReconcileComplete("../etc/passwd", baseDeps(store));
		expect(r.kind).toBe("absent");
	});

	// FLY-222 #1 (Codex code-review R2 MED): a no_code marker that lost its
	// response AFTER the Bridge already completed the run must NOT regress
	// completed→failed. The unreplayable (non-running) marker on an already
	// terminal session is a duplicate → deleted, no quarantine, no POST.
	it("no_code marker for already-completed session → duplicate_terminal (no quarantine, no POST)", async () => {
		writeMarker(markerDir, "execNC", {
			payload: { decision: { route: "no_code" }, evidence: {} },
		});
		const store = makeStore({ execNC: { status: "completed" } });
		const fetchFn = vi.fn();
		const r = await tryReconcileComplete(
			"execNC",
			baseDeps(store, fetchFn as never),
		);
		expect(r.kind).toBe("duplicate_terminal");
		expect(fetchFn).not.toHaveBeenCalled();
		expect(store.forceStatus).not.toHaveBeenCalled();
		// deleted, not quarantined (dir never created)
		expect(existsSync(join(markerDir, "execNC.json"))).toBe(false);
		expect(existsSync(quarantineDir) ? readdirSync(quarantineDir) : []).toEqual(
			[],
		);
	});

	// no_code marker on a RUNNING session replays normally to completed.
	it("no_code marker for running session → replays (reconciled)", async () => {
		writeMarker(markerDir, "execNCr", {
			payload: { decision: { route: "no_code" }, evidence: {} },
		});
		const store = makeStore({ execNCr: { status: "running" } });
		const fetchFn = vi.fn(async () => {
			store.sessions.set("execNCr", { status: "completed" });
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		});
		const r = await tryReconcileComplete(
			"execNCr",
			baseDeps(store, fetchFn as never),
		);
		expect(r.kind).toBe("reconciled");
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});
});

describe("applyQuarantineFallback (Codex R2 #3)", () => {
	it("tmux dead → forces session to routeStatus with quarantine breadcrumb", () => {
		const store = makeStore({ d1: { status: "running" } });
		applyQuarantineFallback({
			store: store as never,
			executionId: "d1",
			tmuxAlive: false,
			routeStatus: "blocked",
			quarantinePath: "/q/d1.json",
			log: () => {},
		});
		expect(store.forceStatus).toHaveBeenCalledWith(
			"d1",
			"blocked",
			expect.any(String),
			expect.stringContaining("/q/d1.json"),
		);
	});
	it("tmux dead + no routeStatus → failed", () => {
		const store = makeStore({ d2: { status: "running" } });
		applyQuarantineFallback({
			store: store as never,
			executionId: "d2",
			tmuxAlive: false,
			quarantinePath: "/q/d2.json",
			log: () => {},
		});
		expect(store.forceStatus).toHaveBeenCalledWith(
			"d2",
			"failed",
			expect.any(String),
			expect.any(String),
		);
	});
	it("tmux alive → leaves session running (no forceStatus)", () => {
		const store = makeStore({ d3: { status: "running" } });
		applyQuarantineFallback({
			store: store as never,
			executionId: "d3",
			tmuxAlive: true,
			routeStatus: "blocked",
			quarantinePath: "/q/d3.json",
			log: () => {},
		});
		expect(store.forceStatus).not.toHaveBeenCalled();
	});

	it("CODEX R1 MEDIUM: transitionOpts present + FSM allows → applyTransition (no direct forceStatus)", () => {
		mockedApplyTransition.mockReset().mockReturnValue({ ok: true } as never);
		const store = makeStore({ d4: { status: "running" } });
		applyQuarantineFallback({
			store: store as never,
			transitionOpts: { fake: true } as never,
			executionId: "d4",
			issueId: "iss-d4",
			projectName: "geoforge3d",
			tmuxAlive: false,
			routeStatus: "blocked",
			quarantinePath: "/q/d4.json",
			log: () => {},
		});
		expect(mockedApplyTransition).toHaveBeenCalledWith(
			expect.anything(),
			"d4",
			"blocked",
			expect.objectContaining({ trigger: "complete_marker_quarantine" }),
			expect.objectContaining({
				last_error: expect.stringContaining("/q/d4.json"),
			}),
		);
		// FSM accepted → no fail-close direct write
		expect(store.forceStatus).not.toHaveBeenCalled();
	});

	it("CODEX R1 MEDIUM: transitionOpts present but FSM rejects → fail-close forceStatus", () => {
		mockedApplyTransition
			.mockReset()
			.mockReturnValue({ ok: false, error: "illegal" } as never);
		const store = makeStore({ d5: { status: "running" } });
		applyQuarantineFallback({
			store: store as never,
			transitionOpts: { fake: true } as never,
			executionId: "d5",
			issueId: "iss-d5",
			projectName: "geoforge3d",
			tmuxAlive: false,
			routeStatus: "blocked",
			quarantinePath: "/q/d5.json",
			log: () => {},
		});
		expect(mockedApplyTransition).toHaveBeenCalled();
		// FSM rejected → must still reach a definite terminal status (fail-close)
		expect(store.forceStatus).toHaveBeenCalledWith(
			"d5",
			"blocked",
			expect.any(String),
			expect.stringContaining("/q/d5.json"),
		);
	});

	// FLY-222 #1 (Codex code-review R2 MED): the fallback rescues a `running`-stuck
	// dead Runner ONLY. A non-running session must never be force-failed by a
	// stale quarantined marker (completed→failed regression / review-gate clear).
	it.each(["completed", "awaiting_review", "approved_to_ship", "blocked"])(
		"tmux dead but status=%s (not running) → no mutation",
		(status) => {
			mockedApplyTransition.mockReset().mockReturnValue({ ok: true } as never);
			const store = makeStore({ dn: { status } });
			applyQuarantineFallback({
				store: store as never,
				transitionOpts: { fake: true } as never,
				executionId: "dn",
				tmuxAlive: false,
				quarantinePath: "/q/dn.json",
				log: () => {},
			});
			expect(store.forceStatus).not.toHaveBeenCalled();
			expect(mockedApplyTransition).not.toHaveBeenCalled();
			expect(store.sessions.get("dn")?.status).toBe(status);
		},
	);
});

describe("reconcileCompleteFailedMarkers (boot drain, Codex R1 #2)", () => {
	let dir: string;
	let markerDir: string;
	let quarantineDir: string;
	beforeEach(() => {
		process.env.FLYWHEEL_MERGE_APPROVAL_GATE = "0"; // FLY-869: FSM tests bypass ship gate
		process.env.FLYWHEEL_QA_DONE_GATE = "0";
		dir = mkdtempSync(join(tmpdir(), "fly172-boot-"));
		markerDir = join(dir, "complete-failed");
		quarantineDir = join(dir, "quarantine");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("no dir → zero", async () => {
		const store = makeStore();
		const r = await reconcileCompleteFailedMarkers({
			store: store as never,
			bridgeBaseUrl: "http://127.0.0.1:9876",
			markerDir,
			quarantineDir,
			log: () => {},
		});
		expect(r).toEqual({ scanned: 0, reconciled: 0, quarantined: 0 });
	});

	it("replays multiple markers; idempotent on second drain", async () => {
		writeMarker(markerDir, "a", {
			payload: {
				decision: { route: "auto_approve" },
				evidence: { landingStatus: { status: "merged" } },
			},
		}); // → completed
		writeMarker(markerDir, "b"); // needs_review → awaiting_review
		const store = makeStore({
			a: { status: "running" },
			b: { status: "running" },
		});
		const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
			const body = JSON.parse(init.body as string);
			if (body.execution_id === "a")
				store.sessions.set("a", { status: "completed" });
			if (body.execution_id === "b")
				store.sessions.set("b", { status: "awaiting_review" });
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		});
		const deps = {
			store: store as never,
			bridgeBaseUrl: "http://127.0.0.1:9876",
			fetchFn: fetchFn as never,
			markerDir,
			quarantineDir,
			log: () => {},
		};
		const r1 = await reconcileCompleteFailedMarkers(deps);
		expect(r1.scanned).toBe(2);
		expect(r1.reconciled).toBe(2);
		expect(readdirSync(markerDir)).toHaveLength(0);
		// Second drain — markers gone → scanned 0, idempotent
		const r2 = await reconcileCompleteFailedMarkers(deps);
		expect(r2.scanned).toBe(0);
	});

	it("quarantine fallback at boot: dead tmux forces terminal status", async () => {
		writeMarker(markerDir, "c", {
			payload: { decision: { route: "blocked" }, evidence: {} },
		});
		const store = makeStore({
			c: { status: "running", project_name: "geoforge3d" },
		});
		// replay returns 200+warning so it never reaches expected → rejected → quarantine
		const fetchFn = vi.fn(
			async () =>
				new Response(JSON.stringify({ ok: true, warning: "skipped" }), {
					status: 200,
				}),
		);
		const r = await reconcileCompleteFailedMarkers({
			store: store as never,
			bridgeBaseUrl: "http://127.0.0.1:9876",
			fetchFn: fetchFn as never,
			markerDir,
			quarantineDir,
			transitionOpts: undefined,
			getTmuxTarget: () => ({ tmuxWindow: "geoforge3d:@0" }),
			isTmuxWindowAlive: async () => false, // dead
			log: () => {},
		});
		expect(r.quarantined).toBe(1);
		expect(store.forceStatus).toHaveBeenCalledWith(
			"c",
			"blocked",
			expect.any(String),
			expect.stringContaining("quarantine"),
		);
	});
});
