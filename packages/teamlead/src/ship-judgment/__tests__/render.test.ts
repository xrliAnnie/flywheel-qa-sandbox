import { expect, it } from "vitest";
import { canonicalDigest } from "../contract.js";
import { renderJudgmentMessage } from "../render.js";
import { bindingFixture, CHANNEL, NOW } from "./binding-fixture.js";

it("renders the persisted three-point opinion without approval language, unsafe mentions, or unbounded content", async () => {
	const { store } = await bindingFixture();
	try {
		const binding = store.readShipJudgmentBinding("q", CHANNEL)!;
		const offer = store.getShipJudgmentOpinions().offer(
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
					scope: "main + files",
					checkedRepos: 1,
					openPrCount: 0,
					overlaps: [],
				},
			},
			Date.parse(NOW),
		);
		if (offer.status !== "created") throw new Error(offer.status);
		const view = store.getShipJudgmentDelivery().view("q", offer.opinionId)!;
		expect(view.opinionId).toBe(offer.opinionId);
		const text = renderJudgmentMessage(
			{
				...view,
				evaluation: {
					alignment: {
						evidence: [
							{
								quote: `@everyone [click](https://evil.invalid) ${"x".repeat(3000)}`,
							},
						],
					},
				},
			},
			`sample ${"x".repeat(3000)}`,
		);
		expect(text).toContain("机器试判");
		expect(text).toContain("dry_run");
		expect(text).toContain("仍由你批准");
		expect(text).toContain("PRD / 设计对齐");
		expect(text).toContain("QA 用例覆盖");
		expect(text).toContain("旧窄口三闸");
		expect(text).toContain(offer.opinionId);
		expect(text).not.toContain("@everyone");
		expect(text).not.toContain("[click](");
		expect(text.length).toBeLessThanOrEqual(2000);
		for (const reason of [
			"project_sources_unavailable",
			"input_unavailable:repositories_unavailable",
		]) {
			const unavailable = renderJudgmentMessage({
				...view,
				mechanical: {
					...view.mechanical,
					reason,
					checkedRepos: 0,
					openPrCount: null,
				},
			});
			expect(unavailable).toContain("输入不可得：");
			expect(unavailable).toContain("三项按已得证据判");
			expect(unavailable).not.toContain("0 仓");
		}
		expect(store.getShipJudgmentDelivery().view("q", "wrong")).toBeUndefined();
	} finally {
		store.close();
	}
});

it("bounds escaped Unicode fields together, including maximum overlap evidence", () => {
	const huge = "😀\\`@".repeat(1000);
	expect(() =>
		renderJudgmentMessage(
			{
				opinionId: huge,
				questionId: "q",
				threadId: "1",
				cardMessageId: "2",
				marker: huge,
				overall: "undetermined",
				alignment: "undetermined",
				conflict: "undetermined",
				coverage: "undetermined",
				mechanical: {
					verdict: "undetermined",
					reason: "missing",
					digest: "a".repeat(64),
					checkedAt: NOW,
					scope: huge,
					checkedRepos: 200,
					openPrCount: 200,
					overlaps: Array.from({ length: 3 }, () => ({
						repo_identity: huge,
						pr_number: 123456,
						path: huge,
					})),
				},
				evaluation: {
					alignment: { evidence: [{ quote: huge }] },
					coverage: { evidence: [{ quote: huge }] },
				},
			},
			huge,
		),
	).not.toThrow();
});
