#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import BetterSqlite3 from "better-sqlite3";
import {
	parseWorkflowScorecardPoolCapacityConfig,
	readWorkflowScorecardReport,
	type WorkflowScorecardReport,
} from "./workflow-scorecard-report.js";

function iso(value: string | undefined, name: string): string {
	if (!value || !Number.isFinite(Date.parse(value)))
		throw new Error(`${name} must be an ISO timestamp`);
	return new Date(value).toISOString();
}

function integer(
	value: string | undefined,
	name: string,
	minimum: number,
	maximum: number,
	defaultValue: number,
): number {
	if (value === undefined) return defaultValue;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
		throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
	return parsed;
}

function text(report: WorkflowScorecardReport): string {
	const lines = [
		`workflow scorecard project=${report.project} issues=${report.issueCount} degraded=${report.degradedCount}`,
		`cohort=[${report.from}, ${report.to}) as_of=${report.asOf} unit=${report.unit} qa_filter=${report.qaFilter}`,
	];
	if (report.crossVendorUnitIncomparable)
		lines.push(
			"warning=cross-provider token counts are not equivalent billing units",
		);
	for (const provider of report.providerConsumption) {
		lines.push(
			`provider/${provider.vendor} tokens=${provider.tokens} accounts=${provider.accountCount ?? "unconfigured"} capacity_units=${provider.capacityUnits ?? "unconfigured"} weekly_pool_capacity=${provider.weeklyPoolCapacity ?? "unconfigured"} weekly_pool_used_percent=${provider.weeklyPoolUsedPercent ?? "missing"} coverage_complete=${provider.coverageComplete}`,
		);
	}
	for (const group of report.groups) {
		lines.push(
			`${group.axis}/${group.group} policy=${group.policyVersion ?? "n/a"} issues=${group.issueCount} terminal=${group.terminalCount} open=${group.openCount} assigned_before_exclusions=${group.assignedIssueCountBeforeExclusions} degraded_from_arm=${group.degradedFromThisArm}/${group.assignedIssueCountBeforeExclusions} qa_first_pass=${group.qaFirstPass.numerator}/${group.qaFirstPass.denominator} founder_reject=${group.founderReject.numerator}/${group.founderReject.denominator} tokens_per_first_pass=${group.tokensPerFirstPassIssue ?? "missing"} mean_node_work_ms=${group.meanNodeWorkMs ?? "missing"} mean_elapsed_ms=${group.meanElapsedMs ?? "missing"}`,
		);
	}
	for (const issue of report.issues) {
		lines.push(
			`${issue.issueId} canonical=${issue.canonicalIssueId} runs=${issue.runIds.join(",")} qa_first_pass=${issue.qaFirstPass ?? "unknown"} founder_rejects=${issue.founderRejectCount ?? "missing"} tokens=${issue.totalTokens ?? "missing"} node_work_ms=${issue.nodeWorkMs ?? "missing"} elapsed_ms=${issue.elapsedMs ?? "missing"} degraded=${issue.degraded}`,
		);
	}
	return `${lines.join("\n")}\n`;
}

export function runWorkflowScorecardCli(
	argv: string[],
	io: { stdout: (value: string) => void; stderr: (value: string) => void } = {
		stdout: (value) => process.stdout.write(value),
		stderr: (value) => process.stderr.write(value),
	},
): number {
	try {
		const command = argv[0];
		if (command !== "report" && command !== "issue")
			throw new Error("command must be report or issue");
		const { values } = parseArgs({
			args: argv.slice(1),
			options: {
				db: { type: "string" },
				project: { type: "string" },
				from: { type: "string" },
				to: { type: "string" },
				"as-of": { type: "string" },
				issue: { type: "string" },
				qa: { type: "string", default: "all" },
				limit: { type: "string" },
				offset: { type: "string" },
				format: { type: "string", default: "text" },
				"pool-capacity-config": { type: "string" },
				"dry-run": { type: "boolean", default: false },
			},
			strict: true,
		});
		if (!values.db || !values.project)
			throw new Error("--db and --project are required");
		if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(values.project))
			throw new Error("--project is invalid");
		if (command === "issue" && !values.issue)
			throw new Error("issue requires --issue");
		if (
			values.issue &&
			!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(values.issue)
		)
			throw new Error("--issue is invalid");
		if (values.format !== "json" && values.format !== "text")
			throw new Error("--format must be json or text");
		if (values.qa !== "all" && values.qa !== "eligible")
			throw new Error("--qa must be all or eligible");
		const qa = values.qa === "eligible" ? "eligible" : "all";
		const detailLimit = integer(values.limit, "--limit", 1, 1_000, 100);
		const detailOffset = integer(
			values.offset,
			"--offset",
			0,
			Number.MAX_SAFE_INTEGER,
			0,
		);
		const asOf = iso(values["as-of"] ?? new Date().toISOString(), "--as-of");
		const from = iso(values.from ?? "1970-01-01T00:00:00.000Z", "--from");
		const to = iso(
			values.to ?? new Date(Date.parse(asOf) + 1).toISOString(),
			"--to",
		);
		if (Date.parse(from) >= Date.parse(to))
			throw new Error("--from must be before --to");
		const db = new BetterSqlite3(values.db, {
			readonly: true,
			fileMustExist: true,
			timeout: 2_000,
		});
		try {
			const poolCapacity = values["pool-capacity-config"]
				? parseWorkflowScorecardPoolCapacityConfig(
						JSON.parse(readFileSync(values["pool-capacity-config"], "utf8")),
					)
				: undefined;
			const required = [
				"workflow_run",
				"workflow_run_issue_alias",
				"workflow_run_event",
				"workflow_claims",
				"workflow_gate_holder",
				"ship_judgment_outcome",
				"workflow_execution_runtime",
				"workflow_execution_binding",
				"workflow_scorecard_activation",
				"workflow_scorecard_turn",
				"workflow_scorecard_usage",
				"workflow_scorecard_cursor",
			];
			const found = new Set(
				(
					db
						.prepare(
							`SELECT name FROM sqlite_master
							  WHERE type = 'table' AND name IN (${required.map(() => "?").join(",")})`,
						)
						.all(...required) as Array<{ name: string }>
				).map((row) => row.name),
			);
			if (required.some((name) => !found.has(name)))
				throw new Error("unavailable_schema");
			const report = db.transaction(() =>
				readWorkflowScorecardReport(db, {
					project: values.project!,
					from,
					to,
					asOf,
					qa,
					detailLimit,
					detailOffset,
					...(poolCapacity ? { poolCapacity } : {}),
					...(values.issue ? { issue: values.issue } : {}),
				}),
			)();
			io.stdout(
				values.format === "json"
					? `${JSON.stringify(report, null, 2)}\n`
					: text(report),
			);
			return 0;
		} finally {
			db.close();
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		io.stderr(`${message}\n`);
		return /required|command|format|--from|--project|--issue|--qa|--limit|--offset|ISO timestamp/.test(
			message,
		)
			? 2
			: 1;
	}
}

if (process.argv[1]?.endsWith("workflow-scorecard-cli.js")) {
	process.exitCode = runWorkflowScorecardCli(process.argv.slice(2));
}
