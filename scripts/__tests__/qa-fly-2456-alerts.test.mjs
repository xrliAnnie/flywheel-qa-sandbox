import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { alertDirsAttribution } from "../lib/qa-fly-2456-alerts.mjs";

test("real meta-alert text attributes dead-letter lead and keeps unknown attribution", (t) => {
	const text = (lead) =>
		`[2026-09-10 00:00] LeadAlert dropped (dead-letter)\nreason=alert_dead_lettered\n\nA Lead alert could not be delivered and was dead-lettered (reason=failed, lead=${lead}, type=complete). The Discord alert path may be misconfigured or down.\n`;
	const row = (content) => ({
		path: "meta-alert/alert_dead_lettered.txt",
		content,
		sha256: createHash("sha256").update(content).digest("hex"),
	});
	assert.equal(run(t, [], [row(text("flywheel-eng-lead"))]).status, "pass");
	assert.equal(run(t, [], [row(text("flywheel-test-4"))]).pollution.length, 1);
	assert.equal(
		run(
			t,
			[],
			[row("[2026-09-10 00:00] unknown\nreason=other\n\nno identity\n")],
		).status,
		"needs-attribution",
	);
});

const item = (path, leadId) => {
	const content = JSON.stringify({ leadId, message: "test" });
	return {
		path,
		content,
		sha256: createHash("sha256").update(content).digest("hex"),
	};
};
function run(t, before, after) {
	const dir = mkdtempSync(join(tmpdir(), "fly2456-alert-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	for (const [name, data] of Object.entries({ before, after }))
		writeFileSync(join(dir, name), JSON.stringify(data));
	return alertDirsAttribution({
		beforePath: join(dir, "before"),
		afterPath: join(dir, "after"),
		slotLead: "flywheel-test-4",
	});
}
test("new and changed alerts classified from content not filename", (t) => {
	const r = run(
		t,
		[item("meta-alert/production.json", "flywheel-eng-lead")],
		[
			item("meta-alert/production.json", "flywheel-test-4"),
			item("alert-deadletter/flywheel-test-4.json", "flywheel-eng-lead"),
		],
	);
	assert.equal(r.status, "fail");
	assert.equal(r.pollution.length, 1);
	assert.equal(r.production.length, 1);
});
test("unchanged baseline slot pollution is disclosed without failure", (t) => {
	const a = [item("meta-alert/a.json", "flywheel-test-4")];
	assert.equal(run(t, a, a).status, "pass");
	assert.equal(run(t, a, a).baselineHitCount, 1);
	assert.equal(run(t, a, a).pollution.length, 0);
});
test("production alerts can change without slot pollution", (t) => {
	assert.equal(
		run(t, [], [item("alert-deadletter/a.json", "flywheel-eng-lead")]).status,
		"pass",
	);
});
test("invalid hash, duplicate path, unknown directory or missing lead fail closed", (t) => {
	const good = item("meta-alert/a.json", "flywheel-eng-lead");
	for (const input of [
		[{ ...good, sha256: "0".repeat(64) }],
		[good, good],
		[item("../other", "flywheel-eng-lead")],
	])
		assert.equal(run(t, [], input).status, "fail");
});

test("production foreign leads and atomic leftovers are classified without raw content", (t) => {
	const raw = (path, content) => ({
		path,
		content,
		sha256: createHash("sha256").update(content).digest("hex"),
	});
	const files = [
		item("alert-deadletter/product.json", "product-lead"),
		item("alert-deadletter/bridge.json", "bridge"),
		item("alert-deadletter/empty.json", ""),
		raw("alert-deadletter/invalid.json", "private-not-json"),
		raw("meta-alert/alert.txt.tmp.123.456", ""),
	];
	const result = run(t, files, files);
	assert.equal(result.status, "pass");
	assert.equal(result.foreign.length, 3);
	assert.deepEqual(
		result.foreign.map((r) => r.leadId),
		["product-lead", "bridge", ""],
	);
	assert.equal(result.unparsed.length, 2);
	assert.ok(
		result.unparsed.every((r) => r.path && /^[a-f0-9]{64}$/.test(r.sha256)),
	);
	assert.ok(!JSON.stringify(result).includes("private-not-json"));
	assert.ok(!JSON.stringify(result).includes('"content"'));
	const after = [
		...files,
		item("alert-deadletter/new-slot.json", "flywheel-test-4"),
	];
	assert.equal(run(t, files, after).status, "fail");
	assert.deepEqual(
		run(t, files, after).pollution.map((r) => r.path),
		["alert-deadletter/new-slot.json"],
	);
});
