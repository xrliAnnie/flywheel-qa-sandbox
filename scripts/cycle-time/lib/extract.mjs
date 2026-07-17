import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import { parseSqliteUtc } from "./time.mjs";

const evidence = (source, key, summary) => [{ source, key, summary }];
const execFileAsync = promisify(execFile);

export async function backupSqliteSnapshot(sourcePath, snapshotPath) {
	const escapedSnapshot = snapshotPath.replaceAll("'", "''");
	await execFileAsync("sqlite3", [
		"-readonly",
		`file:${sourcePath}?mode=ro`,
		`.backup '${escapedSnapshot}'`,
	]);
}

export async function querySqliteSnapshot(snapshotPath, sql) {
	const { stdout } = await execFileAsync(
		"sqlite3",
		["-json", `file:${snapshotPath}?mode=ro&immutable=1`, sql],
		{
			maxBuffer: 32 * 1024 * 1024,
		},
	);
	return stdout.trim() ? JSON.parse(stdout) : [];
}

export function buildReviewIntervals(rows, asOf) {
	const intervals = [];
	const delivery_latencies = [];
	for (const row of rows) {
		const start_ms = parseSqliteUtc(row.created_at);
		if (start_ms >= asOf) continue;
		const terminal = row.updated_at ? parseSqliteUtc(row.updated_at) : null;
		const end_ms = terminal !== null && terminal <= asOf ? terminal : null;
		if (terminal !== null && row.responded_at) {
			const responded = parseSqliteUtc(row.responded_at);
			if (responded >= terminal && terminal <= asOf) {
				delivery_latencies.push({
					issue: row.issue_identifier ?? row.issue_id,
					request_id: row.request_id,
					duration_ms: Math.min(responded, asOf) - terminal,
				});
			}
		}
		if (end_ms !== null && end_ms <= start_ms) continue;
		intervals.push({
			source: "teamlead",
			kind: "review_round",
			label: "review_running",
			sublabel: row.review_type,
			issue: row.issue_identifier ?? row.issue_id,
			execId: row.execution_id,
			start_ms,
			end_ms,
			allow_overlap: true,
			state:
				end_ms === null ? "open" : row.status === "failed" ? "failed" : "ok",
			evidence: evidence(
				"teamlead",
				`codex_review_job:request_id=${row.request_id}`,
				`${row.review_type} review R${row.round} ${row.status ?? row.verdict ?? "open"}`,
			),
		});
	}
	return { intervals, delivery_latencies };
}

function parsePayload(payload) {
	if (!payload) return {};
	if (typeof payload === "object") return payload;
	try {
		return JSON.parse(payload);
	} catch {
		return {};
	}
}

export function buildSessionIntervals(sessions, events, asOf) {
	const workingStages = new Set([
		"onboard",
		"brainstorm",
		"research",
		"plan",
		"implement",
		"test",
	]);
	const intervals = [];
	for (const session of sessions) {
		const sessionStart = parseSqliteUtc(session.started_at);
		if (sessionStart >= asOf) continue;
		const terminal = session.terminal_at
			? Math.min(parseSqliteUtc(session.terminal_at), asOf)
			: null;
		if (session.session_role === "qa") {
			if (terminal !== null && terminal <= sessionStart) continue;
			intervals.push({
				source: "teamlead",
				kind: "qa_session",
				label: "qa_running",
				issue: session.issue_identifier,
				execId: session.execution_id,
				start_ms: sessionStart,
				end_ms: terminal,
				allow_overlap: true,
				state:
					terminal === null
						? "open"
						: session.status === "completed"
							? "ok"
							: "failed",
				evidence: evidence(
					"teamlead",
					`session:execution_id=${session.execution_id}`,
					`QA session ${session.status}`,
				),
			});
			continue;
		}
		const stageEvents = events
			.filter(
				(event) =>
					event.execution_id === session.execution_id &&
					event.event_type === "stage_changed",
			)
			.map((event) => ({
				...event,
				stage: parsePayload(event.payload).stage,
				at: parseSqliteUtc(event.ts),
			}))
			.filter((event) => event.at <= asOf)
			.sort((a, b) => a.at - b.at);
		for (let index = 0; index < stageEvents.length; index += 1) {
			const event = stageEvents[index];
			if (!workingStages.has(event.stage)) continue;
			const nextAt = stageEvents[index + 1]?.at ?? terminal ?? asOf;
			if (nextAt <= event.at) continue;
			intervals.push({
				source: "teamlead",
				kind: "session_stage",
				label: "working",
				sublabel: session.session_role === "design" ? "design" : "implement",
				issue: session.issue_identifier,
				execId: session.execution_id,
				start_ms: event.at,
				end_ms: nextAt === asOf && terminal === null ? null : nextAt,
				allow_overlap: true,
				state: nextAt === asOf && terminal === null ? "open" : "ok",
				evidence: evidence(
					"teamlead",
					`session_event:${event.event_id ?? `${session.execution_id}:${event.ts}:${event.stage}`}`,
					`${session.session_role} stage ${event.stage}`,
				),
			});
		}
	}
	return intervals.sort(
		(a, b) => a.start_ms - b.start_ms || a.kind.localeCompare(b.kind),
	);
}

