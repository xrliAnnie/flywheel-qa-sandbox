export const CANDIDATE_SQL = {
	F1: `-- F1 founder·immediate(命中 mailbox_pending_immediate_f)
SELECT seq,message_uid,payload,created_at FROM mailbox INDEXED BY mailbox_pending_immediate_f
 WHERE to_agent=:agent AND state='pending' AND next_retry_at IS NULL
   AND source_kind='founder' ORDER BY seq LIMIT 1;`,
	F2: `-- F2 founder·scheduled(命中 mailbox_pending_scheduled_f)
SELECT seq,message_uid,payload,created_at FROM mailbox INDEXED BY mailbox_pending_scheduled_f
 WHERE to_agent=:agent AND state='pending' AND next_retry_at IS NOT NULL
   AND next_retry_at<=:now AND source_kind='founder'
 ORDER BY next_retry_at, seq LIMIT 1;`,
	N1: `-- N1 非founder·immediate(命中 mailbox_pending_immediate_nf)
SELECT seq,message_uid,payload,created_at FROM mailbox INDEXED BY mailbox_pending_immediate_nf
 WHERE to_agent=:agent AND state='pending' AND next_retry_at IS NULL
   AND source_kind<>'founder' ORDER BY seq LIMIT 1;`,
	N2: `-- N2 非founder·scheduled(命中 mailbox_pending_scheduled_nf)
SELECT seq,message_uid,payload,created_at FROM mailbox INDEXED BY mailbox_pending_scheduled_nf
 WHERE to_agent=:agent AND state='pending' AND next_retry_at IS NOT NULL
   AND next_retry_at<=:now AND source_kind<>'founder'
 ORDER BY next_retry_at, seq LIMIT 1;`,
} as const;

/**
 * FLY-1563: the runner-session PULL variants of the non-founder lanes. The
 * spawn-injected `dag_task_dispatch` letter is delivered through the spawn
 * prompt and its attempt stays open for the whole task, so a session's later
 * pulls must select PAST it while it runs. It becomes pull-eligible again in
 * exactly one shape — the FLY-1503 item 8 redelivery: a prior attempt exists
 * and every attempt is settled (crash-settled outside the host, message
 * rescheduled), where withholding it would wedge the executor forever. A
 * dispatch row with NO attempt yet belongs to the spawn path alone. Founder
 * lanes carry no dispatch rows and stay verbatim. The extra predicates are
 * correlated EXISTS probes on the processing_attempts unique indexes inside
 * the same per-recipient partial-index scan — no TEMP B-TREE.
 */
export const CANDIDATE_SQL_BEYOND_ASSIGNMENT = {
	N1: `-- N1 非founder·immediate·beyond-assignment(命中 mailbox_pending_immediate_nf)
SELECT seq,message_uid,payload,created_at FROM mailbox INDEXED BY mailbox_pending_immediate_nf
 WHERE to_agent=:agent AND state='pending' AND next_retry_at IS NULL
   AND source_kind<>'founder'
   AND (source_kind<>'dag_task_dispatch'
        OR (EXISTS(SELECT 1 FROM processing_attempts pa
                    WHERE pa.message_uid=mailbox.message_uid)
            AND NOT EXISTS(SELECT 1 FROM processing_attempts pa
                    WHERE pa.message_uid=mailbox.message_uid
                      AND pa.outcome='running')))
 ORDER BY seq LIMIT 1;`,
	N2: `-- N2 非founder·scheduled·beyond-assignment(命中 mailbox_pending_scheduled_nf)
SELECT seq,message_uid,payload,created_at FROM mailbox INDEXED BY mailbox_pending_scheduled_nf
 WHERE to_agent=:agent AND state='pending' AND next_retry_at IS NOT NULL
   AND next_retry_at<=:now AND source_kind<>'founder'
   AND (source_kind<>'dag_task_dispatch'
        OR (EXISTS(SELECT 1 FROM processing_attempts pa
                    WHERE pa.message_uid=mailbox.message_uid)
            AND NOT EXISTS(SELECT 1 FROM processing_attempts pa
                    WHERE pa.message_uid=mailbox.message_uid
                      AND pa.outcome='running')))
 ORDER BY next_retry_at, seq LIMIT 1;`,
} as const;

export const DETECTOR_SQL = `SELECT count(*), min(created_at) FROM mailbox
 WHERE to_agent=:agent AND state='pending' AND created_at<=:cutoff;`;
