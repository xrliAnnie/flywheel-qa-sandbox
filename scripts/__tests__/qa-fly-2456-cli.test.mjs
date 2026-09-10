import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MAILBOX_SCHEMA } from "../../packages/flywheel-comm/src/mailbox-schema.ts";

const cli = fileURLToPath(
	new URL("../qa-fly-2456-drill-tools.mjs", import.meta.url),
);
function run(args) {
	const r = spawnSync(process.execPath, [cli, ...args], {
		encoding: "utf8",
		timeout: 10000,
	});
	assert.equal(r.error, undefined);
	return { code: r.status, value: JSON.parse(r.stdout) };
}
function file(f, name, value) {
	const path = join(dirname(f.dbPath), name);
	writeFileSync(
		path,
		typeof value === "string" ? value : JSON.stringify(value),
	);
	return path;
}

const require = createRequire(
	new URL("../../packages/flywheel-comm/package.json", import.meta.url),
);
const Database = require("better-sqlite3");
const bodies = { B1: "exec-B1", B2: "exec-B2", B3: "exec-B3" };
function stamp(path) {
	writeFileSync(
		`${path}.meta.json`,
		JSON.stringify({
			observedAt: new Date().toISOString(),
			sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
		}),
	);
}
function fixture(t, mutate = () => {}) {
	const dir = mkdtempSync(join(tmpdir(), "fly2456-shape-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const dbPath = join(dir, "teamlead.db"),
		commPath = join(dir, "comm.db"),
		livenessPath = join(dir, "liveness.json");
	const db = new Database(dbPath),
		comm = new Database(commPath);
	db.pragma("foreign_keys=OFF");
	const source = readFileSync(
		new URL("../../packages/teamlead/src/StateStore.ts", import.meta.url),
		"utf8",
	);
	for (const name of [
		"sessions",
		"workflow_execution_binding",
		"workflow_run",
		"workflow_run_node",
		"session_events",
		"workflow_run_event",
		"recovery_claim",
		"lead_events",
		"workflow_engine_park_outbox",
	])
		db.exec(
			source.match(
				new RegExp(
					`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\t\\t\\t\\)`,
				),
			)[0],
		);
	db.exec("ALTER TABLE sessions ADD COLUMN adapter_type TEXT");
	const commSource = readFileSync(
		new URL("../../packages/flywheel-comm/src/db.ts", import.meta.url),
		"utf8",
	);
	comm.exec(MAILBOX_SCHEMA);
	comm.exec(
		"CREATE TABLE sessions(execution_id TEXT); CREATE TABLE runner_workflow_activation(execution_id TEXT)",
	);
	comm.exec(
		commSource.match(
			/CREATE TABLE IF NOT EXISTS three_stage_turn \([\s\S]*?\n\);/,
		)[0],
	);
	comm.exec(
		commSource.match(
			/CREATE TABLE IF NOT EXISTS workflow_engine_park \([\s\S]*?\n\);/,
		)[0],
	);
	const liveness = [];
	for (const [label, executionId] of Object.entries(bodies)) {
		const issue = `FLY-${label.slice(1)}`,
			run = `run-${label}`,
			parked = label === "B3";
		db.prepare(
			"INSERT INTO sessions(execution_id,issue_id,project_name,status,adapter_type) VALUES(?,?,?,?,?)",
		).run(
			executionId,
			issue,
			"test-slot-4",
			parked ? "ship_parked" : "running",
			"codex-tmux",
		);
		db.prepare(
			"INSERT INTO workflow_run(run_id,issue_id,project_name,status) VALUES(?,?,?,?)",
		).run(run, issue, "test-slot-4", "active");
		for (let attempt = 1; attempt <= (label === "B1" ? 2 : 1); attempt++) {
			db.prepare(
				"INSERT INTO workflow_execution_binding(activation_id,execution_id,run_id,node_id,attempt,mode,bound_at) VALUES(?,?,?,?,?,?,?)",
			).run(
				`activation-${label}-${attempt}`,
				executionId,
				run,
				"implement",
				attempt,
				attempt === 1 ? "spawn" : "wake",
				"2026-09-10T00:00:00Z",
			);
			db.prepare(
				"INSERT INTO workflow_run_node(run_id,node_id,attempt,state,execution_id) VALUES(?,?,?,?,?)",
			).run(
				run,
				"implement",
				attempt,
				parked ? "done" : "running",
				executionId,
			);
		}
		comm
			.prepare(
				"INSERT INTO three_stage_turn(issue_id,holder_exec_id,phase,epoch,granted_at,target_run_id) VALUES(?,?,?,?,?,?)",
			)
			.run(
				issue,
				parked ? "qa-exec" : executionId,
				parked ? "qa" : "implement",
				1,
				1,
				run,
			);
		if (!parked) {
			comm
				.prepare(
					"INSERT INTO mailbox_identity(id,delivery_id,insert_projection_hash) VALUES(?,?,?)",
				)
				.run(`gate-${label}`, `delivery-${label}`, "hash");
			comm
				.prepare(
					"INSERT INTO mailbox(id,delivery_id,from_agent,to_agent,recipient_kind,type,content,created_at,checkpoint,relay_state) VALUES(?,?,?,?,'lead','question',?,'2026-09-10T00:00:00Z','question','open')",
				)
				.run(
					`gate-${label}`,
					`delivery-${label}`,
					executionId,
					"flywheel-test-4",
					"FLY-2456 drill hold",
				);
		}
		liveness.push({
			executionId,
			verdict: "alive",
			socketPath: `/tmp/flywheel-test-slot-4/state/cdx-sock/${createHash("sha1").update(executionId).digest("hex").slice(0, 16)}.sock`,
			persistedPgidBefore: 123,
			persistedPgidAfter: 123,
			groupState: "alive",
			holderPids: [{ pid: 124, pgid: 123 }],
		});
	}
	mutate({ db, comm, liveness });
	db.close();
	comm.close();
	stamp(dbPath);
	stamp(commPath);
	writeFileSync(livenessPath, JSON.stringify(liveness));
	return { dbPath, commPath, livenessPath, bodies };
}
test("CLI bounds and activation parser use valid immutable database", (t) => {
	const f = fixture(t);
	const bounded = run([
		"bounds",
		"--db",
		f.dbPath,
		"--runs",
		"run-B1",
		"--runs",
		"run-B2",
		"--runs",
		"run-B3",
	]);
	assert.equal(bounded.code, 0);
	assert.equal(bounded.value.sessionEventsMaxId, 0);
	const parsed = run([
		"activation-parse",
		"--db",
		f.dbPath,
		"--exec",
		"exec-B1",
	]);
	assert.equal(parsed.code, 0);
	assert.equal(parsed.value.bindings.length, 2);
	const invalid = run(["bounds", "--db", f.dbPath, "--runs", "absent"]);
	assert.equal(invalid.code, 1);
});
test("CLI campaign shape positive and real ineligible negative", (t) => {
	const good = fixture(t);
	const args = (f) => [
		"campaign-shape",
		"--db",
		f.dbPath,
		"--comm",
		f.commPath,
		"--liveness",
		f.livenessPath,
		...Object.entries(bodies).flatMap(([l, e]) => ["--body", `${l}=${e}`]),
	];
	assert.equal(run(args(good)).code, 0);
	const bad = fixture(t, ({ db }) =>
		db.exec(
			"UPDATE sessions SET status='ship_parked' WHERE execution_id='exec-B2'",
		),
	);
	assert.equal(run(args(bad)).code, 1);
});
test("CLI observe JSON bounds and bodies parses evidence", (t) => {
	const f = fixture(t);
	const b = file(f, "bounds.json", {
		sessionEventsMaxId: 0,
		runEventMaxSeq: { "run-B1": 0, "run-B2": 0, "run-B3": 0 },
	});
	const ids = file(
		f,
		"bodies.json",
		Object.fromEntries(
			Object.entries(bodies).map(([l, e]) => [
				l,
				{ executionId: e, runId: `run-${l}`, nodeId: "implement" },
			]),
		),
	);
	const r = run(["observe", "--db", f.dbPath, "--bounds", b, "--bodies", ids]);
	assert.equal(r.code, 0);
	assert.equal(r.value.bodies.B1.classification, "excluded_or_ineligible");
	assert.equal(
		run([
			"observe",
			"--db",
			f.dbPath,
			"--bounds",
			file(f, "bad-bounds.json", {}),
			"--bodies",
			ids,
		]).code,
		1,
	);
});
test("CLI comm and production scanners return meaningful nonzero contamination", (t) => {
	const f = fixture(t);
	assert.equal(
		run([
			"comm-scan",
			"--db",
			f.commPath,
			"--slot",
			"9",
			"--exec",
			"not-present",
		]).code,
		0,
	);
	assert.equal(
		run([
			"comm-scan",
			"--db",
			f.commPath,
			"--slot",
			"4",
			"--exec",
			"not-present",
		]).code,
		1,
	);
	assert.equal(
		run(["prod-statestore-check", "--db", f.dbPath, "--exec", "not-present"])
			.code,
		0,
	);
	assert.equal(
		run(["prod-statestore-check", "--db", f.dbPath, "--exec", "exec-B1"]).code,
		1,
	);
});
test("CLI fleet identity writes sidecar exclusively and fleet diff checks declarations", (t) => {
	const f = fixture(t);
	const inventory = file(f, "inventory.txt", "|main|@1|fly2454-decoy\n"),
		out = join(dirname(f.dbPath), "sidecar.json");
	const args = [
		"fleet-identity",
		"--prod-statestore",
		f.dbPath,
		"--tmux-inventory",
		inventory,
		"--prod-socket-root",
		"/synthetic/prod/sockets",
		"--out",
		out,
	];
	assert.equal(run(args).code, 0);
	const initial = readFileSync(out, "utf8");
	assert.equal(run(args).code, 1);
	assert.equal(readFileSync(out, "utf8"), initial);
	const before = file(
			f,
			"before.txt",
			"[codex-app-servers]\n[tmux-windows]\nmain|@1|fly2454-decoy\n",
		),
		after = file(
			f,
			"after.txt",
			"[codex-app-servers]\n/synthetic/slot.sock\n[tmux-windows]\nmain|@1|fly2454-decoy\n",
		);
	const diff = [
		"fleet-diff",
		"--before",
		before,
		"--after",
		after,
		"--mode",
		"live",
	];
	assert.equal(run(diff).code, 1);
	assert.equal(
		run([
			...diff,
			"--declared-sockets",
			file(f, "sockets.json", ["/synthetic/slot.sock"]),
		]).code,
		0,
	);
});
test("CLI liveness command renders without executing paths", () => {
	const good = run([
		"liveness-command",
		"--runtime-module",
		"/does-not-exist/runtime.js",
		"--state-dir",
		"/synthetic/state",
		"--socket-root",
		"/synthetic/sockets",
		"--marker-dir",
		"/synthetic/markers",
		"--exec",
		"exec-B1",
	]);
	assert.equal(good.code, 0);
	assert.ok(good.value.command.includes("probeCodexDaemonLiveness"));
	assert.equal(
		run([
			"liveness-command",
			"--runtime-module",
			"relative",
			"--state-dir",
			"/state",
			"--socket-root",
			"/sockets",
			"--marker-dir",
			"/markers",
			"--exec",
			"exec-B1",
		]).code,
		1,
	);
});
function initManifest(f) {
	const path = join(dirname(f.dbPath), "manifest.json");
	const initialized = run([
		"manifest",
		"init",
		"--manifest",
		path,
		"--round",
		"r1",
		"--slot",
		"4",
		"--checkout",
		"/synthetic/checkout",
		"--head",
		"a".repeat(40),
		"--issue",
		"B1=FLY-1",
		"--issue",
		"B2=FLY-2",
		"--issue",
		"B3=FLY-3",
	]);
	assert.equal(initialized.code, 0);
	return path;
}
test("CLI manifest receipt writes once and rejects mismatched replay", (t) => {
	const f = fixture(t),
		path = initManifest(f),
		detail = file(f, "intent.json", {
			kind: "decoy",
			tmuxSocket: "/private/tmp/tmux-501/default",
		});
	assert.equal(
		run([
			"manifest",
			"intent",
			"--manifest",
			path,
			"--step",
			"decoy",
			"--file",
			detail,
		]).code,
		0,
	);
	const args = [
		"manifest",
		"receipt",
		"--manifest",
		path,
		"--step",
		"decoy",
		"--file",
		file(f, "receipt.json", { windowIdentity: "main|@1|fly2454-decoy" }),
	];
	assert.equal(run(args).code, 0);
	assert.equal(run(args).code, 0);
	assert.equal(
		run([
			"manifest",
			"receipt",
			"--manifest",
			path,
			"--step",
			"decoy",
			"--file",
			file(f, "wrong-receipt.json", { windowIdentity: "other" }),
		]).code,
		1,
	);
});
test("CLI file adoption records decoy receipt and replays exact evidence", (t) => {
	const f = fixture(t),
		path = initManifest(f);
	assert.equal(
		run([
			"manifest",
			"intent",
			"--manifest",
			path,
			"--step",
			"decoy",
			"--file",
			file(f, "intent.json", {
				kind: "decoy",
				tmuxSocket: "/private/tmp/tmux-501/default",
			}),
		]).code,
		0,
	);
	const evidence = file(f, "evidence.json", {
		scope: { slot: 4, checkout: "/synthetic/checkout" },
		tmuxSocket: "/private/tmp/tmux-501/default",
		tmuxInventory: "|main|@1|fly2454-decoy\n",
	});
	stamp(evidence);
	const args = [
		"manifest",
		"adopt",
		"--manifest",
		path,
		"--step",
		"decoy",
		"--evidence",
		evidence,
	];
	const first = run(args);
	assert.equal(first.code, 0, JSON.stringify(first.value));
	assert.equal(first.value.action, "adopt-existing");
	assert.equal(run(args).value.action, "replay");
	const bad = file(f, "bad-evidence.json", {
		scope: { slot: 4, checkout: "/synthetic/checkout" },
		tmuxSocket: "/private/tmp/tmux-501/default",
		tmuxInventory: "|main|@2|other\n",
	});
	stamp(bad);
	assert.equal(run([...args.slice(0, -1), bad]).code, 1);
});
function startedManifest(f) {
	const path = initManifest(f),
		m = JSON.parse(readFileSync(path));
	for (const [label, executionId] of Object.entries(bodies))
		m.steps[`start-${label}`] = {
			intent: {
				detail: { kind: "start", label, issueId: m.config.issues[label] },
			},
			receipt: {
				result: {
					success: true,
					generalized: true,
					executionId,
					workflowRunId: `run-${label}`,
					workflowNodeId: "implement",
				},
			},
		};
	m.steps.cycle = {
		intent: {
			detail: {
				kind: "cycle",
				preState: {
					bounds: {
						sessionEventsMaxId: 0,
						runEventMaxSeq: { "run-B1": 0, "run-B2": 0, "run-B3": 0 },
					},
				},
			},
		},
	};
	writeFileSync(path, JSON.stringify(m));
	return path;
}
test("CLI observe derives exact bodies and cycle bounds from manifest", (t) => {
	const f = fixture(t),
		path = startedManifest(f);
	const args = [
		"observe",
		"--db",
		f.dbPath,
		"--manifest",
		path,
		"--step",
		"cycle",
	];
	assert.equal(run(args).code, 0);
	const m = JSON.parse(readFileSync(path));
	m.steps.duplicate = m.steps["start-B1"];
	writeFileSync(path, JSON.stringify(m));
	assert.equal(run(args).code, 1);
});
test("CLI launch delta accepts declared starts and rejects unknown receipt basename", (t) => {
	const f = fixture(t),
		path = startedManifest(f),
		before = file(f, "launch-before.txt", "");
	const args = [
		"launch-commits-delta",
		"--manifest",
		path,
		"--before",
		before,
		"--after",
		file(f, "launch-after.txt", "exec-B1\n"),
	];
	assert.equal(run(args).code, 0);
	writeFileSync(args.at(-1), "unknown-exec\n");
	assert.equal(run(args).code, 1);
});
test("CLI dry-run validates provided guard receipt and not-run exits nonzero", (t) => {
	const f = fixture(t),
		command = "/synthetic/tool --read",
		book =
			'## One\n命令\n<!-- fly2456-step {"id":"read","kind":"read"} -->\n```bash\n' +
			command +
			"\n```\n期望输出: pass\n落盘: output\n停手: failure\n";
	const runbook = file(f, "runbook.md", book),
		scanner = file(f, "scanner.py", "# synthetic scanner fixture\n");
	const hash = (value) => createHash("sha256").update(value).digest("hex");
	const receipt = file(f, "guard.json", {
		schemaVersion: 1,
		inputsDigest: hash(book),
		scannerSha256: hash(readFileSync(scanner)),
		commands: [{ sha256: hash(command), hit: null }],
	});
	const args = [
		"dry-run",
		"--runbook",
		runbook,
		"--scanner",
		scanner,
		"--receipt",
		receipt,
	];
	assert.equal(run(args).code, 0);
	rmSync(receipt);
	const missing = run(args);
	assert.equal(missing.code, 1);
	assert.equal(missing.value.status, "not-run");
});
test("CLI runner window equality passes while unexplained count change fails", (t) => {
	const f = fixture(t),
		before = file(f, "count-before", "3\n"),
		after = file(f, "count-after", "3\n"),
		args = ["runner-windows", "--before", before, "--after", after];
	assert.equal(run(args).code, 0);
	writeFileSync(after, "2\n");
	assert.equal(run(args).code, 1);
});
test("CLI park and terminate dispatch actual authority and preserve execute/noop distinction", (t) => {
	const f = fixture(t),
		path = initManifest(f);
	const detail = file(f, "park-intent", {
		kind: "park-complete",
		label: "B2",
		issueId: "FLY-2",
		executionId: "exec-B2",
		runId: "run-B2",
	});
	assert.equal(
		run([
			"manifest",
			"intent",
			"--manifest",
			path,
			"--step",
			"park",
			"--file",
			detail,
		]).code,
		0,
	);
	stamp(f.dbPath);
	stamp(f.commPath);
	const parked = run([
		"manifest",
		"adopt",
		"--manifest",
		path,
		"--step",
		"park",
		"--db",
		f.dbPath,
		"--comm",
		f.commPath,
	]);
	assert.equal(parked.code, 0, JSON.stringify(parked.value));
	assert.equal(parked.value.action, "execute");
	const terminal = fixture(t, ({ db }) =>
			db.exec(
				"UPDATE sessions SET status='failed' WHERE execution_id='exec-B2'",
			),
		),
		m = initManifest(terminal);
	assert.equal(
		run([
			"manifest",
			"intent",
			"--manifest",
			m,
			"--step",
			"terminate",
			"--file",
			file(terminal, "terminate-intent", {
				kind: "terminate",
				executionId: "exec-B2",
				reason: "drill cleanup",
				purpose: "qa-fallback",
			}),
		]).code,
		0,
	);
	stamp(terminal.dbPath);
	const result = run([
		"manifest",
		"adopt",
		"--manifest",
		m,
		"--step",
		"terminate",
		"--db",
		terminal.dbPath,
	]);
	assert.equal(result.code, 0, JSON.stringify(result.value));
	assert.equal(result.value.result.noop, true);
	assert.equal(
		JSON.parse(readFileSync(m)).steps.terminate.receipt.result.outcome,
		"not-executed",
	);
});
test("CLI existing gate dispatcher remains live", (t) => {
	const f = fixture(t),
		path = initManifest(f);
	assert.equal(
		run([
			"manifest",
			"intent",
			"--manifest",
			path,
			"--step",
			"gate",
			"--file",
			file(f, "gate-intent", {
				kind: "gate",
				label: "B2",
				issueId: "FLY-2",
				executionId: "exec-B2",
				checkpoint: "question",
			}),
		]).code,
		0,
	);
	stamp(f.commPath);
	const output = run([
		"manifest",
		"adopt",
		"--manifest",
		path,
		"--step",
		"gate",
		"--comm",
		f.commPath,
	]);
	assert.equal(output.code, 0, JSON.stringify(output.value));
	assert.equal(output.value.result.questionId, "gate-B2");
});
test("CLI needs-attribution remains a nonzero exit", (t) => {
	const terminalAt = new Date(Date.now() - 30000).toISOString();
	const f = fixture(t, ({ db }) =>
		db
			.prepare(
				"UPDATE sessions SET status='completed',terminal_at=? WHERE execution_id='exec-B2'",
			)
			.run(terminalAt),
	);
	const metadata = JSON.parse(readFileSync(`${f.dbPath}.meta.json`));
	const sidecar = file(f, "attribution-sidecar", {
		status: "pass",
		metadata: {
			...metadata,
			observedAt: new Date(Date.now() - 60000).toISOString(),
		},
		entries: [
			{
				executionId: "exec-B2",
				socketPath: "/synthetic/prod.sock",
				windowIdentity: null,
			},
		],
	});
	const before = file(
			f,
			"fleet-before",
			"[codex-app-servers]\n/synthetic/prod.sock\n[tmux-windows]\nmain|@1|fly2454-decoy\n",
		),
		after = file(
			f,
			"fleet-after",
			"[codex-app-servers]\n[tmux-windows]\nmain|@1|fly2454-decoy\n",
		);
	const output = run([
		"fleet-diff",
		"--before",
		before,
		"--after",
		after,
		"--mode",
		"post-teardown",
		"--sidecar",
		sidecar,
		"--prod-statestore",
		f.dbPath,
		"--kill-ledger",
		file(f, "empty-ledger", ""),
		"--window",
		file(f, "window", {
			from: new Date(Date.now() - 45000).toISOString(),
			to: metadata.observedAt,
		}),
	]);
	assert.equal(output.value.status, "needs-attribution");
	assert.equal(output.code, 1);
});

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
						hits: [],
						hitRows: [],
						baselineHitCount: 0,
						newHitCount: 0,
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

test("verdict CLI serializes full reports and rejects invalid rounds", (t) => {
	const f = verdictFixture(t);
	const args = [
		"verdict",
		"--round",
		"r1",
		"--manifest",
		f.manifestPath,
		"--shape",
		f.shapePath,
		"--observe",
		f.observePath,
		"--zero-impact",
		f.zeroImpactPath,
		"--fixture",
		f.fixturePath,
	];
	const r = run(args);
	assert.equal(r.code, 0);
	assert.equal(r.value.status, "pass");
	assert.equal(r.value.successRate, 0.5);
	assert.match(r.value.markdown, /FLY-2456/);
	assert.match(r.value.html, /<!doctype html>/i);
	assert.ok(r.value.evidence.length > 5);
	assert.ok(r.value.evidence.every((e) => /^[a-f0-9]{64}$/.test(e.sha256)));
	args[2] = "r3";
	const bad = run(args);
	assert.equal(bad.code, 1);
	assert.equal(bad.value.status, "fail");
	assert.match(bad.value.failures.join(" "), /round identity invalid/);
});
test("CLI proc preparation preserves raw and feeds verified comparison to attribution", (t) => {
	const f = fixture(t),
		raw = file(
			f,
			"ps.txt",
			"1 0 Thu Sep 10 01:02:03 2026 /sbin/launchd\n2 1 Thu Sep 10 01:02:03 2026 /bin/ps -axo pid=,ppid=,lstart=,command=\n",
		),
		out = join(dirname(f.dbPath), "ps-comparison.txt");
	const prepared = run([
		"proc-prepare",
		"--raw",
		raw,
		"--sensor-pid",
		"2",
		"--out",
		out,
	]);
	assert.equal(prepared.code, 0);
	assert.equal(prepared.value.exclusion.pid, 2);
	assert.match(readFileSync(raw, "utf8"), /\/bin\/ps/);
	const comparison = run([
		"proc-attribution",
		"--baseline",
		out,
		"--after",
		out,
		"--slot-dir",
		"/tmp/slot-4",
		"--checkout",
		"/tmp/checkout",
	]);
	assert.equal(comparison.code, 0);
	assert.equal(comparison.value.status, "pass");
});
