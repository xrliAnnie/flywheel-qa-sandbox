import { describe, expect, it } from "vitest";
import {
	DEPENDENCY_LEDGER_PREFIX,
	KIND_ACTION_MATRIX,
	LEDGER_ACTIONS,
	LEDGER_COMMENT_KEYS,
	LEDGER_EVIDENCE,
	LEDGER_KINDS,
	LEDGER_MACHINE_LINE_PREFIX,
	OPERATION_ID_RE,
} from "../index.js";

describe("dependency ledger contract", () => {
	it("exports the fixed comment format and exact vocabularies", () => {
		expect(DEPENDENCY_LEDGER_PREFIX).toBe("[dependency-ledger]");
		expect(LEDGER_MACHINE_LINE_PREFIX).toBe("dl1:");
		expect(LEDGER_KINDS).toEqual(["missed", "not_needed", "discovered"]);
		expect(LEDGER_ACTIONS).toEqual(["added", "removed"]);
		expect(LEDGER_EVIDENCE).toEqual(["mutation", "state", "lead_ack"]);
		expect(KIND_ACTION_MATRIX).toEqual({
			missed: "added",
			not_needed: "removed",
			discovered: "added",
		});
	});

	it("accepts only lowercase UUID v4 operation IDs", () => {
		expect(OPERATION_ID_RE.test("40b90faf-8d07-4a26-8109-145a61819a4f")).toBe(
			true,
		);
		expect(OPERATION_ID_RE.test("40B90FAF-8D07-4A26-8109-145A61819A4F")).toBe(
			false,
		);
		expect(OPERATION_ID_RE.test("40b90faf-8d07-5a26-8109-145a61819a4f")).toBe(
			false,
		);
	});

	it("lists the exact machine comment key set", () => {
		expect(LEDGER_COMMENT_KEYS).toEqual([
			"v",
			"op",
			"parent_op",
			"relation_id",
			"evidence",
			"kind",
			"action",
			"blocker",
			"blocked",
			"claimed_actor",
			"at",
			"reason",
		]);
	});
});
