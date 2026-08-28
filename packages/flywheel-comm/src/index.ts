#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
	DEFAULT_GATE_TIMEOUT_MS,
	DEFAULT_TIMEOUT_BEHAVIOR,
} from "flywheel-config";
import {
	type AccountRotationNotifyArgs,
	accountRotationNotify,
} from "./commands/account-rotation-notify.js";
import { ackEvent } from "./commands/ack-event.js";
import { adoptInflight } from "./commands/adopt-inflight.js";
import { ask } from "./commands/ask.js";
import { awaitCodexGate } from "./commands/await-codex-gate.js";
import { capture } from "./commands/capture.js";
import { check } from "./commands/check.js";
import { cleanupMessages } from "./commands/cleanup-messages.js";
import { codexResume } from "./commands/codex-resume.js";
import { emitCodexReviewResult } from "./commands/codex-review-result.js";
import { complete } from "./commands/complete.js";
import {
	type DeclareStateOpts,
	declareState,
	parseDuration,
} from "./commands/declare-state.js";
import { runFeatureFlags } from "./commands/feature-flags.js";
import { founderTime } from "./commands/founder-time.js";
import { gate } from "./commands/gate.js";
import { inbox, renderInboxInstruction } from "./commands/inbox.js";
import { runLeadIdentityCommand } from "./commands/lead-identity.js";
import { runLeadLeaseCommand } from "./commands/lead-lease.js";
import { messageStatus } from "./commands/message-status.js";
import { type NotifyArgs, notify } from "./commands/notify.js";
import { pending } from "./commands/pending.js";
import { progress } from "./commands/progress.js";
import {
	type PublishReportArgs,
	publishReport,
} from "./commands/publish-report.js";
import { qaResult } from "./commands/qa-result.js";
import { reportDeployed } from "./commands/report-deployed.js";
import { requestReview } from "./commands/request-review.js";
import { respond } from "./commands/respond.js";
import { reviewRuling } from "./commands/review-ruling.js";
import { runRunnerConfig } from "./commands/runner-config.js";
import {
	type RunnerStopSource,
	runnerStopped,
	type StopFailureInput,
} from "./commands/runner-stopped.js";
import { runnerWakeSweep } from "./commands/runner-wake-sweep.js";
import { search } from "./commands/search.js";
import { send } from "./commands/send.js";
import { sessions } from "./commands/sessions.js";
import { type SetArtifactArgs, setArtifact } from "./commands/set-artifact.js";
import { stage } from "./commands/stage.js";
import { runTokenReport } from "./commands/token-report.js";
import {
	formatTurnStatus,
	isTurnDebugOverride,
	recordTurnCommandSideEffects,
	turnStatus,
	turnWaitAskAfterMs,
} from "./commands/turn.js";
import { verifyApprovalWithBridgeHead } from "./commands/verify-approval.js";
import { verifyReport } from "./commands/verify-report.js";
import {
	type VisualCaptureArgs,
	visualCapture,
	visualCaptureStdout,
} from "./commands/visual-capture.js";
import { currentWorkflowCompletionActivationFromEnv } from "./commands/workflow-activation.js";
import { workflowOutput } from "./commands/workflow-output.js";
import { xhsAnalysis } from "./commands/xhs-analysis.js";
import { xhsState } from "./commands/xhs-state.js";
import { xhsValidateFinal } from "./commands/xhs-validate-final.js";
import { CommDB } from "./db.js";
import { ingestDiscordChat } from "./discord-chat-ingest.js";
import { resolveFounderId } from "./founder-attribution.js";
import { inspectCommittedFounderReviewArtifacts } from "./founder-review.js";
import { nudgeLeadInboxBestEffort } from "./lead-inbox-nudge.js";
import { resolveDbPath } from "./resolve-db-path.js";

