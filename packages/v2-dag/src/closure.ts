import { FENCE, type Kernel } from "flywheel-v2-kernel";
import type { CanonicalValue } from "./digests.js";
import { appendEvent } from "./events.js";
import type { ShipGateData } from "./gate.js";
import {
	insertEnvelope,
	makeEnvelope,
	readCutoverEpoch,
	readEnvelope,
	updateEnvelope,
} from "./meta.js";
import { appendLifecycleTx } from "./outbox.js";
import { terminalizeSessionMailboxTx } from "./terminal-mail.js";
import type { DagPorts } from "./types.js";

/**
 * FLY-1544 ⑤⑥: whole-issue closure after the merge.
 *
 * A node finishing never tears anything down; the ONE teardown point is the
 * issue's ship gate settling (direct ship or reconcile-ship re-entry). The
 * closure hook runs on the host coordinator tick — the only place with a real
 * launcher — and executes, in order:
 *
 *   1. stop every live session of the issue (launcher.stop via runnerControl),
 *      settle its activation and terminalize its session mailbox;
 *   2. dirty-safe removal of each of the issue's worktrees (clean-probe first,
 *      then a non-force `git worktree remove` — git itself refuses a tree that
 *      turned dirty in between);
 *   3. delete the REMOTE branch behind a compare-and-swap on the recorded span
 *      tip (the local branch is deliberately left alone — v1 lesson);
 *   4. clear the issue's canonical_worktree / span_tip / writer_chain rows.
 *
 * Fire-once, no retries, no daemon: a durable `issue_closure:<issueId>` marker
 * claims the issue before any effect; every failure lands a visible
 * `issue_closure_step_failed` event and finalizes the marker as failed —
 * residue stays visible for the operator instead of being retried forever.
 */
export interface IssueCleanupPort {
	worktreeClean(worktreePath: string): Promise<boolean | "unknown">;
	/**
	 * Non-force removal; must throw when git refuses. Returns the main repo
	 * path derived from the worktree BEFORE removal — the remote-branch CAS
	 * needs a repository to push from after the worktree is gone
	 * (canonical_worktree.repo_identity is the "__main__" sentinel, not a path).
	 */
	removeWorktree(worktreePath: string): Promise<{ mainRepoPath: string }>;
	deleteRemoteBranch(input: {
		mainRepoPath: string;
		branch: string;
		expectedSha: string;
	}): Promise<
		{ deleted: true; sha: string } | { deleted: false; reason: string }
	>;
}

interface ClosureMarker {
	state: "running" | "done" | "failed";
	merged_sha: string;
	steps: Record<string, string>;
	started_at: string;
	finished_at: string | null;
}

interface IssueData {
	task_ids: string[];
	worktree_ids?: string[];
	ship_worktree_id: string;
	notify_agent_id: string;
}

export interface IssueClosureResult {
	examined: number;
	closed: number;
	failed: number;
	/** FLY-1556: gate rows that could not even be parsed into candidates. */
	unreadable?: number;
}

interface Candidate {
	issueId: string;
	mergedSha: string;
}

function markerKey(issueId: string): string {
	return `issue_closure:${issueId}`;
}

