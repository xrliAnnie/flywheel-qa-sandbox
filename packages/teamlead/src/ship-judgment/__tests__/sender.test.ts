import { expect, it, vi } from "vitest";
import { canonicalDigest } from "../contract.js";
import { type SendReceipt, sendJudgmentOpinion } from "../sender.js";
import { bindingFixture, CHANNEL, NOW } from "./binding-fixture.js";

it.each(["mode", "binding"])(
	"recovers an uncertain POST and rejects receipts after %s changes",
	async (change) => {
		const { store, db } = await bindingFixture();
		try {
			let now = Date.parse(NOW),
				enabled = true;
			const binding = store.readShipJudgmentBinding("q", CHANNEL)!;
			const offered = store.getShipJudgmentOpinions().offer(
				{
					questionId: "q",
					channelId: CHANNEL,
					bindingDigest: canonicalDigest(binding),
					inputId: null,
					reason: "missing",
					mechanical: {
						verdict: "undetermined",
						reason: "missing",
						digest: "a".repeat(64),
						checkedAt: NOW,
						scope: "main",
						checkedRepos: 0,
						openPrCount: null,
						overlaps: [],
					},
				},
				now,
			);
			if (offered.status !== "created") throw new Error(offered.status);
			const delivery = store.getShipJudgmentDelivery();
			const post = vi.fn<() => Promise<SendReceipt>>(async () => ({
				kind: "uncertain",
			}));
			const scan = vi.fn(async () => ({
				kind: "found" as const,
				messageId: "123456789012345681",
				opinionId: offered.opinionId,
				visibleAt: NOW,
			}));
			const deps = {
				delivery,
				enabled: () => enabled,
				now: () => now,
				post,
				scan,
				patch: vi.fn(),
				current: () => store.readShipJudgmentBinding("q", CHANNEL),
				legacySummary: () => "暂无样本",
			};
			expect(await sendJudgmentOpinion("q", CHANNEL, "sender", deps)).toBe(
				"deferred",
			);
			now += 60_001;
			expect(await sendJudgmentOpinion("q", CHANNEL, "sender", deps)).toBe(
				"delivered",
			);
			expect(post).toHaveBeenCalledTimes(1);
			expect(scan).toHaveBeenCalledTimes(1);
			expect(await sendJudgmentOpinion("q", CHANNEL, "sender", deps)).toBe(
				"settled",
			);
			// Force a fresh distinct question delivery attempt only by resetting mutable transport state.
			db.prepare(
				"UPDATE ship_judgment_delivery SET state='pending',message_id=NULL,posted_id=NULL,validated_at=?",
			).run(new Date(now).toISOString());
			post.mockImplementationOnce(async () => {
				if (change === "mode") enabled = false;
				else
					db.prepare(
						"UPDATE workflow_ship_target_binding SET superseded_at=? WHERE approve_question_id='q'",
					).run(NOW);
				return {
					kind: "posted",
					messageId: "123456789012345682",
					visibleAt: new Date(now).toISOString(),
				};
			});
			expect(await sendJudgmentOpinion("q", CHANNEL, "sender", deps)).toBe(
				"invalidated",
			);
			expect(
				db
					.prepare(
						"SELECT COUNT(*) AS n FROM workflow_run_event WHERE kind='ship_judgment_visible'",
					)
					.get(),
			).toEqual({ n: 1 });
			expect(await sendJudgmentOpinion("q", CHANNEL, "sender", deps)).toBe(
				"inactive",
			);
		} finally {
			store.close();
		}
	},
);

it("times out a stalled transport, aborts it, and ignores its late success", async () => {
	const { store, db } = await bindingFixture();
	vi.useFakeTimers();
	try {
		const now = Date.parse(NOW),
			binding = store.readShipJudgmentBinding("q", CHANNEL)!;
		store.getShipJudgmentOpinions().offer(
			{
				questionId: "q",
				channelId: CHANNEL,
				bindingDigest: canonicalDigest(binding),
				inputId: null,
				reason: "missing",
				mechanical: {
					verdict: "undetermined",
					reason: "missing",
					digest: "a".repeat(64),
					checkedAt: NOW,
					scope: "main",
					checkedRepos: 0,
					openPrCount: null,
					overlaps: [],
				},
			},
			now,
		);
		let finish: (receipt: SendReceipt) => void = () => {};
		let signal: AbortSignal | undefined;
		const pending = new Promise<SendReceipt>((resolve) => {
			finish = resolve;
		});
		const task = sendJudgmentOpinion("q", CHANNEL, "sender", {
			delivery: store.getShipJudgmentDelivery(),
			enabled: () => true,
			current: () => binding,
			now: () => now,
			legacySummary: () => "暂无",
			post: async (_view, _content, abort) => {
				signal = abort;
				return pending;
			},
			patch: vi.fn(),
			scan: vi.fn(),
		});
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await task).toBe("deferred");
		expect(signal?.aborted).toBe(true);
		finish({ kind: "posted", messageId: "123456789012345682", visibleAt: NOW });
		await Promise.resolve();
		expect(
			db.prepare("SELECT state,message_id FROM ship_judgment_delivery").get(),
		).toEqual({ state: "uncertain", message_id: null });
		expect(
			db
				.prepare(
					"SELECT COUNT(*) AS n FROM workflow_run_event WHERE kind='ship_judgment_visible'",
				)
				.get(),
		).toEqual({ n: 0 });
	} finally {
		vi.useRealTimers();
		store.close();
	}
});