function printUsage(): void {
	console.log(`Usage: flywheel-comm <command> [options]

Commands:
  ask       Ask your Lead a question (non-blocking; Lead notified ≤1 poll tick via Bridge)
            With --report (FLY-1041): mark it a fire-and-forget status report
            ("DONE: …") — the Lead still gets it, but founder thread replies
            can never bind to it.
  check     Check if a question has been answered
  ack-event Write a backend-neutral Lead-event ACK receipt. The bearer token
            MUST arrive on stdin: ack-event <seq> --project <name> --token-stdin
  gate      Block at a checkpoint until Lead responds (ask+poll+resolve).
            With --no-block (FLY-191): park the question + return questionId
            JSON immediately; runner goes idle and is woken by mailbox.
  verify-approval  MANDATORY pre-ship authority check (FLY-191): re-verify the
            approve_to_ship gate response + StateStore approved_to_ship +
            pr_head_sha against --pr-head $(git rev-parse HEAD). Fail-closed;
            exit 0 only when approved. The wake message itself is NEVER authority.
  pending   List unanswered questions for a lead
  respond   Respond to a runner's question
  chat-ingest   Enqueue one Discord inbound into the unified mailbox
  send      Send an instruction to a runner (Lead use)
  lead-identity  Resolve one immutable Lead identity from an explicit registry selector
  lead-lease  Manage the Lead identity lease (acquire|bind|verify-bound|progress-snapshot|status|set-mode|resolve|carrier-self-check|readiness)
  inbox     Check for instructions from Lead (Runner use)
  message-status  Read one mailbox message's live/archive delivery evidence by exact id
  adopt-inflight  Requeue this recipient identity's in-flight inbox batches (Lead birth use)
  sessions           List runner sessions
  sessions register  Register a runner session in CommDB
  capture   Capture tmux output of a runner session
  search    Search tmux output for a regex pattern
  stage     Report pipeline stage to Bridge (Runner use)
  turn      FLY-887: DAG workflow runner's shared-worktree TURN self-check.
            Prints yours|not-yours|no-turn (exit 0). Touch the worktree ONLY on
            a 'yours' answer; the wake message text is never authority.
            --exec-id <id> (defaults to FLYWHEEL_EXEC_ID).
  complete  Emit session_completed terminal event to Bridge (Runner use)
  runner-stopped  Emit a reasoned Runner turn-end report to its Lead (hook use)
  runner-wake-sweep  Ring a durable Codex phase-hold doorbell when unread
            Runner traffic exists (turn-ended hook use; never ACKs mailbox rows)
  await-codex-gate  Block until Bridge-written Codex review JSON or skip marker appears (Runner use)
  qa-result  Emit a QA verdict (pass|fail) that gates the founder ship notification (QA Runner use)
  workflow-output  Submit a generalized node's JSON output before completion
  request-review  Register a codex-author review request bound to an open review gate (FLY-1188; --type design|code --question-id <id> [--plan <path>] [--target-repo <rel>])
  review-ruling  Record or revoke a supervised Lead ruling for a delivered review finding (FLY-1278)
  codex-review-result  Emit a Codex code-review APPROVED verdict for an explicit execution/head (FLY-827; requires --exec-id and --pr-head)
  cleanup   Archive terminal mailbox families (72h minimum)
  visual-capture   Run ProofShot UI/3D capture, select artifacts, write manifest (GEO-151)
  notify    POST artifact_emitted event to Bridge after capture+Read (GEO-151)
  publish-report   Publish HTML report to hosting + deliver to Discord as
            screenshot preview + unguessable link (FLY-203). Flags:
            --html <file> --project <name> [--title <t>]
            [--channel <id> | --issue <FLY-123>]
            [--no-screenshot] [--kind token_report --expected-date YYYY-MM-DD].
            Env: FLYWHEEL_BRIDGE_URL, TEAMLEAD_API_TOKEN. Always prints a one-line
            JSON envelope to stdout.
  verify-report   Verify a hosted HTML report. Default is browser-free HTTP/CSP
            validation; screenshot is opt-in and process-group bounded. Flags:
            --url <http(s)://url> [--expect <substring>]
            [--screenshot <absolute.png>] [--shot-window <WxH>]
            [--timeout-ms <n>] [--shot-timeout-ms <n>]
            [--chrome-bin <absolute executable>]. Always prints a one-line JSON
            envelope to stdout.
	  feature-flags   Feature-flag console helpers (FLY-709). Subcommands:
	            report [--project <name>] [--channel <id>] [--out <file>]
            [--bridge-url <url>]  — fetch the read-only flag report from the
            Bridge loopback endpoint and deliver via publish-report (hosted URL
            + Discord).
	            set --name <flag> --to on|off|<enum> [--project <scope; default *>]
	            [--reason <reason>] [--bridge-url <url>]
	            clear --name <flag> --project <scope> --reason <reason>
	            [--bridge-url <url>]  — copy/paste stage→apply commands. set/clear
	            --project selects flag scope; report --project selects publishing.
	            apply remains a set alias. clear is limited to SQLite-managed flags.
  founder-time   Print Annie's current local time and timezone. Uses the host
            device timezone by default; --json emits {iso,tz,abbrev,offsetMinutes}.
  runner-config   Per-project runner defaults + cron model (FLY-709). Subcommand:
            apply --project <name> [--cron <collection_id>] [--model <id|default>]
            [--effort <level|default>] [--backend <executor|default>] --yes
            — writes <projectRoot>/.flywheel/config.yaml (roles.runner.* or
            collections[].model); hot-effective for NEW runs, no restart.
  set-artifact   Register build output (.glb/.stl/.3mf) path for 3D capture (GEO-151)
  account-rotation-notify  FLY-696: surface a Codex per-runner account rotation
            in the unified Alerts channel. Emits a dedicated account_rotation
            event to the Bridge /events (NOT artifact_emitted). Flags:
            --provider <codex> --to <account> --reason <r> [--from <account>]
            [--reset-at <iso>] [--bridge-url <url>] [--exec-id <id>].
            Env: FLYWHEEL_BRIDGE_URL, FLYWHEEL_INGEST_TOKEN. Best-effort —
            called with || true from flywheel-codex-with-fallback.
  token-report   Fine-grained token usage report (FLY-614/FLY-744). Subcommands:
            aggregate [--since --until | --backfill-days N]  scan CC logs → persist
              daily aggregates (rolling window, default 14 days);
            report [--date --trend-since --before A..B --after C..D |
              --rollout-date D --window N] [--out <html> --json]  render;
            daily [--out <html>]  roll up the window → report yesterday, with a
              week-over-week before/after hero (or a --rollout-date anchor).
            Pair with publish-report --html <out> to deliver to a channel.

Global options:
  --db <path>       Explicit DB path
  --project <name>  Project name (resolves to ~/.flywheel/comm/<name>/comm.db)
  --json            Output as JSON

respond options:
	<question-id> <answer> --lead <lead> [--db <path> | --project <name>]
	[--expect-owner <execution-id>]
	[--expect-checkpoint <checkpoint> | --expect-no-checkpoint]
	[--source-thread <discord-thread-id>] [--bridge-url <url>] [--kickback]
  --bridge-url <url>  Route an approve_to_ship gate response through the Bridge
                      founder-consent wrapper (FLY-175). Required for the
                      approve_to_ship checkpoint unless BRIDGE_URL env is set;
                      omitting it for that gate is fail-closed (refuses to write).
  --kickback          Explicitly confirm a non-approval answer as a kickback.
                      Without this flag or a recognized kickback prefix, neutral
                      discussion is relayed but no verdict is written.

Environment:
  FLYWHEEL_COMM_DB           DB path (overridden by --db)
  BRIDGE_URL                 Default Bridge URL for the approve_to_ship gate route
  TEAMLEAD_API_TOKEN         Bearer token for the Bridge gate-response endpoint
`);
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
			await runAsk(commandArgs);
			break;
		case "check":
			runCheck(commandArgs);
			break;
		case "ack-event":
			await runAckEvent(commandArgs);
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
		case "chat-ingest":
			await runChatIngest(commandArgs);
			break;
		case "send":
			await runSend(commandArgs);
			break;
		case "lead-identity":
			process.exitCode = await runLeadIdentityCommand(commandArgs);
			break;
		case "lead-lease":
			process.exitCode = await runLeadLeaseCommand(commandArgs);
			break;
		case "inbox":
			runInbox(commandArgs);
			break;
		case "message-status":
			process.exitCode = messageStatus(commandArgs);
			break;
		case "adopt-inflight":
			process.exitCode = adoptInflight(commandArgs);
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
		case "progress":
			// FLY-795: single-writer, path-limited, atomic progress.md writer.
			process.exit(progress(commandArgs));
			break;
		case "park":
			runDeclareState("park", commandArgs);
			break;
		case "busy":
			runDeclareState("busy", commandArgs);
			break;
		case "unpark":
			runDeclareState("unpark", commandArgs);
			break;
		case "turn":
			runTurn(commandArgs);
			break;
		case "complete":
			await runComplete(commandArgs);
			break;
		case "runner-stopped":
			await runRunnerStopped(commandArgs);
			break;
		case "runner-wake-sweep":
			runRunnerWakeSweep(commandArgs);
			break;
		case "await-codex-gate":
			await runAwaitCodexGate(commandArgs);
			break;
		case "qa-result":
			await runQaResult(commandArgs);
			break;
		case "workflow-output":
			await runWorkflowOutput(commandArgs);
			break;
		case "request-review":
			await runRequestReview(commandArgs);
			break;
		case "review-ruling":
			await runReviewRuling(commandArgs);
			break;
		case "codex-review-result":
			await runCodexReviewResult(commandArgs);
			break;
		case "codex-resume":
			await runCodexResume(commandArgs);
			break;
		case "verify-approval":
			await runVerifyApproval(commandArgs);
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
		case "verify-report":
			await runVerifyReport(commandArgs);
			break;
		case "feature-flags":
			await runFeatureFlags(commandArgs);
			break;
		case "founder-time":
			founderTime(commandArgs);
			break;
		case "runner-config":
			await runRunnerConfig(commandArgs);
			break;
		case "token-report":
			await runTokenReport(commandArgs);
			break;
		case "report-deployed":
			process.exitCode = await reportDeployed(commandArgs);
			break;
		case "notify":
			await runNotify(commandArgs);
			break;
		case "set-artifact":
			await runSetArtifact(commandArgs);
			break;
		case "account-rotation-notify":
			await runAccountRotationNotify(commandArgs);
			break;
		case "xhs-state":
			process.exit(await xhsState(commandArgs));
			break;
		case "xhs-analysis":
			process.exit(await xhsAnalysis(commandArgs));
			break;
		case "xhs-validate-final":
			process.exit(xhsValidateFinal(commandArgs));
			break;
		default:
			console.error(`Unknown command: ${command}`);
			printUsage();
			process.exit(1);
	}
}

