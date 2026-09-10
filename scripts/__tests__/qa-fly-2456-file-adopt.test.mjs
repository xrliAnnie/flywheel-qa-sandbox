import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectFileAdoption } from "../lib/qa-fly-2456-file-adopt.mjs";

const now = Date.parse("2026-09-10T10:05:00Z"),
	createdAt = "2026-09-10T10:00:00Z",
	sha = "a".repeat(40);
function fixture(t, kind, evidence, detail = {}) {
	if (kind === "decoy") {
		detail = { tmuxSocket: "/private/tmp/tmux-501/default", ...detail };
		evidence = { tmuxSocket: detail.tmuxSocket, ...evidence };
	}
	if (kind === "park-pr")
		evidence = {
			query: {
				repository: detail.repository,
				head: detail.branch,
				state: "open",
			},
			...evidence,
		};
	if (kind === "park-marker") evidence = { treeRecursive: true, ...evidence };
	if (kind === "teardown" && evidence.archive)
		evidence = {
			...evidence,
			archive: {
				birthtimeMs: Date.parse("2026-09-10T10:03:00Z"),
				isDirectory: true,
				...evidence.archive,
			},
		};
	const dir = mkdtempSync(join(tmpdir(), "fly2456-file-adopt-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const evidencePath = join(dir, "evidence.json");
	writeFileSync(
		evidencePath,
		JSON.stringify({ scope: { slot: 4, checkout: "/tmp/r1" }, ...evidence }),
	);
	writeFileSync(
		`${evidencePath}.meta.json`,
		JSON.stringify({
			observedAt: "2026-09-10T10:04:00Z",
			sha256: createHash("sha256")
				.update(readFileSync(evidencePath))
				.digest("hex"),
		}),
	);
	return {
		manifest: {
			config: { slot: 4, head: sha, checkout: "/tmp/r1" },
			steps: {
				...Object.fromEntries(
					["B1", "B2", "B3"].map((label) => [
						`start-${label}`,
						{
							intent: { detail: { kind: "start", label } },
							receipt: { result: { workflowRunId: `run-${label}` } },
						},
					]),
				),
				step: { intent: { createdAt, detail: { kind, ...detail } } },
			},
		},
		step: "step",
		evidencePath,
		now,
	};
}
const deployed = {
	slotExists: true,
	roomInfo: { schemaVersion: 1, slot: 4, buildSha: sha, runnerMode: "real" },
	health: {
		ok: true,
		buildMode: "built",
		buildSha: sha,
		artifactBuildSha: sha,
	},
	bridgePid: 123,
	processes: [{ pid: 123, ppid: 1, lstart: "2026-09-10T10:01:00Z" }],
};
test("external query scope and teardown archive birth cannot be substituted", (t) => {
	assert.equal(
		inspectFileAdoption(
			fixture(t, "decoy", {
				tmuxSocket: "/tmp/slot/tmux/default",
				tmuxInventory: "|production|@1|fly2454-decoy\n",
			}),
		).action,
		"conflict",
	);
	const detail = { repository: "owner/sandbox", branch: "b1", title: "park" };
	assert.equal(
		inspectFileAdoption(
			fixture(
				t,
				"park-pr",
				{
					repository: detail.repository,
					query: {
						repository: detail.repository,
						head: "different",
						state: "open",
					},
					prs: [],
				},
				detail,
			),
		).action,
		"conflict",
	);
	assert.equal(
		inspectFileAdoption(
			fixture(
				t,
				"teardown",
				{
					slotExists: false,
					archive: {
						exists: true,
						path: "/tmp/evidence/slot-4/old",
						birthtimeMs: Date.parse("2026-09-09T10:00:00Z"),
					},
				},
				{ archiveRoot: "/tmp/evidence/slot-4" },
			),
		).action,
		"conflict",
	);
});
test("nonrecursive tree cannot prove a nested marker is absent", (t) => {
	const detail = {
		repository: "owner/sandbox",
		branch: "b1",
		markerPath: "doc/marker.txt",
		markerText: "marker",
	};
	const e = {
		repository: detail.repository,
		remoteRefs: `${sha}\trefs/heads/b1\n`,
		commit: { sha, tree: { sha: "b".repeat(40) } },
		tree: {
			sha: "b".repeat(40),
			truncated: false,
			tree: [{ path: "doc", type: "tree", sha: "c".repeat(40) }],
		},
		treeRecursive: false,
		blob: null,
	};
	assert.equal(
		inspectFileAdoption(fixture(t, "park-marker", e, detail)).action,
		"conflict",
	);
});
test("decoy adopts exactly one observed window and refuses duplicate identities", (t) => {
	const window = "|production|@2|fly2454-decoy\n";
	const r = inspectFileAdoption(fixture(t, "decoy", { tmuxInventory: window }));
	assert.equal(r.action, "adopt-existing");
	assert.equal(r.result.windowIdentity, "production|@2|fly2454-decoy");
	assert.equal(
		inspectFileAdoption(
			fixture(t, "decoy", { tmuxInventory: "|production|@1|ordinary\n" }),
		).action,
		"execute",
	);
	assert.equal(
		inspectFileAdoption(
			fixture(t, "decoy", {
				tmuxInventory: window + "|production|@3|fly2454-decoy\n",
			}),
		).action,
		"conflict",
	);
});
test("teardown requires absent slot and an observed archive under expected root", (t) => {
	const detail = { archiveRoot: "/tmp/evidence/slot-4" };
	assert.equal(
		inspectFileAdoption(
			fixture(
				t,
				"teardown",
				{
					slotExists: false,
					archive: { exists: true, path: "/tmp/evidence/slot-4/stamp" },
				},
				detail,
			),
		).action,
		"adopt-existing",
	);
	assert.equal(
		inspectFileAdoption(
			fixture(t, "teardown", { slotExists: true, archive: null }, detail),
		).action,
		"execute",
	);
	for (const e of [
		{ slotExists: false, archive: null },
		{
			slotExists: false,
			archive: { exists: true, path: "/tmp/evidence/slot-4/../slot-1/stamp" },
		},
	])
		assert.equal(
			inspectFileAdoption(fixture(t, "teardown", e, detail)).action,
			"conflict",
		);
});
test("room-info hide and restore adopt only matching unambiguous identity", (t) => {
	const identity = {
		sha256: "d".repeat(64),
		mode: 0o600,
		inode: 10,
		mtimeMs: 100,
	};
	for (const action of ["hide", "restore"]) {
		const e =
			action === "hide"
				? { roomInfo: null, hiddenRoomInfo: identity }
				: { roomInfo: identity, hiddenRoomInfo: null };
		assert.equal(
			inspectFileAdoption(fixture(t, "room-info", e, { action, identity }))
				.action,
			"adopt-existing",
		);
		const before =
			action === "hide"
				? { roomInfo: identity, hiddenRoomInfo: null }
				: { roomInfo: null, hiddenRoomInfo: identity };
		assert.equal(
			inspectFileAdoption(fixture(t, "room-info", before, { action, identity }))
				.action,
			"execute",
		);
		assert.equal(
			inspectFileAdoption(
				fixture(
					t,
					"room-info",
					{ roomInfo: identity, hiddenRoomInfo: identity },
					{ action, identity },
				),
			).action,
			"conflict",
		);
	}
});
test("park marker binds remote head through commit tree and actual blob hash", (t) => {
	const content = Buffer.from("FLY-2456 park marker\n"),
		blobSha = createHash("sha1")
			.update(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content]))
			.digest("hex");
	const detail = {
		repository: "owner/sandbox",
		branch: "drill-r1-B1",
		markerPath: "drill-marker.txt",
		markerText: "FLY-2456 park marker",
	};
	const e = {
		repository: detail.repository,
		remoteRefs: `${sha}\trefs/heads/${detail.branch}\n`,
		commit: { sha, tree: { sha: "b".repeat(40) } },
		tree: {
			sha: "b".repeat(40),
			truncated: false,
			tree: [{ path: detail.markerPath, type: "blob", sha: blobSha }],
		},
		blob: {
			sha: blobSha,
			encoding: "base64",
			content: content.toString("base64"),
		},
	};
	assert.equal(
		inspectFileAdoption(fixture(t, "park-marker", e, detail)).action,
		"adopt-existing",
	);
	assert.equal(
		inspectFileAdoption(
			fixture(
				t,
				"park-marker",
				{
					...e,
					blob: { ...e.blob, content: Buffer.from("wrong").toString("base64") },
				},
				detail,
			),
		).action,
		"conflict",
	);
	assert.equal(
		inspectFileAdoption(
			fixture(
				t,
				"park-marker",
				{
					repository: detail.repository,
					remoteRefs: "",
					commit: null,
					tree: null,
					blob: null,
				},
				detail,
			),
		).action,
		"execute",
	);
});
test("park PR adopts exactly one open matching branch title repository", (t) => {
	const detail = {
			repository: "owner/sandbox",
			branch: "drill-r1-B1",
			title: "FLY-2456 park B1",
		},
		pr = {
			number: 12,
			url: "https://github.com/owner/sandbox/pull/12",
			state: "OPEN",
			headRefName: detail.branch,
			title: detail.title,
		};
	assert.equal(
		inspectFileAdoption(
			fixture(
				t,
				"park-pr",
				{ repository: detail.repository, prs: [pr] },
				detail,
			),
		).action,
		"adopt-existing",
	);
	assert.equal(
		inspectFileAdoption(
			fixture(t, "park-pr", { repository: detail.repository, prs: [] }, detail),
		).action,
		"execute",
	);
	for (const prs of [
		[pr, pr],
		[{ ...pr, title: "different" }],
		[{ ...pr, state: "CLOSED" }],
	])
		assert.equal(
			inspectFileAdoption(
				fixture(t, "park-pr", { repository: detail.repository, prs }, detail),
			).action,
			"conflict",
		);
});
test("deploy adopt and replay require room health double sha and live pid", (t) => {
	const f = fixture(t, "deploy", deployed),
		r = inspectFileAdoption(f);
	assert.equal(r.action, "adopt-existing");
	f.manifest.steps.step.receipt = { result: r.result };
	assert.equal(inspectFileAdoption(f).action, "replay");
	for (const changed of [
		{ ...deployed, processes: [] },
		{
			...deployed,
			health: { ...deployed.health, artifactBuildSha: "b".repeat(40) },
		},
		{ ...deployed, roomInfo: { ...deployed.roomInfo, runnerMode: "stub" } },
	])
		assert.equal(
			inspectFileAdoption(fixture(t, "deploy", changed)).action,
			"conflict",
		);
});
test("deploy execute only confirmed absent slot", (t) => {
	assert.equal(
		inspectFileAdoption(
			fixture(t, "deploy", {
				slotExists: false,
				roomInfo: null,
				health: null,
				bridgePid: null,
				processes: [],
			}),
		).action,
		"execute",
	);
	assert.equal(
		inspectFileAdoption(fixture(t, "deploy", {})).action,
		"conflict",
	);
});
test("adoption parses actual per-lead YAML rather than comment substring", (t) => {
	assert.equal(
		inspectFileAdoption(
			fixture(t, "adoption", {
				adoptionYaml: "flywheel-test-4: [code, generic, simple_code]\n",
			}),
		).action,
		"adopt-existing",
	);
	assert.equal(
		inspectFileAdoption(
			fixture(t, "adoption", {
				adoptionYaml: "# simple_code\nflywheel-test-4: [code, generic]\n",
			}),
		).action,
		"execute",
	);
	assert.equal(
		inspectFileAdoption(
			fixture(t, "adoption", {
				adoptionYaml: "flywheel-test-1: [simple_code]\n",
			}),
		).action,
		"conflict",
	);
});
test("cycle old identity alive executes, replacement identity adopts, failure/spec drift conflicts", (t) => {
	const preState = {
		oldPid: 123,
		oldLstart: "2026-09-10T10:01:00Z",
		listenerChain: [{ pid: 123, ppid: 1 }],
		logOffset: 0,
		bounds: {
			sessionEventsMaxId: 0,
			runEventMaxSeq: { "run-B1": 0, "run-B2": 0, "run-B3": 0 },
		},
		launchSpecSha256: "b".repeat(64),
	};
	const e = {
		bridgePid: 124,
		processes: [{ pid: 124, ppid: 1, lstart: "2026-09-10T10:03:00Z" }],
		launchSpecSha256: preState.launchSpecSha256,
		cycleFailed: false,
	};
	assert.equal(
		inspectFileAdoption(fixture(t, "cycle", e, { preState })).action,
		"adopt-existing",
	);
	assert.equal(
		inspectFileAdoption(
			fixture(
				t,
				"cycle",
				{
					...e,
					bridgePid: 123,
					processes: [{ pid: 123, ppid: 1, lstart: preState.oldLstart }],
				},
				{ preState },
			),
		).action,
		"execute",
	);
	for (const altered of [
		{ ...e, cycleFailed: true },
		{ ...e, launchSpecSha256: "c".repeat(64) },
		{ ...e, processes: [] },
	])
		assert.equal(
			inspectFileAdoption(fixture(t, "cycle", altered, { preState })).action,
			"conflict",
		);
});
test("captured scope cannot be reused for another slot or checkout", (t) => {
	for (const scope of [
		{ slot: 1, checkout: "/tmp/r1" },
		{ slot: 4, checkout: "/tmp/other" },
		null,
	])
		assert.equal(
			inspectFileAdoption(
				fixture(t, "deploy", {
					scope,
					slotExists: false,
					roomInfo: null,
					health: null,
					bridgePid: null,
					processes: [],
				}),
			).action,
			"conflict",
		);
});
test("cycle rejects incomplete process chain and wrong campaign bounds", (t) => {
	const preState = {
		oldPid: 123,
		oldLstart: "2026-09-10T10:01:00Z",
		listenerChain: [{ pid: 123, ppid: 1 }],
		logOffset: 0,
		bounds: {
			sessionEventsMaxId: 0,
			runEventMaxSeq: { "run-B1": 0, "run-B2": 0, "run-B3": 0 },
		},
		launchSpecSha256: "b".repeat(64),
	};
	const e = {
		bridgePid: 124,
		processes: [{ pid: 124, ppid: 1, lstart: "2026-09-10T10:03:00Z" }],
		launchSpecSha256: preState.launchSpecSha256,
		cycleFailed: false,
	};
	for (const p of [
		{ ...preState, listenerChain: [null] },
		{ ...preState, bounds: { sessionEventsMaxId: 0, runEventMaxSeq: [0] } },
		{
			...preState,
			bounds: { sessionEventsMaxId: 0, runEventMaxSeq: { other: 0 } },
		},
	])
		assert.equal(
			inspectFileAdoption(fixture(t, "cycle", e, { preState: p })).action,
			"conflict",
		);
});
test("stale evidence and receipt disagreement conflict", (t) => {
	const f = fixture(t, "deploy", deployed);
	f.now += 700000;
	assert.equal(inspectFileAdoption(f).action, "conflict");
	f.now = now;
	f.manifest.steps.step.receipt = { result: { wrong: true } };
	assert.equal(inspectFileAdoption(f).action, "conflict");
});
test("existing approved notes execute only at the captured baseline blob", (t) => {
	const blob = (value) => {
		const b = Buffer.from(value);
		return {
			sha: createHash("sha1")
				.update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b]))
				.digest("hex"),
			encoding: "base64",
			content: b.toString("base64"),
		};
	};
	const base = blob("Existing sandbox notes\n");
	const detail = {
		repository: "owner/sandbox",
		branch: "drill-r1-B1",
		markerPath: "doc/qa/sandbox-notes.md",
		markerText: "FLY-2456 drill marker r1 B1",
		expectedBaseBlobSha: base.sha,
	};
	const evidence = (b) => ({
		repository: detail.repository,
		remoteRefs: `${sha}\trefs/heads/${detail.branch}\n`,
		commit: { sha, tree: { sha: "b".repeat(40) } },
		tree: {
			sha: "b".repeat(40),
			truncated: false,
			tree: [{ path: detail.markerPath, type: "blob", sha: b.sha }],
		},
		blob: b,
	});
	assert.equal(
		inspectFileAdoption(fixture(t, "park-marker", evidence(base), detail))
			.action,
		"execute",
	);
	assert.equal(
		inspectFileAdoption(
			fixture(
				t,
				"park-marker",
				evidence(blob("Unknown unrelated edit\n")),
				detail,
			),
		).action,
		"conflict",
	);
	assert.equal(
		inspectFileAdoption(
			fixture(
				t,
				"park-marker",
				evidence(blob("Existing sandbox notes\n" + detail.markerText + "\n")),
				detail,
			),
		).action,
		"adopt-existing",
	);
	assert.equal(
		inspectFileAdoption(
			fixture(
				t,
				"park-marker",
				{
					repository: detail.repository,
					remoteRefs: "",
					commit: null,
					tree: null,
					blob: null,
				},
				detail,
			),
		).action,
		"conflict",
	);
});

