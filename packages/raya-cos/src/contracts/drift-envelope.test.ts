import { describe, expect, it } from "vitest";
import * as contracts from "./index.js";

describe("drift envelope", () => {
	it("accepts only evidence-bound patrol output and renders one safe message", () => {
		const api = contracts as typeof contracts & {
			parseDriftEnvelope?: (text: string) => Record<string, unknown>;
			validateDriftEnvelope?: (
				envelope: Record<string, unknown>,
				context: {
					snapshot: Record<string, unknown>;
					activeGoalIds: string[];
				},
			) => Record<string, unknown>;
		};
		expect(api.parseDriftEnvelope).toBeTypeOf("function");
		if (!api.parseDriftEnvelope || !api.validateDriftEnvelope) return;

		expect(api.parseDriftEnvelope("【无话】")).toEqual({
			kind: "silent_no_divergence",
		});
		expect(api.parseDriftEnvelope("【证据不足】")).toEqual({
			kind: "silent_insufficient",
		});

		const envelope = api.parseDriftEnvelope(
			[
				"【偏离】",
				"依据: snapshot=snap-1 goals=g-20260906-01 readings=flywheel.checkoutHead.lastNonChoreCommit,flywheel.openPrs.returnedCount",
				"你说「留住对话」要紧，但这个仓本周真实推进为零、仍挂着 3 个 PR。是目标变了，还是执行卡住了？",
			].join("\n"),
		);
		expect(envelope).toMatchObject({
			kind: "drift",
			snapshotId: "snap-1",
			goalIds: ["g-20260906-01"],
			readingRefs: [
				"flywheel.checkoutHead.lastNonChoreCommit",
				"flywheel.openPrs.returnedCount",
			],
		});

		const snapshot = {
			snapshotId: "snap-1",
			projects: [
				{
					projectName: "flywheel",
					checkoutHead: {
						lastNonChoreCommit: {
							ok: true,
							value: { sha7: "abc1234" },
							at: "2026-09-06T20:00:00Z",
						},
					},
					openPrs: {
						returnedCount: {
							ok: true,
							value: 3,
							at: "2026-09-06T20:00:00Z",
						},
					},
				},
			],
		};
		expect(
			api.validateDriftEnvelope(envelope, {
				snapshot,
				activeGoalIds: ["g-20260906-01"],
			}),
		).toEqual({
			kind: "valid",
			content:
				"🔔 **Raya**: 你说「留住对话」要紧，但这个仓本周真实推进为零、仍挂着 3 个 PR。是目标变了，还是执行卡住了？\n\n依据:读数 snap-1 · 目标 g-20260906-01 · 读数键 flywheel.checkoutHead.lastNonChoreCommit,flywheel.openPrs.returnedCount",
		});

		expect(api.parseDriftEnvelope("【无话】\n解释一句")).toMatchObject({
			kind: "invalid",
		});
		expect(
			api.parseDriftEnvelope(
				"【偏离】\n依据: snapshot=snap-1 goals=g-20260906-01 readings=flywheel.prActivity.newestUpdatedAt\n正文",
			),
		).toMatchObject({ kind: "invalid" });
		expect(
			api.validateDriftEnvelope(envelope, {
				snapshot: { ...snapshot, snapshotId: "snap-2" },
				activeGoalIds: ["g-20260906-01"],
			}),
		).toEqual({ kind: "invalid", reason: "snapshot_mismatch" });
	});

	it("rechecks duplicate evidence in the validator", () => {
		const validateDriftEnvelope = (
			contracts as typeof contracts & {
				validateDriftEnvelope: (
					envelope: Record<string, unknown>,
					context: {
						snapshot: Record<string, unknown>;
						activeGoalIds: string[];
					},
				) => Record<string, unknown>;
			}
		).validateDriftEnvelope;
		const reading = { ok: true, value: "main", at: "2026-09-06T20:00:00Z" };

		expect(
			validateDriftEnvelope(
				{
					kind: "drift",
					snapshotId: "snap-1",
					goalIds: ["g-20260906-01"],
					readingRefs: [
						"flywheel.checkoutHead.branch",
						"flywheel.checkoutHead.branch",
					],
					body: "这句不能发。",
				},
				{
					snapshot: {
						snapshotId: "snap-1",
						projects: [
							{
								projectName: "flywheel",
								checkoutHead: { branch: reading },
							},
						],
					},
					activeGoalIds: ["g-20260906-01"],
				},
			),
		).toEqual({ kind: "invalid", reason: "duplicate" });
	});

	it("fails closed for inactive goals and unavailable readings", () => {
		const api = contracts as typeof contracts & {
			parseDriftEnvelope: (text: string) => Record<string, unknown>;
			validateDriftEnvelope: (
				envelope: Record<string, unknown>,
				context: {
					snapshot: Record<string, unknown>;
					activeGoalIds: string[];
				},
			) => Record<string, unknown>;
		};
		const envelope = api.parseDriftEnvelope(
			"【偏离】\n依据: snapshot=snap-1 goals=g-20260906-01 readings=tidal-echo.activity.daysSinceLatestObservedActivity\n正文里的日期不受信任，但引用键必须可用。",
		);
		const snapshot = {
			snapshotId: "snap-1",
			projects: [
				{
					projectName: "tidal-echo",
					activity: {
						daysSinceLatestObservedActivity: {
							ok: false,
							reason: "no_activity_source",
						},
					},
				},
			],
		};

		expect(
			api.validateDriftEnvelope(envelope, {
				snapshot,
				activeGoalIds: [],
			}),
		).toEqual({ kind: "invalid", reason: "goal_not_active" });
		expect(
			api.validateDriftEnvelope(envelope, {
				snapshot,
				activeGoalIds: ["g-20260906-01"],
			}),
		).toEqual({ kind: "invalid", reason: "reading_unavailable" });
	});
});