function runRunnerWakeSweep(args: string[]): void {
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
	const envExecId = process.env.FLYWHEEL_EXEC_ID;
	const execId = values["exec-id"] ?? envExecId;
	if (!execId) {
		throw new Error("FLYWHEEL_EXEC_ID is required");
	}
	if (values["exec-id"] && values["exec-id"] !== envExecId) {
		console.warn(
			`runner-wake-sweep: debug --exec-id override targets ${values["exec-id"]}`,
		);
	}
	const result = runnerWakeSweep({
		dbPath: resolveDbPath({ db: values.db, project: values.project }),
		execId,
	});
	console.log(values.json ? JSON.stringify(result) : result.kind);
}

async function runAckEvent(args: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		options: {
			db: { type: "string" },
			project: { type: "string" },
			lead: { type: "string" },
			"token-stdin": { type: "boolean", default: false },
			json: { type: "boolean", default: false },
		},
		allowPositionals: true,
	});
	const eventSeq = Number(positionals[0]);
	if (!Number.isSafeInteger(eventSeq) || eventSeq <= 0) {
		throw new Error("A positive event sequence is required");
	}
	if (!values["token-stdin"]) {
		throw new Error(
			"--token-stdin is required; tokens are never accepted in argv",
		);
	}
	const leadId = values.lead ?? process.env.FLYWHEEL_LEAD_ID?.trim();
	if (!leadId) {
		throw new Error(
			"ACK identity is required: pass --lead or set FLYWHEEL_LEAD_ID",
		);
	}
	const dbPath = resolveDbPath({ db: values.db, project: values.project });
	const receiptId = ackEvent({
		dbPath,
		eventSeq,
		ackToken: readFileSync(0, "utf8").trim(),
		leadId,
	});
	await nudgeLeadInboxBestEffort({
		bridgeUrl: process.env.FLYWHEEL_BRIDGE_URL ?? process.env.BRIDGE_URL,
		leadId,
		project: values.project,
		apiToken: process.env.TEAMLEAD_API_TOKEN,
		ingestToken: process.env.FLYWHEEL_INGEST_TOKEN,
	});
	if (values.json)
		console.log(JSON.stringify({ receipt_id: receiptId, event_seq: eventSeq }));
	else console.log(`ACK receipt queued for event ${eventSeq}`);
}

