/**
 * FLY-1188 §7.2 — Claude reviewer subprocess (the cross-family reviewer for
 * codex-authored work).
 *
 * Spawns `claude -p <prompt> --session-id <uuid>|--resume <uuid>
 * --output-format json --model <model>` once per review round. Every round
 * carries its full prompt. Rerounds resume the same session so Claude keeps
 * its read of the codebase; a fresh reround rebuilds the available context.
 *
 * Failure semantics (§7.2, fail-close): anything that is not a parseable
 * structured verdict — spawn failure, timeout, non-zero exit, refusal,
 * malformed JSON — is `kind: "failed"`, NEVER a verdict. The caller keeps the
 * review gate closed and alerts the Lead; recovery is a same-requestId retry
 * or the sanctioned codex-skip governance path. A missing reviewer must never
 * silently become a same-family pass.
 *
 * Process hygiene: detached process group so
 * timeout/shutdown kills the WHOLE tree; stdin closed immediately (a `-p`
 * child left with an open stdin pipe can hang forever); stdout bounded.
 * Live children are registered so Bridge shutdown can kill them all.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	appendRunnerTestPolicyHookSettings,
	buildNonLeadClaudeSettings,
	buildRunnerTestPolicyHookCommand,
	type CompiledRunnerPrefixProfile,
	getModelConfigSnapshot,
	type RoleEffort,
	resolveAllowedCanonicalModel,
	resolveAllowedEffort,
} from "flywheel-config";

const RUNNER_TEST_POLICY_HOOK = fileURLToPath(
	new URL(
		"../../../../scripts/hooks/inject-runner-test-policy.mjs",
		import.meta.url,
	),
);

const washReviewEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
	Object.fromEntries(
		Object.entries(env).filter(
			([key]) => !/TOKEN|SECRET|PASSWORD|(?:^|_)KEY(?:_|$)|API_KEY/i.test(key),
		),
	);

export interface ClaudeReviewFinding {
	id?: string;
	disputesRuling?: string;
	severity?: string;
	file?: string;
	line?: number;
	title?: string;
	detail?: string;
}

export type ClaudeReviewOutcome =
	| {
			kind: "verdict";
			verdict: "APPROVED" | "CHANGES_REQUESTED";
			findings: ClaudeReviewFinding[];
			reviewedHeadSha: string | null;
			reviewedPlanBlobSha?: string | null;
			repairedTrailingBrace: boolean;
			/** Raw assistant text the verdict was parsed from (audit copy). */
			raw: string;
	  }
	| {
			kind: "failed";
			reason:
				| "spawn_error"
				| "timeout"
				| "nonzero_exit"
				| "stdout_overflow"
				| "no_verdict";
			detail: string;
			exitCode: number | null;
			timedOut: boolean;
			raw?: string;
			stderrTail?: string;
	  };

export interface ClaudeReviewInvocation {
	/** Full prompt for THIS round (every round is self-contained). */
	prompt: string;
	/** Review-session uuid — `--session-id` on round 1, `--resume` after. */
	sessionId: string;
	/** true = reround (`--resume`), false = first round (`--session-id`). */
	resume: boolean;
	/** Fixed working directory (the reviewed repo / worktree). */
	cwd: string;
	model?: string;
	/**
	 * FLY-1224 (Annie's directive): reasoning effort for the reviewer. Defaults
	 * to `DEFAULT_REVIEW_EFFORT` ("xhigh") — the single ownership layer for the
	 * default is HERE (the coordinator only forwards an override).
	 */
	effort?: RoleEffort;
	timeoutMs?: number;
	maxStdoutBytes?: number;
	env?: NodeJS.ProcessEnv;
	binary?: string;
	/**
	 * FLY-2913: compiled role-v1 reviewer profile. Applied only when its stamp
	 * is durable under `prefixStamp.dir`; otherwise the round stays legacy.
	 */
	prefixProfile?: Pick<
		CompiledRunnerPrefixProfile,
		"settings" | "profileDigest"
	> & { stamp: Record<string, unknown> };
	prefixAudit?: Record<string, unknown>;
	prefixStamp?: { dir: string; requestId: string; executionId?: string };
}

