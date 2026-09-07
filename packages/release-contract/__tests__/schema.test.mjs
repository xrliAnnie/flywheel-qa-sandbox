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
import { isIso, validateManifest } from "../src/index.mjs";

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

test("all documented manifest examples pass the schema and relational validator", async () => {
	for (const file of await jsonFiles("../examples/")) {
		const manifest = await readJson(file);
		assert.equal(validateSchema(manifest), true, basename(file.pathname));
		assert.deepEqual(validateManifest(manifest), [], basename(file.pathname));
	}
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

test("shape corpus is rejected by both schema and runtime C-0", async () => {
	for (const file of await jsonFiles("../examples/invalid/shape/")) {
		const manifest = await readJson(file);
		assert.equal(validateSchema(manifest), false, basename(file.pathname));
		assert.ok(
			validateManifest(manifest).some((error) => error.startsWith("C-0: ")),
			basename(file.pathname),
		);
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
