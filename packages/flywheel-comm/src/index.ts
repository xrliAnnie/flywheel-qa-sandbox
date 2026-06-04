#!/usr/bin/env node

import { parseArgs } from "node:util";
import {
	DEFAULT_GATE_TIMEOUT_MS,
	DEFAULT_TIMEOUT_BEHAVIOR,
} from "flywheel-config";
import { ask } from "./commands/ask.js";
import { awaitCodexGate } from "./commands/await-codex-gate.js";
import { capture } from "./commands/capture.js";
import { check } from "./commands/check.js";
import { cleanupMessages } from "./commands/cleanup-messages.js";
import { complete } from "./commands/complete.js";
import { gate } from "./commands/gate.js";
import { inbox } from "./commands/inbox.js";
import { type NotifyArgs, notify } from "./commands/notify.js";
import { pending } from "./commands/pending.js";
import {
	type PublishReportArgs,
	publishReport,
} from "./commands/publish-report.js";
import { respond } from "./commands/respond.js";
import { search } from "./commands/search.js";
import { send } from "./commands/send.js";
import { sessions } from "./commands/sessions.js";
import { type SetArtifactArgs, setArtifact } from "./commands/set-artifact.js";
import { stage } from "./commands/stage.js";
import { verifyApproval } from "./commands/verify-approval.js";
import {
	type VisualCaptureArgs,
	visualCapture,
	visualCaptureStdout,
} from "./commands/visual-capture.js";
import { CommDB } from "./db.js";
import { resolveDbPath } from "./resolve-db-path.js";

function printUsage(): void {
	console.log(`Usage: flywheel-comm <command> [options]

Commands:
  ask       Ask your Lead a question (non-blocking; Lead notified ≤1 poll tick via Bridge)
  check     Check if a question has been answered
  gate      Block at a checkpoint until Lead responds (ask+poll+resolve).
            With --no-block (FLY-191): park the question + return questionId
            JSON immediately; runner goes idle and is woken by mailbox.
  verify-approval  MANDATORY pre-ship authority check (FLY-191): re-verify the
            approve_to_ship gate response + StateStore approved_to_ship +
            pr_head_sha against --pr-head $(git rev-parse HEAD). Fail-closed;
            exit 0 only when approved. The wake message itself is NEVER authority.
  pending   List unanswered questions for a lead
  respond   Respond to a runner's question
  send      Send an instruction to a runner (Lead use)
  inbox     Check for instructions from Lead (Runner use)
  sessions           List runner sessions
  sessions register  Register a runner session in CommDB
  capture   Capture tmux output of a runner session
  search    Search tmux output for a regex pattern
  stage     Report pipeline stage to Bridge (Runner use)
  complete  Emit session_completed terminal event to Bridge (Runner use)
  await-codex-gate  Block until Bridge-written Codex review JSON or skip marker appears (Runner use)
  cleanup   Delete read messages older than TTL (default 24h)
  visual-capture   Run ProofShot UI/3D capture, select artifacts, write manifest (GEO-151)
  notify    POST artifact_emitted event to Bridge after capture+Read (GEO-151)
  publish-report   Publish HTML report to hosting + deliver to Discord as
            screenshot preview + unguessable link (FLY-203). Flags:
            --html <file> --project <name> [--title <t>] [--channel <id>]
            [--no-screenshot]. Env: FLYWHEEL_BRIDGE_URL, TEAMLEAD_API_TOKEN,
            FLYWHEEL_REMOTE_REPORTS=0 disables. Always prints a one-line
            JSON envelope to stdout.
  set-artifact   Register build output (.glb/.stl/.3mf) path for 3D capture (GEO-151)

Global options:
  --db <path>       Explicit DB path
  --project <name>  Project name (resolves to ~/.flywheel/comm/<name>/comm.db)
  --json            Output as JSON

respond options:
  --bridge-url <url>  Route an approve_to_ship gate response through the Bridge
                      founder-consent wrapper (FLY-175). Required for the
                      approve_to_ship checkpoint unless BRIDGE_URL env is set;
                      omitting it for that gate is fail-closed (refuses to write).

Environment:
  FLYWHEEL_COMM_DB           DB path (overridden by --db)
  BRIDGE_URL                 Default Bridge URL for the approve_to_ship gate route
  TEAMLEAD_API_TOKEN         Bearer token for the Bridge gate-response endpoint
  FLYWHEEL_COMM_BYPASS_BRIDGE Set =1 for emergency direct write of an
                             approve_to_ship gate (loud audit row + stderr warning)`);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const command = args[0];

	if (!command || command === "--help" || command === "-h") {
		printUsage();
		process.exit(0);
	}

	// Parse global options from remaining args
	const commandArgs = args.slice(1);

	switch (command) {
		case "ask":
			runAsk(commandArgs);
			break;
		case "check":
			runCheck(commandArgs);
			break;
		case "gate":
			await runGate(commandArgs);
			break;
		case "pending":
			runPending(commandArgs);
			break;
		case "respond":
			await runRespond(commandArgs);
			break;
		case "send":
			await runSend(commandArgs);
			break;
		case "inbox":
			runInbox(commandArgs);
			break;
		case "sessions":
			if (commandArgs[0] === "register") {
				runSessionsRegister(commandArgs.slice(1));
			} else {
				runSessions(commandArgs);
			}
			break;
		case "capture":
			runCapture(commandArgs);
			break;
		case "search":
			await runSearch(commandArgs);
			break;
		case "stage":
			await runStage(commandArgs);
			break;
		case "complete":
			await runComplete(commandArgs);
			break;
		case "await-codex-gate":
			await runAwaitCodexGate(commandArgs);
			break;
		case "verify-approval":
			runVerifyApproval(commandArgs);
			break;
		case "cleanup":
			runCleanup(commandArgs);
			break;
		case "visual-capture":
			await runVisualCapture(commandArgs);
			break;
		case "publish-report":
			await runPublishReport(commandArgs);
			break;
		case "notify":
			await runNotify(commandArgs);
			break;
		case "set-artifact":
			await runSetArtifact(commandArgs);
			break;
		default:
			console.error(`Unknown command: ${command}`);
			printUsage();
			process.exit(1);
	}
}

