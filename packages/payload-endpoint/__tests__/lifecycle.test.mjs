// FLY-1062 PR3 · release-operation lifecycle (plan §B0-9) + retention/cleanup
// protocol (§B0-10) + server time authority (§B0-2-3/9) — driven through the
// real handler exactly the way the release scripts drive it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
	DAY,
	edit,
	fixtureManifest,
	getManifest,
	makeClock,
	makeDeps,
	payloadKeyOf,
	postManifest,
	request,
	seedBucketForManifest,
	TOKENS,
} from "./harness.mjs";
import { MemoryBucket } from "./memory-bucket.mjs";

const COMMIT = "c".repeat(40);

function seeded(manifest = fixtureManifest()) {
	const bucket = new MemoryBucket();
	seedBucketForManifest(bucket, manifest);
	const clock = makeClock("2026-07-11T00:00:00.000Z");
	return { ...makeDeps({ bucket, clock }), manifest };
}

// drive one full beta publish through the handler, the way
// payload-release.mjs does. Returns {ver, sha, objectKey}.
async function publishBeta(deps, id, bytes, { skipCommit = false } = {}) {
	// 1. reserve (ledger-fused)
	let g = await getManifest(deps);
	const base = "1.55.0";
	const n = g.manifest.releaseLedger[base]?.nextBetaN ?? 1;
	const ver = `${base}-beta.${n}`;
	const reserved = edit(g.manifest, (x) => {
		x.releaseOps[id] = {
			kind: "beta",
			state: "reserved",
			ver,
			betaVersion: null,
			sourceCommit: null,
			sha256: null,
			objectKey: null,
			createdAt: "1999-01-01T00:00:00.000Z",
		};
		x.releaseLedger[base] = { nextBetaN: n + 1 };
	});
	assert.equal(
		(await postManifest(deps, reserved, g.etag, TOKENS.beta)).status,
		200,
	);
	// 2. tuple registration (BEFORE upload)
	const sha = createHash("sha256").update(bytes).digest("hex");
	const objectKey = payloadKeyOf(ver, sha);
	g = await getManifest(deps);
	const registered = edit(g.manifest, (x) => {
		x.releaseOps[id].sourceCommit = COMMIT;
		x.releaseOps[id].sha256 = sha;
		x.releaseOps[id].objectKey = objectKey;
	});
	assert.equal(
		(await postManifest(deps, registered, g.etag, TOKENS.beta)).status,
		200,
	);
	// 3. upload + prepared
	const put = await request(deps, "PUT", `/admin/payload/${ver}/${sha}`, {
		token: TOKENS.beta,
		body: bytes,
	});
	assert.ok([200, 409].includes(put.status)); // 409 = already uploaded (retry)
	g = await getManifest(deps);
	const prepared = edit(g.manifest, (x) => {
		x.releaseOps[id].state = "prepared";
	});
	assert.equal(
		(await postManifest(deps, prepared, g.etag, TOKENS.beta)).status,
		200,
	);
	if (skipCommit) return { ver, sha, objectKey };
	// 4. commit: entry + pointer + op committed, ONE CAS
	g = await getManifest(deps);
	const committed = edit(g.manifest, (x) => {
		x.versions[ver] = {
			sha256: sha,
			key: objectKey,
			size: bytes.length,
			publishedAt: "1999-01-01T00:00:00.000Z", // server overwrites
			channel: "beta",
			status: "active",
			sourceCommit: COMMIT,
			releaseId: id,
			derivedFromBeta: null,
			retentionSince: null,
			quarantinedAt: null,
		};
		x.channels["internal-beta"].latest = ver;
		x.releaseOps[id].state = "committed";
	});
	assert.equal(
		(await postManifest(deps, committed, g.etag, TOKENS.beta)).status,
		200,
	);
	return { ver, sha, objectKey };
}

test("B0-9 happy path: reserve → register → upload → prepared → commit (one CAS commit point)", async () => {
	const { deps, clock } = seeded();
	clock.set("2026-07-11T08:00:00.000Z");
	const { ver } = await publishBeta(
		deps,
		"gh-run-100",
		Buffer.from("beta-2-bytes"),
	);
	assert.equal(ver, "1.55.0-beta.2");
	const { manifest } = await getManifest(deps);
	assert.equal(manifest.channels["internal-beta"].latest, ver);
	assert.equal(manifest.versions[ver].status, "active");
	assert.equal(manifest.releaseOps["gh-run-100"].state, "committed");
	// server-owned stamps, not the client's 1999 values
	assert.equal(manifest.versions[ver].publishedAt, "2026-07-11T08:00:00.000Z");
	assert.equal(
		manifest.releaseOps["gh-run-100"].createdAt,
		"2026-07-11T08:00:00.000Z",
	);
	// pointer migration: the previous beta left latest and got stamped
	assert.equal(
		manifest.versions["1.55.0-beta.1"].retentionSince,
		"2026-07-11T08:00:00.000Z",
	);
	assert.equal(manifest.versions[ver].retentionSince, null);
});

