import assert from "node:assert/strict";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	manifestInit,
	manifestIntent,
	manifestPreconditionBody,
	manifestReceipt,
} from "../lib/qa-fly-2456-manifest.mjs";

function fixture(t) {
	const dir = mkdtempSync(join(tmpdir(), "fly2456-manifest-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return join(dir, "manifest.json");
}
const config = {
	round: "r1",
	checkout: "/private/tmp/fly2456-r1-main",
	head: "a".repeat(40),
	slot: 4,
	issues: { B1: "FLY-202", B2: "FLY-145", B3: "FLY-146" },
};
test("precondition identity is durable and separate from three core bodies", (t) => {
	const path = fixture(t),
		before = manifestInit(path, config);
	const pre = manifestPreconditionBody(path, "FLY-202");
	assert.match(pre.idempotencyKey, /^fly2456-r1-PRE-/);
	assert.notEqual(pre.idempotencyKey, before.bodies.B1.idempotencyKey);
	assert.deepEqual(manifestPreconditionBody(path, "FLY-202"), pre);
	assert.throws(() => manifestPreconditionBody(path, "FLY-145"), /conflict/);
	const intent = manifestIntent(path, "start-PRE", {
		kind: "start",
		label: "PRE",
		issueId: "FLY-202",
	});
	assert.equal(intent.idempotencyKey, pre.idempotencyKey);
	assert.deepEqual(Object.keys(JSON.parse(readFileSync(path)).bodies).sort(), [
		"B1",
		"B2",
		"B3",
	]);
});
function startedBodies(path) {
	for (const label of ["B1", "B2", "B3"]) {
		manifestIntent(path, `start-${label}`, {
			kind: "start",
			label,
			issueId: config.issues[label],
		});
		manifestReceipt(path, `start-${label}`, {
			executionId: `exec-${label}`,
			workflowRunId: `run-${label}`,
		});
	}
}

test("manifest init preserves generated body request identities on replay and rejects another head", (t) => {
	const path = fixture(t);
	const first = manifestInit(path, config);
	assert.match(first.bodies.B1.idempotencyKey, /^fly2456-r1-B1-/);
	assert.match(first.bodies.B1.clientRequestId, /^[a-f0-9-]{36}$/);
	assert.notEqual(
		first.bodies.B1.idempotencyKey,
		first.bodies.B2.idempotencyKey,
	);
	const bytes = readFileSync(path);
	assert.deepEqual(manifestInit(path, config), first);
	assert.deepEqual(readFileSync(path), bytes);
	assert.throws(
		() => manifestInit(path, { ...config, head: "b".repeat(40) }),
		/conflict/,
	);
	assert.deepEqual(readFileSync(path), bytes);
});

test("intent is durable before an effect and cannot be silently rewritten", (t) => {
	const path = fixture(t);
	manifestInit(path, config);
	const detail = {
		kind: "start",
		label: "B1",
		issueId: "FLY-202",
		selectionDigest: "c".repeat(64),
	};
	const intent = manifestIntent(path, "start-B1", detail);
	assert.ok(Date.parse(intent.createdAt));
	assert.equal(
		intent.idempotencyKey,
		JSON.parse(readFileSync(path)).bodies.B1.idempotencyKey,
	);
	assert.deepEqual(manifestIntent(path, "start-B1", detail), intent);
	const bytes = readFileSync(path);
	assert.throws(
		() => manifestIntent(path, "start-B1", { ...detail, issueId: "FLY-999" }),
		/conflict/,
	);
	assert.deepEqual(readFileSync(path), bytes);
});

test("receipt requires an intent and conflicting receipts preserve the original bytes", (t) => {
	const path = fixture(t);
	manifestInit(path, config);
	assert.throws(
		() => manifestReceipt(path, "missing", { executionId: "exec-1" }),
		/intent/,
	);
	manifestIntent(path, "start-B1", {
		kind: "start",
		label: "B1",
		issueId: "FLY-202",
		selectionDigest: "c".repeat(64),
	});
	manifestReceipt(path, "start-B1", { executionId: "exec-1" });
	const bytes = readFileSync(path);
	manifestReceipt(path, "start-B1", { executionId: "exec-1" });
	assert.deepEqual(readFileSync(path), bytes);
	assert.throws(
		() => manifestReceipt(path, "start-B1", { executionId: "exec-2" }),
		/conflict/,
	);
	assert.deepEqual(readFileSync(path), bytes);
});

test("initialization rejects malformed identities and does not overwrite unrelated files", (t) => {
	const path = fixture(t);
	assert.throws(
		() => manifestInit(path, { ...config, checkout: "relative" }),
		/checkout/,
	);
	assert.throws(() => manifestInit(path, { ...config, slot: 1 }), /slot/);
	writeFileSync(path, "unrelated evidence");
	assert.throws(() => manifestInit(path, config));
	assert.equal(readFileSync(path, "utf8"), "unrelated evidence");
});

test("manifest refuses a symlink and an outstanding writer before changing evidence", (t) => {
	const path = fixture(t),
		target = `${path}.target`;
	manifestInit(target, config);
	const bytes = readFileSync(target);
	symlinkSync(target, path);
	assert.throws(
		() => manifestIntent(path, "start-B1", { kind: "start", label: "B1" }),
		/symlink/,
	);
	assert.deepEqual(readFileSync(target), bytes);
	rmSync(path);
	manifestInit(path, config);
	const original = readFileSync(path);
	writeFileSync(`${path}.lock`, "existing writer");
	assert.throws(
		() => manifestIntent(path, "start-B1", { kind: "start", label: "B1" }),
		/EEXIST|writer/,
	);
	assert.deepEqual(readFileSync(path), original);
});

test("cycle intent requires the complete captured pre-state before a restart can be proposed", (t) => {
	const path = fixture(t);
	manifestInit(path, config);
	startedBodies(path);
	assert.throws(
		() =>
			manifestIntent(path, "cycle-1", {
				kind: "cycle",
				preState: { oldPid: 123 },
			}),
		/pre-state/,
	);
	const preState = {
		oldPid: 123,
		oldLstart: "Thu Sep 10 00:00:00 2026",
		listenerChain: [{ pid: 124, ppid: 123 }],
		logOffset: 0,
		bounds: {
			sessionEventsMaxId: 5,
			runEventMaxSeq: { "run-B1": 2, "run-B2": 1, "run-B3": 1 },
		},
		launchSpecSha256: "f".repeat(64),
	};
	assert.deepEqual(
		manifestIntent(path, "cycle-1", { kind: "cycle", preState }).detail
			.preState,
		preState,
	);
});

test("cycle cannot omit a body run or invent bounds before body start receipts exist", (t) => {
	const path = fixture(t);
	manifestInit(path, config);
	const preState = {
		oldPid: 123,
		oldLstart: "Thu Sep 10 00:00:00 2026",
		listenerChain: [{ pid: 124, ppid: 123 }],
		logOffset: 0,
		bounds: {
			sessionEventsMaxId: 5,
			runEventMaxSeq: { "run-B1": 2, "run-B2": 1, "run-B3": 1 },
		},
		launchSpecSha256: "f".repeat(64),
	};
	assert.throws(
		() => manifestIntent(path, "cycle-1", { kind: "cycle", preState }),
		/body.*receipt/,
	);
	startedBodies(path);
	assert.throws(
		() =>
			manifestIntent(path, "cycle-1", {
				kind: "cycle",
				preState: {
					...preState,
					bounds: {
						...preState.bounds,
						runEventMaxSeq: { "run-B1": 2, "run-B2": 1 },
					},
				},
			}),
		/run bounds/,
	);
});

test("cycle intent rejects an empty run bound set or unusable process birth identity", (t) => {
	const path = fixture(t);
	manifestInit(path, config);
	const preState = {
		oldPid: 123,
		oldLstart: "Thu Sep 10 00:00:00 2026",
		listenerChain: [{ pid: 124, ppid: 123 }],
		logOffset: 0,
		bounds: { sessionEventsMaxId: 5, runEventMaxSeq: { run: 2 } },
		launchSpecSha256: "f".repeat(64),
	};
	assert.throws(
		() =>
			manifestIntent(path, "cycle-1", {
				kind: "cycle",
				preState: {
					...preState,
					bounds: { ...preState.bounds, runEventMaxSeq: {} },
				},
			}),
		/pre-state/,
	);
	assert.throws(
		() =>
			manifestIntent(path, "cycle-1", {
				kind: "cycle",
				preState: { ...preState, oldLstart: true },
			}),
		/pre-state/,
	);
});

test("body issue binding cannot drift and a partial manifest cannot be replayed as valid", (t) => {
	const path = fixture(t);
	manifestInit(path, config);
	assert.throws(
		() =>
			manifestIntent(path, "start-B1", {
				kind: "start",
				label: "B1",
				issueId: "FLY-999",
			}),
		/issue/,
	);
	writeFileSync(path, JSON.stringify({ config }));
	assert.throws(() => manifestInit(path, config), /manifest/);
});
