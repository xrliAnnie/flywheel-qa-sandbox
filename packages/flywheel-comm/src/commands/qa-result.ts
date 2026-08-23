/**
 * Runner-driven DAG QA verdict emitter (`flywheel-comm qa-result`).
 *
 * A DAG QA Runner emits this after verification. The scoped workflow
 * submission credential binds the decision to its durable DAG activation.
 *
 * Reliability mirrors `complete.ts`: retry with backoff + fail-close marker on
 * exhaustion. There is deliberately no legacy `/events` fallback: an event
 * acknowledgement is not a consumed DAG decision.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseGitHubPushEndpoint } from "flywheel-config";
import { currentWorkflowCredentialFromEnv } from "./workflow-activation.js";

const VALID_STATUSES = new Set(["pass", "fail"]);

const ATTEMPT_COUNT = 4;
const ATTEMPT_TIMEOUT_MS = 5000;
const BACKOFF_MS = [1000, 2000, 4000] as const;
const LAND_HEAD_SETTLE_INTERVAL_MS = 250;
const LAND_HEAD_SETTLE_TIMEOUT_MS = 5000;
const LAND_HEAD_SETTLE_MAX_ATTEMPTS =
	LAND_HEAD_SETTLE_TIMEOUT_MS / LAND_HEAD_SETTLE_INTERVAL_MS;

const DETERMINISTIC_REJECTION_REASONS = new Set([
	"workflow_submission_required",
	"credential_not_found",
	"credential_revoked",
	"credential_expired",
	"credential_receipt_corrupt",
	"invalid_request",
	"invalid_status",
	"invalid_client_head",
	"invalid_timestamp",
	"head_authority_mismatch",
	"replay_payload_mismatch",
	"not_durable_qa_execution",
	"predicate_not_allowed",
	"binding_not_current",
	"same_vendor_review",
	"missing_subject_producer",
	"node_does_not_emit_decisions",
	"decision_family_mismatch",
	"materialized_head_invalid",
	"materialized_output_mismatch",
	"materialized_producer_ambiguous",
	"execution_not_found",
	"worktree_not_found",
	"invalid_git_head",
	"run_not_found",
	"transition_refused",
	"land_head_pr_closed",
	"land_head_pr_merged",
	"land_head_pr_draft",
	"land_head_pr_cross_repo",
	"land_head_pr_ref_invalid",
	"land_head_pr_identity_unavailable",
	"land_head_authority_drift",
	"land_head_materialized_pr_not_at_tip",
	"land_gate_entry_binding_mismatch",
	"land_gate_entry_sealed_manifest_stale",
]);

/**
 * The Bridge reason vocabulary is intentionally open. Known structural
 * rejections stop immediately; unknown reasons retain the bounded retry path
 * so a newer Bridge cannot accidentally make an older CLI fail permanently.
 */
export function classifyQaResultRejection(
	reason: string | undefined,
): "fail" | "retry" {
	return reason && DETERMINISTIC_REJECTION_REASONS.has(reason)
		? "fail"
		: "retry";
}

export interface QaResultOpts {
	/** "pass" | "fail" — the QA verdict. */
	status: string;
	/** The parent (implementer/main) execution id this verdict gates. */
	targetExec: string;
	/** Human-readable verdict summary (what was tested + any blocking issue). */
	summary?: string;
	/** QA runner's own execution id. Defaults to FLYWHEEL_EXEC_ID. */
	execId?: string;
	/** Reviewed PR head the QA worktree was pinned to. Defaults to git HEAD. */
	prHeadSha?: string;
}

export interface WorkflowQaDecisionBody {
	credential: string;
	client_request_id: string;
	status: "pass" | "fail";
	client_pr_head_sha?: string;
	summary?: string;
}

/** Credential-free verdict projection persisted before any fallible context lookup. */
export interface RecoverableQaVerdict {
	executionId: string;
	targetExecutionId: string;
	issueId: string;
	projectName: string;
	status: "pass" | "fail";
	summary?: string;
	clientRequestId: string;
	prHeadSha?: string;
}

export interface GitHubCredential {
	username: string;
	password: string;
}

const GITHUB_CREDENTIAL_FIELDS = new Set([
	"protocol",
	"host",
	"username",
	"password",
]);
const GITHUB_CREDENTIAL_USERNAME_MAX = 256;
const GITHUB_CREDENTIAL_PASSWORD_MAX = 8_192;

export function parseGitHubCredentialOutput(
	output: string,
	expectedHost: string,
): GitHubCredential {
	const invalid = (): never => {
		throw new Error("GitHub CLI credential response is invalid");
	};
	if (!output || output.length > 12_288 || expectedHost !== "github.com") {
		return invalid();
	}
	const fields = new Map<string, string>();
	for (const line of output.split(/\r?\n/)) {
		if (!line) continue;
		const separator = line.indexOf("=");
		if (separator <= 0) return invalid();
		const key = line.slice(0, separator);
		const value = line.slice(separator + 1);
		if (
			!GITHUB_CREDENTIAL_FIELDS.has(key) ||
			fields.has(key) ||
			[...value].some((character) => {
				const code = character.charCodeAt(0);
				return code <= 31 || code === 127;
			})
		) {
			return invalid();
		}
		fields.set(key, value);
	}
	const protocol = fields.get("protocol");
	const host = fields.get("host");
	const username = fields.get("username");
	const password = fields.get("password");
	if (
		fields.size !== GITHUB_CREDENTIAL_FIELDS.size ||
		protocol !== "https" ||
		host !== expectedHost ||
		!username ||
		username.length > GITHUB_CREDENTIAL_USERNAME_MAX ||
		!password ||
		password.length > GITHUB_CREDENTIAL_PASSWORD_MAX
	) {
		return invalid();
	}
	return { username, password };
}

