import { describe, expect, it } from "vitest";
import { AuditSidecar, decodeAuditSidecar } from "../audit-sidecar.js";

describe("audit sidecar", () => {
	it("interns repeated strings and round-trips complete cells and view arrays", () => {
		const audit = new AuditSidecar();
		const cell = {
			value: { key: 3, list: [null, false, "repeat"] },
			observed_at: "repeat",
			provenance: {
				kind: "derived",
				rule: "counts.v1",
				from: ["/items/1/state", "/items/2/state"],
			},
		};
		const id = audit.add(cell);
		expect(audit.add(structuredClone(cell))).toBe(id);
		const view = {
			rule: "view.order.v1",
			from: ["/items/1/state"],
			observedAt: "repeat",
		};
		const viewId = audit.add(view);
		const data = JSON.parse(audit.json());
		expect(data.strings.filter((v: string) => v === "repeat")).toHaveLength(1);
		expect(decodeAuditSidecar(audit.json())[Number(id)]).toEqual(cell);
		expect(decodeAuditSidecar(audit.json())[Number(viewId)]).toEqual(view);
		expect(audit.count).toBe(2);
	});
	it("preserves hostile text and object keys without prototype mutation", () => {
		const audit = new AuditSidecar();
		const value = JSON.parse(
			'{"__proto__":{"x":"</script>"},"constructor":"text"}',
		);
		audit.add(value);
		expect(decodeAuditSidecar(audit.json())).toEqual([value]);
		expect(({} as { x?: string }).x).toBeUndefined();
	});
});
