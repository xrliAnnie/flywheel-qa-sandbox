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

	it("owns the liveness and freshness vocabulary", () => {
		expect(label("section.stuck")).toBe("卡住说了一声的");
		expect(label("section.waiting_founder")).toBe("在等 founder 的");
		expect(label("page.signal_none")).toBe("无");
		expect(label("freshness.trigger.event")).toBe("事件触发");
		expect(label("freshness.trigger.scan")).toBe("到点扫描");
		expect(label("freshness.trigger.manual")).toBe("手动");
		expect(label("freshness.current")).toBe("本版");
		expect(label("freshness.last_generated")).toBe("上次成功生成");
		expect(label("freshness.last_published")).toBe("固定页上次成功发布");
		expect(
			label("freshness.failures", {
				n: 2,
				token: "publish-timeout",
				at: "2026-09-05T08:00:00.000Z",
			}),
		).toBe(
			"本版成功之前,上次成功发布之后失败 2 次,最近 publish-timeout @ 2026-09-05T08:00:00.000Z",
		);
		expect(label("freshness.next_scan")).toBe("下一次到点扫描预计");
		expect(label("freshness.oldest_source")).toBe("来源最旧观测");
		expect(
			label("freshness.hosted", {
				token8: "deadbeef",
				at: "2026-09-05T08:00:00.000Z",
			}),
		).toBe("固定页 deadbeef 上次发布 2026-09-05T08:00:00.000Z");
		expect(label("freshness.opened_age", { minutes: 7 })).toBe(
			"你打开时它已 7 分钟旧",
		);
		expect(label("signal.kind.declared_blocked")).toBe("IC 声明卡住");
		expect(label("signal.kind.runner_stopped", { reason: "quota" })).toBe(
			"runner 停机(quota)",
		);
		expect(label("signal.kind.question_pending")).toBe("有问题等 Lead 回");
		expect(label("signal.kind.run_held")).toBe("run 被 hold");
		expect(label("signal.kind.waiting_founder")).toBe("在等 founder");
		expect(
			label("tick.stuck_line", { n: 1, items: "FLY-2143(run_held,now)" }),
		).toBe("- 卡住说了一声的 1 张:FLY-2143(run_held,now)");
	});
});

const founderVocabulary = {
	"section.epics": "在做的 Epic",
	"section.epics_count": "{n} 个(全做完的不列;状态照抄 Linear)",
	"epic.hidden_done": "另有 {n} 个 Epic 全做完,不列",
	"epic.none": "范围内没有还没做完的 Epic",
	"epic.scope_unavailable": "Epic 范围不可用,这一版没有 Epic 卡",
	"epic.unattached": "没挂 Epic(取数时它的父单为空)",
	"counts.live": "{n} 在跑",
	"counts.waiting": "{n} 等依赖",
	"counts.free": "{n} 可起跑",
	"counts.idle": "{n} 未开始",
	"counts.total": "共 {n}",
	"counts.missing": "计数缺失:不认识状态类型 {type}",
	"epic.all_waiting": "整块在等 {blockers}",
	"epic.terminal_tail": "另有 {tail}(不列)",
	"child.live": "在跑",
	"child.waiting": "等 {blockers}",
	"child.free": "可起跑",
	"child.idle": "未开始",
	"child.unknown_type": "{state}(未知类型)",
	"blocker.outside": "(范围外)",
	"blocker.other_epic": "(在 {root})",
	"blocker.unattached": "(没挂 Epic)",
	"progress.live": "到「{node}」· 第 {attempt} 次 · 会话 {status}",
	"progress.live_no_run": "在跑(引擎还没报节点)",
	"progress.waiting": "被 {blockers} 挡着,没起跑",
	"progress.free": "原本等 {blockers},它已经做完了 —— 现在没人挡着",
	"progress.idle": "还没起跑",
	"progress.missing": "执行事实缺失:{reasons}",
	"progress.source": "机器测的",
	"section.lead_panel": "给 Lead 看的诊断(默认收起)",
	"audit.linear_issue": "Linear issue {id}",
	"audit.seen": "看到 {at}",
	"audit.source_updated": "源 {at}",
	"view.rule_note": "页面展示规则 {rule} · 由 {from} 推出 · 输入最新观测 {at}",
	"view.order_desc":
		"Epic 按 Linear 状态分组、组内按单号;子单 在跑 → 等依赖 → 可起跑 → 未开始、组内按单号",
	"audit.root_projection": "本 Epic 在「active 父单」格里的那一项",
} as const;

describe("founder rendering vocabulary", () => {
	it.each(Object.entries(founderVocabulary))(
		"renders %s with all parameters",
		(key, template) => {
			const params = {
				n: 2,
				type: "future",
				blockers: "FLY-1",
				tail: "1 张已完成",
				state: "Future",
				root: "FLY-100",
				node: "实现",
				attempt: 2,
				status: "running",
				reasons: "statestore_error",
				id: "abc",
				at: "2026-09-10T00:00:00Z",
				rule: "view.progress.v1",
				from: "/items/0/run",
			};
			const expected = template.replace(
				/\{(\w+)\}/g,
				(_, name: keyof typeof params) => String(params[name]),
			);
			expect(label(key as keyof typeof founderVocabulary, params)).toBe(
				expected,
			);
		},
	);
	it("requires blockers for the waiting badge", () => {
		expect(() => label("child.waiting")).toThrow(/parameter/i);
	});
	it("requires all display provenance parameters", () => {
		expect(() =>
			label("view.rule_note", {
				rule: "view.progress.v1",
				from: "/items/0/run",
			}),
		).toThrow(/parameter/i);
	});
});
