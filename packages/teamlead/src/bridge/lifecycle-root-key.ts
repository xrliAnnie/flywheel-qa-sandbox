/**
 * FLY-1185 §2.12 (R10#2 + R11#2) — canonical lifecycle-root key resolution.
 *
 * EVERY issue-scoped lifecycle surface — admission tombstone checks, residue
 * dedupe, the A–E closeout entries, manual manifest/apply, the durable
 * closeout epoch — must key on the SAME canonical root, or two surfaces can
 * hold different locks for the same real-world issue family and interleave
 * mutations. The root is:
 *
 *   - the issue's immutable Linear UUID (identifier ↔ UUID aliases collapse
 *     onto it via session rows and, when the caller has one, a fresh Linear
 *     lookup passed in as `extraAliases`);
 *   - a trusted auto-QA child issue (`auto_qa_record.qa_issue_id`) merges
 *     into its PARENT's root — a QA child is never its own root.
 *
 * FAIL-CLOSED CONTRACT: when the mapping is missing (no UUID known),
 * conflicted (two distinct UUIDs in one closure), or otherwise not uniquely
 * resolvable, `ok:false` is returned — deletion-bearing paths must treat
 * that as "no automatic mutation". `lockKeys` is still populated (the full
 * related key set, stably sorted) so callers that only need serialization
 * can take ALL the locks; taking a single child key's lock is forbidden.
 */

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuidKey(key: string): boolean {
	return UUID_RE.test(key);
}

export interface LifecycleRootStore {
	getSessionsForIssueAliases(keys: string[]): Array<{
		execution_id: string;
		issue_id: string;
		issue_identifier: string | null;
	}>;
	/**
	 * auto_qa_record rows whose QA-child issue key (qa_issue_id /
	 * qa_issue_identifier) matches ANY given key. Used to fold a QA child
	 * into its parent's root.
	 */
	findAutoQaRecordsByQaIssueKeys(keys: string[]): Array<{
		parent_execution_id: string;
		issue_id: string;
	}>;
	getSession(
		executionId: string,
	): { issue_id: string; issue_identifier?: string | null } | undefined;
}

export type LifecycleRootResolution =
	| {
			ok: true;
			/** Canonical root — the single immutable Linear UUID. */
			rootKey: string;
			/** Keys to mutex on (sorted). ok:true ⇒ exactly [rootKey]. */
			lockKeys: string[];
			/** Full alias closure (UUIDs + identifiers) for residue queries. */
			aliasKeys: string[];
	  }
	| {
			ok: false;
			reason: "no_uuid_mapping" | "uuid_conflict";
			/** Sorted full related key set — callers may still serialize on it. */
			lockKeys: string[];
			aliasKeys: string[];
	  };

const MAX_CLOSURE_ROUNDS = 6;

/**
 * Resolve the canonical lifecycle root for any issue key (UUID or Linear
 * identifier). `extraAliases` lets a caller contribute a fresh Linear
 * lookup's `{id, identifier}` pair (the D entry already fetches one).
 */
export function resolveLifecycleRootKey(
	store: LifecycleRootStore,
	issueKey: string,
	extraAliases: string[] = [],
): LifecycleRootResolution {
	const closure = new Set<string>();
	let frontier = [issueKey, ...extraAliases].filter(Boolean);
	for (const k of frontier) closure.add(k);

	for (let round = 0; round < MAX_CLOSURE_ROUNDS; round++) {
		const next = new Set<string>();

		// (1) alias expansion via session rows (UUID ↔ identifier, both ways).
		for (const row of store.getSessionsForIssueAliases(frontier)) {
			for (const k of [row.issue_id, row.issue_identifier]) {
				if (k && !closure.has(k)) {
					closure.add(k);
					next.add(k);
				}
			}
		}

		// (2) QA-child fold: any key in the frontier that is a trusted auto-QA
		// child's issue joins the PARENT's key family.
		for (const rec of store.findAutoQaRecordsByQaIssueKeys(frontier)) {
			const parentKeys: Array<string | null | undefined> = [rec.issue_id];
			const parent = store.getSession(rec.parent_execution_id);
			if (parent) {
				parentKeys.push(parent.issue_id, parent.issue_identifier);
			}
			for (const k of parentKeys) {
				if (k && !closure.has(k)) {
					closure.add(k);
					next.add(k);
				}
			}
		}

		if (next.size === 0) break;
		frontier = [...next];
	}

	const aliasKeys = [...closure].sort();
	const uuids = aliasKeys.filter(isUuidKey);

	const soleUuid = uuids.length === 1 ? uuids[0] : undefined;
	if (soleUuid) {
		return { ok: true, rootKey: soleUuid, lockKeys: [soleUuid], aliasKeys };
	}
	if (uuids.length === 0) {
		return {
			ok: false,
			reason: "no_uuid_mapping",
			lockKeys: aliasKeys,
			aliasKeys,
		};
	}
	// Two distinct UUIDs in one closure. The ONLY legitimate multi-UUID family
	// is parent + Bridge-created QA child — but then the child must have been
	// folded via auto_qa_record, and the PARENT uuid is the root. Detect that
	// narrow case: exactly the set {parent uuid} ∪ {qa child uuids all owned by
	// records pointing at that parent}.
	const qaChildUuids = new Set<string>();
	for (const rec of store.findAutoQaRecordsByQaIssueKeys(aliasKeys)) {
		// rec.issue_id is the PARENT-side issue id on the auto_qa_record row.
		for (const u of uuids) {
			if (u !== rec.issue_id) qaChildUuids.add(u);
		}
	}
	const parentCandidates = uuids.filter((u) => {
		// a uuid is a parent candidate if it is NOT itself a QA child key
		const asChild = store.findAutoQaRecordsByQaIssueKeys([u]);
		return asChild.length === 0;
	});
	const soleParent =
		parentCandidates.length === 1 ? parentCandidates[0] : undefined;
	if (soleParent) {
		return {
			ok: true,
			rootKey: soleParent,
			lockKeys: [soleParent],
			aliasKeys,
		};
	}
	return { ok: false, reason: "uuid_conflict", lockKeys: uuids, aliasKeys };
}
