import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type Manifest, payloadObjectKey } from "flywheel-release-contract";
import { expect, it } from "vitest";
import {
	CustomerReleaseSource,
	selectCustomerBeta,
} from "../customer-release/source.js";

const now = Date.parse("2026-09-15T15:00:00Z");
const example = () =>
	JSON.parse(
		readFileSync(
			new URL(
				"../../../../release-contract/examples/prepared-candidate.json",
				import.meta.url,
			),
			"utf8",
		),
	) as Manifest;
it("selects the current deployment source and fails closed without its identity", () => {
	const manifest = example();
	const beta = Object.keys(manifest.versions)[0]!,
		entry = manifest.versions[beta]!;
	const selected = selectCustomerBeta(manifest, entry.sourceCommit);
	expect(selected?.betaVersion).toBe(beta);
	expect(selectCustomerBeta(manifest, "a".repeat(40))).toBeNull();
	expect(() => selectCustomerBeta(manifest, null)).toThrow();
});
function fixture() {
	const manifest = example(),
		bytes = Buffer.from("prepared artifact bytes"),
		hash = createHash("sha256").update(bytes).digest("hex");
	const op = manifest.releaseOps["promo-1"]!;
	op.sha256 = hash;
	op.objectKey = payloadObjectKey(op.ver, hash);
	const calls: { path: string; token: string | null; method: string }[] = [];
	let corrupt = false,
		clockSkew = 0;
	const reader = new CustomerReleaseSource({
		endpoint: "https://payload.example",
		decisionToken: "decision-token",
		payloadReadToken: "beta-read-token",
		now: () => now,
		fetch: (async (url: string | URL | Request, init?: RequestInit) => {
			const u = new URL(String(url));
			calls.push({
				path: u.pathname,
				token: new Headers(init?.headers).get("authorization"),
				method: init?.method ?? "GET",
			});
			expect(init?.redirect).toBe("error");
			return u.pathname === "/admin/manifest"
				? Response.json(manifest, {
						headers: {
							etag: '"etag-1"',
							"x-fw-server-time": new Date(now + clockSkew).toISOString(),
						},
					})
				: new Response(corrupt ? Buffer.from("bad bytes") : bytes, {
						headers: { "content-type": "application/octet-stream" },
					});
		}) as typeof fetch,
	});
	return {
		reader,
		manifest,
		calls,
		hash,
		corrupt: () => {
			corrupt = true;
		},
		skew: () => {
			clockSkew = 5001;
		},
	};
}
it("validates the real manifest, ETag/server clock, and streams the exact prepared object through the read capability", async () => {
	const f = fixture(),
		snapshot = await f.reader.manifest();
	const candidate = selectCustomerBeta(
		snapshot.manifest,
		Object.values(snapshot.manifest.versions)[0]!.sourceCommit,
	)!;
	const verified = await f.reader.prepared(
		snapshot.manifest,
		"promo-1",
		candidate,
	);
	expect(verified).toMatchObject({
		binding: { releaseId: "promo-1", releasePayloadSha256: f.hash },
		readbackSha256: f.hash,
	});
	expect(snapshot.etag).toBe('"etag-1"');
	expect(f.calls[0]).toMatchObject({
		path: "/admin/manifest",
		token: "Bearer decision-token",
		method: "GET",
	});
	expect(f.calls[1]).toMatchObject({
		token: "Bearer beta-read-token",
		method: "GET",
	});
});
it("corrupt bytes, clock drift and frozen candidate mismatch never become prepare evidence", async () => {
	const f = fixture(),
		snapshot = await f.reader.manifest(),
		candidate = selectCustomerBeta(
			snapshot.manifest,
			Object.values(snapshot.manifest.versions)[0]!.sourceCommit,
		)!;
	f.corrupt();
	await expect(
		f.reader.prepared(snapshot.manifest, "promo-1", candidate),
	).rejects.toThrow();
	await expect(
		f.reader.prepared(snapshot.manifest, "promo-1", {
			...candidate,
			betaPayloadSha256: "f".repeat(64),
		}),
	).rejects.toThrow();
	f.skew();
	await expect(f.reader.manifest()).rejects.toThrow();
});
it("read client rejects unsafe endpoints and does not accept a schema-invalid manifest", async () => {
	for (const endpoint of [
		"http://other.example",
		"https://x.example/path",
		"https://user:secret@x.example",
	]) {
		expect(
			() =>
				new CustomerReleaseSource({
					endpoint,
					decisionToken: "d",
					payloadReadToken: "b",
				}),
		).toThrow();
	}
	const f = fixture();
	f.manifest.schemaVersion = 2 as 1;
	await expect(f.reader.manifest()).rejects.toThrow();
});
