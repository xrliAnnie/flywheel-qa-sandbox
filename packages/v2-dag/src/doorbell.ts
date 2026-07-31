import { type Kernel, recordExternalEffectIntentTx } from "flywheel-v2-kernel";
import { appendEvent } from "./events.js";
import {
	insertEnvelope,
	makeEnvelope,
	readCutoverEpoch,
	readEnvelope,
	updateEnvelope,
} from "./meta.js";
import type { DagPorts } from "./types.js";

/**
 * FLY-1547 (纠正 FLY-1544 门铃语义): the bell only announces "你有新信" — it
 * NEVER carries the letter body and it NEVER settles the row. Content travels
 * exclusively through the recipient's own authenticated `next` (which is where
 * the read receipt is created), and settlement follows next/settle.
 *
 * Channel routing per live session:
 *  - official channel healthy (the session's mailbox MCP lease, probed through
 *    the launcher port) → do nothing here; the session's own channel bell
 *    rings and the engine must not double-ring;
 *  - otherwise → the issue-authorized LAST RESORT: paste a pointer-only bell
 *    line into the terminal. (The Codex remote-daemon bell route hangs off the
 *    same port once the FLY-1547 §9 authority ruling lands; until then Codex
 *    sessions take the pointer paste, which is also the ruling-B end state.)
 *
 * Exclusions kept from FLY-1544:
 * - `dag_task_dispatch` rows: the assignment is embedded in the spawn prompt
 *   and settled through the runner's own proposal.
 * - rows with ANY processing attempt: those are already inside the pull
 *   delivery machinery (the recipient asked for them); the attempt owns them.
 * - sessions without a binding: not launched yet, nothing to ring.
 *
 * Dedup/re-ring: a per-session durable cursor (`bell_cursor:<sessionRef>`)
 * keyed on the mailbox seq high-water; ring again only when the high-water
 * advances or the debt is overdue. A duplicate pointer paste (crash between
 * paste and cursor write) is a benign repeated bell — the intent/outcome
 * ceremony is reserved for the token-consuming Codex turn route.
 */
export interface SessionDeliveryPort {
	paste(sessionRef: string, text: string): Promise<void>;
	/** FLY-1563 ③: paste into a LEAD's terminal. A lead has no derivable tmux
	 * session name — its address is the pid its registration recorded (the
	 * agents.session_binding), resolved to the hosting pane at delivery time.
	 * pidStart is the binding's start identity: the implementation MUST refuse
	 * a pid whose live start identity differs (pid reuse would otherwise paste
	 * into a stranger's pane, advance the cursor, and silence the real lead —
	 * codex R1 HIGH-1). Absent method = the port cannot reach leads; the bell
	 * fails loud. */
	leadPaste?(
		agentId: string,
		pid: number,
		pidStart: string,
		text: string,
	): Promise<void>;
	/** FLY-1547: is the recipient's official channel (mailbox MCP) healthy? An
	 * absent probe means "no official channel exists" → last-resort paste. */
	channelHealthy?(sessionRef: string): Promise<boolean>;
	/** FLY-1547 §2.6: ring a remote-attached codex session through its own
	 * daemon (turn/start, idempotent under the key). Resolves false when the
	 * session has no daemon record — the caller falls to the pointer paste. */
	codexBell?(
		sessionRef: string,
		text: string,
		idempotencyKey: string,
	): Promise<boolean>;
}

/** Documented constants, not flags (founder-approved 2026-07-30): an
 * unanswered pending batch re-rings once per 300s window, capped at 5
 * re-rings per high-water. At the cap the bell goes silent for that batch —
 * the letters stay pending in the mailbox (any later pull sees them; nothing
 * is lost) and the engine records one visible capped event instead of
 * papering a wedged night into 100+ notes. */
export const OVERDUE_RERING_S = 300;
export const OVERDUE_RERING_CAP = 5;

