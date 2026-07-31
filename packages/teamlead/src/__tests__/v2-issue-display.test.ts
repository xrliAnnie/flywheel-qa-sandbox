import { describe, expect, it } from "vitest";
import {
	applyV2TitleBadge,
	computeV2DisplayFingerprint,
	deriveV2IssueTitleBadge,
	deriveV2TaskDisplayState,
	renderV2PipelineHeader,
	V2_KIND_BADGE,
	type V2IssueDisplaySnapshot,
	type V2TaskDisplayView,
	v2KindLabel,
	v2RunnerTmuxSessionName,
	v2WindowMatchesIssue,
} from "../v2-issue-display.js";

function task(over: Partial<V2TaskDisplayView>): V2TaskDisplayView {
	return {
		taskId: "task:aaaa",
		kind: "implement",
		state: "ready",
		attemptCount: 0,
		...over,
	};
}

function snapshot(
	over: Partial<V2IssueDisplaySnapshot>,
): V2IssueDisplaySnapshot {
	return { issueId: "FLY-1549", tasks: [], ...over };
}

describe("deriveV2TaskDisplayState (plan §2a, every row pinned)", () => {
	it("draft → pending", () => {
		expect(deriveV2TaskDisplayState(task({ state: "draft" }))).toBe("pending");
	});
	it("ready with no attempt ever → pending", () => {
		expect(
			deriveV2TaskDisplayState(task({ state: "ready", attemptCount: 0 })),
		).toBe("pending");
	});
	it("ready with a prior attempt (rework/reap re-queue) → active — FLY-543 rollback semantics", () => {
		expect(
			deriveV2TaskDisplayState(task({ state: "ready", attemptCount: 2 })),
		).toBe("active");
	});
	it("running → active", () => {
		expect(deriveV2TaskDisplayState(task({ state: "running" }))).toBe("active");
	});
	it("review (schema state, engine not writing yet) → active, conservative", () => {
		expect(deriveV2TaskDisplayState(task({ state: "review" }))).toBe("active");
	});
	it("done → done", () => {
		expect(deriveV2TaskDisplayState(task({ state: "done" }))).toBe("done");
	});
	it("blocked → blocked", () => {
		expect(deriveV2TaskDisplayState(task({ state: "blocked" }))).toBe(
			"blocked",
		);
	});
	it("canceled → blocked", () => {
		expect(deriveV2TaskDisplayState(task({ state: "canceled" }))).toBe(
			"blocked",
		);
	});
	it("unknown future state with a session → active, conservative", () => {
		expect(deriveV2TaskDisplayState(task({ state: "weird" }))).toBe("active");
	});
});

