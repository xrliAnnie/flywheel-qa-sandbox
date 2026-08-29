/**
 * FLY-799 Part C — fan-out node collection (RED first).
 *
 * 甲 (Annie): no sub-issue tree — the finalization graph is just feature ↔ QA
 * (auto_qa_record). collectRelatedNodes returns the shipped runner + its QA
 * runner(s). isQaSafeToFinalize gates cleanup to already-PASS QA (Codex R1 #7:
 * never close a running/awaiting_retest/stuck QA on the parent's approval).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	collectRelatedNodes,
	isQaSafeToFinalize,
} from "../fanout-finalization.js";

describe("collectRelatedNodes", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("no QA → just the shipped root node", () => {
		const nodes = collectRelatedNodes(store, {
			rootExecutionId: "root",
			rootIssueId: "root-issue",
		});
		expect(nodes).toEqual([
			{ executionId: "root", issueId: "root-issue", role: "shipped" },
		]);
	});

	it("includes the QA runner from auto_qa_record", () => {
		store.claimAutoQaRecord({
			parentExecutionId: "root",
			targetPrHeadSha: "a".repeat(40),
			issueId: "root-issue",
			projectName: "proj",
		});
		store.setAutoQaQaExecutionId("root", "a".repeat(40), "qa-exec");

		const nodes = collectRelatedNodes(store, {
			rootExecutionId: "root",
			rootIssueId: "root-issue",
		});
		expect(nodes[0]).toEqual({
			executionId: "root",
			issueId: "root-issue",
			role: "shipped",
		});
		const qa = nodes.find((n) => n.role === "qa");
		expect(qa).toMatchObject({ executionId: "qa-exec", role: "qa" });
	});
});

describe("isQaSafeToFinalize", () => {
	it("only 'passed' is safe to finalize on the parent's approval", () => {
		expect(isQaSafeToFinalize("passed")).toBe(true);
		for (const s of [
			"running",
			"awaiting_retest",
			"failed",
			"stuck",
			"superseded",
		]) {
			expect(isQaSafeToFinalize(s)).toBe(false);
		}
	});
});
