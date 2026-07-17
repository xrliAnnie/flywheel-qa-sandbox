import {
	buildCiIntervals,
	buildGateIntervals,
	buildInfraIntervals,
	buildReviewIntervals,
	buildReworkIntervals,
	buildSessionIntervals,
} from "./extract.mjs";
import { segmentIssue } from "./segment.mjs";
import {
	buildLoadOverlays,
	buildNightOverlays,
	parseSqliteUtc,
} from "./time.mjs";
import { validateIntervals, validateReport } from "./validate.mjs";

const evidence = (source, key, summary) => [{ source, key, summary }];

export function buildAutoQaIntervals(rows, asOf) {
	return rows
		.filter((row) => parseSqliteUtc(row.started_at) < asOf)
		.flatMap((row) => {
			const start_ms = parseSqliteUtc(row.started_at);
			const completed = row.completed_at
				? parseSqliteUtc(row.completed_at)
				: null;
			const end_ms = completed !== null && completed <= asOf ? completed : null;
			if (end_ms !== null && end_ms <= start_ms) return [];
			return [
				{
					source: "teamlead",
					kind: "qa_run",
					label: "qa_running",
					issue: row.issue_id,
					execId: row.qa_execution_id,
					start_ms,
					end_ms,
					state:
						completed === null || completed > asOf
							? "open"
							: row.status === "passed"
								? "ok"
								: "failed",
					allow_overlap: true,
					evidence: evidence(
						"teamlead",
						`auto_qa_record:${row.parent_execution_id}:${row.target_pr_head_sha}`,
						`auto QA ${row.status}`,
					),
				},
			];
		});
}

