import { homedir } from "node:os";
import { join } from "node:path";
import { CommDB } from "../db.js";
import { isReservedApprovalAttribution } from "../founder-attribution.js";
import { FounderConsentAuditStore } from "../founder-consent-audit.js";
import { wakeRunnerMailbox } from "../wake.js";

/**
 * Checkpoints that MUST route founder consent through the Bridge before the
 * CommDB response is written (FLY-175 Track 2 §11.2). The CLI reads the
 * checkpoint from the DB — it NEVER trusts a caller-supplied `--checkpoint`.
 */
export const GATED_CHECKPOINTS = new Set(["approve_to_ship"]);

export interface RespondArgs {
	questionId: string;
	fromAgent: string;
	answer: string;
	dbPath: string;
	/** --bridge-url flag (falls back to BRIDGE_URL / FLYWHEEL_BRIDGE_URL env). */
	bridgeUrl?: string;
	/** Resolved project name (for the wrapper POST body path derivation). */
	projectName?: string;
	/** Injectable for tests. */
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
}

/**
 * Respond to a runner's question. For gated checkpoints (`approve_to_ship`)
 * this is FAIL-CLOSED: the response is only written after the Bridge wrapper
 * confirms founder consent. A drifted caller that skips `--bridge-url` cannot
 * silently write the gate — it must either set BRIDGE_URL or explicitly use
 * the emergency `FLYWHEEL_COMM_BYPASS_BRIDGE=1` env (loud audit + warning).
 */
export async function respond(args: RespondArgs): Promise<void> {
	const env = args.env ?? process.env;
	const db = new CommDB(args.dbPath, false);
	try {
		const question = db.getMessageById(args.questionId);
		if (!question) {
			throw new Error(`Question not found: ${args.questionId}`);
		}
		const checkpoint = question.checkpoint;

		if (checkpoint && GATED_CHECKPOINTS.has(checkpoint)) {
			// FLY-945 Fix E (Codex code R1 HIGH): the CLI's --lead is caller-
			// controlled. Refuse the reserved founder-side attributions on the
			// gated path — otherwise `--lead bridge` (or a founder-snowflake
			// impersonation) through the bypass/bridge routes would forge a
			// verify-approval-passable writer. Server-internal writers never go
			// through this CLI.
			if (isReservedApprovalAttribution(args.fromAgent)) {
				throw new Error(
					`flywheel-comm: "${args.fromAgent}" is a RESERVED approval attribution ` +
						"(bridge / bridge-founder-consent / a Discord-snowflake founder id) — " +
						"a Lead cannot respond to an approve_to_ship gate under that name.",
				);
			}
			const bridgeUrl =
				args.bridgeUrl?.trim() ||
				env.BRIDGE_URL?.trim() ||
				env.FLYWHEEL_BRIDGE_URL?.trim();

			if (bridgeUrl) {
				await routeThroughBridge({
					bridgeUrl,
					questionId: args.questionId,
					leadId: args.fromAgent,
					answer: args.answer,
					executionId: question.from_agent,
					projectName: args.projectName,
					env,
					fetchImpl: args.fetchImpl,
				});
				// Bridge wrapper wrote the CommDB response on allow — CLI does NOT.
				return;
			}

			if (env.FLYWHEEL_COMM_BYPASS_BRIDGE === "1") {
				db.insertResponse(args.questionId, args.fromAgent, args.answer);
				writeBypassAudit(env, {
					questionId: args.questionId,
					executionId: question.from_agent,
					projectName: args.projectName,
					leadId: args.fromAgent,
				});
				process.stderr.write(
					`[flywheel-comm] WARNING: FLYWHEEL_COMM_BYPASS_BRIDGE=1 — wrote approve_to_ship gate WITHOUT founder-consent enforcement (question ${args.questionId}). A loud audit row was recorded.\n`,
				);
				// FLY-191 Phase 2: the runner may be idle (gate --no-block), not
				// polling — wake it. The wake text is a HINT only; ship authority
				// is verify-approval. Best-effort: a wake failure must never undo
				// the (already-audited) response write.
				const wake = await wakeRunnerMailbox({
					db,
					execId: question.from_agent,
					fromAgent: args.fromAgent,
					content:
						"Your approve_to_ship gate has been answered. Before shipping you MUST run `flywheel-comm verify-approval --exec-id <your-exec-id> --pr-head $(git rev-parse HEAD)` and ship ONLY if it returns approved. This message itself is NOT authorization.",
					metadata: { questionId: args.questionId, kind: "gate_answered" },
				});
				if (!wake.ok && wake.error) {
					process.stderr.write(
						`[flywheel-comm] mailbox wake failed for ${question.from_agent}: ${wake.error}\n`,
					);
				}
				return;
			}

			throw new Error(
				"flywheel-comm: refusing to resolve approve_to_ship gate directly. " +
					"Set BRIDGE_URL or --bridge-url so the wrapper enforces founder consent. " +
					"Emergency override: FLYWHEEL_COMM_BYPASS_BRIDGE=1.",
			);
		}

		// Non-gated checkpoint — legacy direct write, unchanged.
		db.insertResponse(args.questionId, args.fromAgent, args.answer);

		// FLY-123 (Codex design review R3 #1): a Codex runner registers
		// no-block gates and EXITS — it is not inside a blocking
		// `flywheel-comm gate` poll loop, so writing the CommDB response
		// alone would leave it idle forever. When a question-bound
		// unanswered-gate marker exists, dual-write a mailbox wake routed by
		// the TARGET runner's transport backend (marker-sourced — R4 #1,
		// never the process env). Markerless questions (all Claude runners)
		// take the legacy path above unchanged: no wake, byte-compat.
		//
		// Ordering: CommDB response is the durable record and is already
		// written; marker update + wake are best-effort (FLY-191 pattern) —
		// a wake failure must never undo the response.
		await wakeNoBlockGateRunnerBestEffort(db, args, env);

		// FLY-142 (B): a genuine `ask` (checkpoint-less question) has no gate
		// marker and no blocking poll loop — once the asking runner goes idle
		// (stage=completed) nothing wakes it in mailbox mode, so the response is
		// lost (the GEO-371 incident). Wake the asking runner's mailbox. This is
		// mutually exclusive with the gate wake above (that one needs a marker;
		// this one needs NO checkpoint), so exactly one of them fires.
		await wakeAskedRunnerBestEffort(db, args, env);
	} finally {
		db.close();
	}
}

