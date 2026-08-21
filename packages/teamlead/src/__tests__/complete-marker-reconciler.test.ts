import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalSubmissionDigest } from "flywheel-config";
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
	defaultMarkerDir,
	defaultQuarantineDir,
	expectedStatusFromMarker,
	reconcileCompleteFailedMarkers,
	tryReconcileComplete,
} from "../bridge/complete-marker-reconciler.js";
import {
	isRewakeCandidate,
	shipAttemptFailedSuppressedHead,
} from "../bridge/stale-approved-ship-reconciler.js";

const mockedApplyTransition = vi.mocked(applyTransition);

type SessionRow = {
	status: string;
	project_name?: string;
	issue_identifier?: string;
	issue_id?: string;
	pr_head_sha?: string;
	pr_number?: number;
	review_question_id?: string;
	session_params?: string;
};

/** Minimal in-memory StateStore stub matching the reconciler's usage. */
function makeStore(initial: Record<string, SessionRow> = {}) {
	const sessions = new Map<string, SessionRow>(Object.entries(initial));
	return {
		sessions,
		getSession: vi.fn((id: string) => sessions.get(id)),
		getGeneralizedWorkflowNodeForExecution: vi.fn(() => undefined),
		getGeneralizedWorkflowNodeForActivation: vi.fn(() => undefined),
		getWorkflowNodeCompletion: vi.fn(() => undefined),
		getEventPayloadById: vi.fn(() => undefined),
		getSessionParams: vi.fn((id: string) => {
			const raw = sessions.get(id)?.session_params;
			return raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
		}),
		setSessionParams: vi.fn((id: string, params: Record<string, unknown>) => {
			const cur = sessions.get(id);
			if (!cur) throw new Error(`session not found: ${id}`);
			sessions.set(id, { ...cur, session_params: JSON.stringify(params) });
		}),
		setMergeBlock: vi.fn(() => true),
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

describe("complete marker default directories (FLY-1608)", () => {
	const originalHome = process.env.HOME;
	const originalMarkerDir = process.env.FLYWHEEL_COMPLETE_MARKER_DIR;

	afterEach(() => {
		vi.useRealTimers();
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalMarkerDir === undefined) {
			delete process.env.FLYWHEEL_COMPLETE_MARKER_DIR;
		} else {
			process.env.FLYWHEEL_COMPLETE_MARKER_DIR = originalMarkerDir;
		}
	});

	it("uses the trimmed slot override for marker + derived quarantine", () => {
		process.env.FLYWHEEL_COMPLETE_MARKER_DIR =
			"  /tmp/fly1608-slot/complete-failed  ";
		expect(defaultMarkerDir()).toBe("/tmp/fly1608-slot/complete-failed");
		expect(defaultQuarantineDir()).toBe(
			"/tmp/fly1608-slot/complete-failed-quarantine",
		);
	});

	it("unset override is byte-compatible with the legacy HOME paths", () => {
		delete process.env.FLYWHEEL_COMPLETE_MARKER_DIR;
		process.env.HOME = "/tmp/fly1608-home";
		expect(defaultMarkerDir()).toBe(
			"/tmp/fly1608-home/.flywheel/state/complete-failed",
		);
		expect(defaultQuarantineDir()).toBe(
			"/tmp/fly1608-home/.flywheel/state/complete-failed-quarantine",
		);
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
		// Merged stays completed; a blocked completion is a failed/stalled ship
		// ATTEMPT and preserves approved_to_ship (FLY-1505).
		expect(
			expectedStatusFromMarker(mk("needs_review", true), "approved_to_ship"),
		).toBe("completed");
		expect(
			expectedStatusFromMarker(mk("blocked", false), "approved_to_ship"),
		).toBe("approved_to_ship");
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
	let originalHome: string | undefined;

	beforeEach(() => {
		originalHome = process.env.HOME;
		process.env.FLYWHEEL_MERGE_APPROVAL_GATE = "0"; // FLY-869: FSM tests bypass ship gate
		process.env.FLYWHEEL_QA_DONE_GATE = "0";
		dir = mkdtempSync(join(tmpdir(), "fly172-"));
		markerDir = join(dir, "complete-failed");
		quarantineDir = join(dir, "quarantine");
	});
	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		delete process.env.FLYWHEEL_MERGE_APPROVAL_GATE;
		delete process.env.FLYWHEEL_QA_DONE_GATE;
		delete process.env.FLYWHEEL_DESIGN_HTML_GATE;
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

	it("derives quarantine from an explicitly resolved markerDir", async () => {
		const legacyHome = join(dir, "legacy-home");
		process.env.HOME = legacyHome;
		mkdirSync(markerDir, { recursive: true });
		writeFileSync(join(markerDir, "bad.json"), "not-json", "utf8");
		const store = makeStore();
		const markerOnlyDeps = {
			store: store as never,
			bridgeBaseUrl: "http://127.0.0.1:9876",
			ingestToken: "tok",
			markerDir,
			log: () => {},
		};

		const result = await tryReconcileComplete("bad", markerOnlyDeps);

		expect(result).toMatchObject({
			kind: "quarantined",
			quarantinePath: join(`${markerDir}-quarantine`, "bad.json"),
		});
		expect(existsSync(join(`${markerDir}-quarantine`, "bad.json"))).toBe(true);
		expect(
			existsSync(
				join(
					legacyHome,
					".flywheel",
					"state",
					"complete-failed-quarantine",
					"bad.json",
				),
			),
		).toBe(false);
	});

	it("FLY-1505 settles the explicit failed-attempt route, persists the approval-bound head marker, and suppresses automatic re-wake", async () => {
		const head = "a".repeat(40);
		writeMarker(markerDir, "execShipAttempt", {
			payload: {
				decision: { route: "ship_attempt_failed" },
				evidence: { headSha: head, prNumber: 715 },
				reviewQuestionId: "11111111-1111-1111-1111-111111111111",
				summary: "ship workflow still running",
			},
		});
		const store = makeStore({
			execShipAttempt: {
				status: "approved_to_ship",
				issue_id: "iss-1",
				project_name: "geoforge3d",
				pr_head_sha: head,
				pr_number: 715,
				review_question_id: "11111111-1111-1111-1111-111111111111",
			},
		});
		const fetchFn = vi.fn();
		const alertShipAttemptFailed = vi.fn();

		const result = await tryReconcileComplete("execShipAttempt", {
			...baseDeps(store, fetchFn as never),
			alertShipAttemptFailed,
		});

		expect(result).toEqual({
			kind: "settled_ship_attempt_failed",
			settle: "marked",
		});
		expect(fetchFn).not.toHaveBeenCalled();
		expect(alertShipAttemptFailed).toHaveBeenCalledOnce();
		expect(store.sessions.get("execShipAttempt")?.status).toBe(
			"approved_to_ship",
		);
		const rawParams = store.sessions.get("execShipAttempt")?.session_params;
		expect(rawParams).toBeTruthy();
		expect(JSON.parse(rawParams ?? "{}")).toMatchObject({
			fly1505_ship_attempt_failed: {
				head_sha: head,
				attempt_count: 1,
				review_question_id: "11111111-1111-1111-1111-111111111111",
				summary: "ship workflow still running",
			},
		});
		expect(
			isRewakeCandidate(
				{
					execution_id: "execShipAttempt",
					issue_id: "iss-1",
					project_name: "geoforge3d",
					status: "approved_to_ship",
					review_question_id: "11111111-1111-1111-1111-111111111111",
					pr_head_sha: head,
					last_activity_at: "2026-07-27 00:00:00",
					shipAttemptFailedHead: shipAttemptFailedSuppressedHead(
						rawParams,
						"11111111-1111-1111-1111-111111111111",
					),
				},
				{
					nowMs: Date.parse("2026-07-27T00:10:00Z"),
					graceMs: 5 * 60_000,
				},
			),
		).toBe(false);
		expect(existsSync(join(markerDir, "execShipAttempt.json"))).toBe(false);
	});

	it("FLY-1505 consumes a delayed Q1 marker without suppressing the same-head Q2 approval", async () => {
		const head = "e".repeat(40);
		writeMarker(markerDir, "execStaleBindingAttempt", {
			payload: {
				decision: { route: "ship_attempt_failed" },
				evidence: { headSha: head, prNumber: 715 },
				reviewQuestionId: "11111111-1111-1111-1111-111111111111",
			},
		});
		const store = makeStore({
			execStaleBindingAttempt: {
				status: "approved_to_ship",
				issue_id: "iss-binding",
				project_name: "geoforge3d",
				pr_head_sha: head,
				pr_number: 715,
				review_question_id: "22222222-2222-2222-2222-222222222222",
			},
		});
		const alertShipAttemptFailed = vi.fn();

		const result = await tryReconcileComplete("execStaleBindingAttempt", {
			...baseDeps(store, vi.fn() as never),
			alertShipAttemptFailed,
		});

		expect(result).toEqual({
			kind: "settled_ship_attempt_failed",
			settle: "stale_attempt",
		});
		expect(
			store.sessions.get("execStaleBindingAttempt")?.session_params,
		).toBeUndefined();
		expect(alertShipAttemptFailed).not.toHaveBeenCalled();
		expect(existsSync(join(markerDir, "execStaleBindingAttempt.json"))).toBe(
			false,
		);
	});

	it("FLY-1505 consumes a stale head-A marker without contaminating the currently approved head B", async () => {
		const headA = "a".repeat(40);
		const headB = "b".repeat(40);
		writeMarker(markerDir, "execStaleShipAttempt", {
			payload: {
				decision: { route: "blocked" },
				evidence: { headSha: headA },
			},
		});
		const store = makeStore({
			execStaleShipAttempt: {
				status: "approved_to_ship",
				project_name: "geoforge3d",
				pr_head_sha: headB,
			},
		});
		const alertShipAttemptFailed = vi.fn();
		const result = await tryReconcileComplete("execStaleShipAttempt", {
			...baseDeps(store, vi.fn() as never),
			alertShipAttemptFailed,
		});

		expect(result).toEqual({
			kind: "settled_ship_attempt_failed",
			settle: "stale_attempt",
		});
		expect(
			store.sessions.get("execStaleShipAttempt")?.session_params,
		).toBeUndefined();
		expect(alertShipAttemptFailed).not.toHaveBeenCalled();
		expect(existsSync(join(markerDir, "execStaleShipAttempt.json"))).toBe(
			false,
		);
	});

	it("FLY-1505 keeps the durable marker until the Lead alert succeeds", async () => {
		const head = "d".repeat(40);
		writeMarker(markerDir, "execShipAlertRetry", {
			payload: {
				decision: { route: "ship_attempt_failed" },
				evidence: { headSha: head, prNumber: 715 },
				reviewQuestionId: "22222222-2222-2222-2222-222222222222",
				summary: "workflow timed out",
			},
		});
		const store = makeStore({
			execShipAlertRetry: {
				status: "approved_to_ship",
				issue_id: "iss-alert",
				project_name: "geoforge3d",
				pr_head_sha: head,
				pr_number: 715,
				review_question_id: "22222222-2222-2222-2222-222222222222",
			},
		});
		const alertShipAttemptFailed = vi
			.fn()
			.mockRejectedValueOnce(new Error("notifier unavailable"))
			.mockResolvedValueOnce(undefined);

		const first = await tryReconcileComplete("execShipAlertRetry", {
			...baseDeps(store, vi.fn() as never),
			alertShipAttemptFailed,
		});
		expect(first).toEqual({
			kind: "transient_failed",
			error: "Error: notifier unavailable",
		});
		expect(existsSync(join(markerDir, "execShipAlertRetry.json"))).toBe(true);
		expect(store.sessions.get("execShipAlertRetry")?.status).toBe(
			"approved_to_ship",
		);

		const second = await tryReconcileComplete("execShipAlertRetry", {
			...baseDeps(store, vi.fn() as never),
			alertShipAttemptFailed,
		});
		expect(second).toEqual({
			kind: "settled_ship_attempt_failed",
			settle: "marked",
		});
		expect(alertShipAttemptFailed).toHaveBeenCalledTimes(2);
		expect(existsSync(join(markerDir, "execShipAlertRetry.json"))).toBe(false);
	});

	it("FLY-1505 keeps the marker retryable when no durable alert sink is wired", async () => {
		const head = "f".repeat(40);
		writeMarker(markerDir, "execShipNoAlertSink", {
			payload: {
				decision: { route: "ship_attempt_failed" },
				evidence: { headSha: head, prNumber: 715 },
				reviewQuestionId: "33333333-3333-3333-3333-333333333333",
			},
		});
		const store = makeStore({
			execShipNoAlertSink: {
				status: "approved_to_ship",
				issue_id: "iss-no-alert",
				project_name: "geoforge3d",
				pr_head_sha: head,
				pr_number: 715,
				review_question_id: "33333333-3333-3333-3333-333333333333",
			},
		});

		const result = await tryReconcileComplete(
			"execShipNoAlertSink",
			baseDeps(store, vi.fn() as never),
		);
		expect(result).toMatchObject({
			kind: "transient_failed",
			error: expect.stringContaining("alert sink"),
		});
		expect(existsSync(join(markerDir, "execShipNoAlertSink.json"))).toBe(true);
	});

	it("FLY-1505 keeps the marker retryable when the durable session_params write fails", async () => {
		const head = "c".repeat(40);
		writeMarker(markerDir, "execShipWriteFail", {
			payload: {
				decision: { route: "blocked" },
				evidence: { headSha: head },
			},
		});
		const store = makeStore({
			execShipWriteFail: {
				status: "approved_to_ship",
				project_name: "geoforge3d",
				pr_head_sha: head,
			},
		});
		store.setSessionParams.mockImplementation(() => {
			throw new Error("sqlite busy");
		});
		const result = await tryReconcileComplete(
			"execShipWriteFail",
			baseDeps(store),
		);
		expect(result).toEqual({
			kind: "transient_failed",
			error: "Error: sqlite busy",
		});
		expect(existsSync(join(markerDir, "execShipWriteFail.json"))).toBe(true);
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

	describe("FLY-1912 replay circuit breaker", () => {
		const setNow = (value: string) => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date(value));
		};
		const ledger = (execId: string) =>
			(JSON.parse(readFileSync(join(markerDir, `${execId}.json`), "utf8"))
				.replay_ledger ?? {}) as Record<string, unknown>;
		const internalError = () =>
			new Response(JSON.stringify({ error: "internal error" }), {
				status: 500,
				headers: { "content-type": "application/json" },
			});

		it("persists exponential 5xx backoff and alerts once on the third failure", async () => {
			writeMarker(markerDir, "exec-backoff");
			const store = makeStore({ "exec-backoff": { status: "running" } });
			const fetchFn = vi.fn(async () => internalError());
			const alertCompleteMarkerHeld = vi.fn(async () => {});
			const deps = {
				...baseDeps(store, fetchFn as never),
				alertCompleteMarkerHeld,
			};

			for (const [now, streak, next] of [
				["2026-08-20T00:00:00.000Z", 1, "2026-08-20T00:01:00.000Z"],
				["2026-08-20T00:01:00.000Z", 2, "2026-08-20T00:03:00.000Z"],
				["2026-08-20T00:03:00.000Z", 3, "2026-08-20T00:07:00.000Z"],
			] as const) {
				setNow(now);
				expect(await tryReconcileComplete("exec-backoff", deps)).toMatchObject({
					kind: "transient_failed",
				});
				expect(ledger("exec-backoff")).toMatchObject({
					v: 1,
					mode: "backoff",
					streak,
					next_probe_at: next,
				});
			}
			expect(alertCompleteMarkerHeld).toHaveBeenCalledOnce();
			expect(alertCompleteMarkerHeld.mock.calls[0]?.[0]).toMatchObject({
				eventId: "complete-marker-5xx:exec-backoff:2026-08-20T00:00:00.000Z",
				kind: "unknown_5xx_episode",
				httpStatus: 500,
			});
			expect(ledger("exec-backoff")).toMatchObject({
				alert_state: "accepted",
			});
		});

		it("does not POST before backoff expires and reconciles after recovery", async () => {
			writeMarker(markerDir, "exec-recover");
			const store = makeStore({ "exec-recover": { status: "running" } });
			const fetchFn = vi
				.fn()
				.mockResolvedValueOnce(internalError())
				.mockImplementationOnce(async () => {
					store.sessions.set("exec-recover", { status: "awaiting_review" });
					return new Response(JSON.stringify({ ok: true }), { status: 200 });
				});
			setNow("2026-08-20T01:00:00.000Z");
			const deps = baseDeps(store, fetchFn as never);
			await tryReconcileComplete("exec-recover", deps);

			setNow("2026-08-20T01:00:59.999Z");
			expect(await tryReconcileComplete("exec-recover", deps)).toMatchObject({
				kind: "transient_failed",
			});
			expect(fetchFn).toHaveBeenCalledTimes(1);

			setNow("2026-08-20T01:01:00.000Z");
			expect(await tryReconcileComplete("exec-recover", deps)).toEqual({
				kind: "reconciled",
				status: "awaiting_review",
			});
			expect(fetchFn).toHaveBeenCalledTimes(2);
			expect(existsSync(join(markerDir, "exec-recover.json"))).toBe(false);
		});

		it("caps repeated 5xx probes at one hour without repeating the alert", async () => {
			writeMarker(markerDir, "exec-cap");
			const store = makeStore({ "exec-cap": { status: "running" } });
			const fetchFn = vi.fn(async () => internalError());
			const alertCompleteMarkerHeld = vi.fn(async () => {});
			const deps = {
				...baseDeps(store, fetchFn as never),
				alertCompleteMarkerHeld,
			};
			setNow("2026-08-20T02:00:00.000Z");
			for (let attempt = 0; attempt < 10; attempt += 1) {
				await tryReconcileComplete("exec-cap", deps);
				if (attempt < 9) setNow(String(ledger("exec-cap").next_probe_at));
			}
			expect(
				Date.parse(String(ledger("exec-cap").next_probe_at)) - Date.now(),
			).toBe(60 * 60_000);
			expect(alertCompleteMarkerHeld).toHaveBeenCalledOnce();
		});

		it.each(["network", "429"])(
			"keeps legacy %s failures ledger-free",
			async (failure) => {
				writeMarker(markerDir, `exec-${failure}`);
				const store = makeStore({ [`exec-${failure}`]: { status: "running" } });
				const fetchFn = vi.fn(async () => {
					if (failure === "network") throw new Error("ECONNREFUSED");
					return new Response("busy", { status: 429 });
				});
				for (let attempt = 0; attempt < 5; attempt += 1) {
					expect(
						await tryReconcileComplete(
							`exec-${failure}`,
							baseDeps(store, fetchFn as never),
						),
					).toMatchObject({ kind: "transient_failed" });
				}
				expect(ledger(`exec-${failure}`).v).toBeUndefined();
			},
		);

		it("pushes an existing backoff probe after network or 429 without increasing streak", async () => {
			writeMarker(markerDir, "exec-probe");
			const store = makeStore({ "exec-probe": { status: "running" } });
			const fetchFn = vi
				.fn()
				.mockResolvedValueOnce(internalError())
				.mockRejectedValueOnce(new Error("ECONNRESET"))
				.mockResolvedValueOnce(new Response("busy", { status: 429 }));
			const deps = baseDeps(store, fetchFn as never);
			setNow("2026-08-20T03:00:00.000Z");
			await tryReconcileComplete("exec-probe", deps);
			setNow("2026-08-20T03:01:00.000Z");
			await tryReconcileComplete("exec-probe", deps);
			expect(ledger("exec-probe")).toMatchObject({
				streak: 1,
				next_probe_at: "2026-08-20T03:02:00.000Z",
			});
			setNow("2026-08-20T03:02:00.000Z");
			await tryReconcileComplete("exec-probe", deps);
			expect(ledger("exec-probe")).toMatchObject({
				streak: 1,
				next_probe_at: "2026-08-20T03:03:00.000Z",
			});
		});

		it("holds a typed 409 immediately, skips quarantine, and probes hourly", async () => {
			writeMarker(markerDir, "exec-held");
			const store = makeStore({ "exec-held": { status: "running" } });
			const invariantResponse = () =>
				new Response(
					JSON.stringify({
						ok: false,
						reason: "transition_refused",
						detail: {
							transitionReason:
								"engine_invariant:workflow_rework_verification_advance_cas_failed",
						},
					}),
					{ status: 409, headers: { "content-type": "application/json" } },
				);
			const fetchFn = vi
				.fn()
				.mockImplementationOnce(async () => invariantResponse())
				.mockImplementationOnce(async () => invariantResponse())
				.mockImplementationOnce(async () => {
					store.sessions.set("exec-held", { status: "awaiting_review" });
					return new Response(JSON.stringify({ ok: true }), { status: 200 });
				});
			const alertCompleteMarkerHeld = vi.fn(async () => {});
			const deps = {
				...baseDeps(store, fetchFn as never),
				alertCompleteMarkerHeld,
			};

			setNow("2026-08-20T04:00:00.000Z");
			expect(await tryReconcileComplete("exec-held", deps)).toMatchObject({
				kind: "held_for_lead",
				invariant: "workflow_rework_verification_advance_cas_failed",
				alertState: "accepted",
			});
			expect(alertCompleteMarkerHeld).not.toHaveBeenCalled();
			expect(existsSync(quarantineDir)).toBe(false);

			setNow("2026-08-20T04:59:59.999Z");
			await tryReconcileComplete("exec-held", deps);
			expect(fetchFn).toHaveBeenCalledTimes(1);
			setNow("2026-08-20T05:00:00.000Z");
			await tryReconcileComplete("exec-held", deps);
			expect(fetchFn).toHaveBeenCalledTimes(2);
			expect(ledger("exec-held").next_probe_at).toBe(
				"2026-08-20T06:00:00.000Z",
			);
			setNow("2026-08-20T06:00:00.000Z");
			expect(await tryReconcileComplete("exec-held", deps)).toEqual({
				kind: "reconciled",
				status: "awaiting_review",
			});
			expect(alertCompleteMarkerHeld).not.toHaveBeenCalled();
		});

		it("writes alertPending before delivery and retries only the durable alert", async () => {
			writeMarker(markerDir, "exec-alert-retry", {
				payload: {
					decision: { route: "needs_review" },
					workflowActivation: {
						activationId: "activation-1",
						runId: "run-1",
						nodeId: "implement",
						attempt: 2,
						turnEpoch: 1,
					},
				},
			});
			const store = makeStore({
				"exec-alert-retry": { status: "running" },
			});
			const fetchFn = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							reason: "transition_refused",
							detail: {
								transitionReason: "engine_invariant:test_invariant",
								alertPending: true,
							},
						}),
						{ status: 409 },
					),
			);
			const alertCompleteMarkerHeld = vi
				.fn()
				.mockRejectedValueOnce(new Error("notifier unavailable"))
				.mockResolvedValueOnce(undefined);
			const deps = {
				...baseDeps(store, fetchFn as never),
				alertCompleteMarkerHeld,
			};
			setNow("2026-08-20T06:30:00.000Z");

			expect(await tryReconcileComplete("exec-alert-retry", deps)).toEqual({
				kind: "transient_failed",
				error: "notifier unavailable",
			});
			expect(ledger("exec-alert-retry")).toMatchObject({
				mode: "held",
				alert_state: "pending",
				alert_event_id: "engine_invariant:run-1:implement:2:test_invariant",
			});
			expect(
				await tryReconcileComplete("exec-alert-retry", deps),
			).toMatchObject({
				kind: "held_for_lead",
				alertState: "accepted",
			});
			expect(fetchFn).toHaveBeenCalledOnce();
			expect(alertCompleteMarkerHeld).toHaveBeenCalledTimes(2);
			expect(alertCompleteMarkerHeld.mock.calls[1]?.[0]).toMatchObject({
				eventId: "engine_invariant:run-1:implement:2:test_invariant",
				binding: { runId: "run-1", nodeId: "implement", attempt: 2 },
			});
		});

		it("durably retries a pending invariant alert before any POST or terminal settlement", async () => {
			writeMarker(markerDir, "exec-pending", {
				replay_ledger: {
					v: 1,
					mode: "held",
					streak: 0,
					episode_started_at: "2026-08-20T06:00:00.000Z",
					last_status: 409,
					last_at: "2026-08-20T06:00:00.000Z",
					next_probe_at: "2026-08-20T06:00:00.000Z",
					invariant: "workflow_rework_verification_advance_cas_failed",
					alert_event_id:
						"engine_invariant:run-1:implement:2:workflow_rework_verification_advance_cas_failed",
					alert_state: "pending",
				},
			});
			const store = makeStore({
				"exec-pending": { status: "awaiting_review" },
			});
			const fetchFn = vi.fn();
			const alertCompleteMarkerHeld = vi.fn(async () => {});
			setNow("2026-08-20T07:00:00.000Z");
			const deps = {
				...baseDeps(store, fetchFn as never),
				alertCompleteMarkerHeld,
			};

			expect(await tryReconcileComplete("exec-pending", deps)).toMatchObject({
				kind: "held_for_lead",
				alertState: "accepted",
			});
			expect(fetchFn).not.toHaveBeenCalled();
			expect(existsSync(join(markerDir, "exec-pending.json"))).toBe(true);
			expect(ledger("exec-pending").alert_state).toBe("accepted");
			expect(await tryReconcileComplete("exec-pending", deps)).toEqual({
				kind: "duplicate_terminal",
				status: "awaiting_review",
			});
			expect(fetchFn).not.toHaveBeenCalled();
		});

		it("keeps pending alerts retryable when the sink is unavailable", async () => {
			writeMarker(markerDir, "exec-no-sink", {
				replay_ledger: {
					v: 1,
					mode: "held",
					streak: 0,
					episode_started_at: "2026-08-20T08:00:00.000Z",
					last_status: 409,
					last_at: "2026-08-20T08:00:00.000Z",
					next_probe_at: "2026-08-20T08:00:00.000Z",
					invariant: "workflow_rework_verification_advance_cas_failed",
					alert_event_id: "engine_invariant:run-1:implement:2:test",
					alert_state: "pending",
				},
			});
			const store = makeStore({ "exec-no-sink": { status: "running" } });
			const fetchFn = vi.fn();
			expect(
				await tryReconcileComplete(
					"exec-no-sink",
					baseDeps(store, fetchFn as never),
				),
			).toMatchObject({ kind: "transient_failed" });
			expect(fetchFn).not.toHaveBeenCalled();
			expect(ledger("exec-no-sink").alert_state).toBe("pending");
		});

		it("keeps a pending ledger when the accepted rewrite fails", async () => {
			writeMarker(markerDir, "exec-accept-fail", {
				replay_ledger: {
					v: 1,
					mode: "held",
					streak: 0,
					episode_started_at: "2026-08-20T08:00:00.000Z",
					last_status: 409,
					last_at: "2026-08-20T08:00:00.000Z",
					next_probe_at: "2026-08-20T09:00:00.000Z",
					invariant: "test",
					alert_event_id: "engine_invariant:run-1:implement:2:test",
					alert_state: "pending",
				},
			});
			const store = makeStore({ "exec-accept-fail": { status: "running" } });
			const alertCompleteMarkerHeld = vi.fn(async () => {});
			chmodSync(markerDir, 0o500);
			try {
				expect(
					await tryReconcileComplete("exec-accept-fail", {
						...baseDeps(store, vi.fn() as never),
						alertCompleteMarkerHeld,
					}),
				).toMatchObject({ kind: "transient_failed" });
			} finally {
				chmodSync(markerDir, 0o700);
			}
			expect(ledger("exec-accept-fail").alert_state).toBe("pending");
		});

		it("treats malformed ledgers as absent and replaces them after a 5xx", async () => {
			writeMarker(markerDir, "exec-malformed", { replay_ledger: "broken" });
			const store = makeStore({ "exec-malformed": { status: "running" } });
			setNow("2026-08-20T09:00:00.000Z");
			await tryReconcileComplete(
				"exec-malformed",
				baseDeps(store, vi.fn(async () => internalError()) as never),
			);
			expect(ledger("exec-malformed")).toMatchObject({
				v: 1,
				mode: "backoff",
				streak: 1,
			});
		});

		it("single-flights concurrent boot and heartbeat replay", async () => {
			writeMarker(markerDir, "exec-singleflight");
			const store = makeStore({
				"exec-singleflight": { status: "running" },
			});
			let release: (() => void) | undefined;
			const waiting = new Promise<void>((resolve) => {
				release = resolve;
			});
			const fetchFn = vi.fn(async () => {
				await waiting;
				return internalError();
			});
			setNow("2026-08-20T10:00:00.000Z");
			const deps = baseDeps(store, fetchFn as never);
			const boot = tryReconcileComplete("exec-singleflight", deps);
			const heartbeat = tryReconcileComplete("exec-singleflight", deps);
			release?.();
			await expect(Promise.all([boot, heartbeat])).resolves.toEqual([
				expect.objectContaining({ kind: "transient_failed" }),
				expect.objectContaining({ kind: "transient_failed" }),
			]);
			expect(fetchFn).toHaveBeenCalledOnce();
			expect(ledger("exec-singleflight").streak).toBe(1);
			expect(
				readdirSync(markerDir).filter((name) => name.includes(".tmp")),
			).toHaveLength(0);
		});

		it("does not alert when the durable ledger write fails", async () => {
			writeMarker(markerDir, "exec-write-fail");
			const store = makeStore({ "exec-write-fail": { status: "running" } });
			const alertCompleteMarkerHeld = vi.fn(async () => {});
			chmodSync(markerDir, 0o500);
			try {
				expect(
					await tryReconcileComplete("exec-write-fail", {
						...baseDeps(
							store,
							vi.fn(
								async () =>
									new Response(
										JSON.stringify({
											reason: "transition_refused",
											detail: {
												transitionReason: "engine_invariant:test",
												alertPending: true,
											},
										}),
										{ status: 409 },
									),
							) as never,
						),
						alertCompleteMarkerHeld,
					}),
				).toMatchObject({ kind: "transient_failed" });
			} finally {
				chmodSync(markerDir, 0o700);
			}
			expect(alertCompleteMarkerHeld).not.toHaveBeenCalled();
			expect(ledger("exec-write-fail").v).toBeUndefined();
		});
	});

	it("generalized missing-output replay stays retryable and keeps the marker", async () => {
		writeMarker(markerDir, "exec-output", {
			payload: { decision: { route: "no_code" }, evidence: {} },
		});
		const store = makeStore({ "exec-output": { status: "running" } });
		Object.assign(store, {
			getGeneralizedWorkflowNodeForExecution: vi.fn(() => ({
				binding: {
					execution_id: "exec-output",
					run_id: "run-1",
					node_id: "produce",
					attempt: 1,
				},
			})),
			getWorkflowNodeCompletion: vi.fn(() => undefined),
		});
		const fetchFn = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						ok: false,
						reason: "missing_output",
						retryable: true,
					}),
					{ status: 409, headers: { "content-type": "application/json" } },
				),
		);
		const result = await tryReconcileComplete(
			"exec-output",
			baseDeps(store, fetchFn as never),
		);
		expect(result).toEqual({
			kind: "transient_failed",
			error: "missing_output",
		});
		expect(readdirSync(markerDir)).toContain("exec-output.json");
		expect(existsSync(quarantineDir)).toBe(false);
	});

	it("FLY-1427 deletes a terminal-immune generalized marker only after terminal verification", async () => {
		writeMarker(markerDir, "exec-terminal-immune", {
			payload: { decision: { route: "no_code" }, evidence: {} },
		});
		const store = makeStore({
			"exec-terminal-immune": { status: "terminated" },
		});
		Object.assign(store, {
			getGeneralizedWorkflowNodeForExecution: vi.fn(() => ({
				binding: {
					execution_id: "exec-terminal-immune",
					run_id: "run-1",
					node_id: "execute",
					attempt: 1,
				},
			})),
		});
		const fetchFn = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						ok: true,
						settled: "terminal_status_immune",
					}),
					{ status: 200 },
				),
		);

		const result = await tryReconcileComplete(
			"exec-terminal-immune",
			baseDeps(store, fetchFn as never),
		);

		expect(result).toEqual({
			kind: "reconciled",
			status: "terminal_status_immune",
		});
		expect(existsSync(join(markerDir, "exec-terminal-immune.json"))).toBe(
			false,
		);
	});

	it("FLY-1427 keeps a terminal-immune marker when the session verification is not terminal", async () => {
		writeMarker(markerDir, "exec-terminal-immune-invalid", {
			payload: { decision: { route: "no_code" }, evidence: {} },
		});
		const store = makeStore({
			"exec-terminal-immune-invalid": { status: "running" },
		});
		Object.assign(store, {
			getGeneralizedWorkflowNodeForExecution: vi.fn(() => ({
				binding: {
					execution_id: "exec-terminal-immune-invalid",
					run_id: "run-1",
					node_id: "execute",
					attempt: 1,
				},
			})),
		});
		const fetchFn = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						ok: true,
						settled: "terminal_status_immune",
					}),
					{ status: 200 },
				),
		);

		const result = await tryReconcileComplete(
			"exec-terminal-immune-invalid",
			baseDeps(store, fetchFn as never),
		);

		expect(result).toEqual({
			kind: "transient_failed",
			error: "terminal_status_immune status verification failed",
		});
		expect(
			existsSync(join(markerDir, "exec-terminal-immune-invalid.json")),
		).toBe(true);
	});

	it("generalized replay deletes the marker only after its receipt is visible", async () => {
		writeMarker(markerDir, "exec-receipt", {
			payload: { decision: { route: "no_code" }, evidence: {} },
		});
		const store = makeStore({ "exec-receipt": { status: "running" } });
		const payload = { decision: { route: "no_code" }, evidence: {} };
		let receipt: Record<string, unknown> | undefined;
		let canonicalAudit: Record<string, unknown> | undefined;
		Object.assign(store, {
			getGeneralizedWorkflowNodeForExecution: vi.fn(() => ({
				binding: {
					execution_id: "exec-receipt",
					run_id: "run-1",
					node_id: "execute",
					attempt: 1,
				},
			})),
			getWorkflowNodeCompletion: vi.fn(() => receipt),
			getEventPayloadById: vi.fn(() => canonicalAudit),
		});
		const fetchFn = vi.fn(async () => {
			receipt = {
				execution_id: "exec-receipt",
				route: "no_code",
				event_uid: "wfc:run-1:execute:1",
				completion_submission_digest: canonicalSubmissionDigest(payload),
			};
			canonicalAudit = payload;
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		});
		const result = await tryReconcileComplete(
			"exec-receipt",
			baseDeps(store, fetchFn as never),
		);
		expect(result).toEqual({ kind: "reconciled", status: "node_completed" });
		expect(existsSync(join(markerDir, "exec-receipt.json"))).toBe(false);
	});

	it("generalized replay resolves a reused actor marker by activation, never by ambiguous execution", async () => {
		const workflowActivation = {
			activationId: "activation-attempt-2",
			runId: "run-1",
			nodeId: "execute",
			attempt: 2,
			turnEpoch: 4,
		};
		const payload = {
			decision: { route: "no_code" },
			evidence: { commitMessages: ["same actor fixed QA feedback"] },
			workflowActivation,
		};
		writeMarker(markerDir, "exec-reused", { payload });
		const store = makeStore({ "exec-reused": { status: "completed" } });
		Object.assign(store, {
			getGeneralizedWorkflowNodeForExecution: vi.fn(() => {
				throw new Error("ambiguous execution lookup must not run");
			}),
			getGeneralizedWorkflowNodeForActivation: vi.fn((activationId: string) =>
				activationId === workflowActivation.activationId
					? {
							binding: {
								activation_id: workflowActivation.activationId,
								execution_id: "exec-reused",
								run_id: workflowActivation.runId,
								node_id: workflowActivation.nodeId,
								attempt: workflowActivation.attempt,
							},
						}
					: undefined,
			),
			getWorkflowNodeCompletion: vi.fn(() => ({
				activation_id: workflowActivation.activationId,
				execution_id: "exec-reused",
				route: "no_code",
				event_uid: "wfc:run-1:execute:2",
				completion_submission_digest: canonicalSubmissionDigest(payload),
			})),
			getEventPayloadById: vi.fn(() => payload),
		});
		const fetchFn = vi.fn();

		const result = await tryReconcileComplete(
			"exec-reused",
			baseDeps(store, fetchFn as never),
		);

		expect(result).toEqual({
			kind: "duplicate_terminal",
			status: "node_completed",
		});
		expect(store.getGeneralizedWorkflowNodeForActivation).toHaveBeenCalledWith(
			workflowActivation.activationId,
		);
		expect(store.getGeneralizedWorkflowNodeForExecution).not.toHaveBeenCalled();
		expect(fetchFn).not.toHaveBeenCalled();
		expect(existsSync(join(markerDir, "exec-reused.json"))).toBe(false);
	});

	it("generalized receipt without its canonical audit replays before deleting the marker", async () => {
		const payload = { decision: { route: "no_code" }, evidence: {} };
		writeMarker(markerDir, "exec-audit-gap", { payload });
		const store = makeStore({ "exec-audit-gap": { status: "completed" } });
		let canonicalAudit: Record<string, unknown> | undefined;
		Object.assign(store, {
			getGeneralizedWorkflowNodeForExecution: vi.fn(() => ({
				binding: {
					execution_id: "exec-audit-gap",
					run_id: "run-1",
					node_id: "execute",
					attempt: 1,
				},
			})),
			getWorkflowNodeCompletion: vi.fn(() => ({
				execution_id: "exec-audit-gap",
				route: "no_code",
				event_uid: "wfc:run-1:execute:1",
				completion_submission_digest: canonicalSubmissionDigest(payload),
			})),
			getEventPayloadById: vi.fn(() => canonicalAudit),
		});
		const fetchFn = vi.fn(async () => {
			canonicalAudit = payload;
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		});

		const result = await tryReconcileComplete(
			"exec-audit-gap",
			baseDeps(store, fetchFn as never),
		);

		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ kind: "reconciled", status: "node_completed" });
		expect(existsSync(join(markerDir, "exec-audit-gap.json"))).toBe(false);
	});

	it("generalized receipt owned by another execution is quarantined without replay", async () => {
		writeMarker(markerDir, "exec-audit-conflict", {
			payload: { decision: { route: "no_code" }, evidence: { changed: true } },
		});
		const store = makeStore({ "exec-audit-conflict": { status: "completed" } });
		Object.assign(store, {
			getGeneralizedWorkflowNodeForExecution: vi.fn(() => ({
				binding: {
					execution_id: "exec-audit-conflict",
					run_id: "run-1",
					node_id: "execute",
					attempt: 1,
				},
			})),
			getWorkflowNodeCompletion: vi.fn(() => ({
				execution_id: "other-execution",
				route: "no_code",
				event_uid: "wfc:run-1:execute:1",
				completion_submission_digest: canonicalSubmissionDigest({
					decision: { route: "no_code" },
					evidence: {},
				}),
			})),
		});
		const fetchFn = vi.fn();

		const result = await tryReconcileComplete(
			"exec-audit-conflict",
			baseDeps(store, fetchFn as never),
		);

		expect(fetchFn).not.toHaveBeenCalled();
		expect(result.kind).toBe("quarantined");
		expect(existsSync(join(markerDir, "exec-audit-conflict.json"))).toBe(false);
		expect(readdirSync(quarantineDir)).toContain("exec-audit-conflict.json");
	});

	it("generalized changed resubmission replays to the Bridge and deletes the marker when settled", async () => {
		writeMarker(markerDir, "exec-stale-resubmission", {
			payload: {
				decision: { route: "no_code" },
				evidence: { commitMessages: ["fix after QA feedback"] },
			},
		});
		const store = makeStore({
			"exec-stale-resubmission": { status: "completed" },
		});
		Object.assign(store, {
			getGeneralizedWorkflowNodeForExecution: vi.fn(() => ({
				binding: {
					execution_id: "exec-stale-resubmission",
					run_id: "run-1",
					node_id: "execute",
					attempt: 1,
				},
			})),
			getWorkflowNodeCompletion: vi.fn(() => ({
				execution_id: "exec-stale-resubmission",
				route: "no_code",
				event_uid: "wfc:run-1:execute:1",
				completion_submission_digest: canonicalSubmissionDigest({
					decision: { route: "no_code" },
					evidence: { commitMessages: ["initial completion"] },
				}),
			})),
		});
		const fetchFn = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						ok: true,
						generalized: true,
						settled: "stale_resubmission_escalated",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);

		const result = await tryReconcileComplete(
			"exec-stale-resubmission",
			baseDeps(store, fetchFn as never),
		);

		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(result).toEqual({
			kind: "reconciled",
			status: "stale_resubmission_escalated",
		});
		expect(existsSync(join(markerDir, "exec-stale-resubmission.json"))).toBe(
			false,
		);
		expect(existsSync(quarantineDir)).toBe(false);
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

	it("quarantines a design-node marker without valid HTML attestation before replay", async () => {
		writeMarker(markerDir, "execDesign", {
			issue_id: "GEO-95",
			payload: {
				decision: { route: "phase_design_complete" },
				evidence: {
					headSha: "0123456789abcdef0123456789abcdef01234567",
				},
				sessionRole: "design",
			},
		});
		const store = makeStore({
			execDesign: {
				status: "running",
				issue_identifier: "GEO-95",
			},
		});
		const fetchFn = vi.fn();
		const result = await tryReconcileComplete(
			"execDesign",
			baseDeps(store, fetchFn as never),
		);

		expect(result).toMatchObject({ kind: "quarantined", reason: "invalid" });
		expect(fetchFn).not.toHaveBeenCalled();
		expect(readdirSync(quarantineDir)).toContain("execDesign.json");
	});

	it("quarantines a design-node marker whose HTML attestation targets a different head", async () => {
		writeMarker(markerDir, "execDesignHeadMismatch", {
			issue_id: "GEO-95",
			payload: {
				decision: { route: "phase_design_complete" },
				evidence: { headSha: "a".repeat(40) },
				designHtmlEvidence: {
					version: 1,
					issueIdentifier: "GEO-95",
					paths: ["engineering/doc/GEO-95-design/founder.html"],
					headSha: "b".repeat(40),
				},
				sessionRole: "design",
			},
		});
		const store = makeStore({
			execDesignHeadMismatch: {
				status: "running",
				issue_identifier: "GEO-95",
			},
		});
		const fetchFn = vi.fn();
		const result = await tryReconcileComplete(
			"execDesignHeadMismatch",
			baseDeps(store, fetchFn as never),
		);

		expect(result).toMatchObject({ kind: "quarantined", reason: "invalid" });
		expect(fetchFn).not.toHaveBeenCalled();
		expect(readdirSync(quarantineDir)).toContain("execDesignHeadMismatch.json");
	});

	it("replays an attested design-node marker", async () => {
		const headSha = "0123456789abcdef0123456789abcdef01234567";
		writeMarker(markerDir, "execDesignValid", {
			issue_id: "GEO-95",
			payload: {
				decision: { route: "phase_design_complete" },
				evidence: { headSha },
				designHtmlEvidence: {
					version: 1,
					issueIdentifier: "GEO-95",
					paths: ["engineering/doc/GEO-95-design/founder.html"],
					headSha,
				},
				sessionRole: "design",
			},
		});
		const store = makeStore({
			execDesignValid: {
				status: "running",
				issue_identifier: "GEO-95",
			},
		});
		const fetchFn = vi.fn(async () => {
			store.sessions.set("execDesignValid", {
				status: "design_done",
				issue_identifier: "GEO-95",
			});
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		});
		const result = await tryReconcileComplete(
			"execDesignValid",
			baseDeps(store, fetchFn as never),
		);

		expect(result).toEqual({ kind: "reconciled", status: "design_done" });
		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(existsSync(join(markerDir, "execDesignValid.json"))).toBe(false);
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
		const onTerminalStatusPersisted = vi.fn();
		applyQuarantineFallback({
			store: store as never,
			executionId: "d2",
			projectName: "geoforge3d",
			tmuxAlive: false,
			quarantinePath: "/q/d2.json",
			onTerminalStatusPersisted,
			log: () => {},
		});
		expect(store.forceStatus).toHaveBeenCalledWith(
			"d2",
			"failed",
			expect.any(String),
			expect.any(String),
		);
		expect(onTerminalStatusPersisted).toHaveBeenCalledWith(
			"d2",
			"failed",
			"geoforge3d",
		);
	});
	it("indeterminate verdict logs HONESTLY (never 'tmux alive'); legacy boolean-only call keeps the old line byte-for-byte (code R1 #5)", () => {
		const store = makeStore({ d5: { status: "running" } });
		const lines: string[] = [];
		applyQuarantineFallback({
			store: store as never,
			executionId: "d5",
			tmuxAlive: true, // legacy meaning: not-provably-dead
			livenessVerdict: "indeterminate",
			quarantinePath: "/q/d5.json",
			log: (m) => lines.push(m),
		});
		expect(store.forceStatus).not.toHaveBeenCalled();
		expect(lines[0]).toContain("liveness indeterminate — leaving running");
		expect(lines[0]).not.toContain("tmux alive");
		// Legacy boolean-only caller: byte-identical old copy.
		const legacyLines: string[] = [];
		applyQuarantineFallback({
			store: store as never,
			executionId: "d5",
			tmuxAlive: true,
			quarantinePath: "/q/d5.json",
			log: (m) => legacyLines.push(m),
		});
		expect(legacyLines[0]).toBe(
			"[complete-reconciler] d5: marker quarantined but tmux alive — leaving running, advisory will fire",
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
		const onTerminalStatusPersisted = vi.fn();
		applyQuarantineFallback({
			store: store as never,
			transitionOpts: { fake: true } as never,
			executionId: "d4",
			issueId: "iss-d4",
			projectName: "geoforge3d",
			tmuxAlive: false,
			routeStatus: "blocked",
			quarantinePath: "/q/d4.json",
			onTerminalStatusPersisted,
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
		expect(onTerminalStatusPersisted).not.toHaveBeenCalled();
	});

	it("CODEX R1 MEDIUM: transitionOpts present but FSM rejects → fail-close forceStatus", () => {
		mockedApplyTransition
			.mockReset()
			.mockReturnValue({ ok: false, error: "illegal" } as never);
		const store = makeStore({ d5: { status: "running" } });
		const onTerminalStatusPersisted = vi.fn();
		applyQuarantineFallback({
			store: store as never,
			transitionOpts: { fake: true } as never,
			executionId: "d5",
			issueId: "iss-d5",
			projectName: "geoforge3d",
			tmuxAlive: false,
			routeStatus: "blocked",
			quarantinePath: "/q/d5.json",
			onTerminalStatusPersisted,
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
		expect(onTerminalStatusPersisted).toHaveBeenCalledWith(
			"d5",
			"blocked",
			"geoforge3d",
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
		expect(r).toEqual({
			scanned: 0,
			reconciled: 0,
			quarantined: 0,
			held: 0,
		});
	});

	it("counts a typed engine invariant marker as held without fallback", async () => {
		writeMarker(markerDir, "held");
		const store = makeStore({
			held: { status: "running", project_name: "geoforge3d" },
		});
		const result = await reconcileCompleteFailedMarkers({
			store: store as never,
			bridgeBaseUrl: "http://127.0.0.1:9876",
			markerDir,
			quarantineDir,
			fetchFn: vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							reason: "transition_refused",
							detail: { transitionReason: "engine_invariant:test" },
						}),
						{ status: 409 },
					),
			) as never,
			log: () => {},
		});

		expect(result).toEqual({
			scanned: 1,
			reconciled: 0,
			quarantined: 0,
			held: 1,
		});
		expect(store.forceStatus).not.toHaveBeenCalled();
		expect(store.sessions.get("held")?.status).toBe("running");
		expect(existsSync(join(markerDir, "held.json"))).toBe(true);
	});

	it("counts a settled blocked-after-approval marker as reconciled, never quarantined", async () => {
		const head = "d".repeat(40);
		writeMarker(markerDir, "ship-attempt", {
			payload: {
				decision: { route: "blocked" },
				evidence: { headSha: head },
			},
		});
		const store = makeStore({
			"ship-attempt": {
				status: "approved_to_ship",
				project_name: "geoforge3d",
				pr_head_sha: head,
			},
		});
		const result = await reconcileCompleteFailedMarkers({
			store: store as never,
			bridgeBaseUrl: "http://127.0.0.1:9876",
			markerDir,
			quarantineDir,
			alertShipAttemptFailed: vi.fn(),
			log: () => {},
		});
		expect(result).toEqual({
			scanned: 1,
			reconciled: 1,
			quarantined: 0,
			held: 0,
		});
		expect(existsSync(join(markerDir, "ship-attempt.json"))).toBe(false);
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
		const onTerminalStatusPersisted = vi.fn();
		const r = await reconcileCompleteFailedMarkers({
			store: store as never,
			bridgeBaseUrl: "http://127.0.0.1:9876",
			fetchFn: fetchFn as never,
			markerDir,
			quarantineDir,
			transitionOpts: undefined,
			getTmuxTarget: () => ({ tmuxWindow: "geoforge3d:@0" }),
			isTmuxWindowAlive: async () => false, // dead
			onTerminalStatusPersisted,
			log: () => {},
		});
		expect(r.quarantined).toBe(1);
		expect(store.forceStatus).toHaveBeenCalledWith(
			"c",
			"blocked",
			expect.any(String),
			expect.stringContaining("quarantine"),
		);
		expect(onTerminalStatusPersisted).toHaveBeenCalledWith(
			"c",
			"blocked",
			"geoforge3d",
		);
	});
});
