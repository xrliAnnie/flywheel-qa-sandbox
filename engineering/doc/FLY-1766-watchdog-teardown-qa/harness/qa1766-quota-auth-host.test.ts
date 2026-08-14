/**
 * FLY-1766 QA A5 (isolated leg) — the quota/auth scan in its NEW host.
 *
 * The rider moved off RunnerIdleWatchdog onto the GatePoller. This drives the
 * REAL `makeRunnerQuotaScanPass` (the new pass) with a login-expired pane and
 * asserts the scan still fires, and that the 1h-per-session claim gate that used
 * to live on the old host still throttles. The real-pane leg runs in the 529 room.
 */
import { describe, expect, it } from "vitest";
import type { StateStore } from "../../StateStore.js";
import { makeRunnerQuotaScanPass } from "../runner-quota-scan.js";

type Session = ReturnType<StateStore["getActiveSessions"]>[number];

const LOGIN_EXPIRED_PANE = [
	"● Running…",
	"",
	"API Error: 401 Unauthorized",
	"Your session has expired. Please run /login to sign in again.",
	"",
].join("\n");

function session(id: string, status = "running"): Session {
	return {
		execution_id: id,
		project_name: "test-slot-3",
		status,
		issue_id: "FLY-9999",
		issue_identifier: "FLY-9999",
	} as unknown as Session;
}

function makeStore(sessions: Session[]): Pick<StateStore, "getActiveSessions"> {
	return { getActiveSessions: () => sessions } as unknown as Pick<
		StateStore,
		"getActiveSessions"
	>;
}

describe("FLY-1766 QA A5 — quota/auth scan under the GatePoller host", () => {
	it("scans a running session's pane and hands it to the scan leg", async () => {
		const scanned: Array<{ id: string; pane: string }> = [];
		const pass = makeRunnerQuotaScanPass({
			store: makeStore([session("exec-a")]),
			captureSession: async () => ({ output: LOGIN_EXPIRED_PANE }) as never,
			scan: async (s, pane) => {
				scanned.push({ id: s.execution_id, pane });
			},
		});
		await pass();
		expect(scanned).toHaveLength(1);
		expect(scanned[0].id).toBe("exec-a");
		expect(scanned[0].pane).toContain("session has expired");
	});

	it("keeps the 1h-per-session claim gate — a second pass inside the window is skipped", async () => {
		let now = 0;
		const scanned: string[] = [];
		const pass = makeRunnerQuotaScanPass({
			store: makeStore([session("exec-a")]),
			captureSession: async () => ({ output: LOGIN_EXPIRED_PANE }) as never,
			scan: async (s) => {
				scanned.push(s.execution_id);
			},
			intervalMs: 3_600_000,
			now: () => now,
		});
		await pass();
		now = 3_599_999;
		await pass();
		expect(scanned).toEqual(["exec-a"]); // still one — throttled
		now = 3_600_001;
		await pass();
		expect(scanned).toEqual(["exec-a", "exec-a"]); // window elapsed
	});

	it("ignores non-running sessions (byte-compat with the old host's filter)", async () => {
		const scanned: string[] = [];
		const pass = makeRunnerQuotaScanPass({
			store: makeStore([session("exec-parked", "parked"), session("exec-live")]),
			captureSession: async () => ({ output: LOGIN_EXPIRED_PANE }) as never,
			scan: async (s) => {
				scanned.push(s.execution_id);
			},
		});
		await pass();
		expect(scanned).toEqual(["exec-live"]);
	});

	it("a capture error does not consume the session's claim (it retries next pass)", async () => {
		let fail = true;
		const scanned: string[] = [];
		const pass = makeRunnerQuotaScanPass({
			store: makeStore([session("exec-a")]),
			captureSession: async () =>
				(fail ? { error: "pane gone" } : { output: LOGIN_EXPIRED_PANE }) as never,
			scan: async (s) => {
				scanned.push(s.execution_id);
			},
			intervalMs: 3_600_000,
		});
		await pass();
		expect(scanned).toEqual([]);
		fail = false;
		await pass(); // same wall-clock window, but the claim was never taken
		expect(scanned).toEqual(["exec-a"]);
	});

	it("one scan failure does not abort the sweep of the other sessions", async () => {
		const scanned: string[] = [];
		const pass = makeRunnerQuotaScanPass({
			store: makeStore([session("exec-bad"), session("exec-good")]),
			captureSession: async () => ({ output: LOGIN_EXPIRED_PANE }) as never,
			scan: async (s) => {
				if (s.execution_id === "exec-bad") throw new Error("scan blew up");
				scanned.push(s.execution_id);
			},
			log: () => {},
		});
		await pass();
		expect(scanned).toEqual(["exec-good"]);
	});
});