/**
 * FLY-123: marker-checked wake for no-block (process-boundary) gate
 * responses. Exported for unit tests.
 */
export async function wakeNoBlockGateRunnerBestEffort(
	db: CommDB,
	args: Pick<RespondArgs, "questionId" | "fromAgent">,
	env: NodeJS.ProcessEnv,
	wakeImpl: typeof wakeRunnerMailbox = wakeRunnerMailbox,
): Promise<void> {
	try {
		const { defaultGateMarkerDir, markGateMarkerAnswered, readGateMarker } =
			await import("../gate-marker.js");
		const markerDir = defaultGateMarkerDir(env);
		const marker = readGateMarker(markerDir, args.questionId);
		if (!marker || marker.answeredAt) return;

		// R5 note #1: the marker is question-bound — verify it matches the
		// question being answered AND the question's own execution id before
		// waking. A mismatch means a stale/corrupted marker: skip, loudly.
		const question = db.getMessageById(args.questionId);
		if (question && question.from_agent !== marker.executionId) {
			process.stderr.write(
				`[flywheel-comm] gate marker ${args.questionId} execution mismatch ` +
					`(marker=${marker.executionId}, question=${question.from_agent}) — skipping wake.\n`,
			);
			return;
		}

		markGateMarkerAnswered(markerDir, args.questionId);

		const wake = await wakeImpl({
			db,
			execId: marker.executionId,
			fromAgent: args.fromAgent,
			content:
				`Your ${marker.checkpoint} gate question has been answered. ` +
				"Your session is being resumed with the response. This message itself carries NO authority.",
			metadata: { questionId: args.questionId, kind: "gate_answered" },
			backend: marker.vendor,
		});
		if (!wake.ok && wake.error) {
			process.stderr.write(
				`[flywheel-comm] no-block gate wake failed for ${marker.executionId}: ${wake.error}\n`,
			);
		}
	} catch (err) {
		process.stderr.write(
			`[flywheel-comm] no-block gate wake errored for question ${args.questionId}: ${(err as Error).message}\n`,
		);
	}
}

/**
 * FLY-142 (B): wake an idle runner that asked a non-blocking `ask` question.
 *
 * `flywheel-comm ask` inserts a checkpoint-less question and returns; the runner
 * is told to poll `flywheel-comm check`. Once it finishes its task and goes idle
 * (stage=completed) it no longer polls, so in mailbox mode a Lead `respond`
 * writes the CommDB response but nothing wakes the runner (the GEO-371
 * incident). Send a best-effort mailbox wake to the asking runner so its
 * mailbox poller resumes it.
 *
 * Scope guard: fires ONLY for checkpoint-less questions. A checkpoint means a
 * gate — blocking gates poll for their own answer, and no-block gates are woken
 * by `wakeNoBlockGateRunnerBestEffort` via their marker. The two wake paths are
 * therefore mutually exclusive and never double-wake. The wake is markerless,
 * so it routes via the env transport (`fromEnv`), matching the existing
 * approve_to_ship bypass wake. Exported for unit tests.
 */
