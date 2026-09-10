import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

const prefix = "# fly2456-proc-comparison ";
const captureCommand = "/bin/ps -axo pid=,ppid=,lstart=,command=";
const hash = (b) => createHash("sha256").update(b).digest("hex");
function comparison(rawPath, sensorPid) {
	if (!Number.isSafeInteger(sensorPid) || sensorPid <= 0)
		throw new Error("invalid sensor PID");
	const raw = readFileSync(rawPath),
		text = raw.toString("utf8");
	if (!Buffer.from(text).equals(raw) || text.includes("\r"))
		throw new Error("invalid ps encoding");
	const lines = text.match(/[^\n]+(?:\n|$)/g) ?? [];
	if (lines.join("") !== text || lines.length < 2)
		throw new Error("invalid raw ps rows");
	let excluded;
	const seen = new Set(),
		kept = [];
	for (const rawRow of lines) {
		const m =
			/^\s*(\d+)\s+(\d+)\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S[^\n]*)\n?$/.exec(
				rawRow,
			);
		if (!m) throw new Error("invalid raw ps row");
		const pid = Number(m[1]),
			ppid = Number(m[2]),
			lstart = m[3].replace(/\s+/g, " "),
			command = m[4];
		if (
			!Number.isSafeInteger(pid) ||
			pid <= 0 ||
			!Number.isSafeInteger(ppid) ||
			seen.has(pid) ||
			!Number.isFinite(Date.parse(lstart)) ||
			command.includes("\0")
		)
			throw new Error("invalid raw process identity");
		seen.add(pid);
		if (pid === sensorPid) {
			if (command !== captureCommand)
				throw new Error("sensor command mismatch");
			excluded = { pid, ppid, lstart, rawRow, reason: "capture-command-self" };
		} else kept.push(rawRow);
	}
	if (!excluded) throw new Error("sensor PID missing");
	const body = kept.join("");
	return {
		header: {
			schemaVersion: 1,
			sourcePath: resolve(rawPath),
			sourceSha256: hash(raw),
			derivedSha256: hash(body),
			command: captureCommand,
			exclusion: excluded,
		},
		body,
	};
}
/** Only source-derived bytes after the header are included in derivedSha256. */
export function prepareProcComparison({ rawPath, sensorPid, outPath }) {
	try {
		const { header, body } = comparison(rawPath, sensorPid),
			output = prefix + JSON.stringify(header) + "\n" + body;
		writeFileSync(outPath, output, { flag: "wx", mode: 0o444 });
		return {
			status: "pass",
			outPath: resolve(outPath),
			...header,
			artifactSha256: hash(output),
		};
	} catch (error) {
		return { status: "fail", reason: error.message };
	}
}
/** Raw snapshots remain supported; arbitrary comment headers remain invalid ps rows. */
export function readProcComparison(path) {
	const text = readFileSync(path, "utf8");
	if (!text.startsWith(prefix)) return text;
	const newline = text.indexOf("\n");
	if (newline < 0) throw new Error("comparison header incomplete");
	const header = JSON.parse(text.slice(prefix.length, newline));
	if (typeof header.sourcePath !== "string" || !isAbsolute(header.sourcePath))
		throw new Error("comparison source invalid");
	const expected = comparison(header.sourcePath, header.exclusion?.pid);
	if (
		!isDeepStrictEqual(header, expected.header) ||
		text.slice(newline + 1) !== expected.body
	)
		throw new Error("comparison evidence mismatch");
	return expected.body;
}
