import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SqliteJournalStore } from "../../lead-backends/codex/SqliteJournalStore.js";
import { LeadCapabilityBroker } from "../broker.js";
import { createReportDeliverHandlers } from "../handlers/report-deliver.js";

vi.mock("../runtime-context.js", () => ({
	createLeadCapabilityContext: () => ({ assertActivationCurrent() {} }),
}));
it("reconciles an uncertain delivery only through the read-only receipt route after journal restart", async () => {
	const root = mkdtempSync(join(tmpdir(), "report-deliver-parent-"));
	let journal = new SqliteJournalStore(join(root, "journal.db"));
	const requestId = randomUUID(),
		reportId = "a".repeat(32);
	const urls: string[] = [];
	const fetchImpl = vi.fn(async (url) => {
		urls.push(String(url));
		if (String(url).endsWith("/deliver")) throw new Error("lost response");
		return Response.json({
			requestId,
			status: "succeeded",
			resourceRefs: ["12345678901234567"],
			data: {
				reportId,
				messageId: "12345678901234567",
				channelId: "22345678901234567",
				delivery: "link-only",
				receiptId: requestId,
				observedAt: new Date().toISOString(),
			},
		});
	}) as typeof fetch;
	const make = () =>
		new LeadCapabilityBroker({
			projectName: "flywheel",
			leadId: "eng",
			activationId: "a1",
			receipts: journal.operationReceipts,
			allowedOperationIds: () => new Set(["report.deliver"]),
			assertCurrent: async () => {},
			secrets: [],
			handlers: createReportDeliverHandlers({
				env: {
					FLYWHEEL_PROJECT_NAME: "flywheel",
					FLYWHEEL_LEAD_ID: "eng",
					FLYWHEEL_LEAD_IDENTITY_DIGEST: "a".repeat(64),
					FLYWHEEL_LEAD_CARRIER_INSTANCE_ID: "CLAIM",
					FLYWHEEL_API_TOKEN: "TOKEN",
					FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:3199",
				},
				activationId: "a1",
				fetchImpl,
			}),
		});
	let broker = make();
	const request = {
		schemaVersion: 1,
		operationId: "report.deliver",
		requestId,
		input: { reportId, issueId: "FLY-2519" },
	};
	try {
		expect((await broker.execute(request)).status).toBe("unknown");
		await broker.close();
		journal.close();
		journal = new SqliteJournalStore(join(root, "journal.db"));
		broker = make();
		expect((await broker.execute(request)).status).toBe("succeeded");
		expect(urls).toEqual([
			"http://127.0.0.1:3199/api/lead-capabilities/reports/deliver",
			"http://127.0.0.1:3199/api/lead-capabilities/reports/delivery-receipt",
		]);
		expect(
			(
				await broker.execute({
					...request,
					input: { ...request.input, issueId: "FLY-2" },
				})
			).status,
		).toBe("rejected");
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	} finally {
		await broker.close();
		journal.close();
		rmSync(root, { recursive: true, force: true });
	}
});
