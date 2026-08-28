import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { compileSummaryAssignmentRows } from "./summary-assignment-core.js";
import {
	readSummaryGranularity,
	type SummaryGranularity,
	type SummaryGranularitySelection,
} from "./summary-config.js";

export type LeadIdentityErrorCode =
	| "identity_source_error"
	| "identity_registry_shape_invalid"
	| "identity_project_invalid"
	| "identity_project_collision"
	| "identity_agent_id_invalid"
	| "identity_summary_role_invalid"
	| "identity_bare_id_collision"
	| "identity_row_missing"
	| "identity_row_ambiguous"
	| "identity_backend_invalid"
	| "identity_bot_token_env_invalid"
	| "identity_bot_user_id_invalid"
	| "identity_bot_user_id_missing"
	| "identity_bot_user_id_collision"
	| "identity_state_dir_invalid"
	| "identity_state_dir_conflict";

export class LeadIdentityError extends Error {
	constructor(
		readonly code: LeadIdentityErrorCode,
		message: string,
	) {
		super(message);
		this.name = "LeadIdentityError";
	}
}

export interface ResolveLeadIdentityInput {
	projectsPath: string;
	projectName: string;
	leadId: string;
	homeDir?: string;
}

export type CanonicalLeadBackend = "claude-code" | "codex-app-server";
export type CanonicalLeadRole = "cos" | "dept" | "companion" | "external";
export type SummaryRole = "producer" | "aggregator" | "recipient" | "exempt";

export interface CanonicalLeadIdentity {
	schemaVersion: 1;
	leadId: string;
	projectName: string;
	leadKey: string;
	agentTeamName: string;
	botUserId: string | null;
	botTokenEnv: string | null;
	discordStateDir: string;
	backend: CanonicalLeadBackend;
	role: CanonicalLeadRole;
	summaryRole: SummaryRole;
	summaryGranularity: SummaryGranularity | null;
	hasSummaryDuty: boolean | null;
	summaryAssignmentDigest: string | null;
	projectsDigest: string;
	identityDigest: string;
}

export interface IdentityLeadRow extends Record<string, unknown> {
	agentId: string;
	summaryRole: SummaryRole;
}

export interface IdentityProjectRow extends Record<string, unknown> {
	projectName: string;
	leads: IdentityLeadRow[];
}

export interface CompiledLeadIdentityRow {
	project: IdentityProjectRow;
	lead: IdentityLeadRow;
	identity: CanonicalLeadIdentity;
}

export interface CompileLeadIdentityRegistryOptions {
	homeDir?: string;
	projectsDigest?: string;
	summarySelection?: SummaryGranularitySelection;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DISCORD_SNOWFLAKE = /^[0-9]{17,20}$/;

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function identityError(
	code: LeadIdentityErrorCode,
	message: string,
): LeadIdentityError {
	return new LeadIdentityError(code, `${code}: ${message}`);
}

function projectsArray(raw: unknown): unknown[] {
	const candidate =
		raw !== null &&
		typeof raw === "object" &&
		!Array.isArray(raw) &&
		"projects" in raw
			? (raw as { projects: unknown }).projects
			: raw;
	if (!Array.isArray(candidate)) {
		throw identityError(
			"identity_registry_shape_invalid",
			"projects registry must be an array or {projects: array}",
		);
	}
	return candidate;
}

/**
 * Resolve a path through its nearest existing ancestor. This detects aliases
 * such as `/real/new-dir` and `/symlink-to-real/new-dir` without requiring the
 * final Discord state directory to exist before provisioning.
 */
function effectivePathIdentity(input: string): string {
	let cursor = resolve(input);
	const suffix: string[] = [];
	for (;;) {
		try {
			const base = realpathSync.native(cursor);
			return suffix.length === 0 ? base : join(base, ...suffix);
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!("code" in error) ||
				(error as NodeJS.ErrnoException).code !== "ENOENT"
			) {
				throw identityError(
					"identity_state_dir_invalid",
					`cannot resolve ${input}: ${errorMessage(error)}`,
				);
			}
			const parent = dirname(cursor);
			if (parent === cursor) {
				throw identityError(
					"identity_state_dir_invalid",
					`no existing ancestor for ${input}`,
				);
			}
			suffix.unshift(basename(cursor));
			cursor = parent;
		}
	}
}

