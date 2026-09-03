#!/usr/bin/env bash
# Restore only FLY-2278's startup JSON upgrades. Run against a copy/snapshot,
# inspect the default dry-run, then repeat with --apply.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_PATH=""
MODE="dry-run"

usage() {
  printf 'Usage: %s --db <teamlead.db snapshot> [--apply]\n' "$(basename "$0")" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db)
      [[ $# -ge 2 ]] || { usage; exit 64; }
      DB_PATH="$2"
      shift 2
      ;;
    --apply)
      MODE="apply"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 64
      ;;
  esac
done

[[ -n "$DB_PATH" && -f "$DB_PATH" ]] || {
  printf 'ERROR: --db must name an existing database snapshot\n' >&2
  exit 66
}

cd "$ROOT/packages/teamlead"
node - "$DB_PATH" "$MODE" <<'NODE'
const Database = require("better-sqlite3");

const dbPath = process.argv[2];
const mode = process.argv[3];
const applying = mode === "apply";
const db = new Database(dbPath, {
	readonly: !applying,
	fileMustExist: true,
});

try {
	const events = db
		.prepare(
			`SELECT event_uid, payload
			   FROM workflow_run_event
			  WHERE kind = 'delivery_attempt_version_upgraded'
			  ORDER BY event_uid`,
		)
		.all();
	const selectAttempt = db.prepare(
		"SELECT contract_ref_json FROM workflow_delivery_attempt WHERE attempt_id = ?",
	);
	const seen = new Set();
	const eligible = [];
	const alreadyRestored = [];
	const drifted = [];
	const missing = [];
	const invalidEvents = [];

	for (const event of events) {
		let payload;
		try {
			payload = JSON.parse(String(event.payload));
		} catch {
			invalidEvents.push(String(event.event_uid));
			continue;
		}
		const attemptId = payload?.attemptId;
		const before = payload?.before;
		const after = payload?.after;
		if (
			typeof attemptId !== "string" ||
			attemptId.length === 0 ||
			typeof before !== "string" ||
			typeof after !== "string" ||
			seen.has(attemptId)
		) {
			invalidEvents.push(String(event.event_uid));
			continue;
		}
		seen.add(attemptId);
		const row = selectAttempt.get(attemptId);
		if (!row) {
			missing.push(attemptId);
		} else if (row.contract_ref_json === before) {
			alreadyRestored.push(attemptId);
		} else if (row.contract_ref_json === after) {
			eligible.push({ attemptId, before, after });
		} else {
			drifted.push(attemptId);
		}
	}

	console.log(
		`mode=${mode} eligible=${eligible.length} already_restored=${alreadyRestored.length} drifted=${drifted.length} missing=${missing.length} invalid_events=${invalidEvents.length}`,
	);
	for (const attemptId of drifted) console.error(`DRIFTED attempt_id=${attemptId}`);
	for (const attemptId of missing) console.error(`MISSING attempt_id=${attemptId}`);
	for (const eventUid of invalidEvents) console.error(`INVALID event_uid=${eventUid}`);

	if (drifted.length || missing.length || invalidEvents.length) {
		process.exitCode = 2;
	} else if (applying) {
		const restore = db.prepare(
			`UPDATE workflow_delivery_attempt
			    SET contract_ref_json = ?
			  WHERE attempt_id = ? AND contract_ref_json = ?`,
		);
		const applyAll = db.transaction(() => {
			for (const candidate of eligible) {
				const result = restore.run(
					candidate.before,
					candidate.attemptId,
					candidate.after,
				);
				if (result.changes !== 1) {
					throw new Error(`rollback_fence_changed:${candidate.attemptId}`);
				}
			}
		});
		applyAll();
		console.log(`applied=${eligible.length}`);
	}
} finally {
	db.close();
}
NODE
