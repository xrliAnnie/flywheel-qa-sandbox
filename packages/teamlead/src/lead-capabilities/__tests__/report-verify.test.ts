import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { LeadOperationContext } from "../broker.js";
import { createReportVerifyHandlers } from "../handlers/report-verify.js";

vi.mock("../runtime-context.js", () => ({
	createLeadCapabilityContext: () => ({ assertActivationCurrent() {} }),
}));
it("correlates report verification to the exact report and request through the fixed Bridge endpoint", async () => {
	const context: LeadOperationContext = {
		projectName: "flywheel",
		leadId: "eng",
		activationId: "a1",
		requestId: randomUUID(),
		signal: new AbortController().signal,
		assertCurrent: async () => {},
	};
	const reportId = "a".repeat(32);
	let returnedId = reportId;
	const fetchImpl = vi.fn(async () =>
		Response.json({
			requestId: context.requestId,
			status: "succeeded",
			resourceRefs: [returnedId],
			data: {
				reportId: returnedId,
				httpStatus: 200,
				cspValid: true,
				nonceValid: true,
				receiptId: context.requestId,
				observedAt: new Date().toISOString(),
			},
		}),
	) as typeof fetch;
	const handler = createReportVerifyHandlers({
		env: {
			FLYWHEEL_PROJECT_NAME: "flywheel",
			FLYWHEEL_LEAD_ID: "eng",
			FLYWHEEL_LEAD_IDENTITY_DIGEST: "a".repeat(64),
			FLYWHEEL_LEAD_CARRIER_INSTANCE_ID: "CLAIM_CANARY",
			FLYWHEEL_API_TOKEN: "TOKEN_CANARY",
			FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:3199",
		},
		activationId: "a1",
		fetchImpl,
	}).get("report.verify")!;
	expect((await handler.execute({ reportId }, context)).status).toBe(
		"succeeded",
	);
	const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!;
	expect(url).toBe(
		"http://127.0.0.1:3199/api/lead-capabilities/reports/verify",
	);
	expect(JSON.parse(init!.body as string)).toMatchObject({
		projectName: "flywheel",
		capability: {
			reportId,
			requestId: context.requestId,
			operationId: "report.verify",
			carrierClaim: "CLAIM_CANARY",
		},
	});
	returnedId = "b".repeat(32);
	expect((await handler.execute({ reportId }, context)).status).toBe("unknown");
	await expect(
		handler.authorize({ reportId, url: "https://evil.test" }, context),
	).rejects.toThrow();
	expect(fetchImpl).toHaveBeenCalledTimes(2);
});