test("decoy adoption folds real linked inventory and retains identity conflicts", (t) => {
	const captured = JSON.parse(
		readFileSync(
			new URL("./fixtures/qa-fly-2456-linked-inventory.json", import.meta.url),
			"utf8",
		),
	).inventory;
	const decoy = "|main|@9008|fly2454-decoy\n|cmux-decoy|@9008|fly2454-decoy\n";
	const result = inspectFileAdoption(
		fixture(t, "decoy", { tmuxInventory: captured + decoy }),
	);
	assert.equal(result.action, "adopt-existing");
	assert.equal(result.result.windowIdentity, "main|@9008|fly2454-decoy");
	for (const extra of [
		"|other|@9009|fly2454-decoy\n",
		"|other|@9008|wrong-name\n",
		"wrong-exec|other|@9008|fly2454-decoy\n",
	]) {
		assert.equal(
			inspectFileAdoption(
				fixture(t, "decoy", { tmuxInventory: captured + decoy + extra }),
			).action,
			"conflict",
		);
	}
});

test("initial sandbox branch publication adopts exact head and rejects other refs (#10)", (t) => {
	const detail = {
		repository: "xrliAnnie/flywheel-qa-sandbox",
		branch: "fixture",
		expectedHead: sha,
	};
	const inspect = (refs) =>
		inspectFileAdoption(
			fixture(
				t,
				"park-publish",
				{ repository: detail.repository, remoteRefs: refs },
				detail,
			),
		);
	assert.equal(inspect("").action, "execute");
	assert.equal(
		inspect(sha + "\trefs/heads/fixture\n").action,
		"adopt-existing",
	);
	assert.equal(
		inspect("b".repeat(40) + "\trefs/heads/fixture\n").action,
		"conflict",
	);
	assert.equal(inspect(sha + "\trefs/heads/other\n").action, "conflict");
});