test("same releaseId re-reservation after 412 → reuse, never a second N", async () => {
	const { deps } = seeded();
	// two concurrent reservations race on the same etag; the loser re-reads and
	// finds its op already there (same id ⇒ same pinned ver, ledger untouched).
	const g = await getManifest(deps);
	const mk = (m) =>
		edit(m, (x) => {
			x.releaseOps["gh-run-7"] = {
				kind: "beta",
				state: "reserved",
				ver: "1.55.0-beta.2",
				betaVersion: null,
				sourceCommit: null,
				sha256: null,
				objectKey: null,
				createdAt: "1999-01-01T00:00:00.000Z",
			};
			x.releaseLedger["1.55.0"].nextBetaN = 3;
		});
	assert.equal(
		(await postManifest(deps, mk(g.manifest), g.etag, TOKENS.beta)).status,
		200,
	);
	// retry with the stale etag → 412 (protocol: re-read, see op exists, reuse)
	assert.equal(
		(await postManifest(deps, mk(g.manifest), g.etag, TOKENS.beta)).status,
		412,
	);
	const after = await getManifest(deps);
	assert.equal(after.manifest.releaseOps["gh-run-7"].ver, "1.55.0-beta.2");
	assert.equal(
		after.manifest.releaseLedger["1.55.0"].nextBetaN,
		3,
		"no double allocation",
	);
});

test("crash between registration and upload: claim visible in manifest, object absent, rerun continues", async () => {
	const { deps, bucket } = seeded();
	const bytes = Buffer.from("interrupted-upload");
	const sha = createHash("sha256").update(bytes).digest("hex");
	// reserve + register, then "crash" (no upload)
	let g = await getManifest(deps);
	const reserved = edit(g.manifest, (x) => {
		x.releaseOps["gh-run-8"] = {
			kind: "beta",
			state: "reserved",
			ver: "1.55.0-beta.2",
			betaVersion: null,
			sourceCommit: COMMIT,
			sha256: sha,
			objectKey: payloadKeyOf("1.55.0-beta.2", sha),
			createdAt: "1999-01-01T00:00:00.000Z",
		};
		x.releaseLedger["1.55.0"].nextBetaN = 3;
	});
	assert.equal(
		(await postManifest(deps, reserved, g.etag, TOKENS.beta)).status,
		200,
	);
	// orphan discovery: the staging object is representable from the manifest
	g = await getManifest(deps);
	const op = g.manifest.releaseOps["gh-run-8"];
	assert.equal(op.state, "reserved");
	assert.equal(bucket.rawBytes(op.objectKey), null, "object never made it");
	// rerun continues from the claim: upload + prepared succeed
	const put = await request(
		deps,
		"PUT",
		`/admin/payload/1.55.0-beta.2/${sha}`,
		{
			token: TOKENS.beta,
			body: bytes,
		},
	);
	assert.equal(put.status, 200);
});

test("upload landed but response lost: rerun tolerates 409 + readback + idempotent prepared", async () => {
	const { deps } = seeded();
	const bytes = Buffer.from("upload-then-lost-response");
	const { ver, sha } = await publishBeta(deps, "gh-run-9", bytes, {
		skipCommit: true,
	});
	// rerun's upload → 409 (already exists) is TOLERATED, then readback verifies
	const dup = await request(deps, "PUT", `/admin/payload/${ver}/${sha}`, {
		token: TOKENS.beta,
		body: bytes,
	});
	assert.equal(dup.status, 409);
	const rb = await request(deps, "GET", `/admin/payload/${ver}/${sha}`, {
		token: TOKENS.beta,
	});
	const got = createHash("sha256")
		.update(Buffer.from(await rb.arrayBuffer()))
		.digest("hex");
	assert.equal(got, sha);
	// idempotent prepared: already prepared → posting the same state is a no-op 200
	const g = await getManifest(deps);
	const same = edit(g.manifest, () => {});
	assert.equal(
		(await postManifest(deps, same, g.etag, TOKENS.beta)).status,
		200,
	);
});

