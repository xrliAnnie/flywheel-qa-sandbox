import { createHash } from "node:crypto";
import type { BetaScheduleObservation } from "./beta-release-scheduler.js";
import type { BetaReleaseStore } from "./beta-release-store.js";
import type { ManagementBetaScheduleView } from "./management-console-contract.js";
import type { ManagementSnapshotProvider } from "./management-console-snapshot.js";
/** Pure cached projection: page requests perform no GitHub or filesystem work. */
export function createBetaManagementProvider(options: {
	store: Pick<BetaReleaseStore, "lanes" | "active" | "latestResult">;
	observations: () => BetaScheduleObservation[];
	now?: () => number;
}): ManagementSnapshotProvider {
	return {
		id: "beta-schedules",
		sourceKind: "extension",
		read() {
			const now = options.now?.() ?? Date.now();
			const lanes = options.store.lanes();
			const projectBetaSchedules = options.observations().map((observation) => {
				const lane = lanes.find(
					(l) => l.projectName === observation.projectName,
				);
				const stale =
					now - observation.observedAtMs > 120000 ||
					now < observation.observedAtMs;
				const owner = stale ? "unknown" : observation.owner;
				const status = stale ? "unknown" : observation.status;
				const active = options.store.active(observation.projectName);
				const last = options.store
					.latestResult(observation.projectName)
					?.find((r) => r.outcome !== "not_activated");
				let label =
					owner === "legacy"
						? "旧入口每 6 小时"
						: owner === "paused"
							? "已暂停新的内部测试版"
							: owner === "bridge"
								? `每 ${observation.intervalHours ?? 24} 小时检查内部测试版`
								: "内部测试版状态未知";
				if (!stale && status === "unconfigured")
					label = "尚未激活：缺少内部测试版工作流；目标 24 小时";
				if (!stale && status === "not_activated")
					label = "尚未激活：发布端点未配置";
				if (!stale && status === "attention") label = "内部测试版需要检查";
				const betaSchedule: ManagementBetaScheduleView = {
					owner,
					status,
					label,
					reason: stale ? "observation_stale" : observation.reason,
					configuredIntervalHours: observation.intervalHours,
					effectiveIntervalHours:
						owner === "legacy"
							? 6
							: owner === "bridge"
								? observation.intervalHours
								: null,
					nextDueAtMs: lane?.nextDueAtMs ?? null,
					observedAtMs: observation.observedAtMs,
					activeRuns:
						lane &&
						/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(
							lane.canonicalRepo,
						)
							? (active?.runIds ?? [])
									.filter((id) => Number.isSafeInteger(id) && id > 0)
									.map((id) => ({
										id,
										url: `https://github.com/${lane.canonicalRepo}/actions/runs/${id}`,
									}))
							: [],
					lastPublished:
						last &&
						last.publishedVersion &&
						last.publishedSourceCommit &&
						last.publishedAt
							? {
									version: last.publishedVersion,
									sourceCommit: last.publishedSourceCommit,
									publishedAt: last.publishedAt,
								}
							: null,
				};
				return { projectName: observation.projectName, betaSchedule };
			});
			return {
				revision: createHash("sha256")
					.update(JSON.stringify(projectBetaSchedules))
					.digest("hex"),
				fragment: { projectBetaSchedules },
			};
		},
	};
}