function trustedEnvironmentDirectory(value: string, label: string): string {
	if (
		!isAbsolute(value) ||
		value.length > 2_048 ||
		[...value].some((character) => {
			const code = character.charCodeAt(0);
			return code <= 31 || code === 127;
		})
	) {
		throw new Error(`${label} must be an absolute bounded directory`);
	}
	const canonical = realpathSync(value);
	if (!statSync(canonical).isDirectory()) {
		throw new Error(`${label} must be an absolute bounded directory`);
	}
	return canonical;
}

export function buildGitHubAuthEnvironment(
	githubCliPath: string,
	environment: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
	const homeValue = environment.HOME ?? homedir();
	const result: Record<string, string> = {
		PATH: [...new Set([dirname(githubCliPath), "/usr/bin", "/bin"])].join(":"),
		LANG: "C",
		LC_ALL: "C",
		HOME: trustedEnvironmentDirectory(homeValue, "HOME"),
	};
	if (environment.GH_CONFIG_DIR) {
		result.GH_CONFIG_DIR = trustedEnvironmentDirectory(
			environment.GH_CONFIG_DIR,
			"GH_CONFIG_DIR",
		);
	}
	if (environment.TMPDIR) {
		result.TMPDIR = trustedEnvironmentDirectory(environment.TMPDIR, "TMPDIR");
	}
	for (const name of [
		"USER",
		"LOGNAME",
		"SECURITYSESSIONID",
		"__CF_USER_TEXT_ENCODING",
	] as const) {
		const value = environment[name];
		if (
			value &&
			value.length <= 2_048 &&
			![...value].some((character) => {
				const code = character.charCodeAt(0);
				return code <= 31 || code === 127;
			})
		) {
			result[name] = value;
		}
	}
	return result;
}

const QA_GIT_USERNAME_ENV = "FLYWHEEL_QA_GIT_USERNAME";
const QA_GIT_PASSWORD_ENV = "FLYWHEEL_QA_GIT_PASSWORD";
const QA_GIT_ONCE_ENV = "FLYWHEEL_QA_GIT_CREDENTIAL_ONCE";

export function createOneShotGitCredentialHelper(
	directory: string,
	host: string,
	credential: GitHubCredential,
): {
	path: string;
	config: readonly string[];
	env: Readonly<Record<string, string>>;
} {
	if (
		host !== "github.com" ||
		!credential.username ||
		credential.username.length > GITHUB_CREDENTIAL_USERNAME_MAX ||
		!credential.password ||
		credential.password.length > GITHUB_CREDENTIAL_PASSWORD_MAX ||
		[credential.username, credential.password].some((value) =>
			[...value].some((character) => {
				const code = character.charCodeAt(0);
				return code <= 31 || code === 127;
			}),
		)
	) {
		throw new Error("GitHub credential helper input is invalid");
	}
	const canonicalDirectory = trustedEnvironmentDirectory(
		directory,
		"credential helper directory",
	);
	const helperPath = join(canonicalDirectory, "git-credential-once");
	const oncePath = join(canonicalDirectory, ".git-credential-consumed");
	writeFileSync(
		helperPath,
		`#!/bin/sh\nif [ "$#" -ne 1 ] || [ "$1" != get ]; then exit 0; fi\nif ! /bin/mkdir "$${QA_GIT_ONCE_ENV}" 2>/dev/null; then exit 0; fi\nprintf '%s\\n' 'protocol=https' 'host=${host}' "username=$${QA_GIT_USERNAME_ENV}" "password=$${QA_GIT_PASSWORD_ENV}" ''\n`,
		{ encoding: "utf8", mode: 0o700 },
	);
	chmodSync(helperPath, 0o700);
	return {
		path: helperPath,
		config: [
			"-c",
			"credential.helper=",
			"-c",
			`credential.https://${host}.helper=!${shellQuote(helperPath)}`,
		],
		env: {
			[QA_GIT_USERNAME_ENV]: credential.username,
			[QA_GIT_PASSWORD_ENV]: credential.password,
			[QA_GIT_ONCE_ENV]: oncePath,
		},
	};
}

export interface QaResultDependencies {
	/** Narrow process seam for tests; production uses an absolute bounded git. */
	runGit?: (
		args: readonly string[],
		opts: { cwd: string; env: Readonly<Record<string, string>> },
	) => string;
	/** Narrow seam for the one read-only `gh auth git-credential get` call. */
	runGitHubCredential?: (
		args: readonly string[],
		opts: {
			env: Readonly<Record<string, string>>;
			input: string;
		},
	) => string;
	/** Used only for the server-authorized resend, never for the first POST. */
	createClientRequestId?: () => string;
	/** Narrow settle-loop seams for deterministic tests. */
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	/** Test seams; production resolves trusted defaults. */
	gitPath?: string;
	sourceRepoPath?: string;
	stagingRoot?: string;
	trustedSshCommand?: string;
	githubCliPath?: string | false;
}

interface QaGitContext {
	runGit: NonNullable<QaResultDependencies["runGit"]>;
	runGitHubCredential?: NonNullable<
		QaResultDependencies["runGitHubCredential"]
	>;
	repoPath: string;
	stagingRoot: string;
	cleanupStagingRoot: boolean;
	readEnv: Readonly<Record<string, string>>;
	cleanEnv: Readonly<Record<string, string>>;
	safeConfig: readonly string[];
	githubCliPath?: string;
}

const GIT_TIMEOUT_MS = 30_000;
const GITHUB_AUTH_TIMEOUT_MS = 5_000;

