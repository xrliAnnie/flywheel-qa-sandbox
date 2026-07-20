import { describe, expect, it, vi } from "vitest";
import { nudgeLeadInboxBestEffort } from "../lead-inbox-nudge.js";

describe("FLY-1373 lead inbox doorbell", () => {
	it("posts the target Lead and project with bearer auth", async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));

		await nudgeLeadInboxBestEffort({
			bridgeUrl: "http://127.0.0.1:9876/",
			leadId: "flywheel-eng-lead",
			project: "flywheel",
			apiToken: "bridge-token",
			fetchImpl,
		});

		expect(fetchImpl).toHaveBeenCalledOnce();
		const [url, init] = fetchImpl.mock.calls[0]!;
		expect(url).toBe("http://127.0.0.1:9876/api/lead-inbox/nudge");
		expect(init?.headers).toMatchObject({
			Authorization: "Bearer bridge-token",
			"Content-Type": "application/json",
		});
		expect(JSON.parse(String(init?.body))).toEqual({
			leadId: "flywheel-eng-lead",
			project: "flywheel",
		});
	});

	it("is best-effort when the Bridge is unavailable", async () => {
		const warn = vi.fn();
		await expect(
			nudgeLeadInboxBestEffort({
				bridgeUrl: "http://127.0.0.1:9876",
				leadId: "lead-a",
				fetchImpl: async () => {
					throw new Error("connection refused");
				},
				warn,
			}),
		).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("connection refused"),
		);
	});
});
