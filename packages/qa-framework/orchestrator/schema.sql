-- schema.sql — QA Framework Agent Orchestrator
-- Generic version: no hardcoded domain or agent_type constraints.
-- Agent types and step templates are defined in qa-config.yaml.

PRAGMA user_version = 1;

CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    version TEXT NOT NULL,
    slug TEXT NOT NULL,
    issue_id TEXT UNIQUE,
    plan_file TEXT,
    branch TEXT DEFAULT '',
    worktree_path TEXT,
    pr_number INTEGER,
    status TEXT NOT NULL DEFAULT 'spawned'
        CHECK(status IN ('spawned','running','awaiting_approval','shipping','completed','failed','stopped')),
    error_message TEXT,
    spawned_at DATETIME DEFAULT (datetime('now')),
    completed_at DATETIME,
    updated_at DATETIME DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS step_templates (
    agent_type TEXT NOT NULL,
    step_key TEXT NOT NULL,
    step_name TEXT NOT NULL,
    step_order INTEGER NOT NULL,
    prerequisite TEXT,
    is_aggregate BOOLEAN NOT NULL DEFAULT 0,
    PRIMARY KEY (agent_type, step_key)
);

CREATE TABLE IF NOT EXISTS agent_steps (
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    step_key TEXT NOT NULL,
    step_name TEXT NOT NULL,
    step_order INTEGER NOT NULL,
    prerequisite TEXT,
    is_aggregate BOOLEAN NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','in_progress','completed','skipped','failed')),
    started_at DATETIME,
    completed_at DATETIME,
    notes TEXT,
    PRIMARY KEY (agent_id, step_key)
);

CREATE TABLE IF NOT EXISTS artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    artifact_type TEXT NOT NULL,
    value TEXT NOT NULL,
    metadata TEXT,
    created_at DATETIME DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_agents_issue ON agents(issue_id);
CREATE INDEX IF NOT EXISTS idx_agent_steps_agent ON agent_steps(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_artifacts_agent ON artifacts(agent_id);
