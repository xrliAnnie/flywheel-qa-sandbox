import { expect, it, vi } from "vitest";
import { VercelBlobReportStore } from "../bridge/report-blob-store.js";

it("reuses identical uploaded bytes without overwrite, and rejects conflicting bytes", async () => {
	const token = "a".repeat(32),
		html = "<html>history</html>",
		signal = new AbortController().signal;
	let stored: string | null = null;
	const get = vi.fn(async () =>
		stored === null
			? { statusCode: 404, stream: null }
			: { statusCode: 200, stream: new Response(stored).body },
	);
	const put = vi.fn(async (_path: string, body: string) => {
		stored = body;
		return { pathname: "fixture", url: "fixture" };
	});
	const store = new VercelBlobReportStore("fixture-secret", {
		get,
		put,
		list: vi.fn(),
		del: vi.fn(),
	});
	await store.resumeReport(token, html, signal);
	await store.resumeReport(token, html, signal);
	expect(put).toHaveBeenCalledOnce();
	expect(put.mock.calls[0]![2]).toMatchObject({
		allowOverwrite: false,
		abortSignal: signal,
	});
	stored = "conflicting content";
	await expect(store.resumeReport(token, html, signal)).rejects.toThrow(
		"report_resume_content_conflict",
	);
	expect(put).toHaveBeenCalledOnce();
	const canceled = new AbortController();
	canceled.abort();
	const count = get.mock.calls.length;
	await expect(
		store.resumeReport(token, html, canceled.signal),
	).rejects.toThrow();
	expect(get).toHaveBeenCalledTimes(count);
});

it("resumes gzip gateway objects without overwriting or renewing their TTL", async () => {
	const token = "b".repeat(32),
		html = "<html>history gzip</html>";
	let stored: Buffer | null = null;
	const put = vi.fn(async (_path: string, body: Buffer) => {
		stored = body;
		return { pathname: "fixture", url: "fixture" };
	});
	const store = new VercelBlobReportStore("fixture-secret", {
		get: vi.fn(async () =>
			stored === null
				? { statusCode: 404, stream: null }
				: { statusCode: 200, stream: new Response(stored).body },
		),
		put,
		list: vi.fn(),
		del: vi.fn(),
	});
	const signal = new AbortController().signal;
	await store.resumeReport(token, html, signal, { gzip: true });
	expect(stored?.[0]).toBe(0x1f);
	await store.resumeReport(token, html, signal, { gzip: true });
	expect(put).toHaveBeenCalledOnce();
	await expect(
		store.resumeReport(token, html.replace("history", "changed"), signal, {
			gzip: true,
		}),
	).rejects.toThrow();
	expect(put).toHaveBeenCalledOnce();
});
