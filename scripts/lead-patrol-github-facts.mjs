/** Bounded non-secret facts prepared by a trusted parent. No network or credentials. */
import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readSync,
	realpathSync,
} from "node:fs";
import { pathToFileURL } from "node:url";

const invalid = () => new Error("patrol_github_facts_invalid");
const keys = (value, expected) =>
	value &&
	typeof value === "object" &&
	!Array.isArray(value) &&
	Object.keys(value).sort().join(",") === [...expected].sort().join(",");
const date = (value) =>
	typeof value === "string" &&
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
	Number.isFinite(Date.parse(value));
const integer = (value) => Number.isSafeInteger(value) && value > 0;

export function readPatrolGithubFacts(path, projectName, leadId) {
	let fd;
	try {
		if (realpathSync(path) !== path) throw invalid();
		fd = openSync(
			path,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		const before = fstatSync(fd);
		if (
			!before.isFile() ||
			before.nlink !== 1 ||
			before.uid !== process.getuid?.() ||
			(before.mode & 0o077) !== 0 ||
			before.size > 131072
		)
			throw invalid();
		const buffer = Buffer.alloc(131073);
		const count = readSync(fd, buffer, 0, buffer.length, 0);
		const after = fstatSync(fd);
		if (
			count !== before.size ||
			count > 131072 ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			before.ctimeMs !== after.ctimeMs
		)
			throw invalid();
		const facts = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(
				buffer.subarray(0, count),
			),
		);
		if (
			!keys(facts, ["projectName", "leadId", "pulls", "runs"]) ||
			facts.projectName !== projectName ||
			facts.leadId !== leadId
		)
			throw invalid();
		if (
			!Array.isArray(facts.pulls) ||
			facts.pulls.length > 50 ||
			!facts.pulls.every(
				(pr) =>
					keys(pr, ["number", "draft", "head", "updated_at"]) &&
					integer(pr.number) &&
					typeof pr.draft === "boolean" &&
					keys(pr.head, ["sha"]) &&
					typeof pr.head.sha === "string" &&
					/^[a-f0-9]{40}$/.test(pr.head.sha) &&
					date(pr.updated_at),
			)
		)
			throw invalid();
		if (
			!keys(facts.runs, ["workflow_runs"]) ||
			!Array.isArray(facts.runs.workflow_runs) ||
			facts.runs.workflow_runs.length > 5 ||
			!facts.runs.workflow_runs.every(
				(run) =>
					keys(run, ["id", "status", "created_at"]) &&
					integer(run.id) &&
					typeof run.status === "string" &&
					/^[a-z_]{1,32}$/.test(run.status) &&
					date(run.created_at),
			)
		)
			throw invalid();
		return facts;
	} catch {
		throw invalid();
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		if (process.argv.length !== 5) throw invalid();
		process.stdout.write(
			`${JSON.stringify(readPatrolGithubFacts(...process.argv.slice(2)))}\n`,
		);
	} catch {
		process.stderr.write("patrol_github_facts_invalid\n");
		process.exitCode = 1;
	}
}
