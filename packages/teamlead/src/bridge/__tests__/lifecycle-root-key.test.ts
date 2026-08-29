/** FLY-1185 §2.12 — canonical lifecycle-root key resolution tests (R10#2/R11#2). */

import { describe, expect, it } from "vitest";
import {
	isUuidKey,
	type LifecycleRootStore,
	resolveLifecycleRootKey,
} from "../lifecycle-root-key.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_QA = "22222222-2222-4222-8222-222222222222";
const UUID_OTHER = "33333333-3333-4333-8333-333333333333";

function makeStore(opts: {
	sessions?: Array<{
		execution_id: string;
		issue_id: string;
		issue_identifier: string | null;
	}>;
	qaRecords?: Array<{
		parent_execution_id: string;
		issue_id: string;
		qaKeys: string[];
	}>;
}): LifecycleRootStore {
	const sessions = opts.sessions ?? [];
	const qaRecords = opts.qaRecords ?? [];
	return {
		getSessionsForIssueAliases: (keys) =>
			sessions.filter(
				(s) =>
					keys.includes(s.issue_id) ||
					(s.issue_identifier !== null && keys.includes(s.issue_identifier)),
			),
		findAutoQaRecordsByQaIssueKeys: (keys) =>
			qaRecords
				.filter((r) => r.qaKeys.some((k) => keys.includes(k)))
				.map((r) => ({
					parent_execution_id: r.parent_execution_id,
					issue_id: r.issue_id,
				})),
		getSession: (executionId) => {
			const s = sessions.find((x) => x.execution_id === executionId);
			return s
				? { issue_id: s.issue_id, issue_identifier: s.issue_identifier }
				: undefined;
		},
	};
}

describe("isUuidKey", () => {
	it("accepts UUIDs and rejects identifiers", () => {
		expect(isUuidKey(UUID_A)).toBe(true);
		expect(isUuidKey("FLY-1185")).toBe(false);
		expect(isUuidKey("")).toBe(false);
	});
});

describe("resolveLifecycleRootKey", () => {
	it("identifier and UUID alias resolve to the SAME root (identifier-key A vs UUID-key D)", () => {
		const store = makeStore({
			sessions: [
				{ execution_id: "e1", issue_id: UUID_A, issue_identifier: "FLY-1185" },
			],
		});
		const byIdent = resolveLifecycleRootKey(store, "FLY-1185");
		const byUuid = resolveLifecycleRootKey(store, UUID_A);
		expect(byIdent.ok).toBe(true);
		expect(byUuid.ok).toBe(true);
		if (byIdent.ok && byUuid.ok) {
			expect(byIdent.rootKey).toBe(UUID_A);
			expect(byUuid.rootKey).toBe(UUID_A);
			expect(byIdent.aliasKeys).toContain("FLY-1185");
		}
	});

	it("a trusted auto-QA child folds into the PARENT root (parent-A vs child-D share one lock)", () => {
		const store = makeStore({
			sessions: [
				{ execution_id: "p1", issue_id: UUID_A, issue_identifier: "FLY-1185" },
				{ execution_id: "q1", issue_id: UUID_QA, issue_identifier: "FLY-1200" },
			],
			qaRecords: [
				{
					parent_execution_id: "p1",
					issue_id: UUID_A,
					qaKeys: [UUID_QA, "FLY-1200"],
				},
			],
		});
		const byChild = resolveLifecycleRootKey(store, UUID_QA);
		const byParent = resolveLifecycleRootKey(store, UUID_A);
		expect(byChild.ok).toBe(true);
		expect(byParent.ok).toBe(true);
		if (byChild.ok && byParent.ok) {
			expect(byChild.rootKey).toBe(UUID_A);
			expect(byParent.rootKey).toBe(UUID_A);
		}
	});

	it("no UUID mapping anywhere → fail-closed (ok:false) with full lockKeys", () => {
		const store = makeStore({ sessions: [] });
		const res = resolveLifecycleRootKey(store, "FLY-9999");
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.reason).toBe("no_uuid_mapping");
			expect(res.lockKeys).toEqual(["FLY-9999"]);
		}
	});

	it("extraAliases (fresh Linear lookup) supply the UUID for a thread-only residue", () => {
		const store = makeStore({ sessions: [] });
		const res = resolveLifecycleRootKey(store, "FLY-9999", [
			UUID_A,
			"FLY-9999",
		]);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.rootKey).toBe(UUID_A);
	});

	it("two unrelated UUIDs in one closure → uuid_conflict, multi-lock keys sorted, never a single child lock", () => {
		// Pathological alias row that bridges two distinct UUID families.
		const store = makeStore({
			sessions: [
				{ execution_id: "e1", issue_id: UUID_A, issue_identifier: "FLY-1" },
				{ execution_id: "e2", issue_id: UUID_OTHER, issue_identifier: "FLY-1" },
			],
		});
		const res = resolveLifecycleRootKey(store, "FLY-1");
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.reason).toBe("uuid_conflict");
			expect(res.lockKeys).toEqual([UUID_A, UUID_OTHER].sort());
			expect(res.lockKeys.length).toBeGreaterThan(1);
		}
	});
});
