import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
	REPORT_BLOB_SWEEP_INTERVAL_MS,
	VercelBlobReportStore,
} from "../bridge/report-blob-store.js";

describe("VercelBlobReportStore", () => {
	it("uploads exactly one deterministic private HTML object per report", async () => {
		const put = vi.fn().mockResolvedValue({
			pathname: "r/0123456789abcdef0123456789abcdef/index.html",
			url: "https://store.private.blob.vercel-storage.com/r/0123456789abcdef0123456789abcdef/index.html",
		});
		const store = new VercelBlobReportStore("blob-secret", {
			put,
			list: vi.fn(),
			del: vi.fn(),
		});

		const result = await store.putReport(
			"0123456789abcdef0123456789abcdef",
			"<html><head></head><body>menu</body></html>",
		);

		expect(put).toHaveBeenCalledOnce();
		expect(put).toHaveBeenCalledWith(
			"r/0123456789abcdef0123456789abcdef/index.html",
			"<html><head></head><body>menu</body></html>",
			{
				access: "private",
				addRandomSuffix: false,
				allowOverwrite: false,
				cacheControlMaxAge: 60,
				contentType: "text/html; charset=utf-8",
				token: "blob-secret",
			},
		);
		expect(result.pathname).toBe(
			"r/0123456789abcdef0123456789abcdef/index.html",
		);
	});

	it("allows overwrite only for a stable Epic page object", async () => {
		const token = "0123456789abcdef0123456789abcdef";
		const put = vi.fn().mockResolvedValue({
			pathname: `r/${token}/index.html`,
			url: `https://store.private.blob.vercel-storage.com/r/${token}/index.html`,
		});
		const store = new VercelBlobReportStore("blob-secret", {
			put,
			list: vi.fn(),
			del: vi.fn(),
		});

		await store.putEpicPage(
			token,
			"<html><head></head><body>epic</body></html>",
		);

		expect(put).toHaveBeenCalledWith(
			`r/${token}/index.html`,
			"<html><head></head><body>epic</body></html>",
			expect.objectContaining({ allowOverwrite: true }),
		);
	});

	it("deletes only report objects whose Blob metadata is at least 14 days old", async () => {
		const now = Date.parse("2026-09-03T16:00:00.000Z");
		const list = vi
			.fn()
			.mockResolvedValueOnce({
				blobs: [
					{
						pathname: "r/11111111111111111111111111111111/index.html",
						uploadedAt: new Date(now - 13 * 24 * 60 * 60 * 1000),
					},
					{
						pathname: "r/22222222222222222222222222222222/index.html",
						uploadedAt: new Date(now - 14 * 24 * 60 * 60 * 1000),
					},
				],
				hasMore: true,
				cursor: "page-2",
			})
			.mockResolvedValueOnce({
				blobs: [
					{
						pathname: "r/33333333333333333333333333333333/index.html",
						uploadedAt: new Date(now - 15 * 24 * 60 * 60 * 1000),
					},
					{
						pathname: "unrelated/object.html",
						uploadedAt: new Date(now - 30 * 24 * 60 * 60 * 1000),
					},
				],
				hasMore: false,
			});
		const del = vi.fn().mockResolvedValue(undefined);
		const store = new VercelBlobReportStore("blob-secret", {
			put: vi.fn(),
			list,
			del,
		});

		const removed = await store.sweepExpiredReports(now);

		expect(removed).toBe(2);
		expect(list).toHaveBeenNthCalledWith(1, {
			cursor: undefined,
			limit: 1000,
			mode: "expanded",
			prefix: "r/",
			token: "blob-secret",
		});
		expect(list).toHaveBeenNthCalledWith(2, {
			cursor: "page-2",
			limit: 1000,
			mode: "expanded",
			prefix: "r/",
			token: "blob-secret",
		});
		expect(del).toHaveBeenCalledOnce();
		expect(del).toHaveBeenCalledWith(
			[
				"r/22222222222222222222222222222222/index.html",
				"r/33333333333333333333333333333333/index.html",
			],
			{ token: "blob-secret" },
		);
	});

	it("ages migrated objects from their original registry createdAt", async () => {
		const now = Date.parse("2026-09-03T16:00:00.000Z");
		const token = "44444444444444444444444444444444";
		const pathname = `r/${token}/index.html`;
		const del = vi.fn().mockResolvedValue(undefined);
		const store = new VercelBlobReportStore("blob-secret", {
			put: vi.fn(),
			list: vi.fn().mockResolvedValue({
				blobs: [
					{
						pathname,
						uploadedAt: new Date(now - 24 * 60 * 60 * 1000),
					},
				],
				hasMore: false,
			}),
			del,
		});

		const removed = await store.sweepExpiredReports(now, {
			[token]: new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString(),
		});

		expect(removed).toBe(1);
		expect(del).toHaveBeenCalledWith([pathname], { token: "blob-secret" });
	});

	it("falls back to old Blob metadata before deleting an object with malformed original creation metadata", async () => {
		const now = Date.parse("2026-09-03T16:00:00.000Z");
		const token = "55555555555555555555555555555555";
		const pathname = `r/${token}/index.html`;
		const del = vi.fn().mockResolvedValue(undefined);
		const store = new VercelBlobReportStore("blob-secret", {
			put: vi.fn(),
			list: vi.fn().mockResolvedValue({
				blobs: [
					{
						pathname,
						uploadedAt: new Date(now - 14 * 24 * 60 * 60 * 1000),
					},
				],
				hasMore: false,
			}),
			del,
		});

		const removed = await store.sweepExpiredReports(now, {
			[token]: "not-a-date",
		});

		expect(removed).toBe(1);
		expect(del).toHaveBeenCalledWith([pathname], { token: "blob-secret" });
	});

	it("keeps an object whose Blob metadata is younger when original creation metadata is malformed", async () => {
		const now = Date.parse("2026-09-03T16:00:00.000Z");
		const token = "66666666666666666666666666666666";
		const del = vi.fn().mockResolvedValue(undefined);
		const store = new VercelBlobReportStore("blob-secret", {
			put: vi.fn(),
			list: vi.fn().mockResolvedValue({
				blobs: [
					{
						pathname: `r/${token}/index.html`,
						uploadedAt: new Date(now - 13 * 24 * 60 * 60 * 1000),
					},
				],
				hasMore: false,
			}),
			del,
		});

		const removed = await store.sweepExpiredReports(now, {
			[token]: "not-a-date",
		});

		expect(removed).toBe(0);
		expect(del).not.toHaveBeenCalled();
	});

	it("keeps objects with no authoritative timestamp and emits one credential-safe warning", async () => {
		const now = Date.parse("2026-09-03T16:00:00.000Z");
		const firstToken = "77777777777777777777777777777777";
		const secondToken = "88888888888888888888888888888888";
		const del = vi.fn().mockResolvedValue(undefined);
		const warn = vi.fn();
		const store = new VercelBlobReportStore(
			"blob-secret",
			{
				put: vi.fn(),
				list: vi.fn().mockResolvedValue({
					blobs: [
						{
							pathname: `r/${firstToken}/index.html`,
							uploadedAt: new Date("not-a-date"),
						},
						{
							pathname: `r/${secondToken}/index.html`,
							uploadedAt: new Date("not-a-date"),
						},
					],
					hasMore: false,
				}),
				del,
			},
			warn,
		);

		expect(
			await store.sweepExpiredReports(now, {
				[firstToken]: "not-a-date",
				[secondToken]: "also-not-a-date",
			}),
		).toBe(0);
		expect(
			await store.sweepExpiredReports(now, {
				[firstToken]: "not-a-date",
				[secondToken]: "also-not-a-date",
			}),
		).toBe(0);
		expect(del).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledOnce();
		expect(warn.mock.calls.flat().join(" ")).not.toContain("blob-secret");
	});

	it("fails closed if the configured store returns a public Blob URL", async () => {
		const store = new VercelBlobReportStore("blob-secret", {
			put: vi.fn().mockResolvedValue({
				pathname: "r/0123456789abcdef0123456789abcdef/index.html",
				url: "https://store.public.blob.vercel-storage.com/r/0123456789abcdef0123456789abcdef/index.html",
			}),
			list: vi.fn(),
			del: vi.fn(),
		});

		await expect(
			store.putReport(
				"0123456789abcdef0123456789abcdef",
				"<html><head></head></html>",
			),
		).rejects.toThrow("private Vercel Blob");
	});
});

