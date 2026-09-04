import { describe, expect, it, vi } from "vitest";
import {
	createReportGatewayHandler,
	REPORT_GATEWAY_RETENTION_MS,
	default as reportGatewayNodeHandler,
} from "../bridge/report-gateway-runtime.js";
import {
	DEFAULT_RETENTION_MAX_AGE_MS,
	injectHeadMeta,
} from "../bridge/report-registry.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const NOW = Date.parse("2026-09-03T16:00:00.000Z");

function blobHeaders(uploadedAt: Date): Headers {
	return new Headers({ "last-modified": uploadedAt.toUTCString() });
}

describe("report gateway runtime", () => {
	it("uses the same fixed 14-day contract as the publisher", () => {
		expect(REPORT_GATEWAY_RETENTION_MS).toBe(14 * 24 * 60 * 60 * 1000);
		expect(REPORT_GATEWAY_RETENTION_MS).toBe(DEFAULT_RETENTION_MAX_AGE_MS);
	});

	it("serves a private Blob through the stable report URL with the injected CSP as a response header", async () => {
		const html =
			"<html><head><meta http-equiv=\" Content-Security-Policy \" content=\"default-src 'none'; script-src 'nonce-n0nce'; style-src 'unsafe-inline'; img-src data:;\"></head><body><script nonce=\"n0nce\">ok()</script></body></html>";
		const uploadedAt = new Date(NOW - 13 * 24 * 60 * 60 * 1000);
		const get = vi.fn().mockResolvedValue({
			statusCode: 200,
			stream: new Blob([html]).stream(),
			headers: blobHeaders(uploadedAt),
			blob: {
				uploadedAt,
				etag: '"etag"',
			},
		});
		const handler = createReportGatewayHandler({
			get,
			now: () => NOW,
			blobToken: () => "blob-secret",
		});

		const response = await handler(
			new Request(
				`https://fw-reports-a1b2c3.vercel.app/api/report?token=${TOKEN}`,
			),
		);

		expect(get).toHaveBeenCalledWith(`r/${TOKEN}/index.html`, {
			access: "private",
			token: "blob-secret",
			useCache: false,
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe(
			"text/html; charset=utf-8",
		);
		expect(response.headers.get("content-security-policy")).toBe(
			"default-src 'none'; script-src 'nonce-n0nce'; style-src 'unsafe-inline'; img-src data:;",
		);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(await response.text()).toBe(html);
	});

	it("ignores CSP-looking meta tags inside HTML comments", async () => {
		const html =
			'<!-- <meta http-equiv="Content-Security-Policy" content="default-src *"> --><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"></head></html>';
		const uploadedAt = new Date(NOW - 60_000);
		const handler = createReportGatewayHandler({
			get: vi.fn().mockResolvedValue({
				statusCode: 200,
				stream: new Blob([html]).stream(),
				headers: blobHeaders(uploadedAt),
				blob: { uploadedAt, etag: '"etag"' },
			}),
			now: () => NOW,
			blobToken: () => "blob-secret",
		});

		const response = await handler(
			new Request(
				`https://fw-reports-a1b2c3.vercel.app/api/report?token=${TOKEN}`,
			),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-security-policy")).toBe(
			"default-src 'none'",
		);
	});

	it("keeps scanning a CSP meta tag when a quoted attribute contains >", async () => {
		const html =
			'<html><head><meta data-note="a > b" http-equiv="Content-Security-Policy" content="default-src \'none\'"></head></html>';
		const uploadedAt = new Date(NOW - 60_000);
		const handler = createReportGatewayHandler({
			get: vi.fn().mockResolvedValue({
				statusCode: 200,
				stream: new Blob([html]).stream(),
				headers: blobHeaders(uploadedAt),
				blob: { uploadedAt, etag: '"etag"' },
			}),
			now: () => NOW,
			blobToken: () => "blob-secret",
		});

		const response = await handler(
			new Request(
				`https://fw-reports-a1b2c3.vercel.app/api/report?token=${TOKEN}`,
			),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-security-policy")).toBe(
			"default-src 'none'",
		);
	});

	it("matches publisher scanning for commented and quote-disguised CSP meta", async () => {
		const published = injectHeadMeta(
			'<!-- <meta http-equiv="Content-Security-Policy" content="default-src *"> --><html><head><meta data-note="a > b" http-equiv="Content-Security-Policy" content="default-src \'none\'"></head><body></body></html>',
		);
		const uploadedAt = new Date(NOW - 60_000);
		const handler = createReportGatewayHandler({
			get: vi.fn().mockResolvedValue({
				statusCode: 200,
				stream: new Blob([published]).stream(),
				headers: blobHeaders(uploadedAt),
				blob: { uploadedAt, etag: '"etag"' },
			}),
			now: () => NOW,
			blobToken: () => "blob-secret",
		});

		const response = await handler(
			new Request(
				`https://fw-reports-a1b2c3.vercel.app/api/report?token=${TOKEN}`,
			),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-security-policy")).toBe(
			"default-src 'none'",
		);
		expect(await response.text()).toBe(published);
	});

	it("exports the Node handler contract used by a raw Vercel /api function", async () => {
		const headers = new Map<string, string>();
		let body: Uint8Array | undefined;
		const response = {
			statusCode: 0,
			setHeader: vi.fn((name: string, value: string) => {
				headers.set(name.toLowerCase(), value);
			}),
			end: vi.fn((value?: Uint8Array) => {
				body = value;
			}),
		};

		await reportGatewayNodeHandler(
			{ url: "/api/report?token=invalid", headers: {} },
			response,
		);

		expect(response.statusCode).toBe(404);
		expect(headers.get("content-type")).toContain("text/plain");
		expect(new TextDecoder().decode(body)).toBe("Not found");
		expect(response.end).toHaveBeenCalledOnce();
	});

	it("returns 404 at the exact 14-day boundary using Blob object metadata", async () => {
		const uploadedAt = new Date(NOW - 14 * 24 * 60 * 60 * 1000);
		const get = vi.fn().mockResolvedValue({
			statusCode: 200,
			stream: new Blob([
				'<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"></head></html>',
			]).stream(),
			headers: blobHeaders(uploadedAt),
			blob: {
				uploadedAt,
				etag: '"etag"',
			},
		});
		const handler = createReportGatewayHandler({
			get,
			now: () => NOW,
			blobToken: () => "blob-secret",
		});

		const response = await handler(
			new Request(
				`https://fw-reports-a1b2c3.vercel.app/api/report?token=${TOKEN}`,
			),
		);

		expect(response.status).toBe(404);
	});

	it("uses Blob get uploadedAt directly when last-modified is absent", async () => {
		const html =
			'<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"></head></html>';
		const handler = createReportGatewayHandler({
			get: vi.fn().mockResolvedValue({
				statusCode: 200,
				stream: new Blob([html]).stream(),
				headers: new Headers(),
				blob: {
					uploadedAt: new Date(NOW - REPORT_GATEWAY_RETENTION_MS),
					etag: '"etag"',
				},
			}),
			now: () => NOW,
			blobToken: () => "blob-secret",
		});

		const response = await handler(
			new Request(
				`https://fw-reports-a1b2c3.vercel.app/api/report?token=${TOKEN}`,
			),
		);

		expect(response.status).toBe(404);
	});

	it("does not log the Blob credential when uploadedAt access fails", async () => {
		const blobCredential = "blob-secret";
		const logError = vi.fn();
		const blob = {
			etag: '"etag"',
			get uploadedAt(): Date {
				throw new Error(`Blob metadata exposed credential ${blobCredential}`);
			},
		};
		const handler = createReportGatewayHandler({
			get: vi.fn().mockResolvedValue({
				statusCode: 200,
				stream: new Blob(["<html><head></head></html>"]).stream(),
				headers: new Headers(),
				blob,
			}),
			now: () => NOW,
			blobToken: () => blobCredential,
			logError,
		});

		const response = await handler(
			new Request(
				`https://fw-reports-a1b2c3.vercel.app/api/report?token=${TOKEN}`,
			),
		);

		expect(response.status).toBe(502);
		expect(logError).toHaveBeenCalledWith(
			expect.stringContaining("unable to read Blob uploadedAt"),
		);
		expect(logError.mock.calls.flat().join(" ")).not.toContain(blobCredential);
	});

	it("returns an explicit 502 when a stored multiline CSP cannot become a response header", async () => {
		const html =
			"<html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none';\nstyle-src 'unsafe-inline'\"></head></html>";
		const uploadedAt = new Date(NOW - 60_000);
		const handler = createReportGatewayHandler({
			get: vi.fn().mockResolvedValue({
				statusCode: 200,
				stream: new Blob([html]).stream(),
				headers: blobHeaders(uploadedAt),
				blob: { uploadedAt, etag: '"etag"' },
			}),
			now: () => NOW,
			blobToken: () => "blob-secret",
		});

		const response = await handler(
			new Request(
				`https://fw-reports-a1b2c3.vercel.app/api/report?token=${TOKEN}`,
			),
		);

		expect(response.status).toBe(502);
		expect(await response.text()).toBe("Report storage unavailable");
	});

	it("logs and rejects service when neither Blob response nor metadata has a trustworthy createdAt", async () => {
		const logError = vi.fn();
		const handler = createReportGatewayHandler({
			get: vi.fn().mockResolvedValue({
				statusCode: 200,
				stream: new Blob(["<html><head></head></html>"]).stream(),
				headers: new Headers(),
				blob: { uploadedAt: new Date(Number.NaN), etag: '"etag"' },
			}),
			now: () => NOW,
			blobToken: () => "blob-secret",
			logError,
		});

		const response = await handler(
			new Request(
				`https://fw-reports-a1b2c3.vercel.app/api/report?token=${TOKEN}`,
			),
		);

		expect(response.status).toBe(502);
		expect(logError).toHaveBeenCalledWith(
			expect.stringContaining("no authoritative createdAt"),
		);
		expect(logError.mock.calls.flat().join(" ")).not.toContain(TOKEN);
	});

	it("uses original creation time for migrated links instead of extending them at cutover", async () => {
		const get = vi.fn().mockResolvedValue({
			statusCode: 200,
			stream: new Blob([
				'<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"></head></html>',
			]).stream(),
			headers: blobHeaders(new Date(NOW - 60_000)),
			blob: {
				uploadedAt: new Date(NOW - 60_000),
				etag: '"etag"',
			},
		});
		const handler = createReportGatewayHandler({
			get,
			now: () => NOW,
			blobToken: () => "blob-secret",
			migratedCreatedAt: {
				[TOKEN]: new Date(NOW - (14 * 24 + 1) * 60 * 60 * 1000).toISOString(),
			},
		});

		expect(
			(
				await handler(
					new Request(
						`https://fw-reports-a1b2c3.vercel.app/api/report?token=${TOKEN}`,
					),
				)
			).status,
		).toBe(404);
	});

	it("fails closed for invalid tokens, missing credentials, and missing CSP", async () => {
		const get = vi.fn();
		const invalid = createReportGatewayHandler({
			get,
			now: () => NOW,
			blobToken: () => "blob-secret",
		});
		expect(
			(
				await invalid(
					new Request(
						"https://fw-reports-a1b2c3.vercel.app/api/report?token=../secret",
					),
				)
			).status,
		).toBe(404);
		expect(get).not.toHaveBeenCalled();

		const missingCredential = createReportGatewayHandler({
			get,
			now: () => NOW,
			blobToken: () => undefined,
		});
		expect(
			(
				await missingCredential(
					new Request(
						`https://fw-reports-a1b2c3.vercel.app/api/report?token=${TOKEN}`,
					),
				)
			).status,
		).toBe(503);

		const noCsp = createReportGatewayHandler({
			get: vi.fn().mockResolvedValue({
				statusCode: 200,
				stream: new Blob(["<html><head></head></html>"]).stream(),
				headers: blobHeaders(new Date(NOW)),
				blob: { uploadedAt: new Date(NOW), etag: '"etag"' },
			}),
			now: () => NOW,
			blobToken: () => "blob-secret",
		});
		expect(
			(
				await noCsp(
					new Request(
						`https://fw-reports-a1b2c3.vercel.app/api/report?token=${TOKEN}`,
					),
				)
			).status,
		).toBe(502);
	});
});
