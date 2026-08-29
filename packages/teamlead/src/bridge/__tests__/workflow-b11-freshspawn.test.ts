import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import type { AgentDispatcher } from "flywheel-edge-worker";
import type { BlueprintContext } from "flywheel-edge-worker/dist/Blueprint.js";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	launchCommitPath,
	type ProjectRuntime,
	RunDispatcher,
} from "../run-dispatcher.js";
import { WorkflowShadowWriter } from "../workflow-shadow-writer.js";

/**
 * FLY-1232 B11 — RunDispatcher.start seam + real evidence chain (Lead 67225a60 ③,
 * scope ruled A in 2b3a46ed).
 *
 * The flag-ON drill (qa-fly1232-flagon-drill.mjs) proves the §F.3 truth table but
 * drives writer hooks DIRECTLY. This test instead exercises FLY-1232's NEW behavior
 * — the fresh dispatch path sets + propagates `launchCommitPath` — through the REAL
 * production `RunDispatcher.start()` seam, with real on-disk evidence:
 *
 *   RunDispatcher.start()  →  [Blueprint.run replaced by the test callback below]
 *     the callback STANDS IN for Blueprint.run() + TmuxAdapter and does what the
 *     FLY-245 commit-gate adapter does at spawn:
 *     · writes the durable commit marker at ctx.launchCommitPath  (real file on
 *       disk, the production path ~/.flywheel/state/launch-commits/<execId>)
 *     · registers a non-:pending CommDB session row               (real better-sqlite3)
 *   →  writer.reconcileSideEffects()  reads BOTH real facts  →  started
 *
 * SCOPE (honest, per Lead ruling A):
 *   VERIFIED here      = the real RunDispatcher.start seam sets/propagates
 *                        launchCommitPath on the fresh path (FLY-1232's new behavior)
 *                        + the real evidence chain (real marker file, real CommDB,
 *                        real reconcileSideEffects → started; start-success alone does
 *                        NOT fabricate started).
 *   NOT run here       = the real Blueprint.run + real TmuxAdapter (the marker-write
 *                        itself) — the callback replaces both. That adapter marker-write
 *                        is FLY-245's two-phase commit-gate, already shipped/audited on
 *                        the retry path.
 *   DEFERRED (not waived) = a full real tmux/runner fresh spawn, per plan §5 risk 7 /
 *                        §8.2 — required before FLYWHEEL_WORKFLOW_CLAIMS_WRITE=1 is
 *                        enabled (pinned into the FLY-1232 Linear closeout + sub-issue B).
 */

const PROJECT = "flywheel";
const ISSUE = "FLY-1232";

// Isolated CommDB the dispatcher pre-registers into and the "adapter" self-
// registers into — never the production comm.db.
let commDbPath: string;
let workDir: string;
const markersWritten: string[] = [];

afterEach(() => {
	// The launch-commit markers land at the REAL production path (per-execId);
	// remove every one this test created so ~/.flywheel stays clean.
	for (const p of markersWritten.splice(0)) {
		try {
			rmSync(p, { force: true });
		} catch {}
	}
	try {
		rmSync(workDir, { recursive: true, force: true });
	} catch {}
});

/** A RunDispatcher whose CommDB pre-registration targets the ISOLATED db. */
class IsolatedDispatcher extends RunDispatcher {
	protected override preRegisterCommDb(
		executionId: string,
		tmuxSession: string,
		projectName: string,
		issueId: string,
	): void {
		const db = new CommDB(commDbPath);
		try {
			db.registerSession(
				executionId,
				`${tmuxSession}:pending`,
				projectName,
				issueId,
			);
		} finally {
			db.close();
		}
	}
	protected override cleanupPreRegistration(executionId: string): void {
		const db = new CommDB(commDbPath);
		try {
			db.unregisterPendingSession(executionId);
		} finally {
			db.close();
		}
	}
}

function makeRuntime(
	onRun: (ctx: BlueprintContext) => Promise<{
		success: boolean;
		sessionId?: string;
	}>,
): Map<string, ProjectRuntime> {
	const runtime: ProjectRuntime = {
		blueprint: {
			run: (_issue: unknown, _root: string, ctx: BlueprintContext) =>
				onRun(ctx),
		} as unknown as ProjectRuntime["blueprint"],
		projectRoot: workDir,
		tmuxSessionName: "flywheel",
		agentDispatcher: {} as AgentDispatcher,
	};
	return new Map([[PROJECT, runtime]]);
}

