#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
// FLY-2655: QA-owned lifecycle for one generalized 529 slot voice process.
// This script never installs launchd state and never targets the production bot/room.
import {
	closeSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

import { PRODUCTION_GENERAL_VOICE_CHANNEL_ID } from "../lib/fly2655-voice-fixture.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SLOT_RE = /^\/((private\/)?tmp)\/flywheel-test-slot-[1-9][0-9]*$/;
const SLOT_PATH_RE =
	/^\/((?:private\/)?tmp)\/(flywheel-test-slot-[1-9][0-9]*)(?:\/(.*))?$/;
const SHA = /^[a-f0-9]{40}$/;

function check(value, reason) {
	if (!value) throw new Error(reason);
}

function slotRelativePath(root, path, reason) {
	check(typeof path === "string" && isAbsolute(path), reason);
	const resolvedRoot = resolve(root);
	const resolvedPath = resolve(path);
	let rel = relative(resolvedRoot, resolvedPath);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		const rootSlot = SLOT_PATH_RE.exec(resolvedRoot);
		const pathSlot = SLOT_PATH_RE.exec(resolvedPath);
		check(rootSlot?.[2] && rootSlot[2] === pathSlot?.[2], reason);
		rel = pathSlot[3] ?? "";
	}
	check(
		rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel),
		reason,
	);
	return rel;
}

function contained(root, path, reason = "path_outside_slot") {
	slotRelativePath(root, path, reason);
	return path;
}

function trusted(root, path) {
	const canonicalRoot = realpathSync(root);
	const rel = slotRelativePath(canonicalRoot, path, "path_outside_slot");
	let current = canonicalRoot;
	for (const part of rel.split(sep).filter(Boolean)) {
		current = join(current, part);
		check(!lstatSync(current).isSymbolicLink(), "slot_symlink_rejected");
	}
	contained(canonicalRoot, realpathSync(current));
	return current;
}

function json(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function privateWrite(path, value) {
	const temporary = `${path}.tmp.${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
		mode: 0o600,
		flag: "wx",
	});
	renameSync(temporary, path);
}

function envArray(values) {
	return Object.fromEntries(
		values.map((entry) => {
			const index = entry.indexOf("=");
			check(index > 0, "launch_environment_invalid");
			return [entry.slice(0, index), entry.slice(index + 1)];
		}),
	);
}

function mode600Regular(path, reason) {
	const info = lstatSync(path);
	check(info.isFile() && !info.isSymbolicLink(), reason);
	check((info.mode & 0o777) === 0o600, reason);
	const uid = process.getuid?.();
	check(uid === undefined || info.uid === uid, reason);
	return path;
}

function readSecret(slotDir, launch, name) {
	const records = launch.secretEnvironment.filter(
		(entry) => entry.name === name,
	);
	check(records.length === 1, `slot_secret_not_unique:${name}`);
	const path = mode600Regular(
		trusted(slotDir, records[0].path),
		`slot_secret_not_private:${name}`,
	);
	const value = readFileSync(path, "utf8").trim();
	check(value.length > 0, `slot_secret_empty:${name}`);
	return value;
}

function parseManagedEnvValue(source, name) {
	const matches = [
		...source.matchAll(
			new RegExp(`^(?:export[ \\t]+)?${name}[ \\t]*=[ \\t]*(.*)$`, "gm"),
		),
	];
	check(matches.length === 1, `${name}_clean_source_not_unique`);
	const raw = matches[0][1].trim();
	let value;
	if (raw.startsWith("'") && raw.endsWith("'")) {
		value = raw.slice(1, -1);
	} else if (raw.startsWith('"') && raw.endsWith('"')) {
		value = JSON.parse(raw);
	} else {
		check(!/[#'"`$\\\s]/.test(raw), `${name}_clean_source_unsafe`);
		value = raw;
	}
	check(
		typeof value === "string" && value.trim(),
		`${name}_clean_source_empty`,
	);
	return value;
}

function readManagedOpenAiKey(homeDir = homedir()) {
	const path = join(homeDir, ".flywheel", ".env");
	mode600Regular(path, "managed_clean_source_invalid");
	return parseManagedEnvValue(readFileSync(path, "utf8"), "OPENAI_API_KEY");
}

export function validatePreparedTopology(t) {
	check(SLOT_RE.test(t.slotDir), "529_slot_directory_required");
	check(
		SHA.test(t.buildSha) && t.buildSha === t.expectedHead,
		"checkout_head_drift",
	);
	check(t.founderUserId === t.discordOwnerUserId, "founder_identity_mismatch");
	check(
		Array.isArray(t.qaVoiceChannelIds) &&
			t.qaVoiceChannelIds.includes(t.voiceChannelId),
		"529_voice_channel_not_allowlisted",
	);
	check(
		t.voiceChannelId !== PRODUCTION_GENERAL_VOICE_CHANNEL_ID,
		"production_general_rejected",
	);
	contained(t.slotDir, t.commDbPath, "comm_db_outside_slot");
	return t;
}

