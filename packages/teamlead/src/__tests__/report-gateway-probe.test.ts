import { expect, it, vi } from "vitest";
import { probeGatewayFormats } from "../bridge/report-gateway-probe.js";
import { createReportGatewayHandler } from "../bridge/report-gateway-runtime.js";

function fixture(failAt?: number) {
	const objects = new Map<string, Buffer>();
	const bound = {
		putRawObject: vi.fn(async (pathname: string, body: Buffer) => {
			objects.set(pathname, body);
			return {
				pathname,
				url: `https://store.private.blob.vercel-storage.com/${pathname}`,
			};
		}),
		deleteReports: vi.fn(async (tokens: readonly string[]) => {
			for (const token of tokens) objects.delete(`r/${token}/index.html`);
		}),
	};
	const handler = createReportGatewayHandler({
		get: async (path) => {
			const body = objects.get(path);
			return body
				? {
						statusCode: 200,
						stream: new Blob([body]).stream(),
						headers: new Headers(),
						blob: { uploadedAt: new Date(), etag: "fake" },
					}
				: null;
		},
		blobToken: () => "fake",
		now: Date.now,
	});
	let calls = 0;
	const request = vi.fn(async (url: string, init?: RequestInit) => {
		const token = new URL(url).pathname.split("/")[2];
		if (calls++ === failAt)
			return new Response("bad probe", { status: failAt === 3 ? 200 : 502 });
		return handler(
			new Request(`https://report.invalid/api/report?token=${token}`, init),
		);
	});
	return { objects, bound, request };
}
it("proves gzip, identity, q=0 and corrupt rejection then removes both raw probes", async () => {
	const f = fixture();
	await probeGatewayFormats({
		bound: f.bound,
		projectName: "fw-reports-abcdef",
		request: f.request,
	});
	expect(f.request).toHaveBeenCalledTimes(4);
	expect(f.bound.putRawObject).toHaveBeenCalledTimes(2);
	expect(f.bound.putRawObject.mock.calls[1]![1].length).toBeLessThan(10);
	expect(f.objects.size).toBe(0);
	expect(f.bound.deleteReports).toHaveBeenCalledTimes(1);
});
it.each([0, 1, 2, 3])(
	"fails closed and cleans probes when case %i fails",
	async (failAt) => {
		const f = fixture(failAt);
		await expect(
			probeGatewayFormats({
				bound: f.bound,
				projectName: "fw-reports-abcdef",
				request: f.request,
			}),
		).rejects.toThrow("gateway format probe");
		expect(f.objects.size).toBe(0);
		expect(f.bound.deleteReports).toHaveBeenCalledTimes(1);
	},
);