export function buildReworkIntervals({
	reviewRows,
	eventRows,
	qaSessions,
	asOf,
}) {
	const intervals = [];
	for (const row of reviewRows) {
		if (row.verdict !== "CHANGES_REQUESTED" || !row.updated_at) continue;
		const start_ms = parseSqliteUtc(row.updated_at);
		if (start_ms >= asOf) continue;
		const next = reviewRows
			.filter(
				(item) =>
					item.execution_id === row.execution_id &&
					item.review_type === row.review_type &&
					parseSqliteUtc(item.created_at) > start_ms,
			)
			.sort(
				(a, b) => parseSqliteUtc(a.created_at) - parseSqliteUtc(b.created_at),
			)[0];
		const end_ms = next
			? Math.min(parseSqliteUtc(next.created_at), asOf)
			: null;
		intervals.push({
			source: "teamlead",
			kind: "rework",
			label: "rework_loop",
			sublabel: "review_fix",
			issue: row.issue_id,
			start_ms,
			end_ms,
			allow_overlap: true,
			state: end_ms === null ? "open" : "ok",
			evidence: evidence(
				"teamlead",
				`codex_review_job:request_id=${row.request_id}`,
				"CHANGES_REQUESTED to next review",
			),
		});
	}
	for (const event of eventRows) {
		const payload = parsePayload(event.payload);
		if (
			event.event_type !== "qa_result" ||
			String(payload.verdict ?? payload.result ?? "").toUpperCase() !== "FAIL"
		)
			continue;
		const start_ms = parseSqliteUtc(event.ts);
		if (start_ms >= asOf) continue;
		const next = qaSessions
			.filter(
				(session) =>
					session.issue_identifier === event.issue_id &&
					parseSqliteUtc(session.started_at) > start_ms,
			)
			.sort(
				(a, b) => parseSqliteUtc(a.started_at) - parseSqliteUtc(b.started_at),
			)[0];
		const end_ms = next
			? Math.min(parseSqliteUtc(next.started_at), asOf)
			: null;
		intervals.push({
			source: "teamlead",
			kind: "rework",
			label: "rework_loop",
			sublabel: "qa_fix",
			issue: event.issue_id,
			start_ms,
			end_ms,
			allow_overlap: true,
			state: end_ms === null ? "open" : "ok",
			evidence: evidence(
				"teamlead",
				`session_event:${event.event_id}`,
				"QA FAIL to next QA",
			),
		});
	}
	return intervals.sort((a, b) => a.start_ms - b.start_ms);
}

