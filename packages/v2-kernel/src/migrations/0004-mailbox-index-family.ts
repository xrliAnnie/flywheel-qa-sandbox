export const MAILBOX_INDEX_FAMILY_DDL = `CREATE INDEX mailbox_pending_immediate ON mailbox(to_agent, seq)
  WHERE state='pending' AND next_retry_at IS NULL;
CREATE INDEX mailbox_pending_scheduled ON mailbox(to_agent, next_retry_at, seq)
  WHERE state='pending' AND next_retry_at IS NOT NULL;
CREATE INDEX mailbox_pending_immediate_f ON mailbox(to_agent, seq)
  WHERE state='pending' AND next_retry_at IS NULL AND source_kind='founder';
CREATE INDEX mailbox_pending_scheduled_f ON mailbox(to_agent, next_retry_at, seq)
  WHERE state='pending' AND next_retry_at IS NOT NULL AND source_kind='founder';
CREATE INDEX mailbox_pending_immediate_nf ON mailbox(to_agent, seq)
  WHERE state='pending' AND next_retry_at IS NULL AND source_kind<>'founder';
CREATE INDEX mailbox_pending_scheduled_nf ON mailbox(to_agent, next_retry_at, seq)
  WHERE state='pending' AND next_retry_at IS NOT NULL AND source_kind<>'founder';
CREATE INDEX mailbox_pending_age ON mailbox(to_agent, created_at) WHERE state='pending';`;
