import assert from "node:assert/strict";
import { test } from "node:test";

import { distTagForVersion } from "../release/lib/dist-tag.mjs";

test("shell versions map to one explicit npm dist-tag", () => {
	assert.equal(distTagForVersion("1.2.3"), "latest");
	assert.equal(distTagForVersion("1.2.3-beta.1"), "next");
	assert.equal(distTagForVersion("1.2.3-rc.1"), "next");
	for (const value of ["v1.2.3", "1.2", "1.2.3+meta"]) {
		assert.throws(() => distTagForVersion(value), /version|semver/i, value);
	}
});