describe("deriveV2IssueTitleBadge (plan §2b precedence)", () => {
	const design = (state: string, attempts = 1) =>
		task({ taskId: "t:design", kind: "design", state, attemptCount: attempts });
	const implement = (state: string, attempts = 1) =>
		task({
			taskId: "t:impl",
			kind: "implement",
			state,
			attemptCount: attempts,
		});
	const qa = (state: string, attempts = 1) =>
		task({ taskId: "t:qa", kind: "qa", state, attemptCount: attempts });

	it("closure done → ✅完成 (terminal, never 进行中)", () => {
		expect(
			deriveV2IssueTitleBadge(
				snapshot({
					tasks: [design("done"), implement("done"), qa("done")],
					closure: "done",
				}),
			),
		).toBe("✅完成");
	});
	it("gate settled → ✅完成 even before closure runs", () => {
		expect(
			deriveV2IssueTitleBadge(
				snapshot({
					tasks: [design("done"), implement("done"), qa("done")],
					gate: { state: "approved", settled: true },
				}),
			),
		).toBe("✅完成");
	});
	it("closure failed → 🔴受阻", () => {
		expect(
			deriveV2IssueTitleBadge(
				snapshot({
					tasks: [design("done"), implement("done"), qa("done")],
					closure: "failed",
				}),
			),
		).toBe("🔴受阻");
	});
	it("closure failed OUTRANKS gate.settled — closure only runs after settle (Codex design R1 #2)", () => {
		expect(
			deriveV2IssueTitleBadge(
				snapshot({
					tasks: [design("done"), implement("done"), qa("done")],
					gate: { state: "approved", settled: true },
					closure: "failed",
				}),
			),
		).toBe("🔴受阻");
	});
	it("all done + expired gate (ship retry exhaustion) → 🔴受阻 (Codex design R1 #2)", () => {
		expect(
			deriveV2IssueTitleBadge(
				snapshot({
					tasks: [design("done"), implement("done"), qa("done")],
					gate: { state: "expired", settled: false },
				}),
			),
		).toBe("🔴受阻");
	});
	it("rework-expired gate never blocks: tasks are back at ready → task-active badge wins", () => {
		expect(
			deriveV2IssueTitleBadge(
				snapshot({
					tasks: [design("done"), implement("ready", 2), qa("draft", 0)],
					gate: { state: "expired", settled: false },
				}),
			),
		).toBe("🔨实现");
	});
	it("any blocked task → 🔴受阻", () => {
		expect(
			deriveV2IssueTitleBadge(
				snapshot({
					tasks: [design("done"), implement("blocked"), qa("draft")],
				}),
			),
		).toBe("🔴受阻");
	});
	it("all done + open gate → 📬待批", () => {
		expect(
			deriveV2IssueTitleBadge(
				snapshot({
					tasks: [design("done"), implement("done"), qa("done")],
					gate: { state: "open", settled: false },
				}),
			),
		).toBe("📬待批");
	});
	it("all done + approved-not-settled gate → 📬待批", () => {
		expect(
			deriveV2IssueTitleBadge(
				snapshot({
					tasks: [design("done"), implement("done"), qa("done")],
					gate: { state: "approved", settled: false },
				}),
			),
		).toBe("📬待批");
	});
	it("all done + rejected gate (pre-rework instant) → 🔴受阻", () => {
		expect(
			deriveV2IssueTitleBadge(
				snapshot({
					tasks: [design("done"), implement("done"), qa("done")],
					gate: { state: "rejected", settled: false },
				}),
			),
		).toBe("🔴受阻");
	});
	it("design running → 🎨设计", () => {
		expect(
			deriveV2IssueTitleBadge(
				snapshot({
					tasks: [design("running"), implement("draft"), qa("draft")],
				}),
			),
		).toBe("🎨设计");
	});
	it("LAST active in topo order wins: qa FAIL rework wakes implement → title rolls BACK to 🔨实现, not ✅", () => {
		// rework put implement back to ready (with prior attempts); qa was
		// reverted to draft/ready. The most-advanced ACTIVE node is implement.
		expect(
			deriveV2IssueTitleBadge(
				snapshot({
					tasks: [design("done"), implement("ready", 2), qa("ready", 1)],
				}),
			),
		).toBe("🧪QA");
		// qa never attempted → only implement is active:
		expect(
			deriveV2IssueTitleBadge(
				snapshot({
					tasks: [design("done"), implement("ready", 2), qa("draft", 0)],
				}),
			),
		).toBe("🔨实现");
	});
	it("handoff gap (no active): badge = node before the first pending", () => {
		expect(
			deriveV2IssueTitleBadge(
				snapshot({ tasks: [design("done"), implement("draft"), qa("draft")] }),
			),
		).toBe("🎨设计");
	});
	it("all pending → first node badge", () => {
		expect(
			deriveV2IssueTitleBadge(
				snapshot({
					tasks: [design("draft", 0), implement("draft"), qa("draft")],
				}),
			),
		).toBe("🎨设计");
	});
	it("all done, no gate yet → last node badge", () => {
		expect(
			deriveV2IssueTitleBadge(
				snapshot({ tasks: [design("done"), implement("done"), qa("done")] }),
			),
		).toBe("🧪QA");
	});
	it("single generic node running → 🔨实现 (generic maps to the implement badge)", () => {
		expect(
			deriveV2IssueTitleBadge(
				snapshot({ tasks: [task({ kind: "generic", state: "running" })] }),
			),
		).toBe("🔨实现");
	});
	it("unknown kind falls back to 🔨<kind>", () => {
		expect(
			deriveV2IssueTitleBadge(
				snapshot({ tasks: [task({ kind: "mystery", state: "running" })] }),
			),
		).toBe("🔨mystery");
	});
	it("no tasks → null (face A noop)", () => {
		expect(deriveV2IssueTitleBadge(snapshot({}))).toBeNull();
	});
});

