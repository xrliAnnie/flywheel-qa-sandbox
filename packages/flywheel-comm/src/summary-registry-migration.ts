import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { compileLeadIdentityRows, type SummaryRole } from "./lead-identity.js";
import { compileSummaryAssignments } from "./summary-assignment.js";
import { compileSummaryAssignmentRows } from "./summary-assignment-core.js";
import { readSummaryGranularity } from "./summary-config.js";

export type SummaryRegistryErrorCode =
	| "summary_registry_source_error"
	| "summary_registry_stale"
	| "summary_registry_manifest_invalid"
	| "summary_registry_candidate_invalid"
	| "summary_registry_write_error"
	| "summary_registry_receipt_missing"
	| "summary_registry_receipt_invalid"
	| "summary_registry_projection_mismatch";

export class SummaryRegistryError extends Error {
	constructor(
		readonly code: SummaryRegistryErrorCode,
		message: string,
	) {
		super(`${code}: ${message}`);
		this.name = "SummaryRegistryError";
	}
}

interface AssignmentManifestRow {
	projectName: string;
	leadId: string;
	summaryRole: SummaryRole;
}

interface AssignmentManifest {
	assignments: AssignmentManifestRow[];
	projectAggregators: Array<{ projectName: string; leadId: string }>;
}

export interface SummaryMigrationReceipt {
	schemaVersion: 1;
	postImageSha256: string;
	assignments: AssignmentManifestRow[];
	projectAggregators: Array<{ projectName: string; leadId: string }>;
	granularity: "per-lead" | "per-project";
	summaryAssignmentDigest: string;
	migratedAt: string;
}

export interface MigrateSummaryRegistryInput {
	projectsPath: string;
	assignmentsPath: string;
	receiptPath: string;
	expectedSha256: string;
	homeDir?: string;
}

export interface VerifySummaryRegistryActivationInput {
	projectsPath: string;
	receiptPath: string;
	homeDir?: string;
}