function runAsk(args: string[]): void {
	const { values, positionals } = parseArgs({
		args,
		options: {
			lead: { type: "string" },
			"exec-id": { type: "string" },
			db: { type: "string" },
			project: { type: "string" },
			json: { type: "boolean", default: false },
		},
		allowPositionals: true,
	});

	if (!values.lead) {
		throw new Error("--lead is required");
	}

	const question = positionals.join(" ");
	if (!question) {
		throw new Error("Question text is required");
	}

	const dbPath = resolveDbPath({ db: values.db, project: values.project });
	const questionId = ask({
		lead: values.lead,
		execId: values["exec-id"],
		question,
		dbPath,
	});

	if (values.json) {
		console.log(JSON.stringify({ question_id: questionId }));
	} else {
		console.log(questionId);
	}
}

function runCheck(args: string[]): void {
	const { values, positionals } = parseArgs({
		args,
		options: {
			db: { type: "string" },
			project: { type: "string" },
			json: { type: "boolean", default: false },
		},
		allowPositionals: true,
	});

	const questionId = positionals[0];
	if (!questionId) {
		throw new Error("Question ID is required");
	}

	const dbPath = resolveDbPath({ db: values.db, project: values.project });
	const result = check({ questionId, dbPath });

	if (values.json) {
		console.log(JSON.stringify(result));
	} else if (result.status === "answered") {
		console.log(result.content);
	} else {
		console.log("not yet");
	}
	// Always exit 0 per Codex #4
}

