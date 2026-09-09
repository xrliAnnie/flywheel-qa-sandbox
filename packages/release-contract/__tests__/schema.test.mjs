import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { test } from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import {
	fixtureManifest,
	makeDeps,
	request,
	seedBucketForManifest,
	seedKey,
} from "../../payload-endpoint/__tests__/harness.mjs";
import { MemoryBucket } from "../../payload-endpoint/__tests__/memory-bucket.mjs";
import { emptyManifest, isIso, validateManifest } from "../src/index.mjs";

async function readJson(url) {
	return JSON.parse(await readFile(url, "utf8"));
}

async function jsonFiles(relativeDirectory) {
	const directory = new URL(relativeDirectory, import.meta.url);
	return (await readdir(directory))
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) => new URL(name, directory));
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addFormat("date-time", { type: "string", validate: isIso });
const manifestSchema = await readJson(
	new URL("../schema/manifest.schema.json", import.meta.url),
);
const manifestViewSchema = await readJson(
	new URL("../schema/manifest-view.schema.json", import.meta.url),
);
const validateSchema = ajv.compile(manifestSchema);
const validateViewSchema = ajv.compile(manifestViewSchema);

const BETA_VERSION = "1.55.0-beta.2";
const BETA_OP = "beta-95400c4f1a7161ab32e84a5107befe5a0c78e7f3";

function mutateFixture(fixture, mutate) {
	const manifest = structuredClone(fixture);
	mutate(manifest);
	return manifest;
}