/**
 * FLY-123: zero-interpolation Codex cycle launcher (R2 #2). The ONLY
 * command shape the Codex mailbox watcher may inject into a runner shell.
 */
async function runCodexResume(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			state: { type: "string" },
			message: { type: "string" },
		},
		allowPositionals: false,
	});
	if (!values.state) {
		console.error("codex-resume: --state <absolute path> is required");
		process.exit(2);
	}
	const exitCode = await codexResume({
		statePath: values.state,
		...(values.message !== undefined && { message: values.message }),
	});
	process.exit(exitCode);
}

async function runAsk(args: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		options: {
			lead: { type: "string" },
			"exec-id": { type: "string" },
			db: { type: "string" },
			project: { type: "string" },
			json: { type: "boolean", default: false },
			// FLY-1041: fire-and-forget status report — excluded from the
			// founder-reply binding candidate set (Lead relay unchanged).
			report: { type: "boolean", default: false },
			deadline: { type: "string" },
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
		report: values.report,
		deadlineAt: values.deadline,
	});
	await nudgeLeadInboxBestEffort({
		bridgeUrl: process.env.FLYWHEEL_BRIDGE_URL ?? process.env.BRIDGE_URL,
		leadId: values.lead,
		project: values.project,
		apiToken: process.env.TEAMLEAD_API_TOKEN,
		ingestToken: process.env.FLYWHEEL_INGEST_TOKEN,
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
	const result = check({
		questionId,
		dbPath,
		executionId: process.env.FLYWHEEL_EXEC_ID,
	});

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
			"source-thread": { type: "string" },
			"expect-owner": { type: "string" },
			"expect-checkpoint": { type: "string" },
			"expect-no-checkpoint": { type: "boolean", default: false },
			kickback: { type: "boolean", default: false },
			json: { type: "boolean", default: false },
		},
		allowPositionals: true,
	});

	if (!values.lead) {
		throw new Error("--lead is required (identifies who is responding)");
	}
	if (values["expect-checkpoint"] && values["expect-no-checkpoint"]) {
		throw new Error(
			"--expect-checkpoint and --expect-no-checkpoint are mutually exclusive",
		);
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
		sourceThread: values["source-thread"],
		expectedOwner: values["expect-owner"],
		expectedCheckpoint: values["expect-no-checkpoint"]
			? null
			: values["expect-checkpoint"],
		kickback: values.kickback,
	});

	if (values.json) {
		console.log(JSON.stringify({ status: "ok", question_id: questionId }));
	} else {
		console.log(`Responded to ${questionId}`);
	}
}

