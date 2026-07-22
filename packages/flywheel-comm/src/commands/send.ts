import { randomUUID } from "node:crypto";
import { CommDB } from "../db.js";
import {
	authorizeLeadWrite,
	type LeadWriteAuthorizationDeps,
} from "../lead-lease.js";
import { wakeRunnerMailbox } from "../wake.js";

export interface SendArgs {
	fromAgent: string;
	toAgent: string;
	content: string;
	dbPath: string;
	env?: NodeJS.ProcessEnv;
	/** Injectable OS-process seams for deterministic tests. */
	authorizationDeps?: LeadWriteAuthorizationDeps;
}

/**
 * Send a Lead → Runner instruction.
 *
 * Lease authorization happens before any CommDB mutation. Once authorized,
 * the CommDB write is the durable record (audit + rollback substrate) and
 * happens before delivery. In mailbox mode (default) we ALSO write the Runner's
 * claude-code Agent Team inbox so its stock `useInboxPoller` wakes an idle
 * Runner — FLY-168 fixes the transport gap where a sentinel-equipped idle
 * Runner never saw the CommDB-only instruction (the PostToolUse hook short-
 * circuits to a no-op when the mailbox sentinel is present).
 *
 * The mailbox write is BEST-EFFORT: failures are logged to stderr and never
 * block the CommDB write. CommDB is NOT an active mailbox-mode delivery
 * fallback (the sentinel keeps the hook inert) — it is the audit/rollback
 * record. On a mailbox-write failure the operational recovery is the loud
 * stderr log plus rollback / manual resend.
 *
 * Returns the CommDB message id. Async because the mailbox write is async;
 * stdout is reserved for the caller's id/JSON output, so all diagnostics here
 * go to stderr only.
 */