function differentialCases(fixture) {
	const root = (manifest) => manifest;
	const channels = (manifest) => manifest.channels;
	const betaPointer = (manifest) => manifest.channels["internal-beta"];
	const betaEntry = (manifest) => manifest.versions[BETA_VERSION];
	const betaOp = (manifest) => manifest.releaseOps[BETA_OP];
	const ledger = (manifest) => manifest.releaseLedger;
	const ledgerRecord = (manifest) => manifest.releaseLedger["1.55.0"];
	const set = (select, key, value) => (manifest) => {
		select(manifest)[key] = value;
	};
	const omit = (select, key) => (manifest) => {
		delete select(manifest)[key];
	};
	const cases = [
		["root type", null],
		["schemaVersion const", set(root, "schemaVersion", 2)],
		["root additionalProperties", set(root, "extra", true)],
		["channels type", set(root, "channels", [])],
		["channels required", omit(channels, "internal-beta")],
		[
			"channels additionalProperties",
			set(channels, "preview", { latest: null }),
		],
		["channel pointer type", set(channels, "internal-beta", [])],
		["channel pointer required", omit(betaPointer, "latest")],
		["channel pointer additionalProperties", set(betaPointer, "extra", true)],
		["channel latest type", set(betaPointer, "latest", 1)],
		["versions type", set(root, "versions", [])],
		[
			"versions propertyNames pattern",
			(m) => {
				m.versions[`v${BETA_VERSION}`] = m.versions[BETA_VERSION];
				delete m.versions[BETA_VERSION];
			},
		],
		["version entry type", set((m) => m.versions, BETA_VERSION, [])],
		["version entry additionalProperties", set(betaEntry, "extra", true)],
		["version sha256 type", set(betaEntry, "sha256", 1)],
		["version sha256 pattern", set(betaEntry, "sha256", "A".repeat(64))],
		["version key type", set(betaEntry, "key", 1)],
		["version size type", set(betaEntry, "size", "1234")],
		["version size integer", set(betaEntry, "size", 1.5)],
		["version size minimum", set(betaEntry, "size", 0)],
		["version publishedAt type", set(betaEntry, "publishedAt", 1)],
		[
			"version publishedAt format/pattern",
			set(betaEntry, "publishedAt", "2026-09-01"),
		],
		["version channel enum", set(betaEntry, "channel", "preview")],
		["version status enum", set(betaEntry, "status", "deleted")],
		[
			"version sourceCommit pattern",
			set(betaEntry, "sourceCommit", "A".repeat(40)),
		],
		["version releaseId type", set(betaEntry, "releaseId", 1)],
		["version releaseId minLength", set(betaEntry, "releaseId", "")],
		["version derivedFromBeta type", set(betaEntry, "derivedFromBeta", 1)],
		[
			"version derivedFromBeta pattern",
			set(betaEntry, "derivedFromBeta", "1.55.0-rc.1"),
		],
		["version retentionSince type", set(betaEntry, "retentionSince", 1)],
		[
			"version retentionSince format/pattern",
			set(betaEntry, "retentionSince", "yesterday"),
		],
		["version quarantinedAt type", set(betaEntry, "quarantinedAt", 1)],
		[
			"version quarantinedAt format/pattern",
			set(betaEntry, "quarantinedAt", "yesterday"),
		],
		[
			"version quarantined conditional",
			(m) => {
				m.versions[BETA_VERSION].status = "quarantined";
				m.versions[BETA_VERSION].quarantinedAt = null;
			},
		],
		["releaseOps type", set(root, "releaseOps", [])],
		[
			"releaseOps propertyNames minLength",
			(m) => {
				m.releaseOps[""] = m.releaseOps[BETA_OP];
				delete m.releaseOps[BETA_OP];
			},
		],
		["release op type", set((m) => m.releaseOps, BETA_OP, [])],
		["release op additionalProperties", set(betaOp, "extra", true)],
		["release op kind enum", set(betaOp, "kind", "preview")],
		["release op state enum", set(betaOp, "state", "uploading")],
		["release op ver type", set(betaOp, "ver", 1)],
		["release op ver pattern", set(betaOp, "ver", "v1.55.0")],
		["release op betaVersion type", set(betaOp, "betaVersion", 1)],
		[
			"release op betaVersion pattern",
			set(betaOp, "betaVersion", "1.55.0-rc.1"),
		],
		["release op sourceCommit type", set(betaOp, "sourceCommit", 1)],
		[
			"release op sourceCommit pattern",
			set(betaOp, "sourceCommit", "A".repeat(40)),
		],
		["release op sha256 type", set(betaOp, "sha256", 1)],
		["release op sha256 pattern", set(betaOp, "sha256", "A".repeat(64))],
		["release op objectKey type", set(betaOp, "objectKey", 1)],
		["release op createdAt type", set(betaOp, "createdAt", 1)],
		[
			"release op createdAt format/pattern",
			set(betaOp, "createdAt", "yesterday"),
		],
		["releaseLedger type", set(root, "releaseLedger", [])],
		[
			"ledger propertyNames pattern",
			(m) => {
				m.releaseLedger["v1.55.0"] = m.releaseLedger["1.55.0"];
				delete m.releaseLedger["1.55.0"];
			},
		],
		["ledger record type", set(ledger, "1.55.0", [])],
		["ledger additionalProperties", set(ledgerRecord, "extra", true)],
		["ledger nextBetaN type", set(ledgerRecord, "nextBetaN", "3")],
		["ledger nextBetaN integer", set(ledgerRecord, "nextBetaN", 1.5)],
		["ledger nextBetaN minimum zero", set(ledgerRecord, "nextBetaN", 0)],
		["ledger nextBetaN minimum negative", set(ledgerRecord, "nextBetaN", -1)],
		["tombstones type", set(root, "tombstones", {})],
		["tombstone item type", set(root, "tombstones", [1])],
		["tombstone item pattern", set(root, "tombstones", ["not-a-payload-key"])],
		[
			"tombstones uniqueItems",
			(m) => {
				const key = `payloads/9.9.9/${"d".repeat(64)}.tgz`;
				m.tombstones = [key, key];
			},
		],
	];

	for (const key of [
		"schemaVersion",
		"channels",
		"versions",
		"releaseOps",
		"releaseLedger",
		"tombstones",
	]) {
		cases.push([`root required ${key}`, omit(root, key)]);
	}
	for (const key of Object.keys(fixture.versions[BETA_VERSION])) {
		cases.push([`version entry required ${key}`, omit(betaEntry, key)]);
	}
	for (const key of Object.keys(fixture.releaseOps[BETA_OP])) {
		cases.push([`release op required ${key}`, omit(betaOp, key)]);
	}
	cases.push(["ledger required nextBetaN", omit(ledgerRecord, "nextBetaN")]);

	return cases.map(([name, mutate]) => [
		name,
		typeof mutate === "function" ? mutateFixture(fixture, mutate) : mutate,
	]);
}

test("all documented manifest examples pass the schema and relational validator", async () => {
	for (const file of await jsonFiles("../examples/")) {
		const manifest = await readJson(file);
		assert.equal(validateSchema(manifest), true, basename(file.pathname));
		assert.deepEqual(validateManifest(manifest), [], basename(file.pathname));
	}
	const empty = emptyManifest();
	assert.equal(validateSchema(empty), true, "emptyManifest schema");
	assert.deepEqual(validateManifest(empty), [], "emptyManifest runtime");
});

test("the CONTRACT.md manifest example is the validated release fixture", async () => {
	const contract = await readFile(
		new URL("../CONTRACT.md", import.meta.url),
		"utf8",
	);
	const embedded =
		/<!-- manifest-example:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- manifest-example:end -->/.exec(
			contract,
		);
	assert.ok(embedded, "CONTRACT.md must contain the tagged manifest example");
	const manifest = JSON.parse(embedded[1]);
	const fixture = await readJson(
		new URL("../examples/release-committed.json", import.meta.url),
	);
	assert.deepEqual(manifest, fixture);
	assert.equal(validateSchema(manifest), true);
	assert.deepEqual(validateManifest(manifest), []);
});

test("file-backed shape corpus is rejected by both schema and runtime", async () => {
	for (const file of await jsonFiles("../examples/invalid/shape/")) {
		const manifest = await readJson(file);
		assert.equal(validateSchema(manifest), false, basename(file.pathname));
		assert.ok(validateManifest(manifest).length > 0, basename(file.pathname));
	}
});

