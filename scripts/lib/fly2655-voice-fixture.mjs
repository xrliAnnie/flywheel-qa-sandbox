#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const PRODUCTION_GENERAL_VOICE_CHANNEL_ID = "1485787273193853170";
const SNOWFLAKE = /^[0-9]{17,20}$/;
const FIXTURE_KEYS = [
	"schemaVersion",
	"guildId",
	"voiceChannelId",
	"qaCategoryId",
	"founderUserId",
	"allowUserIds",
];

function check(value, reason) {
	if (!value) throw new Error(reason);
}

function object(value, reason) {
	check(value && typeof value === "object" && !Array.isArray(value), reason);
	return value;
}

function snowflake(value, field) {
	check(typeof value === "string" && SNOWFLAKE.test(value), `${field}_invalid`);
	return value;
}

function privateWrite(path, bytes) {
	const temporary = `${path}.tmp.${process.pid}`;
	writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
	chmodSync(temporary, 0o600);
	renameSync(temporary, path);
}

function readRegularJson(path, label) {
	const info = lstatSync(path);
	check(
		info.isFile() && !info.isSymbolicLink(),
		`${label}_regular_file_required`,
	);
	return JSON.parse(readFileSync(path, "utf8"));
}

function slotPath(slotDir, ...parts) {
	check(isAbsolute(slotDir) && resolve(slotDir) !== sep, "slot_dir_invalid");
	const root = resolve(slotDir);
	const path = resolve(root, ...parts);
	check(path.startsWith(`${root}${sep}`), "slot_path_escape");
	return path;
}

export function parseVoiceFixture(raw) {
	const value = object(raw, "fixture_object_required");
	for (const key of Object.keys(value)) {
		check(FIXTURE_KEYS.includes(key), `fixture_unknown_key:${key}`);
	}
	for (const key of FIXTURE_KEYS) {
		check(Object.hasOwn(value, key), `fixture_missing_key:${key}`);
	}
	check(value.schemaVersion === 1, "fixture_schema_invalid");
	const guildId = snowflake(value.guildId, "guild_id");
	const voiceChannelId = snowflake(value.voiceChannelId, "voice_channel_id");
	const qaCategoryId = snowflake(value.qaCategoryId, "qa_category_id");
	const founderUserId = snowflake(value.founderUserId, "founder_user_id");
	check(
		voiceChannelId !== PRODUCTION_GENERAL_VOICE_CHANNEL_ID,
		"production_general_rejected",
	);
	check(
		Array.isArray(value.allowUserIds) && value.allowUserIds.length > 0,
		"allow_user_ids_required",
	);
	const allowUserIds = value.allowUserIds.map((id) =>
		snowflake(id, "allow_user_id"),
	);
	check(
		new Set(allowUserIds).size === allowUserIds.length,
		"allow_user_ids_duplicate",
	);
	check(allowUserIds.includes(founderUserId), "founder_not_allowlisted");
	return {
		schemaVersion: 1,
		guildId,
		voiceChannelId,
		qaCategoryId,
		founderUserId,
		allowUserIds,
	};
}

export function buildVoiceFixtureArtifacts(input) {
	const fixture = parseVoiceFixture(input.fixture);
	const slotDir = resolve(input.slotDir);
	check(isAbsolute(input.slotDir) && slotDir !== sep, "slot_dir_invalid");
	check(Array.isArray(input.projects), "projects_array_required");
	const projects = structuredClone(input.projects);
	const matchingProjects = projects.filter(
		(project) => project?.projectName === input.projectName,
	);
	check(matchingProjects.length === 1, "fixture_project_not_unique");
	const project = matchingProjects[0];
	check(project.huddle == null, "legacy_huddle_conflict");
	check(Array.isArray(project.leads), "fixture_project_leads_required");
	const matchingLeads = project.leads.filter(
		(lead) => lead?.agentId === input.leadId,
	);
	check(matchingLeads.length === 1, "fixture_lead_not_unique");
	const lead = matchingLeads[0];
	check(lead.botUserId === input.botUserId, "fixture_bot_identity_mismatch");
	check(
		lead.botTokenEnv === input.botTokenEnv,
		"fixture_bot_token_env_mismatch",
	);
	check(
		lead.codexVoiceActions === undefined,
		"model_voice_actions_must_remain_default_off",
	);
	project.voiceRoom = {
		guildId: fixture.guildId,
		voiceChannelId: fixture.voiceChannelId,
	};
	lead.voiceModes = { meeting: true, rg: true };

	const stateDir = slotPath(slotDir, "state");
	const voiceRoot = slotPath(slotDir, "state", "voice");
	const codexHome = slotPath(slotDir, "state", "voice-codex-home");
	const evidenceRoot = slotPath(slotDir, "state", "voice-evidence");
	const meetingStateDir = slotPath(slotDir, "state", "meetings");
	const commRoot = slotPath(slotDir, "state", "comm", input.projectName);
	for (const path of [
		stateDir,
		voiceRoot,
		codexHome,
		evidenceRoot,
		meetingStateDir,
		commRoot,
	]) {
		mkdirSync(path, { recursive: true, mode: 0o700 });
		chmodSync(path, 0o700);
	}
	const voiceHostPath = join(stateDir, "voice-host.json");
	const meetingNotesPath = join(stateDir, "meeting-notes.yaml");
	const receiptPath = join(slotDir, "voice-fixture.json");
	privateWrite(
		join(codexHome, "config.toml"),
		'forced_login_method = "api"\ncli_auth_credentials_store = "ephemeral"\n',
	);
	privateWrite(
		voiceHostPath,
		`${JSON.stringify(
			{
				schemaVersion: 1,
				qaVoiceChannelIds: [fixture.voiceChannelId],
				qaAllowUserIds: fixture.allowUserIds,
				evidenceRoots: [evidenceRoot],
			},
			null,
			2,
		)}\n`,
	);
	privateWrite(
		meetingNotesPath,
		[
			`meetingStateDir: ${meetingStateDir}`,
			"linear:",
			"  team: FLY",
			"  project: Flywheel",
			"  meetingLabel: meeting",
			"  departmentLabel: qa",
			"dispatch:",
			"  taskCategory: prd",
			`  leadId: ${input.leadId}`,
			"tickIntervalSeconds: 60",
			"",
		].join("\n"),
	);
	const result = {
		projects,
		projectsSha256: createHash("sha256")
			.update(JSON.stringify(projects))
			.digest("hex"),
		fixture,
		voiceHostPath,
		meetingNotesPath,
		voiceRoot,
		codexHome,
		evidenceRoot,
		meetingStateDir,
		commDbPath: join(commRoot, "comm.db"),
		receiptPath,
	};
	privateWrite(
		receiptPath,
		`${JSON.stringify(
			{
				schemaVersion: 1,
				status: "INSTALLED",
				projectName: input.projectName,
				leadId: input.leadId,
				botUserId: input.botUserId,
				botTokenEnv: input.botTokenEnv,
				fixture,
				voiceHostPath,
				meetingNotesPath,
				voiceRoot,
				codexHome,
				evidenceRoot,
				meetingStateDir,
				commDbPath: result.commDbPath,
				projectsSha256: result.projectsSha256,
			},
			null,
			2,
		)}\n`,
	);
	return result;
}