describe("applyV2TitleBadge (strip + restamp, zero churn)", () => {
	it("stamps a badge onto a bare v2 thread name", () => {
		expect(applyV2TitleBadge("[FLY-1549]", "🔨实现")).toBe("🔨实现 [FLY-1549]");
	});
	it("replaces an existing badge instead of stacking", () => {
		expect(applyV2TitleBadge("🎨设计 [FLY-1549]", "🧪QA")).toBe(
			"🧪QA [FLY-1549]",
		);
	});
	it("is idempotent — restamping the same badge yields the same name", () => {
		const once = applyV2TitleBadge("[FLY-1549]", "✅完成");
		expect(applyV2TitleBadge(once, "✅完成")).toBe(once);
	});
	it("preserves a founder-customized suffix after the [KEY]", () => {
		expect(applyV2TitleBadge("🔴受阻 [FLY-1549] 自定义标题", "✅完成")).toBe(
			"✅完成 [FLY-1549] 自定义标题",
		);
	});
	it("a fully custom name without [ is preserved as the base", () => {
		expect(applyV2TitleBadge("我的自定义thread", "🔨实现")).toBe(
			"🔨实现 我的自定义thread",
		);
	});
	it("a founder prefix BEFORE the [KEY] survives — only self-managed badges strip (Codex design R1 #6)", () => {
		expect(applyV2TitleBadge("URGENT [FLY-1549] 标题", "🔨实现")).toBe(
			"🔨实现 URGENT [FLY-1549] 标题",
		);
	});
	it("a fallback badge (🔨<kind>) strips cleanly on restamp when it is a self badge", () => {
		const selfBadges = new Set(["🔨mystery"]);
		const once = applyV2TitleBadge("[FLY-1549]", "🔨mystery", selfBadges);
		expect(once).toBe("🔨mystery [FLY-1549]");
		expect(applyV2TitleBadge(once, "✅完成", selfBadges)).toBe(
			"✅完成 [FLY-1549]",
		);
	});
	it("a founder token starting with a badge emoji is NOT stripped (Codex design R2 #3)", () => {
		expect(applyV2TitleBadge("✅P0 [FLY-1549] 标题", "🔨实现")).toBe(
			"🔨实现 ✅P0 [FLY-1549] 标题",
		);
	});
	it("composition respects the 100-char thread-name budget", () => {
		const long = `[FLY-1549] ${"标".repeat(120)}`;
		const stamped = applyV2TitleBadge(long, "🔨实现");
		expect(Array.from(stamped).length).toBeLessThanOrEqual(100);
		expect(stamped.startsWith("🔨实现 [FLY-1549]")).toBe(true);
	});
});

describe("v2 tmux naming (single source with the v2-host launcher)", () => {
	const ref = "v2dag:da54746c-2aff-4595-9c0a-07bcf2b6a005:1:3efeaf95";
	it("session name = v2- + sha256(sessionRef) first 32 hex chars", () => {
		const name = v2RunnerTmuxSessionName(ref);
		expect(name).toMatch(/^v2-[0-9a-f]{32}$/);
		expect(v2RunnerTmuxSessionName(ref)).toBe(name);
	});
	it("cross-wire guard: FLY-1550 workspace-title prefix passes, foreign identifier fails", () => {
		expect(
			v2WindowMatchesIssue("FLY-1549", "FLY-1549-runner-claude-Fable-v2-di"),
		).toBe(true);
		expect(
			v2WindowMatchesIssue("FLY-1549", "FLY-9999-runner-claude-Fable-other"),
		).toBe(false);
		// A shorter issue id must not prefix-match a longer one (trailing dash).
		expect(
			v2WindowMatchesIssue("FLY-154", "FLY-1549-runner-claude-Fable-v2-di"),
		).toBe(false);
	});
	it("cross-wire guard: pre-FLY-1550 launcher form keeps its links", () => {
		expect(
			v2WindowMatchesIssue("FLY-1549", "v2-FLY-1549-implement-ab12cd34"),
		).toBe(true);
		expect(
			v2WindowMatchesIssue("FLY-1549", "v2-FLY-9999-implement-ab12cd34"),
		).toBe(false);
	});
	it("missing anchors pass (no new false kills — PRD Step 3)", () => {
		expect(v2WindowMatchesIssue("FLY-1549", undefined)).toBe(true);
		expect(v2WindowMatchesIssue("FLY-1549", null)).toBe(true);
		expect(v2WindowMatchesIssue("", "whatever")).toBe(true);
	});
});

