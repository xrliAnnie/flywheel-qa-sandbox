import { describe, expect, it, vi } from "vitest";
import type { Goal } from "../contracts/goals.js";
import type { CoSPorts } from "../ports.js";
import { planPatrol, publishPatrolJudgment } from "./patrol.js";
import type { PortfolioSnapshot } from "./types.js";

const snapshot: PortfolioSnapshot = {
	v: 1,
	snapshotId: "snapshot-7",
	seq: 7,
	sampledAt: "2026-09-08T20:00:00.000Z",
	trigger: "scheduled",
	projects: [],
	activityAvailable: true,
	all: { git: "ok", gh: "ok", linear: "ok" },
};
const goals: Goal[] = [
	{
		id: "g-20260908-01",
		operationId: "12345678901234567:record:1",
		status: "active",
		text: "Finish standard Lead migration",
		sourceUrl: "https://discord.com/channels/1/2/3",
		recordedAt: "2026-09-08T18:00:00.000Z",
	},
];

describe("portfolio patrol without a private model driver", () => {
	it("returns business material for the current standard Lead turn", () => {
		const result = planPatrol({
			snapshot,
			goals,
			now: new Date("2026-09-08T20:01:00.000Z"),
			staleAfterMs: 300_000,
		});

		expect(result).toMatchObject({
			status: "needs_judgment",
			snapshotId: "snapshot-7",
		});
		if (result.status === "needs_judgment") {
			expect(result.prompt).toContain("Finish standard Lead migration");
			expect(result.prompt).toContain("snapshot-7");
		}
	});

	it("publishes with a stable Bridge event and preserves pending", async () => {
		const announce = vi.fn(async () => ({ status: "pending" as const }));
		const ports = { announce } as unknown as CoSPorts;
		const result = await publishPatrolJudgment(
			{
				snapshotId: "snapshot-7",
				text: "【偏离】\n依据: snapshot=snapshot-7 goals=g-20260908-01 readings=flywheel.openPrs.returnedCount\n需要关注 Flywheel。",
				context: {
					snapshot: {
						...snapshot,
						projects: [
							{
								projectName: "flywheel",
								openPrs: {
									returnedCount: { ok: true, value: 3, at: snapshot.sampledAt },
								},
							},
						],
					},
					goals: goals.map((goal) => ({ ...goal, projects: ["flywheel"] })),
					now: new Date(snapshot.sampledAt),
					staleAfterMs: 300000,
				},
			},
			ports,
		);

		expect(announce).toHaveBeenCalledWith({
			eventId: "portfolio:snapshot-7:judgment",
			target: "chat",
			text: expect.stringContaining("🔔 **Raya**: 需要关注 Flywheel。"),
		});
		expect(result).toEqual({ status: "pending" });
	});
	it("refuses unvalidated text at the actual outbound entry", async () => {
		const announce = vi.fn();
		await expect(
			publishPatrolJudgment(
				{ snapshotId: "snapshot-7", text: "publish without evidence" },
				{ announce } as unknown as CoSPorts,
			),
		).rejects.toThrow(/evidence/);
		expect(announce).not.toHaveBeenCalled();
	});
});
