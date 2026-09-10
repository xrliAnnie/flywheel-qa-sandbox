import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runnerWindows } from "../lib/qa-fly-2456-runner-windows.mjs";

const require = createRequire(
	new URL("../../packages/flywheel-comm/package.json", import.meta.url),
);
const Database = require("better-sqlite3");
function fixture(
	t,
	{
		before = 1,
		after = 0,
		event = "session_completed",
		ts = "2026-09-09 10:01:00",
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "fly2456-windows-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const f = {
		beforePath: join(dir, "before"),
		afterPath: join(dir, "after"),
		beforeIdentityPath: join(dir, "before-identity"),
		afterIdentityPath: join(dir, "after-identity"),
		dbPath: join(dir, "snapshot.db"),
		window: { from: "2026-09-09T10:00:00Z", to: "2026-09-09T10:02:00Z" },
	};
	writeFileSync(f.beforePath, `${before}\n`);
	writeFileSync(f.afterPath, `${after}\n`);
	const entry = {
		executionId: "prod",
		socketPath: "/tmp/prod.sock",
		windowIdentity: "runner-flywheel|@1|implement",
	};
	for (const [path, count, observedAt] of [
		[f.beforeIdentityPath, before, "2026-09-09T09:59:00Z"],
		[f.afterIdentityPath, after, "2026-09-09T10:03:00Z"],
	])
		writeFileSync(
			path,
			JSON.stringify({
				status: "pass",
				metadata: { observedAt, sha256: "a".repeat(64) },
				entries: count ? [entry] : [],
			}),
		);
	const db = new Database(f.dbPath);
	const source = readFileSync(
		new URL("../../packages/teamlead/src/StateStore.ts", import.meta.url),
		"utf8",
	);
	for (const table of ["sessions", "session_events"])
		db.exec(
			source.match(
				new RegExp(
					`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\t\\t\\t\\)`,
				),
			)[0],
		);
	db.prepare(
		"INSERT INTO sessions(execution_id,issue_id,project_name,status,terminal_at) VALUES(?,?,?,?,?)",
	).run(
		"prod",
		"FLY-1",
		"flywheel",
		event === "session_started" ? "running" : "completed",
		ts,
	);
	db.prepare(
		"INSERT INTO session_events(event_id,execution_id,issue_id,project_name,event_type,ts,source) VALUES(?,?,?,?,?,?,?)",
	).run("event", "prod", "FLY-1", "flywheel", event, ts, "test");
	db.close();
	writeFileSync(
		`${f.dbPath}.meta.json`,
		JSON.stringify({
			observedAt: "2026-09-09T10:03:00Z",
			sha256: createHash("sha256").update(readFileSync(f.dbPath)).digest("hex"),
		}),
	);
	return f;
}
test("equal counts pass without production explanation", (t) => {
	assert.equal(
		runnerWindows(fixture(t, { before: 1, after: 1 })).status,
		"pass",
	);
});
test("removed and added windows require matching production events", (t) => {
	assert.equal(runnerWindows(fixture(t)).status, "pass");
	assert.equal(
		runnerWindows(fixture(t, { before: 0, after: 1, event: "session_started" }))
			.status,
		"pass",
	);
	assert.equal(
		runnerWindows(fixture(t, { event: "heartbeat" })).status,
		"fail",
	);
});
test("out of window events and mismatched sidecar counts fail", (t) => {
	assert.equal(
		runnerWindows(fixture(t, { ts: "2026-09-09 09:00:00" })).status,
		"fail",
	);
	const f = fixture(t);
	writeFileSync(f.beforePath, "2\n");
	assert.equal(runnerWindows(f).status, "fail");
});
test("count inputs must be complete nonnegative integers", (t) => {
	const f = fixture(t);
	for (const s of ["", "-1", "1x", "1\n2"]) {
		writeFileSync(f.beforePath, s);
		assert.equal(runnerWindows(f).status, "fail");
	}
});
test("views cannot impersonate production tables", (t) => {
	const f = fixture(t),
		db = new Database(f.dbPath);
	db.exec(
		"ALTER TABLE sessions RENAME TO shadow_sessions; CREATE VIEW sessions AS SELECT * FROM shadow_sessions; ALTER TABLE session_events RENAME TO shadow_events; CREATE VIEW session_events AS SELECT * FROM shadow_events",
	);
	db.close();
	const meta = JSON.parse(readFileSync(`${f.dbPath}.meta.json`));
	meta.sha256 = createHash("sha256")
		.update(readFileSync(f.dbPath))
		.digest("hex");
	writeFileSync(`${f.dbPath}.meta.json`, JSON.stringify(meta));
	assert.equal(runnerWindows(f).status, "fail");
});

test("released production projection preserves window explanation and negative event guards", async (t) => {
	const { deriveEvidence } = await import("../lib/qa-fly-2456-evidence.mjs");
	for (const event of ["session_completed", "unrelated"]) {
		const f = fixture(t, { event }),
			expected = runnerWindows(f),
			path = f.dbPath + ".evidence.json";
		deriveEvidence(f.dbPath, path, "production");
		rmSync(f.dbPath);
		rmSync(f.dbPath + ".meta.json");
		assert.deepEqual(runnerWindows({ ...f, dbPath: path }), expected);
		assert.equal(
			expected.status,
			event === "session_completed" ? "pass" : "fail",
		);
	}
});
