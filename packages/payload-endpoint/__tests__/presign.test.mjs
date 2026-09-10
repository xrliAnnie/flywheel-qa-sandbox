import assert from "node:assert/strict";
import { test } from "node:test";
import { createSignGet } from "../src/presign.mjs";

const config = {
	FW_R2_ACCOUNT_ID: "a".repeat(32),
	FW_R2_BUCKET: "flywheel-payloads",
	FW_R2_ACCESS_KEY_ID: "fixture-access",
	FW_R2_SECRET_ACCESS_KEY: "fixture-secret",
};
const objectKey = `payloads/1.55.0/${"b".repeat(64)}.tgz`;
const issuedAt = Date.parse("2026-07-11T00:00:00.000Z");

test("GET signer caps lifetime at 60 seconds, fixes issue time and signs only host", async () => {
	const sign = createSignGet(config);
	for (const expiresIn of [1, 20, 60]) {
		const url = new URL(await sign({ objectKey, issuedAt, expiresIn }));
		assert.equal(
			url.origin,
			`https://${config.FW_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
		);
		assert.equal(url.pathname, `/flywheel-payloads/${objectKey}`);
		assert.equal(url.searchParams.get("X-Amz-Expires"), String(expiresIn));
		assert.equal(url.searchParams.get("X-Amz-Date"), "20260711T000000Z");
		assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "host");
		assert.equal(
			url.searchParams.get("response-cache-control"),
			"private, no-store",
		);
		assert.match(url.searchParams.get("X-Amz-Signature"), /^[a-f0-9]{64}$/);
		// Independently computed with Python hashlib/hmac over the canonical
		// GET request and AWS4 date/auto/s3/aws4_request key derivation.
		if (expiresIn === 60)
			assert.equal(
				url.searchParams.get("X-Amz-Signature"),
				"7945c337af848ecd0ab2e96dc60b0a2097f128238c2f1f0d0d1a20c0875079e9",
			);
		assert.equal(url.href.includes(config.FW_R2_SECRET_ACCESS_KEY), false);
	}
	for (const expiresIn of [0, -1, 61, 86400, 1.5, NaN]) {
		await assert.rejects(sign({ objectKey, issuedAt, expiresIn }));
	}
});

test("signer rejects missing credentials, arbitrary hosts/buckets and non-payload paths", async () => {
	for (const patch of [
		{ FW_R2_ACCOUNT_ID: "evil.test/" },
		{ FW_R2_BUCKET: "other" },
		{ FW_R2_ACCESS_KEY_ID: "" },
		{ FW_R2_SECRET_ACCESS_KEY: "" },
	]) {
		assert.throws(() => createSignGet({ ...config, ...patch }));
	}
	const sign = createSignGet(config);
	for (const key of [
		"manifest.json",
		"keys/key.json",
		"payloads/../../secret",
		`${objectKey}?list=1`,
	]) {
		await assert.rejects(sign({ objectKey: key, issuedAt, expiresIn: 60 }));
	}
});
