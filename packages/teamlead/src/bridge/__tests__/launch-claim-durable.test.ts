/**
 * FLY-245 D2 / Codex code-review R1 HIGH-3 — the durable launch claim must
 * converge to EXACTLY ONE started Runner across a Bridge crash. These tests
 * count ACTUAL Blueprint.run() invocations across a RECONSTRUCTED dispatcher
 * (fresh in-flight map, shared durable LaunchClaimStore) — not just WAL
 * decisions or same-process inflight dedup.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BlueprintContext } from "flywheel-edge-worker/dist/Blueprint.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LaunchClaimStore } from "../launch-claim-store.js";
import { type ProjectRuntime, RetryDispatcher } from "../run-dispatcher.js";

class TestRetryDispatcher extends RetryDispatcher {
	protected override preRegisterCommDb(): void {}
	protected override cleanupPreRegistration(): void {}
}

describe("LaunchClaimStore (durable, atomic)", () => {
	let dir: string;
	let store: LaunchClaimStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly245-launch-claim-"));
		store = new LaunchClaimStore(join(dir, "lc.db"));
	});
	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("first claim wins; a second (even after reopen) sees `exists`", () => {
		expect(store.claim("exec-1", 1000)).toBe("claimed");
		expect(store.claim("exec-1", 2000)).toBe("exists");
		store.close();
		// reopen = simulate a Bridge restart against the SAME durable db
		store = new LaunchClaimStore(join(dir, "lc.db"));
		expect(store.claim("exec-1", 3000)).toBe("exists");
	});

	it("records + reads back the live window", () => {
		store.claim("exec-1", 1000);
		expect(store.getClaim("exec-1")?.tmux_window).toBeNull();
		store.recordWindow("exec-1", "runner-x:@5");
		expect(store.getClaim("exec-1")?.tmux_window).toBe("runner-x:@5");
	});

	// Codex R3 HIGH-3: a recordWindow that updates 0 rows (claim row missing) must
	// THROW so the caller treats the bind as failed (kill window + abort launch),
	// never silently leave a live but untracked Runner.
	it("recordWindow THROWS when no claim row exists (no silent no-op bind)", () => {
		expect(() => store.recordWindow("never-claimed", "runner-x:@9")).toThrow(
			/expected 1|claim row missing/i,
		);
	});
});

describe("RetryDispatcher durable launch claim (HIGH-3 — exactly one started)", () => {
	let dir: string;
	let captured: BlueprintContext[];

	// A fake runner that records the ctx and (optionally) writes the durable
	// commit file via ctx.launchCommitPath — modelling the adapter's commit point.
	function makeRuntime(writeCommit: boolean): ProjectRuntime {
		return {
			blueprint: {
				run: vi.fn(async (_n: unknown, _r: string, ctx: BlueprintContext) => {
					captured.push(ctx);
					if (writeCommit && ctx.launchCommitPath) {
						mkdirSync(dirname(ctx.launchCommitPath), { recursive: true });
						writeFileSync(ctx.launchCommitPath, "");
					}
					return { success: true, sessionId: "s" };
				}),
			} as unknown as ProjectRuntime["blueprint"],
			projectRoot: dir,
			tmuxSessionName: "runner-test",
			agentDispatcher: {
				dispatchByName: vi.fn(),
			} as unknown as ProjectRuntime["agentDispatcher"],
		};
	}

	// Commit-existence seam pointed at our temp dir (so the test controls "did the
	// prior attempt commit"), instead of the real ~/.flywheel path.
	function makeDispatcher(
		claims: LaunchClaimStore,
		writeCommit: boolean,
	): TestRetryDispatcher {
		const isCommitted = (execId: string) => existsSync(join(commitDir, execId));
		return new TestRetryDispatcher(
			new Map([["proj", makeRuntime(writeCommit)]]),
			[],
			claims,
			isCommitted,
		);
	}

	let commitDir: string;
	const baseReq = {
		oldExecutionId: "pred-1",
		issueId: "FLY-245",
		projectName: "proj",
		runAttempt: 1,
		successorExecutionId: "succ-9",
	};

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly245-d2-durable-"));
		commitDir = join(dir, "commits");
		mkdirSync(commitDir, { recursive: true });
		captured = [];
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	// The fake adapter writes the commit to OUR temp commitDir, which the
	// isCommitted seam reads — so the dispatcher's ctx.launchCommitPath (the real
	// ~/.flywheel path) is overridden here for the runtime write. We model the
	// commit purely via the seam: writeCommit=true → seam returns true on replay.
	function seedCommit(execId: string): void {
		writeFileSync(join(commitDir, execId), "");
	}

	it("R5: crash AFTER the Runner COMMITTED → reconstructed dispatcher adopts, NO second Runner", async () => {
		const claims = new LaunchClaimStore(join(dir, "lc.db"));
		// attempt 1 committed (seam will report committed on replay)
		claims.claim("succ-9", 1000);
		seedCommit("succ-9");

		const b = makeDispatcher(claims, true);
		const res = await b.dispatch({ ...baseReq });
		await b.drain();
		expect(res.newExecutionId).toBe("succ-9");
		expect(captured).toHaveLength(0); // adopted — Blueprint.run NOT invoked again
		claims.close();
	});

	// FLY-1188 HIGH-3 (Codex full-PR review R2/R3): a committed CODEX runner was
	// briefly made to RE-DRIVE here, but Codex R3 showed the re-drive routes through
	// Blueprint.run's destructive worktree setup (removeIfExists → delete worktree +
	// force-delete branch) BEFORE the orphaned daemon is safely stopped — a data-loss
	// risk. Per the Lead's ruling it was REVERTED: committed codex now bare-adopts
	// like claude (above), and the SAFE recovery (persist backend + safely stop the
	// daemon + reuse the worktree in-place) is a fast-follow issue (see
	// doc/engineer/implementation/codex-recovery-runbook.md). The adapter-side
	// fail-closed reap (codex-daemon-runtime) still covers the crash-BEFORE-commit
	// redrive that an orphan socket would otherwise block.

	it("R5: crash BEFORE commit (recorded-but-never-started) → re-drive, NOT adopt-to-zero", async () => {
		const claims = new LaunchClaimStore(join(dir, "lc.db"));
		// attempt 1 claimed but NEVER committed (crashed between window-open and the
		// commit write) — the gated waiting shell self-reaps; NO commit file.
		claims.claim("succ-9", 1000);
		// (no seedCommit — isCommitted returns false)

		const b = makeDispatcher(claims, true);
		const res = await b.dispatch({ ...baseReq });
		await b.drain();
		// re-driven exactly once with the SAME execId (converges to one, NOT zero)
		expect(res.newExecutionId).toBe("succ-9");
		expect(captured).toHaveLength(1);
		expect(captured[0]?.executionId).toBe("succ-9");
		claims.close();
	});

	it("first attempt: claims + drives + the adapter writes the commit (ctx carries the path)", async () => {
		const claims = new LaunchClaimStore(join(dir, "lc.db"));
		const a = makeDispatcher(claims, true);
		const res = await a.dispatch({ ...baseReq });
		await a.drain();
		expect(res.newExecutionId).toBe("succ-9");
		expect(captured).toHaveLength(1);
		// ctx carried a deterministic commit path keyed by execId
		expect(captured[0]?.launchCommitPath).toMatch(/launch-commits\/succ-9$/);
		claims.close();
	});

	it("legacy path (no pre-bound id, no store) is byte-unchanged: no claim, fresh UUID, no commit path", async () => {
		const a = makeDispatcher(new LaunchClaimStore(join(dir, "lc.db")), false);
		const res = await a.dispatch({
			oldExecutionId: "pred-1",
			issueId: "FLY-1",
			projectName: "proj",
			runAttempt: 1,
		});
		await a.drain();
		expect(res.newExecutionId).toMatch(/^[0-9a-f-]{36}$/);
		expect(captured).toHaveLength(1);
		expect(captured[0]?.launchCommitPath).toBeUndefined();
	});
});
