import assert from "node:assert/strict";
import { test } from "node:test";

import { isReleaseId, RELEASE_ID_SOURCE } from "../release/lib/release-id.mjs";

test("releaseId grammar is one 3..64-character allowlist", () => {
	assert.equal(RELEASE_ID_SOURCE, "^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$");
	for (const value of ["rel", "release-1.2.3_20260908", `r${"a".repeat(63)}`]) {
		assert.equal(isReleaseId(value), true, value);
	}
	for (const value of [
		undefined,
		null,
		"",
		"ab",
		"-release",
		"release/slash",
		"release space",
		`r${"a".repeat(64)}`,
	]) {
		assert.equal(isReleaseId(value), false, String(value));
	}
});
