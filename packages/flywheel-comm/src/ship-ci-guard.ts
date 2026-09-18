import { spawnSync } from "node:child_process";

const FULL_SHA = /^[0-9a-f]{40}$/;
const PR_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+(?:[/?#]|$)/;
const RUN_URL =
	/^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:[/?#]|$)/;
const CHECKS_NORMAL_STATUSES = new Set([0, 1, 8]);
const MATRIX_PLACEHOLDER = "Unit ($" + "{{ matrix.name }})";

export type ShipCiGuardResult =
	| {
			green: true;
			reason: "ci_green";
			mergeStateStatus: string;
			checks: string[];
	  }
	| {
			green: false;
			reason: "ci_not_green";
			detail: string;
			pending?: boolean;
	  };

class PendingCiError extends Error {}

export interface ShipCiCommandResult {
	stdout: string;
	status: number | null;
	signal: NodeJS.Signals | null;
	error?: Error;
}

export type ShipCiCommandRunner = (
	file: string,
	args: string[],
	options: { cwd: string; timeout: number },
) => ShipCiCommandResult;

const defaultRun: ShipCiCommandRunner = (file, args, options) => {
	const result = spawnSync(file, args, {
		cwd: options.cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: options.timeout,
	});
	return {
		stdout: result.stdout ?? "",
		status: result.status,
		signal: result.signal,
		error: result.error,
	};
};

interface RequiredJobsManifest {
	aggregate: string;
	aggregateScoped: string;
	required: string[];
}

function parseJson(result: ShipCiCommandResult, label: string): unknown {
	if (result.error || result.signal || result.status !== 0) {
		throw new Error(
			`${label} failed (status=${String(result.status)} signal=${String(result.signal)} error=${result.error?.message ?? "none"})`,
		);
	}
	return JSON.parse(result.stdout) as unknown;
}

function parseManifest(value: unknown): RequiredJobsManifest | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const row = value as Record<string, unknown>;
	if (
		row.schema !== 1 ||
		typeof row.aggregate !== "string" ||
		typeof row.aggregate_scoped !== "string" ||
		!Array.isArray(row.always) ||
		!Array.isArray(row.heavy) ||
		row.always.length !== 2 ||
		row.heavy.length !== 13 ||
		![...row.always, ...row.heavy].every(
			(name) => typeof name === "string" && name.length > 0,
		)
	) {
		return;
	}
	const all = [
		...(row.always as string[]),
		...(row.heavy as string[]),
		row.aggregate,
		row.aggregate_scoped,
	];
	if (new Set(all).size !== all.length) return;
	return {
		aggregate: row.aggregate,
		aggregateScoped: row.aggregate_scoped,
		required: [
			...(row.always as string[]),
			...(row.heavy as string[]),
			row.aggregate,
		],
	};
}

function rawAggregateName(workflow: string): string | undefined {
	let inAggregateJob = false;
	for (const line of workflow.split(/\r?\n/u)) {
		if (/^  ci-ok:\s*(?:#.*)?$/u.test(line)) {
			inAggregateJob = true;
			continue;
		}
		if (!inAggregateJob) continue;
		if (/^  [^\s][^:]*:/u.test(line)) return;
		const match = /^    name:\s*(.*?)\s*$/u.exec(line);
		if (!match) continue;
		const scalar = match[1]?.trim() ?? "";
		if (!scalar.startsWith("${{") || !scalar.endsWith("}}")) return;
		const expression = scalar.slice(3, -2).trim();
		return expression.length > 0 && expression.length <= 512
			? expression
			: undefined;
	}
	return undefined;
}

function timestamp(value: unknown): number | undefined {
	if (typeof value !== "string" || value.trim() === "") return;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function checkRows(value: unknown): Array<Record<string, unknown>> {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error("no checks were reported");
	}
	if (
		value.some((row) => !row || typeof row !== "object" || Array.isArray(row))
	) {
		throw new Error("checks response contains a malformed row");
	}
	return value as Array<Record<string, unknown>>;
}

function dedupeChecks(
	checks: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
	const undated: Array<Record<string, unknown>> = [];
	const latest = new Map<
		string,
		{ at: number; row: Record<string, unknown> }
	>();
	for (const row of checks) {
		const at = timestamp(row.startedAt);
		if (
			at === undefined ||
			typeof row.workflow !== "string" ||
			typeof row.name !== "string" ||
			typeof row.event !== "string"
		) {
			undated.push(row);
			continue;
		}
		const key = JSON.stringify([row.workflow, row.name, row.event]);
		const prior = latest.get(key);
		if (!prior || at > prior.at) latest.set(key, { at, row });
	}
	return [...undated, ...[...latest.values()].map(({ row }) => row)];
}

function allPass(checks: Array<Record<string, unknown>>): boolean {
	return checks.every((check) => check.bucket === "pass");
}

function exactJobMultiset(
	jobs: unknown,
	required: string[],
): jobs is Array<Record<string, unknown>> {
	if (!Array.isArray(jobs) || jobs.length !== required.length) return false;
	const counts = (names: string[]) => {
		const result = new Map<string, number>();
		for (const name of names) result.set(name, (result.get(name) ?? 0) + 1);
		return result;
	};
	const observedNames: string[] = [];
	for (const job of jobs) {
		if (
			!job ||
			typeof job !== "object" ||
			Array.isArray(job) ||
			typeof (job as Record<string, unknown>).name !== "string" ||
			(job as Record<string, unknown>).conclusion !== "success"
		) {
			return false;
		}
		observedNames.push((job as Record<string, unknown>).name as string);
	}
	const observed = counts(observedNames);
	const expected = counts(required);
	if (observed.size !== expected.size) return false;
	return [...expected].every(([name, count]) => observed.get(name) === count);
}

/**
 * Prove exact-head full CI before a ship gate opens or approval is consumed.
 * Unknown observations and command failures always fail closed.
 */
export function probeShipCiGreen(args: {
	cwd: string;
	prNumber?: number;
	expectedHead?: string;
	run?: ShipCiCommandRunner;
}): ShipCiGuardResult {
	const cwd = args.cwd.trim();
	if (!cwd) {
		return {
			green: false,
			reason: "ci_not_green",
			detail: "worktree path is missing",
		};
	}
	const expectedHead = args.expectedHead?.trim().toLowerCase();
	if (expectedHead && !FULL_SHA.test(expectedHead)) {
		return {
			green: false,
			reason: "ci_not_green",
			detail: "expected PR head is invalid",
		};
	}
	const selector =
		typeof args.prNumber === "number" &&
		Number.isSafeInteger(args.prNumber) &&
		args.prNumber > 0
			? [String(args.prNumber)]
			: [];
	const run = args.run ?? defaultRun;
	const options = { cwd, timeout: 15_000 };
	try {
		const view = parseJson(
			run(
				"gh",
				[
					"pr",
					"view",
					...selector,
					"--json",
					"headRefOid,mergeStateStatus,url",
				],
				options,
			),
			"gh pr view",
		) as Record<string, unknown>;
		const observedHead =
			typeof view.headRefOid === "string"
				? view.headRefOid.trim().toLowerCase()
				: "";
		const mergeStateStatus =
			typeof view.mergeStateStatus === "string"
				? view.mergeStateStatus.trim().toUpperCase()
				: "";
		const prMatch =
			typeof view.url === "string" ? PR_URL.exec(view.url.trim()) : null;
		if (!FULL_SHA.test(observedHead)) {
			throw new Error("GitHub returned no full PR head SHA");
		}
		if (expectedHead && observedHead !== expectedHead) {
			throw new Error(
				`GitHub PR head ${observedHead} != expected ${expectedHead}`,
			);
		}
		if (!mergeStateStatus || mergeStateStatus === "UNKNOWN") {
			throw new PendingCiError(
				`mergeStateStatus=${mergeStateStatus || "missing"}`,
			);
		}
		if (mergeStateStatus === "UNSTABLE" || mergeStateStatus === "DIRTY") {
			throw new Error(`mergeStateStatus=${mergeStateStatus || "missing"}`);
		}
		if (!prMatch) throw new Error("GitHub returned an invalid PR URL");
		const repository = prMatch[1] as string;

		const checksResult = run(
			"gh",
			[
				"pr",
				"checks",
				...selector,
				"--json",
				"bucket,name,state,workflow,link,startedAt,event",
			],
			options,
		);
		if (
			checksResult.error ||
			checksResult.signal ||
			checksResult.status === null ||
			!CHECKS_NORMAL_STATUSES.has(checksResult.status)
		) {
			throw new Error(
				`gh pr checks did not terminate normally (status=${String(checksResult.status)} signal=${String(checksResult.signal)} error=${checksResult.error?.message ?? "none"})`,
			);
		}
		const checks = dedupeChecks(
			checkRows(JSON.parse(checksResult.stdout) as unknown),
		);
		const ciOkRows = checks.filter((check) => check.name === "CI OK");
		if (ciOkRows.length === 0) {
			if (
				checksResult.status === 8 ||
				checks.some((check) => check.bucket === "pending")
			) {
				throw new PendingCiError("not all reported checks have completed");
			}
			if (checksResult.status !== 0 || !allPass(checks)) {
				throw new Error("not all reported checks passed");
			}
			return {
				green: true,
				reason: "ci_green",
				mergeStateStatus,
				checks: checks.map((check) => String(check.name ?? "unknown")),
			};
		}

		const manifestResult = run(
			"git",
			["show", `${observedHead}:.github/ci-required-jobs.json`],
			options,
		);
		let manifest: RequiredJobsManifest | undefined;
		if (
			!manifestResult.error &&
			!manifestResult.signal &&
			manifestResult.status === 0
		) {
			try {
				manifest = parseManifest(JSON.parse(manifestResult.stdout) as unknown);
			} catch {
				manifest = undefined;
			}
		}
		if (!manifest) {
			if (
				checksResult.status === 8 ||
				checks.some((check) => check.bucket === "pending")
			) {
				throw new PendingCiError("legacy checks have not completed");
			}
			if (checksResult.status !== 0 || !allPass(checks)) {
				throw new Error(
					"full CI manifest unavailable and legacy checks are not all pass",
				);
			}
			return {
				green: true,
				reason: "ci_green",
				mergeStateStatus,
				checks: checks.map((check) => String(check.name ?? "unknown")),
			};
		}

		const datedCiOk = ciOkRows
			.map((row) => ({ row, at: timestamp(row.startedAt) }))
			.filter(
				(entry): entry is { row: Record<string, unknown>; at: number } =>
					entry.at !== undefined,
			)
			.sort((left, right) => right.at - left.at);
		const latest = datedCiOk[0];
		if (!latest || latest.row.bucket !== "pass") {
			if (checksResult.status === 8 || latest?.row.bucket === "pending") {
				throw new PendingCiError("latest CI OK has not completed");
			}
			throw new Error("latest CI OK is missing, undated, or not pass");
		}
		const runMatch =
			typeof latest.row.link === "string"
				? RUN_URL.exec(latest.row.link.trim())
				: null;
		if (!runMatch || runMatch[1] !== repository) {
			throw new Error("latest CI OK link is not a run in the PR repository");
		}
		const runId = runMatch[2] as string;
		const runView = parseJson(
			run("gh", ["api", `repos/${repository}/actions/runs/${runId}`], options),
			"full CI run API",
		) as Record<string, unknown>;
		const runRepository = runView.repository as
			| Record<string, unknown>
			| undefined;
		const headRepository = runView.head_repository as
			| Record<string, unknown>
			| undefined;
		if (
			runView.head_sha !== observedHead ||
			runView.event !== "pull_request" ||
			runView.path !== ".github/workflows/ci.yml" ||
			runView.status !== "completed" ||
			runView.conclusion !== "success" ||
			runRepository?.full_name !== repository ||
			headRepository?.full_name !== repository
		) {
			throw new Error("latest CI OK run does not match exact-head full CI");
		}

		const jobsPage = parseJson(
			run(
				"gh",
				[
					"api",
					`repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
				],
				options,
			),
			"full CI jobs API",
		) as Record<string, unknown>;
		if (
			typeof jobsPage.total_count !== "number" ||
			jobsPage.total_count > 100 ||
			!Array.isArray(jobsPage.jobs) ||
			jobsPage.total_count !== jobsPage.jobs.length ||
			!exactJobMultiset(jobsPage.jobs, manifest.required)
		) {
			throw new Error(
				"latest CI attempt is not the exact full-success job set",
			);
		}
		const workflowResult = run(
			"git",
			["show", `${observedHead}:.github/workflows/ci.yml`],
			options,
		);
		const aggregateRaw =
			!workflowResult.error &&
			!workflowResult.signal &&
			workflowResult.status === 0
				? rawAggregateName(workflowResult.stdout)
				: undefined;
		const legacyExceptionNames = new Set([
			manifest.aggregateScoped,
			MATRIX_PLACEHOLDER,
			...(aggregateRaw ? [aggregateRaw] : []),
		]);

		for (const check of checks) {
			if (check === latest.row || check.bucket === "pass") continue;
			const at = timestamp(check.startedAt);
			const linkMatch =
				typeof check.link === "string" ? RUN_URL.exec(check.link.trim()) : null;
			if (
				typeof check.name !== "string" ||
				!legacyExceptionNames.has(check.name) ||
				at === undefined ||
				at >= latest.at ||
				!new Set(["skipping", "cancel", "pass"]).has(String(check.bucket)) ||
				!linkMatch ||
				linkMatch[1] !== repository ||
				linkMatch[2] === runId
			) {
				throw new Error(
					`check ${String(check.name ?? "unknown")} is ${String(check.bucket ?? check.state ?? "unknown")}`,
				);
			}
		}

		return {
			green: true,
			reason: "ci_green",
			mergeStateStatus,
			checks: checks.map((check) => String(check.name ?? "unknown")),
		};
	} catch (err) {
		return {
			green: false,
			reason: "ci_not_green",
			detail: err instanceof Error ? err.message : String(err),
			...(err instanceof PendingCiError ? { pending: true } : {}),
		};
	}
}
