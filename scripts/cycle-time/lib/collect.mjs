import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import {
	backupSqliteSnapshot,
	canonicalizeExtract,
	querySqliteSnapshot,
} from "./extract.mjs";
import { parseSystemHealthLog } from "./time.mjs";

const execFileAsync = promisify(execFile);
const ISSUE_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/;

function requireValue(argv, index, flag) {
	const value = argv[index + 1];
	if (!value || value.startsWith("--"))
		throw new Error(`${flag} requires a value`);
	return value;
}

export function parseReportArgs(argv, now = Date.now) {
	const options = { project: "flywheel", asOfRaw: "now" };
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		if (flag === "--issues")
			options.issuesRaw = requireValue(argv, index++, flag);
		else if (flag === "--as-of")
			options.asOfRaw = requireValue(argv, index++, flag);
		else if (flag === "--out") options.out = requireValue(argv, index++, flag);
		else if (flag === "--project")
			options.project = requireValue(argv, index++, flag);
		else throw new Error(`Unknown argument: ${flag}`);
	}
	if (!options.issuesRaw) throw new Error("--issues is required");
	if (!options.out) throw new Error("--out is required");
	const issues = [
		...new Set(
			options.issuesRaw
				.split(",")
				.map((item) => item.trim())
				.filter(Boolean),
		),
	];
	if (
		issues.length === 0 ||
		issues.some((issue) => !ISSUE_PATTERN.test(issue))
	) {
		throw new Error("invalid issue identifier; expected TEAM-123");
	}
	const asOf = options.asOfRaw === "now" ? now() : Date.parse(options.asOfRaw);
	if (!Number.isFinite(asOf))
		throw new Error(`invalid --as-of: ${options.asOfRaw}`);
	return {
		issues,
		asOf,
		asOfIso: new Date(asOf).toISOString(),
		out: options.out,
		project: options.project,
	};
}

export function buildLinearQuery(issues) {
	return `query { ${issues
		.map(
			(issue, index) =>
				`i${index}: issue(id: "${issue}") { identifier createdAt startedAt completedAt history { nodes { createdAt fromState { name } toState { name } } } }`,
		)
		.join(" ")} }`;
}

export function mapLinearResponse(response, issues, asOf) {
	if (response.errors?.length)
		throw new Error(
			`Linear GraphQL failed: ${response.errors.map((item) => item.message).join("; ")}`,
		);
	const mapped = {};
	for (let index = 0; index < issues.length; index += 1) {
		const issue = response.data?.[`i${index}`];
		if (!issue) continue;
		mapped[issues[index]] = {
			identifier: issue.identifier,
			createdAt: issue.createdAt,
			startedAt:
				issue.startedAt && Date.parse(issue.startedAt) <= asOf
					? issue.startedAt
					: null,
			completedAt:
				issue.completedAt && Date.parse(issue.completedAt) <= asOf
					? issue.completedAt
					: null,
			history: (issue.history?.nodes ?? [])
				.filter((item) => Date.parse(item.createdAt) <= asOf)
				.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
		};
	}
	return mapped;
}

export function mapCommData(rows, sessions) {
	const issueByExec = new Map(
		sessions.map((session) => [session.execution_id, session.issue_identifier]),
	);
	const questions = rows
		.filter(
			(row) => row.type === "question" || (row.checkpoint && !row.parent_id),
		)
		.flatMap((row) => {
			const issue =
				issueByExec.get(row.from_agent) ??
				row.content?.match(/\b[A-Z][A-Z0-9]+-\d+\b/)?.[0];
			if (!issue) return [];
			return [
				{
					id: row.id,
					issue_identifier: issue,
					execution_id: row.from_agent,
					checkpoint: row.checkpoint,
					created_at: row.created_at,
					pr_head_sha: row.content?.match(/\b[0-9a-f]{40}\b/i)?.[0] ?? null,
				},
			];
		});
	const questionIds = new Set(questions.map((item) => item.id));
	const responses = rows
		.filter((row) => row.type === "response" && questionIds.has(row.parent_id))
		.map((row) => ({ parent_id: row.parent_id, created_at: row.created_at }));
	return { questions, responses };
}

