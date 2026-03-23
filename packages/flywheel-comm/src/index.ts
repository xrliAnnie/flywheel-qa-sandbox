#!/usr/bin/env node

import { parseArgs } from "node:util";
import { ask } from "./commands/ask.js";
import { check } from "./commands/check.js";
import { pending } from "./commands/pending.js";
import { respond } from "./commands/respond.js";
import { resolveDbPath } from "./resolve-db-path.js";

function printUsage(): void {
  console.log(`Usage: flywheel-comm <command> [options]

Commands:
  ask       Ask your Lead a question
  check     Check if a question has been answered
  pending   List unanswered questions for a lead
  respond   Respond to a runner's question

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

  const answer = positionals.slice(1).join(" ");
  if (!answer) {
    throw new Error("Answer text is required");
  }

  const dbPath = resolveDbPath({ db: values.db, project: values.project });
  respond({ questionId, answer, dbPath });

  if (values.json) {
    console.log(JSON.stringify({ status: "ok", question_id: questionId }));
  } else {
    console.log(`Responded to ${questionId}`);
  }
}

main();
