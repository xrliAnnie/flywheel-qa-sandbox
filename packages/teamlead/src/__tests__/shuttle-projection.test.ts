import { describe, expect, it, vi } from "vitest";
import {
	createShuttleObservationProjector,
	type ShuttleObservationExport,
} from "../bridge/shuttle-observation-projector.js";
import { StateStore } from "../StateStore.js";

const NOW = "2026-09-17T19:42:00Z";

function unit(input: {
	outcome: "failed" | "up_to_date" | "skipped";
	founderAware: boolean;
	episodeId: string | null;
	expected?: boolean;
}) {
	return {
		schemaVersion: 1 as const,
		cycleId: `cycle-${input.founderAware ? 2 : 1}`,
		cycleSeq: input.founderAware ? 2 : 1,
		unitId: "raya-unit",
		projectName: "raya",
		unitKind: "external_repo",
		ownerKey: "raya-repo",
		displayName: "Raya <repo>",
		wakeKind: "scheduled",
		outcome: input.outcome,
		reason:
			input.outcome === "failed"
				? "prestop_validation_failed"
				: input.outcome === "skipped"
					? "not-in-deploy-wave"
					: "already_current",
		reasonDisplay:
			input.outcome === "failed"
				? "预停验证失败"
				: input.outcome === "skipped"
					? "本轮无部署波次"
					: "已经是最新版",
		expected: input.expected ?? false,
		evaluated: true,
		observedAt: NOW,
		evidenceRef: "/tmp/evidence.json",
		logRef: "/tmp/flywheel-updater.log",
		deployedSha: "0".repeat(40),
		targetSha: "1".repeat(40),
		behindCommits: input.outcome === "failed" ? 105 : 0,
		driftBasis: "first_observed_behind",
		episodeId: input.episodeId,
		episodeOpenedAt: input.episodeId ? NOW : null,
		consecutiveScheduledBad: input.founderAware ? 2 : input.episodeId ? 1 : 0,
		founderAware: input.founderAware,
		closedAt: input.episodeId ? null : NOW,
		driftSince: input.episodeId ? NOW : null,
		notificationIntents: input.episodeId
			? [
					{
						routeKey: "primary",
						episodeId: input.episodeId,
						deliveryState: "sent",
					},
				]
			: [],
	};
}

function exported(
	nextCursor: number,
	current: ReturnType<typeof unit>,
): ShuttleObservationExport {
	return {
		schemaVersion: 1,
		sourceId: "source-1",
		afterChangeSeq: nextCursor - 1,
		nextCursor,
		hasMore: false,
		changes: [
			{
				changeSeq: nextCursor,
				unitId: current.unitId,
				cycleId: current.cycleId,
				payload: current,
			},
		],
		units: [current],
	};
}

describe("shuttle observation projection", () => {
	it("projects failure, founder escalation, and recovery from one durable source", async () => {
		const store = await StateStore.create(":memory:");
		const reads = [
			exported(
				1,
				unit({ outcome: "failed", founderAware: false, episodeId: "ep-1" }),
			),
			exported(
				2,
				unit({ outcome: "failed", founderAware: true, episodeId: "ep-1" }),
			),
			exported(
				3,
				unit({ outcome: "up_to_date", founderAware: false, episodeId: null }),
			),
		];
		const refresh = vi.fn();
		const projector = createShuttleObservationProjector({
			store,
			projects: ["flywheel", "raya"],
			readExport: async () => reads.shift()!,
			requestRefresh: refresh,
			now: () => new Date(NOW),
		});

		await projector.tick();
		expect(store.getShuttleDeploymentProjection("flywheel")).toMatchObject({
			sourceStatus: "complete",
			observedAt: NOW,
			activeIncidents: ["raya-unit"],
			units: [{ founderAware: false, deliveryState: "sent" }],
		});
		expect(refresh).toHaveBeenCalledWith("flywheel", "deployment_changed");
		expect(refresh).toHaveBeenCalledWith("raya", "deployment_changed");

		await projector.tick();
		expect(
			store.getShuttleDeploymentProjection("raya").units[0]?.founderAware,
		).toBe(true);

		await projector.tick();
		expect(store.getShuttleDeploymentProjection("flywheel")).toMatchObject({
			activeIncidents: [],
			units: [{ outcome: "up_to_date", episodeId: null }],
		});
	});

	it("retains the last projection but marks an unavailable source explicitly", async () => {
		const store = await StateStore.create(":memory:");
		const projector = createShuttleObservationProjector({
			store,
			projects: ["flywheel", "raya"],
			readExport: vi
				.fn()
				.mockResolvedValueOnce(
					exported(
						1,
						unit({ outcome: "failed", founderAware: false, episodeId: "ep-1" }),
					),
				)
				.mockRejectedValueOnce(new Error("source offline")),
			requestRefresh: vi.fn(),
			now: () => new Date(NOW),
		});
		await projector.tick();
		await projector.tick();
		expect(store.getShuttleDeploymentProjection("flywheel")).toMatchObject({
			sourceStatus: "unavailable",
			activeIncidents: ["raya-unit"],
		});
	});

	it("keeps an open incident active across an expected skipped cycle", async () => {
		const store = await StateStore.create(":memory:");
		const projector = createShuttleObservationProjector({
			store,
			projects: ["flywheel", "raya"],
			readExport: async () =>
				exported(
					1,
					unit({
						outcome: "skipped",
						expected: true,
						founderAware: true,
						episodeId: "ep-1",
					}),
				),
			requestRefresh: vi.fn(),
			now: () => new Date(NOW),
		});

		await projector.tick();
		expect(store.getShuttleDeploymentProjection("flywheel")).toMatchObject({
			sourceStatus: "complete",
			activeIncidents: ["raya-unit"],
			units: [
				{
					outcome: "skipped",
					expected: true,
					episodeId: "ep-1",
					founderAware: true,
				},
			],
		});
	});

	it("does not present an empty source as healthy", async () => {
		const store = await StateStore.create(":memory:");
		const projector = createShuttleObservationProjector({
			store,
			projects: ["flywheel"],
			readExport: async () => ({
				schemaVersion: 1,
				sourceId: "source-1",
				afterChangeSeq: 0,
				nextCursor: 0,
				hasMore: false,
				changes: [],
				units: [],
			}),
			requestRefresh: vi.fn(),
			now: () => new Date(NOW),
		});

		await projector.tick();
		expect(store.getShuttleDeploymentProjection("flywheel")).toMatchObject({
			sourceStatus: "unavailable",
			observedAt: null,
			units: [],
		});
	});

	it("rejects a cursor-mismatched export instead of skipping source changes", async () => {
		const store = await StateStore.create(":memory:");
		store.applyShuttleProjection({
			sourceId: "source-1",
			cursor: 1,
			status: "complete",
			units: [
				unit({ outcome: "failed", founderAware: false, episodeId: "ep-1" }),
			],
			now: NOW,
		});
		const projector = createShuttleObservationProjector({
			store,
			projects: ["flywheel", "raya"],
			readExport: async () =>
				exported(
					3,
					unit({
						outcome: "up_to_date",
						founderAware: false,
						episodeId: null,
					}),
				),
			requestRefresh: vi.fn(),
			now: () => new Date(NOW),
		});

		await projector.tick();
		expect(store.getShuttleDeploymentProjection("flywheel")).toMatchObject({
			sourceStatus: "unavailable",
			activeIncidents: ["raya-unit"],
		});
	});
});
