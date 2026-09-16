import assert from "node:assert/strict";
import { test } from "node:test";
import { parseChromeObservation } from "../lib/fly2519-browser-process.mjs";

const root = "/private/tmp/isolated qa";
const args = `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${root}/browser-123/profile --remote-debugging-pipe`;
test("requires a live native headed Chrome bound to the disposable profile", () => {
	assert.deepEqual(
		parseChromeObservation("42", `4004 ${args}`, root, "arm64"),
		{ pid: 42, flags: "4004", translated: false, headed: true },
	);
	assert.equal(
		parseChromeObservation("42", `4004 ${args}`, "/private/tmp/other", "arm64"),
		null,
	);
	assert.throws(
		() => parseChromeObservation("42", `24004 ${args}`, root, "arm64"),
		/translated/,
	);
	assert.throws(
		() =>
			parseChromeObservation(
				"42",
				`4004 ${args} --headless=new`,
				root,
				"arm64",
			),
		/headless/,
	);
	assert.throws(
		() => parseChromeObservation("42", `4004 ${args}`, root, "x64"),
		/host_arch/,
	);
	assert.throws(
		() => parseChromeObservation("42", `invalid ${args}`, root, "arm64"),
		/observation/,
	);
});