export function finalizeVoiceFixtureReceipt(input) {
	check(
		isAbsolute(input.receiptPath) && isAbsolute(input.projectsPath),
		"finalize_paths_must_be_absolute",
	);
	const receiptPath = resolve(input.receiptPath);
	const projectsPath = resolve(input.projectsPath);
	check(
		dirname(receiptPath) === dirname(projectsPath),
		"finalize_slot_mismatch",
	);
	const receipt = object(
		readRegularJson(receiptPath, "fixture_receipt"),
		"fixture_receipt_object_required",
	);
	check(
		receipt.schemaVersion === 1 && receipt.status === "INSTALLED",
		"fixture_receipt_invalid",
	);
	const fixture = parseVoiceFixture(receipt.fixture);
	const projects = readRegularJson(projectsPath, "projects");
	check(Array.isArray(projects), "projects_array_required");
	const matchingProjects = projects.filter(
		(project) => project?.projectName === receipt.projectName,
	);
	check(matchingProjects.length === 1, "fixture_project_not_unique");
	const project = matchingProjects[0];
	const matchingLeads = project.leads?.filter(
		(lead) => lead?.agentId === receipt.leadId,
	);
	check(matchingLeads?.length === 1, "fixture_lead_not_unique");
	const lead = matchingLeads[0];
	check(
		lead.botUserId === receipt.botUserId &&
			lead.botTokenEnv === receipt.botTokenEnv,
		"fixture_bot_identity_mismatch",
	);
	check(
		project.voiceRoom?.guildId === fixture.guildId &&
			project.voiceRoom?.voiceChannelId === fixture.voiceChannelId &&
			lead.voiceModes?.rg === true &&
			lead.voiceModes?.meeting === true &&
			lead.codexVoiceActions !== true,
		"slot_voice_registry_drift",
	);
	const projectsSha256 = createHash("sha256")
		.update(readFileSync(projectsPath))
		.digest("hex");
	privateWrite(
		receiptPath,
		`${JSON.stringify({ ...receipt, projectsSha256 }, null, 2)}\n`,
	);
	return { receiptPath, projectsPath, projectsSha256 };
}

function cli(argv) {
	const command = argv[0];
	const { values } = parseArgs({
		args: argv.slice(1),
		options: {
			fixture: { type: "string" },
			projects: { type: "string" },
			receipt: { type: "string" },
			"slot-dir": { type: "string" },
			project: { type: "string" },
			lead: { type: "string" },
			"bot-user": { type: "string" },
			"bot-token-env": { type: "string" },
		},
		allowPositionals: false,
	});
	if (command === "finalize") {
		check(values.receipt, "receipt_required");
		check(values.projects, "projects_required");
		process.stdout.write(
			`${JSON.stringify(
				finalizeVoiceFixtureReceipt({
					receiptPath: values.receipt,
					projectsPath: values.projects,
				}),
			)}\n`,
		);
		return;
	}
	check(values.fixture, "fixture_path_required");
	const fixture = parseVoiceFixture(readRegularJson(values.fixture, "fixture"));
	if (command === "validate") {
		process.stdout.write(`${JSON.stringify(fixture)}\n`);
		return;
	}
	check(command === "install", "validate_install_or_finalize_required");
	for (const key of [
		"projects",
		"slot-dir",
		"project",
		"lead",
		"bot-user",
		"bot-token-env",
	]) {
		check(values[key], `${key}_required`);
	}
	const result = buildVoiceFixtureArtifacts({
		fixture,
		projects: readRegularJson(values.projects, "projects"),
		slotDir: values["slot-dir"],
		projectName: values.project,
		leadId: values.lead,
		botUserId: values["bot-user"],
		botTokenEnv: values["bot-token-env"],
	});
	process.stdout.write(`${JSON.stringify(result.projects)}\n`);
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		cli(process.argv.slice(2));
	} catch (error) {
		console.error(
			`fly2655-voice-fixture: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exitCode = 1;
	}
}
