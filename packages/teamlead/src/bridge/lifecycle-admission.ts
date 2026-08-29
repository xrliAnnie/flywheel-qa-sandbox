/**
 * FLY-1185 §2.12 (R9#2 + R11#1) — spawn admission decorator.
 *
 * `assertIssueNotLifecycleClosed` guards EVERY spawn surface at the single
 * dispatcher chokepoint (HTTP start / retry / phase handoff / auto-QA /
 * rescue all flow through IStartDispatcher.start): a founder-parked issue
 * (ACTIVE tombstone) must never grow a new runner — including the
 * "just-zeroed, immediately respawned" race.
 *
 * Park-vs-start atomicity (R11#1): the check AND the durable `starting`
 * launch claim happen INSIDE the per-root issue mutex — the same mutex the
 * closeout takes — so:
 *   - start acquires first ⇒ its claim is durably visible before park's
 *     node collection runs ⇒ park collects and closes the launch;
 *   - park acquires first ⇒ start's fresh tombstone read sees it ⇒ denied.
 *
 * Fail-closed on READ FAILURE (exceptions / uuid conflicts). A genuinely
 * fresh issue with no UUID mapping anywhere (first spawn, identifier-only,
 * zero history) has no tombstone that could match — admitted after a
 * defensive alias check (availability must not regress for new issues).
 */

import type { StateStore } from "../StateStore.js";
import { resolveLifecycleRootKey } from "./lifecycle-root-key.js";

export interface AdmissionDeps {
	store: Pick<
		StateStore,
		| "getSessionsForIssueAliases"
		| "findAutoQaRecordsByQaIssueKeys"
		| "getSession"
		| "getActiveIssueDispositionIntent"
		| "insertLaunchClaim"
		| "insertEvent"
	>;
	withIssueMutex: <T>(keys: string[], fn: () => Promise<T>) => Promise<T>;
	/** Extra aliases the caller already knows (e.g. issueId + identifier). */
}

export type AdmissionResult =
	| { admitted: true; rootKey: string }
	| { admitted: false; reason: string };

export async function assertIssueNotLifecycleClosed(
	deps: AdmissionDeps,
	input: {
		issueKey: string;
		issueIdentifier?: string;
		projectName: string;
		executionId: string;
		role?: string;
	},
): Promise<AdmissionResult> {
	const audit = (event: string, payload: Record<string, unknown>) => {
		try {
			deps.store.insertEvent({
				event_id: `lifecycle-admission-${event}-${input.executionId}`,
				execution_id: input.executionId,
				issue_id: input.issueKey,
				project_name: input.projectName,
				event_type: event,
				source: "bridge.lifecycle-admission",
				payload,
			});
		} catch {
			/* audit failure must not turn into an admission decision */
		}
	};

	let resolution: ReturnType<typeof resolveLifecycleRootKey>;
	try {
		resolution = resolveLifecycleRootKey(
			deps.store,
			input.issueKey,
			input.issueIdentifier ? [input.issueIdentifier] : [],
		);
	} catch (err) {
		audit("admission_denied", { reason: "root_resolution_failed" });
		return {
			admitted: false,
			reason: `root_resolution_failed:${err instanceof Error ? err.message : String(err)}`,
		};
	}

	if (!resolution.ok && resolution.reason === "uuid_conflict") {
		// Two UUID families claim this key — fail-closed (R10#2).
		audit("admission_denied", { reason: "uuid_conflict" });
		return { admitted: false, reason: "uuid_conflict" };
	}

	const rootKey = resolution.ok ? resolution.rootKey : input.issueKey;
	const lockKeys =
		resolution.lockKeys.length > 0 ? resolution.lockKeys : [rootKey];

	return deps.withIssueMutex(lockKeys, async () => {
		// Fresh tombstone read INSIDE the mutex — check the root AND every
		// alias defensively (a UUID-less resolution can still hit a tombstone
		// written under a UUID alias we happen to know).
		const keysToCheck = [...new Set([rootKey, ...resolution.aliasKeys])];
		for (const key of keysToCheck) {
			let intent: ReturnType<
				AdmissionDeps["store"]["getActiveIssueDispositionIntent"]
			>;
			try {
				intent = deps.store.getActiveIssueDispositionIntent(key);
			} catch (err) {
				audit("admission_denied", { reason: "tombstone_read_failed", key });
				return {
					admitted: false as const,
					reason: `tombstone_read_failed:${err instanceof Error ? err.message : String(err)}`,
				};
			}
			if (intent) {
				audit("admission_denied", {
					reason: "founder_parked",
					rootKey: key,
					founderDecisionId: intent.founderDecisionId,
				});
				return { admitted: false as const, reason: "founder_parked" };
			}
		}

		// Durable `starting` claim BEFORE releasing the mutex — a concurrent
		// park's node collection is guaranteed to see this launch (R11#1).
		deps.store.insertLaunchClaim({
			executionId: input.executionId,
			rootUuid: rootKey,
			project: input.projectName,
			role: input.role,
		});
		return { admitted: true as const, rootKey };
	});
}
