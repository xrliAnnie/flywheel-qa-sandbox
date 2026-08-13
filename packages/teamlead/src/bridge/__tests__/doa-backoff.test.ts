import { beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	createDoaBackoffAdmission,
	drainDoaBackoffAlerts,
	repairDoaBackoffReservations,
} from "../doa-backoff.js";
import { createIssueMutex } from "../lifecycle-closeout.js";

const ROOT = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-08-12T12:00:00.000Z");

describe("FLY-1718 DOA admission and repair", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("resolves aliases to the UUID lane and returns a bounded retry delay", async () => {
		store.upsertSession({
			execution_id: "failed-1",
			issue_id: ROOT,
			issue_identifier: "FLY-1718",
			project_name: "flywheel",
			status: "failed",
			session_role: "main",
			started_at: new Date(NOW - 10_000).toISOString(),
			last_activity_at: new Date(NOW).toISOString(),
		});
		const admit = createDoaBackoffAdmission({
			store,
			withIssueMutex: createIssueMutex(),
			now: () => NOW,
		});

		await expect(
			admit({
				issueKey: "FLY-1718",
				issueIdentifier: "FLY-1718",
				projectName: "flywheel",
				executionId: "successor-1",
				role: "main",
				leadId: "flywheel-eng-lead",
			}),
		).resolves.toMatchObject({
			admitted: false,
			status: "backoff",
			reason: "backoff_active",
			retryAfterSeconds: 60,
		});
		expect(store.getDoaBackoffLedger("flywheel", ROOT, "main")).toMatchObject({
			leadId: "flywheel-eng-lead",
			count: 1,
		});
	});

	it("fails open loudly when no UUID root exists and never creates an identifier row", async () => {
		const log = vi.fn();
		const admit = createDoaBackoffAdmission({
			store,
			withIssueMutex: createIssueMutex(),
			now: () => NOW,
			log,
		});
		await expect(
			admit({
				issueKey: "FLY-9999",
				projectName: "flywheel",
				executionId: "successor",
				role: "main",
			}),
		).resolves.toMatchObject({ admitted: true, reason: "no_uuid_mapping" });
		expect(log).toHaveBeenCalledOnce();
		expect(
			store.getDoaBackoffLedger("flywheel", "FLY-9999", "main"),
		).toBeUndefined();
	});

	it("startup repair settles only a bound starting owner", async () => {
		store.upsertSession({
			execution_id: "failed-1",
			issue_id: ROOT,
			issue_identifier: "FLY-1718",
			project_name: "flywheel",
			status: "failed",
			session_role: "main",
			started_at: new Date(NOW - 10_000).toISOString(),
			last_activity_at: new Date(NOW).toISOString(),
		});
		store.evaluateDoaBackoff({
			projectName: "flywheel",
			lifecycleRootUuid: ROOT,
			issueKeys: [ROOT, "FLY-1718"],
			issueId: ROOT,
			role: "main",
			leadId: "flywheel-eng-lead",
			successorExecutionId: "successor",
			nowMs: NOW,
			thresholdMs: 60_000,
			leaseMs: 600_000,
		});
		store.evaluateDoaBackoff({
			projectName: "flywheel",
			lifecycleRootUuid: ROOT,
			issueKeys: [ROOT, "FLY-1718"],
			issueId: ROOT,
			role: "main",
			leadId: "flywheel-eng-lead",
			successorExecutionId: "successor",
			nowMs: NOW + 60_000,
			thresholdMs: 60_000,
			leaseMs: 600_000,
		});
		store.insertLaunchClaim({
			executionId: "successor",
			rootUuid: ROOT,
			project: "flywheel",
			role: "main",
		});
		store.bindWorktreeOnce(
			"successor",
			{ path: "/tmp/successor", branch: "flywheel-FLY-1718", generation: "g1" },
			{ issueId: ROOT, projectName: "flywheel" },
		);

		await repairDoaBackoffReservations({
			store,
			withIssueMutex: createIssueMutex(),
		});
		expect(store.getLaunchClaim("successor")?.state).toBe("active");
		expect(store.getDoaBackoffLedger("flywheel", ROOT, "main")).toMatchObject({
			releaseState: "settled",
			lastSettledSuccessorExecutionId: "successor",
		});
	});

	it("drains a needs-lead alert only after durable notifier acceptance", async () => {
		const alert = vi.fn(async () => ({ sent: true }));
		const mark = vi.fn(() => true);
		const alertStore = {
			listPendingDoaBackoffAlerts: () => [
				{
					alertId: "doa-alert",
					projectName: "flywheel",
					lifecycleRootUuid: ROOT,
					issueId: "FLY-1718",
					role: "main",
					leadId: "flywheel-eng-lead",
					count: 5,
				},
			],
			markDoaBackoffAlertDelivered: mark,
		} as unknown as StateStore;
		await drainDoaBackoffAlerts({ store: alertStore, alert, now: () => NOW });
		expect(alert).toHaveBeenCalledOnce();
		expect(mark).toHaveBeenCalledWith("doa-alert", NOW);

		alert.mockResolvedValueOnce({ skipped: "no-channel" });
		mark.mockClear();
		await drainDoaBackoffAlerts({ store: alertStore, alert, now: () => NOW });
		expect(mark).not.toHaveBeenCalled();
	});
});
