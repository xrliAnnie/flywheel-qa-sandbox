import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveVetoBinding } from "../src/manifest.mjs";
import { applyPreparedReleaseCommit } from "../src/release-commit.mjs";
import { releaseControlFromEnv } from "../src/release-control-config.mjs";
import worker from "../src/worker.mjs";
import {
	fixtureManifest,
	makeDeps,
	payloadKeyOf,
	request,
	seedBucketForManifest,
	sha256Hex,
	TOKENS,
} from "./harness.mjs";

const control = {
	projectId: "flywheel",
	audience: "flywheel-payload",
	activationEpoch: 7,
	mode: "canary",
	enabled: true,
};
const env = {
	FW_RELEASE_CONTROL_JSON: JSON.stringify({ schemaVersion: 1, ...control }),
	FW_RELEASE_DECISION_REQUIRED: "true",
};
test("no release environment means auto off and preserves the old manual deployment", () => {
	assert.deepEqual(releaseControlFromEnv({}), {
		releaseControl: null,
		releaseDecisionRequired: false,
	});
	assert.deepEqual(
		releaseControlFromEnv({ FW_RELEASE_DECISION_REQUIRED: "true" }),
		{ releaseControl: null, releaseDecisionRequired: true },
	);
});
test("valid release config uses an explicit project, endpoint audience and epoch", () => {
	assert.deepEqual(releaseControlFromEnv(env), {
		releaseControl: control,
		releaseDecisionRequired: true,
	});
	for (const mode of ["off", "observe"]) {
		const c = { ...control, mode, enabled: false };
		assert.deepEqual(
			releaseControlFromEnv({
				...env,
				FW_RELEASE_CONTROL_JSON: JSON.stringify({ schemaVersion: 1, ...c }),
			}).releaseControl,
			c,
		);
	}
});
for (const patch of [
	{ FW_RELEASE_DECISION_REQUIRED: "yes" },
	{ FW_RELEASE_DECISION_REQUIRED: "false" },
	{ FW_RELEASE_CONTROL_JSON: "{" },
	{ FW_RELEASE_CONTROL_JSON: "x".repeat(4097) },
	...[
		{ schemaVersion: 2 },
		{ activationEpoch: -1 },
		{ activationEpoch: "7" },
		{ audience: "https://other" },
		{ projectId: "other" },
		{ enabled: "true" },
		{ mode: "observe" },
		{ extra: "secret-fixture" },
	].map((change) => ({
		FW_RELEASE_CONTROL_JSON: JSON.stringify({
			schemaVersion: 1,
			...control,
			...change,
		}),
	})),
])
	test(`malformed or bypassable release config fails closed: ${JSON.stringify(patch).slice(0, 80)}`, () => {
		const result = releaseControlFromEnv({ ...env, ...patch });
		assert.equal(result.releaseControl, null);
		assert.equal(result.releaseDecisionRequired, true);
		assert.equal(JSON.stringify(result).includes("secret-fixture"), false);
	});
function setup() {
	const ctx = makeDeps();
	const manifest = fixtureManifest({ withRelease: false });
	manifest.releaseOps.candidate = {
		kind: "release",
		state: "prepared",
		ver: "1.55.0",
		betaVersion: "1.55.0-beta.1",
		sourceCommit: "c".repeat(40),
		sha256: "b".repeat(64),
		objectKey: payloadKeyOf("1.55.0", "b".repeat(64)),
		createdAt: "2026-07-01T00:00:00.000Z",
	};
	seedBucketForManifest(ctx.bucket, manifest);
	ctx.bucket.seed(manifest.releaseOps.candidate.objectKey, "prepared bytes", {
		sha256: "b".repeat(64),
		ver: "1.55.0",
	});
	return { ...ctx, manifest };
}
async function commitBody(ctx) {
	const manifest = structuredClone(ctx.manifest);
	applyPreparedReleaseCommit(
		manifest,
		deriveVetoBinding(manifest, "candidate"),
		14,
		ctx.clock.now().toISOString(),
	);
	return { baseEtag: (await ctx.bucket.get("manifest.json")).etag, manifest };
}
for (const token of [TOKENS.release, TOKENS.ops])
	test(`strict policy rejects legacy clean commit by ${token}`, async () => {
		const ctx = setup();
		ctx.deps.releaseDecisionRequired = true;
		const before = ctx.bucket.rawBytes("manifest.json");
		const res = await request(ctx.deps, "POST", "/admin/manifest", {
			token,
			body: await commitBody(ctx),
		});
		assert.equal(res.status, 403);
		assert.equal((await res.json()).error, "release_decision_required");
		assert.deepEqual(ctx.bucket.rawBytes("manifest.json"), before);
	});
