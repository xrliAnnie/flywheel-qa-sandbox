#!/usr/bin/env node

import { parseArgs } from "node:util";
import { ask } from "./commands/ask.js";
import { capture } from "./commands/capture.js";
import { check } from "./commands/check.js";
import { cleanupMessages } from "./commands/cleanup-messages.js";
import { complete } from "./commands/complete.js";
import { gate } from "./commands/gate.js";
import { inbox } from "./commands/inbox.js";
import { pending } from "./commands/pending.js";
import { respond } from "./commands/respond.js";
import { search } from "./commands/search.js";
import { send } from "./commands/send.js";
import { sessions } from "./commands/sessions.js";
import { stage } from "./commands/stage.js";
import { CommDB } from "./db.js";
import { resolveDbPath } from "./resolve-db-path.js";

function printUsage(): void {
	console.log(`Usage: flywheel-comm <command> [options]

Commands:
  ask       Ask your Lead a question
  check     Check if a question has been answered
  gate      Block at a checkpoint until Lead responds (ask+poll+resolve)
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
  cleanup   Delete read messages older than TTL (default 24h)

Global options:
  --db <path>       Explicit DB path
  --project <name>  Project name (resolves to ~/.flywheel/comm/<name>/comm.db)
  --json            Output as JSON

Environment:
  FLYWHEEL_COMM_DB  DB path (overridden by --db)`);
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
			runRespond(commandArgs);
			break;
		case "send":
			runSend(commandArgs);
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
		case "cleanup":
			runCleanup(commandArgs);
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

function runRespond(args: string[]): void {
	const { values, positionals } = parseArgs({
		args,
		options: {
			lead: { type: "string" },
			db: { type: "string" },
			project: { type: "string" },
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
	respond({ questionId, fromAgent: values.lead, answer, dbPath });

	if (values.json) {
		console.log(JSON.stringify({ status: "ok", question_id: questionId }));
	} else {
		console.log(`Responded to ${questionId}`);
	}
}

function runSend(args: string[]): void {
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
	const instructionId = send({
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
	});
}

async function runStage(args: string[]): Promise<void> {
	const subcommand = args[0];
	const stageName = args[1];

	if (!subcommand) {
		console.error("Usage: flywheel-comm stage set <stage>");
		process.exit(1);
	}

	await stage({ subcommand, stageName: stageName ?? "" });
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
		: 3600_000; // default 1 hour

	// Default timeout behavior: fail-open (matches CheckpointConfig type definition).
	// Individual checkpoints override via --timeout-behavior flag.
	let timeoutBehavior: "fail-open" | "fail-close" = "fail-open";
	if (values["timeout-behavior"]) {
		timeoutBehavior = values["timeout-behavior"] as "fail-open" | "fail-close";
	}

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
		cleanupTtlHours,
		stage: values.stage,
	});

	if (values.json) {
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