function parseProjects(raw: unknown): IdentityProjectRow[] {
	const seenProjects = new Set<string>();
	return projectsArray(raw).map((candidate, projectIndex) => {
		if (candidate === null || typeof candidate !== "object") {
			throw identityError(
				"identity_project_invalid",
				`projects[${projectIndex}] must be an object`,
			);
		}
		const project = candidate as Record<string, unknown>;
		if (
			typeof project.projectName !== "string" ||
			!SAFE_ID.test(project.projectName)
		) {
			throw identityError(
				"identity_project_invalid",
				`projects[${projectIndex}].projectName must match ${SAFE_ID}`,
			);
		}
		if (seenProjects.has(project.projectName)) {
			throw identityError(
				"identity_project_collision",
				`projectName ${project.projectName} appears more than once`,
			);
		}
		seenProjects.add(project.projectName);
		if (!Array.isArray(project.leads) || project.leads.length === 0) {
			throw identityError(
				"identity_project_invalid",
				`project ${project.projectName} must have at least one Lead`,
			);
		}
		const leads = project.leads.map((candidateLead, leadIndex) => {
			if (candidateLead === null || typeof candidateLead !== "object") {
				throw identityError(
					"identity_agent_id_invalid",
					`${project.projectName}.leads[${leadIndex}] must be an object`,
				);
			}
			const lead = candidateLead as Record<string, unknown>;
			if (typeof lead.agentId !== "string" || !SAFE_ID.test(lead.agentId)) {
				throw identityError(
					"identity_agent_id_invalid",
					`${project.projectName}.leads[${leadIndex}].agentId must match ${SAFE_ID}`,
				);
			}
			if (
				lead.summaryRole !== "producer" &&
				lead.summaryRole !== "aggregator" &&
				lead.summaryRole !== "recipient" &&
				lead.summaryRole !== "exempt"
			) {
				throw identityError(
					"identity_summary_role_invalid",
					`${project.projectName}.leads[${leadIndex}].summaryRole must be one of producer|aggregator|recipient|exempt`,
				);
			}
			return lead as IdentityLeadRow;
		});
		return { ...project, projectName: project.projectName, leads };
	});
}

function canonicalRole(
	project: IdentityProjectRow,
	lead: IdentityLeadRow,
): CanonicalLeadRole {
	if (lead.external === true) return "external";
	if (lead.companion === true || lead.codexProfile === "companion") {
		return "companion";
	}
	if (
		typeof project.generalChannel === "string" &&
		lead.chatChannel === project.generalChannel
	) {
		return "cos";
	}
	return "dept";
}

function identityFields(
	project: IdentityProjectRow,
	lead: IdentityLeadRow,
	homeDir: string,
): Omit<CanonicalLeadIdentity, "projectsDigest" | "identityDigest"> {
	const backend = lead.backend ?? "claude-code";
	if (backend !== "claude-code" && backend !== "codex-app-server") {
		throw identityError(
			"identity_backend_invalid",
			`${project.projectName}/${lead.agentId} has unsupported backend ${String(backend)}`,
		);
	}
	const botTokenEnv = lead.botTokenEnv ?? null;
	if (
		botTokenEnv !== null &&
		(typeof botTokenEnv !== "string" || !ENV_NAME.test(botTokenEnv))
	) {
		throw identityError(
			"identity_bot_token_env_invalid",
			`${project.projectName}/${lead.agentId} botTokenEnv must be an env variable name`,
		);
	}
	const botUserId = lead.botUserId ?? null;
	if (
		botUserId !== null &&
		(typeof botUserId !== "string" || !DISCORD_SNOWFLAKE.test(botUserId))
	) {
		throw identityError(
			"identity_bot_user_id_invalid",
			`${project.projectName}/${lead.agentId} botUserId must be a 17-20 digit Discord snowflake`,
		);
	}
	if (botTokenEnv !== null && botUserId === null) {
		throw identityError(
			"identity_bot_user_id_missing",
			`${project.projectName}/${lead.agentId} is managed by botTokenEnv but has no independent botUserId`,
		);
	}
	const configuredStateDir = lead.discordStateDir;
	if (
		configuredStateDir !== undefined &&
		(typeof configuredStateDir !== "string" ||
			configuredStateDir.length === 0 ||
			!isAbsolute(configuredStateDir))
	) {
		throw identityError(
			"identity_state_dir_invalid",
			`${project.projectName}/${lead.agentId} discordStateDir must be an absolute path`,
		);
	}
	const discordStateDir = resolve(
		configuredStateDir ??
			join(homeDir, ".claude", "channels", `discord-${lead.agentId}`),
	);
	return {
		schemaVersion: 1,
		leadId: lead.agentId,
		projectName: project.projectName,
		leadKey: `${project.projectName}-${lead.agentId}`,
		agentTeamName: lead.agentId,
		botUserId,
		botTokenEnv,
		discordStateDir,
		backend,
		role: canonicalRole(project, lead),
		summaryRole: lead.summaryRole,
		summaryGranularity: null,
		hasSummaryDuty: null,
		summaryAssignmentDigest: null,
	};
}