export async function closeShippedIssues(
	kernel: Kernel,
	ports: DagPorts,
): Promise<IssueClosureResult> {
	const result: IssueClosureResult = { examined: 0, closed: 0, failed: 0 };
	// FLY-1556: a single unreadable gate row must not abort the enumeration —
	// it is counted and recorded, and every other issue still closes.
	const unreadable: Array<{ key: string; error: string }> = [];
	const candidates = kernel.read((tx) =>
		tx
			.all<{ key: string }>(
				"SELECT key FROM meta WHERE key LIKE 'ship_gate:%' ORDER BY key",
			)
			.flatMap((row) => {
				try {
					const gate = readEnvelope<ShipGateData>(tx, row.key);
					if (!gate || gate.data.settled === null) return [];
					const issueId = row.key.slice("ship_gate:".length);
					if (readEnvelope<ClosureMarker>(tx, markerKey(issueId))) return [];
					return [
						{
							issueId,
							mergedSha: gate.data.settled.merged_sha ?? "",
						} satisfies Candidate,
					];
				} catch (error) {
					unreadable.push({
						key: row.key,
						error: error instanceof Error ? error.message : String(error),
					});
					return [];
				}
			}),
	);
	for (const entry of unreadable) {
		result.unreadable = (result.unreadable ?? 0) + 1;
		kernel.write("v2dag.closure.candidate-unreadable", (tx) => {
			const epoch = readCutoverEpoch(tx);
			const eventUid = `issue_closure_candidate_unreadable:${entry.key}`;
			if (
				tx.get("SELECT 1 FROM events WHERE event_uid=@eventUid", { eventUid })
			) {
				return;
			}
			appendEvent(tx, {
				eventUid,
				kind: "issue_closure_candidate_unreadable",
				sourceKind: "issue_closure",
				sourceId: entry.key,
				payload: { meta_key: entry.key, error: entry.error },
				cutoverEpoch: epoch,
				createdAt: ports.clock.nowIso(),
			});
		});
	}
	for (const candidate of candidates) {
		result.examined += 1;
		// FLY-1556: one issue's closure blowing up (a claim/marker write that
		// throws, not just a step failure closeIssue already contains) must not
		// stop the remaining issues from closing.
		let outcome: "closed" | "failed" | "skipped";
		try {
			outcome = await closeIssue(kernel, ports, candidate);
		} catch (error) {
			outcome = "failed";
			kernel.write("v2dag.closure.candidate-threw", (tx) => {
				const epoch = readCutoverEpoch(tx);
				const eventUid = `issue_closure_step_failed:${candidate.issueId}:unhandled`;
				if (
					tx.get("SELECT 1 FROM events WHERE event_uid=@eventUid", { eventUid })
				) {
					return;
				}
				appendEvent(tx, {
					eventUid,
					kind: "issue_closure_step_failed",
					sourceKind: "issue_closure",
					sourceId: candidate.issueId,
					payload: {
						issue_id: candidate.issueId,
						step: "unhandled",
						error: error instanceof Error ? error.message : String(error),
					},
					cutoverEpoch: epoch,
					createdAt: ports.clock.nowIso(),
				});
			});
		}
		if (outcome === "closed") result.closed += 1;
		if (outcome === "failed") result.failed += 1;
	}
	return result;
}