function runPending(args: string[]): void {
	const { values } = parseArgs({
		args,
		options: {
			lead: { type: "string" },
			db: { type: "string" },
			project: { type: "string" },
			json: { type: "boolean", default: false },
		},
		allowPositionals: false,
	});

	if (!values.lead) {
		throw new Error("--lead is required");
	}

	const dbPath = resolveDbPath({ db: values.db, project: values.project });
	const questions = pending({ lead: values.lead, dbPath });

	if (values.json) {
		console.log(JSON.stringify(questions));
	} else if (questions.length === 0) {
		console.log("No pending questions.");
	} else {
		for (const q of questions) {
			console.log(`[${q.id}] from ${q.from_agent} (${q.created_at}):`);
			console.log(`  ${q.content}`);
		}
	}
}

async function runRespond(args: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		options: {
			lead: { type: "string" },
			db: { type: "string" },
			project: { type: "string" },
			// FLY-175: route approve_to_ship gate responses through the Bridge
			// founder-consent wrapper. Falls back to BRIDGE_URL env when unset.
			"bridge-url": { type: "string" },
			json: { type: "boolean", default: false },
		},
		allowPositionals: true,
	});

	if (!values.lead) {
		throw new Error("--lead is required (identifies who is responding)");
	}

	const questionId = positionals[0];
	if (!questionId) {
		throw new Error("Question ID is required");
	}

	const answer = positionals.slice(1).join(" ");
	if (!answer) {
		throw new Error("Answer text is required");
	}

	const dbPath = resolveDbPath({ db: values.db, project: values.project });
	await respond({
		questionId,
		fromAgent: values.lead,
		answer,
		dbPath,
		bridgeUrl: values["bridge-url"],
		projectName: values.project,
	});

	if (values.json) {
		console.log(JSON.stringify({ status: "ok", question_id: questionId }));
	} else {
		console.log(`Responded to ${questionId}`);
	}
}

async function runSend(args: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		options: {
			from: { type: "string" },
			to: { type: "string" },
			db: { type: "string" },
			project: { type: "string" },
			json: { type: "boolean", default: false },
		},
		allowPositionals: true,
	});

	if (!values.from) {
		throw new Error("--from is required (Lead agent ID)");
	}
	if (!values.to) {
		throw new Error("--to is required (Runner execution ID)");
	}

	const content = positionals.join(" ");
	if (!content) {
		throw new Error("Instruction text is required");
	}

	const dbPath = resolveDbPath({ db: values.db, project: values.project });
	const instructionId = await send({
		fromAgent: values.from,
		toAgent: values.to,
		content,
		dbPath,
	});

	if (values.json) {
		console.log(JSON.stringify({ instruction_id: instructionId }));
	} else {
		console.log(instructionId);
	}
}

function runInbox(args: string[]): void {
	const { values } = parseArgs({
		args,
		options: {
			"exec-id": { type: "string" },
			db: { type: "string" },
			project: { type: "string" },
			json: { type: "boolean", default: false },
		},
		allowPositionals: false,
	});

	if (!values["exec-id"]) {
		throw new Error("--exec-id is required");
	}

	const dbPath = resolveDbPath({ db: values.db, project: values.project });
	const result = inbox({ execId: values["exec-id"], dbPath });

	if (values.json) {
		console.log(JSON.stringify(result.instructions));
	} else if (result.instructions.length === 0) {
		console.log("No instructions.");
	} else {
		for (const inst of result.instructions) {
			console.log(`[${inst.id}] from ${inst.from_agent}: ${inst.content}`);
		}
	}
}