async function runChatIngest(args: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		options: {
			"version-probe": { type: "boolean", default: false },
			json: { type: "boolean", default: false },
			lead: { type: "string" },
			"chat-id": { type: "string" },
			"origin-channel-id": { type: "string" },
			"message-id": { type: "string" },
			"author-id": { type: "string" },
			"author-name": { type: "string" },
			"founder-id": { type: "string" },
			ts: { type: "string" },
			"msg-kind": { type: "string" },
			"attachments-json": { type: "string" },
			"reply-channel-id": { type: "string" },
			"reply-route-json": { type: "string" },
			"content-stdin": { type: "boolean", default: false },
			db: { type: "string" },
			project: { type: "string" },
		},
		allowPositionals: true,
	});
	if (positionals.length > 0)
		throw new Error("chat-ingest accepts no positionals");
	if (values["version-probe"]) {
		console.log(
			JSON.stringify({ command: "chat-ingest", protocolVersion: 1, ok: true }),
		);
		return;
	}
	if (!values["content-stdin"]) {
		throw new Error("chat-ingest requires --content-stdin");
	}
	const required = (name: keyof typeof values): string => {
		const value = values[name];
		if (typeof value !== "string" || !value) {
			throw new Error(`--${String(name)} is required`);
		}
		return value;
	};
	let attachments: unknown;
	let replyRoute: unknown;
	try {
		attachments = JSON.parse(values["attachments-json"] ?? "[]");
		replyRoute = values["reply-route-json"]
			? JSON.parse(values["reply-route-json"])
			: undefined;
	} catch (error) {
		throw new Error(
			`chat-ingest JSON option is invalid: ${(error as Error).message}`,
		);
	}
	const result = ingestDiscordChat({
		dbPath: resolveDbPath({ db: values.db, project: values.project }),
		leadId: required("lead"),
		chatId: required("chat-id"),
		originChannelId: required("origin-channel-id"),
		messageId: required("message-id"),
		authorId: required("author-id"),
		authorName: required("author-name"),
		...(values["founder-id"] ? { founderId: values["founder-id"] } : {}),
		ts: required("ts"),
		msgKind: required("msg-kind") as "dm" | "guild" | "roundtable",
		attachments: attachments as Array<{
			name: string;
			type: string;
			sizeKb: number;
		}>,
		text: readFileSync(0, "utf8"),
		...(values["reply-channel-id"]
			? { replyChannelId: values["reply-channel-id"] }
			: {}),
		...(replyRoute
			? {
					replyRoute: replyRoute as {
						kind: "roundtable_thread_from_message";
						parentChannelId: string;
						sourceMessageId: string;
						threadId: string;
						threadName?: string;
					},
				}
			: {}),
	});
	// Commit evidence must precede the best-effort doorbell.
	console.log(JSON.stringify(result));
	if (result.lane === "inserted_inbox") {
		await nudgeLeadInboxBestEffort({
			bridgeUrl: process.env.BRIDGE_URL,
			leadId: required("lead"),
			project: values.project ?? process.env.PROJECT_NAME,
			apiToken: process.env.TEAMLEAD_API_TOKEN,
			ingestToken: process.env.FLYWHEEL_INGEST_TOKEN,
		});
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

	const envExecId = process.env.FLYWHEEL_EXEC_ID;
	const execId = values["exec-id"] ?? envExecId;
	if (!execId) {
		throw new Error(
			"FLYWHEEL_EXEC_ID is required (or pass --exec-id for debug)",
		);
	}
	const debugExecOverride =
		Boolean(values["exec-id"]) && values["exec-id"] !== envExecId;
	if (debugExecOverride) {
		console.error(
			`[flywheel-comm inbox] WARNING: --exec-id override (${values["exec-id"]}) — use only for debug/test.`,
		);
	}

	const dbPath = resolveDbPath({ db: values.db, project: values.project });
	const result = inbox({ execId, dbPath, debugExecOverride });

	if (values.json) {
		console.log(JSON.stringify(result.instructions));
	} else if (result.instructions.length === 0) {
		console.log("No instructions.");
	} else {
		const renderedAtMs = Date.now();
		for (const inst of result.instructions) {
			console.log(renderInboxInstruction(inst, renderedAtMs));
		}
	}
}

/**
 * FLY-626: `park` / `busy` / `unpark` — a runner self-declares its liveness
 * intent so the stall detectors do not waste a Lead wake on it. Writes the
 * marker to CommDB. exec-id defaults to FLYWHEEL_EXEC_ID; an explicit
 * `--exec-id` is a LOUD debug override (Codex R1 #5 — a runner declares only
 * for itself).
 */
function runDeclareState(
	action: "park" | "busy" | "unpark",
	args: string[],
): void {
	const { values } = parseArgs({
		args,
		options: {
			"exec-id": { type: "string" },
			db: { type: "string" },
			project: { type: "string" },
			reason: { type: "string" },
			until: { type: "string" }, // park
			task: { type: "string" }, // busy
			expect: { type: "string" }, // busy
		},
		allowPositionals: false,
	});

	const envExecId = process.env.FLYWHEEL_EXEC_ID;
	let execId = envExecId;
	if (values["exec-id"]) {
		execId = values["exec-id"];
		if (values["exec-id"] !== envExecId) {
			console.error(
				`[flywheel-comm ${action}] WARNING: --exec-id override (${values["exec-id"]}) — a runner should declare only for itself ($FLYWHEEL_EXEC_ID). Use only for debug/test.`,
			);
		}
	}
	if (!execId) {
		console.error(
			`[flywheel-comm ${action}] FLYWHEEL_EXEC_ID is required (or pass --exec-id for debug)`,
		);
		process.exit(1);
	}

	// Parse the duration flag relevant to the action.
	let durationMs: number | null = null;
	const rawDuration =
		action === "busy"
			? values.expect
			: action === "park"
				? values.until
				: undefined;
	if (rawDuration !== undefined) {
		const parsed = parseDuration(rawDuration);
		if (parsed === null) {
			console.error(
				`[flywheel-comm ${action}] invalid duration "${rawDuration}" — use e.g. 30m, 2h, 90s`,
			);
			process.exit(1);
		}
		durationMs = parsed;
	}

	const dbPath = resolveDbPath({
		db: values.db,
		project: values.project ?? process.env.FLYWHEEL_PROJECT_NAME,
	});
	const db = new CommDB(dbPath);
	try {
		const opts: DeclareStateOpts = {
			action,
			execId,
			nowMs: Date.now(),
			reason:
				action === "busy" ? (values.task ?? null) : (values.reason ?? null),
			durationMs,
		};
		const result = declareState(db, opts);
		if (action === "unpark") {
			console.log(`Cleared declared state for ${execId}`);
		} else {
			const until =
				result.expiresAtMs === null
					? "indefinite"
					: new Date(result.expiresAtMs).toISOString();
			console.log(`Declared ${result.kind} for ${execId} (until: ${until})`);
		}
	} finally {
		db.close();
	}
}