function createQaGitContext(dependencies: QaResultDependencies): QaGitContext {
	const gitPath = resolveTrustedBinary(
		dependencies.gitPath,
		["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"],
		"git",
	);
	const trustedSshCommand = resolveTrustedSshCommand(
		dependencies.trustedSshCommand,
	);
	const repoPath = realpathSync(dependencies.sourceRepoPath ?? process.cwd());
	const cleanupStagingRoot = !dependencies.stagingRoot;
	const stagingRoot = resolve(
		dependencies.stagingRoot ??
			join(tmpdir(), `flywheel-qa-push-${randomUUID()}`),
	);
	const cleanHome = join(stagingRoot, "home");
	const githubCliPath = resolveOptionalTrustedBinary(
		dependencies.githubCliPath,
		["/usr/local/bin/gh", "/opt/homebrew/bin/gh", "/usr/bin/gh"],
		"GitHub CLI",
	);
	const runGitHubCredential = githubCliPath
		? (dependencies.runGitHubCredential ??
			((args, opts) =>
				execFileSync(githubCliPath, [...args], {
					env: { ...opts.env },
					input: opts.input,
					encoding: "utf8",
					stdio: ["pipe", "pipe", "pipe"],
					timeout: GITHUB_AUTH_TIMEOUT_MS,
					killSignal: "SIGKILL",
				})))
		: undefined;
	const baseEnv: Record<string, string> = {
		PATH: `${dirname(gitPath)}:/usr/bin:/bin`,
		LANG: "C",
		LC_ALL: "C",
		GIT_TERMINAL_PROMPT: "0",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_PAGER: "cat",
		GIT_ASKPASS: "/usr/bin/false",
		SSH_ASKPASS: "/usr/bin/false",
	};
	const readEnv: Record<string, string> = {
		...baseEnv,
		HOME: process.env.HOME ?? homedir(),
	};
	for (const name of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"] as const) {
		const value = process.env[name];
		if (value && isAbsolute(value) && value.length <= 2_048) {
			readEnv[name] = value;
		}
	}
	const cleanEnv: Record<string, string> = {
		...baseEnv,
		HOME: cleanHome,
		XDG_CONFIG_HOME: cleanHome,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
	};
	const githubConfigDirectory = process.env.GH_CONFIG_DIR
		? resolve(process.env.GH_CONFIG_DIR)
		: join(process.env.HOME ?? homedir(), ".config", "gh");
	if (
		isAbsolute(githubConfigDirectory) &&
		githubConfigDirectory.length <= 2_048
	) {
		cleanEnv.GH_CONFIG_DIR = githubConfigDirectory;
	}
	const sshAgent = process.env.SSH_AUTH_SOCK;
	if (sshAgent && isAbsolute(sshAgent) && sshAgent.length <= 2_048) {
		cleanEnv.SSH_AUTH_SOCK = sshAgent;
	}
	return {
		runGit:
			dependencies.runGit ??
			((args, opts) =>
				execFileSync(gitPath, [...args], {
					cwd: opts.cwd,
					env: { ...opts.env },
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
					timeout: GIT_TIMEOUT_MS,
					killSignal: "SIGKILL",
				})),
		runGitHubCredential,
		repoPath,
		stagingRoot,
		cleanupStagingRoot,
		readEnv,
		cleanEnv,
		safeConfig: [
			"-c",
			"core.fsmonitor=false",
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"core.pager=cat",
			"-c",
			`core.sshCommand=${trustedSshCommand}`,
			"-c",
			"core.askPass=/usr/bin/false",
			"-c",
			"protocol.ext.allow=never",
			"-c",
			"protocol.file.allow=always",
			"-c",
			"credential.helper=",
			"-c",
			"http.proxy=",
			"-c",
			"https.proxy=",
			"-c",
			"remote.origin.proxy=",
			"-c",
			"core.fsmonitorHookVersion=",
		],
		githubCliPath,
	};
}

function resolveTrustedBinary(
	requested: string | undefined,
	candidates: readonly string[],
	label: string,
): string {
	const candidate = requested ?? candidates.find((path) => existsSync(path));
	if (
		!candidate ||
		!isAbsolute(candidate) ||
		candidate.length > 1_024 ||
		!existsSync(candidate)
	) {
		throw new Error(`${label} must resolve to an absolute trusted executable`);
	}
	const resolved = realpathSync(candidate);
	const stat = statSync(resolved);
	if (!stat.isFile() || (stat.mode & 0o111) === 0) {
		throw new Error(`${label} must resolve to an executable file`);
	}
	return resolved;
}

function resolveOptionalTrustedBinary(
	requested: string | false | undefined,
	candidates: readonly string[],
	label: string,
): string | undefined {
	if (requested === false) return undefined;
	if (!requested) {
		const candidate = candidates.find((path) => existsSync(path));
		if (!candidate) return undefined;
		const resolved = resolveTrustedBinary(candidate, [], label);
		if (/[^A-Za-z0-9_./+-]/.test(resolved)) {
			throw new Error(`${label} path contains unsafe characters`);
		}
		return resolved;
	}
	const resolved = resolveTrustedBinary(requested, [], label);
	if (/[^A-Za-z0-9_./+-]/.test(resolved)) {
		throw new Error(`${label} path contains unsafe characters`);
	}
	return resolved;
}

