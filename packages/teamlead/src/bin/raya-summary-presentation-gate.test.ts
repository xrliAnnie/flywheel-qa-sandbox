import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { runSummaryPresentationMigration } from "../bridge/summary-presentation-migration.js";
import { StateStore } from "../StateStore.js";
import { runRayaSummaryPresentationGate } from "./raya-summary-presentation-gate.js";

const SHA256_ZERO = "0".repeat(64);
const DEPLOYED_SHA = "a".repeat(40);

interface Fixture {
	root: string;
	dbPath: string;
	workspace: string;
	stateRoot: string;
	stateDir: string;
	rayaHome: string;
	deployedShaFile: string;
	toolFiles: { gate: string; migration: string };
}

function sha256(bytes: Buffer | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function canonicalValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, canonicalValue(entry)]),
		);
	}
	return value;
}

function canonicalDigest(value: unknown): string {
	return sha256(JSON.stringify(canonicalValue(value)));
}

function appendRound(
	store: StateStore,
	index: number,
	contractVersion?: 2,
): void {
	const slotStartMs = Date.UTC(2026, 8, 1, index * 6);
	const roundId = `summary-absorption:${new Date(slotStartMs).toISOString()}`;
	if (contractVersion === 2) {
		store.appendSummaryPresentationRounds([
			{
				leadId: "raya",
				eventId: roundId,
				projectName: "raya",
				slotStartMs,
				payload: JSON.stringify({
					event_type: "summary_absorption_round",
					execution_id: roundId,
					project_name: "raya",
					contract_version: 2,
				}),
			},
		]);
		return;
	}
	store.appendLeadEvent(
		"raya",
		roundId,
		"summary_absorption_round",
		JSON.stringify({
			event_type: "summary_absorption_round",
			execution_id: roundId,
			project_name: "raya",
		}),
		"summary-absorption",
	);
}

async function fixture(rounds = 3): Promise<Fixture> {
	const root = mkdtempSync(join(tmpdir(), "fly2697-gate-"));
	const workspace = join(root, "workspace");
	const stateRoot = join(root, "flywheel-state");
	const stateDir = join(stateRoot, "state/lead-persona/raya/raya");
	const rayaHome = join(root, "raya-home");
	const deployedShaFile = join(root, "deployed-sha");
	const dbPath = join(root, "teamlead.db");
	mkdirSync(join(workspace, "state"), { recursive: true });
	mkdirSync(join(workspace, ".lead/raya"), { recursive: true });
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	mkdirSync(rayaHome, { recursive: true, mode: 0o700 });
	writeFileSync(join(workspace, "state/summary-merge-receipts.jsonl"), "");
	writeFileSync(
		join(workspace, ".lead/raya/identity.md"),
		"# Raya test persona\n",
	);
	writeFileSync(deployedShaFile, `${DEPLOYED_SHA}\n`);
	const store = await StateStore.create(dbPath);
	try {
		for (let index = 0; index < rounds; index += 1) appendRound(store, index);
	} finally {
		store.close();
	}
	return {
		root,
		dbPath,
		workspace,
		stateRoot,
		stateDir,
		rayaHome,
		deployedShaFile,
		toolFiles: {
			gate: join(import.meta.dirname, "raya-summary-presentation-gate.ts"),
			migration: join(
				import.meta.dirname,
				"../bridge/summary-presentation-migration.ts",
			),
		},
	};
}

function sharedArgs(value: Fixture): string[] {
	return [
		"--db",
		value.dbPath,
		"--workspace",
		value.workspace,
		"--project",
		"raya",
		"--lead",
		"raya",
		"--state-root",
		value.stateRoot,
	];
}

function preflightArgs(value: Fixture): string[] {
	return [
		"preflight",
		...sharedArgs(value),
		"--deployed-sha-file",
		value.deployedShaFile,
		"--raya-home",
		value.rayaHome,
		"--window-id",
		"window-1",
		"--frozen-payload-digest",
		SHA256_ZERO,
	];
}

function executeArgs(
	value: Fixture,
	authorizedPayloadDigest: string,
): string[] {
	return [
		"execute",
		...sharedArgs(value),
		"--deployed-sha-file",
		value.deployedShaFile,
		"--raya-home",
		value.rayaHome,
		"--window-id",
		"window-1",
		"--frozen-payload-digest",
		SHA256_ZERO,
		"--authorization-channel-id",
		"1542079099928059987",
		"--authorization-message-id",
		"1542079099928059988",
		"--authorization-author-id",
		"1542079099928059989",
		"--authorization-content-sha256",
		"b".repeat(64),
		"--expect-preflight",
		authorizedPayloadDigest,
	];
}

function snapshot(paths: string[]): Record<string, unknown> {
	return Object.fromEntries(
		paths.map((path) => {
			if (!existsSync(path)) return [path, null];
			const stat = lstatSync(path);
			const bytes = readFileSync(path);
			return [
				path,
				{
					size: stat.size,
					...(path.endsWith("-shm") ? {} : { mtimeMs: stat.mtimeMs }),
					mode: stat.mode & 0o777,
					digest: sha256(bytes),
				},
			];
		}),
	);
}

function warmReadonlySidecars(dbPath: string): void {
	const db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
	try {
		db.prepare("SELECT 1").get();
	} finally {
		db.close();
	}
}

function gateDependencies(value: Fixture) {
	return {
		toolFiles: value.toolFiles,
		now: () => 1_800_000_000_000,
		io: {
			fetch: globalThis.fetch,
			now: () => 1_800_000_000_000,
			run: async () => "Tue Sep 17 19:00:00 2026",
		},
	};
}

async function preflightAndExecute(
	value: Fixture,
	dependencies = gateDependencies(value),
) {
	const preflight = await runRayaSummaryPresentationGate(
		preflightArgs(value),
		dependencies,
	);
	expect(preflight.exitCode).toBe(0);
	const authorizedPayloadDigest = String(
		preflight.output.authorizedPayloadDigest,
	);
	const execute = await runRayaSummaryPresentationGate(
		executeArgs(value, authorizedPayloadDigest),
		dependencies,
	);
	return { preflight, execute, authorizedPayloadDigest };
}

