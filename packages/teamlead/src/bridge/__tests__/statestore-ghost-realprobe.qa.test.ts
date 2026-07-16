/**
 * FLY-1066 QA (Tadashi ②) — face-③ REAL-PROBE verification.
 *
 * The unit suite proves the keep/reap decision with a MOCKED probe. This QA test
 * exercises the SAME reconciler against a REAL tmux session and the REAL
 * `probeTmuxWindowLiveness` — no mock — to prove the design→implement handoff
 * shape (active StateStore row + same-pass authoritative exact target) is left
 * untouched while live and reaped only once that exact window is gone. Parked
 * founder-review states stay outside the candidate set even with dead evidence.
 *
 * Skipped automatically where tmux is unavailable (e.g. CI without a tmux server).
 */
import { execFileSync } from "node:child_process";
import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DirectiveExecutor } from "../../DirectiveExecutor.js";
import { StateStore } from "../../StateStore.js";
import {
	reapStateStoreGhost,
	type StateStoreGhostDeps,
} from "../statestore-ghost-reconcile.js";
import { probeTmuxWindowLiveness } from "../tmux-lookup.js";

const SESSION = "qa-fly1066-face3-realprobe";
let EXACT_TARGET = `${SESSION}:@0`;
const NOW = Date.parse("2026-07-16T12:00:00Z");
const OLD = "2026-07-16 11:14:00"; // 46min < NOW → past the 30min ghost guard
const FRESH = "2026-07-16 11:45:00"; // 15min < NOW → inside the guard

function tmux(args: string[]): { ok: boolean; out: string } {
	try {
		return {
			ok: true,
			out: execFileSync("tmux", args, {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}),
		};
	} catch (e) {
		return {
			ok: false,
			out:
				(e as { stdout?: string; message: string }).stdout ??
				(e as Error).message,
		};
	}
}

const tmuxAvailable = tmux(["-V"]).ok;

describe.skipIf(!tmuxAvailable)(
	"FLY-1066 face-③ real-probe (QA, real tmux)",
	() => {
		beforeAll(() => {
			tmux(["kill-session", "-t", SESSION]);
			tmux(["new-session", "-d", "-s", SESSION]);
			const windowId = tmux([
				"list-windows",
				"-t",
				`=${SESSION}`,
				"-F",
				"#{window_id}",
			]).out.trim();
			EXACT_TARGET = `${SESSION}:${windowId}`;
		});
		afterAll(() => {
			tmux(["kill-session", "-t", SESSION]);
		});

		async function mkDeps(target = EXACT_TARGET): Promise<{
			store: StateStore;
			deps: StateStoreGhostDeps;
		}> {
			const store = await StateStore.create(":memory:");
			const deps: StateStoreGhostDeps = {
				store,
				transitionOpts: {
					store,
					fsm: new WorkflowFSM(WORKFLOW_TRANSITIONS),
					executor: new DirectiveExecutor(store),
				},
				ghostMinAgeMs: 30 * 60_000,
				nowMs: () => NOW,
				lookupCommDbSession: () => undefined, // empty CommDB window (the handoff transient)
				getProvenDeadTmuxTarget: () => target,
				probe: (t) => probeTmuxWindowLiveness(t), // THE REAL PROBE
				finalizeCommDbSession: () => ({
					ok: true,
					outcome: "finalized",
					retiredGateCount: 0,
					deletedSessionCount: 0,
				}),
				log: () => {},
			};
			return { store, deps };
		}

		function seed(
			store: StateStore,
			id: string,
			startedAt: string,
			status = "running",
		): void {
			store.upsertSession({
				execution_id: id,
				issue_id: `issue-${id}`,
				project_name: "geo",
				status,
				started_at: startedAt,
				tmux_session: "legacy-untrusted-session-name",
			});
		}

		it("real probe returns alive for the exact live window, dead for an absent exact window", async () => {
			expect(await probeTmuxWindowLiveness(EXACT_TARGET)).toBe("alive");
			expect(await probeTmuxWindowLiveness(`${SESSION}:@999999`)).toBe("dead");
		});

		it("(A) running + same-pass exact target + REAL live window + 46min → KEEP", async () => {
			const { store, deps } = await mkDeps();
			seed(store, "handoff-alive", OLD);
			const outcome = await reapStateStoreGhost(
				store.getSession("handoff-alive")!,
				deps,
			);
			expect(outcome).toBe("kept_target_not_dead");
			expect(store.getSession("handoff-alive")?.status).toBe("running");
		});

		it("(C) fresh (<30min) is kept by the age guard BEFORE any probe", async () => {
			const { store, deps } = await mkDeps();
			seed(store, "handoff-fresh", FRESH);
			let probed = false;
			deps.probe = (t) => {
				probed = true;
				return probeTmuxWindowLiveness(t);
			};
			const outcome = await reapStateStoreGhost(
				store.getSession("handoff-fresh")!,
				deps,
			);
			expect(outcome).toBe("kept_fresh_or_invalid_age");
			expect(probed).toBe(false);
		});

		it("(B) SAME active shape but the REAL exact window is gone → reaped; parked stays parked", async () => {
			tmux(["kill-session", "-t", SESSION]);
			expect(await probeTmuxWindowLiveness(EXACT_TARGET)).toBe("dead");
			const { store, deps } = await mkDeps();
			seed(store, "handoff-dead", OLD);
			seed(store, "parked-dead", OLD, "awaiting_review");
			const outcome = await reapStateStoreGhost(
				store.getSession("handoff-dead")!,
				deps,
			);
			expect(outcome).toBe("reaped");
			expect(store.getSession("handoff-dead")?.status).toBe("terminated");
			expect(
				await reapStateStoreGhost(store.getSession("parked-dead")!, deps),
			).toBe("kept_non_candidate_status");
			expect(store.getSession("parked-dead")?.status).toBe("awaiting_review");
			// restore for afterAll idempotence
			tmux(["new-session", "-d", "-s", SESSION]);
		});
	},
);
