import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FsBucket } from "../src/fs-bucket.mjs";
import { MemoryBucket } from "./memory-bucket.mjs";

for (const backend of ["memory", "fs"])
	test(`${backend} lists only the requested control prefix with stable bounded continuation`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "fw-release-list-"));
		try {
			const b = backend === "fs" ? new FsBucket(dir) : new MemoryBucket();
			const prefix = "control/customer-release/flywheel/";
			for (const key of [
				`${prefix}a/attempt.json`,
				`${prefix}a/permit.json`,
				`${prefix}b/attempt.json`,
				`${prefix}c/attempt.json`,
				`control/customer-release/other/x/attempt.json`,
				`keys/license.json`,
			])
				await b.put(key, "{}");
			const first = await b.list({ prefix, delimiter: "/", limit: 2 });
			assert.deepEqual(first.delimitedPrefixes, [`${prefix}a`, `${prefix}b`]);
			assert.deepEqual(first.objects, []);
			assert.equal(first.truncated, true);
			assert.ok(first.cursor);
			// Cursor identifies the last key, not an array offset that shifts on removal.
			await b.delete(`${prefix}a/attempt.json`);
			await b.delete(`${prefix}a/permit.json`);
			const last = await b.list({
				prefix,
				delimiter: "/",
				limit: 2,
				cursor: first.cursor,
			});
			assert.deepEqual(last.delimitedPrefixes, [`${prefix}c`]);
			assert.deepEqual(last.objects, []);
			assert.equal(last.truncated, false);
			assert.deepEqual(
				(await b.list({ prefix: "missing/", delimiter: "/", limit: 1 }))
					.delimitedPrefixes,
				[],
			);
			for (const options of [
				{ prefix: "../", delimiter: "/", limit: 2 },
				{ prefix, delimiter: "/", limit: 0 },
				{ prefix, delimiter: "/", limit: 1001 },
				{
					prefix,
					delimiter: "/",
					limit: 2,
					cursor: "control/customer-release/other/a/",
				},
			])
				await assert.rejects(b.list(options));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