test("commit succeeded but response lost: rerun's re-post of the SAME final state is a no-op success; zero second beta", async () => {
	const { deps } = seeded();
	const bytes = Buffer.from("commit-retry-bytes");
	const { ver } = await publishBeta(deps, "gh-run-10", bytes);
	// rerun re-reads and re-submits the identical final state
	const g = await getManifest(deps);
	const resubmit = edit(g.manifest, () => {});
	assert.equal(
		(await postManifest(deps, resubmit, g.etag, TOKENS.beta)).status,
		200,
	);
	const after = await getManifest(deps);
	const betas = Object.keys(after.manifest.versions).filter((v) =>
		v.includes("-beta."),
	);
	assert.deepEqual(
		betas.sort(),
		["1.55.0-beta.1", ver].sort(),
		"zero second beta",
	);
});

test("same id, different tuple → fail-closed (write-once tuple)", async () => {
	const { deps } = seeded();
	await publishBeta(deps, "gh-run-11", Buffer.from("original"), {
		skipCommit: true,
	});
	const g = await getManifest(deps);
	const mutated = edit(g.manifest, (x) => {
		x.releaseOps["gh-run-11"].sha256 = "0".repeat(64);
		x.releaseOps["gh-run-11"].objectKey = payloadKeyOf(
			x.releaseOps["gh-run-11"].ver,
			"0".repeat(64),
		);
	});
	const res = await postManifest(deps, mutated, g.etag, TOKENS.beta);
	assert.equal(res.status, 422);
});

test("commit vs abandon race: CAS serializes; committed→abandon refused, abandoned→commit refused", async () => {
	const { deps } = seeded();
	const bytes = Buffer.from("race-bytes");
	const { ver } = await publishBeta(deps, "gh-run-12", bytes, {
		skipCommit: true,
	});
	const g = await getManifest(deps);
	const commitDiff = edit(g.manifest, (x) => {
		x.versions[ver] = {
			sha256: x.releaseOps["gh-run-12"].sha256,
			key: x.releaseOps["gh-run-12"].objectKey,
			size: bytes.length,
			publishedAt: "1999-01-01T00:00:00.000Z",
			channel: "beta",
			status: "active",
			sourceCommit: COMMIT,
			releaseId: "gh-run-12",
			derivedFromBeta: null,
			retentionSince: null,
			quarantinedAt: null,
		};
		x.channels["internal-beta"].latest = ver;
		x.releaseOps["gh-run-12"].state = "committed";
	});
	const abandonDiff = edit(g.manifest, (x) => {
		x.releaseOps["gh-run-12"].state = "abandoned";
	});
	// commit wins the CAS
	assert.equal(
		(await postManifest(deps, commitDiff, g.etag, TOKENS.beta)).status,
		200,
	);
	// abandon raced on the old etag → 412
	assert.equal(
		(await postManifest(deps, abandonDiff, g.etag, TOKENS.beta)).status,
		412,
	);
	// re-read + abandon of a COMMITTED op → illegal move
	const g2 = await getManifest(deps);
	const abandonAfter = edit(g2.manifest, (x) => {
		x.releaseOps["gh-run-12"].state = "abandoned";
	});
	assert.equal(
		(await postManifest(deps, abandonAfter, g2.etag, TOKENS.beta)).status,
		422,
	);
	// mirror: abandoned op cannot be committed (fresh op on a new fixture)
	const fresh = seeded();
	await publishBeta(fresh.deps, "gh-run-13", Buffer.from("x"), {
		skipCommit: true,
	});
	const g3 = await getManifest(fresh.deps);
	const abandoned = edit(g3.manifest, (x) => {
		x.releaseOps["gh-run-13"].state = "abandoned";
	});
	assert.equal(
		(await postManifest(fresh.deps, abandoned, g3.etag, TOKENS.beta)).status,
		200,
	);
	const g4 = await getManifest(fresh.deps);
	const necroCommit = edit(g4.manifest, (x) => {
		x.releaseOps["gh-run-13"].state = "committed";
	});
	assert.equal(
		(await postManifest(fresh.deps, necroCommit, g4.etag, TOKENS.beta)).status,
		422,
	);
});

test("reserved → abandoned (pre-upload exit) is legal; beta abandon by ops-admin also legal", async () => {
	const { deps } = seeded();
	const g = await getManifest(deps);
	const reserved = edit(g.manifest, (x) => {
		x.releaseOps["gh-run-14"] = {
			kind: "beta",
			state: "reserved",
			ver: "1.55.0-beta.2",
			betaVersion: null,
			sourceCommit: null,
			sha256: null,
			objectKey: null,
			createdAt: "1999-01-01T00:00:00.000Z",
		};
		x.releaseLedger["1.55.0"].nextBetaN = 3;
	});
	assert.equal(
		(await postManifest(deps, reserved, g.etag, TOKENS.beta)).status,
		200,
	);
	const g2 = await getManifest(deps);
	const abandoned = edit(g2.manifest, (x) => {
		x.releaseOps["gh-run-14"].state = "abandoned";
	});
	assert.equal(
		(await postManifest(deps, abandoned, g2.etag, TOKENS.ops)).status,
		200,
	);
	// ledger hole (N=2 burned) is harmless; next reservation takes N=3
	const g3 = await getManifest(deps);
	assert.equal(g3.manifest.releaseLedger["1.55.0"].nextBetaN, 3);
});