function runSessions(args: string[]): void {
	const { values } = parseArgs({
		args,
		options: {
			project: { type: "string" },
			db: { type: "string" },
			active: { type: "boolean", default: false },
			lead: { type: "string" },
			json: { type: "boolean", default: false },
		},
		allowPositionals: false,
	});

	const dbPath = resolveDbPath({ db: values.db, project: values.project });
	const result = sessions({
		dbPath,
		projectName: values.project,
		activeOnly: values.active,
		leadId: values.lead,
	});

	if (values.json) {
		console.log(JSON.stringify(result));
	} else if (result.length === 0) {
		console.log("No sessions.");
	} else {
		for (const s of result) {
			console.log(
				`[${s.execution_id}] ${s.tmux_window} ${s.issue_id ?? "-"} ${s.status} (started ${s.started_at})`,
			);
		}
	}
}

function runSessionsRegister(args: string[]): void {
	const { values } = parseArgs({
		args,
		options: {
			"exec-id": { type: "string" },
			project: { type: "string" },
			db: { type: "string" },
			issue: { type: "string" },
			lead: { type: "string" },
			window: { type: "string" },
		},
		allowPositionals: false,
	});

	const execId = values["exec-id"];
	if (!execId) {
		console.error("Missing required --exec-id");
		process.exit(1);
	}
	const projectName = values.project;
	if (!projectName) {
		console.error("Missing required --project");
		process.exit(1);
	}

	const dbPath = resolveDbPath({ db: values.db, project: values.project });
	// tmux window: use provided value, or derive from TMUX_PANE env
	const tmuxWindow = values.window ?? process.env.TMUX_PANE ?? "unknown";

	const db = new CommDB(dbPath);
	try {
		db.registerSession(
			execId,
			tmuxWindow,
			projectName,
			values.issue,
			values.lead,
		);
		console.log(`Session registered: ${execId}`);
	} finally {
		db.close();
	}
}

function runCapture(args: string[]): void {
	const { values } = parseArgs({
		args,
		options: {
			"exec-id": { type: "string" },
			lines: { type: "string" },
			db: { type: "string" },
			project: { type: "string" },
		},
		allowPositionals: false,
	});

	if (!values["exec-id"]) {
		throw new Error("--exec-id is required");
	}

	const dbPath = resolveDbPath({ db: values.db, project: values.project });
	const output = capture({
		execId: values["exec-id"],
		dbPath,
		lines: values.lines ? Number.parseInt(values.lines, 10) : undefined,
	});
	process.stdout.write(output);
}

async function runSearch(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			"exec-id": { type: "string" },
			pattern: { type: "string" },
			lines: { type: "string" },
			db: { type: "string" },
			project: { type: "string" },
			json: { type: "boolean", default: false },
		},
		allowPositionals: false,
	});

	if (!values["exec-id"]) {
		throw new Error("--exec-id is required");
	}
	if (!values.pattern) {
		throw new Error("--pattern is required");
	}

	const dbPath = resolveDbPath({ db: values.db, project: values.project });
	const result = await search({
		execId: values["exec-id"],
		pattern: values.pattern,
		dbPath,
		lines: values.lines ? Number.parseInt(values.lines, 10) : undefined,
	});

	if (values.json) {
		console.log(JSON.stringify(result));
	} else if (result.matches.length === 0) {
		console.log(
			`No matches for "${result.pattern}" in ${result.total_lines} lines.`,
		);
	} else {
		for (const m of result.matches) {
			console.log(`${m.line}: ${m.text}`);
		}
	}
}

function runVerifyApproval(args: string[]): void {
	const { values } = parseArgs({
		args,
		options: {
			"exec-id": { type: "string" },
			"pr-head": { type: "string" },
			db: { type: "string" },
			project: { type: "string" },
			"state-db": { type: "string" },
			json: { type: "boolean", default: false },
		},
		allowPositionals: false,
	});

	if (!values["exec-id"]) {
		throw new Error("--exec-id is required");
	}
	if (!values["pr-head"]) {
		throw new Error(
			"--pr-head is required (full sha: --pr-head $(git rev-parse HEAD))",
		);
	}

	const dbPath = resolveDbPath({ db: values.db, project: values.project });
	const result = verifyApproval({
		execId: values["exec-id"],
		prHead: values["pr-head"],
		dbPath,
		stateDbPath: values["state-db"],
	});

	// Always emit structured JSON — the runner's ship decision branches on it
	// (plus the exit code for bash chaining: 0 approved, 1 not approved).
	console.log(
		JSON.stringify({
			approved: result.approved,
			reason: result.reason,
			questionId: result.questionId,
			responseFrom: result.responseFrom,
			status: result.status,
			expectedPrHeadSha: result.expectedPrHeadSha,
		}),
	);
	process.exit(result.exitCode);
}

