import assert from "node:assert/strict";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { roomInfoCheck } from "../lib/qa-fly-2456-room-info.mjs";

function fixture(t) {
	const slotDir = mkdtempSync(join(tmpdir(), "fly2456-room-"));
	t.after(() => rmSync(slotDir, { recursive: true, force: true }));
	const original = join(slotDir, "room-info.json"),
		hidden = `${original}.drill-hidden`;
	writeFileSync(original, '{"slot":4}', { mode: 0o600 });
	return { slotDir, original, hidden };
}
test("hide and restore preserve exact file identity and bytes", (t) => {
	const f = fixture(t);
	const pre = roomInfoCheck({ ...f, phase: "hide-precheck" });
	assert.equal(pre.status, "pass");
	renameSync(f.original, f.hidden);
	for (const phase of ["hide-postcheck", "restore-precheck"])
		assert.equal(
			roomInfoCheck({ ...f, phase, identity: pre.identity }).status,
			"pass",
		);
	renameSync(f.hidden, f.original);
	assert.equal(
		roomInfoCheck({ ...f, phase: "restore-postcheck", identity: pre.identity })
			.status,
		"pass",
	);
});
test("both names present fails without touching either file", (t) => {
	const f = fixture(t);
	const { identity } = roomInfoCheck({ ...f, phase: "hide-precheck" });
	renameSync(f.original, f.hidden);
	writeFileSync(f.original, "different");
	assert.equal(
		roomInfoCheck({ ...f, phase: "restore-precheck", identity }).status,
		"fail",
	);
	assert.equal(readFileSync(f.original, "utf8"), "different");
	assert.equal(readFileSync(f.hidden, "utf8"), '{"slot":4}');
});
test("hash or mode drift prevents restore", (t) => {
	const f = fixture(t);
	const { identity } = roomInfoCheck({ ...f, phase: "hide-precheck" });
	renameSync(f.original, f.hidden);
	chmodSync(f.hidden, 0o644);
	assert.equal(
		roomInfoCheck({ ...f, phase: "restore-precheck", identity }).status,
		"fail",
	);
	chmodSync(f.hidden, 0o600);
	writeFileSync(f.hidden, "changed");
	assert.equal(
		roomInfoCheck({ ...f, phase: "restore-precheck", identity }).status,
		"fail",
	);
});
test("symlink, missing receipt and invalid phase fail closed", (t) => {
	const f = fixture(t);
	renameSync(f.original, f.hidden);
	symlinkSync(f.hidden, f.original);
	assert.equal(roomInfoCheck({ ...f, phase: "hide-precheck" }).status, "fail");
	rmSync(f.original);
	assert.equal(
		roomInfoCheck({ ...f, phase: "restore-precheck" }).status,
		"fail",
	);
	assert.equal(roomInfoCheck({ ...f, phase: "whatever" }).status, "fail");
});
