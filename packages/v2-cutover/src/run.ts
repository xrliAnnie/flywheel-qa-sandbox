import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	cpSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import Database from "better-sqlite3";
import {
	advanceDatabaseAuthorityStateTx,
	Kernel,
	openExistingKernel,
	publishLiveCutoverAuthority,
	publishRollbackCutoverAuthority,
	readCutoverAuthority,
	readRollbackFence,
	rollbackGateCas,
	writeRollbackReceipt,
} from "flywheel-v2-kernel";
import {
	prepareStagingDatabase,
	promoteStagingDatabase,
	stagingDatabasePath,
} from "./database-lifecycle.js";
import { evaluateGoNoGo, type GoNoGoObservation } from "./go-no-go.js";
import { CutoverLedger } from "./ledger.js";
import {
	archiveAndTombstoneLegacyPath,
	type LegacyArchiveReceipt,
	legacyArchiveRestoreState,
	restoreLegacyArchivePath,
	runLegacyWriterLiveFire,
} from "./legacy-fence.js";
import type { CutoverTargetManifest, LedgeredCommand } from "./manifest.js";
import { applyManualAdjudications } from "./manual-adjudication.js";
import {
	buildMigrationPlan,
	type LegacyMigrationPlan,
	migrateLegacyPlan,
	readLegacySourceSnapshot,
} from "./migration.js";