function resolveTrustedSshCommand(requested: string | undefined): string {
	if (requested) {
		const executable = resolveTrustedBinary(requested, [], "SSH command");
		if (/[^A-Za-z0-9_./+-]/.test(executable)) {
			throw new Error("SSH command path contains unsafe characters");
		}
		return executable;
	}
	const command =
		"/usr/bin/ssh -F /dev/null -oBatchMode=yes -oClearAllForwardings=yes -oProxyCommand=none -oProxyJump=none -oPermitLocalCommand=no";
	const executable = command.split(" ", 1)[0]!;
	if (
		!isAbsolute(executable) ||
		!existsSync(executable) ||
		command.length > 1_024 ||
		/[\r\n;&|`$<>]/.test(command)
	) {
		throw new Error("SSH command must be an absolute bounded trusted command");
	}
	return command;
}

function runQaGit(
	git: QaGitContext,
	args: readonly string[],
	cwd: string,
	preserveObservedConfig: boolean,
	extraConfig: readonly string[] = [],
	extraEnv: Readonly<Record<string, string>> = {},
): string {
	return git.runGit([...git.safeConfig, ...extraConfig, ...args], {
		cwd,
		env: {
			...(preserveObservedConfig ? git.readEnv : git.cleanEnv),
			...extraEnv,
		},
	});
}

export async function qaResult(
	opts: QaResultOpts,
	dependencies: QaResultDependencies = {},
): Promise<void> {
	let git: QaGitContext | undefined;
	const getGit = (): QaGitContext => {
		if (!git) git = createQaGitContext(dependencies);
		return git;
	};
	const createClientRequestId =
		dependencies.createClientRequestId ?? randomUUID;
	const now = dependencies.now ?? Date.now;
	const wait = dependencies.sleep ?? sleep;
	const status = (opts.status ?? "").trim().toLowerCase();
	if (!VALID_STATUSES.has(status)) {
		console.error(
			`--status is required and must be one of: ${[...VALID_STATUSES].join(", ")}`,
		);
		process.exit(1);
	}
	const targetExec = (opts.targetExec ?? "").trim();
	if (!targetExec) {
		console.error("--target-exec <parent-execution-id> is required");
		process.exit(1);
	}

	const qaExecId = (opts.execId ?? process.env.FLYWHEEL_EXEC_ID ?? "").trim();
	if (!qaExecId) {
		console.error(
			"--exec-id or FLYWHEEL_EXEC_ID is required (this QA runner's own execution id)",
		);
		process.exit(1);
	}
	const issueId = process.env.FLYWHEEL_ISSUE_ID?.trim() ?? "";
	const projectName = process.env.FLYWHEEL_PROJECT_NAME?.trim() ?? "";
	const bridgeUrl = process.env.FLYWHEEL_BRIDGE_URL?.trim() ?? "";
	const requestId = randomUUID();
	const suppliedPrHeadSha = opts.prHeadSha?.trim() || undefined;
	const recoverableVerdict: RecoverableQaVerdict = {
		executionId: qaExecId,
		targetExecutionId: targetExec,
		issueId,
		projectName,
		status: status as "pass" | "fail",
		...(opts.summary?.trim() ? { summary: opts.summary.trim() } : {}),
		clientRequestId: requestId,
		...(suppliedPrHeadSha ? { prHeadSha: suppliedPrHeadSha } : {}),
	};
	const missingDeliveryEnv = [
		["FLYWHEEL_ISSUE_ID", issueId],
		["FLYWHEEL_PROJECT_NAME", projectName],
		["FLYWHEEL_BRIDGE_URL", bridgeUrl],
	].find(([, value]) => !value)?.[0];
	if (missingDeliveryEnv) {
		writeDeterministicFailure({
			execId: qaExecId,
			requestId,
			body: recoverableVerdict,
			recoverableVerdict,
			lastError: `qa_environment_context_unavailable: ${missingDeliveryEnv} environment variable is required`,
		});
	}
	let workflowCredential: string | undefined;
	try {
		workflowCredential = currentWorkflowCredentialFromEnv({
			executionId: qaExecId,
			kind: "submission",
			envName: "FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL",
		});
	} catch (error) {
		writeDeterministicFailure({
			execId: qaExecId,
			requestId,
			body: recoverableVerdict,
			recoverableVerdict,
			lastError: `qa_activation_context_unavailable: ${sanitizeText(errorMessage(error), 240)}`,
		});
	}
	if (!workflowCredential) {
		writeDeterministicFailure({
			execId: qaExecId,
			requestId,
			body: recoverableVerdict,
			recoverableVerdict,
			lastError:
				"workflow submission credential is required; legacy /events QA delivery is retired",
		});
	}

	let prHeadSha: string | undefined;
	try {
		// Decisions are server-attested. Avoid touching git on the first POST so
		// receipt-backed/no-worktree review nodes can submit.
		prHeadSha = suppliedPrHeadSha;
	} catch (error) {
		writeDeterministicFailure({
			execId: qaExecId,
			requestId,
			body: recoverableVerdict,
			recoverableVerdict,
			lastError: `qa_git_context_unavailable: ${sanitizeText(errorMessage(error), 240)}`,
		});
	}
	if (prHeadSha) recoverableVerdict.prHeadSha = prHeadSha;

	let submissionBody: WorkflowQaDecisionBody = {
		credential: workflowCredential,
		client_request_id: requestId,
		status: status as "pass" | "fail",
		...(prHeadSha ? { client_pr_head_sha: prHeadSha } : {}),
		...(opts.summary?.trim() ? { summary: opts.summary.trim() } : {}),
	};
	const endpoint = `${bridgeUrl.replace(/\/$/, "")}/api/workflow/decision`;

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};

	let lastError: string | undefined;
	let landHeadPushUsed = false;
	let landHeadPrePushOid: string | undefined;
	let landHeadSettleDeadlineMs: number | undefined;
	let landHeadSettleAttempts = 0;
	for (let attempt = 1; attempt <= ATTEMPT_COUNT; attempt += 1) {
		let deterministicFailure: { reason: string; lastError: string } | undefined;
		let authorizedResend = false;
		let settleDelayMs: number | undefined;
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
			let response: Response;
			try {
				response = await fetch(endpoint, {
					method: "POST",
					headers,
					body: JSON.stringify(submissionBody),
					signal: controller.signal,
				});
			} finally {
				clearTimeout(timer);
			}
			const rawBody = await response.text();
			const parsed = parseResponseObject(rawBody);
			const reason = responseReason(parsed);
			const hint = typeof parsed?.hint === "string" ? parsed.hint : undefined;
			const detail = parsed?.detail;

			if (response.ok && parsed?.ok === true) {
				if (
					typeof parsed.claimId !== "number" ||
					!Number.isFinite(parsed.claimId) ||
					typeof parsed.serverSeq !== "number" ||
					!Number.isFinite(parsed.serverSeq) ||
					typeof parsed.idempotentReplay !== "boolean"
				) {
					lastError = `Malformed workflow decision acknowledgement from ${endpoint} (status ${response.status})`;
				} else {
					clearMarker(qaExecId);
					console.log(
						`[qa-result] decision consumed (claimId=${parsed.claimId} serverSeq=${parsed.serverSeq} idempotentReplay=${parsed.idempotentReplay}) for target=${targetExec} (attempt ${attempt}/${ATTEMPT_COUNT})`,
					);
					return;
				}
			} else if (
				response.status === 409 &&
				reason === "land_head_pr_not_at_tip"
			) {
				lastError = formatResponseFailure({
					endpoint,
					status: response.status,
					reason,
					hint,
					rawBody,
					detail,
				});
				if (landHeadPushUsed) {
					const repeatedInstruction = parseLandHeadPushInstruction(detail);
					const remainingSettleMs =
						landHeadSettleDeadlineMs === undefined
							? 0
							: landHeadSettleDeadlineMs - now();
					const stalePrePushRead =
						repeatedInstruction.ok &&
						repeatedInstruction.value.currentHeadOid === landHeadPrePushOid;
					if (
						stalePrePushRead &&
						landHeadSettleAttempts < LAND_HEAD_SETTLE_MAX_ATTEMPTS &&
						remainingSettleMs > 0
					) {
						settleDelayMs = Math.min(
							LAND_HEAD_SETTLE_INTERVAL_MS,
							remainingSettleMs,
						);
						landHeadSettleAttempts += 1;
						authorizedResend = true;
					} else {
						const failureKind = !repeatedInstruction.ok
							? "invalid_probe"
							: stalePrePushRead
								? "settle_timeout"
								: "head_changed";
						deterministicFailure = {
							reason,
							lastError: `${lastError}; ${freshHandshakeGuidance({
								failureKind,
								status: status as "pass" | "fail",
								targetExec,
								summary: opts.summary?.trim() || undefined,
							})}`,
						};
					}
				} else {
					if (!("client_request_id" in submissionBody)) {
						deterministicFailure = {
							reason,
							lastError: `${lastError}; authorized resend requires a workflow decision payload`,
						};
					} else {
						let nextRequestId: string | undefined;
						try {
							nextRequestId = createClientRequestId().trim();
						} catch (error) {
							deterministicFailure = {
								reason,
								lastError: `${lastError}; failed to create a distinct clientRequestId for the authorized resend: ${sanitizeText(errorMessage(error), 240)}`,
							};
						}
						if (
							!deterministicFailure &&
							(!nextRequestId ||
								nextRequestId === submissionBody.client_request_id)
						) {
							deterministicFailure = {
								reason,
								lastError: `${lastError}; failed to create a distinct clientRequestId for the authorized resend`,
							};
						}
						if (!deterministicFailure && nextRequestId) {
							const pendingVerdict = {
								...recoverableVerdict,
								clientRequestId: nextRequestId,
							};
							const markerWritten = writeMarker({
								execId: qaExecId,
								requestId: nextRequestId,
								body: submissionBody,
								recoverableVerdict: pendingVerdict,
								lastError: "authorized_land_head_push_pending",
							});
							if (!markerWritten) {
								deterministicFailure = {
									reason,
									lastError: `${lastError}; recoverable verdict marker could not be persisted before push`,
								};
							}
							// Spend the mutation budget before entering any operation that may
							// have pushed successfully before throwing.
							landHeadPushUsed = markerWritten;
							const authorization = markerWritten
								? performAuthorizedLandHeadPush(detail, getGit())
								: { ok: false as const, error: "marker_not_persisted" };
							if (!authorization.ok) {
								deterministicFailure = {
									reason,
									lastError: `${lastError}; ${authorization.error}`,
								};
							} else {
								submissionBody = {
									...submissionBody,
									client_request_id: nextRequestId,
								};
								landHeadPrePushOid = authorization.prePushHeadOid;
								landHeadSettleDeadlineMs = now() + LAND_HEAD_SETTLE_TIMEOUT_MS;
								authorizedResend = true;
							}
						}
					}
				}
			} else {
				lastError = formatResponseFailure({
					endpoint,
					status: response.status,
					reason,
					hint,
					rawBody,
					detail,
				});
			}

			if (!authorizedResend) {
				console.error(
					`[qa-result] attempt ${attempt}/${ATTEMPT_COUNT} failed: ${lastError}`,
				);
			}
			const transientStatus =
				response.status >= 500 ||
				response.status === 408 ||
				response.status === 425 ||
				response.status === 429;
			if (
				!transientStatus &&
				reason &&
				classifyQaResultRejection(reason) === "fail"
			) {
				deterministicFailure = {
					reason,
					lastError: lastError ?? `${endpoint} rejected the workflow decision`,
				};
			}
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
			console.error(
				`[qa-result] attempt ${attempt}/${ATTEMPT_COUNT} failed: ${lastError}`,
			);
		}
		if (deterministicFailure) {
			if (deterministicFailure.reason === "replay_payload_mismatch") {
				console.error(
					"[qa-result] The credential was consumed by another submission. This does NOT prove the current verdict was recorded. Stop retrying, never strip the credential, and report both conclusions to the Lead.",
				);
			}
			writeDeterministicFailure({
				execId: qaExecId,
				requestId: activeClientRequestId(submissionBody, requestId),
				body: submissionBody,
				recoverableVerdict: {
					...recoverableVerdict,
					clientRequestId: activeClientRequestId(submissionBody, requestId),
				},
				lastError: deterministicFailure.lastError,
			});
		}
		if (authorizedResend) {
			// The one authorized resend is independent of the generic retry budget.
			if (settleDelayMs !== undefined) await wait(settleDelayMs);
			attempt -= 1;
			continue;
		}
		if (attempt < ATTEMPT_COUNT) {
			await sleep(BACKOFF_MS[attempt - 1] ?? 0);
		}
	}

	const markerWritten = writeMarker({
		execId: qaExecId,
		requestId: activeClientRequestId(submissionBody, requestId),
		body: submissionBody,
		recoverableVerdict: {
			...recoverableVerdict,
			clientRequestId: activeClientRequestId(submissionBody, requestId),
		},
		lastError,
	});
	console.error(
		`[qa-result] FAIL-CLOSE: ${ATTEMPT_COUNT} attempts failed. ${
			markerWritten ? "Marker written." : "Marker NOT written (see above)."
		} Last error: ${lastError}`,
	);
	process.exit(1);
}

function parseResponseObject(raw: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function responseReason(
	parsed: Record<string, unknown> | undefined,
): string | undefined {
	if (typeof parsed?.reason === "string") return parsed.reason;
	return typeof parsed?.error === "string" ? parsed.error : undefined;
}

interface LandHeadPushInstruction {
	expectedHeadOid: string;
	expectedHeadRefName: string;
	prNumber: number;
	repoSlug: string;
	currentHeadOid: string;
}

function performAuthorizedLandHeadPush(
	detail: unknown,
	git: QaGitContext,
): { ok: true; prePushHeadOid: string } | { ok: false; error: string } {
	const instruction = parseLandHeadPushInstruction(detail);
	if (!instruction.ok) return instruction;

	const fullHeadRef = `refs/heads/${instruction.value.expectedHeadRefName}`;
	try {
		runQaGit(git, ["check-ref-format", fullHeadRef], git.repoPath, false);
	} catch {
		return {
			ok: false,
			error:
				"invalid land_head_pr_not_at_tip detail: expectedHeadRefName is not a valid full branch ref",
		};
	}

	let pushUrlsOutput: string;
	try {
		pushUrlsOutput = runQaGit(
			git,
			["remote", "get-url", "--push", "--all", "origin"],
			git.repoPath,
			true,
		);
	} catch {
		return {
			ok: false,
			error: "could not attest origin's configured push endpoint",
		};
	}
	const pushUrls = pushUrlsOutput
		.split(/\r?\n/)
		.filter((value) => value.length > 0);
	if (pushUrls.length !== 1) {
		return {
			ok: false,
			error: "origin must resolve to exactly one nonempty push endpoint",
		};
	}

	let pushRepoSlug: string;
	try {
		pushRepoSlug = parseGitHubPushEndpoint(pushUrls[0]!);
	} catch {
		return {
			ok: false,
			error: "origin push endpoint is not an explicit github.com owner/repo",
		};
	}
	if (pushRepoSlug !== instruction.value.repoSlug) {
		return {
			ok: false,
			error:
				"origin push endpoint does not match the server-authorized repoSlug",
		};
	}
	const isHttpsGithubEndpoint = /^https:\/\/github\.com\//i.test(pushUrls[0]!);
	if (
		isHttpsGithubEndpoint &&
		(!git.githubCliPath || !git.runGitHubCredential)
	) {
		return {
			ok: false,
			error: "trusted GitHub CLI credential helper is unavailable",
		};
	}
	let githubCredential: GitHubCredential | undefined;
	if (isHttpsGithubEndpoint) {
		const credentialHost = "github.com";
		try {
			const output = git.runGitHubCredential!(
				["auth", "git-credential", "get"],
				{
					env: buildGitHubAuthEnvironment(git.githubCliPath!),
					input: `protocol=https\nhost=${credentialHost}\n\n`,
				},
			);
			githubCredential = parseGitHubCredentialOutput(output, credentialHost);
		} catch {
			return {
				ok: false,
				error:
					"trusted GitHub CLI credential lookup failed for github.com; repair gh auth login before retrying",
			};
		}
	}

	let rawPushEndpoint: string;
	try {
		rawPushEndpoint = readRawOriginPushEndpoint(git);
	} catch {
		return {
			ok: false,
			error: "could not read exactly one raw origin push endpoint",
		};
	}
	let objectDirectory: string;
	try {
		const rawObjectDirectory = singleBoundedGitLine(
			runQaGit(git, ["rev-parse", "--git-path", "objects"], git.repoPath, true),
			"object directory",
		);
		objectDirectory = realpathSync(
			isAbsolute(rawObjectDirectory)
				? rawObjectDirectory
				: resolve(git.repoPath, rawObjectDirectory),
		);
		if (!statSync(objectDirectory).isDirectory()) {
			throw new Error("object path is not a directory");
		}
	} catch {
		return {
			ok: false,
			error: "could not resolve the source Git object directory",
		};
	}

	mkdirSync(git.stagingRoot, { recursive: true, mode: 0o700 });
	mkdirSync(join(git.stagingRoot, "home"), { recursive: true, mode: 0o700 });
	const stagingDir = mkdtempSync(join(git.stagingRoot, "qa-push-"));
	try {
		runQaGit(git, ["init", "--quiet", stagingDir], git.stagingRoot, false);
		const alternatesPath = join(
			stagingDir,
			".git",
			"objects",
			"info",
			"alternates",
		);
		mkdirSync(dirname(alternatesPath), { recursive: true });
		writeFileSync(alternatesPath, `${objectDirectory}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		runQaGit(
			git,
			["cat-file", "-e", `${instruction.value.expectedHeadOid}^{commit}`],
			stagingDir,
			false,
		);
		runQaGit(
			git,
			["remote", "add", "origin", rawPushEndpoint],
			stagingDir,
			false,
		);
		if (rawPushEndpoint !== pushUrls[0]!) {
			runQaGit(
				git,
				[
					"config",
					"--local",
					"--add",
					`url.${pushUrls[0]!}.pushInsteadOf`,
					rawPushEndpoint,
				],
				stagingDir,
				false,
			);
		}
		const reconstructedPushEndpoint = singleBoundedGitLine(
			runQaGit(
				git,
				["remote", "get-url", "--push", "--all", "origin"],
				stagingDir,
				false,
			),
			"reconstructed push endpoint",
		);
		if (reconstructedPushEndpoint !== pushUrls[0]!) {
			return {
				ok: false,
				error:
					"clean staging origin did not reconstruct the attested push endpoint",
			};
		}
		const credentialHelper = githubCredential
			? createOneShotGitCredentialHelper(
					stagingDir,
					"github.com",
					githubCredential,
				)
			: undefined;
		runQaGit(
			git,
			["push", "origin", `${instruction.value.expectedHeadOid}:${fullHeadRef}`],
			stagingDir,
			false,
			credentialHelper?.config ?? [],
			credentialHelper?.env ?? {},
		);
	} catch (error) {
		return {
			ok: false,
			error: `authorized git push failed: ${sanitizeText(errorMessage(error), 240)}`,
		};
	} finally {
		rmSync(stagingDir, { recursive: true, force: true });
		if (git.cleanupStagingRoot) {
			rmSync(git.stagingRoot, { recursive: true, force: true });
		}
	}
	return { ok: true, prePushHeadOid: instruction.value.currentHeadOid };
}

function readRawOriginPushEndpoint(git: QaGitContext): string {
	try {
		return singleBoundedGitLine(
			runQaGit(
				git,
				["config", "--local", "--get-all", "remote.origin.pushurl"],
				git.repoPath,
				true,
			),
			"raw origin pushurl",
		);
	} catch {
		return singleBoundedGitLine(
			runQaGit(
				git,
				["config", "--local", "--get-all", "remote.origin.url"],
				git.repoPath,
				true,
			),
			"raw origin URL",
		);
	}
}

function singleBoundedGitLine(output: string, label: string): string {
	const lines = output.split(/\r?\n/).filter((line) => line.length > 0);
	if (lines.length !== 1) throw new Error(`${label} must contain one line`);
	const value = lines[0]!;
	if (
		value.length > 2_048 ||
		[...value].some((character) => character.charCodeAt(0) <= 32)
	) {
		throw new Error(`${label} contains an invalid character`);
	}
	return value;
}

function parseLandHeadPushInstruction(
	detail: unknown,
): { ok: true; value: LandHeadPushInstruction } | { ok: false; error: string } {
	if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
		return invalidInstruction("detail must be an object");
	}
	const input = detail as Record<string, unknown>;
	if (
		typeof input.expectedHeadOid !== "string" ||
		!/^[0-9a-f]{40}$/i.test(input.expectedHeadOid)
	) {
		return invalidInstruction("expectedHeadOid must be a 40-hex object id");
	}
	if (
		typeof input.currentHeadOid !== "string" ||
		!/^[0-9a-f]{40}$/i.test(input.currentHeadOid)
	) {
		return invalidInstruction("currentHeadOid must be a 40-hex object id");
	}
	if (
		typeof input.expectedHeadRefName !== "string" ||
		input.expectedHeadRefName.length === 0 ||
		input.expectedHeadRefName.length > 240
	) {
		return invalidInstruction("expectedHeadRefName must be a bounded string");
	}
	if (
		!Number.isSafeInteger(input.prNumber) ||
		(input.prNumber as number) <= 0
	) {
		return invalidInstruction("prNumber must be a positive integer");
	}
	const repoSlug = normalizeAuthorizedRepoSlug(input.repoSlug);
	if (!repoSlug) {
		return invalidInstruction("repoSlug must be a valid owner/repo slug");
	}
	return {
		ok: true,
		value: {
			expectedHeadOid: input.expectedHeadOid.toLowerCase(),
			expectedHeadRefName: input.expectedHeadRefName,
			prNumber: input.prNumber as number,
			repoSlug,
			currentHeadOid: input.currentHeadOid.toLowerCase(),
		},
	};
}

