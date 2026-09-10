import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { procAttribution } from "../lib/qa-fly-2456-proc.mjs";

function run(t, before, after, options = {}) {
	const dir = mkdtempSync(join(tmpdir(), "fly2456-proc-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(join(dir, "before"), before);
	writeFileSync(join(dir, "after"), after);
	return procAttribution({
		baselinePath: join(dir, "before"),
		afterPath: join(dir, "after"),
		slotDir: "/tmp/slot-4",
		checkout: "/tmp/checkout",
		...options,
	});
}
const row = (pid, ppid, command, date = "Thu Sep 10 01:02:03 2026") =>
	`${pid} ${ppid} ${date} ${command}\n`;
test("live additions require slot path or captured slot ancestry", (t) => {
	const base = row(1, 0, "/sbin/launchd");
	const r = run(
		t,
		base,
		base +
			row(20, 1, "node /tmp/slot-4/bridge.js") +
			row(21, 20, "codex app-server"),
	);
	assert.equal(r.status, "pass");
	assert.deepEqual(
		r.added.map((x) => x.attribution),
		["SLOT", "SLOT"],
	);
});
test("removed production process needs explanation even when counts stay equal", (t) => {
	const r = run(
		t,
		row(1, 0, "/sbin/launchd") + row(20, 1, "codex app-server"),
		row(1, 0, "/sbin/launchd") + row(30, 1, "node /tmp/checkout/main.js"),
	);
	assert.equal(r.status, "needs-attribution");
	assert.equal(r.removed[0].attribution, "NONSLOT");
});
test("same PID with new lstart is removal plus addition", (t) => {
	const r = run(
		t,
		row(20, 1, "node /tmp/slot-4/bridge.js"),
		row(20, 1, "codex app-server", "Thu Sep 10 01:04:03 2026"),
	);
	assert.equal(r.status, "fail");
	assert.equal(r.removed.length, 1);
	assert.equal(r.added.length, 1);
});
test("post teardown permits disappearance of slot descendants", (t) => {
	assert.equal(
		run(
			t,
			row(1, 0, "init") +
				row(20, 1, "node /tmp/slot-4/a") +
				row(21, 20, "codex"),
			row(1, 0, "init"),
			{ mode: "post-teardown" },
		).status,
		"pass",
	);
});
test("prefix collisions and textual mention do not establish slot ownership", (t) => {
	for (const command of [
		"node /tmp/slot-40/a",
		"echo /tmp/slot-4/a",
		"node --message=/tmp/checkout/a",
	]) {
		assert.equal(
			run(t, row(1, 0, "init"), row(1, 0, "init") + row(2, 1, command)).status,
			"fail",
			command,
		);
	}
});
test("malformed empty duplicate and cyclic snapshots fail closed", (t) => {
	for (const input of [
		"",
		"not ps\n",
		row(1, 0, "init") + row(1, 0, "init"),
		row(2, 3, "codex") + row(3, 2, "codex"),
	])
		assert.equal(run(t, input, row(1, 0, "init")).status, "fail");
});
test("path traversal does not confer slot ownership", (t) => {
	assert.equal(
		run(
			t,
			row(1, 0, "init"),
			row(1, 0, "init") + row(2, 1, "node /tmp/slot-4/../production/main.js"),
		).status,
		"fail",
	);
});
test("parent born after child cannot establish ancestry", (t) => {
	const input =
		row(1, 0, "init") +
		row(20, 1, "node /tmp/slot-4/a", "Thu Sep 10 01:05:03 2026") +
		row(21, 20, "codex");
	assert.equal(run(t, row(1, 0, "init"), input).status, "fail");
});
