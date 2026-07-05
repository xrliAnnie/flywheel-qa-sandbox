/**
 * FLY-314 Phase 2 Part(b) — Codex-side parity for roundtable topic-thread no-@
 * continuation. Mirrors the Claude plugin's anti-loop budget so Mufasa (and any Codex
 * Lead) keeps the SAME convergence contract (Codex design review R1#1):
 *
 *   Inside a roundtable topic thread, ANY bot-authored trigger — even one that
 *   @-mentions this Lead or quote-replies to it — CONSUMES a finite per-thread budget
 *   and CANNOT reset or bypass it. The budget resets ONLY on a non-bot human message
 *   (or a new top-level topic, which a fresh thread provides). => bot-only loops
 *   terminate in <= budget steps.
 *
 * Membership is implicit on the Codex side: a thread is only in the dynamic registry
 * because THIS Lead was pulled in / discovered it, so "is in registry" == "is a
 * participant" (no separate membership probe needed — unlike the Claude plugin).
 *
 * Pure + side-effect-free (the store is the only mutable input) so the loop proof,
 * including the 2-bot adversarial case, is exhaustively unit-tested.
 */

export interface ThreadBudgetStore {
	budgets: Map<string, number>;
}

/** FLY-676 — default per-thread bot-only anti-loop budget. Raised from 2 → 12 so a natural
 * multi-turn back-and-forth between thread members is not truncated, while a runaway bot-only
 * loop still terminates in <= 12 steps per Lead (reset only by a human message / new topic).
 * Kept in lockstep with the Claude plugin's DEFAULT_ROUNDTABLE_THREAD_BUDGET (vendor parity). */
export const DEFAULT_ROUNDTABLE_THREAD_BUDGET = 12;

export function createThreadBudgetStore(): ThreadBudgetStore {
	return { budgets: new Map() };
}

/**
 * Seed (reset) a thread's bot-only budget to N. Called ONLY on a genuine reset event:
 * a new top-level topic this Lead engages (its reply is routed into the thread) or a
 * non-bot human message. A bot-authored trigger must NEVER seed — see
 * decideTopicThreadContinuation (Codex code review R1#1): a missing entry on a bot
 * trigger means "exhausted/drop", so process restart / state loss is NOT an implicit
 * reset.
 */
export function seedThreadBudget(
	store: ThreadBudgetStore,
	threadId: string,
	budgetN: number,
): void {
	store.budgets.set(threadId, budgetN);
}

export interface ContinuationInput {
	threadId: string;
	/** Author is a bot (any bot, incl sibling Leads). false => a non-bot human. */
	authorBot: boolean;
}

/**
 * Decide whether THIS Lead may handle a message in a roundtable topic thread WITHOUT
 * an explicit @-mention, applying the bounded anti-loop budget. Mutates `store`.
 * Returns true to handle (deliver to the Lead), false to drop.
 *
 * Callers must only invoke this for messages in a topic thread the Lead participates
 * in (registry member) AND after own-echo has been filtered upstream.
 */
export function decideTopicThreadContinuation(
	input: ContinuationInput,
	store: ThreadBudgetStore,
	opts: { budgetN: number },
): boolean {
	// A non-bot human message is a reset event: refill so members may continue again,
	// and the Lead may respond (it participates in this thread).
	if (!input.authorBot) {
		store.budgets.set(input.threadId, opts.budgetN);
		return true;
	}
	// Bot-authored trigger → strictly budget-gated. An explicit <@bot> / quote-reply
	// from a bot does NOT bypass or reset the budget; it consumes it like any other bot
	// trigger. A MISSING entry means "exhausted" (NOT a fresh budget) — the budget is
	// seeded only on a new top-level topic engage (the wiring's resolveReplyRoute) or a
	// human message (Codex code review R1#1), so process restart / state loss falls on
	// the safe side. Exhausted → stop until a human/new-topic reset.
	const remaining = store.budgets.get(input.threadId) ?? 0;
	if (remaining > 0) {
		store.budgets.set(input.threadId, remaining - 1);
		return true;
	}
	return false;
}
