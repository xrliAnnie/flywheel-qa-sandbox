import Database from "better-sqlite3";

// Only the dedicated authority lifecycle may open this database. Bridge uses status RPC.
const SCHEMA = `
CREATE TABLE xhs_write_proposal (
 proposal_id TEXT PRIMARY KEY NOT NULL,
 project_id TEXT NOT NULL, lead_id TEXT NOT NULL, prepare_request_id TEXT NOT NULL,
 frozen_json TEXT NOT NULL, content_digest TEXT NOT NULL CHECK(length(content_digest)=64),
 account_user_id TEXT NOT NULL, account_epoch INTEGER NOT NULL CHECK(account_epoch>=0),
 provider_generation TEXT NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>=0),
 state TEXT NOT NULL CHECK(state IN ('preparing','awaiting_delivery','awaiting_approval','approved','rejected','revoked','superseded','expired','consumed')),
 created_at INTEGER NOT NULL DEFAULT 0 CHECK(created_at>=0),
 guild_id TEXT, channel_id TEXT, preview_manifest_json TEXT, preview_digest TEXT, card_id TEXT, challenge TEXT, supersedes_id TEXT REFERENCES xhs_write_proposal(proposal_id),
 UNIQUE(project_id,lead_id,prepare_request_id)
);
CREATE TABLE xhs_write_decision (
 receipt_id TEXT PRIMARY KEY NOT NULL,
 proposal_id TEXT NOT NULL UNIQUE REFERENCES xhs_write_proposal(proposal_id),
 founder_message_id TEXT NOT NULL UNIQUE,
 purpose TEXT NOT NULL CHECK(purpose='xiaohongshu_founder_write'),
 decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')),
 founder_id TEXT NOT NULL, founder_config_version INTEGER NOT NULL CHECK(founder_config_version>0),
 guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, card_id TEXT NOT NULL,
 message_digest TEXT NOT NULL CHECK(length(message_digest)=64),
 message_created_at INTEGER NOT NULL CHECK(message_created_at>=0),
 observed_at INTEGER NOT NULL CHECK(observed_at>=0 AND observed_at>=message_created_at-30000),
 expires_at INTEGER NOT NULL CHECK(expires_at>=message_created_at),
 content_digest TEXT NOT NULL CHECK(length(content_digest)=64),
 consumed_at INTEGER CHECK(consumed_at>=0), attempt_id TEXT,
 CHECK((consumed_at IS NULL)=(attempt_id IS NULL))
);
CREATE TABLE xhs_write_attempt (
 attempt_id TEXT PRIMARY KEY NOT NULL,
 receipt_id TEXT NOT NULL UNIQUE REFERENCES xhs_write_decision(receipt_id),
 proposal_id TEXT NOT NULL UNIQUE REFERENCES xhs_write_proposal(proposal_id),
 project_id TEXT NOT NULL, lead_id TEXT NOT NULL, activation_id TEXT NOT NULL,
 execute_request_id TEXT NOT NULL, content_digest TEXT NOT NULL CHECK(length(content_digest)=64),
 provider_generation TEXT NOT NULL, account_epoch INTEGER NOT NULL CHECK(account_epoch>=0), lease_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('claimed','dispatch-admitted','dispatched','succeeded','succeeded-noop','failed','unknown')),
 provider_ref TEXT, started_at INTEGER NOT NULL CHECK(started_at>=0),
 updated_at INTEGER NOT NULL CHECK(updated_at>=started_at), error_code TEXT,
 UNIQUE(project_id,lead_id,execute_request_id)
);
CREATE TABLE xhs_write_notification (
 event_id TEXT PRIMARY KEY NOT NULL, receipt_id TEXT REFERENCES xhs_write_decision(receipt_id),
 event_kind TEXT NOT NULL CHECK(event_kind IN ('approved','rejected','revoked','expired','delivery_delayed')),
 proposal_id TEXT NOT NULL REFERENCES xhs_write_proposal(proposal_id),
 expiry INTEGER NOT NULL CHECK(expiry>=0),
 delivery_state TEXT NOT NULL CHECK(delivery_state IN ('pending','delivered')),
 founder_state TEXT NOT NULL DEFAULT 'pending' CHECK(founder_state IN ('pending','delivered','suppressed')),
 attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
 UNIQUE(receipt_id,event_kind)
);
CREATE TABLE xhs_write_event (
 event_id TEXT PRIMARY KEY NOT NULL, source_message_id TEXT,
 proposal_id TEXT NOT NULL REFERENCES xhs_write_proposal(proposal_id),
 event_kind TEXT NOT NULL, actor_kind TEXT NOT NULL CHECK(actor_kind IN ('founder','authority','requester')),
 evidence_digest TEXT NOT NULL CHECK(length(evidence_digest)=64),
 created_at INTEGER NOT NULL CHECK(created_at>=0), UNIQUE(source_message_id,event_kind)
);
CREATE TRIGGER xhs_event_no_update BEFORE UPDATE ON xhs_write_event BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER xhs_event_no_delete BEFORE DELETE ON xhs_write_event BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TABLE xhs_frozen_artifact (
 artifact_id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL,
 sha256 TEXT NOT NULL CHECK(length(sha256)=64), size INTEGER NOT NULL CHECK(size>0),
 mime TEXT NOT NULL CHECK(mime IN ('image/png','image/jpeg','image/webp','video/mp4')),
 private_path TEXT NOT NULL, inode TEXT NOT NULL,
 created_at INTEGER NOT NULL CHECK(created_at>=0), retention_until INTEGER NOT NULL CHECK(retention_until>=created_at)
);
CREATE TABLE xhs_write_media_ref (
 proposal_id TEXT NOT NULL REFERENCES xhs_write_proposal(proposal_id), ordinal INTEGER NOT NULL CHECK(ordinal>=0),
 artifact_id TEXT NOT NULL REFERENCES xhs_frozen_artifact(artifact_id), PRIMARY KEY(proposal_id,ordinal)
);
CREATE TABLE authority_observer_cursor (
 channel_id TEXT PRIMARY KEY NOT NULL, state_json TEXT NOT NULL
);
PRAGMA user_version=1;
`;