describe("renderV2PipelineHeader (face B snapshots, PRD vocabulary)", () => {
	it("three-stage mid-flight: done / active-with-attach / pending", () => {
		const content = renderV2PipelineHeader("FLY-1549", [
			{
				view: task({
					taskId: "t:design",
					kind: "design",
					state: "done",
					attemptCount: 1,
					attempt: {
						attemptId: "ab12cd34ffff",
						desiredState: "terminal",
						vendor: "claude",
					},
				}),
				state: "done",
			},
			{
				view: task({
					taskId: "t:impl",
					kind: "implement",
					state: "running",
					attemptCount: 1,
					attempt: {
						attemptId: "da54746cffff",
						desiredState: "started",
						vendor: "codex",
						sessionRef: "v2dag:da54746c:1:act",
					},
				}),
				state: "active",
				attach: { command: "env -u TMUX tmux attach -t '=v2-deadbeef'" },
			},
			{
				view: task({ taskId: "t:qa", kind: "qa", state: "draft" }),
				state: "pending",
			},
		]);
		expect(content).toMatchInlineSnapshot(`
			"📌 **[FLY-1549] v2 流水线**
			**[设计]** ✅ 完成 · attempt \`ab12cd34\` · claude
			**[实现]** ▶ 进行中 · attempt \`da54746c\` · codex
			\`env -u TMUX tmux attach -t '=v2-deadbeef'\`
			**[QA]** ◾ 未开始
			_自动更新:各节点状态与终端入口,置顶一条看全。_"
		`);
	});
	it("active row with unresolved terminal degrades to 终端待解析 (cross-wire / no tmux)", () => {
		const content = renderV2PipelineHeader("FLY-1549", [
			{
				view: task({
					taskId: "t:impl",
					kind: "generic",
					state: "running",
					attemptCount: 1,
					attempt: { attemptId: "da54746cffff", desiredState: "started" },
				}),
				state: "active",
				attach: { unresolved: true },
			},
		]);
		expect(content).toContain("**[实现]** ▶ 进行中 · attempt `da54746c`");
		expect(content).toContain("_(终端待解析)_");
		expect(content).not.toContain("tmux attach");
	});
	it("rows render the FLY-1255 vendor-neutral model marker when the model is known (lead pointer)", () => {
		const content = renderV2PipelineHeader("FLY-1549", [
			{
				view: task({
					taskId: "t:design",
					kind: "design",
					state: "done",
					attemptCount: 1,
					attempt: {
						attemptId: "ab12cd34ffff",
						desiredState: "terminal",
						vendor: "claude",
						model: "claude-fable-5",
					},
				}),
				state: "done",
			},
			{
				view: task({
					taskId: "t:impl",
					kind: "implement",
					state: "running",
					attemptCount: 1,
					attempt: {
						attemptId: "da54746cffff",
						desiredState: "started",
						vendor: "codex",
						model: "gpt-5.6-sol",
					},
				}),
				state: "active",
			},
		]);
		expect(content).toContain("**[设计]** ✅ 完成 · attempt `ab12cd34` · F");
		expect(content).toContain("**[实现]** ▶ 进行中 · attempt `da54746c` · G");
		// No model recorded → honest vendor fallback (pinned by the other
		// header snapshots that pass vendor only).
	});
	it("blocked row renders 🔴 受阻", () => {
		const content = renderV2PipelineHeader("FLY-1549", [
			{
				view: task({
					taskId: "t:qa",
					kind: "qa",
					state: "blocked",
					attemptCount: 1,
					attempt: {
						attemptId: "ab12cd34ffff",
						desiredState: "terminal",
						terminalReason: "failed",
					},
				}),
				state: "blocked",
			},
		]);
		expect(content).toContain("**[QA]** 🔴 受阻 · attempt `ab12cd34`");
	});
	it("a 500-task legal DAG stays within one Discord message (Codex design R1 #5)", () => {
		const rows = Array.from({ length: 500 }, (_, index) => ({
			view: task({
				taskId: `t:${index}`,
				kind: "generic",
				state: index === 250 ? "running" : index < 250 ? "done" : "draft",
				attemptCount: index <= 250 ? 1 : 0,
				attempt:
					index <= 250
						? {
								attemptId: `attempt-${index}00000000`,
								desiredState: "terminal",
							}
						: undefined,
			}),
			state: (index === 250 ? "active" : index < 250 ? "done" : "pending") as
				| "active"
				| "done"
				| "pending",
			...(index === 250
				? { attach: { command: "env -u TMUX tmux attach -t '=v2-x'" } }
				: {}),
		}));
		const content = renderV2PipelineHeader("FLY-1549", rows);
		expect(content.length).toBeLessThanOrEqual(1900);
		// The active row (founder's attention) always survives the collapse.
		expect(content).toContain("▶ 进行中");
		expect(content).toContain("tmux attach");
		// The folded tail is counted, not dropped silently.
		expect(content).toMatch(/…另 \d+ 节点/);
	});
	it("500 ACTIVE nodes: total, truthful, within budget — overflow folds to ▶ counts (Codex design R2 #2)", () => {
		const rows = Array.from({ length: 500 }, (_, index) => ({
			view: task({
				taskId: `t:${index}`,
				kind: "generic",
				state: "running",
				attemptCount: 1,
				attempt: {
					attemptId: `attempt-${index}00000000`,
					desiredState: "started",
				},
			}),
			state: "active" as const,
			attach: { command: `env -u TMUX tmux attach -t '=v2-${index}'` },
		}));
		const content = renderV2PipelineHeader("FLY-1549", rows);
		expect(content.length).toBeLessThanOrEqual(1900);
		// Topo-first actives keep full blocks (attach included)…
		expect(content).toContain("env -u TMUX tmux attach -t '=v2-0'");
		// …and the folded remainder is COUNTED, never silently dropped.
		const match = content.match(/…另 (\d+) 节点:▶×(\d+)/);
		expect(match).not.toBeNull();
		const shown = (content.match(/▶ 进行中/g) ?? []).length;
		expect(shown + Number(match?.[2])).toBe(500);
	});
	it("an unbounded kind label is clamped for display", () => {
		const content = renderV2PipelineHeader("FLY-1549", [
			{
				view: task({
					taskId: "t:x",
					kind: "x".repeat(80),
					state: "running",
					attemptCount: 1,
					attempt: { attemptId: "aaaabbbbcccc", desiredState: "started" },
				}),
				state: "active",
			},
		]);
		expect(content).toContain("…]");
		expect(content).not.toContain("x".repeat(30));
	});
	it("terminal all-done header leaves no 进行中 (PRD finalize contract)", () => {
		const content = renderV2PipelineHeader("FLY-1549", [
			{
				view: task({
					taskId: "a",
					kind: "design",
					state: "done",
					attemptCount: 1,
				}),
				state: "done",
			},
			{
				view: task({
					taskId: "b",
					kind: "implement",
					state: "done",
					attemptCount: 1,
				}),
				state: "done",
			},
			{
				view: task({ taskId: "c", kind: "qa", state: "done", attemptCount: 1 }),
				state: "done",
			},
		]);
		expect(content).not.toContain("进行中");
		expect(content).not.toContain("未开始");
		expect(content.match(/✅ 完成/g)).toHaveLength(3);
	});
});

