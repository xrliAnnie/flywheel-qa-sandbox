import { describe, expect, it, vi } from "vitest";
import { SpeechArbiter } from "../codex/SpeechArbiter.js";

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

async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("SpeechArbiter", () => {
	it("waits for 800ms of local-VAD floor idle before speaking serially", async () => {
		const clock = new FakeClock();
		const spoken: Array<{ text: string; pendingKey: string }> = [];
		const arbiter = new SpeechArbiter({
			now: () => clock.now,
			schedule: clock.schedule,
			cancelScheduled: clock.cancel,
			speak: async (request) => {
				spoken.push(request);
				return "spoken";
			},
			cancelSpeech: vi.fn(),
		});

		arbiter.localUtteranceStarted("u1");
		const first = arbiter.enqueue({
			businessId: "result-1",
			kind: "result",
			text: "FLY-2886 已查到。",
		});
		const second = arbiter.enqueue({
			businessId: "result-2",
			kind: "result",
			text: "PR #1324 已通过。",
		});
		clock.advance(5_000);
		expect(spoken).toEqual([]);

		arbiter.localUtteranceEnded("u1");
		clock.advance(799);
		expect(spoken).toEqual([]);
		clock.advance(1);
		await settle();

		expect(spoken).toEqual([
			{ text: "FLY-2886 已查到。", pendingKey: "result-1:attempt:0" },
			{ text: "PR #1324 已通过。", pendingKey: "result-2:attempt:0" },
		]);
		await expect(first).resolves.toBe("spoken");
		await expect(second).resolves.toBe("spoken");
	});

	it("keeps user-active bound to exact provider items and preserves local VAD across generations", () => {
		const clock = new FakeClock();
		const arbiter = new SpeechArbiter({
			now: () => clock.now,
			schedule: clock.schedule,
			cancelScheduled: clock.cancel,
			speak: async () => "spoken",
			cancelSpeech: vi.fn(),
		});

		arbiter.providerSpeechStarted(1, "old");
		arbiter.providerSpeechStarted(1, "new");
		arbiter.providerSpeechFinished(1, "old");
		expect(arbiter.userActive).toBe(true);

		arbiter.localUtteranceStarted("local");
		arbiter.generationChanged(2);
		expect(arbiter.userActive).toBe(true);
		arbiter.providerSpeechFinished(1, "new");
		expect(arbiter.userActive).toBe(true);
		arbiter.localUtteranceEnded("local");
		expect(arbiter.userActive).toBe(false);
	});

	it("clears only stale provider supplements after local speech and raw voice are quiet for 3s", () => {
		const clock = new FakeClock();
		const arbiter = new SpeechArbiter({
			now: () => clock.now,
			schedule: clock.schedule,
			cancelScheduled: clock.cancel,
			speak: async () => "spoken",
			cancelSpeech: vi.fn(),
		});

		arbiter.localUtteranceStarted("local");
		arbiter.observeRawVoiceActivity();
		arbiter.providerSpeechStarted(1, "missing-final");
		clock.advance(100);
		arbiter.localUtteranceEnded("local");
		clock.advance(2_999);
		expect(arbiter.userActive).toBe(true);
		clock.advance(1);
		expect(arbiter.userActive).toBe(false);

		arbiter.providerSpeechStarted(1, "newer");
		clock.advance(3_000);
		expect(arbiter.userActive).toBe(true);
	});

	it("requeues interrupted results with a new key, then posts a fallback after the third interruption", async () => {
		const clock = new FakeClock();
		const speak = vi.fn(
			(_request: { text: string; pendingKey: string }) =>
				new Promise<"spoken" | "failed">(() => undefined),
		);
		const cancelSpeech = vi.fn();
		const postThread = vi.fn(async () => undefined);
		const arbiter = new SpeechArbiter({
			now: () => clock.now,
			schedule: clock.schedule,
			cancelScheduled: clock.cancel,
			speak,
			cancelSpeech,
			postThread,
		});

		const terminal = arbiter.enqueue({
			businessId: "turn-1-result",
			kind: "result",
			text: "FLY-2886 的 PR #1324 已通过。",
			threadText: "FLY-2886 的 PR #1324 已通过。",
		});
		clock.advance(800);
		expect(speak).toHaveBeenLastCalledWith({
			text: "FLY-2886 的 PR #1324 已通过。",
			pendingKey: "turn-1-result:attempt:0",
		});

		for (let attempt = 1; attempt <= 3; attempt += 1) {
			arbiter.localUtteranceStarted(`u${attempt}`);
			arbiter.localUtteranceEnded(`u${attempt}`);
			await settle();
			if (attempt < 3) {
				clock.advance(800);
				expect(speak).toHaveBeenLastCalledWith({
					text: "刚才查到的：FLY-2886 的 PR #1324 已通过。",
					pendingKey: `turn-1-result:attempt:${attempt}`,
				});
			}
		}

		expect(cancelSpeech).toHaveBeenCalledTimes(3);
		expect(postThread).toHaveBeenCalledWith({
			businessId: "turn-1-result",
			text: "FLY-2886 的 PR #1324 已通过。",
		});
		await expect(terminal).resolves.toBe("fallback_posted");
	});
});
