import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verdictRound } from "../lib/qa-fly-2456-verdict.mjs";

function verdictFixture(t, round = "r1") {
	const dir = mkdtempSync(join(tmpdir(), "fly2456-verdict-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const write = (name, value) => {
		const path = join(dir, `${name}.json`);
		writeFileSync(path, JSON.stringify(value));
		return path;
	};
	const starts = Object.fromEntries(
		["B1", "B2", "B3"].map((label) => [
			`start-${label}`,
			{
				intent: {
					detail: { kind: "start", label, issueId: `FLY-${label.slice(1)}` },
				},
				receipt: {
					result: {
						issueId: `FLY-${label.slice(1)}`,
						executionId: `exec-${label}`,
						workflowRunId: `run-${label}`,
					},
				},
			},
		]),
	);
	const bodies = Object.fromEntries(
		["B1", "B2", "B3"].map((label) => [
			label,
			{
				executionId: `exec-${label}`,
				runId: `run-${label}`,
				classification:
					label === "B3"
						? "skipped_not_holder"
						: label === "B1" && round === "r1"
							? "replaced"
							: "succeeded",
				preparedEvents: [],
				attempt2PreparedProof: round === "r2",
				sessionEvents: [],
				workflowEvents: [],
			},
		]),
	);
	const groups = {
		fleet: ["live", "postTeardown"],
		proc: ["live", "postTeardown", "teardown"],
		comm: ["before", "liveAfter", "postTeardown"],
		launchCommits: ["liveAfter", "postTeardown"],
		prodState: ["before", "liveAfter", "postTeardown"],
		alerts: ["liveAfter", "postTeardown"],
		runnerWindows: ["full", "teardown"],
	};
	const zero = Object.fromEntries(
		Object.entries(groups).map(([group, phases]) => [
			group,
			Object.fromEntries(
				phases.map((phase) => [
					phase,
					write(`${group}-${phase}`, {
						status: "pass",
						hitCount: 0,
						baselineHitCount: 0,
						newHitCount: 0,
						hits: [],
						hitRows: [],
						added: [],
						removed: [],
						unknown: [],
						unexplained: [],
						pollution: [],
						explanations: [],
						before: 1,
						after: 1,
					}),
				]),
			),
		]),
	);
	zero.health = Object.fromEntries(
		["before", "liveAfter", "preTeardown", "postTeardown"].map((phase, i) => [
			phase,
			write(`health-${phase}`, {
				ok: true,
				buildSha: "b".repeat(40),
				uptime: 100 + i,
			}),
		]),
	);
	zero.killLedger = write("ledger", { status: "pass", refusals: [] });
	return {
		round,
		manifestPath: write("manifest", {
			config: {
				round,
				slot: round === "r1" ? 4 : 1,
				head: "a".repeat(40),
				issues: { B1: "FLY-1", B2: "FLY-2", B3: "FLY-3" },
			},
			bodies: {
				B1: { issueId: "FLY-1" },
				B2: { issueId: "FLY-2" },
				B3: { issueId: "FLY-3" },
			},
			steps: starts,
		}),
		shapePath: write("shape", {
			status: "pass",
			failures: [],
			bodies: Object.fromEntries(
				Object.entries(bodies).map(([label, b]) => [
					label,
					{ executionId: b.executionId },
				]),
			),
		}),
		observePath: write("observe", {
			status: "pass",
			bodies,
			capabilityDriftEvents: [],
		}),
		zeroImpactPath: write("zero", zero),
		fixturePath: write("fixture", {
			roomInfoHidden: true,
			gateHeld: true,
			cycle1: {
				status: "pass",
				bodies: Object.fromEntries(
					Object.entries(bodies).map(([label, b]) => [
						label,
						{ executionId: b.executionId, runId: b.runId, sessionEvents: [] },
					]),
				),
				timeline: { sessionEvents: [], workflowRunEvents: [] },
			},
			precondition: {
				status: "pass",
				waitedMs: 600000,
				maintenanceTicks: 2,
				termination: {
					purpose: "precondition",
					status: "terminated",
					noop: false,
				},
				fleet: { status: "pass", added: [], removed: [] },
				archivePath: "/tmp/archive",
			},
		}),
	};
}

import { composeReportPair } from "../lib/qa-fly-2456-report-pair.mjs";

function pairFixture(t) {
	const paths = {};
	for (const round of ["r1", "r2"]) {
		const f = verdictFixture(t, round);
		const manifest = JSON.parse(readFileSync(f.manifestPath));
		manifest.config.head = (round === "r1" ? "a" : "c").repeat(40);
		writeFileSync(f.manifestPath, JSON.stringify(manifest));
		const shape = JSON.parse(readFileSync(f.shapePath)),
			observed = JSON.parse(readFileSync(f.observePath));
		for (const label of ["B1", "B2", "B3"]) {
			const body = shape.bodies[label],
				count = label === "B1" ? 2 : 1;
			body.bindings = Array.from({ length: count }, (_, i) => ({
				activation_id: `${round}-${label}-${i}`,
				execution_id: body.executionId,
				run_id: `run-${label}`,
				node_id: "implement",
				attempt: i + 1,
				mode: i ? "wake" : "spawn",
			}));
			body.session = { status: label === "B3" ? "ship_parked" : "running" };
			body.turn = {
				holder_exec_id: label === "B3" ? "another" : body.executionId,
			};
		}
		observed.timeline = {
			sessionEvents: [
				{
					id: 1,
					ts: "2026-09-10T00:00:00Z",
					event_type: "reown_watch_started",
					execution_id: "exec-B1",
					payload: '{"episodeId":"episode"}',
				},
			],
			workflowRunEvents: [],
		};
		writeFileSync(f.shapePath, JSON.stringify(shape));
		writeFileSync(f.observePath, JSON.stringify(observed));
		const result = verdictRound(f);
		assert.equal(result.status, "pass", JSON.stringify(result.failures));
		const path = join(f.manifestPath, "..", `verdict-${round}.json`);
		writeFileSync(path, JSON.stringify(result));
		paths[round + "Path"] = path;
		paths[round] = f;
	}
	return paths;
}
test("pair report verifies two verdicts and renders measured rates and projected timelines without tables", (t) => {
	const f = pairFixture(t),
		r = composeReportPair(f);
	assert.equal(r.status, "pass", JSON.stringify(r.failures));
	assert.deepEqual(
		r.rounds.map((r) => r.successRate),
		[0.5, 1],
	);
	assert.match(r.markdown, /50%/);
	assert.match(r.markdown, /100%/);
	assert.match(r.markdown, /reown_watch_started/);
	assert.match(r.markdown, /room-info/);
	assert.match(r.markdown, /isCodexReownExcluded/);
	assert.match(r.markdown, /launch-commits/);
	assert.doesNotMatch(r.markdown, /^\s*\|/m);
	assert.doesNotMatch(r.html, /<table/i);
	assert.match(r.html, /<!doctype html>/i);
});
test("swapped rounds, modified evidence and fabricated rate fail closed", (t) => {
	for (const change of [
		(f) => {
			[f.r1Path, f.r2Path] = [f.r2Path, f.r1Path];
		},
		(f) => writeFileSync(f.r1.shapePath, "{}"),
		(f) => {
			const r = JSON.parse(readFileSync(f.r1Path));
			r.successRate = 1;
			writeFileSync(f.r1Path, JSON.stringify(r));
		},
	]) {
		const f = pairFixture(t);
		change(f);
		assert.equal(composeReportPair(f).status, "fail");
	}
});
test("actual failed and pending verdicts never become pair pass", (t) => {
	for (const status of ["fail", "needs-attribution"]) {
		const f = pairFixture(t),
			zero = JSON.parse(readFileSync(f.r2.zeroImpactPath));
		const record = JSON.parse(readFileSync(zero.proc.teardown));
		record.status = status;
		writeFileSync(zero.proc.teardown, JSON.stringify(record));
		writeFileSync(f.r2Path, JSON.stringify(verdictRound(f.r2)));
		const r = composeReportPair(f);
		assert.equal(r.status, status);
		assert.match(r.markdown, new RegExp(status));
	}
});
test("missing timelines or malformed activation shapes cannot produce acceptance", (t) => {
	for (const change of [
		(f) => {
			const v = JSON.parse(readFileSync(f.r2.observePath));
			delete v.timeline;
			writeFileSync(f.r2.observePath, JSON.stringify(v));
		},
		(f) => {
			const s = JSON.parse(readFileSync(f.r2.shapePath));
			s.bodies.B1.bindings = [];
			writeFileSync(f.r2.shapePath, JSON.stringify(s));
		},
	]) {
		const f = pairFixture(t);
		change(f);
		writeFileSync(f.r2Path, JSON.stringify(verdictRound(f.r2)));
		assert.equal(composeReportPair(f).status, "fail");
	}
});
test("HTML excludes raw hostile payload text", (t) => {
	const f = pairFixture(t),
		o = JSON.parse(readFileSync(f.r1.observePath));
	o.timeline.sessionEvents[0].payload = "<script>alert(1)</script>";
	writeFileSync(f.r1.observePath, JSON.stringify(o));
	writeFileSync(f.r1Path, JSON.stringify(verdictRound(f.r1)));
	const r = composeReportPair(f);
	assert.equal(r.status, "pass");
	assert.doesNotMatch(r.html, /<script>/);
	assert.doesNotMatch(r.html, /&lt;script&gt;/);
	assert.doesNotMatch(r.markdown, /<script>/);
});
test("failed fixture disclosure does not assert that both rounds used the fixtures", (t) => {
	const f = pairFixture(t),
		v = JSON.parse(readFileSync(f.r2.fixturePath));
	v.roomInfoHidden = false;
	writeFileSync(f.r2.fixturePath, JSON.stringify(v));
	writeFileSync(f.r2Path, JSON.stringify(verdictRound(f.r2)));
	const r = composeReportPair(f);
	assert.equal(r.status, "fail");
	assert.match(r.markdown, /r2.*roomInfoHidden=false/);
	assert.doesNotMatch(r.markdown, /两轮均隐藏/);
});
test("missing body session and holder shape is rejected", (t) => {
	const f = pairFixture(t),
		s = JSON.parse(readFileSync(f.r1.shapePath));
	delete s.bodies.B1.session;
	writeFileSync(f.r1.shapePath, JSON.stringify(s));
	writeFileSync(f.r1Path, JSON.stringify(verdictRound(f.r1)));
	assert.equal(composeReportPair(f).status, "fail");
});
test("production evidence includes measured scan counts and health readings", (t) => {
	const r = composeReportPair(pairFixture(t));
	assert.match(r.markdown, /"hitCount":0/);
	assert.match(r.markdown, /"uptime":100/);
});
test("pair reports baseline and new counts without publishing hit identities", (t) => {
	const f = pairFixture(t);
	const zero = JSON.parse(readFileSync(f.r1.zeroImpactPath));
	const proof = {
		status: "fail",
		hitCount: 1,
		hits: [{ table: "private-identity", column: "private-column", count: 1 }],
		hitRows: [
			{ table: "private-identity", column: "private-column", rowid: 1 },
		],
	};
	for (const path of Object.values(zero.comm))
		writeFileSync(path, JSON.stringify(proof));
	writeFileSync(f.r1Path, JSON.stringify(verdictRound(f.r1)));
	const r = composeReportPair(f);
	assert.equal(r.status, "pass", JSON.stringify(r.failures));
	assert.match(r.markdown, /"baselineHitCount":1/);
	assert.match(r.markdown, /"newHitCount":0/);
	assert.doesNotMatch(r.markdown, /private-identity|private-column/);
	assert.doesNotMatch(r.html, /private-identity|private-column/);
});

test("real verdict to pair publication excludes argv and nested secrets but preserves measured evidence", (t) => {
	const f = pairFixture(t),
		secret = "synthetic-FLY2456-PRIVATE-TOKEN";
	for (const round of ["r1", "r2"]) {
		const input = f[round],
			zero = JSON.parse(readFileSync(input.zeroImpactPath));
		const proc = JSON.parse(readFileSync(zero.proc.live));
		proc.added = [
			{
				pid: 4123,
				ppid: 4000,
				lstart: "Thu Sep 10 00:00:00 2026",
				attribution: "SLOT",
				command: `env -i TEAMLEAD_API_TOKEN=${secret} FLYWHEEL_INGEST_TOKEN=${secret} node /x.js`,
				env: { token: secret },
			},
		];
		writeFileSync(zero.proc.live, JSON.stringify(proc));
		const fleet = JSON.parse(readFileSync(zero.fleet.postTeardown));
		fleet.status = "needs-attribution";
		fleet.removed = [{ kind: "socket", line: "/private/prod.sock" }];
		fleet.attributions = [
			{
				...fleet.removed[0],
				executionId: "prod-ended",
				command: secret,
				terminalEvidence: {
					source: "session_events",
					event_type: "session_completed",
					ts: "2026-09-10T00:00:05Z",
					payload: { token: secret },
				},
			},
		];
		writeFileSync(zero.fleet.postTeardown, JSON.stringify(fleet));
		const o = JSON.parse(readFileSync(input.observePath));
		o.timeline.sessionEvents = [
			{
				id: 8,
				event_id: "evt-first",
				ts: "2026-09-10T00:00:01Z",
				event_type: "reown_revive_failed",
				execution_id: "exec-B1",
				payload: JSON.stringify({
					attempt: 1,
					reason: "workflow capability drift for exec-B1",
					token: secret,
				}),
				parsedPayload: { attempt: 1, token: secret },
				extra: { nested: secret },
			},
			{
				id: 9,
				event_id: "evt-second",
				ts: "2026-09-10T00:00:02Z",
				event_type: "reown_revive_succeeded",
				execution_id: "exec-B2",
				payload: JSON.stringify({ attempt: 2, credential: secret }),
			},
		];
		o.bodies.B1.replacement = {
			executionId: "replacement-safe",
			runId: "run-B1",
			rollbackSeq: 1,
			materializedSeq: 2,
			launchedSeq: 3,
			raw: { token: secret },
		};
		writeFileSync(input.observePath, JSON.stringify(o));
		const v = verdictRound(input);
		assert.equal(v.status, "pass", JSON.stringify(v.failures));
		assert.ok(!v.markdown.includes(secret));
		assert.ok(!v.html.includes(secret));
		writeFileSync(f[round + "Path"], JSON.stringify(v));
		assert.ok(readFileSync(zero.proc.live, "utf8").includes(secret));
	}
	const r = composeReportPair(f);
	assert.equal(r.status, "pass", JSON.stringify(r.failures));
	for (const text of [r.markdown, r.html]) {
		assert.ok(!text.includes(secret));
		assert.doesNotMatch(text, /TEAMLEAD_API_TOKEN|FLYWHEEL_INGEST_TOKEN/);
		for (const retained of [
			"50%",
			"100%",
			"evt-first",
			"evt-second",
			"reown_revive_failed",
			"reown_revive_succeeded",
			"prod-ended",
			"session_completed",
			"replacement-safe",
			"4123",
		])
			assert.ok(text.includes(retained), retained);
		assert.ok(text.indexOf("evt-first") < text.indexOf("evt-second"));
	}
	assert.match(r.markdown, /"attempt":2/);
	assert.ok(r.evidence.every((e) => /^[a-f0-9]{64}$/.test(e.sha256)));
});
