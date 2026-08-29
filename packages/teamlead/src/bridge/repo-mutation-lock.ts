/**
 * FLY-1185 §2.11 — per-main-repo mutation coordinator.
 *
 * In-process async mutex keyed by the CANONICAL main-repo path. Every
 * Flywheel-side structural repo mutation (worktree create/remove, sweep
 * passes, branch CAS deletes, QA teardown, the Layer A removal segment)
 * runs inside `withRepoLock`, so every check-then-delete sequence is atomic
 * against every other one WITHIN this Bridge process. That is the whole
 * TOCTOU surface: multiple Bridges never share a projectRoot (QA slot
 * bridges run against their own worktree repos), and EXTERNAL git users are
 * excluded from automatic local-ref deletion entirely (plan §2.4 R4#3 —
 * periodic local orphan-branch deletion is bundle+manual-apply only).
 *
 * LOCK-INTERNAL CONTRACT (plan §2.11): the holder must do its fresh
 * re-validation (sessions/protection/liveness, `git worktree list`,
 * registered branch/HEAD, clean/activity, open-PR cache age, expected SHA,
 * binding generation vs admin marker) INSIDE the critical section — the
 * lock only guarantees the check and the delete are not interleaved with
 * another Flywheel mutation.
 *
 * Re-entrant per async context (AsyncLocalStorage): a sweep holding the
 * lock may call WorktreeManager methods that are themselves wrapped by the
 * injected `withRepoLock` without deadlocking. Re-entry NEVER re-queues.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { canonicalizeWorktreePath } from "flywheel-edge-worker";

export type WithRepoLock = <T>(
	mainRepoPath: string,
	fn: () => Promise<T>,
) => Promise<T>;

export interface RepoMutationLock {
	withRepoLock: WithRepoLock;
	/** Observability/tests: number of queued+running holders for the key. */
	pendingCount(mainRepoPath: string): number;
}

export function createRepoMutationLock(): RepoMutationLock {
	/** Tail of the wait chain per canonical repo path. */
	const tails = new Map<string, Promise<void>>();
	const counts = new Map<string, number>();
	/** Keys held by the current async context (re-entrancy detection). */
	const held = new AsyncLocalStorage<ReadonlySet<string>>();

	const withRepoLock = async <T>(
		mainRepoPath: string,
		fn: () => Promise<T>,
	): Promise<T> => {
		const key = canonicalizeWorktreePath(mainRepoPath);
		const heldKeys = held.getStore();
		if (heldKeys?.has(key)) {
			// Re-entrant: we are already inside this key's critical section.
			return fn();
		}

		const prevTail = tails.get(key) ?? Promise.resolve();
		let release!: () => void;
		const ourTurnDone = new Promise<void>((resolve) => {
			release = resolve;
		});
		const newTail = prevTail.then(() => ourTurnDone);
		tails.set(key, newTail);
		counts.set(key, (counts.get(key) ?? 0) + 1);

		await prevTail;
		try {
			const nextHeld = new Set(heldKeys ?? []);
			nextHeld.add(key);
			return await held.run(nextHeld, fn);
		} finally {
			release();
			const remaining = (counts.get(key) ?? 1) - 1;
			if (remaining <= 0) {
				counts.delete(key);
				// Only drop the tail if no later waiter replaced it.
				if (tails.get(key) === newTail) tails.delete(key);
			} else {
				counts.set(key, remaining);
			}
		}
	};

	return {
		withRepoLock,
		pendingCount: (mainRepoPath: string) =>
			counts.get(canonicalizeWorktreePath(mainRepoPath)) ?? 0,
	};
}