export function validateDiscordVoiceTarget(channel, topology) {
	check(channel && typeof channel === "object", "discord_channel_invalid");
	check(
		channel.id === topology.voiceChannelId,
		"voice_channel_identity_mismatch",
	);
	check(channel.guild_id === topology.guildId, "voice_guild_identity_mismatch");
	check(channel.type === 2, "discord_target_not_voice");
	check(channel.parent_id === topology.qaCategoryId, "qa_category_mismatch");
	return channel;
}

export function summarizeVoiceEvidence(events, journal) {
	const runtimeEvents = events.filter(
		(event) => event.kind === "voice_receive_runtime",
	);
	const runtime = runtimeEvents.length === 1 ? runtimeEvents[0] : undefined;
	const receiveRuntime =
		runtime &&
		typeof runtime.buildSha === "string" &&
		typeof runtime.voiceVersion === "string" &&
		typeof runtime.daveyVersion === "string" &&
		typeof runtime.nodeVersion === "string" &&
		typeof runtime.arch === "string" &&
		typeof runtime.daveEncryption === "boolean" &&
		Number.isSafeInteger(runtime.decryptionFailureTolerance) &&
		typeof runtime.debug === "boolean"
			? {
					buildSha: runtime.buildSha,
					voiceVersion: runtime.voiceVersion,
					daveyVersion: runtime.daveyVersion,
					nodeVersion: runtime.nodeVersion,
					arch: runtime.arch,
					daveEncryption: runtime.daveEncryption,
					decryptionFailureTolerance: runtime.decryptionFailureTolerance,
					debug: runtime.debug,
				}
			: null;
	const utterances = events.filter(
		(event) => event.kind === "uplink_gate_utterance",
	);
	let framesPassed = 0;
	let framesKnown = utterances.length > 0;
	const seen = new Map();
	for (const event of utterances) {
		if (!Number.isSafeInteger(event.framesPassed) || event.framesPassed < 0) {
			framesKnown = false;
			continue;
		}
		let key;
		if (typeof event.utteranceId === "string" && event.utteranceId) {
			key = `id:${event.utteranceId}`;
		} else if (event.openAtMs === undefined && event.framesPassed === 0) {
			continue;
		} else if (
			typeof event.openAtMs === "number" &&
			Number.isFinite(event.openAtMs) &&
			typeof event.ts === "string" &&
			event.ts &&
			typeof event.mode === "string" &&
			event.mode
		) {
			key = `legacy:${event.openAtMs}:${event.ts}:${event.mode}`;
		} else {
			framesKnown = false;
			continue;
		}
		const digest = JSON.stringify(event);
		const prior = seen.get(key);
		if (prior) {
			if (prior !== digest) framesKnown = false;
			continue;
		}
		seen.set(key, digest);
		framesPassed += event.framesPassed;
	}
	return {
		receiveRuntime,
		framesPassed: framesKnown ? framesPassed : null,
		framesEvidence: framesKnown ? "known" : "unknown",
		userTranscriptCount: events.filter(
			(event) =>
				(event.kind === "realtime_input_terminal" &&
					event.status === "delivered") ||
				(event.kind === "realtime_transcript" && event.role === "user"),
		).length,
		assistantTranscriptCount: events.filter(
			(event) =>
				event.kind === "realtime_output_validated" ||
				(event.kind === "realtime_transcript" && event.role === "assistant"),
		).length,
		playbackSubmittedCount: events.filter(
			(event) => event.kind === "realtime_playback_submitted",
		).length,
		mirroredCount: journal.filter((event) => event.kind === "mirrored").length,
		ingestedCount: journal.filter((event) => event.kind === "ingested").length,
	};
}

export function assertQaIdentityDisjoint(
	productionProjects,
	topology,
	botUserId,
) {
	check(Array.isArray(productionProjects), "production_registry_invalid");
	check(
		!productionProjects.some(
			(project) =>
				project?.voiceRoom?.voiceChannelId === topology.voiceChannelId ||
				project?.leads?.some((lead) => lead.botUserId === botUserId),
		),
		"qa_identity_overlaps_production",
	);
	return true;
}