async function closeIssue(
	kernel: Kernel,
	ports: DagPorts,
	candidate: Candidate,
): Promise<"closed" | "failed" | "skipped"> {
	const { issueId } = candidate;
	const steps: Record<string, string> = {};
	// Claim: fire-once. A raced or pre-existing marker means someone else owns
	// (or owned) this closure — never re-enter.
	const claimed = kernel.write("v2dag.closure.claim", (tx) => {
		const epoch = readCutoverEpoch(tx);
		if (readEnvelope<ClosureMarker>(tx, markerKey(issueId))) return false;
		insertEnvelope(
			tx,
			markerKey(issueId),
			makeEnvelope<ClosureMarker>(epoch, {
				state: "running",
				merged_sha: candidate.mergedSha,
				steps: {},
				started_at: ports.clock.nowIso(),
				finished_at: null,
			}),
			ports.clock.nowIso(),
		);
		return true;
	});
	if (!claimed) return "skipped";

	const fail = (step: string, error: unknown): "failed" => {
		const message = error instanceof Error ? error.message : String(error);
		steps[step] = `failed: ${message}`;
		kernel.write("v2dag.closure.failed", (tx) => {
			const epoch = readCutoverEpoch(tx);
			appendEvent(tx, {
				eventUid: `issue_closure_step_failed:${issueId}:${step}`,
				kind: "issue_closure_step_failed",
				sourceKind: "issue_closure",
				sourceId: issueId,
				payload: { issue_id: issueId, step, error: message },
				cutoverEpoch: epoch,
				createdAt: ports.clock.nowIso(),
			});
			finalizeMarkerTx(tx, issueId, "failed", steps, ports, candidate);
		});
		return "failed";
	};

	// Step 1 — ⑤: stop EVERY session the issue ever spawned. A completed
	// node's activation is ledger-terminal but its tmux session deliberately
	// stays up (FLY-1543 ⑤ — nodes hang around; nothing on the normal
	// completion path calls launcher.stop). Whole-issue closure is the ONE
	// place they are all collected: stop is idempotent (an absent session is a
	// no-op), and only still-active activations get ledger settlement.
	let sessions: Array<{
		session_ref: string;
		activation_id: string;
		state: string;
	}>;
	try {
		sessions = kernel.read((tx) =>
			tx.all<{ session_ref: string; activation_id: string; state: string }>(
				`SELECT act.session_ref,act.id AS activation_id,act.state
				   FROM activations act
				   JOIN attempts a ON a.id=act.attempt_id
				   JOIN tasks t ON t.id=a.task_id
				  WHERE t.external_issue_id=@issueId
				  ORDER BY act.session_ref`,
				{ issueId },
			),
		);
	} catch (error) {
		return fail("enumerate_sessions", error);
	}
	for (const session of sessions) {
		try {
			await ports.runnerControl.requestStop(session.session_ref);
		} catch (error) {
			return fail(`stop_session:${session.session_ref}`, error);
		}
		if (session.state !== "active") continue;
		try {
			kernel.write("v2dag.closure.settle-session", (tx) => {
				const epoch = readCutoverEpoch(tx);
				tx.cas(FENCE.activationCasActiveTerminal, {
					activationId: session.activation_id,
				});
				terminalizeSessionMailboxTx(tx, {
					sessionRef: session.session_ref,
					cutoverEpoch: epoch,
					nowIso: ports.clock.nowIso(),
				});
			});
		} catch (error) {
			return fail(`settle_session:${session.session_ref}`, error);
		}
	}
	steps.sessions = `stopped:${sessions.length}`;

	// Steps 2-4 — ⑥: per worktree, dirty-safe removal → remote branch delete →
	// registration cleanup. A dirty/unknown tree keeps its registration and its
	// branch (visible residue), and is reported — never forced, never retried.
	const issue = kernel.read((tx) =>
		readEnvelope<IssueData>(tx, `dag_issue:${issueId}`),
	);
	if (!issue) return fail("issue_receipt", new Error("dag_issue is missing"));
	const worktreeIds = issue.data.worktree_ids ?? [issue.data.ship_worktree_id];
	const cleanup = ports.issueCleanup;
	for (const worktreeId of worktreeIds) {
		const registration = kernel.read((tx) => ({
			worktree: readEnvelope<{
				worktree_path: string;
				repo_identity: string;
				branch_ref: string;
			}>(tx, `canonical_worktree:${worktreeId}`),
			span: readEnvelope<{ head: string }>(tx, `span_tip:${worktreeId}`),
		}));
		if (!registration.worktree) {
			steps[`worktree:${worktreeId}`] = "skipped: no registration";
			continue;
		}
		if (!cleanup) {
			return fail(
				`worktree:${worktreeId}`,
				new Error("issue cleanup port is unavailable on this runtime"),
			);
		}
		const path = registration.worktree.data.worktree_path;
		let clean: boolean | "unknown";
		try {
			clean = await cleanup.worktreeClean(path);
		} catch (error) {
			return fail(`worktree_probe:${worktreeId}`, error);
		}
		if (clean !== true) {
			// Dirty or unprobeable: keep tree + branch + registration, say so.
			steps[`worktree:${worktreeId}`] = `kept: ${
				clean === "unknown" ? "clean state unknown" : "dirty"
			}`;
			kernel.write("v2dag.closure.residue", (tx) => {
				const epoch = readCutoverEpoch(tx);
				appendEvent(tx, {
					eventUid: `issue_closure_residue:${issueId}:${worktreeId}`,
					kind: "issue_closure_residue",
					sourceKind: "issue_closure",
					sourceId: issueId,
					payload: {
						issue_id: issueId,
						worktree_id: worktreeId,
						worktree_path: path,
						reason: clean === "unknown" ? "clean_unknown" : "dirty",
					},
					cutoverEpoch: epoch,
					createdAt: ports.clock.nowIso(),
				});
			});
			continue;
		}
		let mainRepoPath: string;
		try {
			mainRepoPath = (await cleanup.removeWorktree(path)).mainRepoPath;
		} catch (error) {
			return fail(`worktree_remove:${worktreeId}`, error);
		}
		steps[`worktree:${worktreeId}`] = "removed";
		const branchRef = registration.worktree.data.branch_ref;
		const branch = branchRef.replace(/^refs\/heads\//, "");
		const expectedSha = registration.span?.data.head ?? "";
		if (branch && branch !== "HEAD" && expectedSha) {
			try {
				const deleted = await cleanup.deleteRemoteBranch({
					mainRepoPath,
					branch,
					expectedSha,
				});
				steps[`remote_branch:${worktreeId}`] = deleted.deleted
					? `deleted:${deleted.sha}`
					: `kept: ${deleted.reason}`;
			} catch (error) {
				return fail(`remote_branch:${worktreeId}`, error);
			}
		} else {
			steps[`remote_branch:${worktreeId}`] = "skipped: no branch identity";
		}
		try {
			kernel.write("v2dag.closure.clear-registration", (tx) => {
				tx.run("DELETE FROM meta WHERE key=@key", {
					key: `canonical_worktree:${worktreeId}`,
				});
				tx.run("DELETE FROM meta WHERE key=@key", {
					key: `span_tip:${worktreeId}`,
				});
				tx.run("DELETE FROM meta WHERE key=@key", {
					key: `writer_chain:${worktreeId}`,
				});
			});
			steps[`registration:${worktreeId}`] = "cleared";
		} catch (error) {
			return fail(`registration:${worktreeId}`, error);
		}
	}

	kernel.write("v2dag.closure.done", (tx) => {
		const epoch = readCutoverEpoch(tx);
		appendEvent(tx, {
			eventUid: `issue_closed:${issueId}`,
			kind: "issue_closed",
			sourceKind: "issue_closure",
			sourceId: issueId,
			payload: {
				issue_id: issueId,
				merged_sha: candidate.mergedSha,
				steps: steps as unknown as CanonicalValue,
			},
			cutoverEpoch: epoch,
			createdAt: ports.clock.nowIso(),
		});
		// FLY-1544 ③: the messenger posts the wrap-up and archives the thread.
		appendLifecycleTx(tx, {
			sourceKind: "dag_issue_closed",
			sourceId: issueId,
			kind: "issue_closed",
			issueId,
			payload: { merged_sha: candidate.mergedSha },
			cutoverEpoch: epoch,
			createdAt: ports.clock.nowIso(),
		});
		finalizeMarkerTx(tx, issueId, "done", steps, ports, candidate);
	});
	return "closed";
}

function finalizeMarkerTx(
	tx: Parameters<Parameters<Kernel["write"]>[1]>[0],
	issueId: string,
	state: "done" | "failed",
	steps: Record<string, string>,
	ports: DagPorts,
	candidate: Candidate,
): void {
	const current = readEnvelope<ClosureMarker>(tx, markerKey(issueId));
	if (!current) return;
	updateEnvelope(
		tx,
		markerKey(issueId),
		current,
		{
			state,
			merged_sha: candidate.mergedSha,
			steps,
			started_at: current.data.started_at,
			finished_at: ports.clock.nowIso(),
		},
		ports.clock.nowIso(),
	);
}