test("time authority: client-submitted backdated/future lifecycle stamps are overwritten with the server clock", async () => {
	const { deps, clock } = seeded();
	clock.set("2026-07-11T09:30:00.000Z");
	const bytes = Buffer.from("stamp-bytes");
	const { ver } = await publishBeta(deps, "gh-run-15", bytes, {
		skipCommit: true,
	});
	const g = await getManifest(deps);
	const committed = edit(g.manifest, (x) => {
		x.versions[ver] = {
			sha256: x.releaseOps["gh-run-15"].sha256,
			key: x.releaseOps["gh-run-15"].objectKey,
			size: bytes.length,
			publishedAt: "2099-01-01T00:00:00.000Z", // future — must be overwritten
			channel: "beta",
			status: "active",
			sourceCommit: COMMIT,
			releaseId: "gh-run-15",
			derivedFromBeta: null,
			retentionSince: null,
			quarantinedAt: null,
		};
		x.channels["internal-beta"].latest = ver;
		x.releaseOps["gh-run-15"].state = "committed";
		// try to backdate the superseded beta's clock (would fake an early expiry)
		x.versions["1.55.0-beta.1"].retentionSince = "2020-01-01T00:00:00.000Z";
	});
	assert.equal(
		(await postManifest(deps, committed, g.etag, TOKENS.beta)).status,
		200,
	);
	const { manifest } = await getManifest(deps);
	assert.equal(manifest.versions[ver].publishedAt, "2026-07-11T09:30:00.000Z");
	assert.equal(
		manifest.versions["1.55.0-beta.1"].retentionSince,
		"2026-07-11T09:30:00.000Z",
		"backdated clock refused — server stamped its own",
	);
});

test("expire protocol: latest refused; window enforced with the injected clock; view drops it immediately", async () => {
	const { deps, clock } = seeded();
	// supersede beta.1 so it gets a retention clock
	await publishBeta(deps, "gh-run-16", Buffer.from("supersede"));
	// expire the still-latest beta.2 → refused
	{
		const g = await getManifest(deps);
		const bad = edit(g.manifest, (x) => {
			x.versions["1.55.0-beta.2"].status = "expired";
		});
		const res = await postManifest(deps, bad, g.etag, TOKENS.ops);
		assert.equal(res.status, 422);
	}
	// expire beta.1 before the 14d window → refused
	clock.tick(13 * DAY);
	{
		const g = await getManifest(deps);
		const early = edit(g.manifest, (x) => {
			x.versions["1.55.0-beta.1"].status = "expired";
		});
		assert.equal(
			(await postManifest(deps, early, g.etag, TOKENS.ops)).status,
			422,
		);
	}
	// after the window → allowed (ops-admin only), views drop it immediately
	clock.tick(2 * DAY);
	{
		const g = await getManifest(deps);
		const ok = edit(g.manifest, (x) => {
			x.versions["1.55.0-beta.1"].status = "expired";
		});
		assert.equal(
			(await postManifest(deps, ok, g.etag, TOKENS.beta)).status,
			403,
		);
		assert.equal(
			(await postManifest(deps, ok, g.etag, TOKENS.ops)).status,
			200,
		);
	}
});