async function retry(operation, attempts = 3) {
	let lastError;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			return await operation();
		} catch (error) {
			lastError = error;
			if (attempt < attempts)
				await new Promise((resolve) =>
					setTimeout(resolve, 250 * 2 ** (attempt - 1)),
				);
		}
	}
	throw lastError;
}

async function fetchLinear(issues, asOf, apiKey) {
	if (!apiKey) throw new Error("LINEAR_API_KEY is unavailable");
	const query = buildLinearQuery(issues);
	const response = await retry(async () => {
		const result = await fetch("https://api.linear.app/graphql", {
			method: "POST",
			headers: { Authorization: apiKey, "Content-Type": "application/json" },
			body: JSON.stringify({ query }),
		});
		if (!result.ok) throw new Error(`Linear HTTP ${result.status}`);
		return result.json();
	});
	return mapLinearResponse(response, issues, asOf);
}

async function collectGitHub(issues, asOf) {
	const prsByIssue = {};
	const runsByIssue = {};
	for (const issue of issues) {
		const { stdout } = await retry(() =>
			execFileAsync(
				"gh",
				[
					"pr",
					"list",
					"--state",
					"all",
					"--search",
					issue,
					"--limit",
					"30",
					"--json",
					"number,title,headRefName,headRefOid,createdAt,updatedAt,mergedAt,state,url",
				],
				{ maxBuffer: 16 * 1024 * 1024 },
			),
		);
		const issueUpper = issue.toUpperCase();
		const prs = JSON.parse(stdout)
			.filter(
				(pr) =>
					pr.headRefName?.toUpperCase().includes(issueUpper) ||
					new RegExp(`(^|[^A-Z0-9])${issueUpper}([^0-9]|$)`).test(
						pr.title?.toUpperCase() ?? "",
					),
			)
			.filter((pr) => Date.parse(pr.createdAt) <= asOf)
			.map((pr) => ({
				number: pr.number,
				headRefName: pr.headRefName,
				createdAt: pr.createdAt,
				mergedAt:
					pr.mergedAt && Date.parse(pr.mergedAt) <= asOf ? pr.mergedAt : null,
				url: pr.url,
			}));
		prsByIssue[issue] = prs;
		const runs = [];
		for (const pr of prs) {
			const runResult = await retry(() =>
				execFileAsync(
					"gh",
					[
						"run",
						"list",
						"--branch",
						pr.headRefName,
						"--limit",
						"100",
						"--json",
						"databaseId,workflowName,headSha,createdAt,updatedAt,status,conclusion,event,url",
					],
					{ maxBuffer: 16 * 1024 * 1024 },
				),
			);
			for (const run of JSON.parse(runResult.stdout)) {
				if (Date.parse(run.createdAt) > asOf) continue;
				const closedAtAsOf =
					Boolean(run.updatedAt) && Date.parse(run.updatedAt) <= asOf;
				runs.push({
					...run,
					updatedAt: closedAtAsOf ? run.updatedAt : null,
					status: closedAtAsOf ? run.status : "in_progress",
					conclusion: closedAtAsOf ? run.conclusion : null,
					branch: pr.headRefName,
					prNumber: pr.number,
				});
			}
		}
		runsByIssue[issue] = runs.sort(
			(a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
		);
	}
	return { prsByIssue, runsByIssue };
}

function sqlList(values) {
	return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(",");
}

function sqliteTime(epochMs) {
	return new Date(epochMs).toISOString().replace("T", " ").replace("Z", "");
}

async function collectTeam(snapshotPath, issues, project, asOf, minT0) {
	const issueList = sqlList(issues);
	const projectSql = project.replaceAll("'", "''");
	const minSql = sqliteTime(minT0);
	const asOfSql = sqliteTime(asOf);
	const sessions = await querySqliteSnapshot(
		snapshotPath,
		`SELECT execution_id,issue_identifier,project_name,status,started_at,terminal_at,last_error,session_role,pr_number,branch FROM sessions WHERE project_name='${projectSql}' AND started_at <= '${asOfSql}' AND (started_at >= '${minSql}' OR terminal_at >= '${minSql}' OR issue_identifier IN (${issueList})) ORDER BY started_at,execution_id`,
	);
	for (const session of sessions) {
		if (
			!session.terminal_at ||
			Date.parse(`${session.terminal_at.replace(" ", "T")}Z`) > asOf
		) {
			session.terminal_at = null;
			session.status = "open";
			session.last_error = null;
		}
	}
	const sampleExecs = sessions
		.filter((row) => issues.includes(row.issue_identifier))
		.map((row) => row.execution_id);
	const execList = sampleExecs.length > 0 ? sqlList(sampleExecs) : "''";
	const events = await querySqliteSnapshot(
		snapshotPath,
		`SELECT event_id,ts,execution_id,issue_id,event_type,payload,source FROM session_events WHERE execution_id IN (${execList}) AND ts <= '${asOfSql}' ORDER BY ts,id`,
	);
	const reviews = await querySqliteSnapshot(
		snapshotPath,
		`SELECT request_id,execution_id,issue_id,review_type,round,frozen_head_sha,status,verdict,created_at,updated_at,responded_at,failure_reason FROM codex_review_job WHERE issue_id IN (${issueList}) AND created_at <= '${asOfSql}' ORDER BY created_at,request_id`,
	);
	for (const review of reviews) {
		if (
			!review.updated_at ||
			Date.parse(`${review.updated_at.replace(" ", "T")}Z`) > asOf
		) {
			review.updated_at = null;
			review.responded_at = null;
			review.status = "open";
			review.verdict = null;
			review.failure_reason = null;
		} else if (
			review.responded_at &&
			Date.parse(`${review.responded_at.replace(" ", "T")}Z`) > asOf
		) {
			review.responded_at = null;
		}
	}
	const qaRecords = await querySqliteSnapshot(
		snapshotPath,
		`SELECT parent_execution_id,target_pr_head_sha,issue_id,qa_execution_id,status,started_at,completed_at FROM auto_qa_record WHERE issue_id IN (${issueList}) AND started_at <= '${asOfSql}' ORDER BY started_at,parent_execution_id`,
	);
	for (const qaRecord of qaRecords) {
		if (
			!qaRecord.completed_at ||
			Date.parse(`${qaRecord.completed_at.replace(" ", "T")}Z`) > asOf
		) {
			qaRecord.completed_at = null;
			qaRecord.status = "open";
		}
	}
	return { sessions, events, reviews, qaRecords };
}

async function collectComm(snapshotPath, sessions, asOf) {
	const sampleExecs = sessions.map((row) => row.execution_id);
	const execList = sampleExecs.length > 0 ? sqlList(sampleExecs) : "''";
	const asOfSql = sqliteTime(asOf);
	const questions = await querySqliteSnapshot(
		snapshotPath,
		`SELECT id,from_agent,to_agent,type,parent_id,checkpoint,created_at,content FROM messages WHERE from_agent IN (${execList}) AND type='question' AND checkpoint IS NOT NULL AND created_at <= '${asOfSql}' ORDER BY created_at,id`,
	);
	const questionList =
		questions.length > 0 ? sqlList(questions.map((row) => row.id)) : "''";
	const responses = await querySqliteSnapshot(
		snapshotPath,
		`SELECT id,from_agent,to_agent,type,parent_id,checkpoint,created_at,content FROM messages WHERE parent_id IN (${questionList}) AND type='response' AND created_at <= '${asOfSql}' ORDER BY created_at,id`,
	);
	const wakes = await querySqliteSnapshot(
		snapshotPath,
		`SELECT queue_seq,execution_id,message_id,state,queued_at,started_at,finished_at FROM runner_phase_wakes WHERE execution_id IN (${execList}) AND queued_at <= ${asOf} ORDER BY queued_at,queue_seq`,
	);
	return { ...mapCommData([...questions, ...responses], sessions), wakes };
}

export function healthLogDates(minT0, asOf, timezone = "America/Los_Angeles") {
	const formatter = new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	const localDay = (epochMs) =>
		Object.fromEntries(
			formatter
				.formatToParts(new Date(epochMs))
				.filter((part) => part.type !== "literal")
				.map((part) => [part.type, Number(part.value)]),
		);
	const start = localDay(minT0 - 60_000);
	const end = localDay(asOf);
	const dates = [];
	for (
		let day = Date.UTC(start.year, start.month - 1, start.day);
		day <= Date.UTC(end.year, end.month - 1, end.day);
		day += 86_400_000
	) {
		dates.push(new Date(day).toISOString().slice(0, 10));
	}
	return dates;
}

async function collectHealth(healthRoot, minT0, asOf) {
	const chunks = [];
	const missing = [];
	for (const date of healthLogDates(minT0, asOf)) {
		try {
			chunks.push(await readFile(join(healthRoot, `${date}.log`), "utf8"));
		} catch {
			missing.push(date);
		}
	}
	const logText = chunks.join("\n");
	return {
		status:
			chunks.length === 0 ? "failed" : missing.length > 0 ? "partial" : "ok",
		note:
			chunks.length === 0
				? "system-health logs unavailable"
				: missing.length > 0
					? `missing log days: ${missing.join(",")}`
					: "all requested log days present",
		logText,
		records: parseSystemHealthLog(logText, "America/Los_Angeles")
			.filter(
				(record) => record.at_ms >= minT0 - 60_000 && record.at_ms <= asOf,
			)
			.map((record) => ({
				effective_at: new Date(record.at_ms).toISOString(),
				load_1m: record.load_1m,
			})),
	};
}

async function fileSha256(path) {
	return createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
}

export async function collectSources({
	issues,
	asOf,
	asOfIso,
	project,
	scratchDir,
	teamDb,
	commDb,
	linearApiKey,
	healthRoot,
}) {
	const teamSnapshot = join(scratchDir, "snap-teamlead.db");
	const commSnapshot = join(scratchDir, "snap-comm.db");
	const qaLog = {
		captured_at: new Date().toISOString(),
		as_of: asOfIso,
		raw_sources: {},
	};
	const status = {
		linear: "failed",
		teamlead: "failed",
		commdb: "failed",
		gh: "failed",
	};
	let linear = {};
	let github = {
		prsByIssue: Object.fromEntries(issues.map((issue) => [issue, []])),
		runsByIssue: Object.fromEntries(issues.map((issue) => [issue, []])),
	};
	let team = { sessions: [], events: [], reviews: [], qaRecords: [] };
	let comm = { questions: [], responses: [], wakes: [] };
	const errors = {};

	try {
		linear = await fetchLinear(issues, asOf, linearApiKey);
		status.linear = "ok";
	} catch (error) {
		errors.linear = error.message;
	}
	const knownT0 = Object.values(linear)
		.map((item) => Date.parse(item.createdAt))
		.filter(Number.isFinite);
	const minT0 =
		knownT0.length > 0 ? Math.min(...knownT0) : asOf - 7 * 86_400_000;

	try {
		await backupSqliteSnapshot(teamDb, teamSnapshot);
		team = await collectTeam(teamSnapshot, issues, project, asOf, minT0);
		qaLog.raw_sources.teamlead = {
			snapshot_path: teamSnapshot,
			raw_sha256: await fileSha256(teamSnapshot),
		};
		status.teamlead = "ok";
	} catch (error) {
		errors.teamlead = error.message;
	}
	try {
		await backupSqliteSnapshot(commDb, commSnapshot);
		comm = await collectComm(
			commSnapshot,
			team.sessions.filter((session) =>
				issues.includes(session.issue_identifier),
			),
			asOf,
		);
		qaLog.raw_sources.commdb = {
			snapshot_path: commSnapshot,
			raw_sha256: await fileSha256(commSnapshot),
		};
		status.commdb = "ok";
	} catch (error) {
		errors.commdb = error.message;
	}
	try {
		github = await collectGitHub(issues, asOf);
		status.gh = "ok";
	} catch (error) {
		errors.gh = error.message;
	}
	const health = await collectHealth(healthRoot, minT0, asOf);
	const manifestPayloads = {
		linear: Object.values(linear),
		teamlead: [
			...team.sessions,
			...team.events,
			...team.reviews,
			...team.qaRecords,
		],
		commdb: [...comm.questions, ...comm.responses, ...comm.wakes],
		gh: [
			...Object.values(github.prsByIssue).flat(),
			...Object.values(github.runsByIssue).flat(),
		],
		"system-health": health.records,
	};
	const manifests = Object.entries(manifestPayloads).map(
		([sourceId, payload]) =>
			canonicalizeExtract(payload, {
				asOf: asOfIso,
				sourceId,
				schemaVersion: "cycle-time-v1",
				sortVersion: "stable-json-v1",
			}).manifest,
	);
	return {
		bundle: { issues, asOf, linear, team, comm, github, health, status },
		manifests,
		qaLog: { ...qaLog, errors, status },
	};
}
