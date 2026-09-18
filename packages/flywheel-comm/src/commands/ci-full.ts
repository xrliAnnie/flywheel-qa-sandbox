import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { withMkdirLock } from "flywheel-config";
import { probeShipCiGreen } from "../ship-ci-guard.js";

const FULL_SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PR_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#]|$)/;
const RUNNING = new Set([
	"queued",
	"in_progress",
	"waiting",
	"requested",
	"pending",
]);
const FAILURE_CONCLUSIONS = new Set([
	"failure",
	"timed_out",
	"startup_failure",
]);

export interface CiFullCommandResult {
	stdout: string;
	status: number | null;
	signal: NodeJS.Signals | null;
	error?: Error;
}

export type CiFullCommandRunner = (
	file: string,
	args: string[],
	options: { cwd: string; timeout: number },
) => CiFullCommandResult;

export interface CiFullOptions {
	cwd: string;
	pr?: number;
	head?: string;
	retryLost?: boolean;
}

export interface CiFullOutcome {
	exitCode: 0 | 1 | 2 | 8;
	status: string;
	detail?: string;
	runId?: number;
	url?: string;
	recovery?: string;
}

export interface CiFullDeps {
	run?: CiFullCommandRunner;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	stateDir?: string;
	env?: Record<string, string | undefined>;
	withLock?: (
		path: string,
		fn: () => Promise<CiFullOutcome>,
	) => Promise<CiFullOutcome>;
}

interface RequiredJobsManifest {
	aggregate: string;
	aggregateScoped: string;
	always: string[];
	heavy: string[];
	required: string[];
}

interface Receipt {
	schema: 1;
	head: string;
	pr: number;
	state: "intent" | "labeled" | "aborted_head_moved";
	requested_at: string;
	requester_exec_id: string;
	lost_retries: 0 | 1;
	reran: number[];
}

interface PrView {
	number: number;
	head: string;
	repository: string;
	labels: string[];
}

interface RunObservation {
	id: number;
	status: string;
	conclusion: string | null;
	displayTitle: string;
	createdAt: string;
	url: string;
	attempt: number;
	epoch: number;
	jobs: Array<Record<string, unknown>>;
	fullShape: boolean;
	scopedShape: boolean;
	shapePending: boolean;
}

const defaultRun: CiFullCommandRunner = (file, args, options) => {
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

const success = (result: CiFullCommandResult, label: string): string => {
	if (result.error || result.signal || result.status !== 0) {
		throw new Error(
			`${label} failed (status=${String(result.status)} signal=${String(result.signal)} error=${result.error?.message ?? "none"})`,
		);
	}
	return result.stdout;
};

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
	const always = row.always as string[];
	const heavy = row.heavy as string[];
	const names = [...always, ...heavy, row.aggregate, row.aggregate_scoped];
	if (new Set(names).size !== names.length) return;
	return {
		aggregate: row.aggregate,
		aggregateScoped: row.aggregate_scoped,
		always,
		heavy,
		required: [...always, ...heavy, row.aggregate],
	};
}

function exactSuccessJobs(
	jobs: Array<Record<string, unknown>>,
	required: string[],
): boolean {
	if (jobs.length !== required.length) return false;
	const count = (names: string[]) => {
		const result = new Map<string, number>();
		for (const name of names) result.set(name, (result.get(name) ?? 0) + 1);
		return result;
	};
	const observed: string[] = [];
	for (const job of jobs) {
		if (typeof job.name !== "string" || job.conclusion !== "success")
			return false;
		observed.push(job.name);
	}
	const left = count(observed);
	const right = count(required);
	return (
		left.size === right.size &&
		[...right].every(([name, amount]) => left.get(name) === amount)
	);
}