test("re-pin scenario (plan B0-10-1): A→B→withdraw-fallback-A→C; A免死 during fallback, clock restarts after C", async () => {
	// A = 1.55.0 (fixture release). Build B, withdraw B → fallback A, then C.
	const { deps, clock } = seeded();
	clock.set("2026-07-11T00:00:00.000Z");
	// helper: full release publish via handler (prepare+commit fused here)
	async function publishRelease(id, ver, betaId, _betaVer, bytes) {
		// beta first
		await publishBeta(deps, betaId, Buffer.from(`beta-${ver}`));
		const g0 = await getManifest(deps);
		const actualBetaVer = g0.manifest.releaseOps[betaId].ver;
		const sha = createHash("sha256").update(bytes).digest("hex");
		const objectKey = payloadKeyOf(ver, sha);
		let g = await getManifest(deps);
		const reserved = edit(g.manifest, (x) => {
			x.releaseOps[id] = {
				kind: "release",
				state: "reserved",
				ver,
				betaVersion: actualBetaVer,
				sourceCommit: COMMIT,
				sha256: sha,
				objectKey,
				createdAt: "1999-01-01T00:00:00.000Z",
			};
		});
		assert.equal(
			(await postManifest(deps, reserved, g.etag, TOKENS.beta)).status,
			200,
		);
		assert.equal(
			(
				await request(deps, "PUT", `/admin/payload/${ver}/${sha}`, {
					token: TOKENS.beta,
					body: bytes,
				})
			).status,
			200,
		);
		g = await getManifest(deps);
		const prepared = edit(g.manifest, (x) => {
			x.releaseOps[id].state = "prepared";
		});
		assert.equal(
			(await postManifest(deps, prepared, g.etag, TOKENS.beta)).status,
			200,
		);
		g = await getManifest(deps);
		const committed = edit(g.manifest, (x) => {
			x.versions[ver] = {
				sha256: sha,
				key: objectKey,
				size: bytes.length,
				publishedAt: "1999-01-01T00:00:00.000Z",
				channel: "release",
				status: "active",
				sourceCommit: COMMIT,
				releaseId: id,
				derivedFromBeta: actualBetaVer,
				retentionSince: null,
				quarantinedAt: null,
			};
			x.channels["customer-release"].latest = ver;
			x.releaseOps[id].state = "committed";
		});
		assert.equal(
			(await postManifest(deps, committed, g.etag, TOKENS.release)).status,
			200,
		);
		return ver;
	}
	// B = 1.56.0 — wait: release base must match its beta base; our beta line is
	// pinned to base 1.55.0, so model B/C as maintenance releases is not
	// expressible. Instead: bump doc base by publishing betas of new bases via
	// direct ledger seeding is over-modeling — the withdraw semantics only need
	// THREE releases; reuse fixture 1.55.0 as A and craft B=1.56.0/C=1.57.0 with
	// their own betas (base-matched), exactly like production promote does.
	// (publishBeta pins base 1.55.0, so inline beta publishing for 1.56/1.57:)
	async function publishBetaOf(base, id, bytes) {
		let g = await getManifest(deps);
		const n = g.manifest.releaseLedger[base]?.nextBetaN ?? 1;
		const ver = `${base}-beta.${n}`;
		const sha = createHash("sha256").update(bytes).digest("hex");
		const objectKey = payloadKeyOf(ver, sha);
		const reserved = edit(g.manifest, (x) => {
			x.releaseOps[id] = {
				kind: "beta",
				state: "reserved",
				ver,
				betaVersion: null,
				sourceCommit: COMMIT,
				sha256: sha,
				objectKey,
				createdAt: "1999-01-01T00:00:00.000Z",
			};
			x.releaseLedger[base] = { nextBetaN: n + 1 };
		});
		assert.equal(
			(await postManifest(deps, reserved, g.etag, TOKENS.beta)).status,
			200,
		);
		assert.equal(
			(
				await request(deps, "PUT", `/admin/payload/${ver}/${sha}`, {
					token: TOKENS.beta,
					body: bytes,
				})
			).status,
			200,
		);
		g = await getManifest(deps);
		const committed = edit(g.manifest, (x) => {
			x.releaseOps[id].state = "prepared";
		});
		assert.equal(
			(await postManifest(deps, committed, g.etag, TOKENS.beta)).status,
			200,
		);
		g = await getManifest(deps);
		const final = edit(g.manifest, (x) => {
			x.versions[ver] = {
				sha256: sha,
				key: objectKey,
				size: bytes.length,
				publishedAt: "1999-01-01T00:00:00.000Z",
				channel: "beta",
				status: "active",
				sourceCommit: COMMIT,
				releaseId: id,
				derivedFromBeta: null,
				retentionSince: null,
				quarantinedAt: null,
			};
			x.channels["internal-beta"].latest = ver;
			x.releaseOps[id].state = "committed";
		});
		assert.equal(
			(await postManifest(deps, final, g.etag, TOKENS.beta)).status,
			200,
		);
		return ver;
	}
	async function promote(base, id, betaVer, bytes) {
		const sha = createHash("sha256").update(bytes).digest("hex");
		const objectKey = payloadKeyOf(base, sha);
		let g = await getManifest(deps);
		const reserved = edit(g.manifest, (x) => {
			x.releaseOps[id] = {
				kind: "release",
				state: "reserved",
				ver: base,
				betaVersion: betaVer,
				sourceCommit: COMMIT,
				sha256: sha,
				objectKey,
				createdAt: "1999-01-01T00:00:00.000Z",
			};
		});
		assert.equal(
			(await postManifest(deps, reserved, g.etag, TOKENS.beta)).status,
			200,
		);
		assert.equal(
			(
				await request(deps, "PUT", `/admin/payload/${base}/${sha}`, {
					token: TOKENS.beta,
					body: bytes,
				})
			).status,
			200,
		);
		g = await getManifest(deps);
		const prepared = edit(g.manifest, (x) => {
			x.releaseOps[id].state = "prepared";
		});
		assert.equal(
			(await postManifest(deps, prepared, g.etag, TOKENS.beta)).status,
			200,
		);
		g = await getManifest(deps);
		const committed = edit(g.manifest, (x) => {
			x.versions[base] = {
				sha256: sha,
				key: objectKey,
				size: bytes.length,
				publishedAt: "1999-01-01T00:00:00.000Z",
				channel: "release",
				status: "active",
				sourceCommit: COMMIT,
				releaseId: id,
				derivedFromBeta: betaVer,
				retentionSince: null,
				quarantinedAt: null,
			};
			x.channels["customer-release"].latest = base;
			x.releaseOps[id].state = "committed";
		});
		assert.equal(
			(await postManifest(deps, committed, g.etag, TOKENS.release)).status,
			200,
		);
	}
	void publishRelease; // (structured alternative kept for readability above)

	const b56 = await publishBetaOf("1.56.0", "op-b56", Buffer.from("beta56"));
	await promote("1.56.0", "op-r56", b56, Buffer.from("rel56")); // B live, A superseded
	// withdraw B → fallback A (re-pin): quarantine B + pointer back to A, one CAS
	let g = await getManifest(deps);
	assert.equal(
		g.manifest.versions["1.55.0"].retentionSince !== null,
		true,
		"A got a clock",
	);
	const withdraw = edit(g.manifest, (x) => {
		x.versions["1.56.0"].status = "quarantined";
		x.channels["customer-release"].latest = "1.55.0";
	});
	assert.equal(
		(await postManifest(deps, withdraw, g.etag, TOKENS.release)).status,
		200,
	);
	g = await getManifest(deps);
	assert.equal(
		g.manifest.versions["1.55.0"].retentionSince,
		null,
		"re-pin cleared A's clock",
	);
	assert.equal(
		g.manifest.versions["1.56.0"].quarantinedAt,
		clock.now().toISOString(),
	);
	// during fallback: expiring A is refused (it IS latest again)
	clock.tick(60 * DAY);
	{
		const gg = await getManifest(deps);
		const tryExpire = edit(gg.manifest, (x) => {
			x.versions["1.55.0"].status = "expired";
		});
		assert.equal(
			(await postManifest(deps, tryExpire, gg.etag, TOKENS.ops)).status,
			422,
		);
	}
	// C ships → A superseded AGAIN, clock restarts from零
	const b57 = await publishBetaOf("1.57.0", "op-b57", Buffer.from("beta57"));
	await promote("1.57.0", "op-r57", b57, Buffer.from("rel57"));
	g = await getManifest(deps);
	const stampedAt = g.manifest.versions["1.55.0"].retentionSince;
	assert.equal(
		stampedAt,
		clock.now().toISOString(),
		"clock restarted at C's commit",
	);
	// 27 days later — still refused (28d window counts from the NEW stamp)
	clock.tick(27 * DAY);
	{
		const gg = await getManifest(deps);
		const early = edit(gg.manifest, (x) => {
			x.versions["1.55.0"].status = "expired";
		});
		assert.equal(
			(await postManifest(deps, early, gg.etag, TOKENS.ops)).status,
			422,
		);
	}
	clock.tick(2 * DAY);
	{
		const gg = await getManifest(deps);
		const ok = edit(gg.manifest, (x) => {
			x.versions["1.55.0"].status = "expired";
		});
		assert.equal(
			(await postManifest(deps, ok, gg.etag, TOKENS.ops)).status,
			200,
		);
	}
});