function invalidInstruction(reason: string): { ok: false; error: string } {
	return {
		ok: false,
		error: `invalid land_head_pr_not_at_tip detail: ${reason}`,
	};
}

function normalizeAuthorizedRepoSlug(input: unknown): string | undefined {
	if (typeof input !== "string") return undefined;
	const parts = input.split("/");
	if (parts.length !== 2) return undefined;
	const validSegment = (part: string): boolean =>
		part !== "." && part !== ".." && /^[A-Za-z0-9_.-]+$/.test(part);
	if (!validSegment(parts[0]!) || !validSegment(parts[1]!)) return undefined;
	return `${parts[0]!.toLowerCase()}/${parts[1]!.toLowerCase()}`;
}

function freshHandshakeGuidance(args: {
	failureKind: "settle_timeout" | "head_changed" | "invalid_probe";
	status: "pass" | "fail";
	targetExec: string;
	summary: string | undefined;
}): string {
	const command = [
		"flywheel-comm",
		"qa-result",
		"--status",
		shellQuote(args.status),
		"--target-exec",
		shellQuote(args.targetExec),
	];
	if (args.summary) command.push("--summary", shellQuote(args.summary));
	const prefix =
		args.failureKind === "settle_timeout"
			? "The authorized push was not visible at the PR tip before the 5s settle timeout. Rerun qa-result to re-probe without making additional commits"
			: args.failureKind === "head_changed"
				? "The PR head changed after the authorized push. Inspect the PR branch before rerunning qa-result"
				: "The server returned an invalid post-push PR-head probe. Inspect the PR branch before rerunning qa-result";
	return `${prefix}: ${command.join(" ")}`;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatResponseFailure(args: {
	endpoint: string;
	status: number;
	reason: string | undefined;
	hint: string | undefined;
	rawBody: string;
	detail?: unknown;
}): string {
	const summary = args.reason ?? (args.rawBody.trim() || "empty response");
	const structuredDetail = formatSanitizedDetail(args.detail);
	return `${args.endpoint} returned HTTP ${args.status}: ${sanitizeText(summary, 300)}${
		structuredDetail ? `; detail=${structuredDetail}` : ""
	}${args.hint ? `; hint=${sanitizeText(args.hint, 300)}` : ""}`;
}

function formatSanitizedDetail(detail: unknown): string | undefined {
	if (detail === undefined) return undefined;
	const sanitized = sanitizeDetailValue(detail, 0);
	return sanitizeText(JSON.stringify(sanitized), 1200);
}

function sanitizeDetailValue(value: unknown, depth: number): unknown {
	if (depth >= 3) return "[truncated]";
	if (typeof value === "string") return sanitizeText(value, 240);
	if (
		typeof value === "number" ||
		typeof value === "boolean" ||
		value === null
	) {
		return value;
	}
	if (Array.isArray(value)) {
		return value
			.slice(0, 12)
			.map((entry) => sanitizeDetailValue(entry, depth + 1));
	}
	if (value && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [rawKey, entry] of Object.entries(value).slice(0, 24)) {
			const key = sanitizeText(rawKey, 80);
			result[key] = /credential|password|secret|token/i.test(key)
				? "[redacted]"
				: sanitizeDetailValue(entry, depth + 1);
		}
		return result;
	}
	return sanitizeText(String(value), 240);
}

