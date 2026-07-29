import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { CutoverTargetManifest } from "../manifest.js";
import { buildMigrationPlan, readLegacySourceSnapshot } from "../migration.js";
import { runCutover } from "../run.js";

// QA regression suite for the two defects the FLY-1502 real-data rehearsal found
// on production copies. Both are written as the *invariant the plan promises*, so
// they fail against the shipped behaviour and pass once the contract holds.

const NOW = "2026-07-29T10:00:00.000Z";
const roots: string[] = [];

function tempRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

/**
 * Minimal but schema-faithful legacy comm database: `messages` + `lead_inbox` +
 * `sessions`, matching the columns readLegacySourceSnapshot selects.
 */
function writeLegacyCommDb(
	path: string,
	options: { withSessionForLead?: string } = {},
): void {
	const db = new Database(path);
	db.exec(`
		CREATE TABLE messages(
			id TEXT PRIMARY KEY, from_agent TEXT, to_agent TEXT, type TEXT,
			content TEXT, read_at TEXT, relay_state TEXT, created_at TEXT,
			expires_at TEXT, logical_event_id TEXT);
		CREATE TABLE lead_inbox(
			id TEXT PRIMARY KEY, to_lead TEXT, source TEXT, type TEXT,
			msg_class TEXT, content TEXT, ref_message_id TEXT, created_at TEXT,
			deadline_at TEXT, carrier TEXT, disposition TEXT, delivered_at TEXT,
			consumed_at TEXT, processed_at TEXT, disposed_at TEXT,
			receipt_exempt_reason TEXT);
		CREATE TABLE sessions(execution_id TEXT PRIMARY KEY, lead_id TEXT, status TEXT);
	`);
	// An unread, unexpired, business-class message addressed to a Lead that is
	// alive right now but has never spawned a Runner in this database.
	db.prepare(
		`INSERT INTO messages(id,from_agent,to_agent,type,content,read_at,
		                      relay_state,created_at,expires_at,logical_event_id)
		 VALUES ('m-live','founder','sub-lead','question','需要你回一下',NULL,
		         'open','2026-07-29T09:00:00.000Z','2026-09-01T00:00:00.000Z',NULL)`,
	).run();
	// The same shape on the lead_inbox side (msg_class='model', unconsumed).
	db.prepare(
		`INSERT INTO lead_inbox(id,to_lead,source,type,msg_class,content,
		                        ref_message_id,created_at,deadline_at,carrier,
		                        disposition,delivered_at,consumed_at,processed_at,
		                        disposed_at,receipt_exempt_reason)
		 VALUES ('i-live','sub-lead','discord','instruction','model','founder ping',
		         'discord-1','2026-07-29T09:00:00.000Z',NULL,'inbox',
		         NULL,NULL,NULL,NULL,NULL,NULL)`,
	).run();
	if (options.withSessionForLead) {
		db.prepare(
			"INSERT INTO sessions(execution_id,lead_id,status) VALUES ('exec-1',?,'running')",
		).run(options.withSessionForLead);
	}
	db.close();
}

describe("FLY-1502 QA — live Lead recognition (plan §4.4 rows 6/10)", () => {
	it("keeps a Lead's unread business rows out of the dead letter when the snapshot has a running session for it", () => {
		// Control: with a running session row the migrator recognises the Lead.
		const root = tempRoot("fly1502-live-lead-control-");
		const dbPath = join(root, "comm.db");
		writeLegacyCommDb(dbPath, { withSessionForLead: "sub-lead" });

		const snapshot = readLegacySourceSnapshot({
			commDatabases: [dbPath],
			jsonInboxRoots: [],
			journalDatabases: [],
		});
		const plan = buildMigrationPlan({ nowIso: NOW, epoch: 1, ...snapshot });

		expect(plan.decisions.map((d) => d.disposition)).toEqual([
			"migrate",
			"migrate",
		]);
	});

	it("never silently dead-letters unread business rows for a recipient it has no evidence about", () => {
		// The real corpus: 13 of 16 Bridge-live Leads (sub-lead, mufasa-lead,
		// belle-lead, codex-infra-bot-lead, …) never appear in any comm.db
		// `sessions` row, because a Lead only lands there once it spawns a Runner.
		// `readLegacySourceSnapshot` derives agent liveness *solely* from
		// `sessions`, so those Leads read as "missing or terminal".
		//
		// Absence of evidence is not evidence of termination: plan §4.4 row 1 sends
		// anything that cannot be classified to `manual` (which the manual=0 gate
		// then surfaces to the founder), and rows 6/10 send a surviving Lead's rows
		// to `migrate`. Dropping them to `dead` is silent data loss that
		// conservation still balances and Go/No-Go still reports as GO.
		const root = tempRoot("fly1502-live-lead-");
		const dbPath = join(root, "comm.db");
		writeLegacyCommDb(dbPath); // no sessions row for sub-lead

		const snapshot = readLegacySourceSnapshot({
			commDatabases: [dbPath],
			jsonInboxRoots: [],
			journalDatabases: [],
		});
		const plan = buildMigrationPlan({ nowIso: NOW, epoch: 1, ...snapshot });

		for (const decision of plan.decisions) {
			expect(
				["migrate", "manual"],
				`${decision.sourceType} row for a Lead with no session evidence was classified "${decision.disposition}" (${decision.reason})`,
			).toContain(decision.disposition);
		}
	});
});

