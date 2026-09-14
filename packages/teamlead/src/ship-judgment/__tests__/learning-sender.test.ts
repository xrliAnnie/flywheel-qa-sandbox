import { expect, it, vi } from "vitest";
import { LearningDelivery } from "../learning-delivery.js";
import { sendLearningMessage } from "../learning-sender.js";
import type { LearningSendReceipt } from "../learning-transport.js";
import { bindingFixture, CHANNEL, NOW } from "./binding-fixture.js";

const subjectId = "a".repeat(64),
	messageId = "123456789012345695";
async function fixture() {
	const { store, db } = await bindingFixture();
	db.prepare(`INSERT INTO ship_judgment_delivery(purpose,subject_id,question_id,thread_id,card_message_id,desired_id,state,marker)
 VALUES ('clarification',?,'q','123456789012345679','123456789012345678',?,'pending',?)`).run(
		subjectId,
		subjectId,
		`ship-judgment:clarification:${subjectId}`,
	);
	const delivery = new LearningDelivery(db, () => "dry_run");
	// Content resolution has its own real-ledger tests; sender tests keep the real delivery state machine.
	vi.spyOn(delivery, "view").mockReturnValue({
		content: "fixture",
		replyTo: "123456789012345678",
		since: NOW,
	});
	return { store, db, delivery };
}
it("recovers a lost POST via authenticated scan and binds only the expected subject", async () => {
	const { store, db, delivery } = await fixture();
	try {
		let now = Date.parse(NOW);
		const post = vi.fn(async () => ({ kind: "uncertain" as const })),
			scan = vi.fn(async () => ({
				kind: "found" as const,
				messageId,
				subjectId,
				visibleAt: NOW,
			}));
		const deps = {
			delivery,
			guildId: CHANNEL,
			now: () => now,
			post,
			scan,
			signal: new AbortController().signal,
		};
		expect(
			await sendLearningMessage("clarification", subjectId, "sender", deps),
		).toBe("uncertain");
		now += 60_001;
		scan.mockResolvedValueOnce({
			kind: "found",
			messageId,
			subjectId: "b".repeat(64),
			visibleAt: NOW,
		});
		expect(
			await sendLearningMessage("clarification", subjectId, "sender", deps),
		).toBe("uncertain");
		now += 120_001;
		expect(
			await sendLearningMessage("clarification", subjectId, "sender", deps),
		).toBe("delivered");
		expect(post).toHaveBeenCalledOnce();
		expect(scan).toHaveBeenCalledTimes(2);
		expect(
			db
				.prepare(
					"SELECT state,message_id FROM ship_judgment_delivery WHERE purpose='clarification'",
				)
				.get(),
		).toEqual({ state: "delivered", message_id: messageId });
	} finally {
		store.close();
	}
});
it("joins cancellation without waiting for uncooperative transport and ignores its late receipt", async () => {
	const { store, db, delivery } = await fixture();
	try {
		let start: () => void = () => {},
			finish: (value: LearningSendReceipt) => void = () => {};
		const started = new Promise<void>((resolve) => {
				start = resolve;
			}),
			response = new Promise<LearningSendReceipt>((resolve) => {
				finish = resolve;
			});
		const controller = new AbortController();
		const post = vi.fn(
			async (_claim: unknown, _view: unknown, signal: AbortSignal) => {
				start();
				signal.addEventListener("abort", () => {}, { once: true });
				return response;
			},
		);
		const pending = sendLearningMessage("clarification", subjectId, "sender", {
			delivery,
			guildId: CHANNEL,
			now: () => Date.parse(NOW),
			post,
			scan: vi.fn(),
			signal: controller.signal,
		});
		await started;
		controller.abort();
		expect(await pending).toBe("uncertain");
		finish({ kind: "posted", messageId, visibleAt: NOW });
		await Promise.resolve();
		expect(
			db
				.prepare(
					"SELECT state,message_id FROM ship_judgment_delivery WHERE purpose='clarification'",
				)
				.get(),
		).toEqual({ state: "uncertain", message_id: null });
	} finally {
		store.close();
	}
});
it("records unavailable transport results without claiming delivery", async () => {
	const { store, db, delivery } = await fixture();
	try {
		expect(
			await sendLearningMessage("clarification", subjectId, "sender", {
				delivery,
				guildId: CHANNEL,
				now: () => Date.parse(NOW),
				post: async () => ({ kind: "unavailable", code: "thread_archived" }),
				scan: vi.fn(),
				signal: new AbortController().signal,
			}),
		).toBe("unavailable");
		expect(
			db
				.prepare(
					"SELECT state,last_error FROM ship_judgment_delivery WHERE purpose='clarification'",
				)
				.get(),
		).toEqual({ state: "unavailable", last_error: "thread_archived" });
	} finally {
		store.close();
	}
});

it("enforces the total ten-second deadline with a hung transport", async () => {
	const { store, db, delivery } = await fixture();
	vi.useFakeTimers();
	vi.setSystemTime(new Date(NOW));
	try {
		const pending = sendLearningMessage("clarification", subjectId, "sender", {
			delivery,
			guildId: CHANNEL,
			now: Date.now,
			post: async () => new Promise(() => {}),
			scan: vi.fn(),
			signal: new AbortController().signal,
		});
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await pending).toBe("uncertain");
		expect(
			db
				.prepare(
					"SELECT state,message_id FROM ship_judgment_delivery WHERE purpose='clarification'",
				)
				.get(),
		).toEqual({ state: "uncertain", message_id: null });
	} finally {
		vi.useRealTimers();
		store.close();
	}
});
