// FLY-1062 PR3 · pure validator shape/invariant matrix (the negatives that
// no legal transition can even express — schema garbage, empty-state
// exception, set semantics).
import assert from "node:assert/strict";
import { test } from "node:test";
import { isEmptyInitialManifest, validateManifest } from "../src/validator.mjs";
import {
	edit,
	emptyManifest,
	fixtureManifest,
	payloadKeyOf,
} from "./harness.mjs";

test("empty manifest (dual null channels) is the ONLY valid empty state", () => {
	assert.deepEqual(validateManifest(emptyManifest()), []);
	assert.ok(isEmptyInitialManifest(emptyManifest()));
	// null latest with entries present → violation (both directions)
	const withEntries = edit(fixtureManifest(), (m) => {
		m.channels["internal-beta"].latest = null;
	});
	assert.ok(
		validateManifest(withEntries).some((e) => e.includes("latest null")),
	);
	assert.ok(!isEmptyInitialManifest(fixtureManifest()));
});

test("fixture manifest is fully valid", () => {
	assert.deepEqual(validateManifest(fixtureManifest()), []);
});

test("shape garbage: non-object / wrong schemaVersion / missing tables", () => {
	assert.ok(validateManifest(null).length > 0);
	assert.ok(validateManifest("nope").length > 0);
	assert.ok(validateManifest({ schemaVersion: 2 }).length > 0);
	const m = emptyManifest();
	delete m.tombstones;
	assert.ok(validateManifest(m).length > 0);
});

test("field grammar: sha256 length, derived key, size, channel/semver correspondence, sourceCommit", () => {
	const bads = [
		(m) => {
			m.versions["1.55.0"].sha256 = "abc";
		},
		(m) => {
			m.versions["1.55.0"].key = "payloads/1.55.0/wrong.tgz";
		},
		(m) => {
			m.versions["1.55.0"].size = 0;
		},
		(m) => {
			m.versions["1.55.0"].channel = "beta"; // clean semver on beta channel
		},
		(m) => {
			m.versions["1.55.0"].sourceCommit = "short";
		},
		(m) => {
			m.versions["1.55.0"].publishedAt = "yesterday";
		},
	];
	for (const mutate of bads) {
		const m = edit(fixtureManifest(), mutate);
		assert.ok(
			validateManifest(m).length > 0,
			`expected violation for ${mutate}`,
		);
	}
});

test("quarantined entry must carry quarantinedAt; committed op must carry full tuple", () => {
	const q = edit(fixtureManifest(), (m) => {
		// structurally consistent quarantine EXCEPT the missing stamp — and a
		// fallback pointer so channel rules stay satisfiable
		m.versions["1.55.0"].status = "quarantined";
		m.versions["1.55.0"].quarantinedAt = null;
		m.versions["1.55.0"].retentionSince = "2026-07-02T00:00:00.000Z";
		m.channels["customer-release"].latest = null; // invalid too, but the stamp violation must be reported
	});
	assert.ok(validateManifest(q).some((e) => e.includes("quarantinedAt")));
	const t = edit(fixtureManifest(), (m) => {
		m.releaseOps["op-beta-1"].sha256 = null;
		m.releaseOps["op-beta-1"].objectKey = null;
	});
	assert.ok(validateManifest(t).some((e) => e.includes("full tuple")));
});

test("releaseId uniqueness across versions", () => {
	const m = edit(fixtureManifest(), (x) => {
		x.versions["1.55.0"].releaseId = "op-beta-1"; // duplicate of the beta's
	});
	assert.ok(validateManifest(m).some((e) => e.includes("not unique")));
});

test("tombstone set semantics + terminal-refs across BOTH layers", () => {
	// duplicate entries
	const dup = edit(fixtureManifest(), (m) => {
		m.tombstones = ["payloads/x/y.tgz", "payloads/x/y.tgz"];
	});
	assert.ok(validateManifest(dup).some((e) => e.includes("duplicate")));
	// live committed op whose entry is ACTIVE → tombstone refused
	const live = edit(fixtureManifest(), (m) => {
		m.tombstones = [m.versions["1.55.0"].key];
	});
	assert.ok(validateManifest(live).length > 0);
	// expired version + its committed op → tombstone allowed (published-then-
	// expired versions ARE deletable, plan R5#1 two-layer rule)
	const ok = edit(fixtureManifest(), (m) => {
		const sha = "0".repeat(64);
		m.versions["1.54.0-beta.3"] = {
			sha256: sha,
			key: payloadKeyOf("1.54.0-beta.3", sha),
			size: 3,
			publishedAt: "2026-05-01T00:00:00.000Z",
			channel: "beta",
			status: "expired",
			sourceCommit: "c".repeat(40),
			releaseId: "op-dead",
			derivedFromBeta: null,
			retentionSince: "2026-05-02T00:00:00.000Z",
			quarantinedAt: null,
		};
		m.releaseOps["op-dead"] = {
			kind: "beta",
			state: "committed",
			ver: "1.54.0-beta.3",
			betaVersion: null,
			sourceCommit: "c".repeat(40),
			sha256: sha,
			objectKey: payloadKeyOf("1.54.0-beta.3", sha),
			createdAt: "2026-05-01T00:00:00.000Z",
		};
		m.releaseLedger["1.54.0"] = { nextBetaN: 4 };
		m.tombstones = [payloadKeyOf("1.54.0-beta.3", sha)];
	});
	assert.deepEqual(validateManifest(ok), []);
});

test("lineage: release entry without a real beta anchor is refused", () => {
	const m = edit(fixtureManifest(), (x) => {
		x.versions["1.55.0"].derivedFromBeta = "9.9.9-beta.1";
		x.releaseOps["op-rel-1"].betaVersion = "9.9.9-beta.1";
	});
	assert.ok(validateManifest(m).length > 0);
});
