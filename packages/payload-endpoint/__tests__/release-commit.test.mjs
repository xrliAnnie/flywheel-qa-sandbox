import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { deriveVetoBinding } from "../src/manifest.mjs";
import { applyPreparedReleaseCommit } from "../src/release-commit.mjs";
import { fixtureManifest, payloadKeyOf } from "./harness.mjs";

function prepared() {
	const m = fixtureManifest({ withRelease: false });
	m.releaseOps.candidate = {
		kind: "release",
		state: "prepared",
		ver: "1.55.0",
		betaVersion: "1.55.0-beta.1",
		sourceCommit: "c".repeat(40),
		sha256: "b".repeat(64),
		objectKey: payloadKeyOf("1.55.0", "b".repeat(64)),
		createdAt: "2026-07-01T00:00:00.000Z",
	};
	return m;
}
const time = "2026-07-02T00:00:00.000Z";
test("one commit diff creates the bound entry, moves the pointer, and abandons only live same-version competitors", () => {
	const m = prepared();
	m.releaseOps.other = { ...m.releaseOps.candidate };
	m.releaseOps.unrelated = { ...m.releaseOps.candidate, ver: "1.56.0" };
	const binding = deriveVetoBinding(m, "candidate");
	assert.equal(applyPreparedReleaseCommit(m, binding, 123, time), "1.55.0");
	assert.deepEqual(m.versions["1.55.0"], {
		sha256: binding.releasePayloadSha256,
		key: payloadKeyOf("1.55.0", "b".repeat(64)),
		size: 123,
		publishedAt: time,
		channel: "release",
		status: "active",
		sourceCommit: binding.sourceCommit,
		releaseId: "candidate",
		derivedFromBeta: binding.betaVersion,
		retentionSince: null,
		quarantinedAt: null,
	});
	assert.equal(m.channels["customer-release"].latest, "1.55.0");
	assert.equal(m.releaseOps.candidate.state, "committed");
	assert.equal(m.releaseOps.other.state, "abandoned");
	assert.equal(m.releaseOps.unrelated.state, "prepared");
});
for (const field of [
	"releaseId",
	"betaVersion",
	"betaPayloadSha256",
	"releaseVersion",
	"releasePayloadSha256",
	"sourceCommit",
]) {
	test(`rejects changed ${field} before modifying any manifest field`, () => {
		const m = prepared();
		const binding = {
			...deriveVetoBinding(m, "candidate"),
			[field]: "mismatch",
		};
		const before = structuredClone(m);
		assert.throws(() => applyPreparedReleaseCommit(m, binding, 123, time));
		assert.deepEqual(m, before);
	});
}
test("cannot reuse a clean version or revive an abandoned candidate", () => {
	for (const patch of [
		(m) => {
			m.versions["1.55.0"] = { status: "withdrawn" };
		},
		(m) => {
			m.releaseOps.candidate.state = "abandoned";
		},
		(m) => {
			m.versions["1.55.0-beta.1"].status = "withdrawn";
		},
	]) {
		const m = prepared(),
			binding = deriveVetoBinding(m, "candidate");
		patch(m);
		const before = structuredClone(m);
		assert.throws(() => applyPreparedReleaseCommit(m, binding, 123, time));
		assert.deepEqual(m, before);
	}
});
test("rejects malformed metadata and unknown binding fields without mutation", () => {
	for (const [size, publishedAt, extra] of [
		[-1, time, {}],
		[NaN, time, {}],
		[123, "invalid", {}],
		[123, time, { unknown: true }],
	]) {
		const m = prepared(),
			before = structuredClone(m);
		assert.throws(() =>
			applyPreparedReleaseCommit(
				m,
				{ ...deriveVetoBinding(m, "candidate"), ...extra },
				size,
				publishedAt,
			),
		);
		assert.deepEqual(m, before);
	}
});

test("the shared mutation imports in a checkout without installed packages", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2391-commit-import-"));
	try {
		const endpoint = join(root, "packages/payload-endpoint/src");
		mkdirSync(endpoint, { recursive: true });
		mkdirSync(join(root, "packages/release-contract"), { recursive: true });
		cpSync(
			new URL("../src/release-commit.mjs", import.meta.url),
			join(endpoint, "release-commit.mjs"),
		);
		cpSync(
			new URL("../../release-contract/src", import.meta.url),
			join(root, "packages/release-contract/src"),
			{ recursive: true },
		);
		execFileSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`await import(${JSON.stringify(pathToFileURL(join(endpoint, "release-commit.mjs")).href)})`,
			],
			{
				timeout: 60_000,
				stdio: "pipe",
				env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
			},
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