describe("FLY-2697 Raya summary presentation migration gate", () => {
	const cleanups: string[] = [];
	afterEach(() => {
		for (const root of cleanups.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("preflights, resumes a bounded migration, writes an auditable receipt, and then stays read-only", async () => {
		const value = await fixture(3);
		cleanups.push(value.root);
		const dependencies = gateDependencies(value);
		const preflight = await runRayaSummaryPresentationGate(
			preflightArgs(value),
			dependencies,
		);
		expect(preflight).toMatchObject({
			exitCode: 0,
			output: {
				status: "preflight",
				existingState: "missing",
				completedAtMsPresent: false,
			},
		});
		const authorizedPayloadDigest = String(
			preflight.output.authorizedPayloadDigest,
		);
		expect(authorizedPayloadDigest).toMatch(/^[0-9a-f]{64}$/u);
		expect(preflight.output.issuer).toMatchObject({
			toolBlobSha256: sha256(readFileSync(value.toolFiles.gate)),
		});
		expect(preflight.output.migrationModuleSha256).toBe(
			sha256(readFileSync(value.toolFiles.migration)),
		);

		const partial = await runRayaSummaryPresentationGate(
			[...executeArgs(value, authorizedPayloadDigest), "--max-rows", "1"],
			dependencies,
		);
		expect(partial).toMatchObject({
			exitCode: 2,
			output: { status: "migration_building" },
		});

		const completed = await runRayaSummaryPresentationGate(
			executeArgs(value, authorizedPayloadDigest),
			dependencies,
		);
		expect(completed).toMatchObject({
			exitCode: 0,
			output: { status: "complete", mode: "executed" },
		});

		const receiptPath = join(value.stateDir, "m0-receipt.json");
		const evidencePath = join(value.stateDir, "m0-dispositions.jsonl");
		const executionPath = join(value.stateDir, "m0-execution.json");
		const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<
			string,
			unknown
		>;
		expect(Object.keys(receipt).sort()).toEqual(
			[
				"schemaVersion",
				"kind",
				"mode",
				"receiptId",
				"windowId",
				"projectName",
				"leadId",
				"database",
				"workspaceCanonicalPath",
				"workspaceIdentityDigest",
				"summaryContractVersion",
				"state",
				"migration_boundary_seq",
				"cursor_seq",
				"sourceDigests",
				"dispositions",
				"verifiedRowCount",
				"dispositionDigest",
				"issuer",
				"executionAuthorization",
				"completedAt",
				"generatedAt",
			].sort(),
		);
		expect(receipt).toMatchObject({
			schemaVersion: 1,
			kind: "raya-summary-presentation-m0",
			mode: "executed",
			projectName: "raya",
			leadId: "raya",
			state: "complete",
			migration_boundary_seq: 3,
			cursor_seq: 3,
			verifiedRowCount: 3,
			dispositions: { needs_reconciliation: 3, claimed: 0 },
			issuer: {
				kind: "flywheel-m0-wrapper",
				toolBlobSha256: sha256(readFileSync(value.toolFiles.gate)),
				deployedSha: DEPLOYED_SHA,
			},
			executionAuthorization: {
				channelId: "1542079099928059987",
				messageId: "1542079099928059988",
				authorId: "1542079099928059989",
				contentSha256: "b".repeat(64),
				authorizedPayloadDigest,
			},
		});
		const frozenRows = readFileSync(evidencePath, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as unknown);
		expect(receipt.dispositionDigest).toBe(canonicalDigest(frozenRows));
		const {
			receiptId: _receiptId,
			generatedAt: _generatedAt,
			...receiptIdentity
		} = receipt;
		expect(receipt.receiptId).toBe(canonicalDigest(receiptIdentity));
		for (const path of [receiptPath, evidencePath, executionPath]) {
			expect(lstatSync(path).mode & 0o777).toBe(0o600);
		}

		const verify = await runRayaSummaryPresentationGate(
			["verify", ...sharedArgs(value)],
			dependencies,
		);
		expect(verify).toMatchObject({
			exitCode: 0,
			output: { status: "unchanged", receiptId: receipt.receiptId },
		});

		const watched = [
			value.dbPath,
			`${value.dbPath}-wal`,
			`${value.dbPath}-shm`,
			receiptPath,
			evidencePath,
			executionPath,
		];
		const before = snapshot(watched);
		const replay = await runRayaSummaryPresentationGate(
			executeArgs(value, authorizedPayloadDigest),
			dependencies,
		);
		expect(replay).toMatchObject({
			exitCode: 0,
			output: { status: "unchanged", receiptId: receipt.receiptId },
		});
		expect(snapshot(watched)).toEqual(before);
		const verifyReplay = await runRayaSummaryPresentationGate(
			["verify", ...sharedArgs(value)],
			dependencies,
		);
		expect(verifyReplay).toMatchObject({
			exitCode: 0,
			output: { status: "unchanged", receiptId: receipt.receiptId },
		});
		expect(snapshot(watched)).toEqual(before);

		const dbAndWal = [value.dbPath, `${value.dbPath}-wal`];
		const beforePositiveControl = snapshot(dbAndWal);
		const writer = new BetterSqlite3(value.dbPath);
		try {
			writer
				.prepare(
					"UPDATE summary_presentation_migration SET updated_at_ms = updated_at_ms + 1 WHERE project_name = 'raya' AND lead_id = 'raya'",
				)
				.run();
			expect(snapshot(dbAndWal)).not.toEqual(beforePositiveControl);
		} finally {
			writer.close();
		}
	});

	it("certifies a v2 journal round without a pre-admitted eligible row", async () => {
		const value = await fixture(0);
		cleanups.push(value.root);
		const store = await StateStore.create(value.dbPath);
		try {
			const slotStartMs = Date.UTC(2026, 8, 1, 0);
			const roundId = `summary-absorption:${new Date(slotStartMs).toISOString()}`;
			store.appendLeadEvent(
				"raya",
				roundId,
				"summary_absorption_round",
				JSON.stringify({
					event_type: "summary_absorption_round",
					execution_id: roundId,
					project_name: "raya",
					contract_version: 2,
				}),
				"summary-absorption",
			);
		} finally {
			store.close();
		}

		const dependencies = gateDependencies(value);
		const { execute } = await preflightAndExecute(value, dependencies);
		expect(execute).toMatchObject({
			exitCode: 0,
			output: { status: "complete", mode: "executed" },
		});
		const receipt = JSON.parse(
			readFileSync(join(value.stateDir, "m0-receipt.json"), "utf8"),
		) as Record<string, unknown>;
		expect(receipt.dispositions).toEqual({
			claimed: 0,
			eligible: 0,
			historical_presented: 0,
			historical_silent: 0,
			needs_reconciliation: 1,
		});

		const verify = await runRayaSummaryPresentationGate(
			["verify", ...sharedArgs(value)],
			dependencies,
		);
		expect(verify).toMatchObject({
			exitCode: 0,
			output: { status: "unchanged", receiptId: receipt.receiptId },
		});
	});

	it("certifies decision evidence that makes a fallback v2 round eligible", async () => {
		const value = await fixture(0);
		cleanups.push(value.root);
		const slotStartMs = Date.UTC(2026, 8, 1, 0);
		const roundId = `summary-absorption:${new Date(slotStartMs).toISOString()}`;
		const store = await StateStore.create(value.dbPath);
		try {
			store.appendLeadEvent(
				"raya",
				roundId,
				"summary_absorption_round",
				JSON.stringify({
					event_type: "summary_absorption_round",
					execution_id: roundId,
					project_name: "raya",
					contract_version: 2,
				}),
				"summary-absorption",
			);
		} finally {
			store.close();
		}
		const evidenceRef = "manual-decision:annie-2026-09-18";
		writeFileSync(
			join(
				value.workspace,
				"state/summary-presentation-migration-decisions.jsonl",
			),
			`${JSON.stringify({
				roundId,
				disposition: "eligible",
				operator: "migration-test",
				reason: "verified unprocessed with no send attempt",
				evidenceRef,
			})}\n`,
		);

		const dependencies = gateDependencies(value);
		const { execute } = await preflightAndExecute(value, dependencies);
		expect(execute).toMatchObject({
			exitCode: 0,
			output: { status: "complete", mode: "executed" },
		});
		const receipt = JSON.parse(
			readFileSync(join(value.stateDir, "m0-receipt.json"), "utf8"),
		) as Record<string, unknown>;
		expect(receipt.dispositions).toEqual({
			claimed: 0,
			eligible: 1,
			historical_presented: 0,
			historical_silent: 0,
			needs_reconciliation: 0,
		});
		const frozen = JSON.parse(
			readFileSync(
				join(value.stateDir, "m0-dispositions.jsonl"),
				"utf8",
			).trim(),
		) as Record<string, unknown>;
		expect(frozen).toMatchObject({
			roundId,
			disposition: "eligible",
			evidenceRef,
		});

		const verify = await runRayaSummaryPresentationGate(
			["verify", ...sharedArgs(value)],
			dependencies,
		);
		expect(verify).toMatchObject({
			exitCode: 0,
			output: { status: "unchanged", receiptId: receipt.receiptId },
		});
	});

	it("fails closed without creating a migration row when the authorized preflight drifts", async () => {
		const value = await fixture(1);
		cleanups.push(value.root);
		const dependencies = gateDependencies(value);
		const preflight = await runRayaSummaryPresentationGate(
			preflightArgs(value),
			dependencies,
		);
		const store = await StateStore.create(value.dbPath);
		try {
			appendRound(store, 2);
		} finally {
			store.close();
		}
		const result = await runRayaSummaryPresentationGate(
			executeArgs(value, String(preflight.output.authorizedPayloadDigest)),
			dependencies,
		);
		expect(result).toMatchObject({
			exitCode: 1,
			output: { status: "error", code: "preflight_drift" },
		});
		const raw = new BetterSqlite3(value.dbPath, { readonly: true });
		try {
			expect(
				raw
					.prepare(
						"SELECT COUNT(*) AS count FROM summary_presentation_migration",
					)
					.get(),
			).toEqual({ count: 0 });
		} finally {
			raw.close();
		}
		warmReadonlySidecars(value.dbPath);
	});

	it("rechecks authorized files only after acquiring the shared deploy lock", async () => {
		const value = await fixture(1);
		cleanups.push(value.root);
		const dependencies = gateDependencies(value);
		const preflight = await runRayaSummaryPresentationGate(
			preflightArgs(value),
			dependencies,
		);
		let mutated = false;
		const result = await runRayaSummaryPresentationGate(
			executeArgs(value, String(preflight.output.authorizedPayloadDigest)),
			{
				...dependencies,
				io: {
					...dependencies.io,
					run: async () => {
						if (!mutated) {
							mutated = true;
							writeFileSync(
								join(value.workspace, ".lead/raya/identity.md"),
								"# Changed after lock acquisition\n",
							);
						}
						return "Tue Sep 17 19:00:00 2026";
					},
				},
			},
		);

		expect(result).toMatchObject({
			exitCode: 1,
			output: { status: "error", code: "preflight_drift" },
		});
		expect(existsSync(join(value.stateDir, "m0-execution.json"))).toBe(false);
		const raw = new BetterSqlite3(value.dbPath, { readonly: true });
		try {
			expect(
				raw
					.prepare(
						"SELECT COUNT(*) AS count FROM summary_presentation_migration",
					)
					.get(),
			).toEqual({ count: 0 });
		} finally {
			raw.close();
		}
	});

	it("uses frozen inputs for the write and refuses evidence if a bounded source changes mid-run", async () => {
		const value = await fixture(1);
		cleanups.push(value.root);
		const dependencies = gateDependencies(value);
		const preflight = await runRayaSummaryPresentationGate(
			preflightArgs(value),
			dependencies,
		);
		const reader = new BetterSqlite3(value.dbPath, { readonly: true });
		let roundId: string;
		try {
			roundId = String(
				(
					reader
						.prepare(
							"SELECT event_id FROM lead_events WHERE event_type = 'summary_absorption_round' ORDER BY seq LIMIT 1",
						)
						.get() as { event_id: string }
				).event_id,
			);
		} finally {
			reader.close();
		}
		const result = await runRayaSummaryPresentationGate(
			executeArgs(value, String(preflight.output.authorizedPayloadDigest)),
			{
				...dependencies,
				hooks: {
					beforeWriteDatabase: () => {
						writeFileSync(
							join(value.workspace, "state/summary-merge-receipts.jsonl"),
							`${JSON.stringify({
								type: "report",
								roundId,
								messageId: "1542079099928059987",
								channelId: "1542079099928059988",
							})}\n`,
						);
					},
				},
			},
		);

		expect(result).toMatchObject({
			exitCode: 1,
			output: {
				status: "error",
				code: "source_digest_drift:legacyLedger",
			},
		});
		expect(existsSync(join(value.stateDir, "m0-receipt.json"))).toBe(false);
		expect(existsSync(join(value.stateDir, "m0-dispositions.jsonl"))).toBe(
			false,
		);
		const checked = new BetterSqlite3(value.dbPath, { readonly: true });
		try {
			expect(
				checked
					.prepare(
						"SELECT state, cursor_seq, migration_boundary_seq FROM summary_presentation_migration WHERE project_name = 'raya' AND lead_id = 'raya'",
					)
					.get(),
			).toEqual({
				state: "complete",
				cursor_seq: 1,
				migration_boundary_seq: 1,
			});
		} finally {
			checked.close();
		}
	});

	it("adopts a verified legacy complete row with only the write-once completion timestamp", async () => {
		const value = await fixture(2);
		cleanups.push(value.root);
		const store = await StateStore.create(value.dbPath);
		try {
			runSummaryPresentationMigration({
				store: store.summaryPresentations,
				projectName: "raya",
				leadId: "raya",
				workspaceRoot: value.workspace,
				nowMs: 1_700_000_000_000,
			});
		} finally {
			store.close();
		}
		const raw = new BetterSqlite3(value.dbPath);
		let before: Record<string, unknown>;
		try {
			raw
				.prepare(
					"UPDATE summary_presentation_migration SET completed_at_ms = NULL WHERE project_name = 'raya' AND lead_id = 'raya'",
				)
				.run();
			before = raw
				.prepare(
					"SELECT * FROM summary_presentation_migration WHERE project_name = 'raya' AND lead_id = 'raya'",
				)
				.get() as Record<string, unknown>;
		} finally {
			raw.close();
		}

		const { execute } = await preflightAndExecute(value);
		expect(execute).toMatchObject({
			exitCode: 0,
			output: { status: "complete", mode: "adopted-legacy" },
		});
		const afterDb = new BetterSqlite3(value.dbPath, { readonly: true });
		try {
			const after = afterDb
				.prepare(
					"SELECT * FROM summary_presentation_migration WHERE project_name = 'raya' AND lead_id = 'raya'",
				)
				.get() as Record<string, unknown>;
			expect(after.completed_at_ms).toBe(before.updated_at_ms);
			expect({ ...after, completed_at_ms: null }).toEqual(before);
		} finally {
			afterDb.close();
		}
		const execution = JSON.parse(
			readFileSync(join(value.stateDir, "m0-execution.json"), "utf8"),
		) as Record<string, unknown>;
		expect(execution).toMatchObject({
			mode: "adopted-legacy",
			schemaAdoption: { source: "updated_at_ms" },
		});
	});

	it("adopts an already timestamped legacy migration without writing the database", async () => {
		const value = await fixture(2);
		cleanups.push(value.root);
		const store = await StateStore.create(value.dbPath);
		try {
			runSummaryPresentationMigration({
				store: store.summaryPresentations,
				projectName: "raya",
				leadId: "raya",
				workspaceRoot: value.workspace,
				nowMs: 1_700_000_000_000,
			});
		} finally {
			store.close();
		}
		const dependencies = gateDependencies(value);
		const missingReceipt = await runRayaSummaryPresentationGate(
			["verify", ...sharedArgs(value)],
			dependencies,
		);
		expect(missingReceipt).toMatchObject({
			exitCode: 2,
			output: { status: "receipt_missing" },
		});
		const preflight = await runRayaSummaryPresentationGate(
			preflightArgs(value),
			dependencies,
		);
		const dbFiles = [
			value.dbPath,
			`${value.dbPath}-wal`,
			`${value.dbPath}-shm`,
		];
		const beforeDatabase = snapshot(dbFiles);
		const execute = await runRayaSummaryPresentationGate(
			executeArgs(value, String(preflight.output.authorizedPayloadDigest)),
			dependencies,
		);
		expect(execute).toMatchObject({
			exitCode: 0,
			output: { status: "complete", mode: "adopted-legacy" },
		});
		expect(snapshot(dbFiles)).toEqual(beforeDatabase);
		const allFiles = [
			...dbFiles,
			join(value.stateDir, "m0-execution.json"),
			join(value.stateDir, "m0-dispositions.jsonl"),
			join(value.stateDir, "m0-receipt.json"),
		];
		const beforeReplay = snapshot(allFiles);
		const replay = await runRayaSummaryPresentationGate(
			executeArgs(value, String(preflight.output.authorizedPayloadDigest)),
			dependencies,
		);
		expect(replay).toMatchObject({
			exitCode: 0,
			output: { status: "unchanged" },
		});
		expect(snapshot(allFiles)).toEqual(beforeReplay);
	});

	it("refuses legacy adoption before any write when round evidence is corrupt", async () => {
		const value = await fixture(1);
		cleanups.push(value.root);
		const store = await StateStore.create(value.dbPath);
		try {
			runSummaryPresentationMigration({
				store: store.summaryPresentations,
				projectName: "raya",
				leadId: "raya",
				workspaceRoot: value.workspace,
			});
		} finally {
			store.close();
		}
		const raw = new BetterSqlite3(value.dbPath);
		try {
			raw
				.prepare(
					"UPDATE summary_presentation_migration SET completed_at_ms = NULL WHERE project_name = 'raya' AND lead_id = 'raya'",
				)
				.run();
			raw
				.prepare(
					"UPDATE summary_presentation_rounds SET source_digest = ? WHERE project_name = 'raya' AND lead_id = 'raya'",
				)
				.run("c".repeat(64));
		} finally {
			raw.close();
		}
		const preflight = await runRayaSummaryPresentationGate(
			preflightArgs(value),
			gateDependencies(value),
		);
		const execute = await runRayaSummaryPresentationGate(
			executeArgs(value, String(preflight.output.authorizedPayloadDigest)),
			gateDependencies(value),
		);
		expect(execute).toMatchObject({
			exitCode: 1,
			output: { status: "error", code: "round_digest_mismatch:1" },
		});
		const checked = new BetterSqlite3(value.dbPath, { readonly: true });
		try {
			expect(
				checked
					.prepare(
						"SELECT completed_at_ms FROM summary_presentation_migration WHERE project_name = 'raya' AND lead_id = 'raya'",
					)
					.get(),
			).toEqual({ completed_at_ms: null });
		} finally {
			checked.close();
		}
		expect(existsSync(join(value.stateDir, "m0-execution.json"))).toBe(false);
	});

	it("refuses legacy adoption when a claimed round points at a different identity group", async () => {
		const value = await fixture(0);
		cleanups.push(value.root);
		const store = await StateStore.create(value.dbPath);
		try {
			appendRound(store, 0, 2);
			runSummaryPresentationMigration({
				store: store.summaryPresentations,
				projectName: "raya",
				leadId: "raya",
				workspaceRoot: value.workspace,
			});
			expect(store.summaryPresentations.begin("raya", "raya").result).toBe(
				"group",
			);
		} finally {
			store.close();
		}
		const raw = new BetterSqlite3(value.dbPath);
		try {
			raw
				.prepare(
					"UPDATE summary_presentation_migration SET completed_at_ms = NULL WHERE project_name = 'raya' AND lead_id = 'raya'",
				)
				.run();
			raw
				.prepare(
					"UPDATE summary_presentation_groups SET project_name = 'mufasa' WHERE project_name = 'raya' AND lead_id = 'raya'",
				)
				.run();
		} finally {
			raw.close();
		}
		const dependencies = gateDependencies(value);
		const preflight = await runRayaSummaryPresentationGate(
			preflightArgs(value),
			dependencies,
		);
		const watched = [
			value.dbPath,
			`${value.dbPath}-wal`,
			`${value.dbPath}-shm`,
			join(value.stateDir, "m0-execution.json"),
			join(value.stateDir, "m0-dispositions.jsonl"),
			join(value.stateDir, "m0-receipt.json"),
		];
		const before = snapshot(watched);

		const execute = await runRayaSummaryPresentationGate(
			executeArgs(value, String(preflight.output.authorizedPayloadDigest)),
			dependencies,
		);

		expect(execute).toMatchObject({
			exitCode: 1,
			output: { status: "error", code: "claimed_reference_invalid:1" },
		});
		expect(snapshot(watched)).toEqual(before);
	});

	it("rebuilds missing evidence to the planned identity but refuses a post-consumption rebuild", async () => {
		const value = await fixture(0);
		cleanups.push(value.root);
		const store = await StateStore.create(value.dbPath);
		try {
			appendRound(store, 0, 2);
		} finally {
			store.close();
		}
		const dependencies = gateDependencies(value);
		const { authorizedPayloadDigest, execute } = await preflightAndExecute(
			value,
			dependencies,
		);
		expect(execute.exitCode).toBe(0);
		const receiptPath = join(value.stateDir, "m0-receipt.json");
		const evidencePath = join(value.stateDir, "m0-dispositions.jsonl");
		const original = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<
			string,
			unknown
		>;

		unlinkSync(receiptPath);
		unlinkSync(evidencePath);
		const fullEvidenceRebuild = await runRayaSummaryPresentationGate(
			executeArgs(value, authorizedPayloadDigest),
			dependencies,
		);
		expect(fullEvidenceRebuild).toMatchObject({
			exitCode: 0,
			output: { receiptId: original.receiptId },
		});
		expect(
			(JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>)
				.completedAt,
		).toBe(original.completedAt);

		const consumer = await StateStore.create(value.dbPath);
		try {
			expect(consumer.summaryPresentations.begin("raya", "raya").result).toBe(
				"group",
			);
		} finally {
			consumer.close();
		}
		const unchanged = await runRayaSummaryPresentationGate(
			executeArgs(value, authorizedPayloadDigest),
			dependencies,
		);
		expect(unchanged).toMatchObject({
			exitCode: 0,
			output: { status: "unchanged", receiptId: original.receiptId },
		});

		unlinkSync(receiptPath);
		unlinkSync(evidencePath);
		const refused = await runRayaSummaryPresentationGate(
			executeArgs(value, authorizedPayloadDigest),
			dependencies,
		);
		expect(refused).toMatchObject({
			exitCode: 1,
			output: { status: "error", code: "rebuild_identity_mismatch" },
		});
		expect(existsSync(receiptPath)).toBe(false);
		expect(existsSync(evidencePath)).toBe(false);
	});

	it("detects source and receipt tampering without overwriting evidence", async () => {
		const value = await fixture(1);
		cleanups.push(value.root);
		const dependencies = gateDependencies(value);
		const { execute } = await preflightAndExecute(value, dependencies);
		expect(execute.exitCode).toBe(0);
		const receiptPath = join(value.stateDir, "m0-receipt.json");
		const originalReceipt = readFileSync(receiptPath);
		const receipt = JSON.parse(originalReceipt.toString("utf8")) as Record<
			string,
			unknown
		>;
		receipt.windowId = "tampered-window";
		writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
		const malformed = await runRayaSummaryPresentationGate(
			["verify", ...sharedArgs(value)],
			dependencies,
		);
		expect(malformed).toMatchObject({
			exitCode: 1,
			output: { status: "error", code: "receipt_malformed" },
		});

		writeFileSync(receiptPath, originalReceipt);
		const invalidGeneratedAt = JSON.parse(
			originalReceipt.toString("utf8"),
		) as Record<string, unknown>;
		invalidGeneratedAt.generatedAt = "not-a-time";
		writeFileSync(receiptPath, `${JSON.stringify(invalidGeneratedAt)}\n`);
		const invalidTime = await runRayaSummaryPresentationGate(
			["verify", ...sharedArgs(value)],
			dependencies,
		);
		expect(invalidTime).toMatchObject({
			exitCode: 1,
			output: { status: "error", code: "receipt_malformed" },
		});

		writeFileSync(receiptPath, originalReceipt);
		const invalidWindow = JSON.parse(
			originalReceipt.toString("utf8"),
		) as Record<string, unknown>;
		invalidWindow.windowId = "window with spaces";
		const {
			receiptId: _invalidWindowReceiptId,
			generatedAt: _invalidWindowGeneratedAt,
			...invalidWindowIdentity
		} = invalidWindow;
		invalidWindow.receiptId = canonicalDigest(invalidWindowIdentity);
		writeFileSync(receiptPath, `${JSON.stringify(invalidWindow)}\n`);
		const invalidWindowResult = await runRayaSummaryPresentationGate(
			["verify", ...sharedArgs(value)],
			dependencies,
		);
		expect(invalidWindowResult).toMatchObject({
			exitCode: 1,
			output: { status: "error", code: "receipt_malformed" },
		});

		writeFileSync(receiptPath, originalReceipt);
		const db = new BetterSqlite3(value.dbPath, { readonly: true });
		let roundId: string;
		try {
			roundId = String(
				(
					db
						.prepare(
							"SELECT event_id FROM lead_events WHERE event_type = 'summary_absorption_round' ORDER BY seq LIMIT 1",
						)
						.get() as { event_id: string }
				).event_id,
			);
		} finally {
			db.close();
		}
		writeFileSync(
			join(value.workspace, "state/summary-merge-receipts.jsonl"),
			`${JSON.stringify({ type: "report_attempt", roundId })}\n`,
		);
		const drift = await runRayaSummaryPresentationGate(
			["verify", ...sharedArgs(value)],
			dependencies,
		);
		expect(drift).toMatchObject({
			exitCode: 1,
			output: {
				status: "error",
				code: "source_digest_drift:legacyLedger",
			},
		});
		expect(readFileSync(receiptPath)).toEqual(originalReceipt);
	});

	it("detects per-round digest, disposition, and frozen evidence tampering read-only", async () => {
		const value = await fixture(1);
		cleanups.push(value.root);
		const dependencies = gateDependencies(value);
		const { execute } = await preflightAndExecute(value, dependencies);
		expect(execute.exitCode).toBe(0);
		const evidencePath = join(value.stateDir, "m0-dispositions.jsonl");
		const receiptPath = join(value.stateDir, "m0-receipt.json");
		const originalEvidence = readFileSync(evidencePath);
		const raw = new BetterSqlite3(value.dbPath);
		let originalDigest: string;
		try {
			originalDigest = String(
				(
					raw
						.prepare(
							"SELECT source_digest FROM summary_presentation_rounds WHERE project_name = 'raya' AND lead_id = 'raya'",
						)
						.get() as { source_digest: string }
				).source_digest,
			);
			raw
				.prepare(
					"UPDATE summary_presentation_rounds SET source_digest = ? WHERE project_name = 'raya' AND lead_id = 'raya'",
				)
				.run("c".repeat(64));
		} finally {
			raw.close();
		}
		warmReadonlySidecars(value.dbPath);
		const watched = [
			value.dbPath,
			`${value.dbPath}-wal`,
			`${value.dbPath}-shm`,
			evidencePath,
			receiptPath,
		];
		let before = snapshot(watched);
		const digestMismatch = await runRayaSummaryPresentationGate(
			["verify", ...sharedArgs(value)],
			dependencies,
		);
		expect(digestMismatch).toMatchObject({
			exitCode: 1,
			output: { status: "error", code: "round_digest_mismatch:1" },
		});
		expect(snapshot(watched)).toEqual(before);

		const dispositionDb = new BetterSqlite3(value.dbPath);
		try {
			dispositionDb
				.prepare(
					"UPDATE summary_presentation_rounds SET source_digest = ?, disposition = 'historical_silent' WHERE project_name = 'raya' AND lead_id = 'raya'",
				)
				.run(originalDigest);
		} finally {
			dispositionDb.close();
		}
		warmReadonlySidecars(value.dbPath);
		before = snapshot(watched);
		const dispositionMismatch = await runRayaSummaryPresentationGate(
			["verify", ...sharedArgs(value)],
			dependencies,
		);
		expect(dispositionMismatch).toMatchObject({
			exitCode: 1,
			output: {
				status: "error",
				code: "round_disposition_mismatch:1:needs_reconciliation:historical_silent",
			},
		});
		expect(snapshot(watched)).toEqual(before);

		const restoredDb = new BetterSqlite3(value.dbPath);
		try {
			restoredDb
				.prepare(
					"UPDATE summary_presentation_rounds SET disposition = 'needs_reconciliation' WHERE project_name = 'raya' AND lead_id = 'raya'",
				)
				.run();
		} finally {
			restoredDb.close();
		}
		warmReadonlySidecars(value.dbPath);
		const evidenceRow = JSON.parse(
			originalEvidence.toString("utf8").trim(),
		) as Record<string, unknown>;
		evidenceRow.evidenceRef = "tampered";
		writeFileSync(evidencePath, `${JSON.stringify(evidenceRow)}\n`);
		before = snapshot(watched);
		const evidenceMismatch = await runRayaSummaryPresentationGate(
			["verify", ...sharedArgs(value)],
			dependencies,
		);
		expect(evidenceMismatch).toMatchObject({
			exitCode: 1,
			output: { status: "error", code: "receipt_conflict" },
		});
		expect(snapshot(watched)).toEqual(before);
	});

	it("honors the shared deploy lock and checks database identity before opening it read-write", async () => {
		const value = await fixture(1);
		cleanups.push(value.root);
		const dependencies = gateDependencies(value);
		const preflight = await runRayaSummaryPresentationGate(
			preflightArgs(value),
			dependencies,
		);
		const lock = join(value.rayaHome, "deploy.lock.d");
		mkdirSync(lock, { mode: 0o700 });
		writeFileSync(join(lock, "pid"), `${process.pid}\n`, { mode: 0o600 });
		writeFileSync(join(lock, "start"), "Tue Sep 17 19:00:00 2026\n", {
			mode: 0o600,
		});
		const locked = await runRayaSummaryPresentationGate(
			executeArgs(value, String(preflight.output.authorizedPayloadDigest)),
			dependencies,
		);
		expect(locked).toMatchObject({
			exitCode: 1,
			output: { status: "error", code: "deploy-lock-held" },
		});

		rmSync(lock, { recursive: true, force: true });
		const replacement = join(value.root, "replacement.db");
		const replacementStore = await StateStore.create(replacement);
		replacementStore.close();
		const oldPath = `${value.dbPath}.authorized`;
		const identityChanged = await runRayaSummaryPresentationGate(
			executeArgs(value, String(preflight.output.authorizedPayloadDigest)),
			{
				...dependencies,
				hooks: {
					beforeWriteDatabase: () => {
						renameSync(value.dbPath, oldPath);
						renameSync(replacement, value.dbPath);
					},
				},
			},
		);
		expect(identityChanged).toMatchObject({
			exitCode: 1,
			output: { status: "error", code: "db_identity_changed" },
		});
		const raw = new BetterSqlite3(value.dbPath, { readonly: true });
		try {
			expect(
				raw
					.prepare(
						"SELECT COUNT(*) AS count FROM summary_presentation_migration",
					)
					.get(),
			).toEqual({ count: 0 });
		} finally {
			raw.close();
		}
	});

	it("rejects a database replacement before the final readonly verification", async () => {
		const value = await fixture(1);
		cleanups.push(value.root);
		const dependencies = gateDependencies(value);
		const preflight = await runRayaSummaryPresentationGate(
			preflightArgs(value),
			dependencies,
		);
		const replacement = join(value.root, "final-replacement.db");
		const replacementStore = await StateStore.create(replacement);
		replacementStore.close();
		const authorizedPath = `${value.dbPath}.authorized`;

		const result = await runRayaSummaryPresentationGate(
			executeArgs(value, String(preflight.output.authorizedPayloadDigest)),
			{
				...dependencies,
				hooks: {
					beforeFinalReadonly: () => {
						renameSync(value.dbPath, authorizedPath);
						for (const suffix of ["-wal", "-shm"]) {
							if (existsSync(`${value.dbPath}${suffix}`)) {
								renameSync(
									`${value.dbPath}${suffix}`,
									`${authorizedPath}${suffix}`,
								);
							}
						}
						renameSync(replacement, value.dbPath);
					},
				},
			},
		);

		expect(result).toMatchObject({
			exitCode: 1,
			output: { status: "error", code: "db_identity_changed" },
		});
		expect(existsSync(join(value.stateDir, "m0-receipt.json"))).toBe(false);
		expect(existsSync(join(value.stateDir, "m0-dispositions.jsonl"))).toBe(
			false,
		);
		const replacementDb = new BetterSqlite3(value.dbPath, { readonly: true });
		try {
			expect(
				replacementDb
					.prepare(
						"SELECT COUNT(*) AS count FROM summary_presentation_migration",
					)
					.get(),
			).toEqual({ count: 0 });
		} finally {
			replacementDb.close();
		}
	});

	it("freezes the full authorization locator across resumable executions", async () => {
		const value = await fixture(3);
		cleanups.push(value.root);
		const dependencies = gateDependencies(value);
		const preflight = await runRayaSummaryPresentationGate(
			preflightArgs(value),
			dependencies,
		);
		const authorizedPayloadDigest = String(
			preflight.output.authorizedPayloadDigest,
		);
		const partial = await runRayaSummaryPresentationGate(
			[...executeArgs(value, authorizedPayloadDigest), "--max-rows", "1"],
			dependencies,
		);
		expect(partial.exitCode).toBe(2);
		const changedLocator = executeArgs(value, authorizedPayloadDigest);
		changedLocator[changedLocator.indexOf("--authorization-message-id") + 1] =
			"1542079099928059999";
		const refused = await runRayaSummaryPresentationGate(
			changedLocator,
			dependencies,
		);
		expect(refused).toMatchObject({
			exitCode: 1,
			output: { status: "error", code: "execution_record_conflict" },
		});
		const raw = new BetterSqlite3(value.dbPath, { readonly: true });
		try {
			expect(
				raw
					.prepare(
						"SELECT cursor_seq, state FROM summary_presentation_migration WHERE project_name = 'raya' AND lead_id = 'raya'",
					)
					.get(),
			).toEqual({ cursor_seq: 1, state: "building" });
		} finally {
			raw.close();
		}
	});

	it("uses the same three-state evidence outcome for verify and execute", async () => {
		const value = await fixture(1);
		cleanups.push(value.root);
		const dependencies = gateDependencies(value);
		const missing = await runRayaSummaryPresentationGate(
			["verify", ...sharedArgs(value)],
			dependencies,
		);
		expect(missing).toMatchObject({
			exitCode: 2,
			output: { status: "migration_missing" },
		});
		const { authorizedPayloadDigest, execute } = await preflightAndExecute(
			value,
			dependencies,
		);
		expect(execute.exitCode).toBe(0);
		const receiptPath = join(value.stateDir, "m0-receipt.json");
		unlinkSync(receiptPath);
		const verifyOneSided = await runRayaSummaryPresentationGate(
			["verify", ...sharedArgs(value)],
			dependencies,
		);
		expect(verifyOneSided).toMatchObject({
			exitCode: 1,
			output: { status: "error", code: "evidence_incomplete" },
		});
		const rebuilt = await runRayaSummaryPresentationGate(
			executeArgs(value, authorizedPayloadDigest),
			dependencies,
		);
		expect(rebuilt.exitCode).toBe(0);
		chmodSync(receiptPath, 0o644);
		const publicReceipt = await runRayaSummaryPresentationGate(
			["verify", ...sharedArgs(value)],
			dependencies,
		);
		expect(publicReceipt).toMatchObject({
			exitCode: 1,
			output: { status: "error", code: "receipt_malformed" },
		});
		chmodSync(receiptPath, 0o600);
		const receiptTarget = `${receiptPath}.target`;
		renameSync(receiptPath, receiptTarget);
		symlinkSync(receiptTarget, receiptPath);
		const symlinkedReceipt = await runRayaSummaryPresentationGate(
			["verify", ...sharedArgs(value)],
			dependencies,
		);
		expect(symlinkedReceipt).toMatchObject({
			exitCode: 1,
			output: { status: "error", code: "receipt_malformed" },
		});
	});

	it("rebuilds receipt-only evidence from the planned identity without refreshing the receipt", async () => {
		const value = await fixture(1);
		cleanups.push(value.root);
		const dependencies = gateDependencies(value);
		const { authorizedPayloadDigest, execute } = await preflightAndExecute(
			value,
			dependencies,
		);
		expect(execute.exitCode).toBe(0);
		const receiptPath = join(value.stateDir, "m0-receipt.json");
		const evidencePath = join(value.stateDir, "m0-dispositions.jsonl");
		const receiptBefore = readFileSync(receiptPath);
		const receiptId = String(
			(JSON.parse(receiptBefore.toString("utf8")) as Record<string, unknown>)
				.receiptId,
		);
		unlinkSync(evidencePath);

		const rebuilt = await runRayaSummaryPresentationGate(
			executeArgs(value, authorizedPayloadDigest),
			{
				...dependencies,
				now: () => 1_800_000_001_000,
			},
		);

		expect(rebuilt).toMatchObject({
			exitCode: 0,
			output: { status: "complete", receiptId },
		});
		expect(readFileSync(receiptPath)).toEqual(receiptBefore);
		expect(existsSync(evidencePath)).toBe(true);
	});

	it("refuses either one-sided evidence state when no planned identity remains", async () => {
		const value = await fixture(1);
		cleanups.push(value.root);
		const dependencies = gateDependencies(value);
		const { authorizedPayloadDigest, execute } = await preflightAndExecute(
			value,
			dependencies,
		);
		expect(execute.exitCode).toBe(0);
		const receiptPath = join(value.stateDir, "m0-receipt.json");
		const evidencePath = join(value.stateDir, "m0-dispositions.jsonl");
		const executionPath = join(value.stateDir, "m0-execution.json");
		const receiptBytes = readFileSync(receiptPath);
		unlinkSync(executionPath);
		unlinkSync(receiptPath);
		let before = snapshot([
			value.dbPath,
			`${value.dbPath}-wal`,
			`${value.dbPath}-shm`,
			evidencePath,
		]);
		const evidenceOnly = await runRayaSummaryPresentationGate(
			executeArgs(value, authorizedPayloadDigest),
			dependencies,
		);
		expect(evidenceOnly).toMatchObject({
			exitCode: 1,
			output: { status: "error", code: "evidence_incomplete" },
		});
		expect(
			snapshot([
				value.dbPath,
				`${value.dbPath}-wal`,
				`${value.dbPath}-shm`,
				evidencePath,
			]),
		).toEqual(before);

		writeFileSync(receiptPath, receiptBytes, { mode: 0o600 });
		unlinkSync(evidencePath);
		before = snapshot([
			value.dbPath,
			`${value.dbPath}-wal`,
			`${value.dbPath}-shm`,
			receiptPath,
		]);
		const receiptOnly = await runRayaSummaryPresentationGate(
			executeArgs(value, authorizedPayloadDigest),
			dependencies,
		);
		expect(receiptOnly).toMatchObject({
			exitCode: 1,
			output: { status: "error", code: "evidence_incomplete" },
		});
		expect(
			snapshot([
				value.dbPath,
				`${value.dbPath}-wal`,
				`${value.dbPath}-shm`,
				receiptPath,
			]),
		).toEqual(before);
	});

	it("binds the authorization digest to its window and rejects symlinked database paths", async () => {
		const value = await fixture(1);
		cleanups.push(value.root);
		const dependencies = gateDependencies(value);
		const preflight = await runRayaSummaryPresentationGate(
			preflightArgs(value),
			dependencies,
		);
		const changedWindow = executeArgs(
			value,
			String(preflight.output.authorizedPayloadDigest),
		);
		changedWindow[changedWindow.indexOf("--window-id") + 1] = "window-2";
		const drift = await runRayaSummaryPresentationGate(
			changedWindow,
			dependencies,
		);
		expect(drift).toMatchObject({
			exitCode: 1,
			output: { status: "error", code: "preflight_drift" },
		});

		const realDb = `${value.dbPath}.real`;
		renameSync(value.dbPath, realDb);
		symlinkSync(realDb, value.dbPath);
		const symlinked = await runRayaSummaryPresentationGate(
			preflightArgs(value),
			dependencies,
		);
		expect(symlinked).toMatchObject({
			exitCode: 1,
			output: { status: "error", code: "db_invalid" },
		});
	});

	it("rejects every missing or malformed execution authorization field before I/O", async () => {
		const value = await fixture(1);
		cleanups.push(value.root);
		const dependencies = gateDependencies(value);
		const valid = executeArgs(value, SHA256_ZERO);
		const watched = [
			value.dbPath,
			`${value.dbPath}-wal`,
			`${value.dbPath}-shm`,
			join(value.stateDir, "m0-execution.json"),
			join(value.stateDir, "m0-dispositions.jsonl"),
			join(value.stateDir, "m0-receipt.json"),
		];
		const before = snapshot(watched);
		for (const flag of [
			"--db",
			"--workspace",
			"--project",
			"--lead",
			"--state-root",
			"--deployed-sha-file",
			"--raya-home",
			"--window-id",
			"--frozen-payload-digest",
			"--authorization-channel-id",
			"--authorization-message-id",
			"--authorization-author-id",
			"--authorization-content-sha256",
			"--expect-preflight",
		]) {
			const args = [...valid];
			const index = args.indexOf(flag);
			args.splice(index, 2);
			const result = await runRayaSummaryPresentationGate(args, dependencies);
			expect(result, flag).toMatchObject({
				exitCode: 1,
				output: { status: "error", code: `missing_argument:${flag}` },
			});
		}
		for (const [flag, invalid] of [
			["--window-id", "window with spaces"],
			["--frozen-payload-digest", "not-a-sha"],
			["--authorization-channel-id", "0"],
			["--authorization-message-id", "abc"],
			["--authorization-author-id", "-1"],
			["--authorization-content-sha256", "ABC"],
			["--expect-preflight", "short"],
		] as const) {
			const args = [...valid];
			args[args.indexOf(flag) + 1] = invalid;
			const result = await runRayaSummaryPresentationGate(args, dependencies);
			expect(result, flag).toMatchObject({
				exitCode: 1,
				output: { status: "error", code: `invalid_argument:${flag}` },
			});
		}
		expect(snapshot(watched)).toEqual(before);
	});

	it("fails closed on unsafe paths and binds state and lock roots into preflight", async () => {
		const value = await fixture(1);
		cleanups.push(value.root);
		const dependencies = gateDependencies(value);
		const watched = [
			value.dbPath,
			`${value.dbPath}-wal`,
			`${value.dbPath}-shm`,
		];
		const beforeRejectedInputs = snapshot(watched);

		writeFileSync(value.deployedShaFile, "not-a-commit\n");
		const invalidSha = await runRayaSummaryPresentationGate(
			preflightArgs(value),
			dependencies,
		);
		expect(invalidSha).toMatchObject({
			exitCode: 1,
			output: { status: "error", code: "deployed_sha_invalid" },
		});
		expect(snapshot(watched)).toEqual(beforeRejectedInputs);
		writeFileSync(value.deployedShaFile, `${DEPLOYED_SHA}\n`);

		const movedStateDir = `${value.stateDir}.moved`;
		renameSync(value.stateDir, movedStateDir);
		const missingState = await runRayaSummaryPresentationGate(
			preflightArgs(value),
			dependencies,
		);
		expect(missingState).toMatchObject({
			exitCode: 1,
			output: { status: "error", code: "state_dir_missing" },
		});
		expect(snapshot(watched)).toEqual(beforeRejectedInputs);
		renameSync(movedStateDir, value.stateDir);
		const stateComponent = join(value.stateRoot, "state");
		const movedStateComponent = `${stateComponent}.moved`;
		renameSync(stateComponent, movedStateComponent);
		symlinkSync(movedStateComponent, stateComponent);
		const symlinkedStateParent = await runRayaSummaryPresentationGate(
			preflightArgs(value),
			dependencies,
		);
		expect(symlinkedStateParent).toMatchObject({
			exitCode: 1,
			output: { status: "error", code: "state_dir_missing" },
		});
		unlinkSync(stateComponent);
		renameSync(movedStateComponent, stateComponent);
		const leadComponent = join(value.workspace, ".lead");
		const movedLeadComponent = `${leadComponent}.moved`;
		renameSync(leadComponent, movedLeadComponent);
		symlinkSync(movedLeadComponent, leadComponent);
		const symlinkedPersonaParent = await runRayaSummaryPresentationGate(
			preflightArgs(value),
			dependencies,
		);
		expect(symlinkedPersonaParent).toMatchObject({
			exitCode: 1,
			output: { status: "error", code: "persona_invalid" },
		});
		unlinkSync(leadComponent);
		renameSync(movedLeadComponent, leadComponent);

		const preflight = await runRayaSummaryPresentationGate(
			preflightArgs(value),
			dependencies,
		);
		const beforeDriftChecks = snapshot(watched);
		const digest = String(preflight.output.authorizedPayloadDigest);
		const alternateStateRoot = join(value.root, "alternate-state-root");
		mkdirSync(join(alternateStateRoot, "state/lead-persona/raya/raya"), {
			recursive: true,
			mode: 0o700,
		});
		const changedState = executeArgs(value, digest);
		changedState[changedState.indexOf("--state-root") + 1] = alternateStateRoot;
		const stateDrift = await runRayaSummaryPresentationGate(
			changedState,
			dependencies,
		);
		expect(stateDrift).toMatchObject({
			exitCode: 1,
			output: { status: "error", code: "preflight_drift" },
		});

		const alternateHome = join(value.root, "alternate-raya-home");
		mkdirSync(alternateHome, { mode: 0o700 });
		const changedHome = executeArgs(value, digest);
		changedHome[changedHome.indexOf("--raya-home") + 1] = alternateHome;
		const homeDrift = await runRayaSummaryPresentationGate(
			changedHome,
			dependencies,
		);
		expect(homeDrift).toMatchObject({
			exitCode: 1,
			output: { status: "error", code: "preflight_drift" },
		});
		expect(existsSync(join(alternateHome, "deploy.lock.d"))).toBe(false);

		const homeTarget = `${value.rayaHome}.target`;
		renameSync(value.rayaHome, homeTarget);
		symlinkSync(homeTarget, value.rayaHome);
		const symlinkedHome = await runRayaSummaryPresentationGate(
			preflightArgs(value),
			dependencies,
		);
		expect(symlinkedHome).toMatchObject({
			exitCode: 1,
			output: { status: "error", code: "raya_home_invalid" },
		});
		const workspaceTarget = `${value.workspace}.target`;
		renameSync(value.workspace, workspaceTarget);
		symlinkSync(workspaceTarget, value.workspace);
		const symlinkedWorkspace = await runRayaSummaryPresentationGate(
			preflightArgs(value),
			dependencies,
		);
		expect(symlinkedWorkspace).toMatchObject({
			exitCode: 1,
			output: { status: "error", code: "workspace_invalid" },
		});
		expect(snapshot(watched)).toEqual(beforeDriftChecks);
	});

	it("rejects every non-Raya identity before touching any path", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2697-negative-"));
		cleanups.push(root);
		const before = readdirSync(root);
		for (const [project, lead] of [
			["mufasa", "mufasa"],
			["raya", "mufasa"],
			["mufasa", "raya"],
		]) {
			const result = await runRayaSummaryPresentationGate([
				"execute",
				"--db",
				join(root, "missing.db"),
				"--workspace",
				join(root, "missing-workspace"),
				"--project",
				project,
				"--lead",
				lead,
				"--state-root",
				join(root, "missing-state"),
			]);
			expect(result).toMatchObject({
				exitCode: 1,
				output: { status: "error", code: "identity_not_allowed" },
			});
		}
		expect(readdirSync(root)).toEqual(before);
	});
});
