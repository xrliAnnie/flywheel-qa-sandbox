import { describe, expect, it } from "vitest";
import { AuditDictionary } from "../audit-dictionary.js";
import type { Cell } from "../model.js";

const cell: Cell<string> = {
	value: "text",
	observed_at: "2026-09-10T00:00:00Z",
	source_updated_at: "2026-09-09T00:00:00Z",
	provenance: {
		kind: "linear",
		entity: "issue",
		id: "issue-1",
		field: "title",
	},
};
describe("lossless audit dictionary", () => {
	it("shares sources and timestamps while retaining each cell reference", () => {
		const dictionary = new AuditDictionary();
		const first = dictionary.add(cell);
		expect(dictionary.add(structuredClone(cell))).toBe(first);
		const later = { ...cell, observed_at: "2026-09-10T01:00:00Z" };
		const second = dictionary.add(later);
		expect(second).not.toBe(first);
		const data = dictionary.data();
		expect(data.sources).toEqual([cell.provenance]);
		expect(data.times).toEqual([
			cell.observed_at,
			cell.source_updated_at,
			later.observed_at,
		]);
		expect(data.cells[Number(first)]).toEqual([0, 0, 1]);
		expect(data.cells[Number(second)]).toEqual([0, 2, 1]);
	});
	it("encodes inert JSON without losing hostile source text or pointer ordering", () => {
		const dictionary = new AuditDictionary();
		const hostile = {
			...cell,
			provenance: {
				kind: "derived" as const,
				rule: "ready.v1" as const,
				from: ["/items/2/state", "</script><img src=x onerror=alert(1)>"],
			},
		};
		dictionary.add(hostile);
		const json = dictionary.json();
		expect(json).not.toContain("<");
		expect(JSON.parse(json).sources).toEqual([hostile.provenance]);
		expect(dictionary.json()).toBe(json);
	});
});