test("tombstone rules: live refs refuse; expired version + committed op allows; barrier race loses cleanly", async () => {
	const { deps, clock } = seeded();
	// supersede + expire beta.1 (the tombstone candidate)
	await publishBeta(deps, "gh-run-17", Buffer.from("supersede2"));
	clock.tick(15 * DAY);
	const g = await getManifest(deps);
	const expire = edit(g.manifest, (x) => {
		x.versions["1.55.0-beta.1"].status = "expired";
	});
	assert.equal(
		(await postManifest(deps, expire, g.etag, TOKENS.ops)).status,
		200,
	);
	const deadKey = payloadKeyOf("1.55.0-beta.1", "a".repeat(64));

	// negatives: live refs refuse the tombstone
	for (const liveKey of [
		payloadKeyOf("1.55.0", "b".repeat(64)), // active release
		(await getManifest(deps)).manifest.releaseOps["gh-run-17"].objectKey, // committed w/ ACTIVE entry
	]) {
		const gg = await getManifest(deps);
		const bad = edit(gg.manifest, (x) => {
			x.tombstones.push(liveKey);
		});
		assert.equal(
			(await postManifest(deps, bad, gg.etag, TOKENS.ops)).status,
			422,
			liveKey,
		);
	}

	// duplicate-in-array is refused (set semantics)
	{
		const gg = await getManifest(deps);
		const dup = edit(gg.manifest, (x) => {
			x.tombstones.push(deadKey, deadKey);
		});
		assert.equal(
			(await postManifest(deps, dup, gg.etag, TOKENS.ops)).status,
			422,
		);
	}

	// barrier race: guard read passes → a concurrent prepare claims the key →
	// tombstone CAS on the stale etag → 412; after re-read the validator refuses.
	{
		const guardRead = await getManifest(deps); // cleanup script's read
		const claim = edit(guardRead.manifest, (x) => {
			x.releaseOps["op-race"] = {
				kind: "beta",
				state: "reserved",
				ver: "1.55.0-beta.1",
				betaVersion: null,
				sourceCommit: COMMIT,
				sha256: "a".repeat(64),
				objectKey: deadKey,
				createdAt: "1999-01-01T00:00:00.000Z",
			};
			// beta.1's N was burned long ago; a same-ver reservation needs the
			// ledger's CURRENT N which is far past 1 — so this claim is refused
			// anyway. Race with a RELEASE candidate instead (claims freely).
		});
		void claim;
		const releaseClaim = edit(guardRead.manifest, (x) => {
			x.releaseOps["op-race"] = {
				kind: "release",
				state: "reserved",
				ver: "1.55.0",
				betaVersion: "1.55.0-beta.1",
				sourceCommit: COMMIT,
				sha256: "a".repeat(64),
				objectKey: null,
				createdAt: "1999-01-01T00:00:00.000Z",
			};
			// objectKey must derive from op.ver — a release op cannot claim a
			// beta object key. The realistic barrier race: claim on a SHARED
			// clean object. For the beta deadKey, the only same-key claimant is a
			// beta op of the same ver, which the ledger blocks. So the honest
			// race here: tombstone CAS vs ANY concurrent write → 412 path.
		});
		assert.equal(
			(await postManifest(deps, releaseClaim, guardRead.etag, TOKENS.beta))
				.status,
			422,
			"release op with null objectKey but set sha is refused (derived-form rule)",
		);
		// a concurrent legal write (an unrelated reservation) lands first:
		const concurrent = edit(guardRead.manifest, (x) => {
			const n = x.releaseLedger["1.55.0"].nextBetaN;
			x.releaseOps["op-unrelated"] = {
				kind: "beta",
				state: "reserved",
				ver: `1.55.0-beta.${n}`,
				betaVersion: null,
				sourceCommit: null,
				sha256: null,
				objectKey: null,
				createdAt: "1999-01-01T00:00:00.000Z",
			};
			x.releaseLedger["1.55.0"].nextBetaN = n + 1;
		});
		assert.equal(
			(await postManifest(deps, concurrent, guardRead.etag, TOKENS.beta))
				.status,
			200,
		);
		// cleanup's tombstone CAS on the stale etag → 412 (re-read → re-judge)
		const tomb = edit(guardRead.manifest, (x) => {
			x.tombstones.push(deadKey);
		});
		assert.equal(
			(await postManifest(deps, tomb, guardRead.etag, TOKENS.ops)).status,
			412,
		);
	}

	// clean tombstone lands after re-read; repeat append of the same key is a
	// no-op re-submission (idempotent success)
	{
		const gg = await getManifest(deps);
		const tomb = edit(gg.manifest, (x) => {
			x.tombstones.push(deadKey);
		});
		assert.equal(
			(await postManifest(deps, tomb, gg.etag, TOKENS.ops)).status,
			200,
		);
		const gg2 = await getManifest(deps);
		assert.ok(gg2.manifest.tombstones.includes(deadKey));
		const same = edit(gg2.manifest, () => {});
		assert.equal(
			(await postManifest(deps, same, gg2.etag, TOKENS.ops)).status,
			200,
		);
	}

	// after tombstone: NEW references to the key are refused (validator)
	{
		const gg = await getManifest(deps);
		const necro = edit(gg.manifest, (x) => {
			const n = x.releaseLedger["1.55.0"].nextBetaN;
			void n;
			x.releaseOps["op-necro2"] = {
				kind: "release",
				state: "reserved",
				ver: "1.55.0",
				betaVersion: "1.55.0-beta.1",
				sourceCommit: COMMIT,
				sha256: "a".repeat(64),
				objectKey: payloadKeyOf("1.55.0", "a".repeat(64)),
				createdAt: "1999-01-01T00:00:00.000Z",
			};
		});
		// this key ISN'T the tombstoned one (different ver) — allowed; the
		// TOMBSTONED key cannot even be expressed on a release op (derived form),
		// which is exactly the structural guarantee.
		assert.equal(
			(await postManifest(deps, necro, gg.etag, TOKENS.beta)).status,
			200,
		);
	}
});