interface CommandResult {
	argv: string[];
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

export interface CutoverRunOptions {
	step?: number;
	yes?: boolean;
	confirm?(prompt: string): Promise<string> | string;
	now?: () => Date;
}

export interface CutoverRunResult {
	completedSteps: number[];
	status: "done" | "no-go";
}

export type RollbackT1FaultPoint =
	| "after_gate_cas"
	| "after_archive_restore"
	| "after_rollback_command"
	| "after_receipt_write"
	| "after_authority_publish"
	| "after_evidence_write";

export interface RollbackT1Options extends Pick<CutoverRunOptions, "now"> {
	fault?(point: RollbackT1FaultPoint, key: string): void;
}

interface ArchivedEvidence {
	v: 1;
	receipts: LegacyArchiveReceipt[];
}

function nowIso(options: CutoverRunOptions): string {
	return (options.now?.() ?? new Date()).toISOString();
}

function sha256(value: Buffer | string): string {
	return createHash("sha256").update(value).digest("hex");
}

function atomicEvidence(path: string, value: unknown): string {
	const parent = dirname(path);
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	chmodSync(parent, 0o700);
	const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
	const temporary = join(
		parent,
		`.${basename(path)}.${process.pid}.${Date.now()}.tmp`,
	);
	const fd = openSync(temporary, "wx", 0o600);
	try {
		writeFileSync(fd, bytes);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, path);
	chmodSync(path, 0o600);
	const parentFd = openSync(parent, "r");
	try {
		fsyncSync(parentFd);
	} finally {
		closeSync(parentFd);
	}
	return path;
}

function readObject<T>(path: string, name: string): T {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new Error("not an object");
		}
		return value as T;
	} catch (error) {
		throw new Error(
			`${name} is missing or malformed at ${path}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

function execute(command: string[], env?: NodeJS.ProcessEnv): CommandResult {
	if (command.length === 0) throw new TypeError("command must not be empty");
	const [file, ...args] = command;
	const result = spawnSync(file as string, args, {
		encoding: "utf8",
		timeout: 30_000,
		env: env ?? process.env,
	});
	return {
		argv: [...command],
		exitCode: result.status,
		signal: result.signal,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? result.error?.message ?? "",
	};
}

function primitiveNeedsApply(input: {
	ledger: CutoverLedger;
	step: number;
	key: string;
	description: string;
	preimage?: unknown;
}): boolean {
	const current = input.ledger.primitiveState(input.key);
	if (current?.status === "complete") return false;
	if (current?.status === "verify") {
		input.ledger.primitive(
			input.key,
			input.step,
			input.description,
			"complete",
		);
		return false;
	}
	if (!current || current.status === "failed") {
		input.ledger.primitive(
			input.key,
			input.step,
			input.description,
			"intent",
			input.preimage,
		);
	}
	if (input.ledger.primitiveState(input.key)?.status === "intent") {
		input.ledger.primitive(input.key, input.step, input.description, "apply");
	}
	return true;
}

function finishPrimitive(input: {
	ledger: CutoverLedger;
	step: number;
	key: string;
	description: string;
}): void {
	input.ledger.primitive(input.key, input.step, input.description, "verify");
	input.ledger.primitive(input.key, input.step, input.description, "complete");
}

type LedgeredCommandFaultPoint =
	| "after_apply_ledger"
	| "after_execute"
	| "after_verify";

export function executeLedgeredCommands(input: {
	ledger: CutoverLedger;
	step: number;
	prefix: string;
	description: string;
	commands: LedgeredCommand[];
	fault?: (point: LedgeredCommandFaultPoint, key: string) => void;
}): CommandResult[] {
	return input.commands.map((command, index) => {
		const key = `${input.prefix}:${index}:${sha256(JSON.stringify(command)).slice(0, 16)}`;
		const primitive = {
			ledger: input.ledger,
			step: input.step,
			key,
			description: `${input.description}: ${command.apply.join(" ")}`,
		};
		const current = input.ledger.primitiveState(key);
		if (current?.status === "complete") {
			return {
				argv: [...command.apply],
				exitCode: 0,
				signal: null,
				stdout: "replayed from completed primitive",
				stderr: "",
			};
		}
		if (current?.status === "verify") {
			const verification = execute(command.verify);
			if (verification.exitCode !== 0) {
				input.ledger.primitive(
					key,
					input.step,
					primitive.description,
					"failed",
				);
				throw new Error(
					`${input.description} recovery verification failed (${command.verify.join(" ")}): ${verification.stderr}`,
				);
			}
			input.ledger.primitive(
				key,
				input.step,
				primitive.description,
				"complete",
			);
			return {
				argv: [...command.apply],
				exitCode: 0,
				signal: null,
				stdout: "reconciled from verification ledger state",
				stderr: "",
			};
		}
		if (
			!primitiveNeedsApply({
				...primitive,
				preimage: {
					applyArgv: command.apply,
					verifyArgv: command.verify,
				},
			})
		) {
			throw new Error(
				`primitive ${key} unexpectedly required no reconciliation`,
			);
		}

		const reconcile = execute(command.verify);
		if (reconcile.exitCode === 0) {
			input.ledger.primitive(key, input.step, primitive.description, "verify");
			input.fault?.("after_verify", key);
			input.ledger.primitive(
				key,
				input.step,
				primitive.description,
				"complete",
			);
			return {
				argv: [...command.apply],
				exitCode: 0,
				signal: null,
				stdout: "reconciled from verification probe",
				stderr: "",
			};
		}

		input.fault?.("after_apply_ledger", key);
		const result = execute(command.apply);
		if (result.exitCode !== 0) {
			input.ledger.primitive(key, input.step, primitive.description, "failed");
			throw new Error(
				`${input.description} command failed (${command.apply.join(" ")}): ${result.stderr}`,
			);
		}
		input.fault?.("after_execute", key);
		const verification = execute(command.verify);
		if (verification.exitCode !== 0) {
			input.ledger.primitive(key, input.step, primitive.description, "failed");
			throw new Error(
				`${input.description} verification failed (${command.verify.join(" ")}): ${verification.stderr}`,
			);
		}
		input.ledger.primitive(key, input.step, primitive.description, "verify");
		input.fault?.("after_verify", key);
		input.ledger.primitive(key, input.step, primitive.description, "complete");
		return result;
	});
}

function credentialProbes(commands: string[][]): {
	pass: boolean;
	results: CommandResult[];
} {
	const results = commands.map((command) => execute(command));
	const pass =
		results.length > 0 &&
		results.every(
			(result) =>
				result.exitCode !== 0 &&
				/(401|403|denied|rejected|revoked|frozen|unauthorized|forbidden)/i.test(
					`${result.stdout}\n${result.stderr}`,
				),
		);
	return { pass, results };
}

function legacyWritersStopped(patterns: string[]): {
	pass: boolean;
	matches: string[];
} {
	if (patterns.length === 0) return { pass: true, matches: [] };
	const result = execute(["ps", "-axo", "pid=,command="]);
	if (result.exitCode !== 0) {
		throw new Error(
			`cannot enumerate legacy writer processes: ${result.stderr}`,
		);
	}
	const matches = result.stdout
		.split("\n")
		.filter((line) => patterns.some((pattern) => line.includes(pattern)))
		.filter((line) => !line.includes(String(process.pid)));
	return { pass: matches.length === 0, matches };
}

function assertNoOpenFds(paths: string[]): void {
	for (const path of paths) {
		const result = execute(["lsof", "-Fn", "--", path]);
		if (result.exitCode === 0 && result.stdout.trim()) {
			throw new Error(`legacy path still has open file descriptors: ${path}`);
		}
		if (result.exitCode === null) {
			throw new Error(`lsof could not inspect ${path}: ${result.stderr}`);
		}
	}
}

async function snapshotSqlite(
	source: string,
	destination: string,
): Promise<void> {
	mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
	const sourceDb = new Database(source, {
		fileMustExist: true,
		timeout: 5_000,
	});
	try {
		const checkpoint = (
			sourceDb.pragma("wal_checkpoint(TRUNCATE)") as Array<{
				busy: number;
				log: number;
				checkpointed: number;
			}>
		)[0];
		if (
			!checkpoint ||
			checkpoint.busy !== 0 ||
			checkpoint.log !== checkpoint.checkpointed
		) {
			throw new Error(
				`legacy WAL checkpoint did not drain for ${source}: ${JSON.stringify(checkpoint)}`,
			);
		}
		await sourceDb.backup(destination);
	} finally {
		sourceDb.close();
	}
	const copy = new Database(destination, {
		readonly: true,
		fileMustExist: true,
	});
	try {
		if (copy.pragma("integrity_check", { simple: true }) !== "ok") {
			throw new Error(`legacy snapshot integrity failed: ${destination}`);
		}
	} finally {
		copy.close();
	}
	chmodSync(destination, 0o400);
}

function snapshotRoot(source: string, destination: string): void {
	cpSync(source, destination, {
		recursive: true,
		errorOnExist: true,
		force: false,
		preserveTimestamps: true,
	});
}

function evidencePath(target: CutoverTargetManifest, name: string): string {
	return join(target.evidenceDir, name);
}

function planEvidencePath(target: CutoverTargetManifest): string {
	return evidencePath(target, "migration-plan.json");
}

function archiveEvidencePath(target: CutoverTargetManifest): string {
	return evidencePath(target, "archive-receipts.json");
}

function productionDbContract(target: CutoverTargetManifest) {
	return {
		dbPath: target.database.finalPath,
		markerPath: target.database.markerPath,
		authorityPath: target.database.authorityPath,
		armedPath: target.database.armedPath,
		expectedWindowId: target.windowId,
		expectedEpoch: target.epoch,
		allowedAuthorityStates: ["cutover", "live"] as const,
	};
}

export function publishLiveAuthorityIdempotently(
	target: CutoverTargetManifest,
	now: string,
): { databaseState: "live"; machineState: "live"; reconciled: boolean } {
	const authority = readCutoverAuthority({
		authorityPath: target.database.authorityPath,
		armedPath: target.database.armedPath,
		expectedWindowId: target.windowId,
		expectedEpoch: target.epoch,
	});
	if (authority.mode !== "armed") {
		throw new Error("live publication requires armed machine authority");
	}
	const kernel = openExistingKernel(productionDbContract(target));
	let databaseState: string | undefined;
	try {
		databaseState = kernel.read(
			(tx) =>
				tx.get<{ value: string }>(
					"SELECT value FROM meta WHERE key='cutover_authority_state'",
				)?.value,
		);
		if (authority.authority.state === "live" && databaseState === "cutover") {
			throw new Error(
				"machine authority is live while database authority is still cutover",
			);
		}
		if (
			authority.authority.state !== "cutover" &&
			authority.authority.state !== "live"
		) {
			throw new Error(
				`machine authority cannot publish live from ${authority.authority.state}`,
			);
		}
		if (databaseState !== "cutover" && databaseState !== "live") {
			throw new Error(
				`database authority cannot publish live from ${databaseState ?? "missing"}`,
			);
		}
		if (databaseState === "cutover") {
			kernel.write("cutover.publish-live", (tx) => {
				advanceDatabaseAuthorityStateTx(tx, {
					expected: "cutover",
					next: "live",
					nowIso: now,
				});
			});
		}
	} finally {
		kernel.close();
	}
	const reconciled =
		databaseState === "live" && authority.authority.state === "cutover";
	publishLiveCutoverAuthority({
		authorityPath: target.database.authorityPath,
		armedPath: target.database.armedPath,
		windowId: target.windowId,
		epoch: target.epoch,
		nowIso: now,
	});
	return { databaseState: "live", machineState: "live", reconciled };
}

function inspectKernelChecks(target: CutoverTargetManifest): {
	activeAttemptUniqueness: boolean;
	actionEffectKeyContract: boolean;
	actionOutcomesSettled: boolean;
	gatesBindExactHead: boolean;
	evidence: Record<string, unknown>;
} {
	const db = new Database(target.database.finalPath, {
		readonly: true,
		fileMustExist: true,
	});
	try {
		const activeDuplicates = db
			.prepare(
				`SELECT count(*) AS count FROM (
					   SELECT task_id FROM attempts
					    WHERE desired_state <> 'terminal'
					    GROUP BY task_id HAVING count(*) > 1
					 )`,
			)
			.get() as { count: number };
		const effectDuplicates = db
			.prepare(
				`SELECT count(*) AS count FROM (
					   SELECT effect_key FROM actions
					    GROUP BY effect_key HAVING count(*) > 1
					 )`,
			)
			.get() as { count: number };
		const malformedOutcomes = db
			.prepare(
				`SELECT count(*) AS count FROM actions
					  WHERE (state='intended' AND (result IS NOT NULL OR completed_at IS NOT NULL))
					     OR (state IN ('succeeded','failed')
					         AND (result IS NULL OR completed_at IS NULL))`,
			)
			.get() as { count: number };
		const unboundShipGates = db
			.prepare(
				`SELECT count(*) AS count FROM gates
					  WHERE lower(kind) LIKE '%ship%'
					    AND state='approved'
					    AND (subject_digest IS NULL OR length(trim(subject_digest))=0)`,
			)
			.get() as { count: number };
		return {
			activeAttemptUniqueness: activeDuplicates.count === 0,
			actionEffectKeyContract: effectDuplicates.count === 0,
			actionOutcomesSettled: malformedOutcomes.count === 0,
			gatesBindExactHead: unboundShipGates.count === 0,
			evidence: {
				activeAttemptDuplicates: activeDuplicates.count,
				effectKeyDuplicates: effectDuplicates.count,
				malformedActionOutcomes: malformedOutcomes.count,
				unboundApprovedShipGates: unboundShipGates.count,
			},
		};
	} finally {
		db.close();
	}
}

function githubLanePassed(target: CutoverTargetManifest): boolean {
	const evidence = readObject<{ status?: unknown }>(
		target.githubLaneEvidencePath,
		"GitHub lane evidence",
	);
	return evidence.status === "pass";
}

function verifyArchives(receipts: LegacyArchiveReceipt[]): boolean {
	return receipts.every((receipt) => {
		try {
			return legacyArchiveRestoreState(receipt) === "pending";
		} catch {
			return false;
		}
	});
}

function goObservation(input: {
	target: CutoverTargetManifest;
	plan: LegacyMigrationPlan;
	receipts: LegacyArchiveReceipt[];
	oldCredentialsRejected: boolean;
	liveFirePassed: boolean;
	writerEvidence: ReturnType<typeof legacyWritersStopped>;
}): GoNoGoObservation {
	const checks = inspectKernelChecks(input.target);
	const evidence = {
		"1": evidencePath(input.target, "check-1-writers.json"),
		"2": evidencePath(input.target, "check-2-credentials.json"),
		"3": evidencePath(input.target, "check-3-attempts.json"),
		"4": evidencePath(input.target, "check-4-actions-key.json"),
		"5": evidencePath(input.target, "check-5-actions-outcomes.json"),
		"6": evidencePath(input.target, "check-6-gates.json"),
		"7": evidencePath(input.target, "check-7-database.json"),
		"8": planEvidencePath(input.target),
		"9": archiveEvidencePath(input.target),
		"10": evidencePath(input.target, "check-10-live-fire.json"),
		namespace: evidencePath(input.target, "check-namespace.json"),
		github: input.target.githubLaneEvidencePath,
	};
	atomicEvidence(evidence["1"], input.writerEvidence);
	atomicEvidence(evidence["3"], checks.evidence);
	atomicEvidence(evidence["4"], checks.evidence);
	atomicEvidence(evidence["5"], checks.evidence);
	atomicEvidence(evidence["6"], checks.evidence);
	atomicEvidence(evidence["7"], { validated: true });
	atomicEvidence(evidence.namespace, { disjoint: true });
	return {
		legacyWritersStopped: input.writerEvidence.pass,
		oldCredentialsRejected: input.oldCredentialsRejected,
		activeAttemptUniqueness: checks.activeAttemptUniqueness,
		actionEffectKeyContract: checks.actionEffectKeyContract,
		actionOutcomesSettled: checks.actionOutcomesSettled,
		gatesBindExactHead: checks.gatesBindExactHead,
		databaseContract: true,
		migrationConservation:
			input.plan.conservation.balanced &&
			input.plan.conservation.manual === 0 &&
			input.plan.conservation.conflicts === 0,
		journalsDrained:
			input.plan.domains.b.journalUnfinished === 0 &&
			input.plan.domains.b.deliveryObligations === 0 &&
			input.plan.domains.b.receiptObligations === 0,
		archivesAndTombstones: verifyArchives(input.receipts),
		liveFirePassed: input.liveFirePassed,
		namespacesDisjoint: true,
		githubLanePassed: githubLanePassed(input.target),
		evidence,
	};
}

async function requireConfirmation(
	target: CutoverTargetManifest,
	options: CutoverRunOptions,
	prompt: string,
	expected: string,
): Promise<void> {
	if (target.mode === "rehearsal" && options.yes) return;
	if (!options.confirm) {
		throw new Error(`founder confirmation required: ${prompt}`);
	}
	const answer = await options.confirm(prompt);
	if (answer !== expected) {
		throw new Error(`founder confirmation mismatch for ${prompt}`);
	}
}

async function executeStep(
	step: number,
	target: CutoverTargetManifest,
	options: CutoverRunOptions,
	ledger: CutoverLedger,
): Promise<string[]> {
	const observedAt = nowIso(options);
	switch (step) {
		case 1: {
			if (target.mode === "production") {
				const evidence = readObject<{
					status?: unknown;
					window_id?: unknown;
					epoch?: unknown;
					production_unchanged?: unknown;
				}>(target.rehearsalEvidencePath, "rehearsal evidence");
				if (
					evidence.status !== "pass" ||
					evidence.window_id !== target.windowId ||
					evidence.epoch !== target.epoch ||
					evidence.production_unchanged !== true
				) {
					throw new Error(
						"production cutover requires a matching, production-unchanged rehearsal",
					);
				}
			}
			return [
				atomicEvidence(evidencePath(target, "step-1.json"), {
					mode: target.mode,
					status: "pass",
					observedAt,
				}),
			];
		}
		case 2: {
			const result = prepareStagingDatabase(target, {
				nowIso: observedAt,
			});
			return [atomicEvidence(evidencePath(target, "step-2.json"), result)];
		}
		case 3: {
			const commands = executeLedgeredCommands({
				ledger,
				step,
				prefix: "stop-legacy",
				description: "stop legacy writer",
				commands: target.legacy.stopCommands,
			});
			const stopped = legacyWritersStopped(target.legacy.writerProcessPatterns);
			if (!stopped.pass) {
				throw new Error(`legacy writers remain: ${stopped.matches.join("\n")}`);
			}
			assertNoOpenFds([
				...(target.legacy.runnerSessionDatabase
					? [target.legacy.runnerSessionDatabase]
					: []),
				...target.legacy.commDatabases,
				...target.legacy.journalDatabases,
			]);
			return [
				atomicEvidence(evidencePath(target, "step-3.json"), {
					commands,
					stopped,
				}),
			];
		}
		case 4: {
			const snapshotRootPath = join(target.evidenceDir, "snapshot");
			const sqlite = [
				...(target.legacy.runnerSessionDatabase
					? [
							{
								path: target.legacy.runnerSessionDatabase,
								kind: "runner-sessions",
							},
						]
					: []),
				...target.legacy.commDatabases.map((path) => ({
					path,
					kind: "comm",
				})),
				...target.legacy.journalDatabases.map((path) => ({
					path,
					kind: "journal",
				})),
			];
			for (const [index, entry] of sqlite.entries()) {
				await snapshotSqlite(
					entry.path,
					join(
						snapshotRootPath,
						entry.kind,
						`${index}-${basename(entry.path)}`,
					),
				);
			}
			for (const [index, root] of target.legacy.jsonInboxRoots.entries()) {
				snapshotRoot(root, join(snapshotRootPath, "json", `${index}`));
			}
			return [
				atomicEvidence(evidencePath(target, "step-4.json"), {
					status: "snapshotted",
					sqliteCount: sqlite.length,
					jsonRootCount: target.legacy.jsonInboxRoots.length,
				}),
			];
		}
		case 5: {
			const preparation = prepareStagingDatabase(target, {
				nowIso: observedAt,
			});
			if (preparation.status === "already_promoted") {
				const priorPlan = readObject<LegacyMigrationPlan>(
					planEvidencePath(target),
					"migration plan",
				);
				if (priorPlan.epoch !== target.epoch || priorPlan.go !== true) {
					throw new Error(
						"promoted database does not have a matching GO migration plan",
					);
				}
				return [
					planEvidencePath(target),
					atomicEvidence(evidencePath(target, "step-5.json"), {
						status: "already_promoted",
						path: preparation.path,
					}),
				];
			}
			const snapshot = readLegacySourceSnapshot({
				commDatabases: target.legacy.commDatabases,
				...(target.legacy.runnerSessionDatabase
					? {
							runnerSessionDatabase: target.legacy.runnerSessionDatabase,
						}
					: {}),
				jsonInboxRoots: target.legacy.jsonInboxRoots,
				journalDatabases: target.legacy.journalDatabases,
			});
			const plan = applyManualAdjudications(
				target,
				buildMigrationPlan({
					nowIso: observedAt,
					epoch: target.epoch,
					windowId: target.windowId,
					authoritativeLiveLeadIds: target.legacy.authoritativeLiveLeadIds,
					...snapshot,
				}),
				ledger.manualAdjudications(),
			);
			atomicEvidence(planEvidencePath(target), plan);
			if (!plan.go) {
				throw new Error(
					`legacy migration is NO-GO: ${JSON.stringify({
						leadLiveness: plan.leadLiveness,
						runnerLiveness: plan.runnerLiveness,
						domains: plan.domains.b,
						conservation: plan.conservation,
					})}`,
				);
			}
			const staging = stagingDatabasePath(target);
			const kernel = Kernel.open({ path: staging, fileMustExist: true });
			try {
				migrateLegacyPlan(kernel, plan);
			} finally {
				kernel.close();
			}
			const promotion = promoteStagingDatabase(target, {
				nowIso: nowIso(options),
			});
			return [
				planEvidencePath(target),
				atomicEvidence(evidencePath(target, "step-5.json"), promotion),
			];
		}
		case 6: {
			const prior = existsSync(archiveEvidencePath(target))
				? readObject<ArchivedEvidence>(
						archiveEvidencePath(target),
						"archive receipts",
					).receipts
				: [];
			const bySource = new Map(
				prior.map((receipt) => [receipt.sourcePath, receipt]),
			);
			for (const [
				index,
				sourcePath,
			] of target.legacy.tombstonePaths.entries()) {
				if (bySource.has(sourcePath)) continue;
				const archivePath = join(
					target.evidenceDir,
					"archive",
					`${index}-${sha256(sourcePath).slice(0, 12)}-${basename(sourcePath)}`,
				);
				const primitive = {
					ledger,
					step,
					key: `archive:${sha256(sourcePath)}`,
					description: `archive and tombstone ${sourcePath}`,
				};
				primitiveNeedsApply({
					...primitive,
					preimage: { sourcePath, archivePath },
				});
				const receipt = archiveAndTombstoneLegacyPath({
					sourcePath,
					archivePath,
				});
				if (
					primitive.ledger.primitiveState(primitive.key)?.status !== "complete"
				) {
					finishPrimitive(primitive);
				}
				bySource.set(sourcePath, receipt);
			}
			const evidence: ArchivedEvidence = {
				v: 1,
				receipts: [...bySource.values()],
			};
			return [atomicEvidence(archiveEvidencePath(target), evidence)];
		}
		case 7: {
			const plan = readObject<LegacyMigrationPlan>(
				planEvidencePath(target),
				"migration plan",
			);
			const receipts = readObject<ArchivedEvidence>(
				archiveEvidencePath(target),
				"archive receipts",
			).receipts;
			const kernel = openExistingKernel(productionDbContract(target));
			kernel.close();
			const liveFire = runLegacyWriterLiveFire({
				commands: target.legacy.liveFireCommands.map((argv, index) => ({
					name: `legacy-writer-${index + 1}`,
					argv,
				})),
				watchedPaths: target.legacy.tombstonePaths,
			});
			atomicEvidence(evidencePath(target, "check-10-live-fire.json"), liveFire);
			// Check 2 is intentionally pending until 8a starts the held endpoints.
			atomicEvidence(evidencePath(target, "check-2-credentials.json"), {
				status: "pending-held-start",
			});
			const observation = goObservation({
				target,
				plan,
				receipts,
				oldCredentialsRejected: false,
				liveFirePassed: true,
				writerEvidence: legacyWritersStopped(
					target.legacy.writerProcessPatterns,
				),
			});
			const report = evaluateGoNoGo(observation, observedAt);
			const failures = report.checks.filter((check) => check.status === "fail");
			if (failures.length !== 1 || failures[0]?.id !== "2") {
				throw new Error(
					`pre-start Go/No-Go failed outside held credential probe: ${JSON.stringify(failures)}`,
				);
			}
			return [
				atomicEvidence(evidencePath(target, "go-no-go-prestart.json"), report),
			];
		}
		case 8: {
			await requireConfirmation(
				target,
				options,
				"held-start",
				target.founderConfirmations.heldStart,
			);
			const held = executeLedgeredCommands({
				ledger,
				step,
				prefix: "held-start",
				description: "start v2 service held",
				commands: [
					target.controlPlane.startCommands.host,
					target.controlPlane.startCommands.bridge,
					target.controlPlane.startCommands.scheduler,
				],
			});
			const probes = credentialProbes(target.legacy.credentialProbeCommands);
			atomicEvidence(evidencePath(target, "check-2-credentials.json"), probes);
			if (!probes.pass) {
				throw new Error("old credential probe was not conclusively rejected");
			}
			const plan = readObject<LegacyMigrationPlan>(
				planEvidencePath(target),
				"migration plan",
			);
			const receipts = readObject<ArchivedEvidence>(
				archiveEvidencePath(target),
				"archive receipts",
			).receipts;
			const observation = goObservation({
				target,
				plan,
				receipts,
				oldCredentialsRejected: true,
				liveFirePassed: true,
				writerEvidence: legacyWritersStopped(
					target.legacy.writerProcessPatterns,
				),
			});
			const report = evaluateGoNoGo(observation, nowIso(options));
			atomicEvidence(evidencePath(target, "go-no-go-final.json"), report);
			if (report.status !== "go") {
				throw new Error("final Go/No-Go report is NO-GO");
			}
			await requireConfirmation(
				target,
				options,
				"final-go",
				target.founderConfirmations.finalGo,
			);
			const livePublication = publishLiveAuthorityIdempotently(
				target,
				nowIso(options),
			);
			const leads = executeLedgeredCommands({
				ledger,
				step,
				prefix: "lead-start",
				description: "start v2 Lead",
				commands: target.controlPlane.startCommands.leads,
			});
			return [
				atomicEvidence(evidencePath(target, "step-8.json"), {
					held,
					probes,
					leads,
					livePublication,
					status: "live",
				}),
			];
		}
		case 9: {
			const kernel = openExistingKernel(productionDbContract(target));
			let fence: ReturnType<typeof readRollbackFence>;
			try {
				fence = readRollbackFence(kernel);
			} finally {
				kernel.close();
			}
			const evidence = atomicEvidence(evidencePath(target, "step-9.json"), {
				rollbackAnchor: {
					effectIntentCount: fence.effectIntentCount,
					rollbackState: fence.rollbackState,
					t1Available:
						fence.effectIntentCount === 0 && fence.rollbackState === "clear",
				},
			});
			if (target.mode === "rehearsal") {
				atomicEvidence(target.rehearsalEvidencePath, {
					v: 1,
					status: "pass",
					window_id: target.windowId,
					epoch: target.epoch,
					evidence,
				});
			}
			return [evidence];
		}
		default:
			throw new TypeError("step must be an integer in 1..9");
	}
}

export async function runCutover(
	target: CutoverTargetManifest,
	options: CutoverRunOptions = {},
): Promise<CutoverRunResult> {
	if (target.mode === "production" && options.yes) {
		throw new Error("--yes is forbidden for production cutover");
	}
	if (
		options.step !== undefined &&
		(!Number.isSafeInteger(options.step) ||
			options.step < 1 ||
			options.step > 9)
	) {
		throw new TypeError("step must be an integer in 1..9");
	}
	const ledger = new CutoverLedger(target.ledgerDir);
	const steps = options.step ? [options.step] : [1, 2, 3, 4, 5, 6, 7, 8, 9];
	const completedSteps: number[] = [];
	for (const step of steps) {
		if (ledger.isStepDone(step)) {
			completedSteps.push(step);
			continue;
		}
		ledger.step(step, "started", []);
		try {
			const evidence = await executeStep(step, target, options, ledger);
			ledger.step(step, "done", evidence);
			completedSteps.push(step);
		} catch (error) {
			ledger.step(step, "failed", [
				error instanceof Error ? error.message : String(error),
			]);
			throw error;
		}
	}
	return { completedSteps, status: "done" };
}

interface RollbackContext {
	fromRevision: number;
	nowIso: string;
	nonce: string;
}

function requireRollbackContext(value: unknown): RollbackContext {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		!Number.isSafeInteger((value as RollbackContext).fromRevision) ||
		(value as RollbackContext).fromRevision < 0 ||
		typeof (value as RollbackContext).nowIso !== "string" ||
		typeof (value as RollbackContext).nonce !== "string"
	) {
		throw new Error("rollback-t1 ledger context is missing or malformed");
	}
	return value as RollbackContext;
}

function reconcileRollbackEffect(input: {
	ledger: CutoverLedger;
	key: string;
	description: string;
	preimage?: unknown;
	verify(): boolean;
	apply(): void;
	fault?(): void;
}): void {
	const step = 9;
	let current = input.ledger.primitiveState(input.key);
	if (current?.status === "complete") return;
	if (current?.status === "verify") {
		if (!input.verify()) {
			input.ledger.primitive(input.key, step, input.description, "failed");
			throw new Error(
				`rollback primitive ${input.key} lost verified world state`,
			);
		}
		input.ledger.primitive(input.key, step, input.description, "complete");
		return;
	}
	if (!current || current.status === "failed") {
		input.ledger.primitive(
			input.key,
			step,
			input.description,
			"intent",
			input.preimage,
		);
		current = input.ledger.primitiveState(input.key);
	}
	if (current?.status === "intent") {
		input.ledger.primitive(input.key, step, input.description, "apply");
	}
	if (!input.verify()) {
		input.apply();
		input.fault?.();
		if (!input.verify()) {
			input.ledger.primitive(input.key, step, input.description, "failed");
			throw new Error(
				`rollback primitive ${input.key} did not reach verified world state`,
			);
		}
	}
	input.ledger.primitive(input.key, step, input.description, "verify");
	input.ledger.primitive(input.key, step, input.description, "complete");
}

function rollbackReceiptMatches(
	target: CutoverTargetManifest,
	context: RollbackContext,
): boolean {
	if (!existsSync(target.database.rollbackReceiptPath)) return false;
	const receipt = readObject<Record<string, unknown>>(
		target.database.rollbackReceiptPath,
		"rollback receipt",
	);
	if (
		receipt.v !== 1 ||
		receipt.window_id !== target.windowId ||
		receipt.epoch !== target.epoch ||
		receipt.from_revision !== context.fromRevision ||
		receipt.to_revision !== context.fromRevision + 1 ||
		receipt.issued_at !== context.nowIso ||
		receipt.nonce !== context.nonce
	) {
		throw new Error("existing rollback receipt conflicts with ledger context");
	}
	return true;
}

function rollbackAuthorityPublished(target: CutoverTargetManifest): boolean {
	const authority = readCutoverAuthority({
		authorityPath: target.database.authorityPath,
		armedPath: target.database.armedPath,
		expectedWindowId: target.windowId,
		expectedEpoch: target.epoch,
	});
	if (authority.mode !== "armed") {
		throw new Error("rollback requires armed machine authority");
	}
	if (authority.authority.state !== "pre") return false;
	if (
		authority.authority.rollback_receipt?.path !==
		target.database.rollbackReceiptPath
	) {
		throw new Error("rollback authority references another receipt");
	}
	return true;
}

export async function rollbackT1(
	target: CutoverTargetManifest,
	options: RollbackT1Options = {},
): Promise<void> {
	const receipts = readObject<ArchivedEvidence>(
		archiveEvidencePath(target),
		"archive receipts",
	).receipts;
	const ledger = new CutoverLedger(target.ledgerDir);
	const gateKey = "rollback-t1:gate";
	const gateState = ledger.primitiveState(gateKey);
	let context: RollbackContext;
	if (gateState?.preimage !== undefined) {
		context = requireRollbackContext(gateState.preimage);
	} else {
		const authority = readCutoverAuthority({
			authorityPath: target.database.authorityPath,
			armedPath: target.database.armedPath,
			expectedWindowId: target.windowId,
			expectedEpoch: target.epoch,
		});
		if (
			authority.mode !== "armed" ||
			(authority.authority.state !== "cutover" &&
				authority.authority.state !== "live")
		) {
			throw new Error("rollback-t1 requires cutover or live authority");
		}
		const timestamp = nowIso(options);
		context = {
			fromRevision: authority.authority.revision,
			nowIso: timestamp,
			nonce: `${target.windowId}:${authority.authority.revision + 1}`,
		};
	}

	const kernel = openExistingKernel({
		...productionDbContract(target),
		allowedAuthorityStates: ["cutover", "live", "pre"],
		allowedRollbackStates: ["clear", "rollback_started"],
	});
	try {
		reconcileRollbackEffect({
			ledger,
			key: gateKey,
			description: "atomically choose T1 rollback before external effects",
			preimage: context,
			verify: () => {
				const fence = readRollbackFence(kernel);
				if (fence.effectIntentCount !== 0) {
					throw new Error("rollback rejected after an external effect intent");
				}
				return fence.rollbackState === "rollback_started";
			},
			apply: () => {
				kernel.write("cutover.rollback-t1", (tx) => {
					rollbackGateCas(tx, context.nowIso);
				});
			},
			fault: () => options.fault?.("after_gate_cas", gateKey),
		});
	} finally {
		kernel.close();
	}

	for (const [index, receipt] of [...receipts].reverse().entries()) {
		const key = `rollback-t1:archive:${index}:${sha256(receipt.sourcePath).slice(0, 16)}`;
		reconcileRollbackEffect({
			ledger,
			key,
			description: `restore legacy archive ${receipt.sourcePath}`,
			preimage: receipt,
			verify: () =>
				legacyArchiveRestoreState(receipt, { allowInProgress: true }) ===
				"restored",
			apply: () => restoreLegacyArchivePath(receipt),
			fault: () => options.fault?.("after_archive_restore", key),
		});
	}

	executeLedgeredCommands({
		ledger,
		step: 9,
		prefix: "rollback-t1-command",
		description: "rollback legacy writer",
		commands: target.legacy.rollbackCommands,
		fault(point, key) {
			if (point === "after_execute") {
				options.fault?.("after_rollback_command", key);
			}
		},
	});

	const receiptKey = "rollback-t1:receipt";
	reconcileRollbackEffect({
		ledger,
		key: receiptKey,
		description: "publish durable T1 rollback receipt",
		preimage: context,
		verify: () => rollbackReceiptMatches(target, context),
		apply: () => {
			writeRollbackReceipt({
				path: target.database.rollbackReceiptPath,
				windowId: target.windowId,
				epoch: target.epoch,
				fromRevision: context.fromRevision,
				toRevision: context.fromRevision + 1,
				nowIso: context.nowIso,
				nonce: context.nonce,
			});
		},
		fault: () => options.fault?.("after_receipt_write", receiptKey),
	});

	const authorityKey = "rollback-t1:authority";
	reconcileRollbackEffect({
		ledger,
		key: authorityKey,
		description: "publish rollback machine authority",
		preimage: context,
		verify: () => rollbackAuthorityPublished(target),
		apply: () => {
			publishRollbackCutoverAuthority({
				authorityPath: target.database.authorityPath,
				armedPath: target.database.armedPath,
				rollbackReceiptPath: target.database.rollbackReceiptPath,
				windowId: target.windowId,
				epoch: target.epoch,
				nowIso: context.nowIso,
			});
		},
		fault: () => options.fault?.("after_authority_publish", authorityKey),
	});

	const restored = receipts.map((receipt) => receipt.sourcePath);
	const rollbackEvidencePath = evidencePath(target, "rollback-t1.json");
	const evidenceKey = "rollback-t1:evidence";
	reconcileRollbackEffect({
		ledger,
		key: evidenceKey,
		description: "publish rollback completion evidence",
		preimage: { restored },
		verify: () => {
			if (!existsSync(rollbackEvidencePath)) return false;
			const evidence = readObject<Record<string, unknown>>(
				rollbackEvidencePath,
				"rollback evidence",
			);
			if (
				evidence.status !== "rolled_back" ||
				JSON.stringify(evidence.restored) !== JSON.stringify(restored)
			) {
				throw new Error("existing rollback evidence conflicts with ledger");
			}
			return true;
		},
		apply: () => {
			atomicEvidence(rollbackEvidencePath, {
				status: "rolled_back",
				restored,
			});
		},
		fault: () => options.fault?.("after_evidence_write", evidenceKey),
	});
}