function sanitizeText(value: string, maxLength: number): string {
	const printable = [...value]
		.map((character) => {
			const code = character.charCodeAt(0);
			return code <= 31 || code === 127 ? "?" : character;
		})
		.join("");
	return printable.length <= maxLength
		? printable
		: `${printable.slice(0, maxLength)}...[truncated]`;
}

function writeDeterministicFailure(args: {
	execId: string;
	requestId: string;
	body: unknown;
	recoverableVerdict: RecoverableQaVerdict;
	lastError: string;
}): never {
	const markerWritten = writeMarker(args);
	console.error(
		`[qa-result] FAIL-CLOSE: deterministic rejection. ${
			markerWritten ? "Marker written." : "Marker NOT written (see above)."
		} ${args.lastError}`,
	);
	process.exit(1);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeMarker(args: {
	execId: string;
	requestId: string;
	body: unknown;
	recoverableVerdict?: RecoverableQaVerdict;
	lastError: string | undefined;
}): boolean {
	const home = process.env.HOME ?? homedir();
	const dir = join(home, ".flywheel", "state", "qa-result-failed");
	const markerPath = join(dir, `${args.execId}.json`);
	const marker = buildQaResultFailureMarker(args);
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(markerPath, JSON.stringify(marker, null, 2), {
			encoding: "utf8",
			mode: 0o600,
		});
		chmodSync(markerPath, 0o600);
		return true;
	} catch (err) {
		console.error(
			`[qa-result] CRITICAL: marker write failed at ${markerPath}: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		if (marker.recoverable_verdict) {
			console.error(
				`[qa-result] RECOVERABLE VERDICT: ${JSON.stringify(marker.recoverable_verdict)}`,
			);
		}
		return false;
	}
}

function clearMarker(execId: string): void {
	const home = process.env.HOME ?? homedir();
	const markerPath = join(
		home,
		".flywheel",
		"state",
		"qa-result-failed",
		`${execId}.json`,
	);
	try {
		unlinkSync(markerPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.error(
				`[qa-result] marker cleanup failed at ${markerPath}: ${errorMessage(error)}`,
			);
		}
	}
}

function activeClientRequestId(body: unknown, fallback: string): string {
	if (body && typeof body === "object" && !Array.isArray(body)) {
		const requestId = (body as Record<string, unknown>).client_request_id;
		if (typeof requestId === "string" && requestId) return requestId;
	}
	return fallback;
}

/** Recoverable verdict marker: keeps status/summary, never the credential. */
export function buildQaResultFailureMarker(args: {
	execId: string;
	requestId: string;
	body: unknown;
	recoverableVerdict?: RecoverableQaVerdict;
	lastError: string | undefined;
	timestamp?: string;
}): {
	execution_id: string;
	client_request_id: string;
	error: string | undefined;
	timestamp: string;
	body_digest: string;
	status?: "pass" | "fail";
	summary?: string;
	recoverable_verdict?: RecoverableQaVerdict;
} {
	const body =
		args.body && typeof args.body === "object" && !Array.isArray(args.body)
			? (args.body as Record<string, unknown>)
			: {};
	const payload =
		body.payload &&
		typeof body.payload === "object" &&
		!Array.isArray(body.payload)
			? (body.payload as Record<string, unknown>)
			: {};
	const status = body.status ?? payload.status;
	const summary = body.summary ?? payload.summary;
	return {
		execution_id: args.execId,
		client_request_id: args.requestId,
		error: args.lastError,
		timestamp: args.timestamp ?? new Date().toISOString(),
		body_digest: createHash("sha256")
			.update(JSON.stringify(args.body))
			.digest("hex"),
		...(status === "pass" || status === "fail" ? { status } : {}),
		...(typeof summary === "string" && summary ? { summary } : {}),
		...(args.recoverableVerdict
			? { recoverable_verdict: args.recoverableVerdict }
			: {}),
	};
}
