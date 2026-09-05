import { describe, expect, it } from "vitest";
import { label } from "../labels.js";

describe("epic-page labels", () => {
	it("is the single renderer vocabulary source and expands parameters", () => {
		expect(label("section.what")).toBe("要做的事");
		expect(label("page.decided_rule_note", { rule: "ready.v1" })).toBe(
			"已获 founder 裁定的规则 ready.v1",
		);
	});

	it("fails loudly for an unknown key or missing parameter", () => {
		expect(() => label("unknown" as never)).toThrow(/unknown/i);
		expect(() => label("page.default_rule_note")).toThrow(/parameter/i);
	});

	it("owns the complete dependency review vocabulary", () => {
		expect(label("section.review")).toBe("依赖需要减法的地方");
		expect(
			label("review.canceled_blocker", { item: "FLY-2", blocker: "FLY-1" }),
		).toBe("FLY-2 还在等已取消的 FLY-1 —— 删这条边,或改指别的单");
		expect(label("review.cycle", { members: "FLY-1、FLY-2" })).toBe(
			"FLY-1、FLY-2 互相等,谁都不会开始 —— 至少删一条边",
		);
		expect(label("review.all_blocked", { n: 2 })).toBe(
			"2 件没做完、0 件能开始 —— 下面是它们各自在等的边,逐条判断:等它做完,还是删边",
		);
		expect(
			label("review.blocking_edge", {
				blocked: "FLY-2",
				blocker: "GEO-1",
				state: "started",
				scope: "(范围外)",
			}),
		).toBe("FLY-2 在等 GEO-1(状态:started(范围外))");
		expect(label("review.blocking_edges_truncated")).toBe("…只列前 50 条");
		expect(label("review.none")).toContain("不代表没有该减的边");
		expect(label("cell.dependency_review")).toBe("依赖审阅");
	});
});