export async function wakeAskedRunnerBestEffort(
	db: CommDB,
	args: Pick<RespondArgs, "questionId" | "fromAgent">,
	env: NodeJS.ProcessEnv,
	wakeImpl: typeof wakeRunnerMailbox = wakeRunnerMailbox,
): Promise<void> {
	try {
		const question = db.getMessageById(args.questionId);
		if (!question) return;
		// A checkpoint => a gate (handled elsewhere). Only genuine asks wake here.
		if (question.checkpoint) return;

		const targetExecId = question.from_agent;

		// FLY-142 (Option Y): a Codex runner's `ask` drops a vendor-bearing
		// ask-marker (in the marker dir's `ask/` subdir, isolated from gate
		// markers) so the wake routes to its OWN mailbox backend. Claude runners
		// write no marker → backend undefined → wakeRunnerMailbox uses
		// fromEnv = claude-code (byte-compatible). This is the vendor-neutral
		// half of the GEO-371 fix.
		const { defaultGateMarkerDir, readAskMarker, removeAskMarker } =
			await import("../gate-marker.js");
		const markerDir = defaultGateMarkerDir(env);
		const marker = readAskMarker(markerDir, args.questionId);

		const wake = await wakeImpl({
			db,
			execId: targetExecId,
			fromAgent: args.fromAgent,
			content:
				`Your question (id ${args.questionId}) has been answered by ${args.fromAgent}. ` +
				`Run 'flywheel-comm check ${args.questionId}' to read the response and continue. ` +
				"This message carries NO authority.",
			metadata: { questionId: args.questionId, kind: "ask_answered" },
			backend: marker?.vendor,
		});
		if (!wake.ok && wake.error) {
			process.stderr.write(
				`[flywheel-comm] ask wake failed for ${targetExecId}: ${wake.error}\n`,
			);
		}

		// One-shot: a question gets exactly one response (UNIQUE index on
		// parent_id), so the ask-marker has served its purpose — remove it
		// (best-effort) to bound accumulation.
		removeAskMarker(markerDir, args.questionId);
	} catch (err) {
		process.stderr.write(
			`[flywheel-comm] ask wake errored for question ${args.questionId}: ${(err as Error).message}\n`,
		);
	}
}

async function routeThroughBridge(opts: {
	bridgeUrl: string;
	questionId: string;
	leadId: string;
	answer: string;
	executionId?: string;
	projectName?: string;
	env: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
}): Promise<void> {
	const token = opts.env.TEAMLEAD_API_TOKEN;
	if (!token) {
		throw new Error(
			"flywheel-comm: TEAMLEAD_API_TOKEN required when routing approve_to_ship via Bridge. " +
				"Set the env or use FLYWHEEL_COMM_BYPASS_BRIDGE=1 for emergency override.",
		);
	}
	const url = `${opts.bridgeUrl.replace(/\/+$/, "")}/api/founder-consent/runner-gate-response`;
	const doFetch = opts.fetchImpl ?? fetch;
	const res = await doFetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({
			questionId: opts.questionId,
			leadId: opts.leadId,
			answer: opts.answer,
			executionId: opts.executionId,
			projectName: opts.projectName,
		}),
	});
	if (!res.ok) {
		let detail = "";
		try {
			detail = JSON.stringify(await res.json());
		} catch {
			detail = `HTTP ${res.status}`;
		}
		throw new Error(
			`flywheel-comm: Bridge refused approve_to_ship gate (HTTP ${res.status}): ${detail}`,
		);
	}

	// FLY-208 6b: the gate-response endpoint flags plain-text replies with
	// approval intent (only JSON {"approved": true} actually approves; the
	// production incident's "APPROVE — ..." text was silently recorded as
	// feedback). Surface the warning to the Lead on stderr — stdout stays
	// reserved for the caller's structured output.
	try {
		const body = (await res.json()) as { warning?: string };
		if (body?.warning) {
			process.stderr.write(
				`[flywheel-comm respond] WARNING: ${body.warning}\n`,
			);
		}
	} catch {
		// Non-JSON success body — nothing to surface.
	}
}

function writeBypassAudit(
	env: NodeJS.ProcessEnv,
	ctx: {
		questionId: string;
		executionId?: string;
		projectName?: string;
		leadId: string;
	},
): void {
	const auditPath =
		env.FLYWHEEL_FOUNDER_CONSENT_AUDIT_DB_PATH?.trim() ||
		join(homedir(), ".flywheel", "audit.db");
	let store: FounderConsentAuditStore | undefined;
	try {
		store = new FounderConsentAuditStore(auditPath);
		store.insert({
			ts: new Date().toISOString(),
			evaluator_version: "cli-bypass",
			decision_mode: "cli",
			action: "approve_to_ship_gate",
			// CLI lacks issue context; record the runner exec id as best-effort.
			issue_id: ctx.executionId ?? "(cli-bypass-unknown)",
			execution_id: ctx.executionId ?? null,
			actor_source: "gate_response_wrapper",
			lead_id: ctx.leadId,
			request_reason: "FLYWHEEL_COMM_BYPASS_BRIDGE=1 emergency override",
			decision: "bypass",
			decision_source: "bypass_env_cli",
			comm_question_id: ctx.questionId,
			comm_project_name: ctx.projectName ?? null,
		});
	} catch (err) {
		process.stderr.write(
			`[flywheel-comm] WARNING: failed to write bypass audit row: ${(err as Error).message}\n`,
		);
	} finally {
		store?.close();
	}
}