function atomicWrite(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value)}\n`, {
		encoding: "utf8",
		mode: 0o600,
		flag: "wx",
	});
	renameSync(temporary, path);
}

function readReceipt(
	path: string,
	head: string,
	pr: number,
): Receipt | undefined {
	if (!existsSync(path)) return;
	const value = JSON.parse(readFileSync(path, "utf8")) as Partial<Receipt>;
	if (
		value.schema !== 1 ||
		value.head !== head ||
		value.pr !== pr ||
		!new Set(["intent", "labeled", "aborted_head_moved"]).has(
			String(value.state),
		) ||
		typeof value.requested_at !== "string" ||
		!Number.isFinite(Date.parse(value.requested_at)) ||
		typeof value.requester_exec_id !== "string" ||
		(value.lost_retries !== 0 && value.lost_retries !== 1) ||
		!Array.isArray(value.reran) ||
		!value.reran.every(
			(id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0,
		)
	) {
		throw new Error("receipt_invalid");
	}
	return value as Receipt;
}

function parsePrView(value: unknown): PrView {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("PR view is malformed");
	}
	const row = value as Record<string, unknown>;
	const match = typeof row.url === "string" ? PR_URL.exec(row.url) : null;
	const head =
		typeof row.headRefOid === "string" ? row.headRefOid.toLowerCase() : "";
	if (
		!match ||
		!REPOSITORY.test(match[1] ?? "") ||
		!Number.isSafeInteger(row.number) ||
		Number(row.number) <= 0 ||
		row.state !== "OPEN" ||
		row.isCrossRepository !== false ||
		!FULL_SHA.test(head)
	) {
		throw new Error(
			"PR must be open, same-repository, and have a full head SHA",
		);
	}
	const labels = Array.isArray(row.labels)
		? row.labels.flatMap((label) =>
				label &&
				typeof label === "object" &&
				typeof (label as Record<string, unknown>).name === "string"
					? [(label as Record<string, unknown>).name as string]
					: [],
			)
		: [];
	return {
		number: Number(row.number),
		head,
		repository: match[1] as string,
		labels,
	};
}

function outcome(
	exitCode: CiFullOutcome["exitCode"],
	status: string,
	extra: Omit<CiFullOutcome, "exitCode" | "status"> = {},
): CiFullOutcome {
	return { exitCode, status, ...extra };
}

function manifestAbsentAtHead(
	run: CiFullCommandRunner,
	cwd: string,
	head: string,
): boolean {
	const path = ".github/ci-required-jobs.json";
	const result = run(
		"git",
		["ls-tree", "-r", "--name-only", head, "--", path],
		{ cwd, timeout: 15_000 },
	);
	if (result.error || result.signal || result.status !== 0) return false;
	return !result.stdout
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.includes(path);
}

/** Ensure that one exact PR head has one full-matrix request and a green result. */
export async function ensureFullCi(
	options: CiFullOptions,
	deps: CiFullDeps = {},
): Promise<CiFullOutcome> {
	const cwd = options.cwd.trim();
	const run = deps.run ?? defaultRun;
	const now = deps.now ?? Date.now;
	const sleep =
		deps.sleep ??
		((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
	const env = deps.env ?? process.env;
	const stateDir =
		deps.stateDir ??
		env.FLYWHEEL_STATE_DIR?.trim() ??
		join(homedir(), ".flywheel", "state");
	const lock =
		deps.withLock ??
		((path: string, fn: () => Promise<CiFullOutcome>) =>
			withMkdirLock(path, fn, { timeoutMs: 5_000 }));
	const commandOptions = { cwd, timeout: 15_000 };
	if (!cwd)
		return outcome(2, "invalid_arguments", { detail: "cwd is missing" });

	let requestedHead = options.head?.trim().toLowerCase();
	try {
		if (!requestedHead) {
			requestedHead = success(
				run("git", ["rev-parse", "HEAD"], commandOptions),
				"git rev-parse HEAD",
			)
				.trim()
				.toLowerCase();
		}
		if (!FULL_SHA.test(requestedHead)) {
			return outcome(2, "invalid_arguments", { detail: "head must be 40-hex" });
		}
		const headSha = requestedHead;
		const selector = options.pr ? [String(options.pr)] : [];
		const readPr = (): PrView =>
			parsePrView(
				JSON.parse(
					success(
						run(
							"gh",
							[
								"pr",
								"view",
								...selector,
								"--json",
								"number,state,isCrossRepository,headRefOid,url,labels",
							],
							commandOptions,
						),
						"gh pr view",
					),
				) as unknown,
			);
		const initialPr = readPr();
		if (options.pr !== undefined && initialPr.number !== options.pr) {
			return outcome(2, "pr_mismatch");
		}
		if (initialPr.head !== headSha) {
			return outcome(2, "head_mismatch", {
				detail: `PR head ${initialPr.head} != requested ${headSha}`,
			});
		}
		const safeRepo = initialPr.repository.replace("/", "__");
		const root = join(stateDir, "ci-full");
		const receiptPath = join(
			root,
			safeRepo,
			String(initialPr.number),
			`${headSha}.json`,
		);
		const lockParent = join(root, "locks");
		mkdirSync(lockParent, { recursive: true, mode: 0o700 });
		const lockPath = join(lockParent, `${safeRepo}__${initialPr.number}.lock`);

		try {
			return await lock(lockPath, async () => {
				const manifestResult = run(
					"git",
					["show", `${headSha}:.github/ci-required-jobs.json`],
					commandOptions,
				);
				let manifest: RequiredJobsManifest | undefined;
				try {
					manifest = parseManifest(
						JSON.parse(
							success(manifestResult, "required-jobs manifest"),
						) as unknown,
					);
				} catch {
					manifest = undefined;
				}
				if (!manifest) {
					const manifestReadFailed =
						Boolean(manifestResult.error) ||
						Boolean(manifestResult.signal) ||
						manifestResult.status !== 0;
					if (manifestReadFailed && manifestAbsentAtHead(run, cwd, headSha)) {
						const legacy = probeShipCiGreen({
							cwd,
							prNumber: initialPr.number,
							expectedHead: headSha,
							run,
						});
						if (legacy.green) return outcome(0, "legacy_ci_green");
						return legacy.pending
							? outcome(8, "legacy_ci_pending", { detail: legacy.detail })
							: outcome(1, "legacy_ci_not_green", { detail: legacy.detail });
					}
					return outcome(2, "manifest_invalid");
				}

				let receipt: Receipt | undefined;
				try {
					receipt = readReceipt(receiptPath, headSha, initialPr.number);
				} catch {
					return outcome(2, "receipt_invalid");
				}

				const observeRuns = (): RunObservation[] => {
					const listed = JSON.parse(
						success(
							run(
								"gh",
								[
									"run",
									"list",
									"--workflow",
									"ci.yml",
									"--commit",
									headSha,
									"--event",
									"pull_request",
									"--limit",
									"50",
									"--json",
									"databaseId,status,conclusion,displayTitle,createdAt,url,attempt",
								],
								commandOptions,
							),
							"gh run list",
						),
					) as unknown;
					if (!Array.isArray(listed) || listed.length >= 50) {
						throw new Error("too_many_runs");
					}
					return listed.map((value) => {
						if (!value || typeof value !== "object" || Array.isArray(value)) {
							throw new Error("run list row malformed");
						}
						const row = value as Record<string, unknown>;
						const id = Number(row.databaseId);
						if (!Number.isSafeInteger(id) || id <= 0) {
							throw new Error("run id malformed");
						}
						const runView = JSON.parse(
							success(
								run(
									"gh",
									["api", `repos/${initialPr.repository}/actions/runs/${id}`],
									commandOptions,
								),
								"run API",
							),
						) as Record<string, unknown>;
						const epoch = Date.parse(String(runView.run_started_at ?? ""));
						if (!Number.isFinite(epoch)) throw new Error("run epoch malformed");
						const jobsPage = JSON.parse(
							success(
								run(
									"gh",
									[
										"api",
										`repos/${initialPr.repository}/actions/runs/${id}/jobs?filter=latest&per_page=100`,
									],
									commandOptions,
								),
								"jobs API",
							),
						) as Record<string, unknown>;
						if (
							typeof jobsPage.total_count !== "number" ||
							jobsPage.total_count > 100 ||
							!Array.isArray(jobsPage.jobs) ||
							jobsPage.total_count !== jobsPage.jobs.length
						) {
							throw new Error("jobs page malformed");
						}
						const jobs = jobsPage.jobs as Array<Record<string, unknown>>;
						const standing = new Set([
							...manifest.always,
							manifest.aggregate,
							manifest.aggregateScoped,
						]);
						const extras = jobs.filter(
							(job) => typeof job.name === "string" && !standing.has(job.name),
						);
						const fullShape = extras.some(
							(job) =>
								job.status !== "completed" || job.conclusion !== "skipped",
						);
						const scopedShape =
							jobs.some((job) => job.name === manifest.aggregateScoped) ||
							(extras.length > 0 &&
								extras.every((job) => job.conclusion === "skipped"));
						const runStatus = String(row.status ?? "");
						const shapePending =
							RUNNING.has(runStatus) && extras.length === 0 && !scopedShape;
						return {
							id,
							status: runStatus,
							conclusion:
								typeof row.conclusion === "string" ? row.conclusion : null,
							displayTitle: String(row.displayTitle ?? ""),
							createdAt: String(row.createdAt ?? ""),
							url: String(row.url ?? ""),
							attempt: Number(row.attempt ?? 0),
							epoch,
							jobs,
							fullShape,
							scopedShape,
							shapePending,
						};
					});
				};

				let observations: RunObservation[];
				try {
					observations = observeRuns();
				} catch (error) {
					return outcome(2, "observation_failed", {
						detail: error instanceof Error ? error.message : String(error),
					});
				}
				const fullRuns = observations.filter(
					(observation) =>
						observation.displayTitle === `CI full-request ${headSha}` ||
						observation.fullShape,
				);
				const newest = [...fullRuns].sort((a, b) => b.epoch - a.epoch)[0];
				if (newest) {
					const poison = fullRuns.find(
						(candidate) =>
							candidate.id !== newest.id &&
							candidate.jobs.some(
								(job) =>
									job.name === manifest.aggregate &&
									job.conclusion !== "success",
							),
					);
					if (poison) {
						return outcome(1, "stale_non_success_ci_ok", {
							runId: poison.id,
							url: poison.url,
							recovery: `gh run rerun ${poison.id}`,
						});
					}
					if (RUNNING.has(newest.status)) {
						return outcome(8, "full_running", {
							runId: newest.id,
							url: newest.url,
						});
					}
					if (newest.conclusion === "success") {
						if (!exactSuccessJobs(newest.jobs, manifest.required)) {
							return outcome(2, "inconsistent", {
								runId: newest.id,
								url: newest.url,
							});
						}
						const supersedingScoped = observations.find(
							(candidate) =>
								candidate.scopedShape && candidate.epoch > newest.epoch,
						);
						if (supersedingScoped) {
							return outcome(1, "superseded_by_scoped_run", {
								runId: newest.id,
								url: newest.url,
								recovery: `gh run rerun ${newest.id}`,
							});
						}
						const shipCi = probeShipCiGreen({
							cwd,
							prNumber: initialPr.number,
							expectedHead: headSha,
							run,
						});
						if (!shipCi.green) {
							return shipCi.pending
								? outcome(8, "ship_ci_pending", { detail: shipCi.detail })
								: outcome(1, "ship_ci_not_green", { detail: shipCi.detail });
						}
						return outcome(0, "full_green", {
							runId: newest.id,
							url: newest.url,
						});
					}
					if (newest.conclusion === "cancelled") {
						const baseReceipt: Receipt = receipt ?? {
							schema: 1,
							head: headSha,
							pr: initialPr.number,
							state: "labeled",
							requested_at: new Date(now()).toISOString(),
							requester_exec_id: env.FLYWHEEL_EXEC_ID?.trim() ?? "",
							lost_retries: 0,
							reran: [],
						};
						if (baseReceipt.reran.includes(newest.id)) {
							return outcome(1, "cancelled_again", {
								runId: newest.id,
								url: newest.url,
							});
						}
						baseReceipt.reran = [...baseReceipt.reran, newest.id];
						atomicWrite(receiptPath, baseReceipt);
						run("gh", ["run", "rerun", String(newest.id)], commandOptions);
						return outcome(8, "full_rerun_after_cancel", {
							runId: newest.id,
							url: newest.url,
						});
					}
					if (newest.conclusion && FAILURE_CONCLUSIONS.has(newest.conclusion)) {
						return outcome(1, "full_failed", {
							runId: newest.id,
							url: newest.url,
						});
					}
					return outcome(2, "unrecognized_conclusion", {
						runId: newest.id,
						url: newest.url,
					});
				}

				if (observations.some((observation) => observation.shapePending)) {
					return outcome(8, "run_shape_pending");
				}
				if (receipt?.state === "aborted_head_moved") {
					return outcome(2, "head_moved");
				}
				if (receipt) {
					const age = now() - Date.parse(receipt.requested_at);
					if (age <= 10 * 60_000) {
						return outcome(8, "request_pending_visibility");
					}
					if (!options.retryLost || receipt.lost_retries === 1) {
						return outcome(2, "request_lost");
					}
					receipt = {
						...receipt,
						lost_retries: 1,
						requested_at: new Date(now()).toISOString(),
					};
				}

				const intent: Receipt = receipt ?? {
					schema: 1,
					head: headSha,
					pr: initialPr.number,
					state: "intent",
					requested_at: new Date(now()).toISOString(),
					requester_exec_id: env.FLYWHEEL_EXEC_ID?.trim() ?? "",
					lost_retries: 0,
					reran: [],
				};
				intent.state = "intent";
				atomicWrite(receiptPath, intent);
				const currentPr = readPr();
				if (currentPr.head !== headSha) {
					intent.state = "aborted_head_moved";
					atomicWrite(receiptPath, intent);
					return outcome(2, "head_moved");
				}
				success(
					run(
						"gh",
						[
							"label",
							"create",
							"ci:full",
							"--color",
							"5319e7",
							"--description",
							"Request the full CI matrix for the current PR head",
							"--force",
						],
						commandOptions,
					),
					"gh label create",
				);
				if (currentPr.labels.includes("ci:full")) {
					success(
						run(
							"gh",
							[
								"pr",
								"edit",
								String(initialPr.number),
								"--remove-label",
								"ci:full",
							],
							commandOptions,
						),
						"remove ci:full label",
					);
				}
				const added = run(
					"gh",
					["pr", "edit", String(initialPr.number), "--add-label", "ci:full"],
					commandOptions,
				);
				if (added.error || added.signal || added.status !== 0) {
					return outcome(8, "request_pending_visibility", {
						detail:
							"label request may have succeeded; durable intent prevents replay",
					});
				}
				intent.state = "labeled";
				atomicWrite(receiptPath, intent);
				for (let attempt = 0; attempt < 12; attempt += 1) {
					await sleep(5_000);
					let visible: RunObservation[];
					try {
						visible = observeRuns();
					} catch {
						continue;
					}
					const requested = visible.find(
						(candidate) =>
							candidate.displayTitle === `CI full-request ${headSha}`,
					);
					if (requested) {
						return outcome(8, "full_requested", {
							runId: requested.id,
							url: requested.url,
						});
					}
				}
				return outcome(8, "full_requested");
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return message.startsWith("withMkdirLock: timeout acquiring")
				? outcome(8, "lock_busy")
				: outcome(2, "lock_failed", { detail: message });
		}
	} catch (error) {
		return outcome(2, "observation_failed", {
			detail: error instanceof Error ? error.message : String(error),
		});
	}
}

const USAGE =
	"usage: flywheel-comm ci-full ensure [--pr <n>] [--head <40-hex>] [--retry-lost] [--json]";

export async function runCiFullCommand(
	args: string[],
	deps: CiFullDeps = {},
): Promise<number> {
	if (args[0] === "--help" || args[0] === "-h") {
		console.log(USAGE);
		return 0;
	}
	if (args[0] !== "ensure") {
		console.error(USAGE);
		return 2;
	}
	let pr: number | undefined;
	let head: string | undefined;
	let retryLost = false;
	let json = false;
	for (let index = 1; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--retry-lost") retryLost = true;
		else if (arg === "--json") json = true;
		else if (arg === "--pr" && args[index + 1]) {
			index += 1;
			pr = Number(args[index]);
		} else if (arg === "--head" && args[index + 1]) {
			index += 1;
			head = args[index];
		} else {
			console.error(USAGE);
			return 2;
		}
	}
	if (
		(pr !== undefined && (!Number.isSafeInteger(pr) || pr <= 0)) ||
		(head !== undefined && !FULL_SHA.test(head.toLowerCase()))
	) {
		console.error(USAGE);
		return 2;
	}
	const result = await ensureFullCi(
		{ cwd: process.cwd(), pr, head, retryLost },
		deps,
	);
	const rendered = JSON.stringify(result);
	if (json) console.log(rendered);
	else
		console.log(
			`[ci-full] ${result.status}${result.url ? ` ${result.url}` : ""}`,
		);
	return result.exitCode;
}
