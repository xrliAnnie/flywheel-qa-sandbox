/**
 * FLY-799 (auto-Linear-Done-on-ship) — the genuine "auto 收尾" gap.
 *
 * After a runner self-ships (PR merged), the Linear issue should flip to Done
 * automatically — otherwise a shipped issue lingers not-Done and the
 * auto-finalize promise is incomplete (Tadashi). This is ONLY ever called from
 * `runPostShipFinalization`, which runs solely on confirmed merge evidence
 * (`isPostApproveShipComplete` requires landingStatus="merged"), so the
 * ship-success gate is structural — we never mark Done for an un-merged ship.
 *
 * Best-effort: resolves the team's completed-type ("Done") workflow state and
 * updates the issue. Never throws (a Linear failure must not break finalization
 * teardown). Injected client interface so it is unit-testable without the SDK.
 */

/** Minimal structural subset of the Linear SDK client we use. */
export interface LinearIssueFinalizerClient {
	issue(id: string): Promise<{
		team: Promise<
			| {
					states(): Promise<{
						nodes: Array<{ id: string; name: string; type?: string }>;
					}>;
			  }
			| undefined
			| null
		>;
	}>;
	updateIssue(id: string, update: { stateId: string }): Promise<unknown>;
}

export interface MarkDoneResult {
	done: boolean;
	reason?: string;
}

/**
 * Flip a Linear issue to its team's Done state. Prefers a `type === "completed"`
 * workflow state (the canonical "Done" bucket, robust to renamed states); falls
 * back to a case-insensitive name match on "done" when no completed-type state
 * exists. Returns `{ done: false }` (never throws) when nothing resolves.
 */
export async function markLinearIssueDone(
	client: LinearIssueFinalizerClient,
	issueId: string,
): Promise<MarkDoneResult> {
	try {
		const issue = await client.issue(issueId);
		const team = await issue.team;
		if (!team) return { done: false, reason: "no_team" };

		const { nodes } = await team.states();
		const doneState =
			nodes.find((s) => s.type === "completed") ??
			nodes.find((s) => s.name.toLowerCase() === "done");
		if (!doneState) return { done: false, reason: "no_done_state" };

		await client.updateIssue(issueId, { stateId: doneState.id });
		return { done: true };
	} catch (err) {
		return { done: false, reason: (err as Error).message };
	}
}

/**
 * Compose the `markIssueDone` closure runPostShipFinalization calls. Returns
 * undefined (→ finalization skips the Linear transition, byte-compatibly) when
 * the default-ON kill-switch `FLYWHEEL_AUTO_LINEAR_DONE=0` is set OR no Linear
 * api key is configured. Built at each finalization call site from the config it
 * already holds — avoids threading a new positional dep through createEventRouter
 * / DirectEventSink. Best-effort: the closure never throws.
 */
export function makeLinearDoneFinalizer(config: {
	linearApiKey?: string;
}): ((issueId: string, issueIdentifier?: string) => Promise<void>) | undefined {
	if (process.env.FLYWHEEL_AUTO_LINEAR_DONE === "0") return undefined;
	const apiKey = config.linearApiKey;
	if (!apiKey) return undefined;
	return async (issueId, issueIdentifier) => {
		try {
			const { LinearClient } = await import("@linear/sdk");
			const client = new LinearClient({ apiKey });
			const r = await markLinearIssueDone(
				client as unknown as LinearIssueFinalizerClient,
				issueId,
			);
			if (r.done) {
				console.log(
					`[linear-finalizer] ${issueIdentifier ?? issueId} → Done (auto-finalize on ship)`,
				);
			} else {
				console.warn(
					`[linear-finalizer] ${issueIdentifier ?? issueId} NOT flipped to Done: ${r.reason ?? "unknown"}`,
				);
			}
		} catch (err) {
			console.warn(
				`[linear-finalizer] markIssueDone threw for ${issueId} (non-fatal): ${(err as Error).message}`,
			);
		}
	};
}