export interface DoorbellResult {
	examined: number;
	rung: number;
	deferred: number;
	failed: number;
}

interface PendingSessionRow {
	to_agent: string;
	pending_total: number;
	max_seq: number;
	oldest_kind: string;
	/** FLY-1563: the registered lead's pane pid + process start identity
	 * (agents.session_binding); NULL for runner sessions, whose address is
	 * derived from the session ref. */
	lead_pid: number | null;
	lead_pid_start: string | null;
}

/** The two recipient namespaces never collide: `registerAgentTx` structurally
 * refuses `v2dag:` lead ids, and every runner session ref carries the prefix. */
function isRunnerSessionRecipient(toAgent: string): boolean {
	return toAgent.startsWith("v2dag:");
}

interface BellCursorData {
	last_rung_seq: number;
	last_rung_at: string;
	/** R4-F5: overdue re-rings at the SAME high-water need a fresh effect key,
	 * or the codex thread-read reconcile would suppress every re-ring. */
	rering_count?: number;
}

export function formatBellText(
	row: {
		pendingTotal: number;
		oldestKind: string;
	},
	recipient: "session" | "lead" = "session",
): string {
	const pull =
		recipient === "lead"
			? "内容不随铃投递:用 flywheel-v2-mailbox MCP 的 next 工具取信;没有 MCP 面时用 CLI(next --agent <你的 lead id> --delivery-credential-file <register-lead 落盘的凭据文件>)。取信即留读痕;FYI 读即销账(ack),runner_ask 先回信(enqueue ask_response)再 settle。"
			: "内容不随铃投递:用 `next --session $FLYWHEEL_V2_SESSION_REF`(经 FLYWHEEL_V2_CLIENT_CLI)取信;取信即留读痕,办完按 envelope 协议 settle。";
	return [
		`[flywheel-v2 mailbox bell] 你有 ${row.pendingTotal} 封新信 (最老 kind=${row.oldestKind})。`,
		pull,
	].join("\n");
}

export async function ringSessionDoorbells(
	kernel: Kernel,
	ports: DagPorts,
): Promise<DoorbellResult> {
	const result: DoorbellResult = {
		examined: 0,
		rung: 0,
		deferred: 0,
		failed: 0,
	};
	const delivery = ports.sessionDelivery;
	if (!delivery) return result;
	// FLY-1563 (founder directive): the bell is addressed by RECIPIENT, not by
	// namespace — the old `substr(m.to_agent,1,6)='v2dag:'` filter plus the
	// activations join structurally excluded every lead, which is why a runner
	// ask never woke its lead. Addressability now follows the recipient family:
	//  - runner session (`v2dag:` ref): a live activation with a session
	//    binding, exactly as before;
	//  - lead: a REGISTERED agents row (kind='lead') whose session binding
	//    carries the pane pid. A provisioned-only lead (generation 0, no
	//    binding) has no pane to ring — its mail waits for its own pull.
	const rows = kernel.read((tx) =>
		tx.all<PendingSessionRow>(
			`SELECT m.to_agent,
			        COUNT(*) AS pending_total,
			        MAX(m.seq) AS max_seq,
			        (SELECT oldest.kind FROM mailbox oldest
			          WHERE oldest.to_agent=m.to_agent AND oldest.state='pending'
			            AND oldest.source_kind<>'dag_task_dispatch'
			            AND NOT EXISTS(SELECT 1 FROM processing_attempts pa
			                            WHERE pa.message_uid=oldest.message_uid)
			          ORDER BY oldest.seq LIMIT 1) AS oldest_kind,
			        (SELECT CAST(json_extract(ag.session_binding,'$.pid') AS INTEGER)
			           FROM agents ag WHERE ag.agent_id=m.to_agent) AS lead_pid,
			        (SELECT json_extract(ag.session_binding,'$.pid_start')
			           FROM agents ag WHERE ag.agent_id=m.to_agent) AS lead_pid_start
			   FROM mailbox m
			  WHERE m.state='pending'
			    AND m.source_kind<>'dag_task_dispatch'
			    AND NOT EXISTS(SELECT 1 FROM processing_attempts pa
			                    WHERE pa.message_uid=m.message_uid)
			    AND ((substr(m.to_agent,1,6)='v2dag:'
			          AND EXISTS(SELECT 1 FROM activations act
			                      WHERE act.session_ref=m.to_agent
			                        AND act.state='active'
			                        AND act.session_binding IS NOT NULL))
			      OR (substr(m.to_agent,1,6)<>'v2dag:'
			          AND EXISTS(SELECT 1 FROM agents ag
			                      WHERE ag.agent_id=m.to_agent AND ag.kind='lead'
			                        AND ag.session_binding IS NOT NULL)))
			  GROUP BY m.to_agent
			  ORDER BY m.to_agent`,
		),
	);
	for (const row of rows) {
		result.examined += 1;
		// FLY-1556 (preserved through the FLY-1547 rewrite): one row's failure —
		// including a throwing cursor/event write — is THAT row's failure. Count
		// it, leave the debt pending for the next tick, keep ringing the rest.
		try {
			await ringOneSession(kernel, ports, delivery, row, result);
		} catch (error) {
			result.failed += 1;
			process.stderr.write(
				`[doorbell] session ${row.to_agent} bell processing failed: ${
					error instanceof Error ? error.message : String(error)
				}\n`,
			);
		}
	}
	return result;
}

