/**
 * FLY-871 R2/C5 — POST /api/account-switch: the Codex Infra Bot's entry point to
 * trigger a Claude account switch it has claimed off an Alerts assignment post.
 *
 * This is the C8b "cross-provider Infra Bot claims a pending switch" path from the
 * FLY-696 design: a Claude usage cap enqueues a durable pending record (see
 * `account-switch-repair.ts` / `AutoRepairBot`), the Bridge posts an assignment
 * into the Alerts thread mentioning the Infra Bot, and the bot calls THIS route to
 * atomically claim + execute the switch before the Bridge watchdog's deadline
 * fires. The route reuses the EXISTING `switchAccount` machinery (via
 * `AccountSwitchRepair.executeSwitch`) — it adds only the HTTP surface, input
 * validation, cross-provider gating, the atomic claim, audit, and the result post.
 *
 * Security / structural guarantees (Codex-reviewed design, plan §3 C5):
 *   - AUTH-REQUIRED: mounted with a tokenless-503 guard at the plugin layer
 *     (`TEAMLEAD_API_TOKEN` absent → 503), exactly like /api/deployments; this
 *     route mutates the machine credential source, so it must never run
 *     unauthenticated. NOT mounted under `/actions`.
 *   - Self-repair is rejected: `actorBackend === provider` → 403 (a backend must
 *     never repair its OWN account family — that is what the cross self-heal
 *     architecture exists to avoid).
 *   - MVP is Claude-only: `provider !== "claude"` → 400.
 *   - Idempotent claim: `claimPending` under the pending flock; a missing or
 *     already-claimed record → 409 (the bot and the Bridge watchdog race is pinned
 *     on one pending record; a double-fire past the claim is still CAS-safe in
 *     `switchAccount`).
 *   - Byte-compat: when account self-heal is OFF (`FLYWHEEL_ACCOUNT_SELF_HEAL`
 *     unset → no runtime bound), the route EXISTS but performs no switch and
 *     writes no audit row → 409 needs_human. Zero new behavior when the flag is
 *     off (the reverse-compat sentinel asserts this).
 */

import { Router } from "express";
import type {
	AccountSwitchRepair,
	RepairDisposition,
} from "../account-heal/account-switch-repair.js";
import { withMkdirLock } from "../account-heal/mkdir-lock.js";
import {
	claimPending,
	defaultPendingPath,
	type PendingSwitch,
	pendingKey,
	readPending,
} from "../account-heal/pending-store.js";

const MVP_PROVIDER = "claude";

/** One audit row per (before / after) side of a switch attempt. */
export interface AccountSwitchAuditEntry {
	phase: "request" | "result";
	key: string;
	actorBotId: string;
	actorBackend: string;
	provider: string;
	observedAccount: string;
	observedGeneration: number;
	/** result phase only */
	outcome?: string;
	detail?: string;
}

/**
 * The late-bound runtime the route needs to actually perform a switch. Bound in
 * plugin.ts ONLY when `FLYWHEEL_ACCOUNT_SELF_HEAL=1` (the same gate that builds
 * `accountSwitchRepair`); `getRuntime()` returning undefined ⇒ self-heal off ⇒
 * the route returns 409 needs_human without touching anything (byte-compat).
 */
export interface AccountSwitchRuntime {
	/** Reuse the production switch executor (does the switch + resolvePending). */
	repair: Pick<AccountSwitchRepair, "executeSwitch">;
	/**
	 * Post the switch result back to the Alerts thread (the watchdog's path).
	 * FLY-929: the disposition rides along as an OPTIONAL second argument (see
	 * AccountSwitchWatchdogDeps.post) — single-arg impls stay valid.
	 */
	postResult: (
		detail: string,
		disposition?: RepairDisposition,
	) => Promise<void>;
	/** Append an audit row (before + after). */
	audit: (entry: AccountSwitchAuditEntry) => void;
	/**
	 * FLY-871 R3/W5: fired AFTER a successful switch (`outcome === "attempted"`) so
	 * the rescue runtime can sweep every incident-window login-stuck session (the
	 * same sweep the watchdog path triggers). Optional ⇒ undefined = no sweep
	 * (byte-compat). Best-effort: the switch has already committed, so a sweep
	 * failure must never fail the request.
	 */
	onSwitchSuccess?: () => Promise<void>;
	/**
	 * FLY-927 (Task 2.3): ticket ACK — fired once the pending switch is
	 * ATOMICALLY claimed (the owner bot took the ticket). `sourceAlertId` is the
	 * alert eventId; the wiring resolves it via getActiveAlertThreadByEventId so
	 * a stale episode can never be acked. Optional + best-effort (byte-compat).
	 */
	ackTicket?: (sourceAlertId: string) => void;
	/** Defaults to the shared pending store path / its flock / withMkdirLock. */
	pendingPath?: string;
	pendingLockPath?: string;
	withLock?: <T>(lockPath: string, fn: () => Promise<T>) => Promise<T>;
}

export interface AccountSwitchRouteDeps {
	/**
	 * Resolved per-request so the route can mount BEFORE `app.listen` while its
	 * dependency (`accountSwitchRepair`) is constructed later in the boot sequence
	 * (the established late-bound-holder pattern in plugin.ts).
	 */
	getRuntime: () => AccountSwitchRuntime | undefined;
}