async function runComplete(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			route: { type: "string" },
			pr: { type: "string" },
			merged: { type: "boolean", default: false },
			"session-role": { type: "string" },
			summary: { type: "string" },
			"exit-reason": { type: "string" },
			"base-ref": { type: "string" },
			// FLY-191 Phase 2: bind the review request to the exact gate
			// question from `gate --no-block` (route=needs_review).
			"question-id": { type: "string" },
		},
		allowPositionals: false,
	});

	await complete({
		route: values.route ?? "",
		pr: values.pr ? Number.parseInt(values.pr, 10) : undefined,
		merged: values.merged ?? false,
		sessionRole: values["session-role"],
		summary: values.summary,
		exitReason: values["exit-reason"],
		baseRef: values["base-ref"],
		questionId: values["question-id"],
	});
}

async function runAwaitCodexGate(args: string[]): Promise<void> {
	const reviewType = args[0];
	const rest = args.slice(1);
	const { values } = parseArgs({
		args: rest,
		options: {
			"exec-id": { type: "string" },
			"worktree-path": { type: "string" },
			timeout: { type: "string" },
			"poll-interval": { type: "string" },
		},
		allowPositionals: false,
	});

	if (!reviewType) {
		console.error(
			"Usage: flywheel-comm await-codex-gate <design|code> --exec-id <id> [--worktree-path <path>]",
		);
		process.exit(1);
	}
	const execId = values["exec-id"] ?? process.env.FLYWHEEL_EXEC_ID;
	if (!execId) {
		console.error("--exec-id is required (or set FLYWHEEL_EXEC_ID)");
		process.exit(1);
	}

	await awaitCodexGate({
		reviewType,
		execId,
		worktreePath: values["worktree-path"],
		timeoutMs: values.timeout ? Number.parseInt(values.timeout, 10) : undefined,
		pollIntervalMs: values["poll-interval"]
			? Number.parseInt(values["poll-interval"], 10)
			: undefined,
	});
}

async function runStage(args: string[]): Promise<void> {
	const subcommand = args[0];
	const stageName = args[1];
	const flagArgs = args.slice(2);

	const { values } = parseArgs({
		args: flagArgs,
		options: {
			plan: { type: "string" },
		},
		allowPositionals: false,
	});

	if (!subcommand) {
		console.error(
			"Usage: flywheel-comm stage set <stage> [--plan <relative-path>]",
		);
		process.exit(1);
	}

	await stage({
		subcommand,
		stageName: stageName ?? "",
		planPath: values.plan,
	});
}

async function runSetArtifact(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			"model-path": { type: "string" },
			"exec-id": { type: "string" },
			"issue-id": { type: "string" },
			"project-name": { type: "string" },
			"bridge-url": { type: "string" },
		},
		allowPositionals: false,
	});

	if (!values["model-path"]) {
		console.error("set-artifact: --model-path required");
		process.exit(1);
	}

	const setArgs: SetArtifactArgs = {
		modelPath: values["model-path"],
		execId: values["exec-id"],
		issueId: values["issue-id"],
		projectName: values["project-name"],
		bridgeUrl: values["bridge-url"],
	};

	try {
		const result = await setArtifact(setArgs);
		process.exit(result.exitCode);
	} catch (err) {
		console.error(
			`set-artifact: ${err instanceof Error ? err.message : String(err)}`,
		);
		process.exit(1);
	}
}