export async function send(args: SendArgs): Promise<string> {
	const authorization = authorizeLeadWrite(
		{
			claimedLeadId: args.fromAgent,
			env: args.env,
		},
		args.authorizationDeps,
	);
	const db = new CommDB(args.dbPath);
	try {
		const targetVendor = db.getSession(args.toAgent)?.vendor;
		const id = randomUUID();
		const wakeContent = `[lead-instruction ${id}]\n${args.content}`;
		const wakeMetadata = {
			flywheelId: id,
			execId: args.toAgent,
			...(authorization.provenance
				? { senderProvenance: authorization.provenance }
				: {}),
		};
		const wakeIntent = db.instructionAndIntent({
			instructionId: id,
			fromAgent: args.fromAgent,
			executionId: args.toAgent,
			content: args.content,
			intentKey: `instruction:${id}`,
			envelope: {
				id: `instruction:${id}`,
				to: args.toAgent,
				content: wakeContent,
				metadata: wakeMetadata,
			},
			queuedAtMs: Date.now(),
			provenance: authorization.provenance,
			wakePolicy: {
				transportAvailable: targetVendor !== "none",
				execPushCap: receiptPositiveInt(
					args.env?.FLYWHEEL_RECEIPT_EXEC_PUSH_CAP ??
						process.env.FLYWHEEL_RECEIPT_EXEC_PUSH_CAP,
					6,
				),
				execPushWindowMs:
					receiptPositiveInt(
						args.env?.FLYWHEEL_RECEIPT_EXEC_PUSH_WINDOW_MIN ??
							process.env.FLYWHEEL_RECEIPT_EXEC_PUSH_WINDOW_MIN,
						10,
					) * 60_000,
			},
		});

		// FLY-626: a Lead/founder instruction to the runner is a RE-ENGAGEMENT —
		// it clears any self-declared park/busy marker so the stall watchdogs
		// resume normal monitoring. Without this, an indefinite `park` could
		// survive re-engagement and keep suppressing runner_idle_detected /
		// session_stuck for a runner that is no longer intentionally parked
		// (Codex code-review #1 — protects the FLY-369 "never silently hide a
		// genuinely stuck runner" posture). No-op when no marker exists.
		db.clearDeclaredState(args.toAgent);

		// FLY-191: wake logic extracted to wake.ts (shared with the approval
		// write-sites). Semantics unchanged from FLY-168: best-effort, CommDB
		// row is the durable record, diagnostics to stderr only.
		//
		// FLY-208 B: the Runner-visible wake text is prefixed with the CommDB
		// message id. The stock claude-code inbox poller is at-least-once
		// (markRead is fire-and-forget; the busy-path requeue has no dedup), so
		// the same instruction can be injected twice — the prefix lets the
		// Runner recognize a re-delivery and idempotent-skip per protocol. The
		// prefix is applied HERE (send-specific), NOT in wake.ts, which is
		// shared with the approval write-sites whose wake text must stay
		// undecorated. The CommDB row keeps the ORIGINAL content (audit without
		// transport decoration).
		//
		// FLY-1188: route the wake by the TARGET runner's registered transport
		// vendor (session row, written at spawn — dispatcher pre-registration
		// AND adapter self-registration both carry it) so a codex runner's
		// instruction reaches the codex mailbox — the process-wide env default
		// is locked to claude-code and misrouted every Lead `send` to a codex
		// runner (the /eleven "Lead couldn't wake turn-1" incident). Only a
		// NULL vendor (legacy row) keeps the env fallback; any other string —
		// including "" — flows through so an unknown vendor is a LOUD wake
		// error (never a silent claude fallback), surfaced via the stderr
		// path below.
		if (targetVendor === "none") {
			// No-transport backend (antigravity/kimi): there is NO mailbox to
			// wake. Loud skip — the CommDB row above stays the durable record,
			// and delivered_at is NEVER set (nothing was delivered). Writing
			// the env-default claude inbox here would fake delivery.
			console.error(
				`[flywheel-comm send] runner ${args.toAgent} uses a no-transport backend (vendor="none") — no mailbox wake is possible; instruction recorded in CommDB only`,
			);
			return id;
		}
		const pushClaim = db.claimRunnerReceiptWakePush(
			args.toAgent,
			wakeIntent.wake.message_id,
			Date.now(),
			{
				t1Ms: receiptPositiveInt(
					args.env?.FLYWHEEL_RECEIPT_WAKE_T1_MS ??
						process.env.FLYWHEEL_RECEIPT_WAKE_T1_MS,
					90_000,
				),
				claimTtlMs: 30_000,
			},
		);
		if (!pushClaim) {
			if (wakeIntent.wake.admission_state === "suppressed_cap") {
				console.error(
					`[flywheel-comm send] wake admission cap suppressed ${wakeIntent.wake.message_id}; instruction remains durable`,
				);
			}
			return id;
		}
		const wake = await wakeRunnerMailbox({
			db,
			execId: args.toAgent,
			fromAgent: args.fromAgent,
			content: pushClaim.envelope.content,
			metadata: pushClaim.envelope.metadata,
			...(targetVendor != null && { backend: targetVendor }),
		});
		db.completeRunnerReceiptWakePush({
			executionId: args.toAgent,
			messageId: pushClaim.wake.message_id,
			claimToken: pushClaim.claimToken,
			attempt: pushClaim.attempt,
			result: wake.ok
				? "delivered"
				: wake.skippedReason
					? `skipped:${wake.skippedReason}`
					: `failed:${wake.error ?? "unknown"}`,
			nowMs: Date.now(),
		});
		if (wake.ok) {
			// FLY-208 B: delivered_at = "transport write returned ok" (raw
			// write — wakeRunnerMailbox does not verify). Closes the audit gap
			// where a delivered-and-acted-on instruction was indistinguishable
			// from one that never left CommDB (read_at NULL + delivered_at
			// NULL, the incident signature). read_at intentionally NOT set: in
			// mailbox mode there is no reliable Runner-side ack point, and we
			// don't fake one. Reuses the FLY-109 column + helper — no second
			// marking scheme.
			db.markInstructionDelivered(id);
		} else if (wake.skippedReason === "no_session_lead") {
			console.warn(
				`[flywheel-comm send] no session/lead_id for ${args.toAgent}; mailbox wake skipped (CommDB instruction written)`,
			);
		} else if (wake.error) {
			console.error(
				`[flywheel-comm send] mailbox wake failed for ${args.toAgent}: ${wake.error}`,
			);
		}

		return id;
	} finally {
		db.close();
	}
}

function receiptPositiveInt(raw: string | undefined, fallback: number): number {
	if (raw === undefined || !raw.trim()) return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`invalid positive receipt configuration value: ${raw}`);
	}
	return value;
}