export function createAccountSwitchRouter(
	deps: AccountSwitchRouteDeps,
): Router {
	const router = Router();

	router.post("/", async (req, res) => {
		const b = (req.body ?? {}) as Record<string, unknown>;
		const str = (v: unknown): string | undefined =>
			typeof v === "string" && v.trim() ? v.trim() : undefined;

		const provider = str(b.provider);
		const observedAccount = str(b.observedAccount);
		const scope = str(b.scope);
		const resetAt = str(b.resetAt);
		const sourceAlertId = str(b.sourceAlertId);
		const actorBotId = str(b.actorBotId);
		const actorBackend = str(b.actorBackend);
		const observedGeneration =
			typeof b.observedGeneration === "number" &&
			Number.isInteger(b.observedGeneration)
				? b.observedGeneration
				: undefined;

		// System-boundary validation: every field required (plan §3 C5).
		if (
			!provider ||
			!observedAccount ||
			scope === undefined ||
			!resetAt ||
			!sourceAlertId ||
			!actorBotId ||
			!actorBackend ||
			observedGeneration === undefined
		) {
			res.status(400).json({
				error:
					"required: provider, observedAccount, observedGeneration (int), scope, resetAt, sourceAlertId, actorBotId, actorBackend",
			});
			return;
		}
		if (scope !== "5h" && scope !== "weekly" && scope !== "both") {
			res.status(400).json({ error: "scope must be one of 5h|weekly|both" });
			return;
		}
		// MVP is Claude-only.
		if (provider !== MVP_PROVIDER) {
			res.status(400).json({
				error: `MVP supports provider=claude only (got '${provider}')`,
			});
			return;
		}
		// Self-repair guard: a backend must never repair its own account family.
		if (actorBackend === provider) {
			res.status(403).json({
				error:
					"actorBackend must differ from provider — a backend must not repair its own account (cross self-heal only)",
			});
			return;
		}

		const key = pendingKey(sourceAlertId, observedAccount, observedGeneration);

		// Byte-compat: self-heal off ⇒ no runtime ⇒ no switch, no audit row.
		const rt = deps.getRuntime();
		if (!rt) {
			res.status(409).json({
				outcome: "needs_human",
				reason: "self_heal_disabled",
				detail:
					"account self-heal is disabled (FLYWHEEL_ACCOUNT_SELF_HEAL off) — no switch performed",
			});
			return;
		}

		const pendingPath = rt.pendingPath ?? defaultPendingPath();
		const pendingLockPath = rt.pendingLockPath ?? `${pendingPath}.lock`;
		const withLock = rt.withLock ?? withMkdirLock;

		try {
			rt.audit({
				phase: "request",
				key,
				actorBotId,
				actorBackend,
				provider,
				observedAccount,
				observedGeneration,
			});

			// Atomic claim under the pending flock (same lock the repair uses for
			// upsert/resolve). claimPending is a no-steal claim: false if the record
			// is missing OR already claimed by another actor → 409 idempotent.
			let record: PendingSwitch | undefined;
			const claimed = await withLock(pendingLockPath, async () => {
				const ok = claimPending(key, actorBotId, pendingPath);
				if (!ok) return false;
				record = readPending(pendingPath).find((r) => r.key === key);
				return record !== undefined;
			});
			if (!claimed || !record) {
				res.status(409).json({
					outcome: "already_claimed_or_missing",
					detail: `no unclaimed pending switch for key ${key} (missing or already claimed)`,
				});
				return;
			}

			// FLY-927 (Task 2.3): the atomic claim IS the ticket ACK — best-effort;
			// an ack failure must never fail the switch.
			if (rt.ackTicket) {
				try {
					rt.ackTicket(sourceAlertId);
				} catch (err) {
					console.warn(
						`[account-switch] ticket ack failed: ${(err as Error).message}`,
					);
				}
			}

			// Execute the switch (switchAccount + resolvePending live inside).
			const disposition = await rt.repair.executeSwitch(record);
			rt.audit({
				phase: "result",
				key,
				actorBotId,
				actorBackend,
				provider,
				observedAccount,
				observedGeneration,
				outcome: disposition.outcome,
				detail: disposition.detail,
			});
			// Post the result back to the Alerts thread — best-effort (the switch has
			// already committed; a Discord post failure must not 500 the request).
			// FLY-929 (Codex code R1 HIGH): the disposition MUST ride along so the
			// bot-claimed path gets the same W6 digest + A5 owner-mention routing
			// as the watchdog path (plugin.ts postSwitchResult reads it).
			try {
				await rt.postResult(disposition.detail, disposition);
			} catch (err) {
				console.warn(
					`[account-switch] postResult failed: ${(err as Error).message}`,
				);
			}

			// FLY-871 R3/W5: a successful switch → sweep the incident-window logins.
			// Best-effort (the switch already committed).
			if (disposition.outcome === "attempted" && rt.onSwitchSuccess) {
				try {
					await rt.onSwitchSuccess();
				} catch (err) {
					console.warn(
						`[account-switch] post-switch rescue sweep failed: ${(err as Error).message}`,
					);
				}
			}

			res.status(200).json({
				ok: disposition.outcome === "attempted",
				outcome: disposition.outcome,
				action: disposition.action,
				detail: disposition.detail,
			});
		} catch (err) {
			// Fail loud — never silently swallow an executor/lock error.
			console.error(
				`[account-switch] failed for key ${key}: ${(err as Error).message}`,
			);
			res
				.status(500)
				.json({ error: `account switch failed: ${(err as Error).message}` });
		}
	});

	return router;
}
