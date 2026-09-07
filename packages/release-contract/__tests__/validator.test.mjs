import assert from "node:assert/strict";
import { test } from "node:test";

import {
	emptyManifest,
	isEmptyInitialManifest,
	payloadObjectKey,
	validateManifest,
} from "../src/index.mjs";

const T0 = "2026-09-01T00:00:00.000Z";
const BETA_VERSION = "1.55.0-beta.2";
const BETA_SHA = "a".repeat(64);
const SOURCE_COMMIT = "c".repeat(40);

function betaOnlyManifest() {
	const manifest = emptyManifest();
	manifest.channels["internal-beta"].latest = BETA_VERSION;
	manifest.versions[BETA_VERSION] = {
		sha256: BETA_SHA,
		key: payloadObjectKey(BETA_VERSION, BETA_SHA),
		size: 1234,
		publishedAt: T0,
		channel: "beta",
		status: "active",
		sourceCommit: SOURCE_COMMIT,
		releaseId: "beta-fixture",
		derivedFromBeta: null,
		retentionSince: null,
		quarantinedAt: null,
	};
	manifest.releaseOps["beta-fixture"] = {
		kind: "beta",
		state: "committed",
		ver: BETA_VERSION,
		betaVersion: null,
		sourceCommit: SOURCE_COMMIT,
		sha256: BETA_SHA,
		objectKey: payloadObjectKey(BETA_VERSION, BETA_SHA),
		createdAt: T0,
	};
	manifest.releaseLedger["1.55.0"] = { nextBetaN: 3 };
	return manifest;
}

test("valid manifests have no violations and every violation has a stable code", () => {
	assert.deepEqual(validateManifest(emptyManifest()), []);
	assert.deepEqual(validateManifest(betaOnlyManifest()), []);

	for (const invalid of [
		null,
		{ schemaVersion: 1 },
		{ ...emptyManifest(), x: 1 },
	]) {
		const errors = validateManifest(invalid);
		assert.ok(errors.length > 0);
		assert.ok(
			errors.every((error) => /^C-\d+[a-z]?: /.test(error)),
			errors,
		);
	}
});

test("an incomplete releaseOp tuple returns C-7 instead of throwing", () => {
	const manifest = emptyManifest();
	manifest.releaseOps["reserved-fixture"] = {
		kind: "beta",
		state: "reserved",
		ver: BETA_VERSION,
		betaVersion: null,
		sourceCommit: null,
		sha256: null,
		objectKey: payloadObjectKey(BETA_VERSION, BETA_SHA),
		createdAt: T0,
	};

	assert.doesNotThrow(() => validateManifest(manifest));
	assert.ok(
		validateManifest(manifest).includes(
			"C-7: releaseOps[reserved-fixture]: sha256 and objectKey must be registered together",
		),
	);
});

test("C-0 rejects extra or missing keys at every manifest shape boundary", () => {
	const mutations = [
		(manifest) => {
			manifest.extra = true;
		},
		(manifest) => {
			manifest.channels["internal-beta"].extra = true;
		},
		(manifest) => {
			delete manifest.versions[BETA_VERSION].size;
		},
		(manifest) => {
			manifest.releaseOps["beta-fixture"].extra = true;
		},
		(manifest) => {
			manifest.releaseLedger["1.55.0"].extra = true;
		},
	];

	for (const mutate of mutations) {
		const manifest = betaOnlyManifest();
		mutate(manifest);
		assert.ok(
			validateManifest(manifest).some((error) => error.startsWith("C-0: ")),
			String(mutate),
		);
	}
});

test("C-1b distinguishes never-activated, paused, and invalid hidden active entries per channel", () => {
	assert.deepEqual(validateManifest(emptyManifest()), []);
	assert.ok(isEmptyInitialManifest(emptyManifest()));

	const hiddenActive = betaOnlyManifest();
	hiddenActive.channels["internal-beta"].latest = null;
	assert.ok(
		validateManifest(hiddenActive).some((error) =>
			error.startsWith("C-1b: channels[internal-beta]"),
		),
	);

	const paused = betaOnlyManifest();
	paused.channels["internal-beta"].latest = null;
	paused.versions[BETA_VERSION].status = "quarantined";
	paused.versions[BETA_VERSION].quarantinedAt = T0;
	paused.versions[BETA_VERSION].retentionSince = T0;
	assert.deepEqual(validateManifest(paused), []);
	assert.equal(isEmptyInitialManifest(paused), false);

	const betaOnly = betaOnlyManifest();
	assert.equal(betaOnly.channels["customer-release"].latest, null);
	assert.deepEqual(validateManifest(betaOnly), []);
});
