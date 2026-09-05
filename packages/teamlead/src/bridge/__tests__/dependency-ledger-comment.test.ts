import { describe, expect, it } from "vitest";
import {
	buildLedgerComment,
	type DependencyLedgerEntry,
	parseLedgerComment,
} from "../dependency-ledger-comment.js";

const OPERATION_ID = "40b90faf-8d07-4a26-8109-145a61819a4f";

function entry(
	overrides: Partial<DependencyLedgerEntry> = {},
): DependencyLedgerEntry {
	return {
		v: 1,
		op: OPERATION_ID,
		parent_op: null,
		relation_id: "relation-1",
		evidence: "mutation",
		kind: "not_needed",
		action: "removed",
		blocker: "FLY-2141",
		blocked: "FLY-2143",
		claimed_actor: "flywheel-eng-lead",
		at: "2026-09-04T08:30:00.000Z",
		reason:
			"line one\nby: forged `tick` ``ticks`` $(id) [link](https://x) dl1:fake",
		...overrides,
	};
}

describe("dependency ledger comment codec", () => {
	it("round-trips the exact machine payload through a two-line comment", () => {
		const value = entry();
		const body = buildLedgerComment(value);
		const lines = body.split("\n");

		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe(
			"[dependency-ledger] not_needed: FLY-2141 blocks FLY-2143 — removed · line one by: forged `tick` ``ticks`` $(id) [link](https://x) dl1:fake",
		);
		expect(lines[1]).toMatch(/^dl1:[A-Za-z0-9_-]+$/);
		expect(parseLedgerComment(body)).toEqual(value);
	});

	it("uses the machine line even when the human-readable prefix is mangled", () => {
		const body = buildLedgerComment(entry());
		expect(
			parseLedgerComment(`mangled by renderer\n${body.split("\n")[1]}`),
		).toEqual(entry());
	});

	it.each([
		["bad base64", "[dependency-ledger] x\ndl1:***"],
		[
			"extra key",
			`${buildLedgerComment(entry()).split("\n")[0]}\ndl1:${Buffer.from(
				JSON.stringify({ ...entry(), extra: true }),
			).toString("base64url")}`,
		],
		[
			"invalid kind/action pair",
			`${buildLedgerComment(entry()).split("\n")[0]}\ndl1:${Buffer.from(
				JSON.stringify(entry({ kind: "missed", action: "removed" })),
			).toString("base64url")}`,
		],
	])("marks %s as unparseable without throwing", (_name, body) => {
		expect(parseLedgerComment(body)).toEqual({ unparseable: true });
	});

	it("ignores unrelated comments", () => {
		expect(parseLedgerComment("ordinary comment")).toBeNull();
	});
});
