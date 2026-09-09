import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { compileLeadIdentityRows } from "../lead-identity.js";
import {
	LeadRegistryAddError,
	type LeadRegistryAddInput,
	planLeadRegistryAdd,
} from "../lead-registry-add.js";
import {
	LeadRegistryCoSContextError,
	planLeadRegistryCoSContextImport,
} from "../lead-registry-cos-context.js";
import {
	classifyRecovery,
	LeadRegistryRecoveryError,
} from "../lead-registry-recover.js";
import { compileSummaryAssignments } from "../summary-assignment.js";
import { readSummaryGranularity } from "../summary-config.js";
import {
	migrateSummaryRegistry,
	type SummaryMigrationReceipt,
	SummaryRegistryError,
	verifySummaryRegistryActivation,
} from "../summary-registry-migration.js";

export interface LeadRegistryCommandDeps {
	stdout?: (line: string) => void;
	stderr?: (line: string) => void;
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	validateTeamleadCandidate?: (candidatePath: string) => void;
	now?: () => string;
	afterProjectsRename?: () => void;
}

class LeadRegistryCommandError extends Error {
	constructor(
		readonly code: string,
		readonly exitCode: 64 | 70 | 75 | 78,
		message: string,
	) {
		super(`${code}: ${message}`);
		this.name = "LeadRegistryCommandError";
	}
}