/** Provision is for trusted installation only, never an automatic recovery option. */
export function openWriteLedger(
	path: string,
	options: { provision?: boolean } = {},
): Database.Database {
	let db: Database.Database | undefined;
	try {
		db = new Database(path, { fileMustExist: !options.provision });
		const version = db.pragma("user_version", { simple: true });
		if (version !== 1 && !(version === 0 && options.provision))
			throw new Error();
		db.pragma("journal_mode = WAL");
		db.pragma("synchronous = FULL");
		db.pragma("foreign_keys = ON");
		db.pragma("busy_timeout = 5000");
		db.pragma("fullfsync = ON");
		db.pragma("checkpoint_fullfsync = ON");
		for (const [key, expected] of Object.entries({
			journal_mode: "wal",
			synchronous: 2,
			foreign_keys: 1,
			busy_timeout: 5000,
			fullfsync: 1,
			checkpoint_fullfsync: 1,
		})) {
			if (db.pragma(key, { simple: true }) !== expected) throw new Error();
		}
		if (version === 0) {
			const connection = db;
			connection.transaction(() => connection.exec(SCHEMA)).immediate();
		}
		// A version number alone is insufficient evidence of an intact ledger.
		for (const table of [
			"xhs_write_proposal",
			"xhs_write_decision",
			"xhs_write_attempt",
			"xhs_write_notification",
			"xhs_write_event",
			"xhs_frozen_artifact",
			"xhs_write_media_ref",
		]) {
			if (
				!db
					.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
					.get(table)
			)
				throw new Error();
		}
		if (db.pragma("quick_check", { simple: true }) !== "ok") throw new Error();
		const violations = db.pragma("foreign_key_check");
		if (!Array.isArray(violations) || violations.length !== 0)
			throw new Error();
		return db;
	} catch {
		db?.close();
		throw new Error("durability_unavailable");
	}
}
