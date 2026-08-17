import { describe, expect, it } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import {
	createProductionFlagScanEffects,
	findLinearBatch,
	resolveFlagScanOwner,
} from "../flag-retirement-production.js";

function project(
	leads: ProjectEntry["leads"],
	projectName = "Flywheel",
): ProjectEntry {
	return {
		projectName,
		projectRoot: "/tmp/flywheel",
		generalChannel: "core",
		leads,
	};
}

function lead(
	agentId: string,
	department?: string,
): ProjectEntry["leads"][number] {
	return {
		agentId,
		chatChannel: "core",
		match: { labels: [agentId] },
		department,
	};
}

describe("FLY-1781 production owner resolution", () => {
	it("selects the one explicit Flywheel engineering Lead", () => {
		expect(
			resolveFlagScanOwner([
				project([
					lead("flywheel-eng-lead", "engineering"),
					lead("flywheel-product-lead", "product"),
				]),
			]),
		).toMatchObject({ leadId: "flywheel-eng-lead" });
	});

	it("fails loud when the engineering owner is missing", () => {
		expect(() => resolveFlagScanOwner([project([])])).toThrow(
			/exactly one Flywheel engineering Lead/,
		);
	});

	it("fails loud when the engineering owner is ambiguous", () => {
		expect(() =>
			resolveFlagScanOwner([
				project([lead("one", "engineering"), lead("two", "engineering")]),
			]),
		).toThrow(/exactly one Flywheel engineering Lead/);
	});

	it("routes Lead alerts with the resolved project's exact configured name", async () => {
		let delivered = false;
		const alerts: Array<{ projectName: string; leadId: string }> = [];
		const effects = createProductionFlagScanEffects({
			projects: [
				project([lead("flywheel-eng-lead", "engineering")], "flywheel"),
			],
			reportBaseUrl: "https://reports.test",
			store: {
				getAlertDeliveryReceipt: () =>
					delivered ? { eventId: "clock-1" } : null,
			} as never,
			alert: async (input) => {
				alerts.push({ projectName: input.projectName, leadId: input.leadId });
				delivered = true;
				return { status: "sent" } as never;
			},
		});

		expect(
			await effects.notifyLead({
				eventId: "clock-1",
				body: "clock debt",
				partIndex: 1,
				partCount: 1,
			}),
		).toEqual({ status: "done", evidence: "clock-1" });
		expect(alerts).toEqual([
			{ projectName: "flywheel", leadId: "flywheel-eng-lead" },
		]);
	});
});

describe("FLY-1781 production reconcile", () => {
	it("adopts a Linear batch when the exact run marker appears anywhere in the body", async () => {
		const client = {
			issues: async () => ({
				nodes: [
					{
						description:
							"\n<!-- flywheel:flag-governance run=weekly-1 -->\nledger",
						url: "https://linear.test/FLY-1",
					},
				],
				pageInfo: { hasNextPage: false },
			}),
		};
		expect(
			await findLinearBatch({
				client: client as never,
				teamId: "team-1",
				runToken: "weekly-1",
				createdAfter: 0,
			}),
		).toEqual({ status: "found", evidence: "https://linear.test/FLY-1" });
	});
});