async function runNotify(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			kind: { type: "string", default: "artifact" },
			path: { type: "string", multiple: true },
			"paths-from": { type: "string" },
			"exec-id": { type: "string" },
			"issue-id": { type: "string" },
			"project-name": { type: "string" },
			"dedup-key": { type: "string" },
			attempt: { type: "string" },
			"bridge-url": { type: "string" },
			db: { type: "string" },
			project: { type: "string" },
		},
		allowPositionals: false,
	});

	const kind = (values.kind ?? "artifact") as "artifact" | "status";
	if (kind !== "artifact" && kind !== "status") {
		console.error(`notify: --kind must be "artifact" or "status"`);
		process.exit(1);
	}

	const dbPath = resolveDbPath({ db: values.db, project: values.project });
	const notifyArgs: NotifyArgs = {
		kind,
		paths: values.path,
		pathsFrom: values["paths-from"],
		execId: values["exec-id"],
		issueId: values["issue-id"],
		projectName: values["project-name"],
		dedupKey: values["dedup-key"],
		attempt: values.attempt,
		bridgeUrl: values["bridge-url"],
		dbPath,
	};

	try {
		const result = await notify(notifyArgs);
		console.log(
			`notify: posted=${result.posted} audit=${result.auditWritten} paths=${result.resolvedPaths.length}`,
		);
		process.exit(result.exitCode);
	} catch (err) {
		console.error(
			`notify: ${err instanceof Error ? err.message : String(err)}`,
		);
		process.exit(1);
	}
}

async function runPublishReport(args: string[]): Promise<void> {
	// stdout contract (FLY-203, code review R1#3): EVERY exit path of this
	// wrapper — including flag/parse errors — prints exactly one compact
	// JSON envelope to stdout. Diagnostics go to stderr.
	const failEnvelope = (error: string): never => {
		console.error(`publish-report: ${error}`);
		console.log(
			JSON.stringify({
				url: null,
				reportId: null,
				messageId: null,
				screenshot: null,
				delivered: false,
				error,
			}),
		);
		process.exit(1);
	};

	let values: {
		html?: string;
		project?: string;
		title?: string;
		channel?: string;
		"no-screenshot"?: boolean;
	};
	try {
		values = parseArgs({
			args,
			options: {
				html: { type: "string" },
				project: { type: "string" },
				title: { type: "string" },
				channel: { type: "string" },
				"no-screenshot": { type: "boolean", default: false },
			},
			allowPositionals: false,
		}).values;
	} catch (err) {
		return failEnvelope(`invalid arguments: ${(err as Error).message}`);
	}

	if (!values.html) {
		return failEnvelope("--html <file> is required");
	}
	if (!values.project) {
		return failEnvelope("--project <name> is required");
	}

	const reportArgs: PublishReportArgs = {
		htmlPath: values.html,
		project: values.project,
		title: values.title,
		channelId: values.channel,
		noScreenshot: values["no-screenshot"],
	};

	const { envelope, exitCode } = await publishReport(reportArgs);
	console.log(JSON.stringify(envelope));
	process.exit(exitCode);
}