/**
 * FLY-1224 (Annie's directive): the cross-family Claude reviewer runs at
 * xhigh effort — matching the codex author's own effort so the review is not
 * weaker than the work it judges. Exported for the coordinator-layer test.
 */
export const DEFAULT_REVIEW_EFFORT: RoleEffort = "xhigh";
const DEFAULT_TIMEOUT_MS = 30 * 60_000; // §7.2: 30min per round
const DEFAULT_MAX_STDOUT_BYTES = 8 * 1_048_576; // 8MB
const MAX_STDERR_BYTES = 16 * 1024;

/** Live children (pid → kill fn) so Bridge shutdown can reap every reviewer. */
const liveChildren = new Map<number, () => void>();

export function killAllClaudeReviewChildren(): number {
	const n = liveChildren.size;
	for (const kill of liveChildren.values()) kill();
	liveChildren.clear();
	return n;
}

function buildReviewSettings(
	prompt: string,
	prefix?: Record<string, unknown>,
): string {
	return JSON.stringify(
		appendRunnerTestPolicyHookSettings(
			buildNonLeadClaudeSettings(prefix),
			prompt,
			buildRunnerTestPolicyHookCommand(
				process.execPath,
				RUNNER_TEST_POLICY_HOOK,
			),
		),
	);
}

export function buildClaudeReviewArgv(
	inv: Pick<ClaudeReviewInvocation, "prompt" | "sessionId" | "resume"> & {
		model?: string;
		effort?: RoleEffort;
		prefixProfile?: ClaudeReviewInvocation["prefixProfile"];
	},
): string[] {
	const snapshot = getModelConfigSnapshot();
	const canonicalModel = resolveAllowedCanonicalModel(
		inv.model ?? snapshot.bindings.opus,
		{
			surface: "runner",
			runtimeVendor: "claude",
			snapshot,
		},
	);
	// FLY-1224: reviewer effort (FLY-671 claude CLI flag), default xhigh.
	// FLY-1650 (Codex R2): this is a third launch path that appends --effort
	// independently of the model, and the model can be Opus 4.6 — either named
	// directly (it carries the runner surface) or inherited from a rebound
	// `bindings.opus`. Opus 4.6 has no `xhigh`, so the default alone would send
	// a flag the API rejects. Same narrowing seam as the tmux and Lead paths.
	const effort = resolveAllowedEffort(
		canonicalModel,
		inv.effort ?? DEFAULT_REVIEW_EFFORT,
		{ surface: "runner", snapshot },
	);
	return [
		"-p",
		inv.prompt,
		inv.resume ? "--resume" : "--session-id",
		inv.sessionId,
		"--output-format",
		"json",
		"--model",
		canonicalModel,
		...(effort ? (["--effort", effort] as const) : []),
		"--settings",
		buildReviewSettings(inv.prompt, inv.prefixProfile?.settings),
	];
}