export function buildCiIntervals(runs, { issue, asOf, requiredWorkflows }) {
	const required = new Set(requiredWorkflows);
	const relevant = runs
		.filter(
			(run) =>
				required.has(run.workflowName) &&
				run.event === "pull_request" &&
				Date.parse(run.createdAt) < asOf,
		)
		.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
	return relevant.flatMap((run) => {
		const start_ms = Date.parse(run.createdAt);
		const reportedEnd = run.updatedAt ? Date.parse(run.updatedAt) : null;
		const nextHead = relevant.find(
			(candidate) =>
				candidate.branch === run.branch &&
				candidate.headSha !== run.headSha &&
				Date.parse(candidate.createdAt) > start_ms,
		);
		const supersededAt = nextHead ? Date.parse(nextHead.createdAt) : null;
		const closedAt = [reportedEnd, supersededAt, asOf]
			.filter(Number.isFinite)
			.sort((a, b) => a - b)[0];
		const superseded =
			supersededAt !== null &&
			supersededAt === closedAt &&
			(reportedEnd === null || supersededAt < reportedEnd);
		const open = !superseded && (reportedEnd === null || reportedEnd > asOf);
		if (closedAt <= start_ms) return [];
		return [
			{
				source: "gh",
				kind: "ci_run",
				label: "ci_waiting",
				issue,
				start_ms,
				end_ms: open ? null : closedAt,
				allow_overlap: true,
				state: open
					? "open"
					: superseded
						? "superseded"
						: run.conclusion === "success"
							? "ok"
							: "failed",
				evidence: evidence(
					"gh",
					`gh_run:databaseId=${run.databaseId}`,
					`${run.workflowName} ${run.headSha?.slice(0, 8) ?? "unknown"} ${run.conclusion ?? run.status}`,
				),
			},
		];
	});
}

export function buildGateIntervals({
	questions,
	responses,
	sessionTerminals = [],
	headChanges = [],
	asOf,
}) {
	const allowed = new Set(["brainstorm", "approve_to_ship"]);
	const humanQuestions = questions.filter((question) =>
		allowed.has(question.checkpoint),
	);
	return humanQuestions.flatMap((question) => {
		const start_ms = parseSqliteUtc(question.created_at);
		if (start_ms >= asOf) return [];
		const candidates = [];
		const response = responses.find((item) => item.parent_id === question.id);
		if (response)
			candidates.push({
				at: parseSqliteUtc(response.created_at),
				reason: "response",
			});
		const terminal = sessionTerminals.find(
			(item) => item.execution_id === question.execution_id && item.terminal_at,
		);
		if (terminal)
			candidates.push({
				at: parseSqliteUtc(terminal.terminal_at),
				reason: "terminal",
			});
		const next = humanQuestions.find(
			(item) =>
				item.id !== question.id &&
				item.execution_id === question.execution_id &&
				item.checkpoint === question.checkpoint &&
				parseSqliteUtc(item.created_at) > start_ms,
		);
		if (next)
			candidates.push({
				at: parseSqliteUtc(next.created_at),
				reason: "superseded",
			});
		if (question.checkpoint === "approve_to_ship") {
			const headChange = headChanges.find(
				(item) =>
					item.issue_identifier === question.issue_identifier &&
					(!question.pr_head_sha || item.from_sha === question.pr_head_sha) &&
					parseSqliteUtc(item.at) > start_ms,
			);
			if (headChange)
				candidates.push({
					at: parseSqliteUtc(headChange.at),
					reason: "head_change",
				});
		}
		const close = candidates
			.filter((item) => item.at >= start_ms && item.at <= asOf)
			.sort((a, b) => a.at - b.at)[0];
		if (close && close.at <= start_ms) return [];
		return [
			{
				source: "commdb",
				kind: "gate_question",
				label: "gate_waiting_human",
				sublabel: question.checkpoint,
				issue: question.issue_identifier,
				execId: question.execution_id,
				start_ms,
				end_ms: close?.at ?? null,
				state: close
					? close.reason === "response"
						? "ok"
						: "superseded"
					: "open",
				evidence: evidence(
					"commdb",
					`commdb:question=${question.id}`,
					`${question.checkpoint} gate ${close?.reason ?? "open"}`,
				),
			},
		];
	});
}

