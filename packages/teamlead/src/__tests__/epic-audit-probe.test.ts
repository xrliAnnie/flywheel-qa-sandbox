import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { probeEpicAuditGateway } from "../bridge/epic-page-publisher.js";

const json = '{"entries":[]}';
const sha = createHash("sha256").update(json).digest("hex");
const url = `https://fw-reports-test.vercel.app/r/${"1".repeat(32)}/${sha}/index.audit.json`;
it("requires exact JSON hash and an unredirected 200 response", async () => {
	const request = vi
		.fn()
		.mockResolvedValue(
			new Response(json, { headers: { "content-type": "application/json" } }),
		);
	expect(await probeEpicAuditGateway(url, sha, request)).toBe(true);
	expect(request).toHaveBeenCalledWith(
		url,
		expect.objectContaining({
			redirect: "error",
			signal: expect.any(AbortSignal),
		}),
	);
});
it.each([
	new Response("old HTML"),
	new Response(json, { status: 404 }),
	new Response("different", {
		headers: { "content-type": "application/json" },
	}),
])(
	"fails closed on missing, old or mismatched gateway response",
	async (response) => {
		expect(
			await probeEpicAuditGateway(
				url,
				sha,
				vi.fn().mockResolvedValue(response),
			),
		).toBe(false);
	},
);
it("fails closed on timeout or transport rejection", async () => {
	expect(
		await probeEpicAuditGateway(
			url,
			sha,
			vi.fn().mockRejectedValue(new Error("timeout")),
		),
	).toBe(false);
});
