import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	evaluateExpectedOutcome,
	parseArgs,
	readFixtureManifest,
} from "./qa-memory-seed.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const head = "a".repeat(40);
const mutationBase = "b".repeat(40);

test("requires an exact slot and tested head", () => {
	assert.deepEqual(parseArgs(["--slot", "2", "--expect-head", head]), {
		slot: 2,
		expectHead: head,
		expectRed: "none",
		runModel: true,
	});
	assert.throws(() => parseArgs(["--slot", "0", "--expect-head", head]));
	assert.throws(() => parseArgs(["--slot", "2", "--expect-head", "short"]));
	const mutationDiff = join(mkdtempSync(join(tmpdir(), "fly2359-red-")), "change.diff");
	writeFileSync(mutationDiff, "diff --git a/a b/a\n");
	assert.throws(() =>
		parseArgs([
			"--slot",
			"2",
			"--expect-head",
			head,
			"--expect-red",
			"role-leak",
			"--mutation-diff",
			mutationDiff,
		]),
	);
	assert.throws(() =>
		parseArgs([
			"--slot",
			"2",
			"--expect-head",
			head,
			"--fixture-only",
			"--expect-red",
			"role-leak",
			"--mutation-diff",
			mutationDiff,
		]),
	);
	assert.equal(
		parseArgs([
			"--slot",
			"2",
			"--expect-head",
			head,
			"--fixture-only",
			"--expect-red",
			"role-leak",
			"--mutation-base",
			mutationBase,
			"--mutation-diff",
			mutationDiff,
		]).expectRed,
		"role-leak",
	);
	assert.equal(
		parseArgs([
			"--slot",
			"2",
			"--expect-head",
			head,
			"--fixture-only",
			"--expect-red",
			"backflow-disabled",
			"--mutation-base",
			mutationBase,
			"--mutation-diff",
			mutationDiff,
		]).expectRed,
		"backflow-disabled",
	);
});

test("ships deidentified fixture bytes with verified hashes", () => {
	const manifest = readFixtureManifest(join(here, "fixtures"));
	assert.equal(manifest.version, 1);
	assert.deepEqual(manifest.controls, [
		{ key: "no-node", expectedSkip: "missing_role" },
		{ key: "bad-adapter", expectedSkip: "adapter_mismatch" },
	]);
	assert.deepEqual(
		manifest.sources.map(({ key, identity }) => ({ key, identity })),
		[
			{ key: "f", identity: { project: "flywheel", role: "implement" } },
			{ key: "q", identity: { project: "flywheel", role: "qa" } },
			{
				key: "j",
				identity: { project: "joycon-typeless", role: "implement" },
			},
			{
				key: "conflict-a",
				identity: { project: "flywheel", role: "implement" },
			},
			{
				key: "conflict-b",
				identity: { project: "flywheel", role: "implement" },
			},
		],
	);
});

test("a RED run passes only when its named guard actually fails", () => {
	const green = [
		{ id: "qa_excludes_implement", passed: true },
		{ id: "flywheel_excludes_joycon", passed: true },
	];
	assert.deepEqual(evaluateExpectedOutcome(green, "none"), {
		passed: true,
		expectedFailureObserved: null,
	});
	assert.deepEqual(evaluateExpectedOutcome(green, "role-leak"), {
		passed: false,
		expectedFailureObserved: false,
	});
	assert.deepEqual(
		evaluateExpectedOutcome(
			green.map((row) =>
				row.id === "qa_excludes_implement" ? { ...row, passed: false } : row,
			),
			"role-leak",
		),
		{ passed: true, expectedFailureObserved: true },
	);
	assert.deepEqual(
		evaluateExpectedOutcome(
			[
				{ id: "implement_storage_contains_current", passed: false },
				{ id: "next_implement_sees_current", passed: false },
			],
			"backflow-disabled",
		),
		{ passed: true, expectedFailureObserved: true },
	);
});
