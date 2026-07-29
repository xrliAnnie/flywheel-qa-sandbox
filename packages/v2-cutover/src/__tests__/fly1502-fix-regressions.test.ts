import { spawnSync } from "node:child_process";
import {
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
import { adjudicateManual } from "../manual-adjudication.js";
import { runCutover } from "../run.js";

const NOW = "2026-07-29T10:00:00.000Z";
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function makeRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

function writeUnknownLeadRows(path: string): void {
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
		INSERT INTO messages VALUES(
			'm-live','founder','sub-lead','question','需要你回一下',NULL,'open',
			'2026-07-29T09:00:00.000Z','2026-09-01T00:00:00.000Z',NULL);
		INSERT INTO lead_inbox VALUES(
			'i-live','sub-lead','bridge','instruction','model','founder ping',
			NULL,'2026-07-29T09:00:00.000Z',NULL,'inbox',
			NULL,NULL,NULL,NULL,NULL,NULL);
	`);
	db.close();
}

function writeRunnerRegistry(path: string, executionId: string): void {
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
		 VALUES (?,'completed','implement')`,
	).run(executionId);
	db.close();
}

function target(
	root: string,
	commDatabase: string,
	authoritativeLiveLeadIds: string[],
	runnerSessionDatabase?: string,
): CutoverTargetManifest {
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
		windowId: "fly1502-fix-regression",
		epoch: 15021,
		homeRoot: join(root, "home"),
		productionHomeRoot: join(
			tmpdir(),
			"fly1502-fix-regression-absent-production",
		),
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
			authoritativeLiveLeadIds,
			...(runnerSessionDatabase ? { runnerSessionDatabase } : {}),
			commDatabases: [commDatabase],
			jsonInboxRoots: [],
			journalDatabases: [],
			tombstonePaths: [
				tombstone,
				commDatabase,
				...(runnerSessionDatabase ? [runnerSessionDatabase] : []),
			],
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
			cmuxTarget: "rehearsal-fly1502-fix",
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

describe("FLY-1502 implementation regressions outside the frozen QA suite", () => {
	it("keeps step 5 NO-GO until every manual row has an explicit adjudication", async () => {
		const root = makeRoot("fly1502-manual-adjudication-");
		const dbPath = join(root, "comm.db");
		writeUnknownLeadRows(dbPath);
		const manifest = target(root, dbPath, []);

		for (const step of [1, 2, 3, 4]) {
			await runCutover(manifest, {
				step,
				yes: true,
				now: () => new Date(NOW),
			});
		}
		await expect(
			runCutover(manifest, {
				step: 5,
				yes: true,
				now: () => new Date(NOW),
			}),
		).rejects.toThrow(/manual.*2/);

		const planPath = join(manifest.evidenceDir, "migration-plan.json");
		const initial = JSON.parse(readFileSync(planPath, "utf8")) as {
			decisions: Array<{
				sourceKind: "discord" | "legacy-comm" | "legacy-json";
				sourceId: string;
				payloadDigest: string;
				disposition: string;
			}>;
		};
		const [first, second] = initial.decisions;
		expect(first?.disposition).toBe("manual");
		expect(second?.disposition).toBe("manual");

		const firstAdjudication = {
			sourceKind: first?.sourceKind as "legacy-comm",
			sourceId: first?.sourceId as string,
			payloadDigest: first?.payloadDigest as string,
			disposition: "dead" as const,
			reason: "Founder verified this malformed recipient is terminal",
		};
		const targetPath = join(root, "target.json");
		writeFileSync(targetPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
		const cli = spawnSync(
			process.execPath,
			[
				join(process.cwd(), "dist", "cli.js"),
				"adjudicate-manual",
				"--target",
				targetPath,
				"--source-kind",
				firstAdjudication.sourceKind,
				"--source-id",
				firstAdjudication.sourceId,
				"--payload-digest",
				firstAdjudication.payloadDigest,
				"--disposition",
				firstAdjudication.disposition,
				"--reason",
				firstAdjudication.reason,
			],
			{ encoding: "utf8" },
		);
		expect(cli.status, cli.stderr).toBe(0);
		expect(JSON.parse(cli.stdout)).toMatchObject({
			status: "manual_adjudicated",
			adjudication: firstAdjudication,
		});
		await expect(
			runCutover(manifest, {
				step: 5,
				yes: true,
				now: () => new Date(NOW),
			}),
		).rejects.toThrow(/manual.*1/);
		expect(() => adjudicateManual(manifest, firstAdjudication)).not.toThrow();
		expect(() =>
			adjudicateManual(manifest, {
				...firstAdjudication,
				reason: "A different unsupported reason",
			}),
		).toThrow(/conflict/i);

		adjudicateManual(manifest, {
			sourceKind: second?.sourceKind as "legacy-comm",
			sourceId: second?.sourceId as string,
			payloadDigest: second?.payloadDigest as string,
			disposition: "dead",
			reason: "Founder verified this malformed recipient is terminal",
		});
		await expect(
			runCutover(manifest, {
				step: 5,
				yes: true,
				now: () => new Date(NOW),
			}),
		).resolves.toMatchObject({ completedSteps: [5] });

		const resolved = JSON.parse(readFileSync(planPath, "utf8")) as {
			go: boolean;
			manualAdjudications: unknown[];
			conservation: { dead: number; manual: number };
		};
		expect(resolved).toMatchObject({
			go: true,
			conservation: { dead: 2, manual: 0 },
		});
		expect(resolved.manualAdjudications).toHaveLength(2);
	});

	it("carries the authoritative Runner registry through snapshot and migration", async () => {
		const root = makeRoot("fly1502-authoritative-runners-");
		const dbPath = join(root, "comm.db");
		const registryPath = join(root, "teamlead.db");
		writeUnknownLeadRows(dbPath);
		writeRunnerRegistry(registryPath, "sub-lead");
		const manifest = target(root, dbPath, [], registryPath);

		for (const step of [1, 2, 3, 4, 5]) {
			await runCutover(manifest, {
				step,
				yes: true,
				now: () => new Date(NOW),
			});
		}

		const snapshotEvidence = JSON.parse(
			readFileSync(join(manifest.evidenceDir, "step-4.json"), "utf8"),
		) as { sqliteCount: number };
		const plan = JSON.parse(
			readFileSync(join(manifest.evidenceDir, "migration-plan.json"), "utf8"),
		) as {
			conservation: { manual: number };
			decisions: Array<{ disposition: string }>;
		};
		expect(snapshotEvidence.sqliteCount).toBe(2);
		expect(plan.conservation.manual).toBe(0);
		expect(plan.decisions.map((row) => row.disposition)).toEqual([
			"dead",
			"dead",
		]);
	});

	it("carries the manifest's authoritative Lead set through step 5", async () => {
		const root = makeRoot("fly1502-authoritative-leads-");
		const dbPath = join(root, "comm.db");
		writeUnknownLeadRows(dbPath);
		const manifest = target(root, dbPath, ["sub-lead"]);

		for (const step of [1, 2, 3, 4, 5]) {
			await runCutover(manifest, {
				step,
				yes: true,
				now: () => new Date(NOW),
			});
		}

		const plan = JSON.parse(
			readFileSync(join(manifest.evidenceDir, "migration-plan.json"), "utf8"),
		) as {
			leadLiveness: { authoritativeLiveLeadIds: string[] };
			decisions: Array<{ disposition: string }>;
		};
		expect(plan.leadLiveness.authoritativeLiveLeadIds).toEqual(["sub-lead"]);
		expect(plan.decisions.map((row) => row.disposition)).toEqual([
			"migrate",
			"migrate",
		]);
	});

	it("prints liveness and domain-B evidence when step 5 is NO-GO", async () => {
		const root = makeRoot("fly1502-no-go-diagnostics-");
		const dbPath = join(root, "comm.db");
		writeUnknownLeadRows(dbPath);
		const manifest = target(root, dbPath, []);

		for (const step of [1, 2, 3, 4]) {
			await runCutover(manifest, {
				step,
				yes: true,
				now: () => new Date(NOW),
			});
		}

		await expect(
			runCutover(manifest, {
				step: 5,
				yes: true,
				now: () => new Date(NOW),
			}),
		).rejects.toThrow(
			/leadLiveness.*unknownRecipientIds.*sub-lead.*runnerLiveness.*authoritativeDatabase.*domains.*deliveryObligations/s,
		);
	});
});