test("strict policy allows existing beta reservation, abandonment and no-op operations", async () => {
	const ctx = setup();
	ctx.deps.releaseDecisionRequired = true;
	for (const [token, mutate] of [
		[TOKENS.beta, () => {}],
		[
			TOKENS.release,
			(m) => {
				m.releaseOps.candidate.state = "abandoned";
			},
		],
		[
			TOKENS.beta,
			(m) => {
				m.releaseOps["beta-new"] = {
					kind: "beta",
					state: "reserved",
					ver: "1.55.0-beta.2",
					betaVersion: null,
					sourceCommit: null,
					sha256: null,
					objectKey: null,
					createdAt: ctx.clock.now().toISOString(),
				};
				m.releaseLedger["1.55.0"].nextBetaN = 3;
			},
		],
	]) {
		const obj = await ctx.bucket.get("manifest.json");
		const m = await obj.json();
		mutate(m);
		const r = await request(ctx.deps, "POST", "/admin/manifest", {
			token,
			body: { baseEtag: obj.etag, manifest: m },
		});
		assert.equal(r.status, 200, await r.clone().text());
	}
});
test("strict policy preserves customer withdraw of an already committed release", async () => {
	const ctx = makeDeps();
	const m = fixtureManifest();
	seedBucketForManifest(ctx.bucket, m);
	ctx.deps.releaseDecisionRequired = true;
	const before = await ctx.bucket.get("manifest.json");
	m.channels["customer-release"].latest = null;
	m.versions["1.55.0"].status = "quarantined";
	const r = await request(ctx.deps, "POST", "/admin/manifest", {
		token: TOKENS.release,
		body: { baseEtag: before.etag, manifest: m },
	});
	assert.equal(r.status, 200, await r.clone().text());
});
test("Worker forwards strict policy; malformed config cannot restore the legacy clean write", async () => {
	for (const config of [env, { ...env, FW_RELEASE_CONTROL_JSON: "bad" }]) {
		const ctx = setup();
		const res = await worker.fetch(
			new Request("https://endpoint.test/admin/manifest", {
				method: "POST",
				headers: { authorization: `Bearer ${TOKENS.release}` },
				body: JSON.stringify(await commitBody(ctx)),
			}),
			{
				...config,
				PAYLOADS: ctx.bucket,
				FW_CUSTOMER_RELEASE_TOKEN_SHA256: sha256Hex(TOKENS.release),
			},
		);
		assert.equal(res.status, 403);
		assert.equal((await res.json()).error, "release_decision_required");
	}
});
test("Worker forwards valid control identity for authenticated attempt creation", async () => {
	const ctx = setup();
	const executor = "executor-fixture",
		writer = "writer-fixture";
	const body = {
		cycleId: "cycle-1",
		baseEtag: (await ctx.bucket.get("manifest.json")).etag,
		fullBinding: deriveVetoBinding(ctx.manifest, "candidate"),
		readbackSha256: "b".repeat(64),
	};
	const r = await worker.fetch(
		new Request("https://endpoint.test/admin/release-attempts", {
			method: "POST",
			headers: { authorization: `Bearer ${executor}` },
			body: JSON.stringify(body),
		}),
		{
			...env,
			PAYLOADS: ctx.bucket,
			FW_AUTO_RELEASE_EXECUTOR_TOKEN_SHA256: sha256Hex(executor),
			FW_RELEASE_DECISION_TOKEN_SHA256: sha256Hex(writer),
		},
	);
	assert.equal(r.status, 201, await r.clone().text());
	const a = await r.json();
	assert.equal(a.audience, control.audience);
	assert.equal(a.activationEpoch, 7);
});
