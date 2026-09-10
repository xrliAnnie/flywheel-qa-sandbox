import assert from "node:assert/strict";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { procAttribution } from "../lib/qa-fly-2456-proc.mjs";
import { prepareProcComparison } from "../lib/qa-fly-2456-proc-comparison.mjs";

const command = "/bin/ps -axo pid=,ppid=,lstart=,command=";
const row = (pid, cmd) =>
	`  ${pid} ${pid === 1 ? 0 : 1} Thu Sep 10 01:02:03 2026 ${cmd}\n`;
function fixture(t) {
	const dir = mkdtempSync(join(tmpdir(), "fly2456-proc-comparison-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const rawPath = join(dir, "raw"),
		outPath = join(dir, "derived");
	writeFileSync(
		rawPath,
		row(1, "/sbin/launchd") + row(42, command) + row(43, "/usr/bin/other"),
	);
	return { rawPath, outPath, sensorPid: 42 };
}
const inspect = (f) =>
	procAttribution({
		baselinePath: f.outPath,
		afterPath: f.outPath,
		slotDir: "/tmp/slot-4",
		checkout: "/tmp/tested",
	});
test("only exact sensor row is removed, raw preserved, verified header parsed", (t) => {
	const f = fixture(t),
		raw = readFileSync(f.rawPath);
	const r = prepareProcComparison(f);
	assert.equal(r.status, "pass", r.reason);
	assert.deepEqual(readFileSync(f.rawPath), raw);
	const derived = readFileSync(f.outPath, "utf8");
	assert.match(derived, /capture-command-self/);
	assert.match(derived, /sourceSha256/);
	assert.match(derived, /derivedSha256/);
	assert.ok(
		derived.endsWith(row(1, "/sbin/launchd") + row(43, "/usr/bin/other")),
	);
	assert.equal(inspect(f).status, "pass");
	assert.equal(prepareProcComparison(f).status, "fail");
});
test("unknown PID, noncapture command and duplicate PID cannot be excluded", (t) => {
	for (const change of [
		(f) => {
			f.sensorPid = 99;
		},
		(f) => writeFileSync(f.rawPath, row(42, "/bin/ps -ef")),
		(f) => writeFileSync(f.rawPath, row(42, command) + row(42, command)),
	]) {
		const f = fixture(t);
		change(f);
		assert.equal(prepareProcComparison(f).status, "fail");
	}
});
test("raw, derived and header tampering fail verification", (t) => {
	for (const change of [
		(f) =>
			writeFileSync(
				f.rawPath,
				readFileSync(f.rawPath, "utf8") + row(80, "hidden"),
			),
		(f) =>
			writeFileSync(
				f.outPath,
				readFileSync(f.outPath, "utf8").replace(row(43, "/usr/bin/other"), ""),
			),
		(f) =>
			writeFileSync(
				f.outPath,
				readFileSync(f.outPath, "utf8").replace(
					"capture-command-self",
					"arbitrary",
				),
			),
		(f) =>
			writeFileSync(
				f.outPath,
				"# arbitrary comment\n" + row(1, "/sbin/launchd"),
			),
	]) {
		const f = fixture(t);
		assert.equal(prepareProcComparison(f).status, "pass");
		chmodSync(f.outPath, 0o600);
		change(f);
		assert.equal(inspect(f).status, "fail");
	}
});
test("different capture PIDs compare cleanly but another ps row is retained", (t) => {
	const f = fixture(t);
	assert.equal(prepareProcComparison(f).status, "pass");
	const next = {
		rawPath: join(f.rawPath, "..", "next-raw"),
		outPath: join(f.rawPath, "..", "next-derived"),
		sensorPid: 52,
	};
	writeFileSync(
		next.rawPath,
		readFileSync(f.rawPath, "utf8").replace(row(42, command), row(52, command)),
	);
	assert.equal(prepareProcComparison(next).status, "pass");
	const compare = () =>
		procAttribution({
			baselinePath: f.outPath,
			afterPath: next.outPath,
			slotDir: "/tmp/slot-4",
			checkout: "/tmp/tested",
		});
	assert.equal(compare().status, "pass");
	const other = { ...next, outPath: join(f.rawPath, "..", "other-derived") };
	writeFileSync(
		next.rawPath,
		readFileSync(next.rawPath, "utf8") + row(99, command),
	);
	assert.equal(prepareProcComparison(other).status, "pass");
	assert.ok(readFileSync(other.outPath, "utf8").endsWith(row(99, command)));
	assert.equal(
		procAttribution({
			baselinePath: f.outPath,
			afterPath: other.outPath,
			slotDir: "/tmp/slot-4",
			checkout: "/tmp/tested",
		}).status,
		"fail",
	);
});