async function ringOneSession(
	kernel: Kernel,
	ports: DagPorts,
	delivery: SessionDeliveryPort,
	row: PendingSessionRow,
	result: DoorbellResult,
): Promise<void> {
	{
		const cursorKey = `bell_cursor:${row.to_agent}`;
		const cursor = kernel.read((tx) =>
			readEnvelope<BellCursorData>(tx, cursorKey),
		);
		const advanced = !cursor || row.max_seq > cursor.data.last_rung_seq;
		const overdue =
			cursor != null &&
			ports.clock.nowMs() - Date.parse(cursor.data.last_rung_at) >=
				OVERDUE_RERING_S * 1000;
		if (!advanced && !overdue) return;
		const rering = advanced ? 0 : (cursor?.data.rering_count ?? 0) + 1;
		if (!advanced && rering > OVERDUE_RERING_CAP) {
			// Founder cap: the batch already got its 5 re-rings — record once,
			// stay silent until the high-water advances.
			kernel.write("v2dag.doorbell.rering-capped", (tx) => {
				const epoch = readCutoverEpoch(tx);
				const eventUid = `session_bell_rering_capped:${row.to_agent}:${row.max_seq}`;
				if (
					tx.get("SELECT 1 FROM events WHERE event_uid=@eventUid", { eventUid })
				) {
					return;
				}
				appendEvent(tx, {
					eventUid,
					kind: "session_bell_rering_capped",
					sourceKind: "doorbell",
					sourceId: row.to_agent,
					payload: {
						session_ref: row.to_agent,
						max_pending_seq: row.max_seq,
						pending_total: row.pending_total,
						rerings: OVERDUE_RERING_CAP,
					},
					cutoverEpoch: epoch,
					createdAt: ports.clock.nowIso(),
				});
			});
			return;
		}
		if (delivery.channelHealthy) {
			let healthy = false;
			try {
				healthy = await delivery.channelHealthy(row.to_agent);
			} catch {
				healthy = false;
			}
			if (healthy) {
				// The session's own channel bell owns the announcement; the engine
				// neither rings nor advances the cursor, so a later lease death
				// makes the same debt ring here.
				result.deferred += 1;
				return;
			}
		}
		const isRunnerSession = isRunnerSessionRecipient(row.to_agent);
		const bellText = formatBellText(
			{
				pendingTotal: row.pending_total,
				oldestKind: row.oldest_kind,
			},
			isRunnerSession ? "session" : "lead",
		);
		// FLY-1547 §2.5: the codex turn consumes tokens, so its external effect
		// rides the intent/outcome ledger with a stable key that doubles as the
		// daemon-side clientUserMessageId — a crash replay cannot double-ring.
		const effectKey =
			rering === 0
				? `bell:${row.to_agent}:${row.max_seq}`
				: `bell:${row.to_agent}:${row.max_seq}#r${rering}`;
		let channel: "codex_turn" | "paste_pointer" | "lead_paste" =
			"paste_pointer";
		try {
			if (!isRunnerSession) {
				// FLY-1563: the lead route. The codex daemon channel is session-scoped
				// and never applies; the pane is located by the registered pid, whose
				// start identity travels along so the port can refuse pid reuse.
				if (!delivery.leadPaste) {
					throw new Error("session delivery port cannot paste to a lead pane");
				}
				if (row.lead_pid === null || row.lead_pid_start === null) {
					throw new Error("lead recipient binding carries no pid identity");
				}
				await delivery.leadPaste(
					row.to_agent,
					row.lead_pid,
					row.lead_pid_start,
					bellText,
				);
				channel = "lead_paste";
			} else {
				let rung = false;
				if (delivery.codexBell) {
					kernel.write("v2dag.doorbell.bell-intent", (tx) => {
						recordExternalEffectIntentTx(tx, {
							effectKey,
							family: "bell",
							nowIso: ports.clock.nowIso(),
						});
					});
					rung = await delivery.codexBell(row.to_agent, bellText, effectKey);
					if (rung) channel = "codex_turn";
				}
				if (!rung) await delivery.paste(row.to_agent, bellText);
			}
		} catch (error) {
			result.failed += 1;
			const message = error instanceof Error ? error.message : String(error);
			kernel.write("v2dag.doorbell.bell-failed", (tx) => {
				const epoch = readCutoverEpoch(tx);
				const eventUid = `session_bell_failed:${row.to_agent}:${row.max_seq}`;
				if (
					tx.get("SELECT 1 FROM events WHERE event_uid=@eventUid", { eventUid })
				) {
					return;
				}
				appendEvent(tx, {
					eventUid,
					kind: "session_bell_failed",
					sourceKind: "doorbell",
					sourceId: row.to_agent,
					payload: {
						session_ref: row.to_agent,
						max_pending_seq: row.max_seq,
						pending_total: row.pending_total,
						error: message,
					},
					cutoverEpoch: epoch,
					createdAt: ports.clock.nowIso(),
				});
			});
			return;
		}
		kernel.write("v2dag.doorbell.bell-rung", (tx) => {
			const epoch = readCutoverEpoch(tx);
			const nowIso = ports.clock.nowIso();
			const current = readEnvelope<BellCursorData>(tx, cursorKey, epoch);
			const data: BellCursorData = {
				last_rung_seq: row.max_seq,
				last_rung_at: nowIso,
				rering_count: rering,
			};
			if (current) updateEnvelope(tx, cursorKey, current, data, nowIso);
			else insertEnvelope(tx, cursorKey, makeEnvelope(epoch, data), nowIso);
			const eventUid = `session_bell_rung:${row.to_agent}:${row.max_seq}`;
			if (
				!tx.get("SELECT 1 FROM events WHERE event_uid=@eventUid", { eventUid })
			) {
				appendEvent(tx, {
					eventUid,
					kind: "session_bell_rung",
					sourceKind: "doorbell",
					sourceId: row.to_agent,
					payload: {
						session_ref: row.to_agent,
						max_pending_seq: row.max_seq,
						pending_total: row.pending_total,
						channel,
					},
					cutoverEpoch: epoch,
					createdAt: nowIso,
				});
			}
		});
		result.rung += 1;
	}
}