describe("kind vocabulary", () => {
	it("known kinds map to the locked badges (PHASE_THREAD_BADGE reuse for the trio)", () => {
		expect(V2_KIND_BADGE.design).toBe("🎨设计");
		expect(V2_KIND_BADGE.implement).toBe("🔨实现");
		expect(V2_KIND_BADGE.qa).toBe("🧪QA");
		expect(V2_KIND_BADGE.generic).toBe("🔨实现");
		expect(V2_KIND_BADGE.research).toBe("🧠调研");
	});
	it("labels strip the emoji", () => {
		expect(v2KindLabel("design")).toBe("设计");
		expect(v2KindLabel("qa")).toBe("QA");
		expect(v2KindLabel("mystery")).toBe("mystery");
	});
});

describe("computeV2DisplayFingerprint", () => {
	const base = snapshot({
		tasks: [
			task({
				taskId: "t:impl",
				kind: "implement",
				state: "running",
				attemptCount: 1,
				attempt: {
					attemptId: "da54746c",
					desiredState: "started",
					sessionRef: "v2dag:x:1:y",
				},
			}),
		],
		gate: { state: "open", pr: 123, head: "abc", settled: false },
		closure: undefined,
	});
	it("is stable for identical snapshots", () => {
		expect(computeV2DisplayFingerprint(base, { s1: "w1" })).toBe(
			computeV2DisplayFingerprint(base, { s1: "w1" }),
		);
	});
	it("changes when task state changes", () => {
		const done = {
			...base,
			tasks: [{ ...base.tasks[0], state: "done" }],
		} as V2IssueDisplaySnapshot;
		expect(computeV2DisplayFingerprint(done, { s1: "w1" })).not.toBe(
			computeV2DisplayFingerprint(base, { s1: "w1" }),
		);
	});
	it("changes when the tmux probe result changes (late window registration drift)", () => {
		expect(computeV2DisplayFingerprint(base, { s1: null })).not.toBe(
			computeV2DisplayFingerprint(base, { s1: "w1" }),
		);
	});
	it("changes when the gate settles", () => {
		const settled = {
			...base,
			gate: { ...(base.gate ?? { state: "approved" }), settled: true },
		} as V2IssueDisplaySnapshot;
		expect(computeV2DisplayFingerprint(settled, {})).not.toBe(
			computeV2DisplayFingerprint(base, {}),
		);
	});
});
