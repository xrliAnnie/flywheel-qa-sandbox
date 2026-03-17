-- CIPHER Decision Memory — Supabase (Postgres) mirror tables.
-- These mirror the SQLite tables in CipherWriter.ts for read-only dashboard viewing.
-- Data flows: CipherWriter (SQLite) → CipherSyncService → Supabase (Postgres).

-- 1. decision_snapshots — one row per agent session completion
CREATE TABLE IF NOT EXISTS cipher_decision_snapshots (
  execution_id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  issue_identifier TEXT NOT NULL,
  issue_title TEXT NOT NULL,
  project_id TEXT NOT NULL,
  issue_labels TEXT NOT NULL,
  size_bucket TEXT NOT NULL,
  area_touched TEXT NOT NULL,
  system_route TEXT NOT NULL,
  system_confidence REAL NOT NULL,
  decision_source TEXT NOT NULL,
  decision_reasoning TEXT,
  commit_count INTEGER NOT NULL,
  files_changed INTEGER NOT NULL,
  lines_added INTEGER NOT NULL,
  lines_removed INTEGER NOT NULL,
  diff_summary TEXT,
  commit_messages TEXT,
  changed_file_paths TEXT,
  exit_reason TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  pattern_keys TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. decision_reviews — CEO approve/reject outcomes
CREATE TABLE IF NOT EXISTS cipher_decision_reviews (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL UNIQUE REFERENCES cipher_decision_snapshots(execution_id),
  ceo_action TEXT NOT NULL,
  ceo_outcome TEXT NOT NULL,
  friction_score TEXT NOT NULL DEFAULT 'low',
  ceo_action_timestamp TIMESTAMPTZ NOT NULL,
  notification_timestamp TIMESTAMPTZ,
  time_to_decision_seconds INTEGER,
  thread_ts TEXT,
  thread_message_count INTEGER,
  ceo_message_count INTEGER,
  source_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cipher_reviews_outcome ON cipher_decision_reviews(ceo_outcome);
CREATE INDEX IF NOT EXISTS idx_cipher_reviews_created ON cipher_decision_reviews(created_at);

-- 3. decision_patterns — aggregated pattern statistics
CREATE TABLE IF NOT EXISTS cipher_decision_patterns (
  pattern_key TEXT PRIMARY KEY,
  approve_count INTEGER NOT NULL DEFAULT 0,
  reject_count INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0,
  maturity_level TEXT NOT NULL DEFAULT 'exploratory',
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  last_90d_approve INTEGER DEFAULT 0,
  last_90d_total INTEGER DEFAULT 0
);

-- 4. review_pattern_keys — junction: review ↔ pattern
CREATE TABLE IF NOT EXISTS cipher_review_pattern_keys (
  review_id TEXT NOT NULL REFERENCES cipher_decision_reviews(id),
  pattern_key TEXT NOT NULL,
  is_approve INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (review_id, pattern_key)
);
CREATE INDEX IF NOT EXISTS idx_cipher_rpk_pattern ON cipher_review_pattern_keys(pattern_key);
CREATE INDEX IF NOT EXISTS idx_cipher_rpk_created ON cipher_review_pattern_keys(created_at);

-- 5. pattern_summary_cache — global approval rate
CREATE TABLE IF NOT EXISTS cipher_pattern_summary_cache (
  id TEXT PRIMARY KEY DEFAULT 'global',
  global_approve_count INTEGER DEFAULT 0,
  global_reject_count INTEGER DEFAULT 0,
  global_approve_rate REAL DEFAULT 0.5,
  prior_strength INTEGER DEFAULT 10,
  last_computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6. cipher_skills — learned behavioral patterns
CREATE TABLE IF NOT EXISTS cipher_skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  source_pattern_key TEXT,
  trigger_conditions TEXT NOT NULL,
  recommended_action TEXT NOT NULL,
  confidence REAL NOT NULL,
  sample_count INTEGER NOT NULL,
  derived_from_reviews TEXT,
  derived_by TEXT NOT NULL DEFAULT 'statistical',
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 7. cipher_principles — graduated decision rules
CREATE TABLE IF NOT EXISTS cipher_principles (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES cipher_skills(id),
  rule_type TEXT NOT NULL,
  rule_definition TEXT NOT NULL,
  confidence REAL NOT NULL,
  sample_count INTEGER NOT NULL,
  source_pattern TEXT NOT NULL DEFAULT '',
  graduation_criteria TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  activated_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  retired_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 8. cipher_questions — auto-detected anomalies / open questions
CREATE TABLE IF NOT EXISTS cipher_questions (
  id TEXT PRIMARY KEY,
  question_type TEXT NOT NULL,
  description TEXT NOT NULL,
  related_pattern_key TEXT,
  evidence TEXT NOT NULL,
  asked_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  resolution TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sync metadata — tracks last sync timestamp per source machine
CREATE TABLE IF NOT EXISTS cipher_sync_metadata (
  source_id TEXT PRIMARY KEY DEFAULT 'local',
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rows_synced INTEGER NOT NULL DEFAULT 0
);

-- RLS: all cipher tables are service-role only (no anon/client access)
ALTER TABLE decision_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision_statistics ENABLE ROW LEVEL SECURITY;
ALTER TABLE cipher_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE cipher_principles ENABLE ROW LEVEL SECURITY;
ALTER TABLE cipher_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cipher_sync_metadata ENABLE ROW LEVEL SECURITY;

-- Service-role full access (CipherSyncService uses service_role key)
CREATE POLICY "service_role_all" ON decision_snapshots FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all" ON decision_reviews FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all" ON decision_statistics FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all" ON cipher_skills FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all" ON cipher_principles FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all" ON cipher_questions FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all" ON cipher_sync_metadata FOR ALL USING (auth.role() = 'service_role');
