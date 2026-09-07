import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
	deriveBetaCandidate,
	deriveReleaseArtifact,
	deriveVetoBinding,
	payloadObjectKey,
} from "../src/index.mjs";

const preparedFixture = JSON.parse(
	await readFile(
		new URL("../examples/prepared-candidate.json", import.meta.url),
		"utf8",
	),
);

function edit(mutate) {
	const manifest = structuredClone(preparedFixture);
	mutate(manifest);
	return manifest;
}

test("identity derivation binds the active beta and prepared clean artifact byte-for-byte", () => {
	assert.deepEqual(deriveBetaCandidate(preparedFixture, "1.55.0-beta.2"), {
		baseVersion: "1.55.0",
		betaN: 2,
		betaVersion: "1.55.0-beta.2",
		sourceCommit: "95400c4f1a7161ab32e84a5107befe5a0c78e7f3",
		betaPayloadSha256:
			"924356fadf749ede33bb35b16abe7c61a066352073d5a464d245cedf93b28367",
	});
	assert.deepEqual(deriveReleaseArtifact(preparedFixture, "promo-1"), {
		releaseId: "promo-1",
		releaseVersion: "1.55.0",
		sourceCommit: "95400c4f1a7161ab32e84a5107befe5a0c78e7f3",
		releasePayloadSha256:
			"9544ebb90c27a285f59a03f3af5fe8bfeb04cea01b3f3ac6673542f29f43d541",
		objectKey:
			"payloads/1.55.0/9544ebb90c27a285f59a03f3af5fe8bfeb04cea01b3f3ac6673542f29f43d541.tgz",
	});
	assert.deepEqual(deriveVetoBinding(preparedFixture, "promo-1"), {
		releaseId: "promo-1",
		betaVersion: "1.55.0-beta.2",
		betaPayloadSha256:
			"924356fadf749ede33bb35b16abe7c61a066352073d5a464d245cedf93b28367",
		releaseVersion: "1.55.0",
		releasePayloadSha256:
			"9544ebb90c27a285f59a03f3af5fe8bfeb04cea01b3f3ac6673542f29f43d541",
		sourceCommit: "95400c4f1a7161ab32e84a5107befe5a0c78e7f3",
	});
});

test("beta identity rejects missing, non-beta, and non-active candidates", () => {
	assert.throws(
		() => deriveBetaCandidate(preparedFixture, "9.9.9-beta.1"),
		/beta candidate.*missing/i,
	);
	assert.throws(
		() => deriveBetaCandidate(preparedFixture, "1.55.0"),
		/beta version/i,
	);
	for (const status of ["quarantined", "expired"]) {
		const manifest = edit((candidate) => {
			candidate.versions["1.55.0-beta.2"].status = status;
		});
		assert.throws(
			() => deriveBetaCandidate(manifest, "1.55.0-beta.2"),
			/active/i,
			status,
		);
	}
});

test("release identity rejects the wrong operation state, kind, tuple, or key", () => {
	assert.throws(
		() => deriveReleaseArtifact(preparedFixture, "missing"),
		/release operation.*missing/i,
	);

	const mutations = [
		[
			(op) => {
				op.kind = "beta";
			},
			/kind release/i,
		],
		[
			(op) => {
				op.state = "reserved";
			},
			/state prepared/i,
		],
		[
			(op) => {
				op.sha256 = null;
			},
			/complete tuple/i,
		],
		[
			(op) => {
				op.objectKey = "payloads/not-derived/value.tgz";
			},
			/object key/i,
		],
	];
	for (const [mutate, expected] of mutations) {
		const manifest = edit((candidate) =>
			mutate(candidate.releaseOps["promo-1"]),
		);
		assert.throws(() => deriveReleaseArtifact(manifest, "promo-1"), expected);
	}
});

test("veto binding rejects base and sourceCommit lineage mismatches", () => {
	const wrongBase = edit((manifest) => {
		const op = manifest.releaseOps["promo-1"];
		op.ver = "1.54.0";
		op.objectKey = payloadObjectKey(op.ver, op.sha256);
	});
	assert.throws(() => deriveVetoBinding(wrongBase, "promo-1"), /base/i);

	const wrongCommit = edit((manifest) => {
		manifest.releaseOps["promo-1"].sourceCommit = "d".repeat(40);
	});
	assert.throws(
		() => deriveVetoBinding(wrongCommit, "promo-1"),
		/sourceCommit/i,
	);
});