async function runVisualCapture(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			kind: { type: "string" },
			description: { type: "string" },
			output: { type: "string" },
			"dedup-key": { type: "string" },
			attempt: { type: "string" },
			"exec-id": { type: "string" },
			"issue-id": { type: "string" },
			"project-name": { type: "string" },
			stage: { type: "string" },
			"dev-command": { type: "string" },
			"model-path": { type: "string" },
			"model-viewer-url": { type: "string" },
			angles: { type: "string" }, // comma-separated
			"vision-token-budget": { type: "string" },
			"png-limit": { type: "string" },
			"preferred-port": { type: "string" },
			notify: { type: "boolean", default: false },
			// FLY-188: forward an agent-browser persistent profile (login state,
			// "Recipe B") + optional live-stream port to ProofShot's browser.
			"agent-browser-profile": { type: "string" },
			"agent-browser-stream-port": { type: "string" },
		},
		allowPositionals: false,
	});

	const kind = (values.kind ?? "ui") as "ui" | "3d";
	if (kind !== "ui" && kind !== "3d") {
		console.error(`visual-capture: --kind must be "ui" or "3d"`);
		process.exit(1);
	}

	// Identity may come from CLI flags OR FLYWHEEL_* env (matches stage / complete).
	const execId = values["exec-id"] ?? process.env.FLYWHEEL_EXEC_ID ?? "";
	const issueId = values["issue-id"] ?? process.env.FLYWHEEL_ISSUE_ID ?? "";
	const projectName =
		values["project-name"] ?? process.env.FLYWHEEL_PROJECT_NAME ?? "";

	const attempt = Number.parseInt(values.attempt ?? "1", 10);
	if (!Number.isInteger(attempt) || attempt < 1) {
		console.error(
			`visual-capture: --attempt must be a positive integer (got: ${values.attempt})`,
		);
		process.exit(1);
	}

	// FLY-188: agent-browser profile (CLI flag OR AGENT_BROWSER_PROFILE env).
	const agentBrowserProfile =
		values["agent-browser-profile"] ?? process.env.AGENT_BROWSER_PROFILE;

	// FLY-188: optional live-stream port (deferred feature, env hook only).
	let agentBrowserStreamPort: number | undefined;
	if (values["agent-browser-stream-port"] != null) {
		const raw = values["agent-browser-stream-port"];
		// Require the whole token to be digits — Number.parseInt would silently
		// accept "9223abc" / "9223.5" and forward a truncated 9223.
		const port = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			console.error(
				`visual-capture: --agent-browser-stream-port must be an integer 1-65535 (got: ${raw})`,
			);
			process.exit(1);
		}
		agentBrowserStreamPort = port;
	}

	const captureArgs: VisualCaptureArgs = {
		kind,
		description: values.description ?? "",
		output: values.output ?? "",
		dedupKey: values["dedup-key"] ?? "",
		attempt,
		execId,
		issueId,
		projectName,
		stage: values.stage ?? "",
		devCommand: values["dev-command"],
		modelPath: values["model-path"],
		modelViewerUrl: values["model-viewer-url"],
		angles: values.angles
			? values.angles.split(",").filter(Boolean)
			: undefined,
		visionTokenBudget: values["vision-token-budget"]
			? Number.parseInt(values["vision-token-budget"], 10)
			: undefined,
		pngLimit: values["png-limit"]
			? Number.parseInt(values["png-limit"], 10)
			: undefined,
		preferredPort: values["preferred-port"]
			? Number.parseInt(values["preferred-port"], 10)
			: undefined,
		notify: values.notify,
		agentBrowserProfile,
		agentBrowserStreamPort,
	};

	try {
		const result = await visualCapture(captureArgs);
		const stdoutJson = visualCaptureStdout(result, {
			dedupKey: captureArgs.dedupKey,
			attempt: captureArgs.attempt,
		});
		console.log(JSON.stringify(stdoutJson, null, 2));
	} catch (err) {
		console.error(
			`visual-capture failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		process.exit(1);
	}
}

function runCleanup(args: string[]): void {
	const { values } = parseArgs({
		args,
		options: {
			ttl: { type: "string" },
			db: { type: "string" },
			project: { type: "string" },
			json: { type: "boolean", default: false },
		},
		allowPositionals: false,
	});

	const dbPath = resolveDbPath({ db: values.db, project: values.project });
	const ttlHours = values.ttl ? Number.parseInt(values.ttl, 10) : undefined;
	const result = cleanupMessages({ dbPath, ttlHours });

	if (values.json) {
		console.log(JSON.stringify(result));
	} else {
		console.log(`Cleaned: ${result.cleaned}`);
	}
}

async function runGate(args: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		options: {
			lead: { type: "string" },
			"exec-id": { type: "string" },
			timeout: { type: "string" },
			"timeout-behavior": { type: "string" },
			"cleanup-ttl": { type: "string" },
			stage: { type: "string" },
			db: { type: "string" },
			project: { type: "string" },
			json: { type: "boolean", default: false },
			// FLY-191 Phase 2: park the question and return immediately (runner
			// goes idle instead of freezing in the poll loop). Output is always
			// structured JSON in this mode so the runner can log the questionId.
			"no-block": { type: "boolean", default: false },
		},
		allowPositionals: true,
	});

	const checkpoint = positionals[0];
	if (!checkpoint) {
		throw new Error("Checkpoint name is required (e.g., brainstorm, question)");
	}
	if (!values.lead) {
		throw new Error("--lead is required");
	}
	if (!values["exec-id"]) {
		throw new Error("--exec-id is required");
	}

	const message = positionals.slice(1).join(" ");
	if (!message) {
		throw new Error("Message text is required");
	}

	const dbPath = resolveDbPath({ db: values.db, project: values.project });
	const timeoutMs = values.timeout
		? Number.parseInt(values.timeout, 10)
		: DEFAULT_GATE_TIMEOUT_MS; // FLY-159: default 48h (was 1h)

	// Default timeout behavior: fail-close (FLY-159, was fail-open). Project
	// YAML / explicit --timeout-behavior flag can opt back into fail-open for
	// genuinely advisory gates.
	//
	// FLY-159 Codex r1 R1 MEDIUM: validate the flag value at parse time.
	// Without this, a CLI typo ("fail-clos") was silently cast through the
	// union type and fell into the fail-open timeout branch in gate.ts —
	// downgrading the safer default and skipping the gate_timed_out event.
	// (ConfigLoader already validates the YAML side; this closes the CLI gap.)
	const explicitBehaviorFlag = values["timeout-behavior"] != null;
	let timeoutBehavior: "fail-open" | "fail-close";
	if (explicitBehaviorFlag) {
		const raw = values["timeout-behavior"];
		if (raw !== "fail-open" && raw !== "fail-close") {
			throw new Error(
				`--timeout-behavior must be "fail-open" or "fail-close" (got "${raw}")`,
			);
		}
		timeoutBehavior = raw;
	} else {
		timeoutBehavior = DEFAULT_TIMEOUT_BEHAVIOR;
	}
	// FLY-159 (Codex R2 Issue 3): two-value source enum. The CLI cannot
	// distinguish a Blueprint-injected flag from a hand-typed flag, so
	// "flag" covers both.
	const timeoutBehaviorSource: "default" | "flag" = explicitBehaviorFlag
		? "flag"
		: "default";

	const cleanupTtlHours = values["cleanup-ttl"]
		? Number.parseInt(values["cleanup-ttl"], 10)
		: 24;

	const result = await gate({
		checkpoint,
		lead: values.lead,
		execId: values["exec-id"],
		message,
		dbPath,
		timeoutMs,
		timeoutBehavior,
		timeoutBehaviorSource,
		cleanupTtlHours,
		stage: values.stage,
		noBlock: values["no-block"],
	});

	if (values["no-block"]) {
		// FLY-191 Phase 2: always structured JSON so the runner can correlate
		// the eventual approval (questionId) and Blueprint can assert on shape.
		console.log(
			JSON.stringify({
				status: result.status,
				questionId: result.questionId,
				checkpoint,
			}),
		);
	} else if (values.json) {
		console.log(JSON.stringify(result));
	} else if (result.status === "answered") {
		console.log(result.content ?? "");
	} else {
		console.error(`Gate timeout (${checkpoint}): ${timeoutBehavior}`);
	}
	process.exit(result.exitCode);
}

main().catch((err) => {
	const message = err instanceof Error ? err.message : String(err);
	console.error(`Error: ${message}`);
	process.exit(1);
});
