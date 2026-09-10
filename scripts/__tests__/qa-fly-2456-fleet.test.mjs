import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fleetDiff, fleetIdentity } from "../lib/qa-fly-2456-fleet.mjs";

const require = createRequire(
	new URL("../../packages/flywheel-comm/package.json", import.meta.url),
);
const Database = require("better-sqlite3");
const socketRoot = "/synthetic/prod/cdx-sock";
const socket = `${socketRoot}/${createHash("sha1").update("exec-prod").digest("hex").slice(0, 16)}.sock`;
const windowIdentity = "runner|@7|codex";
const decoy = "main|@8|fly2454-decoy";
function setup(t, change = () => {}) {
	const dir = mkdtempSync(join(tmpdir(), "fly2456-fleet-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const dbPath = join(dir, "snapshot.db");
	const db = new Database(dbPath);
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
	db.exec(
		"INSERT INTO sessions(execution_id,issue_id,project_name,status,tmux_session) VALUES('exec-prod','i','p','running','runner')",
	);
	change(db);
	db.close();
	writeFileSync(
		`${dbPath}.meta.json`,
		JSON.stringify({
			observedAt: "2026-09-09T00:30:00Z",
			sha256: createHash("sha256").update(readFileSync(dbPath)).digest("hex"),
		}),
	);
	const file = (name, content) => {
		const path = join(dir, name);
		writeFileSync(path, content);
		return path;
	};
	const tmuxInventoryPath = file(
		"inventory.txt",
		`exec-prod|${windowIdentity}\n|${decoy}\n`,
	);
	return { dbPath, tmuxInventoryPath, prodSocketRoot: socketRoot, file };
}
function snapshot(sockets = [socket], windows = [windowIdentity, decoy]) {
	return `[codex-app-servers]\n${sockets.map((s) => s + "\n").join("")}[tmux-windows]\n${windows.map((w) => w + "\n").join("")}`;
}
function diffFixture(t, { after = snapshot(), change } = {}) {
	const ctx = setup(t, change);
	const before = setup(t);
	const beforeMeta = JSON.parse(
		readFileSync(`${before.dbPath}.meta.json`, "utf8"),
	);
	beforeMeta.observedAt = "2026-09-08T23:59:00Z";
	writeFileSync(`${before.dbPath}.meta.json`, JSON.stringify(beforeMeta));
	const identity = fleetIdentity(before);
	return {
		...ctx,
		beforePath: ctx.file("before.txt", snapshot()),
		afterPath: ctx.file("after.txt", after),
		sidecarPath: ctx.file("identity.json", JSON.stringify(identity)),
		killLedgerPaths: [ctx.file("ledger.ndjson", "")],
		window: { from: "2026-09-09T00:00:00Z", to: "2026-09-09T00:20:00Z" },
		mode: "post-teardown",
	};
}
test("identity resolves explicit production socket root and exact live window", (t) => {
	const result = fleetIdentity(setup(t));
	assert.equal(result.status, "pass");
	assert.deepEqual(result.entries, [
		{ executionId: "exec-prod", socketPath: socket, windowIdentity },
	]);
});
for (const content of [
	`exec-prod|${windowIdentity}\nexec-prod|runner|@9|other\n`,
	`unknown|${windowIdentity}\n`,
	"exec-prod|runner|bad|codex\n",
	`exec-prod|wrong|@7|codex\n`,
])
	test(`identity rejects ambiguous or invalid inventory ${JSON.stringify(content)}`, (t) => {
		const ctx = setup(t);
		writeFileSync(ctx.tmuxInventoryPath, content);
		assert.equal(fleetIdentity(ctx).status, "fail");
	});
test("identity refuses implicit or relative socket root", (t) => {
	assert.equal(
		fleetIdentity({ ...setup(t), prodSocketRoot: "relative" }).status,
		"fail",
	);
});
test("missing production schema fails closed", (t) => {
	assert.equal(
		fleetIdentity(setup(t, (db) => db.exec("DROP TABLE sessions"))).status,
		"fail",
	);
});
test("unchanged post-teardown fleet passes", (t) => {
	assert.equal(fleetDiff(diffFixture(t)).status, "pass");
});
test("live allows only declared socket addition", (t) => {
	const ctx = diffFixture(t, {
		after: snapshot([socket, "/synthetic/slot.sock"]),
	});
	assert.equal(
		fleetDiff({
			...ctx,
			mode: "live",
			declaredSockets: ["/synthetic/slot.sock"],
		}).status,
		"pass",
	);
});
for (const after of [
	snapshot([socket, "/unknown.sock"]),
	snapshot([]),
	snapshot([socket], [decoy]),
	snapshot([socket], [windowIdentity]),
	snapshot([socket], [windowIdentity, decoy, "main|@9|extra"]),
])
	test(`live rejects unapproved fleet change ${JSON.stringify(after)}`, (t) => {
		assert.equal(
			fleetDiff({ ...diffFixture(t, { after }), mode: "live" }).status,
			"fail",
		);
	});
test("post-teardown addition fails even when declared", (t) => {
	const ctx = diffFixture(t, { after: snapshot([socket, "/slot.sock"]) });
	assert.equal(
		fleetDiff({ ...ctx, declaredSockets: ["/slot.sock"] }).status,
		"fail",
	);
});
test("removed uniquely mapped terminal production execution needs attribution", (t) => {
	const ctx = diffFixture(t, {
		after: snapshot([], [decoy]),
		change: (db) =>
			db.exec(
				"UPDATE sessions SET status='completed',terminal_at='2026-09-09T00:10:00Z'",
			),
	});
	const result = fleetDiff(ctx);
	assert.equal(result.status, "needs-attribution");
	assert.equal(result.attributions.length, 2);
	assert.ok(result.attributions.every((x) => x.executionId === "exec-prod"));
});
test("terminal event within window can support attribution", (t) => {
	const ctx = diffFixture(t, {
		after: snapshot([], [decoy]),
		change: (db) =>
			db.exec(
				"INSERT INTO session_events(event_id,ts,execution_id,issue_id,project_name,event_type,source,payload) VALUES('end','2026-09-09T00:10:00Z','exec-prod','i','p','session_completed','session','{}')",
			),
	});
	assert.equal(fleetDiff(ctx).status, "needs-attribution");
});
for (const change of [
	() => {},
	(db) =>
		db.exec(
			"UPDATE sessions SET status='completed',terminal_at='2026-09-08T00:10:00Z'",
		),
	(db) => db.exec("UPDATE sessions SET terminal_at='2026-09-09T00:10:00Z'"),
])
	test("unproven in-window terminal prevents attribution", (t) => {
		assert.equal(
			fleetDiff(diffFixture(t, { after: snapshot([], [decoy]), change }))
				.status,
			"fail",
		);
	});
test("duplicate sidecar mapping fails closed", (t) => {
	const ctx = diffFixture(t, {
		after: snapshot([], [decoy]),
		change: (db) =>
			db.exec(
				"UPDATE sessions SET status='completed',terminal_at='2026-09-09T00:10:00Z'",
			),
	});
	const sidecar = JSON.parse(readFileSync(ctx.sidecarPath));
	sidecar.entries.push({ ...sidecar.entries[0], executionId: "other" });
	writeFileSync(ctx.sidecarPath, JSON.stringify(sidecar));
	assert.equal(fleetDiff(ctx).status, "fail");
});
for (const target of [
	{ targetKind: "tmux-window", target: "runner:@7" },
	{ targetKind: "pid", target: 200, execId: "exec-prod" },
	{ targetKind: "pid", target: 201 },
])
	test(`kill ledger target prevents attribution ${JSON.stringify(target)}`, (t) => {
		const ctx = diffFixture(t, {
			after: snapshot([], [decoy]),
			change: (db) =>
				db.exec(
					"UPDATE sessions SET status='completed',terminal_at='2026-09-09T00:10:00Z'",
				),
		});
		writeFileSync(
			ctx.killLedgerPaths[0],
			JSON.stringify({
				schemaVersion: 1,
				ts: "2026-09-09T00:10:00Z",
				source: "test",
				signal: "TERM",
				reason: "test",
				...target,
			}) + "\n",
		);
		assert.equal(fleetDiff(ctx).status, "fail");
	});
for (const malformed of [
	"[tmux-windows]\n" + decoy + "\n",
	"[codex-app-servers]\n/one.sock\n[tmux-windows]\n" +
		decoy +
		"\n" +
		decoy +
		"\n",
	"bad",
])
	test("malformed snapshots fail closed", (t) => {
		assert.equal(
			fleetDiff(diffFixture(t, { after: malformed })).status,
			"fail",
		);
	});
test("missing ledger evidence prevents attribution", (t) => {
	const ctx = diffFixture(t, {
		after: snapshot([], [decoy]),
		change: (db) =>
			db.exec(
				"UPDATE sessions SET status='completed',terminal_at='2026-09-09T00:10:00Z'",
			),
	});
	assert.equal(fleetDiff({ ...ctx, killLedgerPaths: [] }).status, "fail");
});
test("unsupported terminal event name is not attribution evidence", (t) => {
	const ctx = diffFixture(t, {
		after: snapshot([], [decoy]),
		change: (db) =>
			db.exec(
				"INSERT INTO session_events(event_id,ts,execution_id,issue_id,project_name,event_type,source,payload) VALUES('end','2026-09-09T00:10:00Z','exec-prod','i','p','session_cancelled','session','{}')",
			),
	});
	assert.equal(fleetDiff(ctx).status, "fail");
});
test("sidecar duplicate execution identity fails despite unique removed-row match", (t) => {
	const ctx = diffFixture(t, {
		after: snapshot([], [decoy]),
		change: (db) =>
			db.exec(
				"UPDATE sessions SET status='completed',terminal_at='2026-09-09T00:10:00Z'",
			),
	});
	const sidecar = JSON.parse(readFileSync(ctx.sidecarPath));
	sidecar.entries.push({
		executionId: "exec-prod",
		socketPath: "/another.sock",
		windowIdentity: null,
	});
	writeFileSync(ctx.sidecarPath, JSON.stringify(sidecar));
	assert.equal(fleetDiff(ctx).status, "fail");
});
test("unrelated fully attributed ledger rows permit needs-attribution", (t) => {
	const ctx = diffFixture(t, {
		after: snapshot([], [decoy]),
		change: (db) =>
			db.exec(
				"UPDATE sessions SET status='completed',terminal_at='2026-09-09T00:10:00Z'",
			),
	});
	writeFileSync(
		ctx.killLedgerPaths[0],
		JSON.stringify({
			schemaVersion: 1,
			ts: "2026-09-09T00:10:00Z",
			source: "test",
			signal: "TERM",
			reason: "test",
			targetKind: "pid",
			target: 200,
			execId: "unrelated-slot",
		}) + "\n",
	);
	assert.equal(fleetDiff(ctx).status, "needs-attribution");
});
test("sidecar missing provenance fails closed", (t) => {
	const ctx = diffFixture(t, {
		after: snapshot([], [decoy]),
		change: (db) =>
			db.exec(
				"UPDATE sessions SET status='completed',terminal_at='2026-09-09T00:10:00Z'",
			),
	});
	const sidecar = JSON.parse(readFileSync(ctx.sidecarPath));
	delete sidecar.metadata;
	writeFileSync(ctx.sidecarPath, JSON.stringify(sidecar));
	assert.equal(fleetDiff(ctx).status, "fail");
});
for (const status of ["running", "pending", "approved_to_ship"])
	test(`missing live window fails for nonterminal ${status}`, (t) => {
		const ctx = setup(t, (db) =>
			db.prepare("UPDATE sessions SET status=?").run(status),
		);
		writeFileSync(ctx.tmuxInventoryPath, `|${decoy}\n`);
		assert.equal(fleetIdentity(ctx).status, "fail");
	});
for (const status of [
	"completed",
	"terminated",
	"failed",
	"blocked",
	"timeout",
	"canceled",
	"cancelled",
	"rejected",
	"deferred",
	"shelved",
	"approved",
])
	test(`historical terminal ${status} may lack live window`, (t) => {
		const ctx = setup(t, (db) =>
			db.prepare("UPDATE sessions SET status=?").run(status),
		);
		writeFileSync(ctx.tmuxInventoryPath, `|${decoy}\n`);
		const result = fleetIdentity(ctx);
		assert.equal(result.status, "pass");
		assert.equal(result.entries[0].windowIdentity, null);
	});

for (const source of ["terminal_at", "session_events"])
	test(`SQLite UTC ${source} is independent of local timezone`, (t) => {
		const previous = process.env.TZ;
		process.env.TZ = "America/Los_Angeles";
		t.after(() => {
			if (previous === undefined) delete process.env.TZ;
			else process.env.TZ = previous;
		});
		const ctx = diffFixture(t, {
			after: snapshot([], [decoy]),
			change: (db) => {
				if (source === "terminal_at")
					db.exec(
						"UPDATE sessions SET status='completed',terminal_at='2026-09-09 00:10:00'",
					);
				else
					db.exec(
						"INSERT INTO session_events(event_id,ts,execution_id,issue_id,project_name,event_type,source,payload) VALUES('end','2026-09-09 00:10:00','exec-prod','i','p','session_completed','session','{}')",
					);
			},
		});
		assert.equal(fleetDiff(ctx).status, "needs-attribution");
	});
test("identity sidecar generated after attribution window cannot explain disappearance", (t) => {
	const ctx = diffFixture(t, {
		after: snapshot([], [decoy]),
		change: (db) =>
			db.exec(
				"UPDATE sessions SET status='completed',terminal_at='2026-09-09T00:10:00Z'",
			),
	});
	const sidecar = JSON.parse(readFileSync(ctx.sidecarPath));
	sidecar.metadata.observedAt = "2026-09-09T00:30:00Z";
	writeFileSync(ctx.sidecarPath, JSON.stringify(sidecar));
	assert.equal(fleetDiff(ctx).status, "fail");
});

test("released production projection preserves fleet identity and terminal attribution", async (t) => {
	const { deriveEvidence } = await import("../lib/qa-fly-2456-evidence.mjs");
	for (const terminal of [false, true]) {
		const ctx = diffFixture(t, {
			after: snapshot([], [decoy]),
			change: (db) => {
				if (terminal)
					db.exec(
						"UPDATE sessions SET status='completed',terminal_at='2026-09-09T00:10:00Z'",
					);
			},
		});
		const identity = fleetIdentity(ctx),
			expected = fleetDiff(ctx),
			path = ctx.dbPath + ".evidence.json";
		deriveEvidence(ctx.dbPath, path, "production");
		rmSync(ctx.dbPath);
		rmSync(ctx.dbPath + ".meta.json");
		assert.deepEqual(fleetIdentity({ ...ctx, dbPath: path }), identity);
		assert.deepEqual(fleetDiff({ ...ctx, dbPath: path }), expected);
		assert.equal(expected.status, terminal ? "needs-attribution" : "fail");
	}
});

test("identity collapses linked windows from sanitized live inventory", (t) => {
	const fixture = JSON.parse(
		readFileSync(
			new URL("./fixtures/qa-fly-2456-linked-inventory.json", import.meta.url),
			"utf8",
		),
	);
	const rows = fixture.inventory
		.trimEnd()
		.split("\n")
		.map((line) => line.split("|"));
	assert.equal(rows.length, fixture.rowCount);
	assert.equal(new Set(rows.map((row) => row[2])).size, fixture.windowCount);
	assert.ok(fixture.rowCount > fixture.windowCount);
	const expected = new Map();
	for (const [execution, session, id, name] of rows) {
		if (!execution) continue;
		const prior = expected.get(execution);
		if (
			!prior ||
			(prior[0].startsWith("cmux-") && !session.startsWith("cmux-"))
		)
			expected.set(execution, [session, id, name]);
	}
	const ctx = setup(t, (db) => {
		db.exec("DELETE FROM sessions");
		const insert = db.prepare(
			"INSERT INTO sessions(execution_id,issue_id,project_name,status,tmux_session) VALUES(?,'fixture','fixture','running',?)",
		);
		for (const [execution, [session]] of expected)
			insert.run(execution, session);
	});
	for (const inventory of [
		fixture.inventory,
		rows
			.toReversed()
			.map((row) => row.join("|"))
			.join("\n") + "\n",
	]) {
		writeFileSync(ctx.tmuxInventoryPath, inventory);
		const result = fleetIdentity(ctx);
		assert.equal(result.status, "pass");
		assert.equal(result.entries.length, expected.size);
		for (const entry of result.entries)
			assert.equal(
				entry.windowIdentity,
				expected.get(entry.executionId).join("|"),
			);
	}
});

for (const conflict of [
	"exec-prod|runner|@9|codex\n",
	"other-exec|cmux-codex|@7|codex\n",
	"exec-prod|cmux-codex|@7|different\n",
]) {
	test(`linked-window folding rejects conflicting identity ${JSON.stringify(conflict)}`, (t) => {
		const ctx = setup(t);
		writeFileSync(
			ctx.tmuxInventoryPath,
			`exec-prod|cmux-codex|@7|codex\nexec-prod|runner|@7|codex\n${conflict}`,
		);
		assert.equal(fleetIdentity(ctx).status, "fail");
	});
}

function capturedFleetWindows() {
	const fixture = JSON.parse(
		readFileSync(
			new URL("./fixtures/qa-fly-2456-linked-inventory.json", import.meta.url),
			"utf8",
		),
	);
	return fixture.inventory
		.trimEnd()
		.split("\n")
		.map((line) => line.split("|").slice(1).join("|"));
}
test("live diff accepts unchanged real linked inventory and linked decoy", (t) => {
	const windows = [
		...capturedFleetWindows(),
		"main|@9008|fly2454-decoy",
		"cmux-decoy|@9008|fly2454-decoy",
	];
	const ctx = diffFixture(t);
	writeFileSync(ctx.beforePath, snapshot([], windows));
	writeFileSync(ctx.afterPath, snapshot([], windows.toReversed()));
	assert.deepEqual(fleetDiff({ ...ctx, mode: "live" }), {
		status: "pass",
		added: [],
		removed: [],
	});
});
test("post-teardown attributes one removed linked window from the real inventory", (t) => {
	const target = "runner|@9007|codex";
	const windows = [...capturedFleetWindows(), "main|@9008|fly2454-decoy"];
	const ctx = diffFixture(t, {
		change: (db) =>
			db.exec(
				"UPDATE sessions SET status='completed',terminal_at='2026-09-09T00:10:00Z'",
			),
	});
	writeFileSync(
		ctx.beforePath,
		snapshot([], [...windows, "cmux-codex|@9007|codex", target]),
	);
	writeFileSync(ctx.afterPath, snapshot([], windows));
	const sidecar = JSON.parse(readFileSync(ctx.sidecarPath, "utf8"));
	sidecar.entries[0].windowIdentity = target;
	writeFileSync(ctx.sidecarPath, JSON.stringify(sidecar));
	const result = fleetDiff(ctx);
	assert.equal(result.status, "needs-attribution");
	assert.deepEqual(result.removed, [{ kind: "window", line: target }]);
	assert.equal(result.attributions.length, 1);
	assert.equal(result.attributions[0].executionId, "exec-prod");
	assert.equal(
		result.attributions[0].terminalEvidence.source,
		"sessions.terminal_at",
	);
});
for (const extra of ["other|@9008|different", "other|@9009|fly2454-decoy"]) {
	test(`real fleet inventory retains conflict guard ${extra}`, (t) => {
		const windows = [
			...capturedFleetWindows(),
			"main|@9008|fly2454-decoy",
			extra,
		];
		const ctx = diffFixture(t);
		writeFileSync(ctx.beforePath, snapshot([], windows));
		writeFileSync(ctx.afterPath, snapshot([], windows));
		assert.equal(fleetDiff({ ...ctx, mode: "live" }).status, "fail");
	});
}