function buildHeadChanges(bundle) {
	const changes = [];
	for (const issue of bundle.issues) {
		const runs = [...(bundle.github.runsByIssue[issue] ?? [])].sort(
			(a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
		);
		let previousHead = null;
		for (const run of runs) {
			if (previousHead && run.headSha && run.headSha !== previousHead) {
				changes.push({
					issue_identifier: issue,
					from_sha: previousHead,
					at: run.createdAt,
				});
			}
			if (run.headSha) previousHead = run.headSha;
		}
	}
	for (const event of bundle.team.events) {
		if (event.event_type === "ship_gate_superseded") {
			changes.push({
				issue_identifier: event.issue_id,
				from_sha: null,
				at: event.ts,
			});
		}
	}
	return changes;
}

function buildIdleHints(bundle, sessionByExec) {
	const hints = [];
	for (const wake of bundle.comm.wakes) {
		const session = sessionByExec.get(wake.execution_id);
		if (!session) continue;
		const end = wake.started_at ?? wake.finished_at ?? bundle.asOf;
		if (end <= wake.queued_at) continue;
		hints.push({
			issue: session.issue_identifier,
			start_ms: wake.queued_at,
			end_ms: Math.min(end, bundle.asOf),
			sublabel: "park_wake",
			evidence: evidence(
				"commdb",
				`runner_phase_wake:queue_seq=${wake.queue_seq}`,
				`phase wake ${wake.state}`,
			),
		});
	}

	for (const issue of bundle.issues) {
		const sessions = bundle.team.sessions
			.filter((session) => session.issue_identifier === issue)
			.sort(
				(a, b) => parseSqliteUtc(a.started_at) - parseSqliteUtc(b.started_at),
			);
		for (let index = 0; index < sessions.length - 1; index += 1) {
			const current = sessions[index];
			const next = sessions[index + 1];
			const completedEvent = bundle.team.events
				.filter(
					(event) =>
						event.execution_id === current.execution_id &&
						event.event_type === "session_completed",
				)
				.sort((a, b) => parseSqliteUtc(b.ts) - parseSqliteUtc(a.ts))[0];
			const currentEnd = current.terminal_at
				? parseSqliteUtc(current.terminal_at)
				: completedEvent
					? parseSqliteUtc(completedEvent.ts)
					: null;
			const nextStart = parseSqliteUtc(next.started_at);
			if (currentEnd === null || currentEnd >= nextStart) continue;
			hints.push({
				issue,
				start_ms: currentEnd,
				end_ms: nextStart,
				sublabel: "phase_handoff",
				evidence: evidence(
					"teamlead",
					`handoff:${current.execution_id}:${next.execution_id}`,
					`${current.session_role} terminal to ${next.session_role} start`,
				),
			});
		}
	}
	return hints;
}

function coverageFor(issue, t0, end, bundle) {
	const definitions = [
		["linear", "lifecycle", bundle.status.linear],
		["teamlead", "session_review_qa", bundle.status.teamlead],
		["commdb", "gate_wake", bundle.status.commdb],
		["gh", "pr_ci", bundle.status.gh],
	];
	const coverage = definitions.map(([source, authoritative_kind, status]) => ({
		source,
		authoritative_kind,
		status: status === "ok" ? "ok" : "failed",
		covered: status === "ok" ? [{ start_ms: t0, end_ms: end }] : [],
		note:
			status === "ok"
				? `${source} query completed at fixed as-of`
				: `${source} source unavailable`,
	}));
	coverage.push({
		source: "system-health",
		authoritative_kind: "load",
		status: bundle.health.status,
		covered:
			bundle.health.status === "failed" ? [] : [{ start_ms: t0, end_ms: end }],
		note: bundle.health.note,
	});
	if (!bundle.linear[issue]) {
		const linear = coverage.find((item) => item.source === "linear");
		linear.status = "failed";
		linear.covered = [];
		linear.note = "issue missing from Linear response";
	}
	return coverage;
}

export function clipIntervals(intervals, t0, end, closed) {
	return intervals.flatMap((interval) => {
		const rawEnd = interval.end_ms;
		const start_ms = Math.max(interval.start_ms, t0);
		if (start_ms >= end || (rawEnd !== null && rawEnd <= t0)) return [];
		let end_ms = rawEnd === null ? null : Math.min(rawEnd, end);
		let state = interval.state;
		if (rawEnd === null && closed) {
			end_ms = end;
			state = "superseded";
		}
		return [
			{
				...interval,
				start_ms,
				end_ms,
				state,
				allow_overlap: interval.allow_overlap ?? false,
			},
		];
	});
}

function spanDuration(interval, end) {
	return Math.max(0, (interval.end_ms ?? end) - interval.start_ms);
}

export function analyzeSources(bundle) {
	const sessionByExec = new Map(
		bundle.team.sessions.map((session) => [session.execution_id, session]),
	);
	const sessionTerminals = bundle.team.sessions.map((session) => ({
		execution_id: session.execution_id,
		terminal_at: session.terminal_at,
	}));
	const headChanges = buildHeadChanges(bundle);
	const sessionIntervals = buildSessionIntervals(
		bundle.team.sessions,
		bundle.team.events,
		bundle.asOf,
	);
	const { intervals: reviewIntervals, delivery_latencies } =
		buildReviewIntervals(bundle.team.reviews, bundle.asOf);
	const reworkIntervals = buildReworkIntervals({
		reviewRows: bundle.team.reviews,
		eventRows: bundle.team.events,
		qaSessions: bundle.team.sessions.filter(
			(session) => session.session_role === "qa",
		),
		asOf: bundle.asOf,
	});
	const gateIntervals = buildGateIntervals({
		questions: bundle.comm.questions,
		responses: bundle.comm.responses,
		sessionTerminals,
		headChanges,
		asOf: bundle.asOf,
	});
	const infraIntervals = buildInfraIntervals({
		allProjectSessions: bundle.team.sessions,
		sampleIssues: bundle.issues,
		asOf: bundle.asOf,
	});
	const autoQaIntervals = buildAutoQaIntervals(
		bundle.team.qaRecords,
		bundle.asOf,
	);
	const idleHints = buildIdleHints(bundle, sessionByExec);
	const reports = [];
	const diagnostics = {};

	for (const issue of bundle.issues) {
		const lifecycle = bundle.linear[issue];
		if (!lifecycle || bundle.status.linear !== "ok") {
			reports.push({
				kind: "no_verdict",
				issue,
				as_of: bundle.asOf,
				failed_sources: [{ source: "linear", kind: "lifecycle" }],
				notes: ["Linear lifecycle unavailable"],
			});
			continue;
		}
		const t0 = Date.parse(lifecycle.createdAt);
		const completed = lifecycle.completedAt
			? Date.parse(lifecycle.completedAt)
			: null;
		const closed = completed !== null && completed <= bundle.asOf;
		const end = closed ? completed : bundle.asOf;
		const ciIntervals = buildCiIntervals(
			bundle.github.runsByIssue[issue] ?? [],
			{
				issue,
				asOf: bundle.asOf,
				requiredWorkflows: ["CI"],
			},
		);
		const allIntervals = [
			...sessionIntervals,
			...reviewIntervals,
			...reworkIntervals,
			...gateIntervals,
			...infraIntervals,
			...autoQaIntervals,
			...ciIntervals,
		].filter((interval) => interval.issue === issue);
		const intervals = clipIntervals(allIntervals, t0, end, closed);
		validateIntervals(intervals, t0, end);
		const coverage = coverageFor(issue, t0, end, bundle);
		const report = segmentIssue({
			issue,
			t0,
			end: closed ? completed : null,
			asOf: bundle.asOf,
			intervals,
			coverage,
			idleHints: idleHints
				.filter((hint) => hint.issue === issue)
				.map((hint) => ({
					...hint,
					start_ms: Math.max(hint.start_ms, t0),
					end_ms: Math.min(hint.end_ms, end),
				}))
				.filter((hint) => hint.end_ms > hint.start_ms),
		});
		if (report.kind === "analyzed") {
			report.overlays = [
				{
					kind: "night",
					intervals: buildNightOverlays(t0, end, "America/Los_Angeles"),
				},
				...buildLoadOverlays(bundle.health.logText, {
					start_ms: t0,
					end_ms: end,
					timezone: "America/Los_Angeles",
					threshold: 30,
				}),
			];
		}
		validateReport(report);
		reports.push(report);
		diagnostics[issue] = {
			pr_count: (bundle.github.prsByIssue[issue] ?? []).length,
			ci_rounds: ciIntervals.length,
			ci_raw_ms: ciIntervals.reduce(
				(sum, interval) => sum + spanDuration(interval, end),
				0,
			),
			review_rounds: reviewIntervals.filter(
				(interval) => interval.issue === issue,
			).length,
			review_delivery_latency_ms: delivery_latencies
				.filter((item) => item.issue === issue)
				.reduce((sum, item) => sum + item.duration_ms, 0),
			qa_sessions: sessionIntervals.filter(
				(interval) =>
					interval.issue === issue && interval.label === "qa_running",
			).length,
		};
	}
	return { reports, diagnostics };
}

function reportDuration(reports, predicate) {
	return reports
		.filter((report) => report.kind === "analyzed")
		.flatMap((report) => report.segments)
		.filter((segment) => !segment.in_flight && predicate(segment))
		.reduce((sum, segment) => sum + segment.end_ms - segment.start_ms, 0);
}

function compactDuration(ms) {
	if (!Number.isFinite(ms) || ms <= 0) return "0m";
	const minutes = Math.round(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export function buildSuggestions(reports, diagnostics) {
	const ci = reportDuration(
		reports,
		(segment) => segment.label === "ci_waiting",
	);
	const rework = reportDuration(
		reports,
		(segment) => segment.label === "rework_loop",
	);
	const handoff = reportDuration(
		reports,
		(segment) =>
			segment.label === "idle_gap" &&
			["phase_handoff", "park_wake"].includes(segment.sublabel),
	);
	const infra = reportDuration(
		reports,
		(segment) => segment.label === "infra_incident",
	);
	const ciRounds = Object.values(diagnostics).reduce(
		(sum, item) => sum + item.ci_rounds,
		0,
	);
	const reviewRounds = Object.values(diagnostics).reduce(
		(sum, item) => sum + item.review_rounds,
		0,
	);
	return [
		{
			id: "halve-ci",
			title: "CI 分层 + 并行，把单轮墙钟砍半",
			saving: `0–${compactDuration(ci / 2)}`,
			cost: "M",
			rationale: `${ciRounds} 轮 CI；上界按本报告中 CI 主导墙钟的 50% 计算。`,
		},
		{
			id: "minimize-head-churn",
			title: "冻结 review/QA head，减少 churn 重跑",
			saving: `0–${compactDuration(ci)}`,
			cost: "S",
			rationale:
				"每次 head 变化都会重新触发 CI；上界为本样本全部 CI 主导墙钟。",
		},
		{
			id: "review-loop",
			title: "把高耦合 review 发现前移，减少串行返工轮",
			saving: `0–${compactDuration(rework)}`,
			cost: "M",
			rationale: `${reviewRounds} 个 cross-family review job；上界为已测返工主导墙钟。`,
		},
		{
			id: "handoff-gap",
			title: "自动接力 phase handoff / park wake",
			saving: `0–${compactDuration(handoff)}`,
			cost: "S",
			rationale:
				"上界只取已测 phase_handoff + park_wake 空转段，不含 backlog 或人工 gate。",
		},
		{
			id: "infra-recovery",
			title: "重启与 TURN/gate 恢复改成事务化续跑",
			saving: `0–${compactDuration(infra)}`,
			cost: "L",
			rationale: "上界仅取满足三-session 同指纹聚类的基建事故墙钟。",
		},
		{
			id: "doc-only-fast-path",
			title: "Doc-only head 走轻量 review/CI 路径",
			saving: "无法测量",
			cost: "M",
			rationale:
				"当前快照没有逐 head 文件类型分类；先采集再决定，不能用猜测替代。",
		},
		{
			id: "concurrency-telemetry",
			title: "持续采集并发 × load × 周期时间",
			saving: "本次无法定量",
			cost: "S",
			rationale: "本批次不满足每档 ≥60 分钟且 ≥2 个独立 issue 的门槛。",
		},
	];
}
