import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveVetoBinding } from "../src/manifest.mjs";
import {
	fixtureManifest,
	makeDeps,
	payloadKeyOf,
	request,
	seedBucketForManifest,
	TOKENS,
} from "./harness.mjs";

const executor = "release-executor-test";
const writer = "release-writer-test";
function setup() {
	const ctx = makeDeps({
		tokens: {
			...TOKENS,
			autoReleaseExecutor: executor,
			releaseDecision: writer,
		},
	});
	ctx.deps.releaseControl = {
		projectId: "flywheel",
		audience: "flywheel-payload",
		activationEpoch: 7,
		mode: "canary",
		enabled: true,
	};
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
async function input(ctx) {
	return {
		cycleId: "cycle-1",
		fullBinding: deriveVetoBinding(ctx.manifest, "candidate"),
		baseEtag: (await ctx.bucket.get("manifest.json")).etag,
		readbackSha256: "b".repeat(64),
	};
}
async function create(ctx, changes = {}) {
	const res = await request(ctx.deps, "POST", "/admin/release-attempts", {
		token: executor,
		body: { ...(await input(ctx)), ...changes },
	});
	assert.equal(res.status, 201, await res.clone().text());
	return res.json();
}
function permit(attempt, ctx, changes = {}) {
	return {
		...attempt,
		decisionId: "decision-1",
		action: "commit",
		trigger: "silence_auto",
		actor: "system",
		verdictId: "verdict-1",
		evidenceRevision: 4,
		claimedAt: ctx.clock.now().getTime(),
		notAfter: ctx.clock.now().getTime() + 30000,
		...changes,
	};
}
function putPermit(ctx, attempt, body, token = writer) {
	return request(
		ctx.deps,
		"PUT",
		`/admin/release-attempts/${attempt.attemptId}/permit`,
		{ token, body },
	);
}

test("fresh ready attempt is discovered despite retained historical attempt directories", async () => {
	const ctx = setup();
	const fresh = await create(ctx);
	for (let n = 1; n <= 64; n++) {
		const attemptId = `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
		ctx.bucket.seed(
			`control/customer-release/flywheel/${attemptId}/attempt.json`,
			JSON.stringify({
				schemaVersion: 1,
				attempt: { ...fresh, attemptId, readyAt: fresh.readyAt - n * 60000 },
			}),
		);
		ctx.bucket.seed(
			`control/customer-release-ready/flywheel/7/${Math.floor((fresh.readyAt - n * 60000) / 5000)}/${attemptId}/ready.json`,
			{
				schemaVersion: 1,
				ready: { attemptId, readyAt: fresh.readyAt - n * 60000 },
			},
		);
	}
	const list = ctx.bucket.list.bind(ctx.bucket);
	let calls = 0;
	ctx.bucket.list = async (options) => {
		calls++;
		assert.ok(
			options.prefix.startsWith("control/customer-release-ready/flywheel/7/"),
		);
		const bucket = Number(options.prefix.split("/").at(-2));
		assert.ok(Math.abs(bucket - Math.floor(fresh.readyAt / 5000)) <= 1);
		return list(options);
	};
	const response = await request(
		ctx.deps,
		"GET",
		"/admin/release-attempts/pending?limit=1",
		{ token: writer },
	);
	assert.equal(response.status, 200);
	assert.deepEqual((await response.json()).attempts, [fresh]);
	assert.ok(calls <= 3);
});

test("control plane defaults off and old roles cannot mint attempts", async () => {
	const ctx = setup();
	for (const token of [TOKENS.beta, TOKENS.release, TOKENS.ops, writer])
		assert.equal(
			(
				await request(ctx.deps, "POST", "/admin/release-attempts", {
					token,
					body: await input(ctx),
				})
			).status,
			403,
		);
	delete ctx.deps.releaseControl;
	assert.equal(
		(
			await request(ctx.deps, "POST", "/admin/release-attempts", {
				token: executor,
				body: await input(ctx),
			})
		).status,
		503,
	);
	assert.equal(
		[...ctx.bucket.objects.keys()].filter((k) => k.startsWith("control/"))
			.length,
		0,
	);
});
test("attempt identity comes from endpoint and durable exact reads survive handler recreation", async () => {
	const ctx = setup();
	const attempt = await create(ctx);
	assert.match(attempt.attemptId, /^[a-f0-9-]{36}$/);
	assert.match(attempt.nonce, /^[a-f0-9]{64}$/);
	assert.equal(attempt.projectId, "flywheel");
	assert.equal(attempt.activationEpoch, 7);
	assert.equal(attempt.readyAt, ctx.clock.now().getTime());
	assert.deepEqual(
		attempt.fullBinding,
		deriveVetoBinding(ctx.manifest, "candidate"),
	);
	for (const token of [executor, writer]) {
		const res = await request(
			{ ...ctx.deps },
			"GET",
			`/admin/release-attempts/${attempt.attemptId}`,
			{ token },
		);
		assert.equal(res.status, 200);
		assert.deepEqual((await res.json()).attempt, attempt);
	}
	const object = await (
		await ctx.bucket.get(
			`control/customer-release/flywheel/${attempt.attemptId}/attempt.json`,
		)
	).json();
	assert.equal(object.schemaVersion, 1);
	assert.deepEqual(object.attempt, attempt);
	assert.ok(
		ctx.logLines.every(
			(l) => !l.includes(attempt.attemptId) && !l.includes(attempt.nonce),
		),
	);
});
for (const mutation of [
	"extra",
	"etag",
	"binding",
	"readback",
	"metadata",
	"beta",
	"oversize",
]) {
	test(`create rejects ${mutation} without a control write`, async () => {
		const ctx = setup();
		const body = await input(ctx);
		if (mutation === "extra") body.manifest = ctx.manifest;
		if (mutation === "etag") body.baseEtag = "f".repeat(64);
		if (mutation === "binding") body.fullBinding.sourceCommit = "f".repeat(40);
		if (mutation === "readback") body.readbackSha256 = "f".repeat(64);
		if (mutation === "metadata")
			ctx.bucket.seed(ctx.manifest.releaseOps.candidate.objectKey, "bytes", {
				sha256: "f".repeat(64),
			});
		if (mutation === "beta") {
			ctx.manifest.versions["1.55.0-beta.1"].status = "withdrawn";
			ctx.bucket.seed("manifest.json", JSON.stringify(ctx.manifest));
			body.baseEtag = (await ctx.bucket.get("manifest.json")).etag;
		}
		const res = await request(ctx.deps, "POST", "/admin/release-attempts", {
			token: executor,
			body: mutation === "oversize" ? " ".repeat(65537) : body,
		});
		assert.ok(
			[400, 409, 412, 413].includes(res.status),
			`unexpected ${res.status}`,
		);
		assert.equal(
			[...ctx.bucket.objects.keys()].filter((k) => k.startsWith("control/"))
				.length,
			0,
		);
	});
}
test("only writer deposits one immutable permit; exact replay works even after expiry", async () => {
	const ctx = setup();
	const a = await create(ctx);
	const p = permit(a, ctx);
	assert.equal((await putPermit(ctx, a, p, executor)).status, 403);
	assert.equal((await putPermit(ctx, a, p)).status, 201);
	assert.equal(
		(await putPermit(ctx, a, { ...p, decisionId: "different" })).status,
		409,
	);
	ctx.clock.tick(31000);
	assert.equal((await putPermit(ctx, a, p)).status, 200);
	const res = await request(
		ctx.deps,
		"GET",
		`/admin/release-attempts/${a.attemptId}`,
		{ token: executor },
	);
	assert.deepEqual((await res.json()).permit, p);
});
for (const [name, change] of [
	["nonce", { nonce: "f".repeat(64) }],
	["audience", { audience: "other" }],
	["epoch", { activationEpoch: 8 }],
	["unknown-field", { approved: true }],
	["action", { action: "withdraw" }],
	["auto-actor", { actor: "founder" }],
	["manual-proof", { trigger: "founder_go", actor: "founder" }],
	["duration", { notAfter: Date.parse("2026-07-11T00:00:31.000Z") }],
	["future", { claimedAt: Date.parse("2026-07-11T00:00:06.000Z") }],
	[
		"expired",
		{
			claimedAt: Date.parse("2026-07-10T23:59:29.000Z"),
			notAfter: Date.parse("2026-07-10T23:59:59.000Z"),
		},
	],
])
	test(`permit rejects ${name} and cannot mutate manifest`, async () => {
		const ctx = setup();
		const a = await create(ctx);
		const before = ctx.bucket.rawBytes("manifest.json");
		assert.ok(
			[400, 409].includes(
				(await putPermit(ctx, a, permit(a, ctx, change))).status,
			),
		);
		assert.equal(
			await ctx.bucket.get(
				`control/customer-release/flywheel/${a.attemptId}/permit.json`,
			),
			null,
		);
		assert.deepEqual(ctx.bucket.rawBytes("manifest.json"), before);
	});
test("epoch change rejects an old attempt but preserves evidence for reconciliation", async () => {
	const ctx = setup();
	const a = await create(ctx);
	ctx.deps.releaseControl.activationEpoch++;
	assert.equal((await putPermit(ctx, a, permit(a, ctx))).status, 409);
	assert.equal(
		(
			await request(ctx.deps, "GET", `/admin/release-attempts/${a.attemptId}`, {
				token: writer,
			})
		).status,
		200,
	);
});
test("concurrent permit writes select one decision and never replace its bytes", async () => {
	const ctx = setup();
	const a = await create(ctx);
	const res = await Promise.all([
		putPermit(ctx, a, permit(a, ctx)),
		putPermit(ctx, a, permit(a, ctx, { decisionId: "decision-2" })),
	]);
	assert.deepEqual(res.map((r) => r.status).sort(), [201, 409]);
	const read = await request(
		ctx.deps,
		"GET",
		`/admin/release-attempts/${a.attemptId}`,
		{ token: writer },
	);
	assert.ok(
		["decision-1", "decision-2"].includes(
			(await read.json()).permit.decisionId,
		),
	);
});

async function authorized(ctx) {
	const a = await create(ctx);
	const p = permit(a, ctx);
	assert.equal((await putPermit(ctx, a, p)).status, 201);
	return { a, p };
}
async function execute(ctx, a, token = executor) {
	return request(
		ctx.deps,
		"POST",
		`/admin/release-attempts/${a.attemptId}/execute`,
		{ token, body: {} },
	);
}
async function getAttempt(ctx, a) {
	const r = await request(
		ctx.deps,
		"GET",
		`/admin/release-attempts/${a.attemptId}`,
		{ token: writer },
	);
	assert.equal(r.status, 200);
	return r.json();
}
function manifestPuts(ctx) {
	return ctx.bucket.observations.puts.filter((p) => p.key === "manifest.json")
		.length;
}

test("executor commits one endpoint-built diff and replay only reads the exact published tuple", async () => {
	const ctx = setup();
	const { a } = await authorized(ctx);
	assert.equal((await execute(ctx, a, writer)).status, 403);
	const response = await execute(ctx, a);
	assert.equal(response.status, 200, await response.clone().text());
	assert.equal((await response.json()).kind, "published");
	const m = await (await ctx.bucket.get("manifest.json")).json();
	assert.equal(m.channels["customer-release"].latest, "1.55.0");
	assert.equal(m.releaseOps.candidate.state, "committed");
	assert.equal(m.versions["1.55.0"].sha256, a.fullBinding.releasePayloadSha256);
	assert.equal(manifestPuts(ctx), 1);
	ctx.clock.tick(60000);
	assert.equal((await (await execute(ctx, a)).json()).kind, "published");
	assert.equal(manifestPuts(ctx), 1);
	assert.equal((await getAttempt(ctx, a)).result.kind, "published");
});
test("execute has no authority until writer persisted a permit", async () => {
	const ctx = setup();
	const a = await create(ctx);
	assert.equal((await execute(ctx, a)).status, 409);
	assert.equal(manifestPuts(ctx), 0);
	assert.equal(
		await ctx.bucket.get(
			`control/customer-release/flywheel/${a.attemptId}/started.json`,
		),
		null,
	);
});
for (const guard of ["expired", "epoch", "disabled", "artifact", "beta"]) {
	test(`execution guard ${guard} produces durable no_write with zero manifest attempts`, async () => {
		const ctx = setup();
		const { a } = await authorized(ctx);
		if (guard === "expired") ctx.clock.tick(30001);
		if (guard === "epoch") ctx.deps.releaseControl.activationEpoch++;
		if (guard === "disabled") ctx.deps.releaseControl.enabled = false;
		if (guard === "artifact")
			await ctx.bucket.delete(ctx.manifest.releaseOps.candidate.objectKey);
		if (guard === "beta") {
			ctx.manifest.versions["1.55.0-beta.1"].status = "withdrawn";
			ctx.bucket.seed("manifest.json", JSON.stringify(ctx.manifest));
		}
		const res = await execute(ctx, a);
		assert.equal(res.status, 200, await res.clone().text());
		assert.equal((await res.json()).kind, "no_write");
		assert.equal(manifestPuts(ctx), 0);
		assert.equal((await getAttempt(ctx, a)).result.kind, "no_write");
	});
}
test("two overlapping executors get one started winner and at most one manifest CAS", async () => {
	const ctx = setup();
	const { a } = await authorized(ctx);
	let unblock, arrived;
	const blocked = new Promise((r) => {
		unblock = r;
	});
	const held = new Promise((r) => {
		arrived = r;
	});
	const put = ctx.bucket.put.bind(ctx.bucket);
	ctx.bucket.put = async (key, ...args) => {
		if (key === "manifest.json") {
			arrived();
			await blocked;
		}
		return put(key, ...args);
	};
	const first = execute(ctx, a);
	const reached = await Promise.race([
		held.then(() => true),
		first.then(() => false),
	]);
	assert.equal(reached, true, "executor must reach the held manifest CAS");
	try {
		const second = await execute(ctx, a);
		assert.equal(second.status, 200);
		assert.equal((await second.json()).kind, "unknown");
	} finally {
		unblock();
	}
	assert.equal((await (await first).json()).kind, "published");
	assert.equal(manifestPuts(ctx), 1);
});
test("lost manifest PUT reply reconciles exact op and never retries the write", async () => {
	const ctx = setup();
	const { a } = await authorized(ctx);
	const put = ctx.bucket.put.bind(ctx.bucket);
	ctx.bucket.put = async (key, ...args) => {
		const value = await put(key, ...args);
		if (key === "manifest.json") throw new Error("lost response");
		return value;
	};
	const res = await execute(ctx, a);
	assert.equal(res.status, 200);
	assert.equal((await res.json()).kind, "unknown");
	assert.equal((await getAttempt(ctx, a)).result.kind, "published");
	assert.equal((await (await execute(ctx, a)).json()).kind, "published");
	assert.equal(manifestPuts(ctx), 1);
});
test("started marker survives handler failure; prepared alone remains unknown after permit expires", async () => {
	const ctx = setup();
	const { a } = await authorized(ctx);
	const put = ctx.bucket.put.bind(ctx.bucket);
	ctx.bucket.put = async (key, ...args) => {
		const value = await put(key, ...args);
		if (key.endsWith("/started.json"))
			throw new Error("crash after durable started");
		return value;
	};
	assert.equal((await execute(ctx, a)).status, 503);
	ctx.bucket.put = put;
	ctx.clock.tick(60000);
	assert.equal((await getAttempt(ctx, a)).result.kind, "unknown");
	assert.equal((await (await execute(ctx, a)).json()).kind, "unknown");
	assert.equal(manifestPuts(ctx), 0);
});
test("the final permit check runs after artifact metadata await", async () => {
	const ctx = setup();
	const { a } = await authorized(ctx);
	const head = ctx.bucket.head.bind(ctx.bucket);
	ctx.bucket.head = async (key) => {
		const value = await head(key);
		ctx.clock.tick(31000);
		return value;
	};
	assert.equal((await (await execute(ctx, a)).json()).kind, "no_write");
	assert.equal(manifestPuts(ctx), 0);
});
test("a definite manifest CAS conflict is durable no_write, not a blind retry", async () => {
	const ctx = setup();
	const { a } = await authorized(ctx);
	const put = ctx.bucket.put.bind(ctx.bucket);
	ctx.bucket.put = async (key, ...args) =>
		key === "manifest.json" ? null : put(key, ...args);
	assert.equal((await (await execute(ctx, a)).json()).reason, "cas_conflict");
	assert.equal((await getAttempt(ctx, a)).result.kind, "no_write");
});
async function fenceIntent(ctx, a, p, token = writer) {
	return request(
		ctx.deps,
		"PUT",
		`/admin/release-attempts/${a.attemptId}/fence-intent`,
		{
			token,
			body: {
				decisionId: p.decisionId,
				nonce: a.nonce,
				baseEtag: a.baseEtag,
				fullBinding: a.fullBinding,
				reason: "disable_drain",
			},
		},
	);
}
async function fence(ctx, a, token = executor) {
	return request(
		ctx.deps,
		"POST",
		`/admin/release-attempts/${a.attemptId}/fence`,
		{ token, body: {} },
	);
}
test("only a durable exact writer fence intent authorizes executor abandonment", async () => {
	const ctx = setup();
	const { a, p } = await authorized(ctx);
	assert.equal((await fence(ctx, a)).status, 409);
	assert.equal((await fenceIntent(ctx, a, p, executor)).status, 403);
	assert.equal((await fenceIntent(ctx, a, p)).status, 201);
	assert.equal((await fence(ctx, a, writer)).status, 403);
	ctx.clock.tick(60000);
	ctx.deps.releaseControl.enabled = false;
	const res = await fence(ctx, a);
	assert.equal(res.status, 200, await res.clone().text());
	assert.equal((await res.json()).kind, "fenced");
	assert.equal((await getAttempt(ctx, a)).result.kind, "fenced");
	assert.equal((await (await execute(ctx, a)).json()).kind, "fenced");
	assert.equal(manifestPuts(ctx), 1);
	const m = await (await ctx.bucket.get("manifest.json")).json();
	assert.equal(m.channels["customer-release"].latest, null);
});
for (const winner of ["fence", "commit"]) {
	test(`late manifest PUT race: ${winner} wins, unknown resolves from exact manifest`, async () => {
		const ctx = setup();
		const { a, p } = await authorized(ctx);
		await fenceIntent(ctx, a, p);
		let unblock, arrived;
		const blocked = new Promise((r) => {
			unblock = r;
		});
		const held = new Promise((r) => {
			arrived = r;
		});
		const put = ctx.bucket.put.bind(ctx.bucket);
		let once = true;
		ctx.bucket.put = async (key, ...args) => {
			if (key === "manifest.json" && once) {
				once = false;
				arrived();
				await blocked;
			}
			return put(key, ...args);
		};
		const delayed = winner === "fence" ? execute(ctx, a) : fence(ctx, a);
		const reached = await Promise.race([
			held.then(() => true),
			delayed.then(() => false),
		]);
		assert.equal(reached, true, "first operation must reach its CAS");
		let winning;
		try {
			winning = await (
				await (winner === "fence" ? fence(ctx, a) : execute(ctx, a))
			).json();
		} finally {
			unblock();
		}
		assert.equal(winning.kind, winner === "fence" ? "fenced" : "published");
		await delayed;
		const final = await getAttempt(ctx, a);
		assert.equal(final.result.kind, winning.kind);
		const m = await (await ctx.bucket.get("manifest.json")).json();
		assert.equal(
			m.releaseOps.candidate.state,
			winner === "fence" ? "abandoned" : "committed",
		);
		assert.equal((await (await execute(ctx, a)).json()).kind, winning.kind);
		assert.equal(manifestPuts(ctx), 2);
	});
}

test("pending is writer-only, paginated and excludes claimed, stale and other-epoch attempts", async () => {
	const ctx = setup();
	const fresh = await create(ctx);
	const claimed = await create(ctx);
	await putPermit(ctx, claimed, permit(claimed, ctx));
	const stale = await create(ctx);
	const oldEpoch = await create(ctx);
	for (const [a, change] of [
		[stale, { readyAt: ctx.clock.now().getTime() - 5001 }],
		[oldEpoch, { activationEpoch: 6 }],
	])
		ctx.bucket.seed(
			`control/customer-release/flywheel/${a.attemptId}/attempt.json`,
			{ schemaVersion: 1, attempt: { ...a, ...change } },
		);

	assert.equal(
		(
			await request(
				ctx.deps,
				"GET",
				"/admin/release-attempts/pending?limit=2",
				{ token: executor },
			)
		).status,
		403,
	);
	const found = [];
	let cursor;
	let pages = 0;
	do {
		const params = new URLSearchParams({ limit: "2" });
		if (cursor) params.set("cursor", cursor);
		const response = await request(
			ctx.deps,
			"GET",
			`/admin/release-attempts/pending?${params}`,
			{ token: writer },
		);
		assert.equal(response.status, 200, await response.clone().text());
		const page = await response.json();
		found.push(...page.attempts);
		cursor = page.cursor;
		assert.ok(++pages <= 5);
	} while (cursor);
	assert.deepEqual(found, [fresh]);
});
for (const query of [
	"limit=0",
	"limit=101",
	"limit=1.5",
	"limit=2&limit=3",
	"project=other",
	"cursor=",
	`cursor=${"a".repeat(1025)}`,
])
	test(`pending rejects invalid pagination ${query.slice(0, 50)}`, async () => {
		const ctx = setup();
		ctx.bucket.list = async () => {
			assert.fail("invalid input must not list storage");
		};
		const res = await request(
			ctx.deps,
			"GET",
			`/admin/release-attempts/pending?${query}`,
			{ token: writer },
		);
		assert.equal(res.status, 400);
	});
for (const fault of [
	"out-of-prefix",
	"bad-record",
	"missing-cursor",
	"too-many",
	"list-error",
])
	test(`pending fails closed on ${fault}`, async () => {
		const ctx = setup();
		const a = await create(ctx);
		const dir = `control/customer-release-ready/flywheel/7/${Math.floor(a.readyAt / 5000)}/${a.attemptId}/`;
		if (fault === "bad-record")
			ctx.bucket.seed(
				`control/customer-release/flywheel/${a.attemptId}/attempt.json`,
				{ schemaVersion: 99, attempt: a },
			);
		ctx.bucket.list = async () => {
			if (fault === "list-error") throw Error("storage unavailable");
			return {
				objects: [],
				delimitedPrefixes:
					fault === "out-of-prefix"
						? [`control/customer-release/other/${a.attemptId}/`]
						: fault === "too-many"
							? [dir, dir]
							: [dir],
				truncated: fault === "missing-cursor",
			};
		};
		const res = await request(
			ctx.deps,
			"GET",
			"/admin/release-attempts/pending?limit=1",
			{ token: writer },
		);
		assert.equal(res.status, 503);
	});

test("pending uses the real memory adapter without exposing control content to old roles", async () => {
	const ctx = setup();
	const a = await create(ctx);
	const res = await request(
		ctx.deps,
		"GET",
		"/admin/release-attempts/pending?limit=1",
		{ token: writer },
	);
	assert.equal(res.status, 200);
	assert.deepEqual((await res.json()).attempts, [a]);
	for (const token of [TOKENS.beta, TOKENS.release, TOKENS.ops])
		assert.equal(
			(
				await request(ctx.deps, "GET", "/admin/release-attempts/pending", {
					token,
				})
			).status,
			403,
		);
	ctx.clock.tick(5001);
	assert.deepEqual(
		(
			await (
				await request(ctx.deps, "GET", "/admin/release-attempts/pending", {
					token: writer,
				})
			).json()
		).attempts,
		[],
	);
});

test("pending accepts Cloudflare's documented delimited prefix without a trailing slash", async () => {
	const ctx = setup();
	const a = await create(ctx);
	ctx.bucket.list = async ({ prefix }) => ({
		objects: [],
		delimitedPrefixes: prefix.endsWith(`/${Math.floor(a.readyAt / 5000)}/`)
			? [`${prefix}${a.attemptId}`]
			: [],
		truncated: false,
	});
	const r = await request(ctx.deps, "GET", "/admin/release-attempts/pending", {
		token: writer,
	});
	assert.equal(r.status, 200);
	assert.deepEqual((await r.json()).attempts, [a]);
});

for (const delta of [4999, 5000, 5001]) {
	test(`discovery time boundary ${delta}ms preserves original freshness`, async () => {
		const ctx = setup();
		const a = await create(ctx);
		ctx.clock.tick(delta);
		const r = await request(
			ctx.deps,
			"GET",
			"/admin/release-attempts/pending?limit=1",
			{ token: writer },
		);
		assert.equal(r.status, 200);
		assert.deepEqual((await r.json()).attempts, delta <= 5000 ? [a] : []);
	});
}
test("an old cursor cannot pin discovery behind a fresh time partition", async () => {
	const ctx = setup();
	await create(ctx);
	const first = await request(
		ctx.deps,
		"GET",
		"/admin/release-attempts/pending?limit=1",
		{ token: writer },
	);
	const { cursor } = await first.json();
	assert.ok(cursor);
	ctx.clock.tick(60000);
	const fresh = await create(ctx);
	const params = new URLSearchParams({ limit: "1", cursor });
	const r = await request(
		ctx.deps,
		"GET",
		`/admin/release-attempts/pending?${params}`,
		{ token: writer },
	);
	assert.deepEqual((await r.json()).attempts, [fresh]);
});
test("discovery index failure cannot acknowledge a ready attempt", async () => {
	const ctx = setup();
	const put = ctx.bucket.put.bind(ctx.bucket);
	ctx.bucket.put = async (key, ...args) => {
		if (key.startsWith("control/customer-release-ready/"))
			throw Error("index unavailable");
		return put(key, ...args);
	};
	const r = await request(ctx.deps, "POST", "/admin/release-attempts", {
		token: executor,
		body: await input(ctx),
	});
	assert.equal(r.status, 503);
	assert.equal(
		[...ctx.bucket.objects.keys()].filter((k) => k.endsWith("/attempt.json"))
			.length,
		1,
	);
	const pending = await request(
		ctx.deps,
		"GET",
		"/admin/release-attempts/pending",
		{ token: writer },
	);
	assert.deepEqual((await pending.json()).attempts, []);
});
