import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { convertRetroLedger } from "../import-ship-judgment-retro.mjs";

const row = {
	issue: "FLY-2107",
	pr: 1129,
	head: "7358e9c0",
	my_verdict: "可自动批",
	reasons: { prd_align: "原设计", conflict: "没有冲突", qa_coverage: "用例" },
	founder_decision: "canceled",
	decided_at: "2026-09-10T22:03:58Z",
	retro: true,
	clarification: "推断，未追问原因",
};
test("preserves six original rows with digest/line identities and excludes later non-retro entries", () => {
	const lines = Array.from({ length: 6 }, (_, i) =>
		JSON.stringify({ ...row, issue: `FLY-${2107 + i}` }),
	);
	const input = Buffer.from(
		lines.join("\r\n") +
			"\r\n" +
			JSON.stringify({ ...row, retro: false }) +
			"\n",
	);
	const before = Buffer.from(input),
		digest = createHash("sha256").update(input).digest("hex");
	const result = convertRetroLedger(input);
	assert.deepEqual(input, before);
	assert.equal(result.sourceDigest, digest);
	assert.equal(result.records.length, 6);
	assert.equal(result.skipped.length, 1);
	for (const [i, record] of result.records.entries()) {
		assert.equal(record.source, "legacy_retro");
		assert.equal(record.status, "quarantined");
		assert.equal(record.prospective, false);
		assert.equal(record.authorship, "unknown");
		assert.equal(record.line, i + 1);
		assert.equal(record.rawLine, lines[i] + "\r\n");
		assert.equal(record.original.head, "7358e9c0");
		assert.equal(record.original.clarification, row.clarification);
		assert.ok(record.reasons.includes("missing_full_head"));
		assert.equal(
			record.id,
			createHash("sha256")
				.update(JSON.stringify(["legacy_retro", digest, i + 1]))
				.digest("hex"),
		);
	}
	assert.deepEqual(convertRetroLedger(input), result);
});
test("fails closed on malformed input without accepting partial rows or invented provenance", () => {
	assert.throws(
		() => convertRetroLedger(Buffer.from(JSON.stringify(row) + "\n{")),
		/invalid_json_line:2/,
	);
	assert.throws(() => convertRetroLedger(Buffer.from([0xff])), /invalid_utf8/);
	assert.throws(
		() => convertRetroLedger(Buffer.alloc(1048577)),
		/source_budget_exceeded/,
	);
	const complete = {
		...row,
		head: "a".repeat(40),
		question_id: "q",
		judged_at: "2026-09-10T21:00:00Z",
		founder_authored: true,
	};
	const [record] = convertRetroLedger(
		Buffer.from(JSON.stringify(complete)),
	).records;
	assert.equal(record.authorship, "unknown");
	assert.equal(record.status, "quarantined");
	assert.ok(record.reasons.includes("unverified_binding"));
	assert.ok(record.reasons.includes("unverified_founder_source"));
});
test("CLI writes a new quarantine artifact and never overwrites the source or an existing output", async () => {
	const { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } =
		await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { runRetroImport } = await import("../import-ship-judgment-retro.mjs");
	const dir = mkdtempSync(join(tmpdir(), "ship-retro-"));
	try {
		const source = join(dir, "source.jsonl"),
			output = join(dir, "quarantine.json");
		const bytes = Buffer.from(JSON.stringify(row) + "\n");
		writeFileSync(source, bytes);
		runRetroImport(["--source", source, "--output", output]);
		assert.equal(
			JSON.parse(readFileSync(output, "utf8")).records[0].status,
			"quarantined",
		);
		assert.throws(
			() => runRetroImport(["--source", source, "--output", source]),
			/EEXIST/,
		);
		assert.throws(
			() => runRetroImport(["--source", source, "--output", output]),
			/EEXIST/,
		);
		assert.deepEqual(readFileSync(source), bytes);
		writeFileSync(source, bytes + "{");
		const bad = join(dir, "bad.json");
		assert.throws(
			() => runRetroImport(["--source", source, "--output", bad]),
			/invalid_json_line/,
		);
		assert.equal(existsSync(bad), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
