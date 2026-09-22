#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = realpathSync(
	resolve(dirname(fileURLToPath(import.meta.url)), ".."),
);

function option(name) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

function digest(value) {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function field(value, path) {
	return path.split(".").reduce((cursor, segment) => cursor?.[segment], value);
}

function main() {
	if (!process.argv.includes("--sandbox-only")) {
		throw new Error("sandbox_only_required");
	}
	const manifestArg = option("--manifest");
	if (!manifestArg) throw new Error("manifest_required");
	const manifestPath = realpathSync(resolve(repoRoot, manifestArg));
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	assert.equal(manifest.schemaVersion, 1);
	assert.equal(manifest.mode, "readonly_shape_reconstruction");
	assert.equal(manifest.productionMutation, false);
	assert.equal(manifest.managedSnapshot, false);
	assert.equal(manifest.provenance.productionAcceptance, false);
	assert.match(
		relative(repoRoot, manifestPath),
		/^engineering\/doc\/FLY-2662-closeout-recovery\/evidence\//,
	);
	const fixturePath = realpathSync(resolve(repoRoot, manifest.fixture));
	const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
	for (const replayCase of manifest.cases) {
		const shape = fixture[replayCase.fixturePointer];
		assert.ok(shape, `fixture pointer missing: ${replayCase.fixturePointer}`);
		for (const [path, expected] of Object.entries(replayCase.requiredShape)) {
			assert.deepEqual(
				field(shape, path),
				expected,
				`${replayCase.id}:${path}`,
			);
		}
	}
	const testFiles = [
		"src/bridge/__tests__/fly2662-predeploy-replay.test.ts",
		"src/__tests__/close-runner.test.ts",
		"src/__tests__/StateStore.land-lifecycle.test.ts",
	];
	const result = spawnSync(
		"pnpm",
		[
			"--filter",
			"flywheel-teamlead",
			"exec",
			"vitest",
			"run",
			...testFiles,
			"-t",
			"FLY-2662",
			"--reporter=verbose",
		],
		{
			cwd: repoRoot,
			stdio: "inherit",
			env: {
				...process.env,
				FLYWHEEL_FLY2662_REPLAY_MODE: "sandbox-only",
			},
		},
	);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`fixture_replay_failed:${result.status ?? "signal"}`);
	}
	process.stdout.write(
		`${JSON.stringify({
			ok: true,
			mode: manifest.mode,
			productionMutation: false,
			productionAcceptance: false,
			manifest: relative(repoRoot, manifestPath),
			manifestDigest: digest(manifest),
			fixture: relative(repoRoot, fixturePath),
			fixtureDigest: digest(fixture),
			testFiles,
		})}\n`,
	);
}

try {
	main();
} catch (error) {
	process.stderr.write(
		`${JSON.stringify({
			ok: false,
			reason: error instanceof Error ? error.message : String(error),
		})}\n`,
	);
	process.exitCode = 1;
}
