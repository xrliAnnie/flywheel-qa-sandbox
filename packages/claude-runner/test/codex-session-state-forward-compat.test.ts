import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	readCodexGateHoldLatch,
	readCodexResidentWaitLatch,
	readCodexUpstreamRetryEpisode,
} from "../src/CodexTmuxAdapter.js";
import {
	codexSessionStateDir,
	probeCodexDaemonLiveness,
} from "../src/codex-daemon-runtime.js";
import { atomicMergeCodexSessionState } from "../src/codex-phase-lifecycle.js";

/**
 * FLY-2925 rollback safety for release N: the fields N adds to a Codex
 * session.json (residentWaitHold, upstreamRetryEpisode, residentWait) must be
 * invisible to every reader the previous release ships — gate latch, daemon
 * ledger, phase-hold merge — so rolling back to N-1 after N wrote them never
 * breaks or rewrites a live body's state. Those readers are unchanged since
 * the release base (fdd1b404d); this pins that they tolerate and preserve
 * the new keys, and that N's own readers fail closed on malformed values.
 */
describe("FLY-2925 session.json forward compatibility (N fields vs N-1 readers)", () => {
	let root: string;
	let previous: string | undefined;
	const executionId = "exec-compat";
	const statePath = (): string =>
		join(codexSessionStateDir(executionId), "session.json");

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "fly2925-compat-"));
		previous = process.env.FLYWHEEL_CODEX_SESSION_DIR;
		process.env.FLYWHEEL_CODEX_SESSION_DIR = join(root, "sessions");
		mkdirSync(codexSessionStateDir(executionId), { recursive: true });
		writeFileSync(
			statePath(),
			JSON.stringify({
				executionId,
				threadId: "thread-live",
				daemonPgid: 4321,
				gateHold: true,
				residentWaitHold: true,
				upstreamRetryEpisode: {
					v: 1,
					threadId: "thread-live",
					category: "rate_limited",
					attempts: 2,
					lastFailedTurnId: "turn-7",
					nextAt: 1,
				},
				residentWait: {
					reason: "native_blocked",
					threadId: "thread-live",
					observedAt: "2026-09-26T00:00:00.000Z",
				},
			}),
		);
	});

	afterEach(() => {
		if (previous === undefined) delete process.env.FLYWHEEL_CODEX_SESSION_DIR;
		else process.env.FLYWHEEL_CODEX_SESSION_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	});

	it("the previous release's gate-latch reader ignores the new keys", () => {
		expect(readCodexGateHoldLatch(executionId)).toBe(true);
	});

	it("the previous release's daemon ledger still resolves the persisted group", async () => {
		const liveness = await probeCodexDaemonLiveness(executionId, {
			isSocketLive: async () => false,
			processGroupState: (pgid) => (pgid === 4321 ? "absent" : "unknown"),
		});
		expect(liveness).toBe("absent");
	});

	it("the previous release's atomic merge preserves every N field", () => {
		atomicMergeCodexSessionState(statePath(), { gateHold: false });
		const merged = JSON.parse(readFileSync(statePath(), "utf8")) as Record<
			string,
			unknown
		>;
		expect(merged.gateHold).toBe(false);
		expect(merged.residentWaitHold).toBe(true);
		expect(merged.upstreamRetryEpisode).toMatchObject({ attempts: 2 });
		expect(merged.residentWait).toMatchObject({ reason: "native_blocked" });
	});

	it("N's own readers round-trip the new keys and fail closed on a malformed latch", () => {
		expect(readCodexResidentWaitLatch(executionId)).toBe(true);
		expect(readCodexUpstreamRetryEpisode(executionId)).toMatchObject({
			category: "rate_limited",
		});
		atomicMergeCodexSessionState(statePath(), { residentWaitHold: "yes" });
		expect(() => readCodexResidentWaitLatch(executionId)).toThrow(
			/invalid residentWaitHold/,
		);
	});

	it("a session written before N (no new keys) reads as no wait and no episode", () => {
		writeFileSync(
			statePath(),
			JSON.stringify({ executionId, threadId: "thread-old", gateHold: false }),
		);
		expect(readCodexResidentWaitLatch(executionId)).toBe(false);
		expect(readCodexUpstreamRetryEpisode(executionId)).toBeNull();
	});
});