export interface SummaryRegistryDeps {
	/** Invoke TeamLead's built validate-projects CLI against this exact file. */
	validateTeamleadCandidate: (candidatePath: string) => void;
	now?: () => string;
	beforeRename?: (candidatePath: string) => void;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function readJson(
	path: string,
	label: string,
): { text: string; value: unknown } {
	try {
		const text = readFileSync(path, "utf8");
		return { text, value: JSON.parse(text) };
	} catch (error) {
		throw new SummaryRegistryError(
			"summary_registry_source_error",
			`cannot read ${label} ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function validSummaryRole(value: unknown): value is SummaryRole {
	return (
		value === "producer" ||
		value === "aggregator" ||
		value === "recipient" ||
		value === "exempt"
	);
}

function parseManifest(value: unknown): AssignmentManifest {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new SummaryRegistryError(
			"summary_registry_manifest_invalid",
			"assignment manifest must be an object",
		);
	}
	const raw = value as Record<string, unknown>;
	if (!Array.isArray(raw.assignments) || raw.assignments.length === 0) {
		throw new SummaryRegistryError(
			"summary_registry_manifest_invalid",
			"assignments must be a non-empty array",
		);
	}
	const seen = new Set<string>();
	const assignments = raw.assignments.map((candidate, index) => {
		if (candidate === null || typeof candidate !== "object") {
			throw new SummaryRegistryError(
				"summary_registry_manifest_invalid",
				`assignments[${index}] must be an object`,
			);
		}
		const row = candidate as Record<string, unknown>;
		if (
			typeof row.projectName !== "string" ||
			row.projectName.length === 0 ||
			typeof row.leadId !== "string" ||
			row.leadId.length === 0 ||
			!validSummaryRole(row.summaryRole)
		) {
			throw new SummaryRegistryError(
				"summary_registry_manifest_invalid",
				`assignments[${index}] has invalid projectName, leadId, or summaryRole`,
			);
		}
		const key = `${row.projectName}\0${row.leadId}`;
		if (seen.has(key)) {
			throw new SummaryRegistryError(
				"summary_registry_manifest_invalid",
				`duplicate assignment ${row.projectName}/${row.leadId}`,
			);
		}
		seen.add(key);
		return {
			projectName: row.projectName,
			leadId: row.leadId,
			summaryRole: row.summaryRole,
		};
	});
	const rawAggregators = raw.projectAggregators ?? [];
	if (!Array.isArray(rawAggregators)) {
		throw new SummaryRegistryError(
			"summary_registry_manifest_invalid",
			"projectAggregators must be an array when present",
		);
	}
	const seenProjects = new Set<string>();
	const projectAggregators = rawAggregators.map((candidate, index) => {
		if (candidate === null || typeof candidate !== "object") {
			throw new SummaryRegistryError(
				"summary_registry_manifest_invalid",
				`projectAggregators[${index}] must be an object`,
			);
		}
		const row = candidate as Record<string, unknown>;
		if (
			typeof row.projectName !== "string" ||
			row.projectName.length === 0 ||
			typeof row.leadId !== "string" ||
			row.leadId.length === 0 ||
			seenProjects.has(row.projectName)
		) {
			throw new SummaryRegistryError(
				"summary_registry_manifest_invalid",
				`projectAggregators[${index}] has invalid or duplicate projectName/leadId`,
			);
		}
		seenProjects.add(row.projectName);
		return { projectName: row.projectName, leadId: row.leadId };
	});
	return { assignments, projectAggregators };
}

function registryArray(value: unknown): Array<Record<string, unknown>> {
	const candidate =
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		"projects" in value
			? (value as { projects: unknown }).projects
			: value;
	if (!Array.isArray(candidate)) {
		throw new SummaryRegistryError(
			"summary_registry_source_error",
			"projects registry must be an array or {projects: array}",
		);
	}
	return candidate as Array<Record<string, unknown>>;
}

function applyManifest(value: unknown, manifest: AssignmentManifest): unknown {
	const clone = structuredClone(value);
	const projects = registryArray(clone);
	const assignmentByKey = new Map(
		manifest.assignments.map((row) => [
			`${row.projectName}\0${row.leadId}`,
			row.summaryRole,
		]),
	);
	let registryRows = 0;
	for (const project of projects) {
		if (
			typeof project.projectName !== "string" ||
			!Array.isArray(project.leads)
		) {
			throw new SummaryRegistryError(
				"summary_registry_source_error",
				"project has invalid projectName or leads",
			);
		}
		for (const candidateLead of project.leads) {
			if (
				candidateLead === null ||
				typeof candidateLead !== "object" ||
				typeof (candidateLead as Record<string, unknown>).agentId !== "string"
			) {
				throw new SummaryRegistryError(
					"summary_registry_source_error",
					`project ${project.projectName} contains an invalid Lead`,
				);
			}
			const lead = candidateLead as Record<string, unknown>;
			const key = `${project.projectName}\0${lead.agentId}`;
			const role = assignmentByKey.get(key);
			if (!role) {
				throw new SummaryRegistryError(
					"summary_registry_manifest_invalid",
					"assignment manifest must assign every registry Lead exactly once",
				);
			}
			lead.summaryRole = role;
			assignmentByKey.delete(key);
			registryRows += 1;
		}
		const aggregator = manifest.projectAggregators.find(
			(row) => row.projectName === project.projectName,
		);
		if (aggregator) project.summaryAggregatorLeadId = aggregator.leadId;
		else delete project.summaryAggregatorLeadId;
	}
	if (
		assignmentByKey.size > 0 ||
		registryRows !== manifest.assignments.length
	) {
		throw new SummaryRegistryError(
			"summary_registry_manifest_invalid",
			"assignment manifest must assign every registry Lead exactly once",
		);
	}
	return clone;
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

function writeAtomic(path: string, contents: string, mode = 0o600): void {
	const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	try {
		writeDurableFile(temp, contents, mode);
		renameSync(temp, path);
		const dirFd = openSync(dirname(path), "r");
		try {
			fsyncSync(dirFd);
		} finally {
			closeSync(dirFd);
		}
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {}
		throw error;
	}
}

export function migrateSummaryRegistry(
	input: MigrateSummaryRegistryInput,
	deps: SummaryRegistryDeps,
): SummaryMigrationReceipt {
	const source = readJson(input.projectsPath, "projects registry");
	if (!/^[a-f0-9]{64}$/.test(input.expectedSha256)) {
		throw new SummaryRegistryError(
			"summary_registry_stale",
			"expectedSha256 must be a 64-character lowercase hex digest",
		);
	}
	const actualSha = sha256(source.text);
	if (actualSha !== input.expectedSha256) {
		throw new SummaryRegistryError(
			"summary_registry_stale",
			`projects registry changed (expected ${input.expectedSha256}, got ${actualSha})`,
		);
	}
	const manifest = parseManifest(
		readJson(input.assignmentsPath, "assignment manifest").value,
	);
	const candidate = applyManifest(source.value, manifest);
	const selection = readSummaryGranularity({ homeDir: input.homeDir });
	const projection = compileSummaryAssignments(candidate, selection);
	const candidateText = `${JSON.stringify(candidate, null, 2)}\n`;
	const candidatePath = join(
		dirname(input.projectsPath),
		`.${basename(input.projectsPath)}.summary-migration.${randomUUID()}`,
	);
	try {
		writeDurableFile(
			candidatePath,
			candidateText,
			statSync(input.projectsPath).mode & 0o777,
		);
		try {
			compileLeadIdentityRows(candidate);
			deps.validateTeamleadCandidate(candidatePath);
		} catch (error) {
			throw new SummaryRegistryError(
				"summary_registry_candidate_invalid",
				error instanceof Error ? error.message : String(error),
			);
		}
		deps.beforeRename?.(candidatePath);
		chmodSync(candidatePath, statSync(input.projectsPath).mode & 0o777);
		renameSync(candidatePath, input.projectsPath);
		const dirFd = openSync(dirname(input.projectsPath), "r");
		try {
			fsyncSync(dirFd);
		} finally {
			closeSync(dirFd);
		}
	} catch (error) {
		try {
			unlinkSync(candidatePath);
		} catch {}
		if (error instanceof SummaryRegistryError) throw error;
		throw error;
	}
	const receipt: SummaryMigrationReceipt = {
		schemaVersion: 1,
		postImageSha256: sha256(candidateText),
		assignments: [...manifest.assignments].sort((a, b) =>
			`${a.projectName}/${a.leadId}`.localeCompare(
				`${b.projectName}/${b.leadId}`,
			),
		),
		projectAggregators: projection.projectAggregators,
		granularity: projection.granularity,
		summaryAssignmentDigest: projection.digest,
		migratedAt: deps.now?.() ?? new Date().toISOString(),
	};
	try {
		writeAtomic(input.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
	} catch (error) {
		throw new SummaryRegistryError(
			"summary_registry_write_error",
			`registry migrated but receipt write failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return receipt;
}

function parseReceipt(path: string): SummaryMigrationReceipt {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new SummaryRegistryError(
				"summary_registry_receipt_missing",
				`migration receipt is missing: ${path}`,
			);
		}
		throw new SummaryRegistryError(
			"summary_registry_receipt_invalid",
			`migration receipt cannot be read: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new SummaryRegistryError(
			"summary_registry_receipt_invalid",
			`migration receipt is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (
		value === null ||
		typeof value !== "object" ||
		(value as Record<string, unknown>).schemaVersion !== 1 ||
		!/^([a-f0-9]{64})$/.test(
			String((value as Record<string, unknown>).postImageSha256),
		) ||
		!/^([a-f0-9]{64})$/.test(
			String((value as Record<string, unknown>).summaryAssignmentDigest),
		) ||
		((value as Record<string, unknown>).granularity !== "per-lead" &&
			(value as Record<string, unknown>).granularity !== "per-project") ||
		typeof (value as Record<string, unknown>).migratedAt !== "string" ||
		!Number.isFinite(
			Date.parse(String((value as Record<string, unknown>).migratedAt)),
		)
	) {
		throw new SummaryRegistryError(
			"summary_registry_receipt_invalid",
			"migration receipt has an invalid schema or evidence fields",
		);
	}
	const receipt = value as SummaryMigrationReceipt;
	try {
		const evidence = parseManifest(receipt);
		const aggregators = new Map(
			evidence.projectAggregators.map((row) => [row.projectName, row.leadId]),
		);
		const projection = compileSummaryAssignmentRows(
			evidence.assignments.map((row) => ({
				...row,
				summaryAggregatorLeadId: aggregators.get(row.projectName),
			})),
			{
				state: "selected",
				granularity: receipt.granularity,
				setBy: "migration-receipt",
				setAt: receipt.migratedAt,
			},
		);
		if (projection.digest !== receipt.summaryAssignmentDigest) {
			throw new Error(
				`receipt evidence digest ${projection.digest} does not match ${receipt.summaryAssignmentDigest}`,
			);
		}
	} catch (error) {
		throw new SummaryRegistryError(
			"summary_registry_receipt_invalid",
			`migration receipt assignment evidence is invalid: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return receipt;
}

export function verifySummaryRegistryActivation(
	input: VerifySummaryRegistryActivationInput,
	deps: SummaryRegistryDeps,
): SummaryMigrationReceipt {
	const receipt = parseReceipt(input.receiptPath);
	deps.validateTeamleadCandidate(input.projectsPath);
	const raw = readJson(input.projectsPath, "projects registry").value;
	compileLeadIdentityRows(raw);
	const projection = compileSummaryAssignments(
		raw,
		readSummaryGranularity({ homeDir: input.homeDir }),
	);
	if (projection.digest !== receipt.summaryAssignmentDigest) {
		throw new SummaryRegistryError(
			"summary_registry_projection_mismatch",
			`live assignment digest ${projection.digest} does not match receipt ${receipt.summaryAssignmentDigest}`,
		);
	}
	return receipt;
}
