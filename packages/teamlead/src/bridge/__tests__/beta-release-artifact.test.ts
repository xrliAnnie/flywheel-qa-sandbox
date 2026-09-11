import { expect, it } from "vitest";
import { parseBetaReceiptZip } from "../beta-release-artifact.js";
import { receiptZip } from "./beta-release-zip-fixture.js";

it("accepts exactly one regular receipt.json and rejects malformed or hostile archives", async () => {
	const signal = new AbortController().signal;
	const entry = { name: "receipt.json", data: '{"schemaVersion":1}' };
	expect(await parseBetaReceiptZip(receiptZip([entry]), signal)).toEqual({
		schemaVersion: 1,
	});
	for (const entries of [
		[{ ...entry, name: "../receipt.json" }],
		[{ ...entry, name: "/receipt.json" }],
		[{ ...entry, mode: 0o120777 }],
		[entry, entry],
		[{ ...entry, flags: 1 }],
		[{ ...entry, data: "x".repeat(5000), compress: true }],
		[{ ...entry, size: 4, compress: true }],
		[{ ...entry, data: "invalid json" }],
	]) {
		await expect(
			parseBetaReceiptZip(receiptZip(entries), signal),
		).rejects.toThrow("beta_artifact_invalid");
	}
	await expect(
		parseBetaReceiptZip(receiptZip([entry]).subarray(0, 50), signal),
	).rejects.toThrow("beta_artifact_invalid");
	await expect(
		parseBetaReceiptZip(Buffer.alloc(65537), signal),
	).rejects.toThrow("beta_artifact_invalid");
	const stopped = new AbortController();
	stopped.abort();
	await expect(
		parseBetaReceiptZip(receiptZip([entry]), stopped.signal),
	).rejects.toThrow("beta_artifact_invalid");
});