/** Resolve actual settings before spawn, with session-bound audit and resume checks. */
function prepareReviewPrefixSettings(
	inv: ClaudeReviewInvocation,
	logger: (msg: string) => void,
): string | undefined {
	const { prefixProfile, prefixStamp, prefixAudit } = inv;
	if (!prefixProfile && !prefixAudit) return undefined;
	const legacy = buildReviewSettings(inv.prompt);
	const roleSettings = prefixProfile
		? buildReviewSettings(inv.prompt, prefixProfile.settings)
		: undefined;
	if (!prefixStamp) {
		logger(
			`prefix-launch ${JSON.stringify({ ...prefixAudit, effectiveProfile: "legacy", fallbackReason: "stamp-location-missing", settingsSha256: createHash("sha256").update(legacy).digest("hex") })}`,
		);
		return legacy;
	}
	if (!/^[A-Za-z0-9-]{1,128}$/.test(inv.sessionId))
		throw new Error("prefix resume invalid session id");
	const target = join(
		prefixStamp.dir,
		`review-${inv.sessionId}.prefix-profile.json`,
	);
	const settingsFile = `review-${inv.sessionId}.settings.json`;
	if (inv.resume && existsSync(target)) {
		try {
			const prior = JSON.parse(readFileSync(target, "utf-8"));
			if (prior.effectiveProfile === "role-v1" || prior.mode === "role-v1") {
				if (
					prior.sessionId !== inv.sessionId ||
					(prefixStamp.executionId &&
						prior.executionId !== prefixStamp.executionId) ||
					prior.settingsFile !== settingsFile
				)
					throw new Error("identity");
				const expected =
					prefixAudit !== undefined
						? prefixAudit.workflow
						: prefixProfile?.stamp.workflow;
				if (!expected || !prior.workflow) throw new Error("workflow missing");
				if (expected) {
					for (const key of [
						"runId",
						"templateId",
						"snapshotDigest",
						"templateRevision",
					]) {
						if (key === "templateRevision" && prior.workflow[key] === undefined)
							continue;
						if (
							prior.workflow[key] !== (expected as Record<string, unknown>)[key]
						)
							throw new Error("workflow");
					}
				}
				const expectedNode =
					prefixAudit !== undefined
						? prefixAudit.nodeId
						: prefixProfile?.stamp.nodeId;
				if (!expectedNode || prior.nodeId !== expectedNode)
					throw new Error("node");
				const settings = readFileSync(
					join(prefixStamp.dir, settingsFile),
					"utf-8",
				);
				if (
					createHash("sha256").update(settings).digest("hex") !==
					prior.settingsSha256
				)
					throw new Error("settings");
				logger(
					`prefix-launch ${JSON.stringify({ ...prior, requestId: prefixStamp.requestId, executionId: prefixStamp.executionId ?? null, resume: inv.resume, sessionId: inv.sessionId, requestedProfile: prefixAudit?.requestedProfile ?? "legacy", workflow: prior.workflow?.templateRevision ? prior.workflow : (expected ?? null), selectionSource: "historical-session", effectiveProfile: "role-v1", fallbackReason: null })}`,
				);
				return settings;
			}
		} catch {
			throw new Error("prefix resume identity or settings mismatch");
		}
	}
	const settings = roleSettings ?? legacy;
	const audit = {
		...prefixProfile?.stamp,
		...prefixAudit,
		executionId: prefixStamp.executionId ?? null,
		requestId: prefixStamp.requestId,
		sessionId: inv.sessionId,
		resume: inv.resume,
		effectiveProfile: roleSettings ? "role-v1" : "legacy",
		fallbackReason: roleSettings
			? null
			: (prefixAudit?.fallbackReason ?? "node-legacy"),
		settingsFile: roleSettings ? settingsFile : null,
		settingsSha256: createHash("sha256").update(settings).digest("hex"),
	};
	const temps: string[] = [];
	const write = (path: string, content: string) => {
		const temp = `${path}.${randomUUID()}.tmp`;
		temps.push(temp);
		writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
		renameSync(temp, path);
	};
	try {
		mkdirSync(prefixStamp.dir, { recursive: true, mode: 0o700 });
		chmodSync(prefixStamp.dir, 0o700);
		if (roleSettings) write(join(prefixStamp.dir, settingsFile), roleSettings);
		write(target, `${JSON.stringify(audit)}\n`);
		return settings;
	} catch {
		for (const temp of temps) {
			try {
				rmSync(temp, { force: true });
			} catch {}
		}
		logger(
			`FLY-2913 prefix-profile stamp write failed; legacy prefix-launch ${JSON.stringify({ ...audit, mode: "legacy", effectiveProfile: "legacy", fallbackReason: "audit-write-failed", settingsFile: null, settingsSha256: createHash("sha256").update(legacy).digest("hex") })}`,
		);
		return legacy;
	}
}

interface SpawnResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	overflowed: boolean;
	spawnError: string | null;
}

export type ClaudeReviewSpawner = (opts: {
	binary: string;
	argv: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeoutMs: number;
	maxStdoutBytes: number;
}) => Promise<SpawnResult>;

