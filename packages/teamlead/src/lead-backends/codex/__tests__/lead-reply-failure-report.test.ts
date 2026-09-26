import { describe, expect, it, vi } from "vitest";
import type { JournalEntry } from "../LeadJournal.js";
import {
	createLeadReplyFailureReporter,
	resolveReplyFailureBridge,
} from "../lead-reply-failure-report.js";

const entry = (over: Partial<JournalEntry> = {}): JournalEntry => ({
	id: "5f0c2c4e-0b1f-4c2e-9d61-3f9b8f0d2a11",
	idempotencyKey: "mailbox-batch:v#r0",
	source: "mailbox",
	payload: "[voice]",
	state: "dead_letter",
	reason: "empty_final_answer",
	createdAt: 1,
	updatedAt: 2,
	...over,
});

function setup(over: { bridgeUrl?: string; apiToken?: string } = {}) {
	const fetchImpl = vi.fn(
		async () => new Response(JSON.stringify({ status: "voice_notified" })),
	);
	const logger = { warn: vi.fn() };
	const report = createLeadReplyFailureReporter({
		bridgeUrl: "http://127.0.0.1:9876/",
		apiToken: "tok",
		projectName: "flywheel-test",
		leadId: "flywheel-test-1",
		chatChannelId: "100000000000000001",
		fetchImpl: fetchImpl as unknown as typeof fetch,
		logger,
		...over,
	});
	return { fetchImpl, logger, report };
}

describe("FLY-2862 Codex Lead reply-failure report", () => {
	it("posts the failed entry's reply thread to the Bridge with the API token", async () => {
		const { fetchImpl, report } = setup();
		await report(
			entry({ replyChannelId: "100000000000000011" }),
			"empty_final_answer",
		);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe("http://127.0.0.1:9876/api/lead-outbound/reply-failed");
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>).authorization).toBe(
			"Bearer tok",
		);
		expect(JSON.parse(init.body as string)).toEqual({
			projectName: "flywheel-test",
			leadId: "flywheel-test-1",
			channelId: "100000000000000011",
			idempotencyKey: "5f0c2c4e-0b1f-4c2e-9d61-3f9b8f0d2a11",
			reason: "empty_final_answer",
		});
	});

	it("falls back to the Lead's chat channel when the entry had no reply route", async () => {
		const { fetchImpl, report } = setup();
		await report(entry(), "empty_final_answer");
		const init = (
			fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
		)[1];
		expect(JSON.parse(init.body as string).channelId).toBe(
			"100000000000000001",
		);
	});

	it("logs instead of throwing when the Bridge is unconfigured, rejects, or is down", async () => {
		const unconfigured = setup({ bridgeUrl: "" });
		await unconfigured.report(entry(), "empty_final_answer");
		expect(unconfigured.fetchImpl).not.toHaveBeenCalled();
		expect(unconfigured.logger.warn).toHaveBeenCalledWith(
			"lead_reply_failed_unreported",
			expect.objectContaining({ why: "bridge_unconfigured" }),
		);

		const rejected = setup();
		rejected.fetchImpl.mockResolvedValueOnce(
			new Response("{}", { status: 400 }),
		);
		await rejected.report(entry(), "empty_final_answer");
		expect(rejected.logger.warn).toHaveBeenCalledWith(
			"lead_reply_failed_unreported",
			expect.objectContaining({ why: "http_400" }),
		);

		const down = setup();
		down.fetchImpl.mockRejectedValueOnce(new Error("ECONNREFUSED"));
		await expect(
			down.report(entry(), "empty_final_answer"),
		).resolves.toBeUndefined();
		expect(down.logger.warn).toHaveBeenCalledWith(
			"lead_reply_failed_unreported",
			expect.objectContaining({ why: "ECONNREFUSED" }),
		);
	});

	it("resolves the Bridge from runtime config first, then the Lead pane's env", () => {
		expect(
			resolveReplyFailureBridge(
				{ bridgeUrl: "http://cfg", apiToken: "cfg-tok" },
				{ BRIDGE_URL: "http://env", TEAMLEAD_API_TOKEN: "env-tok" },
			),
		).toEqual({ bridgeUrl: "http://cfg", apiToken: "cfg-tok" });
		expect(
			resolveReplyFailureBridge(
				{ bridgeUrl: "", apiToken: "" },
				{ BRIDGE_URL: "http://env", TEAMLEAD_API_TOKEN: "env-tok" },
			),
		).toEqual({ bridgeUrl: "http://env", apiToken: "env-tok" });
	});
});
