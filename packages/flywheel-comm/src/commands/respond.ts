import { homedir } from "node:os";
import { join } from "node:path";
import { CommDB } from "../db.js";
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
	} finally {
		db.close();
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
