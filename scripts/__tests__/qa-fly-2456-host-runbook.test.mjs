import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const bash = process.env.FLY2456_TEST_BASH || "/bin/bash";

const book = readFileSync(
	new URL(
		"../../engineering/doc/FLY-2456-bridge-restart-drill/host-runbook.md",
		import.meta.url,
	),
	"utf8",
);
test("all documented Bash blocks parse without execution", () => {
	for (const [, command] of book.matchAll(/^```bash\n([\s\S]*?)\n```$/gm)) {
		const r = spawnSync(bash, ["-n"], { input: command, encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
	}
});
test("slot runner receives only slot credentials, never inherited workflow authority", (t) => {
	const root = mkdtempSync(join(tmpdir(), "fly2456-host-env-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const bin = join(root, "bin"),
		slot = join(root, "slot"),
		work = join(root, "work");
	for (const p of [bin, join(slot, "state/bridge-env-secrets"), work])
		mkdirSync(p, { recursive: true });
	writeFileSync(join(slot, "state/api-token"), "slot-token");
	writeFileSync(
		join(slot, "state/bridge-env-secrets/TEAMLEAD_INGEST_TOKEN"),
		"slot-ingest",
	);
	const config = join(root, "slots.json");
	writeFileSync(config, JSON.stringify({ slots: [{ bridgePort: 19871 }] }));
	writeFileSync(
		join(bin, "node"),
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal Bash parameter expansion for the environment fixture.
		'#!/bin/bash\nset -eu\ntest "$TEAMLEAD_API_TOKEN" = slot-token || { printf "wrong-api-scope\\n" >&2; exit 1; }\ntest "$FLYWHEEL_INGEST_TOKEN" = slot-ingest\ntest -z "${FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL-}"\ntest -z "${FLYWHEEL_WORKFLOW_OUTPUT_CREDENTIAL-}"\ntest -z "${FLYWHEEL_FOUNDER_REVIEW_REQUIRED-}"\ntest -z "${UNRELATED_SECRET-}"\ntest "$FLYWHEEL_BRIDGE_URL" = http://localhost:19871\nprintf "slot-env-ok\\n"\n',
		{ mode: 0o755 },
	);
	const body = book.match(/^slot_runner\(\) \{[\s\S]*?^\}/m)?.[0];
	assert.ok(body);
	const r = spawnSync(
		bash,
		[
			"-c",
			body + '\nslot_runner qa-exec FLY-1 "$WORK" qa-result --status fail',
		],
		{
			encoding: "utf8",
			env: {
				...process.env,
				BASH_ENV: "/dev/null",
				ENV: "/dev/null",
				PATH: bin + ":/usr/bin:/bin",
				WORK: work,
				SLOT: "1",
				SLOT_DIR: slot,
				SLOT_CONFIG: config,
				TESTED: root,
				TEAMLEAD_API_TOKEN: "owner-secret",
				FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL: "inherited-secret",
				FLYWHEEL_WORKFLOW_OUTPUT_CREDENTIAL: "inherited-secret",
				FLYWHEEL_FOUNDER_REVIEW_REQUIRED: "1",
				UNRELATED_SECRET: "inherited-secret",
			},
		},
	);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout, "slot-env-ok\n");
});

test("cycle one waits for a persisted 60 second deadline before the final snapshot", () => {
	const section = book.split("## E29 —")[1].split("## E30 —")[0];
	assert.ok(section.includes("cycle1-wait.json"));
	assert.ok(
		section.indexOf("while time.time() < deadline") <
			section.indexOf('slot_snapshots "$tag-cycle1-final"'),
	);
	assert.ok(section.includes("deadline=receipt.timestamp()+60"));
});

test("production database helper serializes >2GB aggregate reservations and releases on export failure", (t) => {
	const root = mkdtempSync(join(tmpdir(), "fly2456-budget-"));
	writeFileSync(join(root, "manifest.json"), JSON.stringify({ steps: {} }));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const helper = book.match(/^production_databases\(\) \([\s\S]*?^\)/m)?.[0];
	assert.ok(
		helper,
		"production database scope must release before next snapshot",
	);
	for (const fail of ["no", "yes"]) {
		const r = spawnSync(
			bash,
			[
				"-c",
				`set -euo pipefail
${helper}
managed_snapshot() {
 local size=1149616128
 test "$2" = comm && size=998420480
 local used=0
 test ! -f "$EVIDENCE/usage" || used=$(cat "$EVIDENCE/usage")
 test "$((used+size))" -le 2000000000 || return 78
 printf '%s' "$((used+size))" > "$EVIDENCE/usage"
 printf 'snapshot-%s\n' "$2" >> "$EVIDENCE/log"
 printf '%s' "$EVIDENCE/fixture.db"
}
derive_evidence() {
 printf 'derive-%s\n' "$3" >> "$EVIDENCE/log"
 test "$FAIL" != yes
}
snapshot_release() {
 printf 'release\n' >> "$EVIDENCE/log"
 printf 0 > "$EVIDENCE/usage"
}
production_databases "$EVIDENCE"
`,
			],
			{
				encoding: "utf8",
				env: {
					...process.env,
					EVIDENCE: root,
					FAIL: fail,
					SLOT: "4",
					MANIFEST: join(root, "manifest.json"),
				},
			},
		);
		assert.equal(r.status, fail === "yes" ? 1 : 0, r.stderr);
		assert.equal(readFileSync(join(root, "usage"), "utf8"), "0");
		assert.equal(
			readFileSync(join(root, "log"), "utf8"),
			fail === "yes"
				? "snapshot-teamlead\nderive-production\nrelease\n"
				: "snapshot-teamlead\nderive-production\nrelease\nsnapshot-comm\nderive-comm\nrelease\n",
		);
		rmSync(join(root, "log"));
	}
});

test("production comm derivation passes current manifest executions and slot markers", (t) => {
	const root = mkdtempSync(join(tmpdir(), "fly2456-markers-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const helper = book.match(/^production_databases\(\) \([\s\S]*?^\)/m)[0];
	for (const labels of [[], ["PRE", "B1", "B2", "B3", "QA"]]) {
		writeFileSync(
			join(root, "manifest.json"),
			JSON.stringify({
				steps: Object.fromEntries(
					labels.map((label) => [
						"start-" + label,
						{
							intent: {
								detail: { kind: label === "QA" ? "qa-identity" : "start" },
							},
							receipt: { result: { executionId: "exec-" + label } },
						},
					]),
				),
			}),
		);
		const r = spawnSync(
			bash,
			[
				"-c",
				`set -euo pipefail
${helper}
managed_snapshot() { printf '%s' fixture.db; }
snapshot_release() { :; }
derive_evidence() { if test "$3" = comm; then printf '%s\\n' "$@" > "$EVIDENCE/args"; fi; }
production_databases "$EVIDENCE"
`,
			],
			{
				encoding: "utf8",
				env: {
					...process.env,
					EVIDENCE: root,
					SLOT: "4",
					MANIFEST: join(root, "manifest.json"),
				},
			},
		);
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(
			readFileSync(join(root, "args"), "utf8").trim().split("\n"),
			[
				"fixture.db",
				join(root, "comm.evidence.json"),
				"comm",
				"--slot",
				"4",
				"--lead",
				"flywheel-test-4",
				...labels
					.map((label) => "exec-" + label)
					.sort()
					.flatMap((id) => ["--exec", id]),
			],
		);
	}
});

test("actual observe loop releases each source and derives final evidence before its release", (t) => {
	const root = mkdtempSync(join(tmpdir(), "fly2456-poll-budget-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const helper = book.match(/^observe_campaign\(\) \{[\s\S]*?^\}/m)?.[0];
	assert.ok(helper);
	writeFileSync(
		join(root, "manifest.json"),
		JSON.stringify({
			steps: { "cycle-2": { intent: { createdAt: new Date().toISOString() } } },
		}),
	);
	const r = spawnSync(
		bash,
		[
			"-c",
			`set -euo pipefail
${helper}
new_tag() { local n=0; test ! -f "$EVIDENCE/n" || n=$(cat "$EVIDENCE/n"); printf '%s' "$((n+1))" > "$EVIDENCE/n"; printf '%s' "$((n+1))"; }
managed_snapshot() {
 test ! -f "$EVIDENCE/active" || return 78
 printf active > "$EVIDENCE/active"
 printf 'snapshot\n' >> "$EVIDENCE/log"
 printf '{}' > "$4"
 printf '%s' "$EVIDENCE/source.db"
}
node() {
 printf 'read\n' >> "$EVIDENCE/log"
 if test "$(cat "$EVIDENCE/n")" = 3; then
  printf '{"bodies":{"B1":{"classification":"replaced"},"B2":{"classification":"succeeded"},"B3":{"classification":"skipped_not_holder"}}}'
 else printf '{"bodies":{}}'; fi
}
derive_evidence() { test -f "$EVIDENCE/active"; printf 'derive\n' >> "$EVIDENCE/log"; printf '{}' > "$2"; }
snapshot_release() { test -f "$EVIDENCE/active"; rm "$EVIDENCE/active"; printf 'release\n' >> "$EVIDENCE/log"; }
sleep() { :; }
observe_campaign 15
`,
		],
		{
			encoding: "utf8",
			env: {
				...process.env,
				EVIDENCE: root,
				MANIFEST: join(root, "manifest.json"),
				TOOLS: "fixture",
				SLOT_DIR: root,
				ROUND: "r1",
			},
		},
	);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(
		readFileSync(join(root, "log"), "utf8"),
		"snapshot\nread\nrelease\nsnapshot\nread\nrelease\nsnapshot\nread\nderive\nrelease\n",
	);
	assert.equal(
		JSON.parse(readFileSync(join(root, "observe-wait.json"))).expectedTerminal,
		true,
	);
});

test("snapshot release refuses ok:true receipts that did not authorize deletion", (t) => {
	const root = mkdtempSync(join(tmpdir(), "fly2456-release-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const helper = book.match(/^snapshot_release\(\) \{[\s\S]*?^\}/m)?.[0];
	assert.ok(helper);
	for (const status of [
		"deleted",
		"already_absent",
		"owner_missing",
		"owner_mismatch",
		"not_authorized",
		"owner_changed",
	]) {
		const bin = join(root, status);
		mkdirSync(bin);
		writeFileSync(
			join(bin, "node"),
			`#!/bin/sh\nprintf '%s\\n' '{"ok":true,"status":"${status}"}'\n`,
			{ mode: 0o755 },
		);
		const r = spawnSync(
			bash,
			[
				"-c",
				`set -euo pipefail\n${helper}\nsnapshot_release "$EVIDENCE/receipt"`,
			],
			{
				encoding: "utf8",
				env: {
					...process.env,
					PATH: bin + ":" + process.env.PATH,
					EVIDENCE: root,
					OWNER_EXEC: "fixture-never-owned-2456",
					OWNER_BRIDGE: "fixture",
					TOOL_REPO: root,
				},
			},
		);
		assert.equal(
			r.status,
			["deleted", "already_absent"].includes(status) ? 0 : 1,
			status,
		);
	}
});

test("managed snapshot accepts canonical tmp owner directory and rejects another owner", (t) => {
	const root = mkdtempSync(join(tmpdir(), "fly2456-canonical-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const helper = book.match(/^managed_snapshot\(\) \{[\s\S]*?^\}/m)?.[0];
	assert.ok(helper);
	for (const [path, expected] of [
		["/tmp/flywheel-snapshots/fixture-owner/s.db", 0],
		[`${realpathSync("/tmp")}/flywheel-snapshots/fixture-owner/s.db`, 0],
		["/tmp/flywheel-snapshots/other/s.db", 1],
		["/tmp/flywheel-snapshots/fixture-owner/../other/s.db", 1],
	]) {
		const bin = join(root, "bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(
			join(bin, "node"),
			`#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ ok: true, path })}'\n`,
			{ mode: 0o755 },
		);
		const r = spawnSync(
			bash,
			[
				"-c",
				`set -euo pipefail\n${helper}\nstamp_file() { :; }\nmanaged_snapshot fixture teamlead '' "$EVIDENCE/receipt"`,
			],
			{
				encoding: "utf8",
				env: {
					...process.env,
					PATH: bin + ":" + process.env.PATH,
					EVIDENCE: root,
					OWNER_EXEC: "fixture-owner",
					OWNER_BRIDGE: "fixture",
					TOOL_REPO: root,
				},
			},
		);
		assert.equal(r.status, expected, path + ": " + r.stderr);
	}
});

test("owner preflight accepts only the explicitly supplied current workflow owner", (t) => {
	const root = mkdtempSync(join(tmpdir(), "fly2456-owner-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const helper = book.match(/^verify_snapshot_owner\(\) \{[\s\S]*?^\}/m)?.[0];
	assert.ok(helper);
	for (const [value, expected] of [
		[
			{ ok: true, owner: { kind: "workflow", executionId: "fixture-owner" } },
			0,
		],
		[{ ok: true, owner: { kind: "workflow", executionId: "different" } }, 1],
		[{ ok: true, owner: { kind: "runner", executionId: "fixture-owner" } }, 1],
		[{ ok: true, owner: { kind: "session", executionId: "fixture-owner" } }, 1],
		[
			{ ok: true, owner: { kind: "operator", executionId: "fixture-owner" } },
			1,
		],
		[{ ok: false, error: "snapshot owner not active" }, 1],
	]) {
		const r = spawnSync(
			bash,
			[
				"-c",
				`set -euo pipefail\n${helper}\ncurl() { printf '%s' "$RESPONSE"; }\nverify_snapshot_owner`,
			],
			{
				encoding: "utf8",
				env: {
					...process.env,
					RESPONSE: JSON.stringify(value),
					EVIDENCE: root,
					OWNER_EXEC: "fixture-owner",
					OWNER_BRIDGE: "http://fixture",
					TEAMLEAD_API_TOKEN: "fixture",
				},
			},
		);
		assert.equal(r.status, expected, r.stderr);
	}
});

test("body_context reads the Codex bound branch when branch is null (#8)", async (t) => {
	const { createRequire } = await import("node:module");
	const { createHash } = await import("node:crypto");
	const require = createRequire(
		new URL("../../packages/flywheel-comm/package.json", import.meta.url),
	);
	const Database = require("better-sqlite3");
	const root = mkdtempSync(join(tmpdir(), "fly2456-body-context-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const dbPath = join(root, "state.db"),
		manifestPath = join(root, "manifest.json");
	const db = new Database(dbPath);
	db.exec(
		"CREATE TABLE sessions(execution_id TEXT,issue_id TEXT,project_name TEXT,worktree_path TEXT,branch TEXT,worktree_binding_branch TEXT)",
	);
	db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?)").run(
		"exec",
		"FLY-1",
		"test-slot-4",
		root + "/body",
		null,
		"project-slot-4-FLY-1",
	);
	db.close();
	writeFileSync(
		dbPath + ".meta.json",
		JSON.stringify({
			observedAt: new Date().toISOString(),
			sha256: createHash("sha256").update(readFileSync(dbPath)).digest("hex"),
		}),
	);
	writeFileSync(
		manifestPath,
		JSON.stringify({
			config: { slot: 4 },
			steps: {
				"start-B1": {
					receipt: {
						result: {
							executionId: "exec",
							issueId: "FLY-1",
							workflowRunId: "run",
						},
					},
				},
			},
		}),
	);
	const section = book
		.split("body_context() {")[1]
		.split("capture_marker() {")[0];
	const code = section.match(/<<'JS'[^\n]*\n([\s\S]*?)\nJS/)[1];
	const result = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-",
			process.cwd(),
			dbPath,
			manifestPath,
			"start-B1",
			root,
		],
		{ input: code, encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	const context = JSON.parse(result.stdout);
	assert.equal(context.branch, "project-slot-4-FLY-1");
	assert.equal(context.branch_raw, null);
});

test("late residue managed snapshot refuses occupied tables and malformed databases (#9)", async (t) => {
	const { createRequire } = await import("node:module");
	const { createHash } = await import("node:crypto");
	const require = createRequire(
		new URL("../../packages/flywheel-comm/package.json", import.meta.url),
	);
	const Database = require("better-sqlite3");
	const root = mkdtempSync(join(tmpdir(), "fly2456-residue-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const section = book.split("late_residue_guard() {")[1];
	assert.ok(section, "late residue guard must inspect a managed snapshot");
	const code = section.match(/<<'JS'[^\n]*\n([\s\S]*?)\nJS/)[1];
	const path = join(root, "comm.db"),
		out = join(root, "inspection.json");
	const db = new Database(path);
	db.exec(
		"CREATE TABLE sessions(execution_id TEXT);CREATE TABLE mailbox_migration_meta(version TEXT);INSERT INTO mailbox_migration_meta VALUES('v1')",
	);
	db.close();
	function inspect() {
		writeFileSync(
			path + ".meta.json",
			JSON.stringify({
				observedAt: new Date().toISOString(),
				sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
			}),
		);
		return spawnSync(
			process.execPath,
			["--input-type=module", "-", process.cwd(), path, out],
			{ input: code, encoding: "utf8" },
		);
	}
	assert.equal(inspect().status, 0);
	const occupied = new Database(path);
	occupied.exec("INSERT INTO sessions VALUES('live')");
	occupied.close();
	assert.notEqual(inspect().status, 0);
	writeFileSync(path, "invalid sqlite");
	assert.notEqual(inspect().status, 0);
});
