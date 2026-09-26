import { describe, expect, it } from "vitest";
import {
	BrainCoordinator,
	type BrainSpeechRequest,
} from "../codex/BrainCoordinator.js";

class FakeClock {
	now = 0;
	private sequence = 0;
	private readonly timers = new Map<
		number,
		{ at: number; callback: () => void }
	>();

	schedule = (callback: () => void, delayMs: number): number => {
		const id = ++this.sequence;
		this.timers.set(id, { at: this.now + Math.max(0, delayMs), callback });
		return id;
	};

	cancel = (id: unknown): void => {
		this.timers.delete(id as number);
	};

	advance(ms: number): void {
		const target = this.now + ms;
		for (;;) {
			const next = [...this.timers.entries()]
				.filter(([, timer]) => timer.at <= target)
				.sort(
					(left, right) => left[1].at - right[1].at || left[0] - right[0],
				)[0];
			if (!next) break;
			this.now = next[1].at;
			this.timers.delete(next[0]);
			next[1].callback();
		}
		this.now = target;
	}
}

function harness() {
	const clock = new FakeClock();
	const queued: BrainSpeechRequest[] = [];
	const dropped: Array<{ businessId: string; kind: string }> = [];
	const coordinator = new BrainCoordinator({
		now: () => clock.now,
		schedule: clock.schedule,
		cancelScheduled: clock.cancel,
		speech: {
			enqueue: (request) => {
				queued.push(request);
				return Promise.resolve("spoken");
			},
			drop: (businessId, kind) => {
				dropped.push({ businessId, kind });
			},
		},
	});
	return { clock, coordinator, queued, dropped };
}

describe("BrainCoordinator", () => {
	it("attaches obligations to the active turn and speaks only segments the turn actually returned", () => {
		const h = harness();
		h.coordinator.turnStarted("turn-1");
		expect(
			h.coordinator.registerHandoff({
				handoffId: "h1",
				inputTranscript: "先查 FLY-2886",
			}),
		).toBe(true);
		expect(
			h.coordinator.registerHandoff({
				handoffId: "h2",
				inputTranscript: "再查 PR #1324",
			}),
		).toBe(true);

		h.coordinator.turnTerminal({
			turnId: "turn-1",
			outcome: "completed",
			spokenSegments: ["PR #1324 已通过。"],
		});

		expect(h.queued.filter((item) => item.kind === "result")).toEqual([
			{
				businessId: "turn:turn-1:result:0",
				kind: "result",
				text: "PR #1324 已通过。",
				threadText: "PR #1324 已通过。",
			},
		]);
		expect(h.coordinator.obligation("h1")?.state).toBe("settled");
		expect(h.coordinator.obligation("h2")?.state).toBe("settled");
	});

	it("binds a pending handoff to a turn that starts within 5s and ignores duplicates", () => {
		const h = harness();
		expect(
			h.coordinator.registerHandoff({
				handoffId: "h1",
				inputTranscript: "查一下",
			}),
		).toBe(true);
		expect(
			h.coordinator.registerHandoff({
				handoffId: "h1",
				inputTranscript: "重复到达",
			}),
		).toBe(false);
		h.clock.advance(4_999);
		h.coordinator.turnStarted("turn-1");
		expect(h.coordinator.obligation("h1")).toMatchObject({
			state: "attached",
			turnId: "turn-1",
			inputTranscript: "查一下",
		});
		h.clock.advance(1);
		expect(h.queued).toEqual([]);
	});

	it("settles a late handoff as unconfirmed and changes the prompt only when the prior turn has a write receipt", () => {
		const withoutReceipt = harness();
		withoutReceipt.coordinator.turnStarted("turn-1");
		withoutReceipt.clock.advance(100);
		withoutReceipt.coordinator.turnTerminal({
			turnId: "turn-1",
			outcome: "completed",
			spokenSegments: [],
			hadWriteReceipt: false,
		});
		withoutReceipt.clock.advance(1_000);
		withoutReceipt.coordinator.registerHandoff({
			handoffId: "late-1",
			inputTranscript: "晚到",
		});
		withoutReceipt.clock.advance(5_000);
		expect(withoutReceipt.queued.at(-1)).toMatchObject({
			kind: "fallback",
			text: "刚才那件我没接上，你再说一次？",
		});

		const withReceipt = harness();
		withReceipt.coordinator.turnStarted("turn-2");
		withReceipt.clock.advance(100);
		withReceipt.coordinator.turnTerminal({
			turnId: "turn-2",
			outcome: "completed",
			spokenSegments: ["写操作已落账。"],
			hadWriteReceipt: true,
		});
		withReceipt.clock.advance(1_000);
		withReceipt.coordinator.registerHandoff({
			handoffId: "late-2",
			inputTranscript: "晚到",
		});
		withReceipt.clock.advance(5_000);
		expect(withReceipt.queued.at(-1)).toMatchObject({
			kind: "fallback",
			text: "刚才那件的结果还没对应上，我先核对一下",
		});
	});

	it("emits at most the 20s and 40s waiting cues for the oldest unsettled obligation", () => {
		const h = harness();
		h.coordinator.turnStarted("turn-1");
		h.coordinator.registerHandoff({
			handoffId: "h1",
			inputTranscript: "慢查询",
		});
		h.coordinator.registerHandoff({
			handoffId: "h2",
			inputTranscript: "第二问",
		});
		h.clock.advance(19_999);
		expect(h.queued).toEqual([]);
		h.clock.advance(1);
		h.clock.advance(20_000);
		h.clock.advance(60_000);

		expect(h.queued.filter((item) => item.kind === "cue")).toEqual([
			{
				businessId: "h1",
				kind: "cue",
				text: "还在查",
				expiresAt: 40_000,
			},
			{ businessId: "h1", kind: "cue", text: "还在查" },
		]);

		h.coordinator.turnTerminal({
			turnId: "turn-1",
			outcome: "failed",
			reasonCategory: "权限",
		});
		expect(h.dropped).toContainEqual({ businessId: "h1", kind: "cue" });
		expect(h.queued.at(-1)).toMatchObject({
			kind: "result",
			text: "这件没查成：权限。细节我发到 thread。",
		});
	});
});
