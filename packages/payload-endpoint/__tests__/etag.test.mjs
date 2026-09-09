import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { EtagProtocolError, normalizeEtag } from "../src/etag.mjs";

const vectors = JSON.parse(
	fs.readFileSync(
		new URL(
			"../../../scripts/__tests__/fixtures/etag-vectors.json",
			import.meta.url,
		),
		"utf8",
	),
);

test("endpoint and release clients share the exact ETag normalization contract", () => {
	for (const vector of vectors.valid) {
		assert.equal(normalizeEtag(vector.input), vector.expected, vector.name);
	}
	for (const vector of vectors.invalid) {
		assert.throws(
			() => normalizeEtag(vector.input),
			(error) =>
				error instanceof EtagProtocolError &&
				error.message === "invalid manifest ETag",
			vector.name,
		);
	}
});