function required(value: string | undefined, name: string): string {
	if (!value) {
		throw new LeadRegistryCommandError(
			"lead_registry_usage",
			64,
			`${name} is required`,
		);
	}
	return value;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function writeDurableFile(path: string, contents: string, mode: number): void {
	const fd = openSync(path, "wx", mode);
	try {
		writeSync(fd, contents);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function fsyncDirectory(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function pathEntryExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function writeAtomic(path: string, contents: string, mode = 0o600): void {
	const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	try {
		writeDurableFile(temp, contents, mode);
		renameSync(temp, path);
		fsyncDirectory(dirname(path));
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {}
		throw error;
	}
}

function readRegularFileNoFollow(
	path: string,
	label: string,
	ownerOnly = false,
): string {
	let parent: ReturnType<typeof lstatSync>;
	try {
		parent = lstatSync(dirname(path));
	} catch (error) {
		throw new LeadRegistryCommandError(
			"lead_registry_source_invalid",
			78,
			`${label} parent cannot be inspected: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!parent.isDirectory() || parent.isSymbolicLink()) {
		throw new LeadRegistryCommandError(
			"lead_registry_source_invalid",
			78,
			`${label} parent must be a real directory`,
		);
	}
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		throw new LeadRegistryCommandError(
			"lead_registry_source_invalid",
			78,
			`${label} cannot be opened without following links: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) {
			throw new LeadRegistryCommandError(
				"lead_registry_source_invalid",
				78,
				`${label} must be a regular file`,
			);
		}
		if (ownerOnly && (stat.mode & 0o077) !== 0) {
			throw new LeadRegistryCommandError(
				"lead_registry_source_invalid",
				78,
				`${label} must be owner-only (0600 or stricter)`,
			);
		}
		return readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
}

function readJsonNoFollow<T>(
	path: string,
	label: string,
	ownerOnly = false,
): {
	text: string;
	value: T;
} {
	const text = readRegularFileNoFollow(path, label, ownerOnly);
	try {
		return { text, value: JSON.parse(text) as T };
	} catch (error) {
		throw new LeadRegistryCommandError(
			"lead_registry_source_invalid",
			78,
			`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function optionalCsv(
	value: string | undefined,
	name: string,
): string[] | undefined {
	if (value === undefined) return undefined;
	const rows = value.split(",").map((row) => row.trim());
	if (rows.length === 0 || rows.some((row) => row.length === 0)) {
		throw new LeadRegistryCommandError(
			"lead_registry_usage",
			64,
			`${name} must be a non-empty comma-separated list`,
		);
	}
	return rows;
}

function optionalBoolean(
	value: string | undefined,
	name: string,
): boolean | undefined {
	if (value === undefined) return undefined;
	if (value === "true") return true;
	if (value === "false") return false;
	throw new LeadRegistryCommandError(
		"lead_registry_usage",
		64,
		`${name} must be true or false`,
	);
}

function optionalDiscordSnowflake(
	value: string | undefined,
	name: string,
): string | undefined {
	if (value === undefined) return undefined;
	if (!/^\d{17,20}$/u.test(value)) {
		throw new LeadRegistryCommandError(
			"lead_registry_usage",
			64,
			`${name} must be a 17-20 digit Discord snowflake`,
		);
	}
	return value;
}

function optionalEnvName(
	value: string | undefined,
	name: string,
): string | undefined {
	if (value === undefined) return undefined;
	if (!/^[A-Z_][A-Z0-9_]*$/u.test(value)) {
		throw new LeadRegistryCommandError(
			"lead_registry_usage",
			64,
			`${name} must be an uppercase environment variable name`,
		);
	}
	return value;
}

function defaultTeamleadValidator(
	candidatePath: string,
	env: NodeJS.ProcessEnv,
): void {
	const packagesDir = join(dirname(fileURLToPath(import.meta.url)), "../../..");
	const validator =
		env.FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR ??
		join(packagesDir, "teamlead", "dist", "bin", "validate-projects.js");
	if (!existsSync(validator)) {
		throw new LeadRegistryCommandError(
			"lead_registry_validator_missing",
			78,
			`TeamLead projects validator is missing: ${validator}`,
		);
	}
	const result = spawnSync(process.execPath, [validator, candidatePath], {
		encoding: "utf8",
		env,
	});
	if (result.error || result.status !== 0) {
		throw new LeadRegistryCommandError(
			"lead_registry_candidate_invalid",
			78,
			`TeamLead validator rejected candidate: ${result.error?.message ?? result.stderr.trim() ?? `exit ${result.status}`}`,
		);
	}
}

function assignmentManifest(
	candidateRegistry: unknown,
	homeDir: string,
): string {
	const projection = compileSummaryAssignments(
		candidateRegistry,
		readSummaryGranularity({ homeDir }),
	);
	return `${JSON.stringify(
		{
			assignments: projection.leads.map((row) => ({
				projectName: row.projectName,
				leadId: row.leadId,
				summaryRole: row.summaryRole,
			})),
			projectAggregators: projection.projectAggregators,
		},
		null,
		2,
	)}\n`;
}

function parseAddInput(args: string[]): {
	input: LeadRegistryAddInput;
	projectsPath?: string;
	receiptPath?: string;
	summaryConfigHome?: string;
	dryRun: boolean;
} {
	const { values } = parseArgs({
		args,
		options: {
			"project-name": { type: "string" },
			"project-root": { type: "string" },
			"project-repo": { type: "string" },
			"general-channel": { type: "string" },
			"memory-allowed-users": { type: "string" },
			"lead-id": { type: "string" },
			"chat-channel": { type: "string" },
			"bot-token-env": { type: "string" },
			"bot-user-id": { type: "string" },
			harness: { type: "string" },
			model: { type: "string" },
			effort: { type: "string" },
			"model-context-window": { type: "string" },
			"summary-role": { type: "string" },
			labels: { type: "string" },
			"can-spawn-runners": { type: "string" },
			"roundtable-channel": { type: "string" },
			"alert-channel": { type: "string" },
			"alert-bot-token-env": { type: "string" },
			"alert-fallback-to-core": { type: "string" },
			"projects-file": { type: "string" },
			"receipt-file": { type: "string" },
			"summary-config-home": { type: "string" },
			"dry-run": { type: "boolean" },
		},
		allowPositionals: false,
	});
	const harness = required(values.harness, "--harness");
	if (harness !== "claude" && harness !== "codex") {
		throw new LeadRegistryCommandError(
			"lead_registry_usage",
			64,
			"--harness must be claude or codex",
		);
	}
	const effort = values.effort;
	if (
		effort !== undefined &&
		effort !== "low" &&
		effort !== "medium" &&
		effort !== "high" &&
		effort !== "xhigh" &&
		effort !== "max"
	) {
		throw new LeadRegistryCommandError(
			"lead_registry_usage",
			64,
			"--effort must be low|medium|high|xhigh|max",
		);
	}
	const summaryRole = values["summary-role"];
	if (
		summaryRole !== undefined &&
		summaryRole !== "recipient" &&
		summaryRole !== "producer" &&
		summaryRole !== "exempt"
	) {
		throw new LeadRegistryCommandError(
			"lead_registry_usage",
			64,
			"--summary-role must be recipient|producer|exempt",
		);
	}
	let modelContextWindow: number | undefined;
	if (values["model-context-window"] !== undefined) {
		modelContextWindow = Number(values["model-context-window"]);
		if (!Number.isSafeInteger(modelContextWindow) || modelContextWindow < 1) {
			throw new LeadRegistryCommandError(
				"lead_registry_usage",
				64,
				"--model-context-window must be a positive integer",
			);
		}
	}
	return {
		input: {
			projectName: required(values["project-name"], "--project-name"),
			projectRoot: required(values["project-root"], "--project-root"),
			...(values["project-repo"] !== undefined
				? { projectRepo: values["project-repo"] }
				: {}),
			...(values["general-channel"] !== undefined
				? { generalChannel: values["general-channel"] }
				: {}),
			...(optionalCsv(
				values["memory-allowed-users"],
				"--memory-allowed-users",
			) !== undefined
				? {
						memoryAllowedUsers: optionalCsv(
							values["memory-allowed-users"],
							"--memory-allowed-users",
						),
					}
				: {}),
			leadId: required(values["lead-id"], "--lead-id"),
			chatChannel: required(values["chat-channel"], "--chat-channel"),
			botTokenEnv: required(values["bot-token-env"], "--bot-token-env"),
			botUserId: required(values["bot-user-id"], "--bot-user-id"),
			harness,
			...(values.model !== undefined ? { model: values.model } : {}),
			...(effort !== undefined ? { effort } : {}),
			...(modelContextWindow !== undefined ? { modelContextWindow } : {}),
			...(summaryRole !== undefined ? { summaryRole } : {}),
			...(optionalCsv(values.labels, "--labels") !== undefined
				? { labels: optionalCsv(values.labels, "--labels") }
				: {}),
			...(optionalBoolean(
				values["can-spawn-runners"],
				"--can-spawn-runners",
			) !== undefined
				? {
						canSpawnRunners: optionalBoolean(
							values["can-spawn-runners"],
							"--can-spawn-runners",
						),
					}
				: {}),
			...(optionalDiscordSnowflake(
				values["roundtable-channel"],
				"--roundtable-channel",
			) !== undefined
				? {
						roundtableChannel: optionalDiscordSnowflake(
							values["roundtable-channel"],
							"--roundtable-channel",
						),
					}
				: {}),
			...(optionalDiscordSnowflake(
				values["alert-channel"],
				"--alert-channel",
			) !== undefined
				? {
						alertChannel: optionalDiscordSnowflake(
							values["alert-channel"],
							"--alert-channel",
						),
					}
				: {}),
			...(optionalEnvName(
				values["alert-bot-token-env"],
				"--alert-bot-token-env",
			) !== undefined
				? {
						alertBotTokenEnv: optionalEnvName(
							values["alert-bot-token-env"],
							"--alert-bot-token-env",
						),
					}
				: {}),
			...(optionalBoolean(
				values["alert-fallback-to-core"],
				"--alert-fallback-to-core",
			) !== undefined
				? {
						alertFallbackToCore: optionalBoolean(
							values["alert-fallback-to-core"],
							"--alert-fallback-to-core",
						),
					}
				: {}),
		},
		projectsPath: values["projects-file"],
		receiptPath: values["receipt-file"],
		summaryConfigHome: values["summary-config-home"],
		dryRun: values["dry-run"] ?? false,
	};
}

function runAdd(
	args: string[],
	deps: LeadRegistryCommandDeps,
	homeDir: string,
	stdout: (line: string) => void,
): number {
	const parsed = parseAddInput(args);
	const summaryConfigHome = parsed.summaryConfigHome ?? homeDir;
	const projectsPath =
		parsed.projectsPath ?? join(homeDir, ".flywheel", "projects.json");
	const receiptPath =
		parsed.receiptPath ??
		join(
			homeDir,
			".flywheel",
			"state",
			"summary-registry",
			"migration-receipt.json",
		);
	const intentPath = `${receiptPath}.lead-registry-intent.json`;
	if (pathEntryExists(intentPath)) {
		throw new LeadRegistryCommandError(
			"lead_registry_recovery_required",
			78,
			`recovery intent exists: ${intentPath}; run lead-registry recover`,
		);
	}
	const source = readJsonNoFollow<unknown>(projectsPath, "projects registry");
	const receiptSource = readJsonNoFollow<SummaryMigrationReceipt>(
		receiptPath,
		"summary migration receipt",
	);
	const validator =
		deps.validateTeamleadCandidate ??
		((candidatePath: string) =>
			defaultTeamleadValidator(candidatePath, deps.env ?? process.env));
	const selection = readSummaryGranularity({ homeDir: summaryConfigHome });
	if (selection.state !== "selected" || selection.granularity !== "per-lead") {
		throw new LeadRegistryCommandError(
			"lead_registry_granularity_unsupported",
			78,
			"lead registry add requires summary migration granularity per-lead",
		);
	}
	try {
		verifySummaryRegistryActivation(
			{ projectsPath, receiptPath, homeDir: summaryConfigHome },
			{ validateTeamleadCandidate: validator },
		);
	} catch (error) {
		if (error instanceof LeadRegistryCommandError) throw error;
		throw new LeadRegistryCommandError(
			"lead_registry_preimage_stale",
			78,
			error instanceof Error ? error.message : String(error),
		);
	}
	const plan = planLeadRegistryAdd(
		source.value,
		receiptSource.value,
		selection,
		parsed.input,
	);
	const candidateTemp = join(
		dirname(projectsPath),
		`.${basename(projectsPath)}.lead-registry-validate.${randomUUID()}`,
	);
	try {
		writeDurableFile(
			candidateTemp,
			plan.candidateText,
			statSync(projectsPath).mode & 0o777,
		);
		try {
			validator(candidateTemp);
		} catch (error) {
			if (error instanceof LeadRegistryCommandError) throw error;
			throw new LeadRegistryCommandError(
				"lead_registry_candidate_invalid",
				78,
				error instanceof Error ? error.message : String(error),
			);
		}
	} finally {
		try {
			unlinkSync(candidateTemp);
		} catch {}
	}
	if (parsed.dryRun || plan.kind === "continuation") {
		stdout(
			JSON.stringify({
				ok: true,
				...(plan.kind === "continuation" ? { continuation: true } : {}),
				dryRun: parsed.dryRun,
				leadKey: plan.leadKey,
				candidate: JSON.parse(plan.candidateText),
				manifest: plan.manifest,
				planned: plan.planned,
				projectsFile: projectsPath,
				receiptFile: receiptPath,
			}),
		);
		return 0;
	}
	if ((deps.env ?? process.env).FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD !== "1") {
		throw new LeadRegistryCommandError(
			"lead_registry_lock_required",
			78,
			"FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD=1 is required",
		);
	}
	// Re-open both sources without following links immediately before mutation.
	const fencedProjects = readRegularFileNoFollow(
		projectsPath,
		"projects registry",
	);
	const fencedReceipt = readRegularFileNoFollow(
		receiptPath,
		"summary migration receipt",
	);
	if (sha256(fencedProjects) !== sha256(source.text)) {
		throw new LeadRegistryCommandError(
			"lead_registry_source_stale",
			78,
			"projects registry changed after planning",
		);
	}
	if (sha256(fencedReceipt) !== sha256(receiptSource.text)) {
		throw new LeadRegistryCommandError(
			"lead_registry_source_stale",
			78,
			"summary migration receipt changed after planning",
		);
	}
	const startedAt = deps.now?.() ?? new Date().toISOString();
	const backupStamp = startedAt.replace(/[-:.]/g, "");
	const projectsBackup = `${projectsPath}.bak-fly2444-${backupStamp}`;
	const receiptBackup = `${receiptPath}.bak-fly2444-${backupStamp}`;
	writeDurableFile(
		projectsBackup,
		fencedProjects,
		statSync(projectsPath).mode & 0o777,
	);
	writeDurableFile(
		receiptBackup,
		fencedReceipt,
		statSync(receiptPath).mode & 0o777,
	);
	const intent = {
		schemaVersion: 1 as const,
		phase: "pending" as const,
		leadKey: plan.leadKey,
		startedAt,
		projectsShaBefore: sha256(fencedProjects),
		receiptDigestBefore: receiptSource.value.summaryAssignmentDigest,
		projectsShaPlanned: plan.planned.projectsSha,
		receiptDigestPlanned: plan.planned.receiptDigest,
		backups: { projects: projectsBackup, receipt: receiptBackup },
	};
	writeAtomic(intentPath, `${JSON.stringify(intent, null, 2)}\n`);
	const assignmentsPath = join(
		dirname(receiptPath),
		`.lead-registry-assignments.${randomUUID()}.json`,
	);
	try {
		writeDurableFile(
			assignmentsPath,
			assignmentManifest(plan.candidateRegistry, summaryConfigHome),
			0o600,
		);
		const migrated = migrateSummaryRegistry(
			{
				projectsPath,
				assignmentsPath,
				receiptPath,
				expectedSha256: sha256(fencedProjects),
				homeDir: summaryConfigHome,
				candidateRegistry: plan.candidateRegistry,
			},
			{
				validateTeamleadCandidate: validator,
				now: deps.now,
				afterProjectsRename: deps.afterProjectsRename,
			},
		);
		if (
			sha256(readRegularFileNoFollow(projectsPath, "projects registry")) !==
				plan.planned.projectsSha ||
			migrated.summaryAssignmentDigest !== plan.planned.receiptDigest
		) {
			throw new Error(
				"lead registry landed hashes differ from the planned image",
			);
		}
		verifySummaryRegistryActivation(
			{ projectsPath, receiptPath, homeDir: summaryConfigHome },
			{ validateTeamleadCandidate: validator },
		);
		writeAtomic(
			intentPath,
			`${JSON.stringify(
				{
					...intent,
					phase: "done",
					projectsShaAfter: plan.planned.projectsSha,
					receiptDigestAfter: plan.planned.receiptDigest,
				},
				null,
				2,
			)}\n`,
		);
		unlinkSync(intentPath);
		fsyncDirectory(dirname(intentPath));
	} catch (error) {
		let rollbackError: unknown;
		try {
			writeAtomic(
				receiptPath,
				readRegularFileNoFollow(receiptBackup, "receipt backup"),
				statSync(receiptPath).mode & 0o777,
			);
			writeAtomic(
				projectsPath,
				readRegularFileNoFollow(projectsBackup, "projects backup"),
				statSync(projectsPath).mode & 0o777,
			);
			if (
				sha256(readRegularFileNoFollow(projectsPath, "projects registry")) !==
				intent.projectsShaBefore
			) {
				throw new Error("projects rollback hash mismatch");
			}
			const restoredReceipt = readJsonNoFollow<SummaryMigrationReceipt>(
				receiptPath,
				"summary migration receipt",
			);
			if (
				restoredReceipt.value.summaryAssignmentDigest !==
				intent.receiptDigestBefore
			) {
				throw new Error("receipt rollback digest mismatch");
			}
			verifySummaryRegistryActivation(
				{ projectsPath, receiptPath, homeDir: summaryConfigHome },
				{ validateTeamleadCandidate: validator },
			);
			unlinkSync(intentPath);
			fsyncDirectory(dirname(intentPath));
		} catch (caught) {
			rollbackError = caught;
		}
		if (rollbackError !== undefined) {
			throw new LeadRegistryCommandError(
				"lead_registry_rollback_failed",
				70,
				`${error instanceof Error ? error.message : String(error)}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}; backups: ${projectsBackup}, ${receiptBackup}`,
			);
		}
		throw new LeadRegistryCommandError(
			"lead_registry_rolled_back",
			70,
			error instanceof Error ? error.message : String(error),
		);
	} finally {
		try {
			unlinkSync(assignmentsPath);
		} catch {}
	}
	stdout(
		JSON.stringify({
			ok: true,
			leadKey: plan.leadKey,
			projectsFile: projectsPath,
			receiptFile: receiptPath,
			backups: { projects: projectsBackup, receipt: receiptBackup },
			effectiveAt: "next-bridge-restart",
		}),
	);
	return 0;
}

function removeIntent(intentPath: string): void {
	unlinkSync(intentPath);
	fsyncDirectory(dirname(intentPath));
}

function runImportCoSContext(
	args: string[],
	deps: LeadRegistryCommandDeps,
	homeDir: string,
	stdout: (line: string) => void,
): number {
	const { values } = parseArgs({
		args,
		options: {
			input: { type: "string" },
			"expected-projects-sha": { type: "string" },
			"expected-receipt-sha": { type: "string" },
			"projects-file": { type: "string" },
			"receipt-file": { type: "string" },
			"summary-config-home": { type: "string" },
			"dry-run": { type: "boolean" },
		},
		allowPositionals: false,
	});
	const inputPath = required(values.input, "--input");
	const expectedProjectsSha = required(
		values["expected-projects-sha"],
		"--expected-projects-sha",
	);
	const expectedReceiptSha = required(
		values["expected-receipt-sha"],
		"--expected-receipt-sha",
	);
	if (
		!/^[a-f0-9]{64}$/u.test(expectedProjectsSha) ||
		!/^[a-f0-9]{64}$/u.test(expectedReceiptSha)
	) {
		throw new LeadRegistryCommandError(
			"lead_registry_usage",
			64,
			"expected digests must be 64-character lowercase SHA-256 values",
		);
	}
	const summaryConfigHome = values["summary-config-home"] ?? homeDir;
	const projectsPath =
		values["projects-file"] ?? join(homeDir, ".flywheel", "projects.json");
	const receiptPath =
		values["receipt-file"] ??
		join(
			homeDir,
			".flywheel",
			"state",
			"summary-registry",
			"migration-receipt.json",
		);
	const intentPath = `${receiptPath}.lead-registry-intent.json`;
	if (pathEntryExists(intentPath)) {
		throw new LeadRegistryCommandError(
			"lead_registry_recovery_required",
			78,
			`recovery intent exists: ${intentPath}; run lead-registry recover`,
		);
	}
	const importSource = readJsonNoFollow<unknown>(
		inputPath,
		"CoS context import",
		true,
	);
	const source = readJsonNoFollow<unknown>(projectsPath, "projects registry");
	const receiptSource = readJsonNoFollow<SummaryMigrationReceipt>(
		receiptPath,
		"summary migration receipt",
	);
	if (
		sha256(source.text) !== expectedProjectsSha ||
		sha256(receiptSource.text) !== expectedReceiptSha
	) {
		throw new LeadRegistryCommandError(
			"lead_registry_source_stale",
			78,
			"projects registry or summary receipt does not match the caller CAS",
		);
	}
	const validator =
		deps.validateTeamleadCandidate ??
		((candidatePath: string) =>
			defaultTeamleadValidator(candidatePath, deps.env ?? process.env));
	try {
		verifySummaryRegistryActivation(
			{ projectsPath, receiptPath, homeDir: summaryConfigHome },
			{ validateTeamleadCandidate: validator },
		);
	} catch (error) {
		throw new LeadRegistryCommandError(
			"lead_registry_preimage_stale",
			78,
			error instanceof Error ? error.message : String(error),
		);
	}
	const selection = readSummaryGranularity({ homeDir: summaryConfigHome });
	const plan = planLeadRegistryCoSContextImport(
		source.value,
		receiptSource.value,
		selection,
		importSource.value,
	);
	const candidateTemp = join(
		dirname(projectsPath),
		`.${basename(projectsPath)}.cos-context-validate.${randomUUID()}`,
	);
	try {
		writeDurableFile(
			candidateTemp,
			plan.candidateText,
			statSync(projectsPath).mode & 0o777,
		);
		validator(candidateTemp);
	} catch (error) {
		if (error instanceof LeadRegistryCommandError) throw error;
		throw new LeadRegistryCommandError(
			"lead_registry_candidate_invalid",
			78,
			error instanceof Error ? error.message : String(error),
		);
	} finally {
		try {
			unlinkSync(candidateTemp);
		} catch {}
	}
	const dryRun = values["dry-run"] ?? false;
	if (dryRun || plan.kind === "continuation") {
		stdout(
			JSON.stringify({
				ok: true,
				operation: "cos-context-import",
				...(plan.kind === "continuation" ? { continuation: true } : {}),
				dryRun,
				updatedLeadKeys: plan.updatedLeadKeys,
				planned: plan.planned,
				projectsFile: projectsPath,
				receiptFile: receiptPath,
			}),
		);
		return 0;
	}
	if ((deps.env ?? process.env).FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD !== "1") {
		throw new LeadRegistryCommandError(
			"lead_registry_lock_required",
			78,
			"FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD=1 is required",
		);
	}
	const fencedProjects = readRegularFileNoFollow(
		projectsPath,
		"projects registry",
	);
	const fencedReceipt = readRegularFileNoFollow(
		receiptPath,
		"summary migration receipt",
	);
	if (
		sha256(fencedProjects) !== expectedProjectsSha ||
		sha256(fencedReceipt) !== expectedReceiptSha
	) {
		throw new LeadRegistryCommandError(
			"lead_registry_source_stale",
			78,
			"projects registry or summary receipt changed after planning",
		);
	}
	const startedAt = deps.now?.() ?? new Date().toISOString();
	const backupStamp = startedAt.replace(/[-:.]/g, "");
	const projectsBackup = `${projectsPath}.bak-fly2445-${backupStamp}`;
	const receiptBackup = `${receiptPath}.bak-fly2445-${backupStamp}`;
	writeDurableFile(
		projectsBackup,
		fencedProjects,
		statSync(projectsPath).mode & 0o777,
	);
	writeDurableFile(
		receiptBackup,
		fencedReceipt,
		statSync(receiptPath).mode & 0o777,
	);
	const intent = {
		schemaVersion: 1 as const,
		phase: "pending" as const,
		operation: "cos-context-import" as const,
		leadKey: "cos-context-import",
		startedAt,
		projectsShaBefore: expectedProjectsSha,
		receiptDigestBefore: receiptSource.value.summaryAssignmentDigest,
		projectsShaPlanned: plan.planned.projectsSha,
		receiptDigestPlanned: plan.planned.receiptDigest,
		backups: { projects: projectsBackup, receipt: receiptBackup },
	};
	writeAtomic(intentPath, `${JSON.stringify(intent, null, 2)}\n`);
	const assignmentsPath = join(
		dirname(receiptPath),
		`.cos-context-assignments.${randomUUID()}.json`,
	);
	try {
		writeDurableFile(
			assignmentsPath,
			assignmentManifest(plan.candidateRegistry, summaryConfigHome),
			0o600,
		);
		const migrated = migrateSummaryRegistry(
			{
				projectsPath,
				assignmentsPath,
				receiptPath,
				expectedSha256: expectedProjectsSha,
				homeDir: summaryConfigHome,
				candidateRegistry: plan.candidateRegistry,
			},
			{
				validateTeamleadCandidate: validator,
				now: deps.now,
				afterProjectsRename: deps.afterProjectsRename,
			},
		);
		if (
			sha256(readRegularFileNoFollow(projectsPath, "projects registry")) !==
				plan.planned.projectsSha ||
			migrated.summaryAssignmentDigest !== plan.planned.receiptDigest
		) {
			throw new Error("CoS context import landed hashes differ from plan");
		}
		verifySummaryRegistryActivation(
			{ projectsPath, receiptPath, homeDir: summaryConfigHome },
			{ validateTeamleadCandidate: validator },
		);
		writeAtomic(
			intentPath,
			`${JSON.stringify(
				{
					...intent,
					phase: "done",
					projectsShaAfter: plan.planned.projectsSha,
					receiptDigestAfter: plan.planned.receiptDigest,
				},
				null,
				2,
			)}\n`,
		);
		removeIntent(intentPath);
	} catch (error) {
		let rollbackError: unknown;
		try {
			writeAtomic(
				receiptPath,
				readRegularFileNoFollow(receiptBackup, "receipt backup"),
				statSync(receiptPath).mode & 0o777,
			);
			writeAtomic(
				projectsPath,
				readRegularFileNoFollow(projectsBackup, "projects backup"),
				statSync(projectsPath).mode & 0o777,
			);
			verifySummaryRegistryActivation(
				{ projectsPath, receiptPath, homeDir: summaryConfigHome },
				{ validateTeamleadCandidate: validator },
			);
			removeIntent(intentPath);
		} catch (caught) {
			rollbackError = caught;
		}
		if (rollbackError !== undefined) {
			throw new LeadRegistryCommandError(
				"lead_registry_rollback_failed",
				70,
				`${error instanceof Error ? error.message : String(error)}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
			);
		}
		throw new LeadRegistryCommandError(
			"lead_registry_rolled_back",
			70,
			error instanceof Error ? error.message : String(error),
		);
	} finally {
		try {
			unlinkSync(assignmentsPath);
		} catch {}
	}
	stdout(
		JSON.stringify({
			ok: true,
			operation: "cos-context-import",
			updatedLeadKeys: plan.updatedLeadKeys,
			projectsFile: projectsPath,
			receiptFile: receiptPath,
			backups: { projects: projectsBackup, receipt: receiptBackup },
			effectiveAt: "next-bridge-restart",
		}),
	);
	return 0;
}

function runRecover(
	args: string[],
	deps: LeadRegistryCommandDeps,
	homeDir: string,
	stdout: (line: string) => void,
): number {
	const { values } = parseArgs({
		args,
		options: {
			"projects-file": { type: "string" },
			"receipt-file": { type: "string" },
			"summary-config-home": { type: "string" },
		},
		allowPositionals: false,
	});
	if ((deps.env ?? process.env).FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD !== "1") {
		throw new LeadRegistryCommandError(
			"lead_registry_lock_required",
			78,
			"FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD=1 is required",
		);
	}
	const summaryConfigHome = values["summary-config-home"] ?? homeDir;
	const projectsPath =
		values["projects-file"] ?? join(homeDir, ".flywheel", "projects.json");
	const receiptPath =
		values["receipt-file"] ??
		join(
			homeDir,
			".flywheel",
			"state",
			"summary-registry",
			"migration-receipt.json",
		);
	const intentPath = `${receiptPath}.lead-registry-intent.json`;
	if (!pathEntryExists(intentPath)) {
		stdout(JSON.stringify({ ok: true, state: "none" }));
		return 0;
	}
	const intentSource = readJsonNoFollow<unknown>(intentPath, "recovery intent");
	const projects = readRegularFileNoFollow(projectsPath, "projects registry");
	const receipt = readJsonNoFollow<SummaryMigrationReceipt>(
		receiptPath,
		"summary migration receipt",
	);
	const validator =
		deps.validateTeamleadCandidate ??
		((candidatePath: string) =>
			defaultTeamleadValidator(candidatePath, deps.env ?? process.env));
	let activationOk = false;
	try {
		verifySummaryRegistryActivation(
			{ projectsPath, receiptPath, homeDir: summaryConfigHome },
			{ validateTeamleadCandidate: validator },
		);
		activationOk = true;
	} catch {}
	const classification = classifyRecovery(
		intentSource.value,
		sha256(projects),
		receipt.value.summaryAssignmentDigest,
		activationOk,
	);
	if (classification.state === "conflict") {
		throw new LeadRegistryCommandError(
			"lead_registry_recovery_conflict",
			78,
			`current projects=${sha256(projects)} receipt=${receipt.value.summaryAssignmentDigest}; before projects=${classification.intent.projectsShaBefore} receipt=${classification.intent.receiptDigestBefore}; planned projects=${classification.intent.projectsShaPlanned} receipt=${classification.intent.receiptDigestPlanned}; backups=${classification.intent.backups.projects},${classification.intent.backups.receipt}`,
		);
	}
	if (classification.state === "restore_projects") {
		const backup = readRegularFileNoFollow(
			classification.intent.backups.projects,
			"projects backup",
		);
		if (sha256(backup) !== classification.intent.projectsShaBefore) {
			throw new LeadRegistryCommandError(
				"lead_registry_recovery_conflict",
				78,
				"projects backup does not match the intent before image",
			);
		}
		writeAtomic(projectsPath, backup, statSync(projectsPath).mode & 0o777);
		verifySummaryRegistryActivation(
			{ projectsPath, receiptPath, homeDir: summaryConfigHome },
			{ validateTeamleadCandidate: validator },
		);
		if (
			sha256(readRegularFileNoFollow(projectsPath, "projects registry")) !==
			classification.intent.projectsShaBefore
		) {
			throw new LeadRegistryCommandError(
				"lead_registry_recovery_conflict",
				78,
				"restored projects image failed its bound hash",
			);
		}
		removeIntent(intentPath);
		stdout(JSON.stringify({ ok: true, state: "restored_projects" }));
		return 0;
	}
	if (
		classification.state === "discard_done" ||
		classification.state === "discard_unwritten"
	) {
		if (!activationOk) {
			throw new LeadRegistryCommandError(
				"lead_registry_recovery_conflict",
				78,
				"current registry and receipt do not pass activation verification",
			);
		}
		removeIntent(intentPath);
		stdout(
			JSON.stringify({
				ok: true,
				state:
					classification.state === "discard_done"
						? "cleaned_done"
						: "cleaned_unwritten",
			}),
		);
		return 0;
	}
	if (classification.state === "finalize") {
		writeAtomic(
			intentPath,
			`${JSON.stringify(
				{
					...classification.intent,
					phase: "done",
					projectsShaAfter: classification.intent.projectsShaPlanned,
					receiptDigestAfter: classification.intent.receiptDigestPlanned,
				},
				null,
				2,
			)}\n`,
		);
		verifySummaryRegistryActivation(
			{ projectsPath, receiptPath, homeDir: summaryConfigHome },
			{ validateTeamleadCandidate: validator },
		);
		const finalizedProjects = readRegularFileNoFollow(
			projectsPath,
			"projects registry",
		);
		const finalizedReceipt = readJsonNoFollow<SummaryMigrationReceipt>(
			receiptPath,
			"summary migration receipt",
		);
		if (
			sha256(finalizedProjects) !== classification.intent.projectsShaPlanned ||
			finalizedReceipt.value.summaryAssignmentDigest !==
				classification.intent.receiptDigestPlanned
		) {
			throw new LeadRegistryCommandError(
				"lead_registry_recovery_conflict",
				78,
				"planned image changed during recovery finalization",
			);
		}
		removeIntent(intentPath);
		stdout(JSON.stringify({ ok: true, state: "finalized" }));
		return 0;
	}
	throw new LeadRegistryCommandError(
		"lead_registry_recovery_conflict",
		78,
		"unhandled recovery state",
	);
}

function runSelector(
	args: string[],
	homeDir: string,
	stdout: (line: string) => void,
): number {
	const { values } = parseArgs({
		args,
		options: {
			project: { type: "string" },
			lead: { type: "string" },
			"projects-file": { type: "string" },
		},
		allowPositionals: false,
	});
	const projectName = required(values.project, "--project");
	const leadId = required(values.lead, "--lead");
	const projectsPath =
		values["projects-file"] ?? join(homeDir, ".flywheel", "projects.json");
	const rawText = readRegularFileNoFollow(projectsPath, "projects registry");
	let raw: unknown;
	try {
		raw = JSON.parse(rawText);
	} catch (error) {
		throw new LeadRegistryCommandError(
			"lead_registry_source_invalid",
			78,
			`projects registry is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const projectsDigest = sha256(rawText);
	const matches = compileLeadIdentityRows(raw, {
		homeDir,
		projectsDigest,
	}).filter(
		(row) =>
			row.identity.projectName === projectName &&
			row.identity.leadId === leadId,
	);
	if (matches.length !== 1) {
		throw new LeadRegistryCommandError(
			"lead_registry_selector_missing",
			78,
			`expected exactly one Lead row for ${projectName}/${leadId}`,
		);
	}
	const match = matches[0]!;
	stdout(
		JSON.stringify({
			projectsDigest,
			projectName,
			leadId,
			projectRoot: match.project.projectRoot,
			chatChannel: match.lead.chatChannel,
			...(match.project.generalChannel !== undefined
				? { generalChannel: match.project.generalChannel }
				: {}),
			backend: match.identity.backend,
			...(match.lead.codexProfile !== undefined
				? { codexProfile: match.lead.codexProfile }
				: {}),
			botTokenEnv: match.identity.botTokenEnv,
			...(match.lead.roundtableChannel !== undefined
				? { roundtableChannel: match.lead.roundtableChannel }
				: {}),
			...(match.lead.alertChannel !== undefined
				? { alertChannel: match.lead.alertChannel }
				: {}),
			...(match.lead.alertBotTokenEnv !== undefined
				? { alertBotTokenEnv: match.lead.alertBotTokenEnv }
				: {}),
			...(match.lead.alertFallbackToCore !== undefined
				? { alertFallbackToCore: match.lead.alertFallbackToCore }
				: {}),
		}),
	);
	return 0;
}

export function runLeadRegistryCommand(
	args: string[],
	deps: LeadRegistryCommandDeps = {},
): number {
	const stdout = deps.stdout ?? console.log;
	const stderr = deps.stderr ?? console.error;
	const homeDir = deps.homeDir ?? homedir();
	try {
		const subcommand = args[0];
		if (subcommand === "selector") {
			return runSelector(args.slice(1), homeDir, stdout);
		}
		if (subcommand === "add") {
			return runAdd(args.slice(1), deps, homeDir, stdout);
		}
		if (subcommand === "import-cos-context") {
			return runImportCoSContext(args.slice(1), deps, homeDir, stdout);
		}
		if (subcommand === "recover") {
			return runRecover(args.slice(1), deps, homeDir, stdout);
		}
		throw new LeadRegistryCommandError(
			"lead_registry_usage",
			64,
			"expected subcommand: add|import-cos-context|recover|selector",
		);
	} catch (error) {
		const parseArgsError =
			error !== null &&
			typeof error === "object" &&
			"code" in error &&
			typeof error.code === "string" &&
			error.code.startsWith("ERR_PARSE_ARGS");
		const shaped =
			error instanceof LeadRegistryCommandError
				? error
				: error instanceof LeadRegistryAddError
					? new LeadRegistryCommandError(error.code, 78, error.message)
					: error instanceof LeadRegistryCoSContextError
						? new LeadRegistryCommandError(error.code, 78, error.message)
						: error instanceof LeadRegistryRecoveryError
							? new LeadRegistryCommandError(error.code, 78, error.message)
							: error instanceof SummaryRegistryError
								? new LeadRegistryCommandError(error.code, 78, error.message)
								: parseArgsError
									? new LeadRegistryCommandError(
											"lead_registry_usage",
											64,
											error instanceof Error ? error.message : String(error),
										)
									: new LeadRegistryCommandError(
											"lead_registry_command_invalid",
											78,
											error instanceof Error ? error.message : String(error),
										);
		stderr(
			JSON.stringify({
				ok: false,
				code: shaped.code,
				message: shaped.message,
			}),
		);
		return shaped.exitCode;
	}
}
