#!/usr/bin/env node

import { parseArgs } from "node:util";
import { ask } from "./commands/ask.js";
import { capture } from "./commands/capture.js";
import { check } from "./commands/check.js";
import { inbox } from "./commands/inbox.js";
import { leadInbox } from "./commands/lead-inbox.js";
import { pending } from "./commands/pending.js";
import { progress } from "./commands/progress.js";
import { respond } from "./commands/respond.js";
import { send } from "./commands/send.js";
import { sessions } from "./commands/sessions.js";
import { resolveDbPath } from "./resolve-db-path.js";

function printUsage(): void {
	console.log(`Usage: flywheel-comm <command> [options]

Commands:
  ask       Ask your Lead a question
  check     Check if a question has been answered
  pending   List unanswered questions for a lead
  respond   Respond to a runner's question
  send      Send an instruction to a runner (Lead use)
  inbox     Check for instructions from Lead (Runner use)
  progress  Report pipeline progress (Runner use)
  lead-inbox  Check for progress updates (Lead use)
  sessions  List runner sessions
  capture   Capture tmux output of a runner session

Global options:
  --db <path>       Explicit DB path
  --project <name>  Project name (resolves to ~/.flywheel/comm/<name>/comm.db)
  --json            Output as JSON

Environment:
  FLYWHEEL_COMM_DB  DB path (overridden by --db)`);
}

function main(): void {
	const args = process.argv.slice(2);
	const command = args[0];

	if (!command || command === "--help" || command === "-h") {
		printUsage();
		process.exit(0);
	}

	// Parse global options from remaining args
	const commandArgs = args.slice(1);

	try {
		switch (command) {
			case "ask":
				runAsk(commandArgs);
				break;
			case "check":
				runCheck(commandArgs);
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
			case "progress":
				runProgress(commandArgs);
				break;
			case "lead-inbox":
				runLeadInbox(commandArgs);
				break;
			case "sessions":
				runSessions(commandArgs);
				break;
			case "capture":
				runCapture(commandArgs);
				break;
			default:
				console.error(`Unknown command: ${command}`);
				printUsage();
				process.exit(1);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`Error: ${message}`);
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

function runProgress(args: string[]): void {
	const { values } = parseArgs({
		args,
		options: {
			"exec-id": { type: "string" },
			stage: { type: "string" },
			status: { type: "string" },
			artifact: { type: "string" },
			db: { type: "string" },
			project: { type: "string" },
			json: { type: "boolean", default: false },
		},
		allowPositionals: false,
	});

	if (!values["exec-id"]) {
		throw new Error("--exec-id is required");
	}
	if (!values.stage) {
		throw new Error("--stage is required");
	}
	if (!values.status) {
		throw new Error("--status is required");
	}

	const dbPath = resolveDbPath({ db: values.db, project: values.project });
	const messageId = progress({
		execId: values["exec-id"],
		stage: values.stage,
		status: values.status,
		dbPath,
		artifact: values.artifact,
	});

	if (values.json) {
		console.log(
			JSON.stringify({ message_id: messageId, skipped: messageId === null }),
		);
	} else if (messageId) {
		console.log(messageId);
	} else {
		console.log("Skipped (no session or lead found).");
	}
}

function runLeadInbox(args: string[]): void {
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
	const result = leadInbox({ leadId: values.lead, dbPath });

	if (values.json) {
		console.log(JSON.stringify(result.messages));
	} else if (result.messages.length === 0) {
		console.log("No progress updates.");
	} else {
		for (const msg of result.messages) {
			console.log(`[${msg.id}] from ${msg.from_agent}: ${msg.content}`);
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
			json: { type: "boolean", default: false },
		},
		allowPositionals: false,
	});

	const dbPath = resolveDbPath({ db: values.db, project: values.project });
	const result = sessions({
		dbPath,
		projectName: values.project,
		activeOnly: values.active,
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

main();