export function buildInfraIntervals({
	allProjectSessions,
	sampleIssues,
	asOf,
}) {
	const abnormal = new Set(["failed", "terminated", "rejected", "blocked"]);
	const groups = new Map();
	for (const session of allProjectSessions) {
		if (
			!session.terminal_at ||
			!abnormal.has(session.status) ||
			!session.last_error
		)
			continue;
		const terminal = parseSqliteUtc(session.terminal_at);
		if (terminal > asOf) continue;
		const fingerprint = session.last_error
			.trim()
			.replace(/\s+/g, " ")
			.toLowerCase();
		const minute = Math.floor(terminal / 60_000);
		const key = `${session.project_name}\0${minute}\0${fingerprint}`;
		const group = groups.get(key) ?? {
			project: session.project_name,
			minute,
			fingerprint,
			sessions: [],
		};
		group.sessions.push({ session, terminal });
		groups.set(key, group);
	}

	const output = [];
	for (const group of groups.values()) {
		if (
			new Set(group.sessions.map((item) => item.session.execution_id)).size < 3
		)
			continue;
		const start_ms = Math.min(...group.sessions.map((item) => item.terminal));
		const lastFailure = Math.max(
			...group.sessions.map((item) => item.terminal),
		);
		const recovery = allProjectSessions
			.filter(
				(session) =>
					session.project_name === group.project && session.started_at,
			)
			.map((session) => parseSqliteUtc(session.started_at))
			.filter((started) => started > lastFailure && started <= asOf)
			.sort((a, b) => a - b)[0];
		const affected = [
			...new Set(group.sessions.map((item) => item.session.issue_identifier)),
		].filter((issue) => sampleIssues.includes(issue));
		const fingerprintHash = createHash("sha256")
			.update(group.fingerprint)
			.digest("hex")
			.slice(0, 12);
		if ((recovery ?? asOf) <= start_ms) continue;
		for (const issue of affected) {
			output.push({
				source: "teamlead",
				kind: "incident",
				label: recovery ? "infra_incident" : "unmeasurable",
				sublabel: recovery ? "clustered_failure" : "missing_recovery_anchor",
				issue,
				start_ms,
				end_ms: recovery ?? null,
				state: recovery ? "failed" : "open",
				evidence: evidence(
					"teamlead",
					`failure_cluster:${group.project}:${group.minute}:${fingerprintHash}`,
					`${group.sessions.length} sessions shared failure fingerprint`,
				),
			});
		}
	}
	return output.sort(
		(a, b) => a.start_ms - b.start_ms || a.issue.localeCompare(b.issue),
	);
}

const EPHEMERAL_KEYS = new Set([
	"scratch_path",
	"captured_at",
	"raw_hash",
	"run_started_at",
]);

function normalizeCanonical(value) {
	if (Array.isArray(value)) return value.map(normalizeCanonical);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key, item]) => !EPHEMERAL_KEYS.has(key) && item !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, item]) => [key, normalizeCanonical(item)]),
		);
	}
	return value;
}

function stableStringify(value) {
	return JSON.stringify(normalizeCanonical(value));
}

export function canonicalizeExtract(
	payload,
	{ asOf, sourceId, schemaVersion = "1", sortVersion = "1" },
) {
	const asOfMs = Date.parse(asOf);
	const normalizedPayload = payload
		.filter(
			(record) =>
				!record.effective_at || Date.parse(record.effective_at) <= asOfMs,
		)
		.map(normalizeCanonical)
		.sort((left, right) =>
			stableStringify(left).localeCompare(stableStringify(right)),
		);
	const payloadBytes = stableStringify(normalizedPayload);
	const manifest = {
		as_of: new Date(asOfMs).toISOString(),
		content_sha256: createHash("sha256").update(payloadBytes).digest("hex"),
		schema_version: schemaVersion,
		sort_version: sortVersion,
		source_id: sourceId,
	};
	const bytes = stableStringify(manifest);
	return {
		bytes,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		manifest,
		normalizedPayload,
	};
}
