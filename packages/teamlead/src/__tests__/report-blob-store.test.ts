import { describe, expect, it, vi } from "vitest";
import { VercelBlobReportStore } from "../bridge/report-blob-store.js";

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