function effectiveDiscordPermissions(channel, member, roles, topology) {
	check(
		Array.isArray(member?.roles) && Array.isArray(roles),
		"discord_member_roles_invalid",
	);
	const memberRoleIds = new Set([topology.guildId, ...member.roles]);
	let permissions = 0n;
	for (const role of roles) {
		if (memberRoleIds.has(role.id)) permissions |= BigInt(role.permissions);
	}
	const ADMINISTRATOR = 1n << 3n;
	if ((permissions & ADMINISTRATOR) === ADMINISTRATOR) return ~0n;
	{
		const overwrites = Array.isArray(channel.permission_overwrites)
			? channel.permission_overwrites
			: [];
		const apply = (allow, deny) => {
			permissions = (permissions & ~deny) | allow;
		};
		const everyone = overwrites.find(
			(overwrite) => overwrite.type === 0 && overwrite.id === topology.guildId,
		);
		if (everyone) apply(BigInt(everyone.allow), BigInt(everyone.deny));
		let roleAllow = 0n;
		let roleDeny = 0n;
		for (const overwrite of overwrites) {
			if (
				overwrite.type === 0 &&
				overwrite.id !== topology.guildId &&
				memberRoleIds.has(overwrite.id)
			) {
				roleAllow |= BigInt(overwrite.allow);
				roleDeny |= BigInt(overwrite.deny);
			}
		}
		apply(roleAllow, roleDeny);
		const userId = member.user?.id;
		check(typeof userId === "string", "discord_member_user_invalid");
		const memberOverwrite = overwrites.find(
			(overwrite) => overwrite.type === 1 && overwrite.id === userId,
		);
		if (memberOverwrite)
			apply(BigInt(memberOverwrite.allow), BigInt(memberOverwrite.deny));
	}
	return permissions;
}

export function validateDiscordVoicePermissions(
	channel,
	member,
	roles,
	topology,
) {
	const permissions = effectiveDiscordPermissions(
		channel,
		member,
		roles,
		topology,
	);
	const required = (1n << 10n) | (1n << 20n) | (1n << 21n);
	check(
		(permissions & required) === required,
		"discord_voice_permissions_missing",
	);
	return true;
}

export function validateDiscordThreadPermissions(
	channel,
	member,
	roles,
	topology,
	parentChannel = channel,
) {
	check(
		channel?.id === topology.threadId && channel.guild_id === topology.guildId,
		"discord_thread_identity_mismatch",
	);
	check([10, 11, 12].includes(channel.type), "discord_target_not_thread");
	check(
		parentChannel.id === channel.parent_id &&
			parentChannel.guild_id === topology.guildId,
		"discord_thread_parent_mismatch",
	);
	const permissions = effectiveDiscordPermissions(
		parentChannel,
		member,
		roles,
		topology,
	);
	const required = (1n << 10n) | (1n << 38n);
	check(
		(permissions & required) === required,
		"discord_thread_permissions_missing",
	);
	return true;
}

export function buildVoiceProcessEnv(input) {
	const stateDir = join(input.slotDir, "state");
	const projects = JSON.parse(input.projectsJson);
	check(
		Array.isArray(projects) &&
			projects.filter((project) => project.projectName === input.projectName)
				.length === 1,
		"slot_project_not_unique",
	);
	const tokenName = input.botTokenEnv;
	check(SHA.test(input.buildSha), "voice_build_sha_invalid");
	check(
		/^TEST_BOT_TOKEN_[1-9][0-9]*$/.test(tokenName),
		"test_bot_token_required",
	);
	for (const path of [
		input.projectsPath,
		input.voiceHostPath,
		input.meetingNotesPath,
	])
		contained(input.slotDir, path);
	const engineEnv = Object.fromEntries(
		[
			"FLYWHEEL_VOICE_ENGINE",
			"FLYWHEEL_VOICE_EDGE_TTS_STREAM_CMD",
			"FLYWHEEL_HEADPHONE_BACKGROUND_ENABLED",
		].flatMap((name) =>
			typeof input.baseEnv[name] === "string"
				? [[name, input.baseEnv[name]]]
				: [],
		),
	);
	return {
		HOME: input.baseEnv.HOME,
		PATH: input.baseEnv.PATH,
		TMPDIR: join(input.slotDir, "tmp"),
		BRIDGE_URL: input.bridgeUrl,
		FLYWHEEL_BRIDGE_URL: input.bridgeUrl,
		TEAMLEAD_API_TOKEN: input.apiToken,
		OPENAI_API_KEY: input.openAiApiKey,
		[tokenName]: input.botToken,
		FLYWHEEL_PROJECTS_FILE: input.projectsPath,
		FLYWHEEL_PROJECTS: input.projectsJson,
		FLYWHEEL_STATE_DIR: stateDir,
		FLYWHEEL_COMM_DB: join(stateDir, "comm", input.projectName, "comm.db"),
		FLYWHEEL_VOICE_STATE_DIR: join(stateDir, "voice"),
		FLYWHEEL_VOICE_CODEX_HOME: join(stateDir, "voice-codex-home"),
		FLYWHEEL_VOICE_BUILD_SHA: input.buildSha,
		FLYWHEEL_VOICE_HOST_CONFIG: input.voiceHostPath,
		FLYWHEEL_MEETING_NOTES_CONFIG: input.meetingNotesPath,
		...engineEnv,
		FLYWHEEL_DIR: input.repoRoot,
		FLYWHEEL_COMM_CLI: join(
			input.repoRoot,
			"packages",
			"flywheel-comm",
			"dist",
			"index.js",
		),
	};
}