/** REAL evidence probes — a marker FILE on disk + a real CommDB row. */
function realProbes() {
	return {
		hasCommitMarker: (executionId: string): boolean =>
			existsSync(launchCommitPath(executionId)),
		hasNonPendingCommDbRow: (
			_projectName: string,
			executionId: string,
		): boolean | "unknown" => {
			try {
				if (!existsSync(commDbPath)) return false;
				const db = new CommDB(commDbPath);
				try {
					const s = db.getSession(executionId) as
						| { tmux_window?: string }
						| undefined;
					return !!s && !String(s.tmux_window ?? "").endsWith(":pending");
				} finally {
					db.close();
				}
			} catch {
				return "unknown";
			}
		},
	};
}

describe("FLY-1232 B11 — real fresh-spawn evidence chain via RunDispatcher.start()", () => {
	it("flag ON: start() sets launchCommitPath, the adapter's real marker + CommDB row advance the ledger to started", async () => {
		workDir = mkdtempSync(join(tmpdir(), "qa-fly1232-b11-"));
		commDbPath = join(workDir, "comm.db");
		const store = await StateStore.create(join(workDir, "state.db"));
		const writer = new WorkflowShadowWriter({
			store,
			newRunId: () => "run-1",
			probes: realProbes(),
			logger: { warn: () => {} },
		});

		let seenLaunchCommitPath: string | undefined;
		let seenExecId: string | undefined;
		const dispatcher = new IsolatedDispatcher(
			makeRuntime(async (ctx) => {
				// This callback STANDS IN for Blueprint.run() + TmuxAdapter (neither
				// runs here). It does what the FLY-245 commit-gate adapter does at
				// spawn: write the durable commit marker, then self-register a
				// non-:pending CommDB row.
				seenExecId = ctx.executionId as string;
				seenLaunchCommitPath = ctx.launchCommitPath as string | undefined;
				expect(
					seenLaunchCommitPath,
					"flag ON must set launchCommitPath",
				).toBeTruthy();
				const marker = seenLaunchCommitPath as string;
				mkdirSync(dirname(marker), { recursive: true });
				writeFileSync(marker, "committed");
				markersWritten.push(marker);
				const db = new CommDB(commDbPath);
				try {
					// non-:pending → the runner "started" (adapter self-registration)
					db.registerSession(
						ctx.executionId as string,
						"flywheel:1.qa",
						PROJECT,
						ISSUE,
					);
				} finally {
					db.close();
				}
				return { success: true, sessionId: "s1" };
			}),
			[], // cleanupHandles
			undefined, // runnerAdmission (default alwaysAdmit)
			undefined, // launchClaims
			undefined, // isCommitted (default: real existsSync)
			undefined, // resumeComputer (undefined ⇒ always fresh)
			undefined, // lifecycleAdmission
			undefined, // lifecycleLaunchGuard
			writer, // FLY-1232 workflowShadow (flag ON)
		);

		await dispatcher.start({ issueId: ISSUE, projectName: PROJECT });
		await dispatcher.drain();

		// The pre-launch seam ran through RunDispatcher.start (not a direct hook):
		// launchCommitPath was set and equals the production per-execId path.
		expect(seenExecId).toBeTruthy();
		expect(seenLaunchCommitPath).toBe(launchCommitPath(seenExecId as string));

		// The intent row landed pre-launch; the marker + CommDB row are REAL.
		const rows = store.listWorkflowSideEffects("run-1");
		expect(rows).toHaveLength(1);
		expect(existsSync(launchCommitPath(seenExecId as string))).toBe(true);
		expect(realProbes().hasCommitMarker(seenExecId as string)).toBe(true);
		expect(
			realProbes().hasNonPendingCommDbRow(PROJECT, seenExecId as string),
		).toBe(true);

		// The row starts non-terminal (a start() success alone does not fabricate
		// `started` — the evidence chain must PROVE it).
		expect(rows[0]?.state).toBe("intent_recorded");

		// reconcile reads the REAL marker file + REAL CommDB row → started.
		writer.reconcileSideEffects();
		expect(store.listWorkflowSideEffects("run-1")[0]?.state).toBe("started");
		store.close();
	});

	it("byte-compat: with NO writer, start() leaves launchCommitPath undefined (no commit-gate, no marker)", async () => {
		workDir = mkdtempSync(join(tmpdir(), "qa-fly1232-b11-off-"));
		commDbPath = join(workDir, "comm.db");
		let seenLaunchCommitPath: string | undefined = "sentinel";
		const dispatcher = new IsolatedDispatcher(
			makeRuntime(async (ctx) => {
				seenLaunchCommitPath = ctx.launchCommitPath as string | undefined;
				return { success: true, sessionId: "s1" };
			}),
			[],
			// no writer → the fresh path must keep launchCommitPath undefined
		);
		await dispatcher.start({ issueId: ISSUE, projectName: PROJECT });
		await dispatcher.drain();
		expect(seenLaunchCommitPath).toBeUndefined();
	});
});
