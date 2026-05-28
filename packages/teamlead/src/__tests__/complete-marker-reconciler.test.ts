import {
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
		dir = mkdtempSync(join(tmpdir(), "fly172-"));
		markerDir = join(dir, "complete-failed");
		quarantineDir = join(dir, "quarantine");
	});
	afterEach(() => {
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
});

describe("reconcileCompleteFailedMarkers (boot drain, Codex R1 #2)", () => {
	let dir: string;
	let markerDir: string;
	let quarantineDir: string;
	beforeEach(() => {
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
