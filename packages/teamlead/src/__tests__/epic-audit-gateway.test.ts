import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
	createReportGatewayHandler,
	REPORT_GATEWAY_RETENTION_MS,
} from "../bridge/report-gateway-runtime.js";
import { injectHeadMeta } from "../bridge/report-registry.js";

const token = "1".repeat(32);
const json = '{"entries":["<img src=x onerror=alert(1)>"]}';
const hash = createHash("sha256").update(json).digest("hex");
const now = Date.parse("2026-09-10T00:00:00Z");
function fixture(age = 0, audit = json) {
	const get = vi.fn(async (path: string) => ({
		statusCode: 200,
		stream: new Response(
			path.endsWith(".json")
				? audit
				: injectHeadMeta("<html><head></head><body>epic</body></html>"),
		).body,
		headers: new Headers(),
		blob: { uploadedAt: new Date(now - age), etag: "etag" },
	}));
	return {
		get,
		handler: createReportGatewayHandler({
			get,
			now: () => now,
			blobToken: () => "secret",
		}),
	};
}
it("serves the exact audit as JSON with restrictive headers through the same token", async () => {
	const f = fixture();
	const res = await f.handler(
		new Request(`https://report/api/report?token=${token}&audit=${hash}`),
	);
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toBe(
		"application/json; charset=utf-8",
	);
	expect(res.headers.get("x-content-type-options")).toBe("nosniff");
	expect(res.headers.get("content-security-policy")).toBe(
		"default-src 'none'; frame-ancestors 'none'",
	);
	expect(await res.text()).toBe(json);
	expect(f.get.mock.calls.map((c) => c[0])).toEqual([
		`r/${token}/index.html`,
		`r/${token}/${hash}/index.audit.json`,
	]);
});
it.each(["../index.html", "A".repeat(64), "1".repeat(63), "", "1".repeat(65)])(
	"rejects invalid audit selector %s before storage access",
	async (selector) => {
		const f = fixture();
		const res = await f.handler(
			new Request(
				`https://report/api/report?token=${token}&audit=${encodeURIComponent(selector)}`,
			),
		);
		expect(res.status).toBe(404);
		expect(f.get).not.toHaveBeenCalled();
	},
);
it("rejects expired HTML and audit at the same report TTL", async () => {
	const f = fixture(REPORT_GATEWAY_RETENTION_MS);
	expect(
		(
			await f.handler(
				new Request(`https://report/api/report?token=${token}&audit=${hash}`),
			)
		).status,
	).toBe(404);
	expect(f.get).toHaveBeenCalledTimes(2);
});
it("fails closed on content hash mismatch", async () => {
	const f = fixture(0, "changed");
	expect(
		(
			await f.handler(
				new Request(`https://report/api/report?token=${token}&audit=${hash}`),
			)
		).status,
	).toBe(502);
});
it("allows a first-publication audit probe before the HTML exists", async () => {
	const f = fixture();
	f.get.mockResolvedValueOnce(null as never);
	const res = await f.handler(
		new Request(`https://report/api/report?token=${token}&audit=${hash}`),
	);
	expect(res.status).toBe(200);
	expect(await res.text()).toBe(json);
});
it("allows a fresh replacement audit to recover an expired stable page", async () => {
	const f = fixture();
	f.get.mockResolvedValueOnce({
		statusCode: 200,
		stream: new Response("old").body,
		headers: new Headers(),
		blob: {
			uploadedAt: new Date(now - REPORT_GATEWAY_RETENTION_MS),
			etag: "old",
		},
	});
	const res = await f.handler(
		new Request(`https://report/api/report?token=${token}&audit=${hash}`),
	);
	expect(res.status).toBe(200);
	expect(await res.text()).toBe(json);
});
