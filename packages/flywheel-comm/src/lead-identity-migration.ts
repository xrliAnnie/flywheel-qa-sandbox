import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { compileLeadIdentityRegistry } from "./lead-identity.js";

const DISCORD_SNOWFLAKE = /^[0-9]{17,20}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const AMBIENT_IDENTITY_KEYS = [
	"DISCORD_BOT_TOKEN",
	"DISCORD_EXPECTED_BOT_USER_ID",
	"DISCORD_IDENTITY_MODE",
	"DISCORD_STATE_DIR",
	"FLYWHEEL_LEAD_ID",
	"FLYWHEEL_LEAD_IDENTITY_DIGEST",
	"FLYWHEEL_LEAD_KEY",
	"FLYWHEEL_PROJECT_NAME",
	"LEAD_ID",
	"PROJECT_NAME",
] as const;

export type LeadIdentityMigrationErrorCode =
	| "identity_migration_source_error"
	| "identity_migration_roster_invalid"
	| "identity_migration_roster_mismatch"
	| "identity_migration_dirty_environment"
	| "identity_migration_token_missing"
	| "identity_migration_discord_error"
	| "identity_migration_bot_mismatch"
	| "identity_migration_write_error";

export class LeadIdentityMigrationError extends Error {
	constructor(
		readonly code: LeadIdentityMigrationErrorCode,
		message: string,
	) {
		super(`${code}: ${message}`);
		this.name = "LeadIdentityMigrationError";
	}
}

interface RosterRow {
	projectName: string;
	leadId: string;
	botTokenEnv: string;
	expectedBotUserId: string;
}

interface RegistryLead extends Record<string, unknown> {
	agentId: string;
	botTokenEnv?: unknown;
	botUserId?: unknown;
}

interface RegistryProject extends Record<string, unknown> {
	projectName: string;
	leads: RegistryLead[];
}

export interface MigrateLeadBotUserIdsInput {
	projectsPath: string;
	rosterPath: string;
	backupPath: string;
	homeDir?: string;
	env?: NodeJS.ProcessEnv;
	fetch?: typeof globalThis.fetch;
	discordApiBase?: string;
}

export interface MigrateLeadBotUserIdsResult {
	migrated: number;
	projectsPath: string;
	backupPath: string;
	rows: Array<{ projectName: string; leadId: string; botUserId: string }>;
}

function fail(code: LeadIdentityMigrationErrorCode, message: string): never {
	throw new LeadIdentityMigrationError(code, message);
}

