import { describe, expect, it } from "vitest";
import {
	type ProgressLedger,
	parseProgress,
	renderProgress,
} from "../progress-schema.js";

/**
 * FLY-795: the shared progress.md ledger schema (795 owns; FLY-793 consumes on
 * phase handoff). Light ledger — cursor + chunk statuses + pointers only;
 * rationale stays in committed plan/exploration docs, NOT here.
 */
describe("progress-schema (FLY-795)", () => {
	const sample: ProgressLedger = {
		issue: "FLY-795",
		title: "restart-resilient runner",
		phase: "implement",
		phaseCursor: "3/5",
		nextStep: "wire the badge legacy strip entries",
		chunks: [
			{
				id: "c1",
				order: 1,
				deps: [],
				done: "schema round-trips",
				status: "done",
			},
			{
				id: "c2",
				order: 2,
				deps: ["c1"],
				done: "progress command commits path-limited",
				status: "doing",
			},
			{
				id: "c3",
				order: 3,
				deps: ["c2"],
				done: "resume mode suppresses",
				status: "todo",
			},
		],
		pointers: {
			plan: "engineering/doc/FLY-795-restart-resilient-resume/plan.md",
			exploration:
				"engineering/doc/FLY-795-restart-resilient-resume/exploration.md",
			pr: "#431",
			reviewedSha: "abc1234",
		},
		handoff: "impl→qa: PR #431 open, c1 done, c2 in progress",
	};

	it("round-trips render → parse with all fields preserved", () => {
		const md = renderProgress(sample);
		const back = parseProgress(md);
		expect(back.issue).toBe("FLY-795");
		expect(back.phase).toBe("implement");
		expect(back.phaseCursor).toBe("3/5");
		expect(back.nextStep).toBe("wire the badge legacy strip entries");
		expect(back.chunks).toHaveLength(3);
		expect(back.chunks[1]).toMatchObject({
			id: "c2",
			order: 2,
			deps: ["c1"],
			status: "doing",
		});
		expect(back.pointers.plan).toBe(sample.pointers.plan);
		expect(back.pointers.pr).toBe("#431");
		expect(back.handoff).toContain("impl→qa");
	});

	it("uses WorkflowPhaseRole values (design/implement/qa) for phase", () => {
		for (const phase of ["design", "implement", "qa"] as const) {
			const md = renderProgress({ ...sample, phase });
			expect(parseProgress(md).phase).toBe(phase);
		}
	});

	it("exposes the workflow cursor fields (phase + chunk statuses)", () => {
		// Each workflow node reads these at its boundary — the shared schema
		// must expose them structurally, not as free prose.
		const back = parseProgress(renderProgress(sample));
		const statuses = back.chunks.map((c) => c.status);
		expect(statuses).toEqual(["done", "doing", "todo"]);
		expect(back.phaseCursor).toMatch(/^\d+\/\d+$/);
	});

	it("renders a human-readable markdown body in addition to the machine header", () => {
		// progress.md is committed to the branch + read by humans in the PR diff.
		const md = renderProgress(sample);
		expect(md).toContain("FLY-795");
		// authoritative structured block is parseable regardless of the prose body
		expect(md).toMatch(/^---/);
	});

	it("tolerates a minimal ledger (only required fields)", () => {
		const minimal: ProgressLedger = {
			issue: "FLY-900",
			phase: "design",
			chunks: [],
			pointers: {},
		};
		const back = parseProgress(renderProgress(minimal));
		expect(back.issue).toBe("FLY-900");
		expect(back.phase).toBe("design");
		expect(back.chunks).toEqual([]);
	});

	it("parseProgress throws on a non-progress markdown blob (fail-loud)", () => {
		expect(() =>
			parseProgress("# just a random doc\n\nno frontmatter here"),
		).toThrow();
	});
});

/**
 * FLY-2901 §4.8-3: the takeover-rescue stand-in's FIRST progress write carries a
 * `rescue` pointer produced by `encodeRescuePointer()`
 * (packages/edge-worker/src/worktree-takeover-rescue.ts). The value is always
 * non-empty and contains spaces, colons, commas, slashes and '@' — it must
 * survive render → parse byte-for-byte, including the multi-ref shape (which is
 * longer than yaml's default fold width).
 */
describe("progress-schema rescue pointer (FLY-2901)", () => {
	const eventUid = "0123456789abcdef".repeat(4); // 64 hex
	const baseTip = "a".repeat(40);
	const dirtyTip = "b".repeat(40);
	const rescueSingle = `event:worktree_takeover_rescued:${eventUid}`;
	const rescueMulti =
		`${rescueSingle} refs:` +
		`flywheel-rescue/FLY-12/aaaa1111-bbbb2222-20260925T010203Z-base@${baseTip},` +
		`flywheel-rescue/FLY-12/aaaa1111-bbbb2222-20260925T010203Z-dirty@${dirtyTip}`;

	const base: ProgressLedger = {
		issue: "FLY-2901",
		phase: "implement",
		chunks: [],
		pointers: {},
	};

	it("round-trips the event-only rescue pointer byte-for-byte", () => {
		const md = renderProgress({
			...base,
			pointers: { rescue: rescueSingle },
		});
		expect(parseProgress(md).pointers.rescue).toBe(rescueSingle);
	});

	it("round-trips the multi-ref rescue pointer byte-for-byte (space/colon/comma/slash/@)", () => {
		expect(rescueMulti.length).toBeGreaterThan(80); // exceeds yaml fold width
		const md = renderProgress({
			...base,
			pointers: { plan: "engineering/doc/x/plan.md", rescue: rescueMulti },
		});
		const back = parseProgress(md);
		expect(back.pointers.rescue).toBe(rescueMulti);
		expect(back.pointers.plan).toBe("engineering/doc/x/plan.md");
	});

	it("keeps `rescue` but still drops an unknown pointer key on parse", () => {
		const md = [
			"---",
			"issue: FLY-2901",
			"phase: implement",
			"pointers:",
			`  rescue: ${rescueSingle}`,
			"  bogus: must-be-dropped",
			"---",
			"",
			"# body",
		].join("\n");
		const back = parseProgress(md);
		expect(back.pointers.rescue).toBe(rescueSingle);
		expect(back.pointers).not.toHaveProperty("bogus");
	});

	it("drops an empty `rescue` value on parse, exactly like every other pointer", () => {
		const md = renderProgress({
			...base,
			pointers: { pr: "", rescue: "" },
		});
		const back = parseProgress(md);
		expect(back.pointers.rescue).toBeUndefined();
		expect(back.pointers.pr).toBeUndefined();
	});
});
