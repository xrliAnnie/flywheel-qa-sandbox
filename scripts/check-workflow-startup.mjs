import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(
	new URL("../packages/teamlead/package.json", import.meta.url),
);
const { parse } = require("yaml");

// GitHub added queue:max after actionlint 1.7.12. Validate it explicitly below;
// suppress only this exact unsupported-key diagnostic, never expression errors.
const queueException =
	'^unexpected key "queue" for "concurrency" section\\. expected one of "cancel-in-progress", "group"$';

function validateQueue(concurrency, location) {
	if (
		!concurrency ||
		typeof concurrency !== "object" ||
		!("queue" in concurrency)
	)
		return;
	assert.equal(concurrency.queue, "max", `${location}: queue must be max`);
	assert.ok(
		concurrency["cancel-in-progress"] === undefined ||
			concurrency["cancel-in-progress"] === false,
		`${location}: queue:max requires cancellation false or absent`,
	);
}

try {
	const version = execFileSync("actionlint", ["-version"], {
		encoding: "utf8",
	});
	assert.equal(
		version.split(/\r?\n/)[0],
		"1.7.12",
		"actionlint 1.7.12 required",
	);
	const files = execFileSync(
		"git",
		["ls-files", "-z", "--", ".github/workflows"],
		{ encoding: "utf8" },
	)
		.split("\0")
		.filter((file) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file));
	assert.ok(files.length > 0, "no tracked workflows found");
	for (const file of files) {
		const workflow = parse(fs.readFileSync(file, "utf8"));
		assert.ok(
			workflow?.jobs &&
				typeof workflow.jobs === "object" &&
				!Array.isArray(workflow.jobs) &&
				Object.keys(workflow.jobs).length > 0,
			`${file}: nonempty jobs mapping required`,
		);
		validateQueue(workflow.concurrency, file);
		for (const [name, job] of Object.entries(workflow.jobs))
			validateQueue(job?.concurrency, `${file}: jobs.${name}`);
	}
	execFileSync(
		"actionlint",
		["-shellcheck=", "-pyflakes=", "-ignore", queueException, ...files],
		{ stdio: "inherit" },
	);
	console.log(`Workflow startup validation passed (${files.length} workflows)`);
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
