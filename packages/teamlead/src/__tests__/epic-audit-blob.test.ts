import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { VercelBlobReportStore } from "../bridge/report-blob-store.js";

const token = "1".repeat(32);
const json = '{"entries":[]}';
const hash = createHash("sha256").update(json).digest("hex");
const previous = "2".repeat(64);
const obsolete = "3".repeat(64);
const html = `<html><head></head><body><footer><a href="${hash}/index.audit.json">audit</a></footer></body></html>`;
function fixture() {
	const objects = new Map<string, string>([
		[
			`r/${token}/index.html`,
			`<a href="${previous}/index.audit.json">audit</a>`,
		],
		...[previous, obsolete].map(
			(h) => [`r/${token}/${h}/index.audit.json`, "old"] as [string, string],
		),
	]);
	const put = vi.fn(async (path: string, body: string) => {
		objects.set(path, body);
		return {
			pathname: path,
			url: `https://store.private.blob.vercel-storage.com/${path}`,
		};
	});
	const get = vi.fn(async (path: string) =>
		objects.has(path)
			? { statusCode: 200, stream: new Response(objects.get(path)).body }
			: null,
	);
	const del = vi.fn(async (paths: string | string[]) => {
		for (const p of typeof paths === "string" ? [paths] : paths)
			objects.delete(p);
	});
	const list = vi.fn(async () => ({
		blobs: [...objects.keys()].map((pathname) => ({
			pathname,
			uploadedAt: new Date(),
		})),
		hasMore: false,
	}));
	const store = new VercelBlobReportStore("secret", { put, get, del, list });
	return { store, objects, put, get, del };
}
it("writes audit before HTML and keeps only current and actual previous remote audit after restart", async () => {
	const f = fixture();
	await f.store.putEpicPage(token, html, {
		json,
		sha256: hash,
		verifyGateway: async () => true,
	});
	expect(f.put.mock.calls.map((c) => c[0])).toEqual([
		`r/${token}/${hash}/index.audit.json`,
		`r/${token}/index.html`,
	]);
	expect(f.objects.has(`r/${token}/${previous}/index.audit.json`)).toBe(true);
	expect(f.objects.has(`r/${token}/${obsolete}/index.audit.json`)).toBe(false);
	expect(f.objects.get(`r/${token}/index.html`)).toContain(
		`data-previous-audit="${previous}"`,
	);
});
it("does not replace HTML when audit upload fails", async () => {
	const f = fixture();
	f.put.mockRejectedValueOnce(new Error("offline"));
	await expect(
		f.store.putEpicPage(token, html, {
			json,
			sha256: hash,
			verifyGateway: async () => true,
		}),
	).rejects.toThrow("offline");
	expect(f.put).toHaveBeenCalledTimes(1);
	expect(f.put.mock.calls[0]?.[0]).toBe(`r/${token}/${hash}/index.audit.json`);
	expect(f.objects.get(`r/${token}/index.html`)).toContain(previous);
	expect(f.del).not.toHaveBeenCalled();
});
it("rejects hash mismatch before network mutation", async () => {
	const f = fixture();
	await expect(
		f.store.putEpicPage(token, html, {
			json,
			sha256: obsolete,
			verifyGateway: async () => true,
		}),
	).rejects.toThrow("audit");
	expect(f.put).not.toHaveBeenCalled();
});
it("includes audit objects when deleting a report token", async () => {
	const f = fixture();
	await f.store.deleteReports([token]);
	expect(f.objects.size).toBe(0);
});
it("does not prune the previous audit on an identical publication retry", async () => {
	const f = fixture();
	await f.store.putEpicPage(token, html, {
		json,
		sha256: hash,
		verifyGateway: async () => true,
	});
	await f.store.putEpicPage(token, html, {
		json,
		sha256: hash,
		verifyGateway: async () => true,
	});
	expect(f.objects.has(`r/${token}/${previous}/index.audit.json`)).toBe(true);
});
it("fails closed when current HTML cannot be read", async () => {
	const f = fixture();
	f.get.mockResolvedValueOnce({ statusCode: 200, stream: null });
	await expect(
		f.store.putEpicPage(token, html, {
			json,
			sha256: hash,
			verifyGateway: async () => true,
		}),
	).rejects.toThrow("previous");
	expect(f.put).not.toHaveBeenCalled();
});
it("preserves previous HTML and audits on HTML upload failure, then converges on retry", async () => {
	const f = fixture();
	const realPut = f.put.getMockImplementation()!;
	f.put.mockImplementation(async (path, body) => {
		if (path.endsWith("index.html")) throw new Error("html offline");
		return realPut(path, body);
	});
	await expect(
		f.store.putEpicPage(token, html, {
			json,
			sha256: hash,
			verifyGateway: async () => true,
		}),
	).rejects.toThrow("html offline");
	expect(f.objects.get(`r/${token}/index.html`)).toContain(previous);
	expect(f.del).not.toHaveBeenCalled();
	f.put.mockImplementation(realPut);
	await f.store.putEpicPage(token, html, {
		json,
		sha256: hash,
		verifyGateway: async () => true,
	});
	expect(f.objects.has(`r/${token}/${previous}/index.audit.json`)).toBe(true);
	expect(f.objects.has(`r/${token}/${obsolete}/index.audit.json`)).toBe(false);
});
it("expires audit objects together with their token at the report TTL", async () => {
	const f = fixture();
	expect(
		await f.store.sweepExpiredReports(Date.now() + 15 * 24 * 60 * 60 * 1000),
	).toBe(3);
	expect(f.objects.size).toBe(0);
});
it("probes the gateway after audit upload and preserves HTML if it is unavailable", async () => {
	const f = fixture();
	const probe = vi.fn(async () => {
		expect(f.objects.has(`r/${token}/${hash}/index.audit.json`)).toBe(true);
		expect(f.objects.get(`r/${token}/index.html`)).toContain(previous);
		return false;
	});
	await expect(
		f.store.putEpicPage(token, html, {
			json,
			sha256: hash,
			verifyGateway: probe,
		}),
	).rejects.toThrow("epic_audit_gateway_unavailable");
	expect(probe).toHaveBeenCalledOnce();
	expect(f.put).toHaveBeenCalledTimes(1);
	expect(f.del).not.toHaveBeenCalled();
});
