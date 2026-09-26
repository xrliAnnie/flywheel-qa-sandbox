/** FLY-2920: bounded, request-local authority for an already retired reviewer.
 * No process text escapes this module. A failed/partial sensor is never absence.
 * The caller durably claims the single termination attempt before calling us.
 */
import { execFile } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { auditedSignal } from "flywheel-claude-runner";
import type { CodexReviewAttempt, CodexReviewJob } from "../StateStore.js";

export const REVIEW_IDENTITY_BUDGET_MS = 5_000;
export interface ReviewProcessIdentity {
	pid: number;
	pgid: number;
	processStartedAt: string;
}
export interface ReviewAttemptProbeResult {
	state: "absent" | "alive" | "unknown";
	reason?: string;
	identity?: ReviewProcessIdentity;
}
type ReviewJob = Pick<
	CodexReviewJob,
	"request_id" | "execution_id" | "target_repo_path"
>;
export interface ReviewProcessSnapshot {
	argsBefore: string;
	authoritative: string;
	argsAfter: string;
}
interface IoContext {
	signal: AbortSignal;
	remainingMs: () => number;
}
export interface ReviewProcessIdentityDeps {
	captureSnapshot?: (context: IoContext) => Promise<ReviewProcessSnapshot>;
	readCwd?: (pid: number, context: IoContext) => Promise<string>;
	signalGroup?: (identity: ReviewProcessIdentity, job: ReviewJob) => boolean;
	now?: () => number;
	env?: NodeJS.ProcessEnv;
}
const unknown = (reason: string): ReviewAttemptProbeResult => ({
	state: "unknown",
	reason,
});
const MAX_BYTES = 16 * 1024 * 1024;
const ROW =
	/^\s*(\d+)\s+(\d+)\s+((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/;
const MARKERS = [
	"FLYWHEEL_REVIEW_REQUEST_ID",
	"FLYWHEEL_REVIEW_ATTEMPT_GENERATION",
	"FLYWHEEL_REVIEW_OWNER_BOOT_ID",
] as const;
function check(context: IoContext) {
	if (context.signal.aborted || context.remainingMs() <= 0)
		throw new Error("probe_timeout");
}
function command(
	binary: string,
	argv: string[],
	context: IoContext,
): Promise<string> {
	check(context);
	return new Promise((yes, no) =>
		execFile(
			binary,
			argv,
			{
				encoding: "utf8",
				env: { ...process.env, LC_ALL: "C" },
				signal: context.signal,
				timeout: Math.max(1, Math.floor(context.remainingMs())),
				maxBuffer: MAX_BYTES,
			},
			(error, stdout) =>
				error ? no(new Error("process_sensor_failed")) : yes(stdout),
		),
	);
}
async function captureSnapshot(
	context: IoContext,
): Promise<ReviewProcessSnapshot> {
	// BSD -E is environment; Linux -E has different semantics. Fail closed there.
	if (process.platform !== "darwin")
		throw new Error("unsupported_process_authority");
	const argsBefore = await command(
		"/bin/ps",
		["-axww", "-o", "pid=,pgid=,lstart=,command="],
		context,
	);
	const authoritative = await command(
		"/bin/ps",
		["-axwwE", "-o", "pid=,pgid=,lstart=,stat=,ucomm=,command="],
		context,
	);
	const argsAfter = await command(
		"/bin/ps",
		["-axww", "-o", "pid=,pgid=,lstart=,command="],
		context,
	);
	return { argsBefore, authoritative, argsAfter };
}
async function readCwd(pid: number, context: IoContext): Promise<string> {
	const text = await command(
		"/usr/sbin/lsof",
		["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
		context,
	);
	const lines = text.trim().split("\n");
	if (
		lines.length !== 3 ||
		lines[0] !== `p${pid}` ||
		lines[1] !== "fcwd" ||
		!lines[2]?.startsWith("n/")
	)
		throw new Error("cwd_unknown");
	return lines[2].slice(1);
}
interface Row extends ReviewProcessIdentity {
	rest: string;
}
function rows(text: string): Map<number, Row> {
	if (!text.trim() || text.length > MAX_BYTES)
		throw new Error("process_authority_invalid");
	const result = new Map<number, Row>();
	for (const line of text.split("\n").filter((line) => line.trim())) {
		const match = ROW.exec(line);
		const pid = Number(match?.[1]);
		const pgid = Number(match?.[2]);
		if (
			!match ||
			!Number.isSafeInteger(pid) ||
			pid < 1 ||
			!Number.isSafeInteger(pgid) ||
			pgid < 1 ||
			result.has(pid) ||
			!Number.isFinite(Date.parse(match[3]!))
		)
			throw new Error("process_authority_invalid");
		result.set(pid, {
			pid,
			pgid,
			processStartedAt: match[3]!,
			rest: match[4]!,
		});
	}
	return result;
}
function same(a: ReviewProcessIdentity, b: ReviewProcessIdentity): boolean {
	return (
		a.pid === b.pid &&
		a.pgid === b.pgid &&
		a.processStartedAt === b.processStartedAt
	);
}
function validBudget(attempt: CodexReviewAttempt): boolean {
	const start = Date.parse(attempt.reviewer_started_at ?? "");
	const deadline = Date.parse(attempt.deadline_at ?? "");
	return (
		Number.isFinite(start) &&
		Number.isFinite(deadline) &&
		Number.isSafeInteger(attempt.configured_timeout_ms) &&
		(attempt.configured_timeout_ms ?? 0) > 0 &&
		deadline === start + attempt.configured_timeout_ms!
	);
}
async function inspect(
	job: ReviewJob,
	attempt: CodexReviewAttempt,
	context: IoContext,
	deps: ReviewProcessIdentityDeps,
): Promise<ReviewAttemptProbeResult> {
	check(context);
	if (
		!job.target_repo_path ||
		!isAbsolute(job.target_repo_path) ||
		!attempt.reviewer_session_uuid ||
		attempt.request_id !== job.request_id ||
		!validBudget(attempt)
	)
		return unknown("legacy_owner_unverified");
	const snapshot = await (deps.captureSnapshot ?? captureSnapshot)(context);
	check(context);
	const before = rows(snapshot.argsBefore),
		authoritative = rows(snapshot.authoritative),
		after = rows(snapshot.argsAfter);
	// Sensor ps children and unrelated host processes may come/go between reads.
	// Every possible reviewer row in either argv snapshot must still be accounted
	// for by the authoritative read; omission cannot turn a reviewer into absence.
	for (const index of [before, after]) {
		for (const row of index.values()) {
			if (
				/^(?:\S*\/)?claude(?:\s|$)/.test(row.rest) ||
				row.rest.includes(attempt.reviewer_session_uuid) ||
				row.pid === attempt.pid ||
				(attempt.pgid !== null && row.pgid === attempt.pgid)
			) {
				const authority = authoritative.get(row.pid);
				if (!authority || !same(row, authority))
					return unknown("process_authority_incomplete");
			}
		}
	}
	let found: ReviewProcessIdentity | undefined;
	for (const row of authoritative.values()) {
		const state = /^(\S+)\s+(\S+)\s+(.*)$/.exec(row.rest);
		if (!state) return unknown("process_authority_invalid");
		if (state[1]!.startsWith("Z")) continue;
		if (state[2] !== "claude") {
			if (
				row.pid === attempt.pid ||
				(attempt.pgid !== null && row.pgid === attempt.pgid) ||
				row.rest.includes(attempt.reviewer_session_uuid) ||
				row.rest.includes(`FLYWHEEL_REVIEW_REQUEST_ID=${attempt.request_id}`)
			)
				return unknown("related_process_unclassified");
			continue;
		}
		const b = before.get(row.pid),
			a = after.get(row.pid);
		if (!b || !a || !same(b, row) || !same(a, row))
			return unknown("process_authority_incomplete");
		if (
			b.rest !== a.rest ||
			(state[3] !== b.rest && !state[3]!.startsWith(`${b.rest} `))
		)
			return unknown("process_argv_unstable");
		const suffix = state[3]!.slice(b.rest.length).trim();
		if (!suffix) return unknown("process_environment_unavailable");
		const env = new Map<string, string[]>();
		for (const token of suffix.split(/\s+/)) {
			const entry = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(token);
			if (entry) env.set(entry[1]!, [...(env.get(entry[1]!) ?? []), entry[2]!]);
		}
		if (MARKERS.some((key) => (env.get(key)?.length ?? 0) > 1))
			return unknown("process_environment_ambiguous");
		// Session flags must be the actual structured CLI tail, never an arbitrary
		// substring such as --resume-prefix or a UUID inside a prompt.
		const escaped = attempt.reviewer_session_uuid.replace(
			/[.*+?^${}()|[\]\\]/g,
			"\\$&",
		);
		const session = new RegExp(
			` --(?:session-id|resume) ${escaped} --output-format json --model \\S+(?: --effort \\S+)? --settings (\\{.*\\})$`,
		).exec(b.rest);
		const exactMarkers =
			env.get(MARKERS[0])?.[0] === attempt.request_id &&
			env.get(MARKERS[1])?.[0] === String(attempt.attempt_generation) &&
			env.get(MARKERS[2])?.[0] === attempt.owner_boot_id;
		const relatedSession = b.rest.includes(attempt.reviewer_session_uuid);
		if (attempt.owner_boot_id && !exactMarkers) {
			if (relatedSession || env.get(MARKERS[0])?.[0] === attempt.request_id)
				return unknown("review_owner_unverified");
			continue;
		}
		if (!session) {
			if (exactMarkers || relatedSession)
				return unknown("review_session_unverified");
			continue;
		}
		try {
			JSON.parse(session[1]!);
		} catch {
			return unknown("review_session_unverified");
		}
		const processTime = Date.parse(row.processStartedAt);
		if (
			row.pid !== row.pgid ||
			processTime < Date.parse(attempt.reviewer_started_at!) - 1000 ||
			processTime > Date.parse(attempt.deadline_at!) ||
			(attempt.pid !== null && attempt.pid !== row.pid) ||
			(attempt.pgid !== null && attempt.pgid !== row.pgid) ||
			(attempt.process_started_at !== null &&
				attempt.process_started_at !== row.processStartedAt)
		)
			return unknown("review_identity_mismatch");
		const cwd = await (deps.readCwd ?? readCwd)(row.pid, context);
		check(context);
		if (!isAbsolute(cwd) || resolve(cwd) !== resolve(job.target_repo_path))
			return unknown("review_cwd_mismatch");
		if (found) return unknown("review_identity_ambiguous");
		found = {
			pid: row.pid,
			pgid: row.pgid,
			processStartedAt: row.processStartedAt,
		};
	}
	return found ? { state: "alive", identity: found } : { state: "absent" };
}
async function bounded(
	signal: AbortSignal | undefined,
	work: (context: IoContext) => Promise<ReviewAttemptProbeResult>,
): Promise<ReviewAttemptProbeResult> {
	const controller = new AbortController();
	const started = performance.now();
	const context = {
		signal: controller.signal,
		remainingMs: () =>
			REVIEW_IDENTITY_BUDGET_MS - (performance.now() - started),
	};
	let timer: ReturnType<typeof setTimeout> | undefined;
	const abort = () => controller.abort();
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	const stopped = new Promise<ReviewAttemptProbeResult>((yes) => {
		if (controller.signal.aborted) {
			yes(unknown("probe_aborted"));
			return;
		}
		controller.signal.addEventListener(
			"abort",
			() => yes(unknown("probe_aborted_or_timeout")),
			{ once: true },
		);
		timer = setTimeout(abort, REVIEW_IDENTITY_BUDGET_MS);
	});
	try {
		return await Promise.race([
			stopped,
			work(context).catch(() => unknown("process_probe_failed")),
		]);
	} finally {
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
		controller.abort();
	}
}
export function probeRetiredReviewAttempt(
	job: ReviewJob,
	attempt: CodexReviewAttempt,
	signal?: AbortSignal,
	deps: ReviewProcessIdentityDeps = {},
): Promise<ReviewAttemptProbeResult> {
	return bounded(signal, (context) => inspect(job, attempt, context, deps));
}
export function terminateRetiredReviewAttempt(
	job: ReviewJob,
	attempt: CodexReviewAttempt,
	signal?: AbortSignal,
	deps: ReviewProcessIdentityDeps = {},
): Promise<ReviewAttemptProbeResult> {
	return bounded(signal, async (context) => {
		if (
			!validBudget(attempt) ||
			(deps.now ?? Date.now)() < Date.parse(attempt.deadline_at!)
		)
			return unknown("original_deadline_unverified");
		const first = await inspect(job, attempt, context, deps);
		check(context);
		if (first.state !== "alive" || !first.identity) return first;
		const second = await inspect(job, attempt, context, deps);
		check(context);
		if (second.state !== "alive" || !second.identity) return second;
		if (!same(first.identity, second.identity))
			return unknown("review_identity_changed");
		const signalGroup =
			deps.signalGroup ??
			((identity: ReviewProcessIdentity, target: ReviewJob) =>
				auditedSignal(
					{
						source: "retired_review_attempt",
						signal: "SIGKILL",
						targetKind: "pgid",
						target: identity.pgid,
						execId: target.execution_id,
						reason: "retired_review_original_deadline",
						boundary: { worktreePath: target.target_repo_path },
					},
					{ env: deps.env ?? process.env },
				).ok);
		if (!signalGroup(second.identity, job))
			return unknown("review_signal_refused");
		check(context);
		return inspect(job, attempt, context, deps);
	});
}

/** Supplemental identity only: failure leaves the durable pre-spawn intent intact. */
export async function captureSpawnedReviewIdentity(
	pid: number,
	signal?: AbortSignal,
): Promise<ReviewProcessIdentity | null> {
	let identity: ReviewProcessIdentity | null = null;
	await bounded(signal, async (context) => {
		const args = [
			"-ww",
			"-p",
			String(pid),
			"-o",
			"pid=,pgid=,lstart=,command=",
		];
		const first = rows(await command("/bin/ps", args, context)).get(pid);
		const second = rows(await command("/bin/ps", args, context)).get(pid);
		check(context);
		if (
			first &&
			second &&
			first.pid === first.pgid &&
			same(first, second) &&
			first.rest === second.rest
		)
			identity = {
				pid,
				pgid: first.pgid,
				processStartedAt: first.processStartedAt,
			};
		return { state: "unknown" };
	});
	return identity;
}