/** Compile and validate every Lead identity using the same rules as resolve. */
export function compileLeadIdentityRows(
	raw: unknown,
	options: CompileLeadIdentityRegistryOptions = {},
): CompiledLeadIdentityRow[] {
	const homeDir = options.homeDir ?? homedir();
	const projectsDigest = options.projectsDigest ?? sha256(JSON.stringify(raw));
	const projects = parseProjects(raw);
	const seenLeadIds = new Map<string, string>();
	const seenBotUserIds = new Map<string, string>();
	const seenStateDirs = new Map<string, string>();
	const rows: CompiledLeadIdentityRow[] = [];

	for (const project of projects) {
		for (const lead of project.leads) {
			const location = `${project.projectName}/${lead.agentId}`;
			const priorLead = seenLeadIds.get(lead.agentId);
			if (priorLead !== undefined) {
				throw identityError(
					"identity_bare_id_collision",
					`leadId ${lead.agentId} appears in both ${priorLead} and ${location}`,
				);
			}
			seenLeadIds.set(lead.agentId, location);

			const fields = identityFields(project, lead, homeDir);
			if (fields.botUserId !== null) {
				const priorBot = seenBotUserIds.get(fields.botUserId);
				if (priorBot !== undefined) {
					throw identityError(
						"identity_bot_user_id_collision",
						`botUserId ${fields.botUserId} belongs to both ${priorBot} and ${location}`,
					);
				}
				seenBotUserIds.set(fields.botUserId, location);
			}

			const pathIdentity = effectivePathIdentity(fields.discordStateDir);
			const priorStateDir = seenStateDirs.get(pathIdentity);
			if (priorStateDir !== undefined) {
				throw identityError(
					"identity_state_dir_conflict",
					`effective Discord state directory ${pathIdentity} belongs to both ${priorStateDir} and ${location}`,
				);
			}
			seenStateDirs.set(pathIdentity, location);

			const identityDigest = sha256(JSON.stringify(fields));
			rows.push({
				project,
				lead,
				identity: { ...fields, projectsDigest, identityDigest },
			});
		}
	}
	if (options.summarySelection !== undefined) {
		const projection = compileSummaryAssignmentRows(
			rows.map(({ project, identity }) => ({
				projectName: identity.projectName,
				leadId: identity.leadId,
				summaryRole: identity.summaryRole,
				summaryAggregatorLeadId: project.summaryAggregatorLeadId,
			})),
			options.summarySelection,
		);
		for (const row of rows) {
			const assignment = projection.leads.find(
				(candidate) =>
					candidate.projectName === row.identity.projectName &&
					candidate.leadId === row.identity.leadId,
			);
			if (!assignment) {
				throw identityError(
					"identity_row_missing",
					`summary assignment missing for ${row.identity.projectName}/${row.identity.leadId}`,
				);
			}
			const {
				projectsDigest: _projectsDigest,
				identityDigest: _identityDigest,
				...priorFields
			} = row.identity;
			const assignedFields = {
				...priorFields,
				summaryGranularity: projection.granularity,
				hasSummaryDuty: assignment.hasSummaryDuty,
				summaryAssignmentDigest: projection.digest,
			};
			row.identity = {
				...assignedFields,
				projectsDigest,
				identityDigest: sha256(JSON.stringify(assignedFields)),
			};
		}
	}
	return rows;
}

/** Compile and validate every Lead identity using the same rules as resolve. */
export function compileLeadIdentityRegistry(
	raw: unknown,
	options: CompileLeadIdentityRegistryOptions = {},
): CanonicalLeadIdentity[] {
	return compileLeadIdentityRows(raw, options).map((row) => row.identity);
}

export function resolveLeadIdentity(
	input: ResolveLeadIdentityInput,
): CanonicalLeadIdentity {
	let rawText: string;
	let raw: unknown;
	try {
		rawText = readFileSync(input.projectsPath, "utf8");
		raw = JSON.parse(rawText);
	} catch (error) {
		throw identityError(
			"identity_source_error",
			`failed to read ${input.projectsPath}: ${errorMessage(error)}`,
		);
	}
	const rows = compileLeadIdentityRows(raw, {
		homeDir: input.homeDir,
		projectsDigest: sha256(rawText),
		summarySelection: readSummaryGranularity({ homeDir: input.homeDir }),
	});
	const matches = rows.filter(
		(row) =>
			row.identity.projectName === input.projectName &&
			row.identity.leadId === input.leadId,
	);
	if (matches.length === 0) {
		throw identityError(
			"identity_row_missing",
			`no Lead row matches ${input.projectName}/${input.leadId}`,
		);
	}
	if (matches.length > 1) {
		throw identityError(
			"identity_row_ambiguous",
			`more than one Lead row matches ${input.projectName}/${input.leadId}`,
		);
	}
	return matches[0]!.identity;
}
