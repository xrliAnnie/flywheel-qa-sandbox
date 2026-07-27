export const CANDIDATE_SQL = {
	F1: `-- F1 founder·immediate(命中 mailbox_pending_immediate_f)
SELECT seq,message_uid,payload FROM mailbox
 WHERE to_agent=:agent AND state='pending' AND next_retry_at IS NULL
   AND source_kind='founder' ORDER BY seq LIMIT 1;`,
	F2: `-- F2 founder·scheduled(命中 mailbox_pending_scheduled_f)
SELECT seq,message_uid,payload FROM mailbox
 WHERE to_agent=:agent AND state='pending' AND next_retry_at IS NOT NULL
   AND next_retry_at<=:now AND source_kind='founder'
 ORDER BY next_retry_at, seq LIMIT 1;`,
	N1: `-- N1 非founder·immediate(命中 mailbox_pending_immediate_nf)
SELECT seq,message_uid,payload FROM mailbox
 WHERE to_agent=:agent AND state='pending' AND next_retry_at IS NULL
   AND source_kind<>'founder' ORDER BY seq LIMIT 1;`,
	N2: `-- N2 非founder·scheduled(命中 mailbox_pending_scheduled_nf)
SELECT seq,message_uid,payload FROM mailbox
 WHERE to_agent=:agent AND state='pending' AND next_retry_at IS NOT NULL
   AND next_retry_at<=:now AND source_kind<>'founder'
 ORDER BY next_retry_at, seq LIMIT 1;`,
} as const;

export const DETECTOR_SQL = `SELECT count(*), min(created_at) FROM mailbox
 WHERE to_agent=:agent AND state='pending' AND created_at<=:cutoff;`;