/** Real spawner — never rejects; every failure lands in the result shape. */
export const defaultClaudeReviewSpawner: ClaudeReviewSpawner = (opts) =>
	new Promise((resolve) => {
		let stdout = "";
		let stderrTail = Buffer.alloc(0);
		let done = false;
		let timedOut = false;
		let overflowed = false;
		let spawnError: string | null = null;
		const child = spawn(opts.binary, opts.argv, {
			cwd: opts.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: opts.env,
			detached: true, // own group → tree kill reaps grandchildren
		});
		const killTree = () => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {
				try {
					child.kill("SIGKILL");
				} catch {
					/* already dead */
				}
			}
		};
		if (child.pid) liveChildren.set(child.pid, killTree);
		const finish = (code: number | null) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			if (child.pid) liveChildren.delete(child.pid);
			resolve({
				code,
				stdout,
				stderr: stderrTail.toString("utf8"),
				timedOut,
				overflowed,
				spawnError,
			});
		};
		const timer = setTimeout(() => {
			timedOut = true;
			killTree();
		}, opts.timeoutMs);
		let stdoutBytes = 0;
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf-8");
			stdoutBytes += chunk.length; // real BYTES (R12 LOW: not code units)
			if (stdoutBytes > opts.maxStdoutBytes) {
				overflowed = true;
				killTree();
			}
		});
		child.stderr.on("data", (chunk: Buffer) => {
			// Keep consuming stderr so a noisy child cannot block on pipe
			// backpressure, but retain only the diagnostic tail.
			if (chunk.length >= MAX_STDERR_BYTES) {
				stderrTail = Buffer.from(
					chunk.subarray(chunk.length - MAX_STDERR_BYTES),
				);
				return;
			}
			const excess = stderrTail.length + chunk.length - MAX_STDERR_BYTES;
			stderrTail = Buffer.concat([
				excess > 0 ? stderrTail.subarray(excess) : stderrTail,
				chunk,
			]);
		});
		child.on("error", (err) => {
			spawnError = err instanceof Error ? err.message : String(err);
			finish(127);
		});
		child.on("close", (code) => finish(code));
		try {
			// -p mode must not be left waiting on stdin (classifier precedent)
			child.stdin.end();
		} catch {
			/* close event carries the failure */
		}
	});

/**
 * Extract the structured verdict from the claude CLI output.
 *
 * `--output-format json` wraps the assistant text in a result envelope
 * (`{"type":"result","result":"<text>",...}`); the verdict JSON object lives
 * inside that text (optionally fenced). Tolerant extraction, strict
 * validation: anything that does not yield a well-formed verdict object with
 * a recognized `verdict` value is NOT a verdict (fail-close).
 */
export function parseClaudeReviewOutput(stdout: string): {
	verdict: "APPROVED" | "CHANGES_REQUESTED";
	findings: ClaudeReviewFinding[];
	reviewedHeadSha: string | null;
	reviewedPlanBlobSha: string | null;
	repairedTrailingBrace: boolean;
	raw: string;
} | null {
	let text = stdout.trim();
	// Unwrap the CLI json envelope when present. R12/R13 HIGH: anything carrying
	// an envelope discriminator must match the REAL success schema exactly —
	// type "result", subtype "success", not is_error, no api_error_status, and
	// a string result — or it is NOT a verdict. A top-level bare verdict object
	// remains a separate supported format; other complete JSON objects are not
	// recursively searched for nested verdict-shaped data.
	try {
		const whole = JSON.parse(text) as unknown;
		if (typeof whole !== "object" || whole === null || Array.isArray(whole)) {
			return null;
		}
		const envelope = whole as Record<string, unknown>;
		const exactSuccessEnvelope =
			envelope.type === "result" &&
			envelope.subtype === "success" &&
			envelope.is_error !== true &&
			// R14: null and undefined both mean "no API error" (matches the
			// classifier-runner precedent); any other value is an error.
			envelope.api_error_status == null &&
			typeof envelope.result === "string";
		if (exactSuccessEnvelope) {
			text = (envelope.result as string).trim();
		} else if (
			["type", "subtype", "is_error", "api_error_status", "result"].some(
				(key) => Object.hasOwn(envelope, key),
			)
		) {
			return null;
		} else if (!hasRecognizedVerdict(envelope)) {
			return null;
		}
	} catch {
		/* not an envelope — treat stdout as assistant text */
	}
	const candidate = extractVerdictObject(text);
	if (!candidate) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate.json);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const obj = parsed as Record<string, unknown>;
	const verdictRaw =
		typeof obj.verdict === "string" ? obj.verdict.toUpperCase() : null;
	if (verdictRaw !== "APPROVED" && verdictRaw !== "CHANGES_REQUESTED") {
		return null;
	}
	const findings: ClaudeReviewFinding[] = Array.isArray(obj.findings)
		? obj.findings.filter(
				(f): f is ClaudeReviewFinding => typeof f === "object" && f !== null,
			)
		: [];
	const reviewedHeadSha =
		typeof obj.reviewedHeadSha === "string" && obj.reviewedHeadSha.length > 0
			? obj.reviewedHeadSha.toLowerCase()
			: null;
	const reviewedPlanBlobSha =
		typeof obj.reviewedPlanBlobSha === "string" &&
		obj.reviewedPlanBlobSha.length > 0
			? obj.reviewedPlanBlobSha.toLowerCase()
			: null;
	return {
		verdict: verdictRaw,
		findings,
		reviewedHeadSha,
		reviewedPlanBlobSha,
		repairedTrailingBrace: candidate.repairedTrailingBrace,
		raw: text,
	};
}

