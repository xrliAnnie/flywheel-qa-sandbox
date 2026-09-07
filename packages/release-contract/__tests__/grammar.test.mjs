import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
	baseOf,
	isBetaSemver,
	isCleanSemver,
	isDerivationOf,
	isPayloadSemver,
	normalizeVersionFile,
	parsePayloadVersion,
	payloadObjectKey,
	toDisplayLabel,
} from "../src/index.mjs";

const vectors = JSON.parse(
	await readFile(
		new URL("../vectors/version-derivation.json", import.meta.url),
		"utf8",
	),
);

test("payload version grammar follows the shared derivation vectors", () => {
	for (const vector of vectors) {
		const parsed = parsePayloadVersion(vector.input);
		if (vector.expect.kind === "invalid") {
			assert.equal(parsed, null, vector.input);
			assert.equal(isPayloadSemver(vector.input), false, vector.input);
			assert.equal(isCleanSemver(vector.input), false, vector.input);
			assert.equal(isBetaSemver(vector.input), false, vector.input);
			assert.equal(
				isDerivationOf(vector.base, vector.input),
				false,
				vector.input,
			);
			assert.throws(
				() => baseOf(vector.input),
				/payload version/i,
				vector.input,
			);
			continue;
		}

		assert.deepEqual(parsed, vector.expect, vector.input);
		assert.equal(isPayloadSemver(vector.input), true, vector.input);
		assert.equal(
			isCleanSemver(vector.input),
			vector.expect.kind === "clean",
			vector.input,
		);
		assert.equal(
			isBetaSemver(vector.input),
			vector.expect.kind === "beta",
			vector.input,
		);
		assert.equal(isDerivationOf(vector.base, vector.input), true, vector.input);
		assert.equal(baseOf(vector.input), vector.expect.base, vector.input);
	}
});

test("doc/VERSION normalization accepts one optional v and only a clean base", () => {
	assert.equal(normalizeVersionFile("v1.56.0\n"), "1.56.0");
	assert.equal(normalizeVersionFile("  1.56.0  \n"), "1.56.0");

	for (const invalid of [
		"vv1.56.0",
		"v1.56.0-beta.2",
		"1.56.0+build.1",
		"01.56.0",
		"",
	]) {
		assert.throws(
			() => normalizeVersionFile(invalid),
			/base version/i,
			invalid,
		);
	}
});

test("display labels and immutable object keys are derived, not free-form", () => {
	assert.equal(toDisplayLabel("1.56.0-beta.2"), "v1.56.0-beta.2");
	assert.throws(() => toDisplayLabel("v1.56.0"), /payload version/i);
	assert.equal(
		payloadObjectKey("1.56.0", "a".repeat(64)),
		`payloads/1.56.0/${"a".repeat(64)}.tgz`,
	);
	assert.throws(
		() => payloadObjectKey("1.56.0-rc.1", "a".repeat(64)),
		/payload version/i,
	);
	assert.throws(() => payloadObjectKey("1.56.0", "not-a-sha"), /sha256/i);
});
