#!/usr/bin/env node
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MAX_SOURCE = 1048576,
	MAX_LINE = 65536,
	MAX_LINES = 1000;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const record = (value) =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const instant = (value) =>
	typeof value === "string" &&
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
	Number.isFinite(Date.parse(value));
/** Conversion only. No DB, network, authority inference or mutation of the source. */
export function convertRetroLedger(input) {
	if (!Buffer.isBuffer(input) || input.length > MAX_SOURCE)
		throw new Error("source_budget_exceeded");
	let text;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(input);
	} catch {
		throw new Error("invalid_utf8");
	}
	const sourceDigest = digest(input),
		records = [],
		skipped = [];
	const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	if (lines.length > MAX_LINES) throw new Error("line_count_exceeded");
	for (const [index, rawLine] of lines.entries()) {
		const line = index + 1;
		if (Buffer.byteLength(rawLine) > MAX_LINE)
			throw new Error(`line_budget_exceeded:${line}`);
		if (!rawLine.trim()) {
			skipped.push({ line, reason: "blank" });
			continue;
		}
		let original;
		try {
			original = JSON.parse(rawLine);
		} catch {
			throw new Error(`invalid_json_line:${line}`);
		}
		if (!record(original)) throw new Error(`invalid_record_line:${line}`);
		if (original.retro !== true) {
			skipped.push({ line, reason: "not_explicit_retro" });
			continue;
		}
		if (
			typeof original.issue !== "string" ||
			!/^FLY-\d+$/.test(original.issue) ||
			!Number.isSafeInteger(original.pr) ||
			original.pr <= 0 ||
			typeof original.head !== "string" ||
			!/^[a-fA-F0-9]{4,40}$/.test(original.head) ||
			typeof original.my_verdict !== "string" ||
			!original.my_verdict.trim() ||
			!record(original.reasons) ||
			!["prd_align", "conflict", "qa_coverage"].every(
				(key) =>
					typeof original.reasons[key] === "string" &&
					original.reasons[key].trim(),
			) ||
			!["approved", "rework", "canceled"].includes(original.founder_decision) ||
			!instant(original.decided_at)
		)
			throw new Error(`invalid_retro_line:${line}`);
		const reasons = ["unverified_binding", "unverified_founder_source"];
		if (!/^[a-fA-F0-9]{40}$/.test(original.head))
			reasons.push("missing_full_head");
		if (
			typeof original.question_id !== "string" ||
			!original.question_id.trim()
		)
			reasons.push("missing_question");
		if (!instant(original.judged_at)) reasons.push("missing_prediction_time");
		records.push({
			id: digest(JSON.stringify(["legacy_retro", sourceDigest, line])),
			source: "legacy_retro",
			sourceDigest,
			line,
			status: "quarantined",
			prospective: false,
			authorship: "unknown",
			reasons,
			rawLine,
			original,
		});
	}
	return {
		schemaVersion: 1,
		sourceDigest,
		sourceBytes: input.length,
		records,
		skipped,
	};
}
function readBounded(path) {
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(MAX_SOURCE + 1);
		let offset = 0;
		while (offset < buffer.length) {
			const count = readSync(fd, buffer, offset, buffer.length - offset, null);
			if (!count) break;
			offset += count;
		}
		return buffer.subarray(0, offset);
	} finally {
		closeSync(fd);
	}
}
export function runRetroImport(args) {
	let source, output;
	for (let i = 0; i < args.length; i++) {
		const flag = args[i];
		if (flag === "--source" && !source && args[i + 1]) source = args[++i];
		else if (flag === "--output" && !output && args[i + 1]) output = args[++i];
		else throw new Error("usage: --source <jsonl> [--output <new-json-file>]");
	}
	if (!source) throw new Error("source_required");
	const result = convertRetroLedger(readBounded(source));
	const json = JSON.stringify(result, null, 2) + "\n";
	if (output) writeFileSync(output, json, { flag: "wx", mode: 0o600 });
	else process.stdout.write(json);
	return result;
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		runRetroImport(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	}
}