function parseJsonFile(
	path: string,
	label: string,
): { raw: string; value: unknown } {
	try {
		const raw = readFileSync(path, "utf8");
		return { raw, value: JSON.parse(raw) };
	} catch (error) {
		fail(
			"identity_migration_source_error",
			`cannot read ${label} ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function projectsArray(value: unknown): RegistryProject[] {
	const candidate =
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		"projects" in value
			? (value as { projects: unknown }).projects
			: value;
	if (!Array.isArray(candidate)) {
		fail(
			"identity_migration_source_error",
			"projects registry must be an array or {projects: array}",
		);
	}
	return candidate.map((project, projectIndex) => {
		if (
			project === null ||
			typeof project !== "object" ||
			typeof (project as RegistryProject).projectName !== "string" ||
			!Array.isArray((project as RegistryProject).leads)
		) {
			fail(
				"identity_migration_source_error",
				`projects[${projectIndex}] has an invalid migration shape`,
			);
		}
		return project as RegistryProject;
	});
}

function parseRoster(value: unknown): RosterRow[] {
	if (!Array.isArray(value) || value.length === 0) {
		fail(
			"identity_migration_roster_invalid",
			"roster must be a non-empty array",
		);
	}
	const selectors = new Set<string>();
	const botIds = new Set<string>();
	return value.map((candidate, index) => {
		if (candidate === null || typeof candidate !== "object") {
			fail(
				"identity_migration_roster_invalid",
				`roster[${index}] must be an object`,
			);
		}
		const row = candidate as Record<string, unknown>;
		if (
			typeof row.projectName !== "string" ||
			typeof row.leadId !== "string" ||
			typeof row.botTokenEnv !== "string" ||
			!ENV_NAME.test(row.botTokenEnv) ||
			typeof row.expectedBotUserId !== "string" ||
			!DISCORD_SNOWFLAKE.test(row.expectedBotUserId)
		) {
			fail(
				"identity_migration_roster_invalid",
				`roster[${index}] has invalid projectName, leadId, token selector, or bot id`,
			);
		}
		const selector = `${row.projectName}\0${row.leadId}`;
		if (selectors.has(selector)) {
			fail(
				"identity_migration_roster_invalid",
				`duplicate roster row ${row.projectName}/${row.leadId}`,
			);
		}
		if (botIds.has(row.expectedBotUserId)) {
			fail(
				"identity_migration_roster_invalid",
				`duplicate expected bot id ${row.expectedBotUserId}`,
			);
		}
		selectors.add(selector);
		botIds.add(row.expectedBotUserId);
		return row as unknown as RosterRow;
	});
}

function assertCleanEnvironment(
	env: NodeJS.ProcessEnv,
	roster: RosterRow[],
): void {
	const allowedTokens = new Set(roster.map((row) => row.botTokenEnv));
	const dirtyIdentity = AMBIENT_IDENTITY_KEYS.filter((name) =>
		Boolean(env[name]),
	);
	const unlistedTokens = Object.keys(env).filter(
		(name) =>
			name.endsWith("_BOT_TOKEN") &&
			Boolean(env[name]) &&
			!allowedTokens.has(name),
	);
	const dirty = [...new Set([...dirtyIdentity, ...unlistedTokens])].sort();
	if (dirty.length > 0) {
		fail(
			"identity_migration_dirty_environment",
			`run under env -i; unexpected identity variables: ${dirty.join(",")}`,
		);
	}
}

function registryRows(projects: RegistryProject[]): Array<{
	lead: RegistryLead;
	projectName: string;
	leadId: string;
	botTokenEnv: string;
}> {
	const rows: Array<{
		lead: RegistryLead;
		projectName: string;
		leadId: string;
		botTokenEnv: string;
	}> = [];
	for (const project of projects) {
		for (const [leadIndex, lead] of project.leads.entries()) {
			if (
				lead === null ||
				typeof lead !== "object" ||
				typeof lead.agentId !== "string"
			) {
				fail(
					"identity_migration_source_error",
					`${project.projectName}.leads[${leadIndex}] has an invalid migration shape`,
				);
			}
			if (lead.botTokenEnv === undefined || lead.botTokenEnv === null) continue;
			if (
				typeof lead.botTokenEnv !== "string" ||
				!ENV_NAME.test(lead.botTokenEnv)
			) {
				fail(
					"identity_migration_source_error",
					`${project.projectName}/${lead.agentId} has invalid botTokenEnv`,
				);
			}
			rows.push({
				lead,
				projectName: project.projectName,
				leadId: lead.agentId,
				botTokenEnv: lead.botTokenEnv,
			});
		}
	}
	return rows;
}

function atomicWrite(path: string, contents: string, mode: number): void {
	const parent = dirname(path);
	const temp = join(
		parent,
		`.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
	);
	let fd: number | undefined;
	try {
		fd = openSync(temp, "wx", mode);
		writeSync(fd, contents);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temp, path);
		const dirFd = openSync(parent, "r");
		try {
			fsyncSync(dirFd);
		} finally {
			closeSync(dirFd);
		}
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		fail(
			"identity_migration_write_error",
			`atomic write failed for ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export async function migrateLeadBotUserIds(
	input: MigrateLeadBotUserIdsInput,
): Promise<MigrateLeadBotUserIdsResult> {
	const projectsSource = parseJsonFile(input.projectsPath, "projects registry");
	const rosterSource = parseJsonFile(input.rosterPath, "expected roster");
	const roster = parseRoster(rosterSource.value);
	const env = input.env ?? process.env;
	assertCleanEnvironment(env, roster);
	const projects = projectsArray(projectsSource.value);
	const managed = registryRows(projects);
	const registryBySelector = new Map(
		managed.map((row) => [`${row.projectName}\0${row.leadId}`, row]),
	);
	if (
		registryBySelector.size !== managed.length ||
		managed.length !== roster.length
	) {
		fail(
			"identity_migration_roster_mismatch",
			`managed registry rows (${managed.length}) do not exactly match roster rows (${roster.length})`,
		);
	}
	for (const rosterRow of roster) {
		const row = registryBySelector.get(
			`${rosterRow.projectName}\0${rosterRow.leadId}`,
		);
		if (!row || row.botTokenEnv !== rosterRow.botTokenEnv) {
			fail(
				"identity_migration_roster_mismatch",
				`roster selector does not exactly match ${rosterRow.projectName}/${rosterRow.leadId}`,
			);
		}
		if (
			row.lead.botUserId !== undefined &&
			row.lead.botUserId !== rosterRow.expectedBotUserId
		) {
			fail(
				"identity_migration_roster_mismatch",
				`existing botUserId disagrees for ${rosterRow.projectName}/${rosterRow.leadId}`,
			);
		}
	}

	const fetchImpl = input.fetch ?? globalThis.fetch;
	if (!fetchImpl)
		fail("identity_migration_discord_error", "fetch is unavailable");
	const rows: MigrateLeadBotUserIdsResult["rows"] = [];
	for (const rosterRow of roster) {
		const token = env[rosterRow.botTokenEnv];
		if (!token) {
			fail(
				"identity_migration_token_missing",
				`${rosterRow.botTokenEnv} is unset or empty`,
			);
		}
		let response: Response;
		try {
			response = await fetchImpl(
				`${(input.discordApiBase ?? "https://discord.com/api/v10").replace(/\/$/, "")}/users/@me`,
				{ headers: { Authorization: `Bot ${token}` } },
			);
		} catch (error) {
			fail(
				"identity_migration_discord_error",
				`Discord identity request failed for ${rosterRow.projectName}/${rosterRow.leadId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!response.ok) {
			fail(
				"identity_migration_discord_error",
				`Discord identity request returned HTTP ${response.status} for ${rosterRow.projectName}/${rosterRow.leadId}`,
			);
		}
		let observed: unknown;
		try {
			observed = (await response.json()) as unknown;
		} catch {
			fail(
				"identity_migration_discord_error",
				`Discord identity response was not JSON for ${rosterRow.projectName}/${rosterRow.leadId}`,
			);
		}
		const observedId =
			observed !== null && typeof observed === "object" && "id" in observed
				? (observed as { id?: unknown }).id
				: undefined;
		if (observedId !== rosterRow.expectedBotUserId) {
			fail(
				"identity_migration_bot_mismatch",
				`Discord bot id disagrees with independent roster for ${rosterRow.projectName}/${rosterRow.leadId}`,
			);
		}
		registryBySelector.get(
			`${rosterRow.projectName}\0${rosterRow.leadId}`,
		)!.lead.botUserId = observedId;
		rows.push({
			projectName: rosterRow.projectName,
			leadId: rosterRow.leadId,
			botUserId: observedId,
		});
	}

	compileLeadIdentityRegistry(projectsSource.value, { homeDir: input.homeDir });
	if (existsSync(input.backupPath)) {
		fail(
			"identity_migration_write_error",
			`backup already exists: ${input.backupPath}`,
		);
	}
	const mode = statSync(input.projectsPath).mode & 0o777;
	atomicWrite(input.backupPath, projectsSource.raw, mode);
	atomicWrite(
		input.projectsPath,
		`${JSON.stringify(projectsSource.value, null, 2)}\n`,
		mode,
	);
	return {
		migrated: rows.length,
		projectsPath: input.projectsPath,
		backupPath: input.backupPath,
		rows,
	};
}
