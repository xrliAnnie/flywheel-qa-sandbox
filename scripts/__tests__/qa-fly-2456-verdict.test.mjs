import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verdictRound } from "../lib/qa-fly-2456-verdict.mjs";

function fixture(t, round = "r1") {
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
test("R1 and R2 rates exclude negative control and retain zero-table evidence report", (t) => {
	for (const round of ["r1", "r2"]) {
		const r = verdictRound(fixture(t, round));
		assert.equal(r.status, "pass");
		assert.equal(r.successRate, round === "r1" ? 0.5 : 1);
		assert.equal(r.eligible, 2);
		assert.doesNotMatch(r.markdown, /\|.*\|/);
		assert.match(r.html, /<!doctype html>/i);
	}
});
test("missing any zero-impact group cannot pass", (t) => {
	const f = fixture(t),
		zero = JSON.parse(readFileSync(f.zeroImpactPath));
	delete zero.comm;
	writeFileSync(f.zeroImpactPath, JSON.stringify(zero));
	assert.equal(verdictRound(f).status, "fail");
});
test("R2 global drift or missing attempt2 proof prevents acceptance", (t) => {
	for (const change of [
		(o) => o.capabilityDriftEvents.push({ payload: "capability drift" }),
		(o) => {
			o.bodies.B1.attempt2PreparedProof = false;
		},
	]) {
		const f = fixture(t, "r2"),
			o = JSON.parse(readFileSync(f.observePath));
		change(o);
		writeFileSync(f.observePath, JSON.stringify(o));
		assert.equal(verdictRound(f).status, "fail");
	}
});
test("cycle1 events and shortened precondition wait fail", (t) => {
	for (const change of [
		(f) => f.cycle1.timeline.sessionEvents.push({ id: 1 }),
		(f) => {
			f.precondition.waitedMs = 599999;
		},
	]) {
		const f = fixture(t),
			v = JSON.parse(readFileSync(f.fixturePath));
		change(v);
		writeFileSync(f.fixturePath, JSON.stringify(v));
		assert.equal(verdictRound(f).status, "fail");
	}
});
test("wrong slot and body issue binding cannot be hidden by matching observation ids", (t) => {
	const f = fixture(t, "r2"),
		m = JSON.parse(readFileSync(f.manifestPath));
	m.config.slot = 4;
	writeFileSync(f.manifestPath, JSON.stringify(m));
	assert.equal(verdictRound(f).status, "fail");
});
test("cycle1 needs the same three body identities", (t) => {
	const f = fixture(t),
		v = JSON.parse(readFileSync(f.fixturePath));
	delete v.cycle1.bodies;
	writeFileSync(f.fixturePath, JSON.stringify(v));
	assert.equal(verdictRound(f).status, "fail");
});
for (const group of ["fleet", "proc", "runnerWindows"])
	test(`bare pass cannot replace ${group} evidence`, (t) => {
		const f = fixture(t),
			zero = JSON.parse(readFileSync(f.zeroImpactPath));
		for (const path of Object.values(zero[group]))
			writeFileSync(path, JSON.stringify({ status: "pass" }));
		assert.equal(verdictRound(f).status, "fail");
	});
test("accepted fleet attribution is included in both report formats", (t) => {
	const f = fixture(t),
		zero = JSON.parse(readFileSync(f.zeroImpactPath));
	writeFileSync(
		zero.fleet.postTeardown,
		JSON.stringify({
			status: "needs-attribution",
			added: [],
			removed: [{ kind: "window", line: "runner|@1|main" }],
			attributions: [
				{
					kind: "window",
					line: "runner|@1|main",
					executionId: "prod-execution",
					terminalEvidence: {
						source: "sessions.terminal_at",
						at: "2026-09-09T00:00:00Z",
					},
				},
			],
		}),
	);
	const result = verdictRound(f);
	assert.equal(result.status, "pass");
	assert.match(result.markdown, /prod-execution/);
	assert.match(result.html, /sessions.terminal_at/);
});
test("precondition needs-attribution requires actual matched removed identities", (t) => {
	const f = fixture(t),
		v = JSON.parse(readFileSync(f.fixturePath));
	v.precondition.fleet = { status: "needs-attribution" };
	writeFileSync(f.fixturePath, JSON.stringify(v));
	assert.equal(verdictRound(f).status, "fail");
});
test("Lead structural tick exception preserves measured wall clock and disclosure", (t) => {
	const f = fixture(t),
		v = JSON.parse(readFileSync(f.fixturePath));
	Object.assign(v.precondition, {
		maintenanceTicks: null,
		startedAt: "2026-09-10T00:00:00Z",
		endedAt: "2026-09-10T00:10:00Z",
		tickEvidence: {
			status: "unavailable",
			reason: "no_unconditional_tick_observable",
			rulingQuestionId: "c7791d8e-0d58-44d2-af0f-28b371382737",
		},
	});
	writeFileSync(f.fixturePath, JSON.stringify(v));
	const result = verdictRound(f);
	assert.equal(result.status, "pass");
	assert.match(
		result.markdown,
		/UNAVAILABLE.*no_unconditional_tick_observable/,
	);
	for (const change of [
		(p) => {
			delete p.startedAt;
		},
		(p) => {
			p.endedAt = "2026-09-10T00:09:59Z";
		},
		(p) => {
			p.tickEvidence.rulingQuestionId = "unapproved";
		},
		(p) => {
			p.maintenanceTicks = 2;
		},
	]) {
		const x = structuredClone(v);
		change(x.precondition);
		writeFileSync(f.fixturePath, JSON.stringify(x));
		assert.equal(verdictRound(f).status, "fail");
	}
});
test("supplied clock endpoints cannot contradict a numeric tick receipt", (t) => {
	for (const fields of [
		{ startedAt: "invalid", endedAt: "invalid" },
		{ startedAt: "2026-09-10T00:00:00Z", endedAt: "2026-09-10T00:00:01Z" },
		{ startedAt: "2026-09-10T00:00:00Z" },
	]) {
		const f = fixture(t),
			v = JSON.parse(readFileSync(f.fixturePath));
		Object.assign(v.precondition, fields);
		writeFileSync(f.fixturePath, JSON.stringify(v));
		assert.equal(verdictRound(f).status, "fail");
	}
});

for (const group of ["comm", "prodState"]) {
	test(`${group} historical hits pass while new identities fail the round`, (t) => {
		const f = fixture(t),
			zero = JSON.parse(readFileSync(f.zeroImpactPath));
		const record = {
			status: "fail",
			hitCount: 1,
			hits: [{ table: "sessions", column: "execution_id", count: 1 }],
			hitRows: [{ table: "sessions", column: "execution_id", rowid: 10 }],
		};
		for (const path of Object.values(zero[group]))
			writeFileSync(path, JSON.stringify(record));
		const baseline = verdictRound(f);
		assert.equal(baseline.status, "pass");
		assert.equal(
			baseline.zeroImpactDeltas[group].liveAfter.baselineHitCount,
			1,
		);
		assert.equal(baseline.zeroImpactDeltas[group].liveAfter.newHitCount, 0);
		assert.match(
			baseline.markdown,
			new RegExp(group + "/liveAfter.*基线 1.*新增 0"),
		);
		record.hitRows[0].rowid = 20;
		writeFileSync(zero[group].liveAfter, JSON.stringify(record));
		const changed = verdictRound(f);
		assert.equal(changed.status, "fail");
		assert.equal(changed.zeroImpactDeltas[group].liveAfter.newHitCount, 1);
		assert.equal(changed.zeroImpactDeltas[group].liveAfter.added[0].rowid, 20);
	});
}

test("Lead process attribution resolves pending rows but cannot override tool failure (#7)", (t) => {
	const f = fixture(t),
		zero = JSON.parse(readFileSync(f.zeroImpactPath));
	const row = {
		pid: 42,
		ppid: 1,
		lstart: "Thu Sep 10 00:00:00 2026",
		command: "sleep 5",
		attribution: "NONSLOT",
	};
	const record = {
		status: "needs-attribution",
		mode: "post-teardown",
		removed: [row],
		added: [],
		unexplained: [row],
	};
	const sidecar = {
		status: "pass",
		toolStatus: "needs-attribution",
		mode: "post-teardown",
		rows: [
			{
				...row,
				set: "removed",
				kind: "host_transient",
				rule: "C:host_transient",
				evidence: "^sleep",
			},
		],
		failures: [],
	};
	const path = zero.proc.postTeardown + ".lead.json";
	zero.procLead = { postTeardown: path };
	writeFileSync(f.zeroImpactPath, JSON.stringify(zero));
	writeFileSync(zero.proc.postTeardown, JSON.stringify(record));
	writeFileSync(path, JSON.stringify(sidecar));
	assert.equal(verdictRound(f).status, "pass");
	sidecar.rows[0].pid = 43;
	writeFileSync(path, JSON.stringify(sidecar));
	assert.notEqual(verdictRound(f).status, "pass");
	sidecar.rows[0].pid = 42;
	sidecar.rows[0].kind = "production_casualty";
	writeFileSync(path, JSON.stringify(sidecar));
	assert.notEqual(verdictRound(f).status, "pass");
	record.status = "fail";
	writeFileSync(zero.proc.postTeardown, JSON.stringify(record));
	assert.equal(verdictRound(f).status, "fail");
});

test("owner exhaustion classification survives public report allowlisting (#15)", (t) => {
	const f = fixture(t),
		observed = JSON.parse(readFileSync(f.observePath));
	observed.bodies.B2.classification = "failed_exhausted_no_replacement";
	writeFileSync(f.observePath, JSON.stringify(observed));
	const result = verdictRound(f);
	assert.match(
		result.markdown,
		/B2 \(exec-B2\)：failed_exhausted_no_replacement/,
	);
});