export function voiceProcessBaseEnv(env = process.env) {
	return {
		HOME: env.HOME ?? homedir(),
		PATH: env.PATH ?? "/usr/bin:/bin",
		...Object.fromEntries(
			[
				"FLYWHEEL_VOICE_ENGINE",
				"FLYWHEEL_VOICE_EDGE_TTS_STREAM_CMD",
				"FLYWHEEL_HEADPHONE_BACKGROUND_ENABLED",
			].flatMap((name) =>
				typeof env[name] === "string" ? [[name, env[name]]] : [],
			),
		),
	};
}

function filesUnder(path) {
	return readdirSync(path, { withFileTypes: true })
		.sort((a, b) => a.name.localeCompare(b.name))
		.flatMap((entry) => {
			const child = join(path, entry.name);
			check(!lstatSync(child).isSymbolicLink(), "artifact_symlink_rejected");
			return entry.isDirectory() ? filesUnder(child) : [child];
		});
}

function hashTree(path) {
	const hash = createHash("sha256");
	for (const file of filesUnder(path)) {
		hash.update(relative(path, file));
		hash.update("\0");
		hash.update(readFileSync(file));
		hash.update("\0");
	}
	return hash.digest("hex");
}

function hashFile(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function artifactDigests() {
	return Object.fromEntries(
		["voice-core", "voice-bridge", "voice-codex"].map((name) => [
			name,
			hashTree(join(repo, "packages", name, "dist")),
		]),
	);
}

function configurationDigests(context) {
	return {
		projects: hashFile(context.projectsPath),
		voiceHost: hashFile(context.fixtureReceipt.voiceHostPath),
		meetingNotes: hashFile(context.fixtureReceipt.meetingNotesPath),
		bridgeLaunch: hashFile(
			join(context.topology.slotDir, "bridge-launch.json"),
		),
		commCli: hashFile(join(repo, "packages/flywheel-comm/dist/index.js")),
	};
}

function readJsonLines(slotDir, path) {
	if (!existsSync(path)) return [];
	trusted(slotDir, path);
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function processIdentity(pid) {
	return execFileSync("ps", ["-o", "lstart=,command=", "-p", String(pid)], {
		encoding: "utf8",
	}).trim();
}

function processAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function discordJson(path, token) {
	const response = await fetch(`https://discord.com/api/v10${path}`, {
		headers: { Authorization: `Bot ${token}` },
		signal: AbortSignal.timeout(10_000),
	});
	check(response.ok, `discord_http_${response.status}`);
	return response.json();
}

async function bridgeJson(url, token, path, init = {}) {
	const response = await fetch(`${url.replace(/\/$/, "")}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			...(init.body ? { "Content-Type": "application/json" } : {}),
		},
		signal: AbortSignal.timeout(10_000),
	});
	const body = await response.json();
	check(response.ok, `bridge_http_${response.status}`);
	return body;
}

async function waitForClaim(context, token, sessionId) {
	for (let attempt = 0; attempt < 120; attempt += 1) {
		const session = await bridgeJson(
			context.room.bridgeUrl,
			token,
			`/api/voice/sessions/${sessionId}`,
		);
		if (["claimed", "warming", "live"].includes(session.state)) return session;
		check(
			!["failed", "cancelled", "ended"].includes(session.state),
			`voice_session_terminal_before_claim:${session.state}`,
		);
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
	}
	throw new Error("voice_session_claim_timeout");
}

async function waitForTerminal(context, token, sessionId) {
	for (let attempt = 0; attempt < 120; attempt += 1) {
		const session = await bridgeJson(
			context.room.bridgeUrl,
			token,
			`/api/voice/sessions/${sessionId}`,
		);
		if (["ended", "cancelled", "failed"].includes(session.state))
			return session;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
	}
	throw new Error("voice_session_stop_timeout");
}

async function waitForProcessExit(pid) {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (!processAlive(pid)) return;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
	}
	throw new Error("voice_process_stop_timeout");
}

export function loadSlot(slotDir, expectedHead) {
	const canonical = realpathSync(slotDir);
	check(SLOT_RE.test(canonical), "529_slot_directory_required");
	const room = json(trusted(canonical, join(canonical, "room-info.json")));
	const launch = json(
		trusted(canonical, join(canonical, "bridge-launch.json")),
	);
	const fixtureReceipt = json(
		trusted(canonical, join(canonical, "voice-fixture.json")),
	);
	const projectsPath = trusted(canonical, room.flywheelProjectsFile);
	const projectsBytes = readFileSync(projectsPath);
	const projectsJson = projectsBytes.toString("utf8").trim();
	const projects = JSON.parse(projectsJson);
	const host = json(trusted(canonical, fixtureReceipt.voiceHostPath));
	const launchEnv = envArray(launch.environment);
	check(launch.repoRoot === room.flywheelRepo, "slot_repo_identity_mismatch");
	check(
		realpathSync(room.flywheelRepo) === realpathSync(repo),
		"slot_checkout_root_drift",
	);
	check(
		isDeepStrictEqual(JSON.parse(launchEnv.FLYWHEEL_PROJECTS), projects),
		"projects_env_file_drift",
	);
	check(
		createHash("sha256").update(projectsBytes).digest("hex") ===
			fixtureReceipt.projectsSha256,
		"projects_fixture_digest_drift",
	);
	check(
		trusted(canonical, launchEnv.FLYWHEEL_PROJECTS_FILE) === projectsPath,
		"projects_path_drift",
	);
	check(
		launchEnv.DISCORD_OWNER_USER_ID === fixtureReceipt.fixture.founderUserId,
		"founder_identity_mismatch",
	);
	const project = projects.find(
		(entry) => entry.projectName === room.projectName,
	);
	check(project, "slot_project_missing");
	const lead = project.leads?.find((entry) => entry.agentId === room.agentId);
	check(lead, "slot_lead_missing");
	check(
		project.voiceRoom?.guildId === fixtureReceipt.fixture.guildId &&
			project.voiceRoom?.voiceChannelId ===
				fixtureReceipt.fixture.voiceChannelId &&
			lead.voiceModes?.rg === true &&
			lead.voiceModes?.meeting === true &&
			lead.codexVoiceActions !== true,
		"slot_voice_registry_drift",
	);
	const topology = validatePreparedTopology({
		slotDir: canonical,
		buildSha: room.buildSha,
		expectedHead,
		projectName: room.projectName,
		leadId: room.agentId,
		founderUserId: fixtureReceipt.fixture.founderUserId,
		discordOwnerUserId: launchEnv.DISCORD_OWNER_USER_ID,
		guildId: fixtureReceipt.fixture.guildId,
		voiceChannelId: fixtureReceipt.fixture.voiceChannelId,
		qaCategoryId: fixtureReceipt.fixture.qaCategoryId,
		qaVoiceChannelIds: host.qaVoiceChannelIds,
		commDbPath: fixtureReceipt.commDbPath,
	});
	return {
		topology,
		room,
		launch,
		fixtureReceipt,
		projectsPath,
		projectsJson,
		lead,
	};
}

function assertSlotLock(context) {
	const slot = context.room.slot;
	const pidPath = `/tmp/flywheel-test-slot-${slot}.lock/pid`;
	const owner = Number(readFileSync(pidPath, "utf8").trim());
	check(
		Number.isSafeInteger(owner) && processAlive(owner),
		"slot_lock_not_live",
	);
	check(
		context.launch.ownershipPidFiles.includes(pidPath),
		"slot_lock_not_owned_by_bridge",
	);
}

function voiceEnv(context) {
	const master = readFileSync(
		mode600Regular(
			trusted(context.topology.slotDir, context.room.apiTokenPath),
			"slot_master_not_private",
		),
		"utf8",
	).trim();
	check(master, "slot_master_empty");
	return buildVoiceProcessEnv({
		slotDir: context.topology.slotDir,
		repoRoot: repo,
		bridgeUrl: context.room.bridgeUrl,
		apiToken: master,
		botTokenEnv: context.lead.botTokenEnv,
		botToken: readSecret(
			context.topology.slotDir,
			context.launch,
			context.lead.botTokenEnv,
		),
		openAiApiKey: readManagedOpenAiKey(),
		projectsPath: context.projectsPath,
		projectsJson: context.projectsJson,
		projectName: context.topology.projectName,
		buildSha: context.topology.expectedHead,
		voiceHostPath: context.fixtureReceipt.voiceHostPath,
		meetingNotesPath: context.fixtureReceipt.meetingNotesPath,
		baseEnv: voiceProcessBaseEnv(),
	});
}

async function verifyRemote(context, env) {
	const health = await bridgeJson(
		context.room.bridgeUrl,
		env.TEAMLEAD_API_TOKEN,
		"/health",
	);
	check(
		health.ok === true &&
			health.buildMode === "built" &&
			health.buildSha === context.topology.expectedHead &&
			health.artifactBuildSha === context.topology.expectedHead,
		"slot_exact_head_not_ready",
	);
	const bot = await discordJson("/users/@me", env[context.lead.botTokenEnv]);
	check(bot.id === context.lead.botUserId, "test_bot_identity_mismatch");
	const productionProjectsPath = join(homedir(), ".flywheel", "projects.json");
	const productionProjectsInfo = lstatSync(productionProjectsPath);
	check(
		productionProjectsInfo.isFile() && !productionProjectsInfo.isSymbolicLink(),
		"production_registry_regular_file_required",
	);
	assertQaIdentityDisjoint(
		json(productionProjectsPath),
		context.topology,
		bot.id,
	);
	const channel = await discordJson(
		`/channels/${context.topology.voiceChannelId}`,
		env[context.lead.botTokenEnv],
	);
	validateDiscordVoiceTarget(channel, context.topology);
	const member = await discordJson(
		`/guilds/${context.topology.guildId}/members/${bot.id}`,
		env[context.lead.botTokenEnv],
	);
	const roles = await discordJson(
		`/guilds/${context.topology.guildId}/roles`,
		env[context.lead.botTokenEnv],
	);
	validateDiscordVoicePermissions(channel, member, roles, context.topology);
	return { botUserId: bot.id, channelId: channel.id, member, roles };
}

function requireCleanExactHead(expectedHead) {
	const head = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: repo,
		encoding: "utf8",
	}).trim();
	check(head === expectedHead && SHA.test(head), "checkout_head_drift");
	const dirty = execFileSync("git", ["status", "--porcelain"], {
		cwd: repo,
		encoding: "utf8",
	}).trim();
	check(!dirty, "checkout_not_clean");
}

async function prepare(args) {
	requireCleanExactHead(args.expectedHead);
	const context = loadSlot(args.slotDir, args.expectedHead);
	assertSlotLock(context);
	for (const packageName of [
		"flywheel-voice-core",
		"flywheel-voice-bridge",
		"flywheel-voice-codex",
	]) {
		execFileSync("pnpm", ["--filter", packageName, "build"], {
			cwd: repo,
			stdio: "inherit",
		});
	}
	const env = voiceEnv(context);
	const remote = await verifyRemote(context, env);
	execFileSync(
		process.execPath,
		[join(repo, "packages/voice-codex/dist/cli.js"), "--check-config"],
		{ cwd: repo, env, stdio: "inherit" },
	);
	const artifacts = artifactDigests();
	const configuration = configurationDigests(context);
	const receipt = {
		schemaVersion: 1,
		status: "READY",
		preparedAt: new Date().toISOString(),
		buildSha: args.expectedHead,
		artifacts,
		configurationDigests: configuration,
		topology: context.topology,
		botUserId: remote.botUserId,
		channelId: remote.channelId,
		environmentNames: Object.keys(env).sort(),
	};
	privateWrite(
		join(context.topology.slotDir, "voice-prepare-receipt.json"),
		receipt,
	);
	return receipt;
}

function roomLeasePath(topology) {
	return `/tmp/flywheel-voice-room-${topology.guildId}-${topology.voiceChannelId}.lock`;
}

export function acquireVoiceRoomLease(topology) {
	const path = roomLeasePath(topology);
	let created = false;
	try {
		mkdirSync(path, { mode: 0o700 });
		created = true;
		privateWrite(join(path, "owner.json"), {
			schemaVersion: 1,
			slotDir: topology.slotDir,
			projectName: topology.projectName,
			leadId: topology.leadId,
			voiceChannelId: topology.voiceChannelId,
		});
	} catch (error) {
		if (error?.code !== "EEXIST") throw error;
		const owner = json(join(path, "owner.json"));
		check(owner.slotDir === topology.slotDir, "voice_room_lease_conflict");
	}
	return { path, created };
}

export function releaseVoiceRoomLease(topology) {
	const path = roomLeasePath(topology);
	if (!existsSync(path)) return false;
	const owner = json(join(path, "owner.json"));
	check(owner.slotDir === topology.slotDir, "voice_room_lease_not_owned");
	rmSync(path, { recursive: true });
	return true;
}

function parseCliJson(output, reason) {
	const lines = output.trim().split("\n").filter(Boolean);
	check(lines.length > 0, reason);
	return JSON.parse(lines.at(-1));
}

async function start(args) {
	requireCleanExactHead(args.expectedHead);
	const context = loadSlot(args.slotDir, args.expectedHead);
	assertSlotLock(context);
	const prepared = json(
		trusted(args.slotDir, join(args.slotDir, "voice-prepare-receipt.json")),
	);
	check(
		prepared.status === "READY" && prepared.buildSha === args.expectedHead,
		"prepare_receipt_required",
	);
	check(
		JSON.stringify(prepared.artifacts) === JSON.stringify(artifactDigests()) &&
			JSON.stringify(prepared.configurationDigests) ===
				JSON.stringify(configurationDigests(context)),
		"prepared_artifact_digest_drift",
	);
	const env = voiceEnv(context);
	const remote = await verifyRemote(context, env);
	execFileSync(
		process.execPath,
		[join(repo, "packages/voice-codex/dist/cli.js"), "--check-config"],
		{ cwd: repo, env, stdio: "inherit" },
	);
	const lease = acquireVoiceRoomLease(context.topology);
	check(lease.created, "voice_room_lease_already_owned");
	const logPath = join(args.slotDir, "voice-daemon.log");
	const logFd = openSync(
		logPath,
		constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY,
		0o600,
	);
	let child;
	let session;
	try {
		child = spawn(
			process.execPath,
			[join(repo, "packages/voice-codex/dist/cli.js")],
			{
				cwd: repo,
				env,
				detached: true,
				stdio: ["ignore", logFd, logFd],
			},
		);
		child.unref();
	} catch (error) {
		if (lease.created) rmSync(lease.path, { recursive: true, force: true });
		throw error;
	} finally {
		closeSync(logFd);
	}
	const command = [
		join(repo, "packages/flywheel-comm/dist/index.js"),
		"voice-session",
		"start",
		"--mode",
		args.mode,
		"--project",
		context.topology.projectName,
		"--lead",
		context.topology.leadId,
		"--topic",
		args.topic,
	];
	let evidenceDir;
	if (args.mode === "meeting") {
		evidenceDir = join(
			context.fixtureReceipt.evidenceRoot,
			`meeting-${Date.now()}`,
		);
		mkdirSync(evidenceDir, { mode: 0o700 });
		command.push("--evidence-dir", evidenceDir);
	}
	try {
		check(child?.pid, "voice_spawn_failed");
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
		check(processAlive(child.pid), "voice_process_exited_early");
		session = parseCliJson(
			execFileSync(process.execPath, command, {
				cwd: repo,
				env,
				encoding: "utf8",
			}),
			"voice_session_start_empty",
		);
		check(typeof session.sessionId === "string", "voice_session_id_missing");
		const projected = await waitForClaim(
			context,
			env.TEAMLEAD_API_TOKEN,
			session.sessionId,
		);
		check(
			projected.projectName === context.topology.projectName &&
				projected.leadId === context.topology.leadId &&
				projected.guildId === context.topology.guildId &&
				projected.voiceChannelId === context.topology.voiceChannelId &&
				projected.voiceBotUserId === context.lead.botUserId,
			"claimed_session_tuple_mismatch",
		);
		check(
			typeof projected.threadId === "string",
			"claimed_session_thread_missing",
		);
		const thread = await discordJson(
			`/channels/${projected.threadId}`,
			env[context.lead.botTokenEnv],
		);
		check(
			thread.parent_id === context.lead.chatChannel,
			"claimed_session_thread_parent_mismatch",
		);
		const threadParent = await discordJson(
			`/channels/${thread.parent_id}`,
			env[context.lead.botTokenEnv],
		);
		validateDiscordThreadPermissions(
			thread,
			remote.member,
			remote.roles,
			{
				guildId: context.topology.guildId,
				threadId: projected.threadId,
			},
			threadParent,
		);
	} catch (error) {
		if (session?.sessionId) {
			try {
				execFileSync(
					process.execPath,
					[
						join(repo, "packages/flywheel-comm/dist/index.js"),
						"voice-session",
						"stop",
						"--session",
						session.sessionId,
					],
					{ cwd: repo, env, stdio: "ignore" },
				);
			} catch {
				// Preserve the primary failure; the exact session id remains in Bridge.
			}
		}
		if (child?.pid && processAlive(child.pid))
			process.kill(child.pid, "SIGTERM");
		if (lease.created) rmSync(lease.path, { recursive: true, force: true });
		throw error;
	}
	const receipt = {
		schemaVersion: 1,
		status: "STARTED",
		startedAt: new Date().toISOString(),
		buildSha: args.expectedHead,
		mode: args.mode,
		topic: args.topic,
		sessionId: session.sessionId,
		pid: child.pid,
		processIdentity: processIdentity(child.pid),
		leasePath: lease.path,
		logPath,
		evidencePath: evidenceDir
			? join(evidenceDir, "voice-evidence", "events.jsonl")
			: join(
					context.fixtureReceipt.voiceRoot,
					"sessions",
					session.sessionId,
					"events.jsonl",
				),
		journalPath: join(
			context.fixtureReceipt.voiceRoot,
			"sessions",
			session.sessionId,
			"journal.jsonl",
		),
	};
	privateWrite(join(args.slotDir, "voice-run-receipt.json"), receipt);
	return receipt;
}

function ownedProcess(run, cliPath) {
	if (!processAlive(run.pid)) return false;
	const current = processIdentity(run.pid);
	check(
		current === run.processIdentity && current.includes(cliPath),
		"voice_process_ownership_mismatch",
	);
	return true;
}

async function stop(args) {
	const context = loadSlot(args.slotDir, args.expectedHead);
	const runPath = trusted(
		args.slotDir,
		join(args.slotDir, "voice-run-receipt.json"),
	);
	const run = json(runPath);
	check(
		!args.sessionId || args.sessionId === run.sessionId,
		"session_receipt_mismatch",
	);
	if (run.status === "STOPPED") return run;
	const env = voiceEnv(context);
	const command = [
		join(repo, "packages/flywheel-comm/dist/index.js"),
		"voice-session",
		"stop",
		"--session",
		run.sessionId,
	];
	parseCliJson(
		execFileSync(process.execPath, command, {
			cwd: repo,
			env,
			encoding: "utf8",
		}),
		"voice_session_stop_empty",
	);
	const terminal = await waitForTerminal(
		context,
		env.TEAMLEAD_API_TOKEN,
		run.sessionId,
	);
	const cliPath = join(repo, "packages/voice-codex/dist/cli.js");
	if (ownedProcess(run, cliPath)) {
		process.kill(run.pid, "SIGTERM");
		await waitForProcessExit(run.pid);
	}
	releaseVoiceRoomLease(context.topology);
	run.status = "STOPPED";
	run.stoppedAt = new Date().toISOString();
	run.sessionState = terminal.state;
	privateWrite(runPath, run);
	return run;
}

async function verify(args) {
	const context = loadSlot(args.slotDir, args.expectedHead);
	const run = json(
		trusted(args.slotDir, join(args.slotDir, "voice-run-receipt.json")),
	);
	check(
		!args.sessionId || args.sessionId === run.sessionId,
		"session_receipt_mismatch",
	);
	const env = voiceEnv(context);
	const session = await bridgeJson(
		context.room.bridgeUrl,
		env.TEAMLEAD_API_TOKEN,
		`/api/voice/sessions/${run.sessionId}`,
	);
	check(
		session.projectName === context.topology.projectName &&
			session.leadId === context.topology.leadId &&
			session.voiceChannelId === context.topology.voiceChannelId,
		"verification_session_tuple_mismatch",
	);
	contained(
		context.topology.slotDir,
		run.evidencePath,
		"evidence_path_outside_slot",
	);
	contained(
		context.topology.slotDir,
		run.journalPath,
		"journal_path_outside_slot",
	);
	const events = readJsonLines(context.topology.slotDir, run.evidencePath);
	const journal = readJsonLines(context.topology.slotDir, run.journalPath);
	const evidenceSummary = summarizeVoiceEvidence(events, journal);
	check(
		evidenceSummary.receiveRuntime?.buildSha === args.expectedHead &&
			evidenceSummary.receiveRuntime.voiceVersion === "0.19.2" &&
			evidenceSummary.receiveRuntime.daveyVersion === "0.1.12" &&
			evidenceSummary.receiveRuntime.daveEncryption === true &&
			evidenceSummary.receiveRuntime.decryptionFailureTolerance === 36,
		"voice_receive_runtime_evidence_missing",
	);
	const receipt = {
		schemaVersion: 1,
		status: "EVIDENCE_CAPTURED",
		verifiedAt: new Date().toISOString(),
		buildSha: args.expectedHead,
		sessionId: run.sessionId,
		state: session.state,
		receiveHealth: session.receiveHealth ?? null,
		framesPassed: evidenceSummary.framesPassed,
		threadId: session.threadId,
		evidence: {
			path: run.evidencePath,
			sha256: existsSync(run.evidencePath) ? hashFile(run.evidencePath) : null,
			...evidenceSummary,
		},
		// Human-heard response and transcript evidence remain QA assertions.
		qaVerdict: "NOT_EVALUATED",
	};
	privateWrite(
		join(args.slotDir, `voice-verify-${run.sessionId}.json`),
		receipt,
	);
	return receipt;
}

function commandArgs(argv) {
	const command = argv[0];
	check(
		["prepare", "start", "stop", "verify"].includes(command),
		"prepare_start_stop_or_verify_required",
	);
	const { values } = parseArgs({
		args: argv.slice(1),
		options: {
			"slot-dir": { type: "string" },
			"expected-head": { type: "string" },
			mode: { type: "string" },
			topic: { type: "string" },
			session: { type: "string" },
		},
		allowPositionals: false,
	});
	check(
		values["slot-dir"] && values["expected-head"],
		"slot_dir_and_expected_head_required",
	);
	if (command === "start") {
		check(
			values.mode === "rg" || values.mode === "meeting",
			"start_mode_invalid",
		);
		check(values.topic?.trim(), "start_topic_required");
		check(
			Array.from(values.topic.trim()).length <= 200 &&
				Array.from(values.topic).every((character) => {
					const code = character.codePointAt(0);
					return code !== undefined && code >= 32 && code !== 127;
				}),
			"start_topic_invalid",
		);
	}
	return {
		command,
		slotDir: values["slot-dir"],
		expectedHead: values["expected-head"],
		mode: values.mode,
		topic: values.topic?.trim(),
		sessionId: values.session,
	};
}

async function main(argv) {
	const args = commandArgs(argv);
	const result =
		args.command === "prepare"
			? await prepare(args)
			: args.command === "start"
				? await start(args)
				: args.command === "stop"
					? await stop(args)
					: await verify(args);
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(
			`fly2655-voice-room: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exitCode = 1;
	});
}
