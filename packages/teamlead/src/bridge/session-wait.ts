/**
 * FLY-205 (Codex code R1 HIGH-2): bounded wait for a session row to appear.
 *
 * Dispatchers (start AND retry) return as soon as `blueprint.run()` is kicked
 * off; the session row is created later by `DirectEventSink.emitStarted()`.
 * Any metadata patch issued right after dispatch therefore races row creation
 * — a `getSession()` guard alone can silently skip the patch in production
 * (mocks that create the row synchronously mask this).
 *
 * This helper polls until the row exists or the deadline passes. Callers
 * treat a missing row after the deadline as "metadata could not be persisted"
 * and log it — same poll discipline as the FLY-91 chat-thread poll.
 */

import type { Session, StateStore } from "../StateStore.js";

export const SESSION_WAIT_TIMEOUT_MS = 5000;
export const SESSION_WAIT_INTERVAL_MS = 250;

export async function waitForSession(
	store: StateStore,
	executionId: string,
	opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<Session | undefined> {
	const timeoutMs = opts.timeoutMs ?? SESSION_WAIT_TIMEOUT_MS;
	const intervalMs = opts.intervalMs ?? SESSION_WAIT_INTERVAL_MS;
	const deadline = Date.now() + timeoutMs;
	let session = store.getSession(executionId);
	while (!session && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, intervalMs));
		session = store.getSession(executionId);
	}
	return session;
}