it("deletes report HTML in one call without listing per-token audit objects", async () => {
	const list = vi.fn().mockResolvedValue({ blobs: [], hasMore: false });
	const del = vi.fn();
	const store = new VercelBlobReportStore("fake", { put: vi.fn(), list, del });
	const tokens = ["1".repeat(32), "2".repeat(32)];
	await store.deleteReports(tokens);
	expect(list).not.toHaveBeenCalled();
	expect(del).toHaveBeenCalledExactlyOnceWith(
		tokens.map((t) => `r/${t}/index.html`),
		{ token: "fake" },
	);
});

it("uses a daily report Blob sweep interval", () => {
	expect(REPORT_BLOB_SWEEP_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
});

it("compresses HTML only when the verified gateway format enables gzip", async () => {
	const token = "a".repeat(32);
	const put = vi.fn(async (pathname: string) => ({
		pathname,
		url: `https://store.private.blob.vercel-storage.com/${pathname}`,
	}));
	const store = new VercelBlobReportStore("fake", {
		put,
		list: vi.fn(),
		del: vi.fn(),
	});
	const html = `<html><head></head><body>${"<p>retained report detail</p>".repeat(500)}</body></html>`;
	await store.putReport(token, html, { gzip: true });
	const uploaded = put.mock.calls[0]![1] as Buffer;
	expect(Buffer.isBuffer(uploaded)).toBe(true);
	expect(gunzipSync(uploaded).toString()).toBe(html);
	expect(uploaded.length).toBeLessThan(Buffer.byteLength(html) * 0.4);
	await store.putReport(token, html, { gzip: false });
	expect(put.mock.calls[1]![1]).toBe(html);
});

it("uploads probe bytes without wrapping and measures one report object", async () => {
	const token = "a".repeat(32);
	const put = vi.fn(async (pathname: string) => ({
		pathname,
		url: `https://store.private.blob.vercel-storage.com/${pathname}`,
	}));
	const head = vi.fn().mockResolvedValue({ size: 123 });
	const store = new VercelBlobReportStore("fake", {
		put,
		head,
		list: vi.fn(),
		del: vi.fn(),
	});
	const corrupt = Buffer.from([0x1f, 0x8b, 0, 1]);
	await store.putRawObject(`r/${token}/index.html`, corrupt);
	expect(put.mock.calls[0]![1]).toEqual(corrupt);
	expect(await store.headReportSize(token)).toBe(123);
	expect(head).toHaveBeenCalledWith(`r/${token}/index.html`, { token: "fake" });
	await expect(store.headReportSize("../invalid")).rejects.toThrow(
		"report token",
	);
	expect(head).toHaveBeenCalledTimes(1);
});

it("binds every operation to one immutable credential snapshot and verifies the returned store", async () => {
	const a = "vercel_blob_rw_storea_secret";
	const b = "vercel_blob_rw_storeb_secret";
	const token = "a".repeat(32);
	const put = vi.fn(
		async (pathname: string, _body: unknown, options: { token: string }) => ({
			pathname,
			url: `https://${options.token.split("_")[3]}.private.blob.vercel-storage.com/${pathname}`,
		}),
	);
	const del = vi.fn();
	const store = new VercelBlobReportStore(undefined, {
		put,
		del,
		list: vi.fn(),
	});
	const snapshot = {
		key: "BLOB_READ_WRITE_TOKEN" as const,
		value: a,
		source: "file" as const,
		generation: 1,
	};
	const bound = store.bind(snapshot);
	snapshot.value = b;
	await bound.putReport(token, "html");
	await bound.deleteReports([token]);
	expect(bound.storeId).toBe("storea");
	expect(put.mock.calls[0]![2].token).toBe(a);
	expect(del.mock.calls[0]![1].token).toBe(a);
	put.mockResolvedValueOnce({
		pathname: `r/${token}/index.html`,
		url: `https://storeb.private.blob.vercel-storage.com/r/${token}/index.html`,
	});
	await expect(bound.putReport(token, "html")).rejects.toThrow(
		"private Vercel Blob",
	);
	expect(() => store.bind({ ...snapshot, value: undefined })).toThrow(
		"credential missing",
	);
});

it("keeps paginated sweep and deletion bound while the caller snapshot changes", async () => {
	const a = "vercel_blob_rw_storea_secret";
	const snapshot = {
		key: "BLOB_READ_WRITE_TOKEN" as const,
		value: a,
		source: "file" as const,
		generation: 1,
	};
	const list = vi
		.fn()
		.mockImplementationOnce(async () => {
			snapshot.value = "vercel_blob_rw_storeb_secret";
			return {
				blobs: [
					{
						pathname: `r/${"a".repeat(32)}/index.html`,
						uploadedAt: new Date(0),
					},
				],
				hasMore: true,
				cursor: "next",
			};
		})
		.mockResolvedValueOnce({ blobs: [], hasMore: false });
	const del = vi.fn();
	const bound = new VercelBlobReportStore(undefined, {
		put: vi.fn(),
		list,
		del,
	}).bind(snapshot);
	expect(await bound.sweepExpiredReports(Date.now())).toBe(1);
	expect(list.mock.calls.map((call) => call[0].token)).toEqual([a, a]);
	expect(del.mock.calls[0]![1].token).toBe(a);
});