/**
 * FLY-887: `turn --exec-id <id>` — a DAG workflow runner's shared-worktree
 * TURN self-check. Prints exactly one of `yours` / `not-yours` / `no-turn` and
 * exits 0; a query/DB failure exits 1. The runner proceeds to touch the worktree
 * ONLY on `yours`. exec-id defaults to FLYWHEEL_EXEC_ID (a runner checks only for
 * itself); an explicit `--exec-id` is a loud debug override.
 */
function runTurn(args: string[]): void {
	const observedAtMs = Date.now();
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

	const envExecId = process.env.FLYWHEEL_EXEC_ID;
	let execId = envExecId;
	if (values["exec-id"]) {
		execId = values["exec-id"];
		if (values["exec-id"] !== envExecId) {
			console.error(
				`[flywheel-comm turn] WARNING: --exec-id override (${values["exec-id"]}) — a runner should self-check only for itself ($FLYWHEEL_EXEC_ID). Use only for debug/test.`,
			);
		}
	}
	if (!execId) {
		console.error(
			"[flywheel-comm turn] FLYWHEEL_EXEC_ID is required (or pass --exec-id for debug)",
		);
		process.exit(1);
	}

	const dbPath = resolveDbPath({
		db: values.db,
		project: values.project ?? process.env.FLYWHEEL_PROJECT_NAME,
	});
	const db = new CommDB(dbPath);
	try {
		const status = turnStatus(db, execId);
		const debugOverride = isTurnDebugOverride(values["exec-id"], envExecId);
		recordTurnCommandSideEffects(db, execId, status, {
			observedAtMs,
			askAfterMs: turnWaitAskAfterMs(process.env),
			debugOverride,
		});
		if (values.json) {
			console.log(JSON.stringify(status));
		} else {
			console.log(formatTurnStatus(status));
		}
	} finally {
		db.close();
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

async function runVerifyApproval(args: string[]): Promise<void> {
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
	const result = await verifyApprovalWithBridgeHead({
		execId: values["exec-id"],
		prHead: values["pr-head"],
		dbPath,
		stateDbPath: values["state-db"],
		bridgeUrl: process.env.FLYWHEEL_BRIDGE_URL ?? "",
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
			ciDetail: result.ciDetail,
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
			"target-repo": { type: "string" },
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
		targetRepo: values["target-repo"],
		questionId: values["question-id"],
	});
}

async function runRunnerStopped(args: string[]): Promise<void> {
	try {
		const { values } = parseArgs({
			args,
			options: {
				source: { type: "string" },
				transcript: { type: "string" },
				"error-json": { type: "string" },
				"last-message": { type: "string" },
				"turn-id": { type: "string" },
				"session-id": { type: "string" },
				"ingress-ts": { type: "string" },
				"prev-ingress": { type: "string" },
				"exec-id": { type: "string" },
				"issue-id": { type: "string" },
				db: { type: "string" },
				project: { type: "string" },
			},
			allowPositionals: false,
		});
		const source = values.source;
		if (
			source !== "claude-stop" &&
			source !== "claude-stop-failure" &&
			source !== "codex-notify"
		) {
			throw new Error(
				"--source must be claude-stop, claude-stop-failure, or codex-notify",
			);
		}
		const execId = values["exec-id"] ?? process.env.FLYWHEEL_EXEC_ID;
		if (!execId) throw new Error("--exec-id or FLYWHEEL_EXEC_ID is required");
		if (!values["ingress-ts"]) throw new Error("--ingress-ts is required");
		let stopFailure: StopFailureInput | undefined;
		if (values["error-json"]) {
			const parsed = JSON.parse(values["error-json"]) as Record<
				string,
				unknown
			>;
			if (typeof parsed.error !== "string") {
				throw new Error("--error-json must contain a string error field");
			}
			stopFailure = {
				error: parsed.error,
				...(typeof parsed.errorDetails === "string" ||
				parsed.errorDetails === null
					? { errorDetails: parsed.errorDetails }
					: {}),
				...(typeof parsed.lastAssistantMessage === "string" ||
				parsed.lastAssistantMessage === null
					? { lastAssistantMessage: parsed.lastAssistantMessage }
					: {}),
			};
		}
		const result = await runnerStopped({
			dbPath: resolveDbPath({ db: values.db, project: values.project }),
			execId,
			envIssueId: values["issue-id"] ?? process.env.FLYWHEEL_ISSUE_ID,
			source: source as RunnerStopSource,
			ingressTs: values["ingress-ts"],
			prevIngress: values["prev-ingress"],
			transcriptPath: values.transcript,
			sessionId: values["session-id"],
			stopFailure,
			lastMessage: values["last-message"],
			turnId: values["turn-id"],
		});
		console.log(result.questionId);
	} catch (error) {
		console.error(
			`runner-stopped: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(2);
	}
}

// FLY-1188 §7.1: register a codex-author review request bound to a gate.
async function runRequestReview(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			"exec-id": { type: "string" },
			type: { type: "string" },
			"question-id": { type: "string" },
			plan: { type: "string" },
			"target-repo": { type: "string" },
			"request-id": { type: "string" },
		},
		allowPositionals: false,
	});

	await requestReview({
		execId: values["exec-id"],
		type: values.type,
		questionId: values["question-id"],
		planPath: values.plan,
		targetRepoPath: values["target-repo"],
		requestId: values["request-id"],
	});
}

// FLY-1278: supervised governance for an already-delivered review finding.
async function runReviewRuling(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			project: { type: "string" },
			issue: { type: "string" },
			finding: { type: "string" },
			"request-id": { type: "string" },
			"finding-index": { type: "string" },
			disposition: { type: "string" },
			"follow-up": { type: "string" },
			reason: { type: "string" },
			lead: { type: "string" },
			revoke: { type: "string" },
			"exec-id": { type: "string" },
		},
		allowPositionals: false,
	});
	const rawIndex = values["finding-index"];
	const findingIndex =
		rawIndex !== undefined && /^\d+$/.test(rawIndex)
			? Number.parseInt(rawIndex, 10)
			: rawIndex === undefined
				? undefined
				: Number.NaN;

	await reviewRuling({
		project: values.project,
		issue: values.issue,
		finding: values.finding,
		requestId: values["request-id"],
		findingIndex,
		disposition: values.disposition,
		followUp: values["follow-up"],
		reason: values.reason,
		lead: values.lead,
		revoke: values.revoke,
		execId: values["exec-id"],
	});
}

async function runQaResult(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			"exec-id": { type: "string" },
			"target-exec": { type: "string" },
			status: { type: "string" },
			summary: { type: "string" },
			"pr-head": { type: "string" },
		},
		allowPositionals: false,
	});

	await qaResult({
		status: values.status ?? "",
		targetExec: values["target-exec"] ?? "",
		summary: values.summary,
		execId: values["exec-id"],
		prHeadSha: values["pr-head"],
	});
}

async function runWorkflowOutput(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			"payload-file": { type: "string" },
			"request-id": { type: "string" },
		},
		allowPositionals: false,
	});
	await workflowOutput({
		payloadFile: values["payload-file"] ?? "",
		requestId: values["request-id"],
	});
}

async function runCodexReviewResult(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			"exec-id": { type: "string" },
			"pr-head": { type: "string" },
			"reviewed-target": { type: "string" },
			rounds: { type: "string" },
			"codex-thread-id": { type: "string" },
		},
		allowPositionals: false,
	});
	const execId = values["exec-id"]?.trim();
	const prHeadSha = values["pr-head"]?.trim().toLowerCase();
	if (!execId || !prHeadSha || !/^[0-9a-f]{40}$/.test(prHeadSha)) {
		console.error(
			"Usage: flywheel-comm codex-review-result --exec-id <id> --pr-head <40-hex-sha> [--reviewed-target <target>] [--rounds <n>] [--codex-thread-id <id>]",
		);
		process.exit(1);
		return;
	}
	const rounds = values.rounds ? Number.parseInt(values.rounds, 10) : undefined;
	const ok = await emitCodexReviewResult({
		execId,
		prHeadSha,
		reviewedTarget: values["reviewed-target"],
		rounds: Number.isFinite(rounds) ? rounds : undefined,
		codexThreadId: values["codex-thread-id"],
	});
	process.exit(ok ? 0 : 1);
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

/**
 * FLY-696 M1/④ — make a Codex per-runner account rotation visible in Alerts.
 * Called (best-effort, `|| true`) by `flywheel-codex-with-fallback` after each
 * `flywheel-codex-profile next`. Emits a dedicated `account_rotation` event to
 * the Bridge /events; the Bridge routes it to the unified Alerts channel.
 */
async function runAccountRotationNotify(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			provider: { type: "string" },
			from: { type: "string" },
			to: { type: "string" },
			reason: { type: "string" },
			"reset-at": { type: "string" },
			"bridge-url": { type: "string" },
			"exec-id": { type: "string" },
		},
		allowPositionals: false,
	});

	if (!values.provider || !values.to || !values.reason) {
		console.error(
			"account-rotation-notify: --provider, --to and --reason are required",
		);
		process.exit(2);
	}

	const notifyArgs: AccountRotationNotifyArgs = {
		provider: values.provider,
		to: values.to,
		reason: values.reason,
		...(values.from !== undefined && { from: values.from }),
		...(values["reset-at"] !== undefined && { resetAt: values["reset-at"] }),
		...(values["bridge-url"] !== undefined && {
			bridgeUrl: values["bridge-url"],
		}),
		...(values["exec-id"] !== undefined && { execId: values["exec-id"] }),
	};

	try {
		const result = await accountRotationNotify(notifyArgs);
		process.exit(result.exitCode);
	} catch (err) {
		console.error(
			`account-rotation-notify: ${err instanceof Error ? err.message : String(err)}`,
		);
		process.exit(2);
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
		issue?: string;
		"no-screenshot"?: boolean;
		"publish-only"?: boolean;
		kind?: string;
		"expected-date"?: string;
	};
	try {
		values = parseArgs({
			args,
			options: {
				html: { type: "string" },
				project: { type: "string" },
				title: { type: "string" },
				channel: { type: "string" },
				issue: { type: "string" },
				"no-screenshot": { type: "boolean", default: false },
				"publish-only": { type: "boolean", default: false },
				// FLY-929 B1: delivery-receipt seam (see PublishReportArgs).
				kind: { type: "string" },
				"expected-date": { type: "string" },
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
	if (values.channel !== undefined && values.issue !== undefined) {
		return failEnvelope("--channel and --issue are mutually exclusive");
	}

	const reportArgs: PublishReportArgs = {
		htmlPath: values.html,
		project: values.project,
		title: values.title,
		channelId: values.channel,
		issueIdentifier: values.issue,
		noScreenshot: values["no-screenshot"],
		publishOnly: values["publish-only"],
		kind: values.kind,
		expectedDate: values["expected-date"],
	};

	const { envelope, exitCode } = await publishReport(reportArgs);
	console.log(JSON.stringify(envelope));
	process.exit(exitCode);
}

async function runVerifyReport(args: string[]): Promise<void> {
	let rawUrl = "";
	const failEnvelope = (error: string): never => {
		console.error(`verify-report: ${error}`);
		console.log(
			JSON.stringify({
				ok: false,
				url: rawUrl,
				status: null,
				checks: {
					http: "skipped",
					noncePlaceholder: "skipped",
					scriptNonce: "skipped",
					expect: "skipped",
				},
				warnings: [],
				info: { hasInlineSvg: false, imgCount: 0 },
				screenshot: null,
				error,
			}),
		);
		process.exit(1);
	};

	let values: {
		url?: string;
		expect?: string;
		screenshot?: string;
		"shot-window"?: string;
		"timeout-ms"?: string;
		"shot-timeout-ms"?: string;
		"chrome-bin"?: string;
	};
	try {
		values = parseArgs({
			args,
			options: {
				url: { type: "string" },
				expect: { type: "string" },
				screenshot: { type: "string" },
				"shot-window": { type: "string" },
				"timeout-ms": { type: "string" },
				"shot-timeout-ms": { type: "string" },
				"chrome-bin": { type: "string" },
			},
			allowPositionals: false,
		}).values;
	} catch (error) {
		return failEnvelope(`invalid arguments: ${(error as Error).message}`);
	}

	rawUrl = values.url ?? "";
	if (!values.url) return failEnvelope("--url <http(s)://url> is required");
	const timeoutMs = parseOptionalNumber(values["timeout-ms"]);
	if (timeoutMs === null) {
		return failEnvelope("--timeout-ms must be a number");
	}
	const shotTimeoutMs = parseOptionalNumber(values["shot-timeout-ms"]);
	if (shotTimeoutMs === null) {
		return failEnvelope("--shot-timeout-ms must be a number");
	}

	let envelope: Awaited<ReturnType<typeof verifyReport>>["envelope"];
	let exitCode: number;
	try {
		({ envelope, exitCode } = await verifyReport({
			url: values.url,
			expect: values.expect,
			screenshotPath: values.screenshot,
			shotWindow: values["shot-window"],
			timeoutMs,
			shotTimeoutMs,
			chromeBin: values["chrome-bin"],
		}));
	} catch (error) {
		return failEnvelope(`verification failed: ${(error as Error).message}`);
	}
	if (!envelope.ok) console.error(`verify-report: ${envelope.error}`);
	console.log(JSON.stringify(envelope));
	process.exit(exitCode);
}

function parseOptionalNumber(
	raw: string | undefined,
): number | undefined | null {
	if (raw === undefined) return undefined;
	if (!/^-?\d+(?:\.\d+)?$/.test(raw)) return null;
	return Number(raw);
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
			deadline: { type: "string" },
			"hosted-url": { type: "string" },
			artifact: { type: "string", multiple: true },
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
	const founderReviewEvidence =
		checkpoint === "founder_review"
			? (() => {
					const activation = currentWorkflowCompletionActivationFromEnv(
						values["exec-id"] as string,
					);
					if (!activation) {
						throw new Error(
							"founder_review requires a current workflow activation",
						);
					}
					return {
						runId: activation.run_id,
						founderId: resolveFounderId({ processEnv: process.env }),
						hostedUrl: values["hosted-url"] ?? "",
						artifacts: inspectCommittedFounderReviewArtifacts({
							cwd: process.cwd(),
							paths: values.artifact ?? [],
						}),
					};
				})()
			: undefined;

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
		deadlineAt: values.deadline,
		founderReviewEvidence,
		nudge: () =>
			nudgeLeadInboxBestEffort({
				bridgeUrl: process.env.FLYWHEEL_BRIDGE_URL ?? process.env.BRIDGE_URL,
				leadId: values.lead as string,
				project: values.project,
				apiToken: process.env.TEAMLEAD_API_TOKEN,
				ingestToken: process.env.FLYWHEEL_INGEST_TOKEN,
			}),
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