function cutoverManifest(root: string): CutoverTargetManifest {
	const state = join(root, "state");
	const legacy = join(root, "legacy");
	const evidence = join(root, "evidence");
	mkdirSync(state, { recursive: true, mode: 0o700 });
	mkdirSync(legacy, { recursive: true, mode: 0o700 });
	mkdirSync(evidence, { recursive: true, mode: 0o700 });
	const tombstone = join(legacy, "writer.sh");
	writeFileSync(tombstone, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	const github = join(evidence, "github-lane.json");
	writeFileSync(github, '{"status":"pass"}\n', { mode: 0o600 });
	return {
		v: 1,
		mode: "rehearsal",
		windowId: "fly1502-qa-reentry",
		epoch: 15021,
		homeRoot: join(root, "home"),
		productionHomeRoot: join(tmpdir(), "fly1502-qa-absent-production"),
		ledgerDir: join(root, "ledger"),
		evidenceDir: evidence,
		rehearsalEvidencePath: join(evidence, "rehearsal-pass.json"),
		database: {
			finalPath: join(state, "flywheel-v2.db"),
			markerPath: join(state, "migration-complete.json"),
			authorityPath: join(state, "authority.json"),
			armedPath: join(state, "armed.json"),
			rollbackReceiptPath: join(state, "rollback.json"),
		},
		legacy: {
			authoritativeLiveLeadIds: [],
			commDatabases: [],
			jsonInboxRoots: [],
			journalDatabases: [],
			tombstonePaths: [tombstone],
			writerProcessPatterns: [],
			launchdLabels: [],
			plistPaths: [],
			stopCommands: [{ apply: ["/usr/bin/true"], verify: ["/usr/bin/true"] }],
			credentialProbeCommands: [["/bin/sh", "-c", "echo EACCES >&2; exit 77"]],
			liveFireCommands: [["/bin/sh", "-c", "echo EACCES >&2; exit 1"]],
			rollbackCommands: [
				{ apply: ["/usr/bin/true"], verify: ["/usr/bin/true"] },
			],
		},
		controlPlane: {
			launchdLabelPrefix: "com.flywheel-rehearsal.",
			plistDirectory: join(root, "launchd"),
			tmuxSocket: join(root, "tmux.sock"),
			cmuxTarget: "rehearsal-fly1502-qa",
			wrapperPaths: [],
			credentialPaths: [],
			envKeys: [],
			startCommands: {
				host: { apply: ["/usr/bin/true"], verify: ["/usr/bin/true"] },
				bridge: { apply: ["/usr/bin/true"], verify: ["/usr/bin/true"] },
				scheduler: { apply: ["/usr/bin/true"], verify: ["/usr/bin/true"] },
				leads: [],
			},
		},
		founderConfirmations: { heldStart: "held", finalGo: "go" },
		githubLaneEvidencePath: github,
	};
}

describe("FLY-1502 QA — step 5 re-entry across the promotion marker (plan §4.3)", () => {
	it("resumes when the process died after promotion but before the ledger recorded step 5 done", async () => {
		// Observed on the real rehearsal: SIGKILL inside step 5 landed after
		// promoteStagingDatabase renamed staging onto the final path *and*
		// published the migration-complete marker, but before
		// `ledger.step(5,"done")` was appended. Every later resume re-entered
		// step 5, opened the now-absent staging path (SQLite silently created an
		// empty database) and died with a raw `no such table: meta`. The window
		// wedges with all Leads down; prepareStagingDatabase already models this
		// state as `already_promoted`, but step 5 never consults it.
		const root = tempRoot("fly1502-reentry-");
		const target = cutoverManifest(root);

		for (const step of [1, 2, 3, 4, 5]) {
			await runCutover(target, { step, yes: true, now: () => new Date(NOW) });
		}

		const ledgerPath = join(target.ledgerDir, "ledger.jsonl");
		const lines = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
		const lastIsStep5Done = JSON.parse(lines[lines.length - 1] as string);
		expect(lastIsStep5Done.payload).toMatchObject({
			kind: "step",
			step: 5,
			status: "done",
		});

		// Drop only that trailing append — exactly what a SIGKILL between the
		// promotion and the ledger write leaves behind.
		writeFileSync(ledgerPath, "", { mode: 0o600 });
		appendFileSync(ledgerPath, `${lines.slice(0, -1).join("\n")}\n`);

		await expect(
			runCutover(target, { step: 5, yes: true, now: () => new Date(NOW) }),
		).resolves.toMatchObject({ completedSteps: [5] });
	});
});
