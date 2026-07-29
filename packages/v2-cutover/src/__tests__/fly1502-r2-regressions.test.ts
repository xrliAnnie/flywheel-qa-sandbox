import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CutoverLedger } from "../ledger.js";
import type { CutoverTargetManifest } from "../manifest.js";
import { adjudicateManual } from "../manual-adjudication.js";
import { buildMigrationPlan, readLegacySourceSnapshot } from "../migration.js";

const NOW = "2026-07-29T12:00:00.000Z";
const roots: string[] = [];

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "fly1502-r2-"));
	roots.push(root);
	return root;
}

function writeCommDatabase(path: string, recipient = "runner-terminal"): void {
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
		CREATE TABLE sessions(
			execution_id TEXT PRIMARY KEY, lead_id TEXT, status TEXT);
	`);
	db.prepare(
		`INSERT INTO messages(
		   id,from_agent,to_agent,type,content,read_at,relay_state,
		   created_at,expires_at,logical_event_id
		 ) VALUES (
		   'runner-message','lead-a',?,'question','old work',
		   NULL,'open','2026-07-29T11:00:00.000Z',
		   '2026-08-29T11:00:00.000Z',NULL
		 )`,
	).run(recipient);
	db.close();
}

function writeRunnerRegistry(
	path: string,
	executionId = "runner-terminal",
	status = "completed",
	sessionRole = "implement",
): void {
	const db = new Database(path);
	db.exec(`
		CREATE TABLE sessions(
			execution_id TEXT PRIMARY KEY,
			status TEXT NOT NULL,
			session_role TEXT NOT NULL
		);
	`);
	db.prepare(
		`INSERT INTO sessions(execution_id,status,session_role)
		 VALUES (?,?,?)`,
	).run(executionId, status, sessionRole);
	db.close();
}

function writeCommSession(
	path: string,
	executionId: string,
	status: string,
): void {
	const db = new Database(path);
	db.prepare(
		`INSERT INTO sessions(execution_id,lead_id,status)
		 VALUES (?,NULL,?)`,
	).run(executionId, status);
	db.close();
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("FLY-1502 R2 Runner liveness evidence", () => {
	it("classifies a terminal Runner from the authoritative teamlead registry without requiring lead_id", () => {
		const root = temporaryRoot();
		const commPath = join(root, "comm.db");
		const registryPath = join(root, "teamlead.db");
		writeCommDatabase(commPath);
		writeRunnerRegistry(registryPath);

		const snapshot = readLegacySourceSnapshot({
			commDatabases: [commPath],
			runnerSessionDatabase: registryPath,
			jsonInboxRoots: [],
			journalDatabases: [],
		});
		const plan = buildMigrationPlan({
			nowIso: NOW,
			epoch: 1,
			authoritativeLiveLeadIds: [],
			...snapshot,
		});

		expect(plan.decisions).toEqual([
			expect.objectContaining({
				nativeId: "runner-message",
				disposition: "dead",
			}),
		]);
		expect(plan.conservation.manual).toBe(0);
		expect(plan.leadLiveness.unknownRecipientIds).toEqual([]);
		expect(plan.runnerLiveness).toEqual({
			authoritativeDatabase: registryPath,
			liveSessionIds: [],
			terminalSessionIds: ["runner-terminal"],
			ignoredStatusCounts: {},
		});
	});

	it("keeps a parked Runner manual because only a live Lead may migrate", () => {
		const root = temporaryRoot();
		const commPath = join(root, "comm.db");
		const registryPath = join(root, "teamlead.db");
		writeCommDatabase(commPath, "runner-parked");
		writeRunnerRegistry(registryPath, "runner-parked", "awaiting_review");

		const snapshot = readLegacySourceSnapshot({
			commDatabases: [commPath],
			runnerSessionDatabase: registryPath,
			jsonInboxRoots: [],
			journalDatabases: [],
		});
		const plan = buildMigrationPlan({
			nowIso: NOW,
			epoch: 1,
			authoritativeLiveLeadIds: [],
			...snapshot,
		});

		expect(plan.decisions[0]).toMatchObject({
			nativeId: "runner-message",
			disposition: "manual",
		});
		expect(plan.runnerLiveness.liveSessionIds).toEqual(["runner-parked"]);
	});

	it("lets the authoritative registry override stale comm Runner state", () => {
		const root = temporaryRoot();
		const commPath = join(root, "comm.db");
		const registryPath = join(root, "teamlead.db");
		writeCommDatabase(commPath, "runner-stale");
		writeCommSession(commPath, "runner-stale", "running");
		writeRunnerRegistry(registryPath, "runner-stale", "completed");

		const snapshot = readLegacySourceSnapshot({
			commDatabases: [commPath],
			runnerSessionDatabase: registryPath,
			jsonInboxRoots: [],
			journalDatabases: [],
		});
		const plan = buildMigrationPlan({
			nowIso: NOW,
			epoch: 1,
			authoritativeLiveLeadIds: [],
			...snapshot,
		});

		expect(plan.decisions[0]).toMatchObject({
			nativeId: "runner-message",
			disposition: "dead",
		});
	});

	it("removes stale comm evidence when the authoritative status is unknown", () => {
		const root = temporaryRoot();
		const commPath = join(root, "comm.db");
		const registryPath = join(root, "teamlead.db");
		writeCommDatabase(commPath, "runner-future");
		writeCommSession(commPath, "runner-future", "completed");
		writeRunnerRegistry(registryPath, "runner-future", "future_state");

		const snapshot = readLegacySourceSnapshot({
			commDatabases: [commPath],
			runnerSessionDatabase: registryPath,
			jsonInboxRoots: [],
			journalDatabases: [],
		});
		const plan = buildMigrationPlan({
			nowIso: NOW,
			epoch: 1,
			authoritativeLiveLeadIds: [],
			...snapshot,
		});

		expect(plan.decisions[0]).toMatchObject({
			nativeId: "runner-message",
			disposition: "manual",
		});
	});

	it("treats a Runner absent from the authoritative registry as unknown", () => {
		const root = temporaryRoot();
		const commPath = join(root, "comm.db");
		const registryPath = join(root, "teamlead.db");
		writeCommDatabase(commPath, "runner-absent");
		writeCommSession(commPath, "runner-absent", "completed");
		writeRunnerRegistry(registryPath, "different-runner", "completed");

		const snapshot = readLegacySourceSnapshot({
			commDatabases: [commPath],
			runnerSessionDatabase: registryPath,
			jsonInboxRoots: [],
			journalDatabases: [],
		});
		const plan = buildMigrationPlan({
			nowIso: NOW,
			epoch: 1,
			authoritativeLiveLeadIds: [],
			...snapshot,
		});

		expect(plan.decisions[0]).toMatchObject({
			nativeId: "runner-message",
			disposition: "manual",
		});
	});

	it("rejects malformed authoritative Runner row values", () => {
		const root = temporaryRoot();
		const commPath = join(root, "comm.db");
		const registryPath = join(root, "teamlead.db");
		writeCommDatabase(commPath);
		writeRunnerRegistry(registryPath, "", "completed", "implement");

		expect(() =>
			readLegacySourceSnapshot({
				commDatabases: [commPath],
				runnerSessionDatabase: registryPath,
				jsonInboxRoots: [],
				journalDatabases: [],
			}),
		).toThrow(/execution_id.*non-empty/i);
	});

	it("keeps an unrecognized registry status in the manual gate", () => {
		const root = temporaryRoot();
		const commPath = join(root, "comm.db");
		const registryPath = join(root, "teamlead.db");
		writeCommDatabase(commPath, "runner-future");
		writeRunnerRegistry(registryPath, "runner-future", "future_state");

		const snapshot = readLegacySourceSnapshot({
			commDatabases: [commPath],
			runnerSessionDatabase: registryPath,
			jsonInboxRoots: [],
			journalDatabases: [],
		});
		const plan = buildMigrationPlan({
			nowIso: NOW,
			epoch: 1,
			authoritativeLiveLeadIds: [],
			...snapshot,
		});

		expect(plan.decisions[0]).toMatchObject({
			nativeId: "runner-message",
			disposition: "manual",
		});
		expect(plan.runnerLiveness.ignoredStatusCounts).toEqual({
			future_state: 1,
		});
	});

	it("keeps the legacy ambiguous approved status in the manual gate", () => {
		const root = temporaryRoot();
		const commPath = join(root, "comm.db");
		const registryPath = join(root, "teamlead.db");
		writeCommDatabase(commPath, "runner-approved");
		writeRunnerRegistry(registryPath, "runner-approved", "approved");

		const snapshot = readLegacySourceSnapshot({
			commDatabases: [commPath],
			runnerSessionDatabase: registryPath,
			jsonInboxRoots: [],
			journalDatabases: [],
		});
		const plan = buildMigrationPlan({
			nowIso: NOW,
			epoch: 1,
			authoritativeLiveLeadIds: [],
			...snapshot,
		});

		expect(plan.decisions[0]).toMatchObject({
			nativeId: "runner-message",
			disposition: "manual",
		});
		expect(plan.runnerLiveness.ignoredStatusCounts).toEqual({
			approved: 1,
		});
	});
});

describe("FLY-1502 R2 manual adjudication", () => {
	it("records one exact manual row and its reason in the step-5 hash-chain ledger", () => {
		const root = temporaryRoot();
		const commPath = join(root, "comm.db");
		writeCommDatabase(commPath, "truncated-runner");
		const snapshot = readLegacySourceSnapshot({
			commDatabases: [commPath],
			jsonInboxRoots: [],
			journalDatabases: [],
		});
		const plan = buildMigrationPlan({
			nowIso: NOW,
			epoch: 7,
			windowId: "window-r2",
			authoritativeLiveLeadIds: [],
			...snapshot,
		});
		const manual = plan.decisions[0];
		expect(manual?.disposition).toBe("manual");

		const evidenceDir = join(root, "evidence");
		mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
		writeFileSync(
			join(evidenceDir, "migration-plan.json"),
			`${JSON.stringify(plan)}\n`,
			{ mode: 0o600 },
		);
		const target = {
			windowId: "window-r2",
			epoch: 7,
			ledgerDir: join(root, "ledger"),
			evidenceDir,
		} as CutoverTargetManifest;

		expect(() =>
			adjudicateManual(target, {
				sourceKind: manual?.sourceKind as "legacy-comm",
				sourceId: manual?.sourceId as string,
				payloadDigest:
					"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
				disposition: "dead",
				reason: "Founder verified the truncated Runner ID is terminal",
			}),
		).toThrow(/payload digest mismatch/i);
		expect(new CutoverLedger(target.ledgerDir).manualAdjudications()).toEqual(
			[],
		);

		const recorded = adjudicateManual(target, {
			sourceKind: manual?.sourceKind as "legacy-comm",
			sourceId: manual?.sourceId as string,
			payloadDigest: manual?.payloadDigest as string,
			disposition: "dead",
			reason: "Founder verified the truncated Runner ID is terminal",
		});

		expect(new CutoverLedger(target.ledgerDir).manualAdjudications()).toEqual([
			recorded,
		]);
		expect(recorded).toMatchObject({
			v: 1,
			windowId: "window-r2",
			epoch: 7,
			sourceKind: manual?.sourceKind,
			sourceId: manual?.sourceId,
			payloadDigest: manual?.payloadDigest,
			disposition: "dead",
			reason: "Founder verified the truncated Runner ID is terminal",
			originalReason: manual?.reason,
		});
	});

	it("rejects a forged minimal migration plan before writing authority", () => {
		const root = temporaryRoot();
		const evidenceDir = join(root, "evidence");
		mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
		writeFileSync(
			join(evidenceDir, "migration-plan.json"),
			`${JSON.stringify({
				epoch: 7,
				decisions: [
					{
						sourceKind: "legacy-comm",
						sourceId: "project/row",
						payloadDigest:
							"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
						disposition: "manual",
						reason: "unknown",
					},
				],
			})}\n`,
			{ mode: 0o600 },
		);
		const target = {
			windowId: "window-r2",
			epoch: 7,
			ledgerDir: join(root, "ledger"),
			evidenceDir,
		} as CutoverTargetManifest;

		expect(() =>
			adjudicateManual(target, {
				sourceKind: "legacy-comm",
				sourceId: "project/row",
				payloadDigest:
					"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				disposition: "dead",
				reason: "Founder verified the row is terminal",
			}),
		).toThrow(/migration plan.*windowId/i);
		expect(new CutoverLedger(target.ledgerDir).manualAdjudications()).toEqual(
			[],
		);
	});
});