const VERDICT_ANCHOR_LIMIT = 32;

function hasRecognizedVerdict(obj: Record<string, unknown>): boolean {
	if (typeof obj.verdict !== "string") return false;
	const verdict = obj.verdict.toUpperCase();
	return verdict === "APPROVED" || verdict === "CHANGES_REQUESTED";
}

function parseVerdictCandidate(candidate: string): boolean {
	try {
		const parsed = JSON.parse(candidate) as unknown;
		return (
			typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed) &&
			hasRecognizedVerdict(parsed as Record<string, unknown>)
		);
	} catch {
		return false;
	}
}

function parseRepairedVerdictCandidate(candidate: string): boolean {
	try {
		const parsed = JSON.parse(candidate) as unknown;
		return (
			typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed) &&
			hasRecognizedVerdict(parsed as Record<string, unknown>) &&
			Object.hasOwn(parsed, "findings") &&
			Array.isArray((parsed as Record<string, unknown>).findings)
		);
	} catch {
		return false;
	}
}

/** Return the closing brace for a JSON-like object span, respecting strings. */
function findBalancedObjectEnd(text: string, start: number): number | null {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i += 1) {
		const char = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	return null;
}

/**
 * Extract the final structured verdict from prose-plus-JSON reviewer output.
 * First scan balanced top-level object spans in O(n). If prose contains an
 * unmatched opening brace, fall back to at most 32 verdict-key anchors.
 */
function extractVerdictObject(text: string): {
	json: string;
	repairedTrailingBrace: boolean;
} | null {
	let lastMatch: string | null = null;
	let depth = 0;
	let spanStart = -1;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i += 1) {
		const char = text[i];
		if (depth > 0 && inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (depth > 0 && char === '"') {
			inString = true;
			continue;
		}
		if (char === "{") {
			if (depth === 0) spanStart = i;
			depth += 1;
		} else if (char === "}" && depth > 0) {
			depth -= 1;
			if (depth === 0 && spanStart >= 0) {
				const candidate = text.slice(spanStart, i + 1);
				if (parseVerdictCandidate(candidate)) lastMatch = candidate;
				spanStart = -1;
			}
		}
	}
	if (lastMatch) return { json: lastMatch, repairedTrailingBrace: false };

	let anchorFrom = 0;
	for (let count = 0; count < VERDICT_ANCHOR_LIMIT; count += 1) {
		const anchor = text.indexOf('"verdict"', anchorFrom);
		if (anchor === -1) break;
		anchorFrom = anchor + '"verdict"'.length;
		const start = text.lastIndexOf("{", anchor);
		if (start === -1) continue;
		const end = findBalancedObjectEnd(text, start);
		if (end === null) continue;
		const candidate = text.slice(start, end + 1);
		if (parseVerdictCandidate(candidate)) lastMatch = candidate;
	}
	if (lastMatch) return { json: lastMatch, repairedTrailingBrace: false };

	const repairable = text.trim();
	if (!repairable.startsWith('{"verdict"') || !repairable.endsWith("]")) {
		return null;
	}
	const repaired = `${repairable}}`;
	return parseRepairedVerdictCandidate(repaired)
		? { json: repaired, repairedTrailingBrace: true }
		: null;
}