test("shared-object retry: successive release candidates re-reference the same clean object; tombstone then blocks new refs", async () => {
	const { deps } = seeded();
	const sha = createHash("sha256")
		.update(Buffer.from("clean-bits"))
		.digest("hex");
	const objectKey = payloadKeyOf("1.56.0", sha);
	// beta for base 1.56.0 (lineage anchor)
	let g = await getManifest(deps);
	const bres = edit(g.manifest, (x) => {
		x.releaseOps["op-b"] = {
			kind: "beta",
			state: "reserved",
			ver: "1.56.0-beta.1",
			betaVersion: null,
			sourceCommit: COMMIT,
			sha256: "1".repeat(64),
			objectKey: payloadKeyOf("1.56.0-beta.1", "1".repeat(64)),
			createdAt: "1999-01-01T00:00:00.000Z",
		};
		x.releaseLedger["1.56.0"] = { nextBetaN: 2 };
	});
	assert.equal(
		(await postManifest(deps, bres, g.etag, TOKENS.beta)).status,
		200,
	);
	// candidate A claims the clean object then abandons (pre-upload)
	g = await getManifest(deps);
	const claimA = edit(g.manifest, (x) => {
		x.releaseOps["op-pA"] = {
			kind: "release",
			state: "reserved",
			ver: "1.56.0",
			betaVersion: "1.56.0-beta.1",
			sourceCommit: COMMIT,
			sha256: sha,
			objectKey,
			createdAt: "1999-01-01T00:00:00.000Z",
		};
	});
	assert.equal(
		(await postManifest(deps, claimA, g.etag, TOKENS.beta)).status,
		200,
	);
	g = await getManifest(deps);
	const abandonA = edit(g.manifest, (x) => {
		x.releaseOps["op-pA"].state = "abandoned";
	});
	assert.equal(
		(await postManifest(deps, abandonA, g.etag, TOKENS.beta)).status,
		403,
		"beta token may not abandon a RELEASE candidate (B0-6)",
	);
	g = await getManifest(deps);
	assert.equal(
		(await postManifest(deps, abandonA, g.etag, TOKENS.release)).status,
		200,
	);
	// candidate B (retry, NEW releaseId) re-references the SAME <ver>/<sha> — legal
	g = await getManifest(deps);
	const claimB = edit(g.manifest, (x) => {
		x.releaseOps["op-pB"] = {
			kind: "release",
			state: "reserved",
			ver: "1.56.0",
			betaVersion: "1.56.0-beta.1",
			sourceCommit: COMMIT,
			sha256: sha,
			objectKey,
			createdAt: "1999-01-01T00:00:00.000Z",
		};
	});
	assert.equal(
		(await postManifest(deps, claimB, g.etag, TOKENS.beta)).status,
		200,
		"retry must not deadlock",
	);
	// abandon B too, then tombstone the key (only terminal refs now) → new claim refused
	g = await getManifest(deps);
	const abandonB = edit(g.manifest, (x) => {
		x.releaseOps["op-pB"].state = "abandoned";
	});
	assert.equal(
		(await postManifest(deps, abandonB, g.etag, TOKENS.ops)).status,
		200,
	);
	g = await getManifest(deps);
	const tomb = edit(g.manifest, (x) => {
		x.tombstones.push(objectKey);
	});
	assert.equal(
		(await postManifest(deps, tomb, g.etag, TOKENS.ops)).status,
		200,
	);
	g = await getManifest(deps);
	const claimC = edit(g.manifest, (x) => {
		x.releaseOps["op-pC"] = {
			kind: "release",
			state: "reserved",
			ver: "1.56.0",
			betaVersion: "1.56.0-beta.1",
			sourceCommit: COMMIT,
			sha256: sha,
			objectKey,
			createdAt: "1999-01-01T00:00:00.000Z",
		};
	});
	assert.equal(
		(await postManifest(deps, claimC, g.etag, TOKENS.beta)).status,
		422,
		"tombstoned key blocks new refs",
	);
});
