import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAILBOX_SCHEMA } from "../../packages/flywheel-comm/src/mailbox-schema.ts";
import { deriveEvidence } from "../lib/qa-fly-2456-evidence.mjs";
import { commScan, prodStatestoreCheck } from "../lib/qa-fly-2456-scan.mjs";

const require = createRequire(
	new URL("../../packages/flywheel-comm/package.json", import.meta.url),
);
const Database = require("better-sqlite3");
const opts = {
	slot: 3,
	executions: ["exec_%literal"],
	lead: "flywheel-test-3",
};
test("delta rejects incomplete or duplicated hit identity proofs", async () => {
	const { scanDelta } = await import("../lib/qa-fly-2456-scan.mjs");
	const proof = {
		status: "fail",
		hitCount: 2,
		hitRows: [
			{ table: "a", rowid: 1, column: "c" },
			{ table: "b", rowid: 1, column: "c" },
		],
		hits: [
			{ table: "a", column: "c", count: 1 },
			{ table: "a", column: "c", count: 1 },
		],
	};
	assert.equal(scanDelta(proof, proof).status, "fail");
	assert.equal(
		scanDelta(
			{ status: "pass", hitCount: 0, hits: [] },
			{ status: "pass", hitCount: 0, hits: [] },
		).status,
		"fail",
	);
});
test("comm hit identities preserve original rowid through filtered evidence", (t) => {
	const source = fixture(t, (db) => {
		db.exec(
			"INSERT INTO sessions VALUES('clean'),('test-slot-3'),('clean again'),('test-slot-3')",
		);
	});
	const output = source + ".evidence.json";
	deriveEvidence(source, output, "comm", opts);
	const expected = [2, 4].map((rowid) => ({
		table: "sessions",
		rowid,
		column: "execution_id",
	}));
	assert.deepEqual(commScan(source, opts).hitRows, expected);
	assert.deepEqual(commScan(output, opts).hitRows, expected);
});
for (const kind of ["comm", "production"]) {
	test(`${kind} baseline subtraction detects a new identity despite equal counts`, async (t) => {
		const { scanDelta } = await import("../lib/qa-fly-2456-scan.mjs");
		const source = fixture(
			t,
			(db) => {
				if (kind === "comm")
					db.prepare("INSERT INTO sessions VALUES(?)").run(opts.executions[0]);
				else
					db.prepare(
						"INSERT INTO session_events(id,event_id,execution_id,issue_id,project_name,event_type,source) VALUES(10,'event',?,'i','p','event','bridge.codex-session-reown')",
					).run(opts.executions[0]);
			},
			kind === "production",
		);
		const scan = kind === "comm" ? commScan : prodStatestoreCheck;
		const before = scan(source, opts);
		assert.equal(before.hitRows.length, 1);
		assert.equal(scanDelta(before, before).status, "pass");
		assert.equal(scanDelta(before, before).baselineHitCount, 1);
		assert.equal(scanDelta(before, before).newHitCount, 0);
		const db = new Database(source);
		if (kind === "comm") db.exec("UPDATE sessions SET rowid=20");
		else db.exec("UPDATE session_events SET id=20");
		db.close();
		stamp(source);
		const output = source + ".evidence.json";
		deriveEvidence(source, output, kind, opts);
		const after = scan(output, opts);
		assert.deepEqual(after, scan(source, opts));
		assert.equal(after.hitCount, before.hitCount);
		const delta = scanDelta(before, after);
		assert.equal(delta.status, "fail");
		assert.equal(delta.newHitCount, 1);
		assert.equal(delta.added[0].rowid, 20);
	});
}
test("comm projection bounds 20000 unmarked 2KB rows below 1MB", (t) => {
	const source = fixture(t, (db) => {
		db.exec("CREATE TABLE archive_payload(content TEXT)");
		const insert = db.prepare("INSERT INTO archive_payload VALUES(?)");
		db.transaction(() => {
			for (let i = 0; i < 20000; i++) insert.run("x".repeat(2048));
		})();
	});
	const output = source + ".evidence.json";
	deriveEvidence(source, output, "comm", opts);
	const size = readFileSync(output).length;
	assert.ok(size < 1000000, `projection was ${size} bytes`);
	assert.equal(commScan(output, opts).status, "pass");
	assert.equal(commScan(output, opts).hitCount, 0);
});
test("documented derive helper forwards comm marker arguments to real projection", (t) => {
	const source = fixture(t, (db) =>
		db.prepare("INSERT INTO sessions VALUES(?)").run("prefix\0exec_%literal"),
	);
	const book = readFileSync(
		new URL(
			"../../engineering/doc/FLY-2456-bridge-restart-drill/host-runbook.md",
			import.meta.url,
		),
		"utf8",
	);
	const helper = book.match(/^derive_evidence\(\) \{[\s\S]*?^\}/m)[0];
	const output = source + ".evidence.json";
	const run = spawnSync(
		"bash",
		[
			"-c",
			`${helper}\nderive_evidence "$SOURCE" "$OUTPUT" comm --slot 3 --lead flywheel-test-3 --exec 'exec_%literal'`,
		],
		{
			encoding: "utf8",
			env: {
				...process.env,
				TOOL_REPO: process.cwd(),
				SOURCE: source,
				OUTPUT: output,
			},
		},
	);
	assert.equal(run.status, 0, run.stderr);
	assert.equal(JSON.parse(run.stdout).status, "pass");
	assert.deepEqual(commScan(output, opts), commScan(source, opts));
	assert.equal(commScan(output, opts).hitCount, 1);
});
test("comm projection retains exact marker hits and full schema", (t) => {
	const source = fixture(t, (db) => {
		db.exec(
			"CREATE TABLE archive_payload(id INTEGER, content JSON, other TEXT)",
		);
		db.prepare("INSERT INTO sessions VALUES(?)").run(
			"prefix exec_%literal suffix",
		);
		db.prepare("INSERT INTO three_stage_turn VALUES(?)").run("test-slot-3");
		db.prepare("INSERT INTO archive_payload VALUES(1,?,?)").run(
			"flywheel-test-3",
			"exec_%literal",
		);
		db.prepare("INSERT INTO archive_payload VALUES(2,?,?)").run(
			"exec-XXliteral",
			"clean",
		);
	});
	const output = source + ".evidence.json";
	deriveEvidence(source, output, "comm", opts);
	assert.deepEqual(commScan(output, opts), commScan(source, opts));
	const value = JSON.parse(readFileSync(output));
	assert.equal(
		value.tables.reduce((n, table) => n + table.rows.length, 0),
		3,
	);
	assert.deepEqual(
		value.tables
			.find((table) => table.name === "archive_payload")
			.schemaColumns.map((c) => [c.name, c.type]),
		[
			["id", "INTEGER"],
			["content", "JSON"],
			["other", "TEXT"],
		],
	);
});
test("comm table fingerprints cover unprojected content deterministically", (t) => {
	const source = fixture(t, (db) => {
		db.prepare("INSERT INTO sessions VALUES(?)").run("unmarked original");
	});
	const fingerprint = (suffix) => {
		const output = source + suffix + ".evidence.json";
		deriveEvidence(source, output, "comm", opts);
		return JSON.parse(readFileSync(output)).tables.map(
			({ name, rowCount, sha256 }) => ({ name, rowCount, sha256 }),
		);
	};
	const first = fingerprint("first");
	assert.deepEqual(fingerprint("same"), first);
	assert.equal(first.find((table) => table.name === "sessions").rowCount, 1);
	for (const table of first) assert.match(table.sha256, /^[a-f0-9]{64}$/);
	const db = new Database(source);
	db.exec("UPDATE sessions SET execution_id='unmarked changed'");
	db.close();
	stamp(source);
	const changed = fingerprint("changed");
	assert.notEqual(
		changed.find((table) => table.name === "sessions").sha256,
		first.find((table) => table.name === "sessions").sha256,
	);
	assert.deepEqual(
		changed.filter((table) => table.name !== "sessions"),
		first.filter((table) => table.name !== "sessions"),
	);
});
function stamp(path) {
	writeFileSync(
		`${path}.meta.json`,
		JSON.stringify({
			observedAt: "2026-09-09T00:00:00Z",
			sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
		}),
	);
}
function fixture(t, change = () => {}, prod = false) {
	const dir = mkdtempSync(join(tmpdir(), "fly2456-scan-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "snapshot.db");
	const db = new Database(path);
	if (prod) {
		const source = readFileSync(
			new URL("../../packages/teamlead/src/StateStore.ts", import.meta.url),
			"utf8",
		);
		for (const name of ["sessions", "session_events"])
			db.exec(
				source.match(
					new RegExp(
						`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\t\\t\\t\\)`,
					),
				)[0],
			);
	} else
		db.exec(
			`${MAILBOX_SCHEMA}; CREATE TABLE sessions(execution_id TEXT); CREATE TABLE three_stage_turn(holder_exec_id TEXT); CREATE TABLE runner_workflow_activation(execution_id TEXT);`,
		);
	change(db);
	db.close();
	stamp(path);
	return path;
}
test("clean current mailbox schema passes without querying poison views", (t) => {
	const result = commScan(fixture(t), opts);
	assert.equal(result.status, "pass");
	assert.equal(result.hitCount, 0);
	assert.ok(result.scannedColumns > 0);
});
for (const marker of ["test-slot-3", "exec_%literal", "flywheel-test-3"])
	test(`mailbox detects literal marker ${marker} without leaking content`, (t) => {
		const path = fixture(t, (db) => {
			db.exec(
				"INSERT INTO mailbox_identity(id,delivery_id,insert_projection_hash) VALUES('i','d','hash')",
			);
			db.prepare(
				"INSERT INTO mailbox(id,delivery_id,from_agent,to_agent,recipient_kind,type,content,created_at) VALUES('i','d','a','b','lead','report',?,'now')",
			).run(`secret-value ${marker}`);
		});
		const result = commScan(path, opts);
		assert.equal(result.status, "fail");
		assert.ok(result.hitCount > 0);
		assert.ok(!JSON.stringify(result).includes("secret-value"));
	});
for (const [table, column] of [
	["sessions", "execution_id"],
	["three_stage_turn", "holder_exec_id"],
	["runner_workflow_activation", "execution_id"],
])
	test(`${table} contamination detected`, (t) => {
		const result = commScan(
			fixture(t, (db) =>
				db.prepare(`INSERT INTO ${table} VALUES(?)`).run("exec_%literal"),
			),
			opts,
		);
		assert.equal(result.status, "fail");
		assert.ok(
			result.hits.some((hit) => hit.table === table && hit.column === column),
		);
	});
test("LIKE wildcards in execution markers are literal", (t) => {
	const path = fixture(t, (db) =>
		db.exec("INSERT INTO sessions VALUES('exec-XXliteral')"),
	);
	assert.equal(commScan(path, opts).status, "pass");
});
for (const mutation of [
	"DROP TABLE sessions",
	"DROP TABLE sessions; CREATE TABLE sessions(other TEXT)",
	"DROP VIEW messages; CREATE TABLE messages(id TEXT)",
	"DROP VIEW mailbox_message_projection",
])
	test(`schema fails closed: ${mutation}`, (t) => {
		const result = commScan(
			fixture(t, (db) => db.exec(mutation)),
			opts,
		);
		assert.equal(result.status, "fail");
		assert.equal(result.reason, "schema_invalid");
	});
test("empty database fails closed", (t) => {
	const path = fixture(t);
	const db = new Database(path);
	db.close();
	writeFileSync(path, "");
	stamp(path);
	assert.equal(commScan(path, opts).status, "fail");
});
test("missing snapshot or metadata and changed bytes fail closed", (t) => {
	const path = fixture(t);
	rmSync(`${path}.meta.json`);
	assert.equal(commScan(path, opts).status, "fail");
	stamp(path);
	writeFileSync(path, "corrupt");
	assert.equal(commScan(path, opts).status, "fail");
	rmSync(path);
	assert.equal(commScan(path, opts).status, "fail");
	assert.equal(
		readFileSync(`${path}.meta.json`, "utf8").includes("sha256"),
		true,
	);
});
test("production StateStore clean actual schema passes", (t) => {
	assert.equal(
		prodStatestoreCheck(fixture(t, undefined, true), opts).status,
		"pass",
	);
});
test("production sessions matching execution fails", (t) => {
	const path = fixture(
		t,
		(db) =>
			db
				.prepare(
					"INSERT INTO sessions(execution_id,issue_id,project_name) VALUES(?,'i','p')",
				)
				.run(opts.executions[0]),
		true,
	);
	const result = prodStatestoreCheck(path, opts);
	assert.equal(result.status, "fail");
	assert.equal(result.hitCount, 1);
});
for (const source of ["bridge.codex-session-reown", "other"])
	test(`production events only detect reown source: ${source}`, (t) => {
		const path = fixture(
			t,
			(db) =>
				db
					.prepare(
						"INSERT INTO session_events(event_id,execution_id,issue_id,project_name,event_type,source) VALUES('e',?,'i','p','event',?)",
					)
					.run(opts.executions[0], source),
			true,
		);
		const result = prodStatestoreCheck(path, opts);
		assert.equal(result.status, source === "other" ? "pass" : "fail");
		assert.equal(result.hitCount, source === "other" ? 0 : 1);
	});
for (const table of ["sessions", "session_events"])
	test(`production missing ${table} fails`, (t) => {
		assert.equal(
			prodStatestoreCheck(
				fixture(t, (db) => db.exec(`DROP TABLE ${table}`), true),
				opts,
			).reason,
			"schema_invalid",
		);
	});
for (const slot of ["", 0, "3.0", -1])
	test(`reject noncanonical slot ${JSON.stringify(slot)}`, (t) => {
		assert.equal(commScan(fixture(t), { ...opts, slot }).status, "fail");
	});
test("snapshot evidence errors never claim zero contamination", (t) => {
	const path = fixture(t);
	rmSync(`${path}.meta.json`);
	assert.equal(commScan(path, opts).hitCount, null);
});
for (const suffix of ["-wal", "-shm"])
	test(`reject snapshot with ${suffix} sidecar`, (t) => {
		const path = fixture(t);
		writeFileSync(`${path}${suffix}`, "pending bytes");
		assert.equal(commScan(path, opts).status, "fail");
	});
for (const [kind, value] of [
	["blob", Buffer.from("test-slot-3")],
	["nul", "prefix\0test-slot-3"],
]) {
	test(`comm handles ${kind} storage in scanned text columns`, (t) => {
		const path = fixture(t, (db) =>
			db.prepare("INSERT INTO sessions VALUES(?)").run(value),
		);
		const result = commScan(path, opts);
		assert.equal(result.status, "fail");
		assert.equal(
			result.reason,
			kind === "blob" ? "text_storage_invalid" : undefined,
		);
		assert.equal(result.hitCount, kind === "blob" ? null : 1);
	});
	for (const [table, column] of [
		["sessions", "execution_id"],
		["session_events", "execution_id"],
		["session_events", "source"],
	])
		test(`production rejects ${kind} in ${table}.${column}`, (t) => {
			const path = fixture(
				t,
				(db) => {
					if (table === "sessions")
						db.prepare(
							"INSERT INTO sessions(execution_id,issue_id,project_name) VALUES(?,'i','p')",
						).run(value);
					else
						db.prepare(
							"INSERT INTO session_events(event_id,execution_id,issue_id,project_name,event_type,source) VALUES('e',?,'i','p','event',?)",
						).run(
							column === "execution_id" ? value : opts.executions[0],
							column === "source" ? value : "bridge.codex-session-reown",
						);
				},
				true,
			);
			const result = prodStatestoreCheck(path, opts);
			assert.equal(result.status, "fail");
			assert.equal(result.reason, "text_storage_invalid");
			assert.equal(result.hitCount, null);
		});
}

for (const kind of ["comm", "production"]) {
	test(`derived ${kind} evidence preserves scans after managed source release`, async (t) => {
		const { deriveEvidence, openEvidence } = await import(
			"../lib/qa-fly-2456-evidence.mjs"
		);
		const source = fixture(
			t,
			(db) => {
				db.exec("CREATE TABLE irrelevant_payload(payload BLOB)");
				db.prepare(
					"INSERT INTO sessions(execution_id" +
						(kind === "production" ? ",issue_id,project_name,status" : "") +
						") VALUES(?" +
						(kind === "production" ? ",'i','p','running'" : "") +
						")",
				).run(opts.executions[0]);
			},
			kind === "production",
		);
		const scan = kind === "comm" ? commScan : prodStatestoreCheck;
		const expected = scan(source, opts);
		const output = source + ".evidence.json";
		deriveEvidence(source, output, kind, opts);
		openEvidence(output, kind).db.close();
		rmSync(source);
		rmSync(source + ".meta.json");
		assert.deepEqual(scan(output, opts), expected);
		assert.throws(() => deriveEvidence(source, output, kind));
		writeFileSync(
			output,
			readFileSync(output, "utf8").replace("exec_%literal", "clean"),
		);
		assert.equal(scan(output, opts).status, "fail");
		assert.equal(scan(output, opts).hitCount, null);
	});
}

test("comm projection preserves NUL text matching and rejects BLOB", (t) => {
	for (const value of ["abc\0test-slot-3", "statekey\0legitimate"]) {
		const source = fixture(t, (db) =>
			db.prepare("INSERT INTO sessions VALUES(?)").run(value),
		);
		const output = source + ".evidence.json";
		deriveEvidence(source, output, "comm", opts);
		const result = commScan(output, opts);
		assert.deepEqual(result, commScan(source, opts));
		assert.equal(result.hitCount, value.includes("test-slot-3") ? 1 : 0);
		assert.equal(
			result.status,
			value.includes("test-slot-3") ? "fail" : "pass",
		);
	}
	const source = fixture(t, (db) =>
		db.prepare("INSERT INTO sessions VALUES(?)").run(Buffer.from("unmarked")),
	);
	assert.throws(
		() => deriveEvidence(source, source + ".evidence.json", "comm", opts),
		/text_storage_invalid/,
	);
	assert.equal(commScan(source, opts).reason, "text_storage_invalid");
});
