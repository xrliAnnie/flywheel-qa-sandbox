import { EventEmitter } from "node:events";
import type { request as httpsRequest } from "node:https";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { receiptZip } from "../../bridge/__tests__/beta-release-zip-fixture.js";
import {
	downloadGithubRunLogZip,
	parseGithubRunLogZip,
} from "../handlers/github-run-log.js";

it("reads bounded UTF-8 log entries in memory in stable filename order", async () => {
	const zip = receiptZip([
		{ name: "job/2.txt", data: "second\n" },
		{ name: "job/1.txt", data: "first\n", compress: true },
	]);
	expect(await parseGithubRunLogZip(zip, new AbortController().signal)).toBe(
		"--- job/1.txt ---\nfirst\n\n--- job/2.txt ---\nsecond\n",
	);
});
it.each(
	[
		[{ name: "../evil.txt", data: "x" }],
		[{ name: "/evil.txt", data: "x" }],
		[{ name: "link.txt", data: "x", mode: 0o120777 }],
		[{ name: "encrypted.txt", data: "x", flags: 1 }],
		[{ name: "bomb.txt", data: "x".repeat(300000), compress: true }],
		[
			{ name: "same.txt", data: "x" },
			{ name: "same.txt", data: "y" },
		],
		[{ name: "small.txt", data: "abc", size: 1 }],
		Array.from({ length: 513 }, (_, i) => ({ name: `${i}.txt`, data: "x" })),
	].map((entries) => [entries]),
)("rejects hostile archive %#", async (entries) => {
	await expect(
		parseGithubRunLogZip(receiptZip(entries), new AbortController().signal),
	).rejects.toThrow("github_log_archive_invalid");
});

it("pins public DNS address with original TLS SNI and sends no provider credentials", async () => {
	const payload = receiptZip([{ name: "log.txt", data: "hello" }]);
	const request = vi.fn(
		(
			_options: Record<string, unknown>,
			callback: (response: unknown) => void,
		) => {
			const req = Object.assign(new EventEmitter(), {
				end: () => {
					const response = Object.assign(new PassThrough(), {
						statusCode: 200,
						headers: {},
					});
					callback(response);
					response.end(payload);
				},
				destroy: vi.fn(),
			});
			return req;
		},
	);
	const zip = await downloadGithubRunLogZip(
		"https://productionresultssa1.blob.core.windows.net/logs/archive.zip?sig=SIGNED_CANARY",
		new AbortController().signal,
		{
			lookup: async () => [{ address: "8.8.8.8", family: 4 }],
			request: request as unknown as typeof httpsRequest,
		},
	);
	expect(zip).toEqual(payload);
	expect(request).toHaveBeenCalledWith(
		expect.objectContaining({
			hostname: "8.8.8.8",
			servername: "productionresultssa1.blob.core.windows.net",
			port: 443,
			agent: false,
			rejectUnauthorized: true,
			headers: {
				Host: "productionresultssa1.blob.core.windows.net",
				Accept: "application/zip",
			},
		}),
		expect.any(Function),
	);
});
it.each([
	"http://productionresultssa1.blob.core.windows.net/a",
	"https://user:secret@productionresultssa1.blob.core.windows.net/a",
	"https://productionresultssa1.blob.core.windows.net.evil.test/a",
	"https://evil.test/a",
	"https://productionresultssa1.blob.core.windows.net:444/a",
])(
	"rejects untrusted archive destination %s before connection",
	async (location) => {
		const request = vi.fn();
		await expect(
			downloadGithubRunLogZip(location, new AbortController().signal, {
				request: request as unknown as typeof httpsRequest,
			}),
		).rejects.toThrow("github_log_archive_invalid");
		expect(request).not.toHaveBeenCalled();
	},
);
it("rejects a private or mixed DNS answer without connecting", async () => {
	const request = vi.fn();
	await expect(
		downloadGithubRunLogZip(
			"https://productionresultssa1.blob.core.windows.net/a",
			new AbortController().signal,
			{
				lookup: async () => [
					{ address: "8.8.8.8", family: 4 },
					{ address: "127.0.0.1", family: 4 },
				],
				request: request as unknown as typeof httpsRequest,
			},
		),
	).rejects.toThrow("github_log_archive_invalid");
	expect(request).not.toHaveBeenCalled();
});
it.each([302, 500, 200])(
	"rejects storage redirects/errors/oversize response %s without retry",
	async (statusCode) => {
		const request = vi.fn(
			(_options: unknown, callback: (response: unknown) => void) =>
				Object.assign(new EventEmitter(), {
					destroy: vi.fn(),
					end: () => {
						const response = Object.assign(new PassThrough(), {
							statusCode,
							headers:
								statusCode === 200
									? { "content-length": String(8 * 1024 * 1024 + 1) }
									: { location: "https://evil.test/?secret=CANARY" },
						});
						callback(response);
						response.end();
					},
				}),
		);
		await expect(
			downloadGithubRunLogZip(
				"https://productionresultssa1.blob.core.windows.net/a",
				new AbortController().signal,
				{
					lookup: async () => [{ address: "8.8.8.8", family: 4 }],
					request: request as unknown as typeof httpsRequest,
				},
			),
		).rejects.toThrow("github_log_archive_invalid");
		expect(request).toHaveBeenCalledTimes(1);
	},
);
it("rejects observed compressed overflow even without content-length", async () => {
	const request = vi.fn(
		(_options: unknown, callback: (response: unknown) => void) =>
			Object.assign(new EventEmitter(), {
				destroy: vi.fn(),
				end: () => {
					const response = Object.assign(new PassThrough(), {
						statusCode: 200,
						headers: {},
					});
					callback(response);
					response.end(Buffer.alloc(8 * 1024 * 1024 + 1));
				},
			}),
	);
	await expect(
		downloadGithubRunLogZip(
			"https://productionresultssa1.blob.core.windows.net/a",
			new AbortController().signal,
			{
				lookup: async () => [{ address: "8.8.8.8", family: 4 }],
				request: request as unknown as typeof httpsRequest,
			},
		),
	).rejects.toThrow("github_log_archive_invalid");
});
it("closes an in-flight download on abort without leaking signed URLs", async () => {
	const stop = new AbortController();
	const destroy = vi.fn();
	const request = vi.fn(() =>
		Object.assign(new EventEmitter(), { destroy, end: () => stop.abort() }),
	);
	await expect(
		downloadGithubRunLogZip(
			"https://productionresultssa1.blob.core.windows.net/a?sig=CANARY",
			stop.signal,
			{
				lookup: async () => [{ address: "8.8.8.8", family: 4 }],
				request: request as unknown as typeof httpsRequest,
			},
		),
	).rejects.toThrow("github_log_archive_invalid");
	expect(destroy).toHaveBeenCalledTimes(1);
});
it("aborts a stalled DNS lookup before a connection is allocated", async () => {
	const stop = new AbortController(),
		request = vi.fn();
	const operation = downloadGithubRunLogZip(
		"https://productionresultssa1.blob.core.windows.net/a",
		stop.signal,
		{
			lookup: () => new Promise(() => {}),
			request: request as unknown as typeof httpsRequest,
		},
	);
	stop.abort();
	await expect(operation).rejects.toThrow("github_log_archive_invalid");
	expect(request).not.toHaveBeenCalled();
}, 300);
it("rejects strong-encryption flag independently of traditional encryption", async () => {
	await expect(
		parseGithubRunLogZip(
			receiptZip([{ name: "encrypted.txt", data: "x", flags: 64 }]),
			new AbortController().signal,
		),
	).rejects.toThrow("github_log_archive_invalid");
});