export interface RunClaudeReviewDeps {
	spawner?: ClaudeReviewSpawner;
	logger?: (msg: string) => void;
}

/** Run ONE review round. Never throws; every failure is a fail-close outcome. */
export async function runClaudeReviewRound(
	inv: ClaudeReviewInvocation,
	deps: RunClaudeReviewDeps = {},
): Promise<ClaudeReviewOutcome> {
	const spawner = deps.spawner ?? defaultClaudeReviewSpawner;
	const logger =
		deps.logger ?? ((m: string) => console.log(`[claude-review] ${m}`));
	let settings: string | undefined;
	try {
		settings = prepareReviewPrefixSettings(inv, logger);
	} catch {
		return {
			kind: "failed",
			reason: "spawn_error",
			detail: "prefix resume identity or settings mismatch",
			exitCode: null,
			timedOut: false,
		};
	}
	const argv = buildClaudeReviewArgv({ ...inv, prefixProfile: undefined });
	if (settings !== undefined) argv[argv.indexOf("--settings") + 1] = settings;

	const res = await spawner({
		binary: inv.binary ?? "claude",
		argv,
		cwd: inv.cwd,
		// Codex full-PR review HIGH-5: the reviewer is a model-driven claude
		// subprocess that actively explores the author's worktree — it must NOT
		// inherit the Bridge's third-party creds (Discord/Linear/DB/API keys).
		// Wash them out. Claude auth is CLAUDE_CONFIG_DIR
		// (kept — not secret-shaped); the worktree's git credential helper covers
		// git; the diff is local (git diff in-worktree). The coordinator collects
		// the reviewer's stdout, so it needs no FLYWHEEL_ posting token.
		env: {
			...washReviewEnv(inv.env ?? process.env),
			VITEST_MAX_THREADS: "4",
			VITEST_MIN_THREADS: "1",
			VITEST_MAX_FORKS: "4",
			VITEST_MIN_FORKS: "1",
		},
		timeoutMs: inv.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		maxStdoutBytes: inv.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES,
	});
	if (res.spawnError !== null) {
		logger(`spawn failed: ${res.spawnError}`);
		return {
			kind: "failed",
			reason: "spawn_error",
			detail: res.spawnError,
			exitCode: res.code,
			timedOut: false,
			stderrTail: res.stderr.slice(-2000),
		};
	}
	if (res.timedOut) {
		logger(`review round timed out (session ${inv.sessionId})`);
		return {
			kind: "failed",
			reason: "timeout",
			detail: `timed out after ${inv.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
			exitCode: res.code,
			timedOut: true,
			stderrTail: res.stderr.slice(-2000),
		};
	}
	if (res.overflowed) {
		return {
			kind: "failed",
			reason: "stdout_overflow",
			detail: "reviewer stdout exceeded the bounded buffer",
			exitCode: res.code,
			timedOut: false,
			stderrTail: res.stderr.slice(-2000),
		};
	}
	if (res.code !== 0) {
		return {
			kind: "failed",
			reason: "nonzero_exit",
			detail: `claude exited ${res.code}`,
			exitCode: res.code,
			timedOut: false,
			raw: res.stdout.slice(-4000),
			stderrTail: res.stderr.slice(-2000),
		};
	}
	const parsed = parseClaudeReviewOutput(res.stdout);
	if (!parsed) {
		// refusal / malformed output — NOT a verdict (§7.2: never degrade to
		// a same-family pass, never treat reviewer_unavailable as a review)
		return {
			kind: "failed",
			reason: "no_verdict",
			detail: "no parseable structured verdict in reviewer output",
			exitCode: res.code,
			timedOut: false,
			raw: res.stdout.slice(-4000),
			stderrTail: res.stderr.slice(-2000),
		};
	}
	return { kind: "verdict", ...parsed };
}
