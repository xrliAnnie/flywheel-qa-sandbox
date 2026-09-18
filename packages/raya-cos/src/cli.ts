#!/usr/bin/env node
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { BusinessRound } from "./business-round.js";
import { dueReportDate } from "./contracts/daily-report.js";
import {
	applyDailyReportMigration,
	planDailyReportMigration,
} from "./daily-report/migration.js";
import { applyLegacyMeetings, planLegacyMeetings } from "./legacy-meetings.js";
import {
	applyLegacyQuestions,
	planLegacyQuestions,
} from "./legacy-questions.js";
import { createUnavailablePorts } from "./ports.js";
import { requestVoiceIntent } from "./voice-intent.js";

export interface CoSCommandIo {
	write(line: string): void;
}

function flags(argv: readonly string[]): Map<string, string> {
	const result = new Map<string, string>();
	for (let index = 1; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (!key?.startsWith("--") || value === undefined || result.has(key)) {
			throw new Error("CoS command flags must be unique --name value pairs");
		}
		result.set(key, value);
	}
	return result;
}

function required(values: Map<string, string>, name: string): string {
	const value = values.get(name);
	if (!value) throw new Error(`missing ${name}`);
	return value;
}

function readWorkspaceInput(workspace: string, input: string): unknown {
	const root = realpathSync(workspace);
	const path = resolve(root, input);
	const rel = relative(root, path);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
		throw new Error("input must be inside workspace");
	let checked = root;
	for (const part of rel.split(sep)) {
		checked = join(checked, part);
		if (lstatSync(checked).isSymbolicLink())
			throw new Error("input path must not contain symlinks");
	}
	const fd = openSync(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > 1024 * 1024)
			throw new Error("input must be a JSON file up to 1 MiB");
		return JSON.parse(readFileSync(fd, "utf8"));
	} finally {
		closeSync(fd);
	}
}

export async function runCoSCommand(
	argv: readonly string[],
	io: CoSCommandIo = { write: (line) => process.stdout.write(`${line}\n`) },
	workspace: string = process.cwd(),
): Promise<number> {
	const command = argv[0];
	const values = flags(argv);
	if (command === "legacy-meetings-plan") {
		if (values.size) throw new Error("legacy-meetings-plan accepts no flags");
		io.write(JSON.stringify(planLegacyMeetings(workspace)));
		return 0;
	}
	if (command === "legacy-meetings-apply") {
		if (
			values.size !== 3 ||
			[...values.keys()].some(
				(key) => !["--digest", "--flywheel-sha", "--raya-sha"].includes(key),
			)
		)
			throw new Error("legacy meetings apply requires digest and paired SHAs");
		io.write(
			JSON.stringify(
				applyLegacyMeetings(workspace, required(values, "--digest"), {
					flywheelSha: required(values, "--flywheel-sha"),
					rayaSha: required(values, "--raya-sha"),
				}),
			),
		);
		return 0;
	}
	if (command === "legacy-questions-plan") {
		if (values.size) throw new Error("legacy-questions-plan accepts no flags");
		io.write(JSON.stringify(planLegacyQuestions(workspace)));
		return 0;
	}
	if (command === "legacy-questions-apply") {
		if (
			values.size !== 3 ||
			[...values.keys()].some(
				(key) => !["--digest", "--flywheel-sha", "--raya-sha"].includes(key),
			)
		)
			throw new Error("legacy questions apply requires digest and paired SHAs");
		io.write(
			JSON.stringify(
				applyLegacyQuestions(workspace, required(values, "--digest"), {
					flywheelSha: required(values, "--flywheel-sha"),
					rayaSha: required(values, "--raya-sha"),
				}),
			),
		);
		return 0;
	}
	if (command === "daily-report-migration-apply") {
		if (
			values.size !== 3 ||
			[...values.keys()].some(
				(key) => !["--digest", "--flywheel-sha", "--raya-sha"].includes(key),
			)
		)
			throw new Error("migration apply requires digest and paired SHAs");
		io.write(
			JSON.stringify(
				applyDailyReportMigration(workspace, required(values, "--digest"), {
					flywheelSha: required(values, "--flywheel-sha"),
					rayaSha: required(values, "--raya-sha"),
				}),
			),
		);
		return 0;
	}
	if (command === "daily-report-migration-plan") {
		if (values.size)
			throw new Error("daily-report-migration-plan accepts no flags");
		io.write(JSON.stringify(planDailyReportMigration(workspace)));
		return 0;
	}
	if (command === "status") {
		if (values.size) throw new Error("status accepts no flags");
		io.write(JSON.stringify(new BusinessRound(workspace).status()));
		return 0;
	}
	if (command === "prepare" || command === "record" || command === "resume") {
		if (values.size !== 1 || !values.has("--input"))
			throw new Error("business command requires only --input");
		const input = readWorkspaceInput(workspace, required(values, "--input"));
		const round = new BusinessRound(workspace);
		if (command === "resume") {
			if (!input || typeof input !== "object" || Array.isArray(input))
				throw new Error("invalid resume input");
			const value = input as Record<string, unknown>;
			if (
				value.schemaVersion !== 2 ||
				typeof value.operationId !== "string" ||
				Object.keys(value).some(
					(key) => !["schemaVersion", "operationId"].includes(key),
				)
			)
				throw new Error("invalid resume input");
			io.write(JSON.stringify(round.resume(value.operationId)));
		} else
			io.write(
				JSON.stringify(
					command === "prepare" ? round.prepare(input) : round.record(input),
				),
			);
		return 0;
	}

	if (command === "daily-report-date") {
		const now = Date.parse(required(values, "--now"));
		if (!Number.isFinite(now)) throw new Error("--now must be ISO-8601");
		io.write(
			dueReportDate(
				now,
				required(values, "--timezone"),
				required(values, "--time"),
			),
		);
		return 0;
	}
	if (command === "voice-intent") {
		const action = required(values, "--action");
		if (action !== "start" && action !== "stop") {
			throw new Error("--action must be start or stop");
		}
		const result = await requestVoiceIntent(
			{ meetingId: required(values, "--meeting-id"), action },
			createUnavailablePorts(),
		);
		io.write(JSON.stringify(result));
		return result.status === "accepted" ? 0 : 2;
	}
	throw new Error(`unknown CoS command: ${command ?? ""}`);
}

const executable = process.argv[1];
if (
	executable &&
	import.meta.url === pathToFileURL(realpathSync(executable)).href
) {
	runCoSCommand(process.argv.slice(2))
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error: unknown) => {
			process.stderr.write(
				`${error instanceof Error ? error.message : String(error)}\n`,
			);
			process.exitCode = 1;
		});
}
