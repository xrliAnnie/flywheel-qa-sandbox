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
 * FLY-1185 (Codex R1#7): the finalizer is the plan's ⑥ executor with a
 * MANDATORY fresh-state precheck — it re-reads the issue's CURRENT workflow
 * state right before the write and refuses to overwrite a canceled issue
 * (founder/Linear-side Cancel racing a merged PR must win; a canceled issue
 * is NEVER flipped to Done by automation).
 *
 * Best-effort: resolves the team's completed-type ("Done") workflow state and
 * updates the issue. Never throws (a Linear failure must not break finalization
 * teardown). Injected client interface so it is unit-testable without the SDK.
 */

/** Minimal structural subset of the Linear SDK client we use. */
export interface LinearIssueFinalizerClient {
	issue(id: string): Promise<{
		state?: Promise<
			{ id: string; name: string; type?: string } | undefined | null
		>;
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

export type LinearDoneFinalizer = (
	issueId: string,
	issueIdentifier?: string,
	signal?: AbortSignal,
) => Promise<MarkDoneResult>;

function assertLinearDoneNotAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("linear_done_aborted");
}

/**
 * Flip a Linear issue to its team's Done state. Prefers a `type === "completed"`
 * workflow state (the canonical "Done" bucket, robust to renamed states); falls
 * back to a case-insensitive name match on "done" when no completed-type state
 * exists. Returns `{ done: false }` (never throws) when nothing resolves.
 *
 * Fresh-state guard (Codex R1#7): the issue's CURRENT state is read in the
 * same lookup — `canceled` type (or an already-completed state) → zero write.
 */
export async function markLinearIssueDone(
	client: LinearIssueFinalizerClient,
	issueId: string,
	signal?: AbortSignal,
): Promise<MarkDoneResult> {
	// Codex R2#9: the state read is FAIL-CLOSED (unreadable/missing → no
	// write) and the write is guarded by a SECOND fresh read right before the
	// mutation — a cancel landing during the team/states awaits still wins.
	const readStateType = async (): Promise<string | undefined> => {
		assertLinearDoneNotAborted(signal);
		const issue = await client.issue(issueId);
		assertLinearDoneNotAborted(signal);
		const current = issue.state ? await issue.state : undefined;
		assertLinearDoneNotAborted(signal);
		if (!current?.type) throw new Error("state_unreadable");
		return current.type;
	};
	try {
		const first = await readStateType().catch(() => undefined);
		if (first === undefined) {
			return { done: false, reason: "state_unreadable_fail_closed" };
		}
		if (first === "canceled") {
			return { done: false, reason: "issue_canceled_never_overwritten" };
		}
		if (first === "completed") {
			return { done: true, reason: "already_completed" };
		}

		assertLinearDoneNotAborted(signal);
		const issue = await client.issue(issueId);
		assertLinearDoneNotAborted(signal);
		const team = await issue.team;
		assertLinearDoneNotAborted(signal);
		if (!team) return { done: false, reason: "no_team" };

		assertLinearDoneNotAborted(signal);
		const { nodes } = await team.states();
		assertLinearDoneNotAborted(signal);
		const doneState =
			nodes.find((s) => s.type === "completed") ??
			nodes.find((s) => s.name.toLowerCase() === "done");
		if (!doneState) return { done: false, reason: "no_done_state" };

		// Second fresh read immediately before the write (TOCTOU guard).
		const second = await readStateType().catch(() => undefined);
		if (second === undefined) {
			return { done: false, reason: "state_unreadable_fail_closed" };
		}
		if (second === "canceled") {
			return { done: false, reason: "issue_canceled_never_overwritten" };
		}
		if (second === "completed") {
			return { done: true, reason: "already_completed" };
		}
		if (second !== first) {
			return {
				done: false,
				reason: `state_changed_midflight:${first}->${second}`,
			};
		}

		assertLinearDoneNotAborted(signal);
		await client.updateIssue(issueId, { stateId: doneState.id });
		return { done: true };
	} catch (err) {
		return { done: false, reason: (err as Error).message };
	}
}

/**
 * Bound a best-effort Linear Done attempt. The timeout aborts first, so a
 * delayed SDK read cannot later reach the mutation guarded by the same signal.
 */
export async function raceMarkIssueDoneWithAbort(
	finalizer: LinearDoneFinalizer,
	issueId: string,
	issueIdentifier?: string,
	timeoutMs = 15_000,
	observer?: {
		onRejected?: (error: Error) => void;
		onTimeout?: (timeoutMs: number) => void;
		timeoutReason?: string;
	},
): Promise<MarkDoneResult> {
	const controller = new AbortController();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const attempt = Promise.resolve()
		.then(() => finalizer(issueId, issueIdentifier, controller.signal))
		.catch((err): MarkDoneResult => {
			const error = err instanceof Error ? err : new Error(String(err));
			try {
				observer?.onRejected?.(error);
			} catch {
				// Observability must never perturb best-effort finalization.
			}
			return { done: false, reason: error.message };
		});
	const deadline = new Promise<MarkDoneResult>((resolve) => {
		timeout = setTimeout(() => {
			controller.abort();
			try {
				observer?.onTimeout?.(timeoutMs);
			} catch {
				// Observability must never perturb best-effort finalization.
			}
			resolve({
				done: false,
				reason: observer?.timeoutReason ?? "linear_done_timeout",
			});
		}, timeoutMs);
	});

	try {
		return await Promise.race([attempt, deadline]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

/**
 * Compose the `markIssueDone` closure runPostShipFinalization calls. Returns
 * undefined (→ finalization skips the Linear transition) when no Linear api key
 * is configured. Built at each finalization call site from the config it
 * already holds — avoids threading a new positional dep through createEventRouter
 * / DirectEventSink. Best-effort: the closure never throws.
 */
export function makeLinearDoneFinalizer(config: {
	linearApiKey?: string;
}): LinearDoneFinalizer | undefined {
	const apiKey = config.linearApiKey;
	if (!apiKey) return undefined;
	return async (issueId, issueIdentifier, signal) => {
		try {
			const { LinearClient } = await import("@linear/sdk");
			const client = new LinearClient({ apiKey });
			const r = await markLinearIssueDone(
				client as unknown as LinearIssueFinalizerClient,
				issueId,
				signal,
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
			return r;
		} catch (err) {
			console.warn(
				`[linear-finalizer] markIssueDone threw for ${issueId} (non-fatal): ${(err as Error).message}`,
			);
			return { done: false, reason: (err as Error).message };
		}
	};
}
