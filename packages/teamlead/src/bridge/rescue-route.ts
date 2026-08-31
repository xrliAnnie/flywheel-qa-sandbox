/**
 * FLY-871 R3/C9 — POST /api/rescue: the Codex Infra Bot's entry point to trigger
 * an infra self-heal rescue (lead kickstart OR runner close+resumed-successor) it
 * has claimed off an Alerts assignment post. The `flywheel-rescue-lead` CLI is a
 * thin client of this route.
 *
 * All the structural guards live in the pure `rescue.ts` orchestration the bound
 * runtime wraps (a rescue runs ONLY against a still-pending CONFIRMED
 * login_expired / runner_login_expired alert; restart-in-place only; evidence
 * before+after; one retry then @Annie; every step audited). This route adds only
 * the HTTP surface, input validation, and the byte-compat gate.
 *
 * Security / structural guarantees (mirrors the FLY-871 C5 account-switch route):
 *   - AUTH-REQUIRED: mounted behind the Bearer `tokenAuthMiddleware` with a
 *     tokenless-503 guard at the plugin layer (this route triggers destructive
 *     launchctl / session-close ops, so it must never run unauthenticated). NOT
 *     mounted under `/actions`.
 *   - Byte-compat: when account self-heal is OFF (`FLYWHEEL_ACCOUNT_SELF_HEAL`
 *     unset → no runtime bound), the route EXISTS but performs no rescue → 409
 *     needs_human. Zero new behavior when the flag is off.
 *   - A rescue REFUSAL (no still-pending alert, or a live re-check shows the
 *     runner recovered) is a legitimate 200 result (`ok:false` + reason), NOT an
 *     error — only an unexpected throw is a 500 (fail loud, never swallowed).
 */

import { Router } from "express";
import type { RescueOutcome } from "./rescue.js";

/** The subset of the rescue runtime this route drives. */
export interface RescueRouteRuntime {
	rescueLead: (input: {
		projectName: string;
		leadId: string;
	}) => Promise<RescueOutcome>;
	rescueRunner: (input: { executionId: string }) => Promise<RescueOutcome>;
}

export interface RescueRouteDeps {
	/**
	 * Resolved per-request so the route can mount BEFORE `app.listen` while its
	 * dependency (the rescue runtime) is constructed later in the boot sequence
	 * (the established late-bound-holder pattern in plugin.ts). undefined ⇒
	 * self-heal off ⇒ 409 needs_human (byte-compat).
	 */
	getRuntime: () => RescueRouteRuntime | undefined;
}

export function createRescueRouter(deps: RescueRouteDeps): Router {
	const router = Router();

	router.post("/", async (req, res) => {
		const b = (req.body ?? {}) as Record<string, unknown>;
		const str = (v: unknown): string | undefined =>
			typeof v === "string" && v.trim() ? v.trim() : undefined;

		const route = str(b.route);
		if (route !== "lead" && route !== "runner") {
			res.status(400).json({ error: "route must be one of lead|runner" });
			return;
		}

		const projectName = str(b.projectName);
		const leadId = str(b.leadId);
		const executionId = str(b.executionId);

		// System-boundary validation per route.
		if (route === "lead" && (!projectName || !leadId)) {
			res
				.status(400)
				.json({ error: "route=lead requires projectName + leadId" });
			return;
		}
		if (route === "runner" && !executionId) {
			res.status(400).json({ error: "route=runner requires executionId" });
			return;
		}

		// Byte-compat: self-heal off ⇒ no runtime ⇒ no rescue.
		const rt = deps.getRuntime();
		if (!rt) {
			res.status(409).json({
				outcome: "needs_human",
				reason: "self_heal_disabled",
				detail:
					"account self-heal is disabled (FLYWHEEL_ACCOUNT_SELF_HEAL off) — no rescue performed",
			});
			return;
		}

		try {
			const outcome: RescueOutcome =
				route === "lead"
					? await rt.rescueLead({
							projectName: projectName as string,
							leadId: leadId as string,
						})
					: await rt.rescueRunner({ executionId: executionId as string });
			// A refusal is a valid 200 result (the structural guard did its job),
			// not a client/server error.
			res.status(200).json(outcome);
		} catch (err) {
			// Fail loud — never silently swallow a rescue/lifecycle error.
			console.error(
				`[rescue] ${route} rescue failed: ${(err as Error).message}`,
			);
			res
				.status(500)
				.json({ error: `rescue failed: ${(err as Error).message}` });
		}
	});

	return router;
}