test("legacy exact-key/type shape fixtures retain a runtime C-0 diagnosis", async () => {
	const c0Fixtures = new Set([
		"extra-channel-key.json",
		"extra-root-key.json",
		"ledger-extra-key.json",
		"missing-root-key.json",
		"release-op-missing-keys.json",
		"schema-version-const.json",
		"version-entry-type.json",
	]);
	for (const file of await jsonFiles("../examples/invalid/shape/")) {
		if (!c0Fixtures.has(basename(file.pathname))) continue;
		const manifest = await readJson(file);
		assert.ok(
			validateManifest(manifest).some((error) => error.startsWith("C-0: ")),
			basename(file.pathname),
		);
	}
});

test("every manifest-schema keyword and boundary rejects in the runtime validator too", async () => {
	const fixture = await readJson(
		new URL("../examples/release-committed.json", import.meta.url),
	);
	for (const [name, manifest] of differentialCases(fixture)) {
		assert.equal(
			validateSchema(manifest),
			false,
			`${name}: schema unexpectedly accepted`,
		);
		assert.ok(
			validateManifest(manifest).length > 0,
			`${name}: runtime validator unexpectedly accepted`,
		);
	}
});

test("CONTRACT Amendment A1 records the executable B1 boundaries", async () => {
	const contract = await readFile(
		new URL("../CONTRACT.md", import.meta.url),
		"utf8",
	);
	for (const required of [
		"## Amendment A1 (FLY-2388, 2026-09-08)",
		"`.github/workflows/payload-promote-commit.yml`",
		"`FW_CUSTOMER_RELEASE_TOKEN`",
		"`scripts/release/lib/dist-tag.mjs`",
		"完整 `validateManifest`",
		"differential corpus",
		"stale-days 14",
	]) {
		assert.ok(contract.includes(required), `missing A1 text: ${required}`);
	}
});

test("relation corpus passes shape schema and fails only its named invariant", async () => {
	for (const file of await jsonFiles("../examples/invalid/relations/")) {
		const manifest = await readJson(file);
		const invariant = basename(file.pathname).split("-")[0].slice(1);
		const expectedCode = `C-${invariant}`;
		assert.equal(
			validateSchema(manifest),
			true,
			`${basename(file.pathname)}: ${JSON.stringify(validateSchema.errors)}`,
		);
		const errors = validateManifest(manifest);
		assert.ok(errors.length > 0, basename(file.pathname));
		assert.ok(
			errors.every((error) => error.startsWith(`${expectedCode}: `)),
			`${basename(file.pathname)}: ${errors.join(" | ")}`,
		);
	}
});

test("manifest v1 customer-view schema is closed to unversioned field expansion", () => {
	const view = {
		latest: "1.55.0",
		versions: [{ ver: "1.55.0", sha256: "a".repeat(64) }],
	};
	assert.equal(validateViewSchema(view), true);
	assert.equal(validateViewSchema({ ...view, schemaVersion: 1 }), false);
	assert.equal(
		validateViewSchema({
			...view,
			versions: [{ ...view.versions[0], channel: "release" }],
		}),
		false,
	);
});

test("manifest schema rejects timestamps and tombstone duplicates rejected by runtime", async () => {
	const fixture = await readJson(
		new URL("../examples/release-committed.json", import.meta.url),
	);
	const invalidTimestamp = structuredClone(fixture);
	invalidTimestamp.versions["1.55.0"].publishedAt = "yesterday";
	assert.equal(validateSchema(invalidTimestamp), false);
	assert.ok(
		validateManifest(invalidTimestamp).some((error) =>
			error.includes("must be an ISO timestamp"),
		),
	);

	const duplicateTombstone = structuredClone(fixture);
	const tombstone = `payloads/9.9.9/${"d".repeat(64)}.tgz`;
	duplicateTombstone.tombstones = [tombstone, tombstone];
	assert.equal(validateSchema(duplicateTombstone), false);
	assert.ok(
		validateManifest(duplicateTombstone).some((error) =>
			error.startsWith("C-8: tombstones"),
		),
	);
});

test("the frozen customer-view schema validates a real handler response", async () => {
	const token = `fwk_${"9".repeat(32)}`;
	const manifest = fixtureManifest();
	const bucket = new MemoryBucket();
	seedBucketForManifest(bucket, manifest);
	seedKey(bucket, token, { entitlement: "customer" });
	const { deps } = makeDeps({ bucket });

	const response = await request(deps, "GET", "/manifest", { token });
	assert.equal(response.status, 200);
	const view = await response.json();
	assert.equal(
		validateViewSchema(view),
		true,
		JSON.stringify(validateViewSchema.errors),
	);
	assert.deepEqual(view, {
		latest: "1.55.0",
		versions: [{ ver: "1.55.0", sha256: "b".repeat(64) }],
	});
});
