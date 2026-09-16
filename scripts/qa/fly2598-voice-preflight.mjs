#!/usr/bin/env node
// Read-only Discord GET and authenticated runtime probe; never creates a session.
import { execFileSync } from "node:child_process";
import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import {
	preflightVoiceSession,
	VoicePreflightError,
} from "../../packages/teamlead/dist/bridge/voice-session-preflight.js";
import { resolveLeadVoiceBinding } from "../../packages/teamlead/dist/bridge/voice-session-start.js";
import { parseAndValidateProjects } from "../../packages/teamlead/dist/ProjectConfig.js";
import { loadVoiceHostConfig } from "../../packages/teamlead/dist/voice-host-config.js";

export async function runPreflight(input, deps = {}) {
	const result = {
		schemaVersion: 1,
		checkedAt: new Date().toISOString(),
		codeSha: input.codeSha,
		projectName: input.projectName,
		leadId: input.leadId,
		botUserId: null,
		guildId: null,
		voiceChannelId: null,
		ok: false,
		reason: null,
		checks: null,
	};
	const matches = input.projects.filter(
		(p) => p.projectName === input.projectName,
	);
	if (matches.length !== 1) return { ...result, reason: "project_not_unique" };
	const project = matches[0],
		leads = project.leads.filter((l) => l.agentId === input.leadId);
	if (leads.length !== 1) return { ...result, reason: "lead_not_unique" };
	const lead = leads[0];
	Object.assign(result, {
		botUserId: lead.botUserId ?? null,
		guildId: project.voiceRoom?.guildId ?? null,
		voiceChannelId: project.voiceRoom?.voiceChannelId ?? null,
	});
	if (lead.voiceModes?.meeting !== true)
		return { ...result, reason: "voice_mode_not_enabled" };
	try {
		const binding = resolveLeadVoiceBinding(project, lead, input.env);
		result.checks = await preflightVoiceSession(
			{ project, lead, ...binding },
			deps,
		);
		result.ok = true;
	} catch (error) {
		if (error instanceof VoicePreflightError) {
			result.reason = error.reason;
			result.checks = error.evidence;
		} else
			result.reason = [
				"bot_env_unset",
				"legacy_voice_conflict",
				"voice_room_missing",
			].includes(error?.reason)
				? error.reason
				: "local_preflight_failed";
	}
	return result;
}
function readOwned(path, privateFile = false) {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const s = fstatSync(fd);
		if (
			!s.isFile() ||
			s.uid !== process.getuid() ||
			s.size > 16 * 1024 * 1024 ||
			(privateFile && (s.mode & 0o777) !== 0o600)
		)
			throw Error("unsafe_local_file");
		return readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
}
export async function main(argv) {
	const args = {};
	for (let n = 0; n < argv.length; n += 2) {
		const k = argv[n],
			v = argv[n + 1];
		if (
			!["--project", "--lead", "--out"].includes(k) ||
			args[k] ||
			!v ||
			v.startsWith("--")
		)
			throw Error("usage");
		args[k] = v;
	}
	if (Object.keys(args).length !== 3) throw Error("usage");
	const state = join(homedir(), ".flywheel");
	const projects = parseAndValidateProjects(
		JSON.parse(readOwned(join(state, "projects.json"))),
	);
	const host = join(state, "voice-host.json");
	readOwned(host, true);
	loadVoiceHostConfig({ path: host, projects });
	// Parse assignments, never execute host env as shell code or echo credentials.
	const env = parseEnv(readOwned(join(state, ".env"), true));
	const repo = resolve(import.meta.dirname, "../..");
	const codeSha = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: repo,
		encoding: "utf8",
	}).trim();
	const report = await runPreflight({
		projects,
		projectName: args["--project"],
		leadId: args["--lead"],
		env,
		codeSha,
	});
	// Exclusive creation refuses existing files and symlinks, including config paths.
	writeFileSync(
		resolve(args["--out"]),
		`${JSON.stringify(report, null, 2)}\n`,
		{ mode: 0o600, flag: "wx" },
	);
	console.log(JSON.stringify(report));
	return report.ok ? 0 : 1;
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
	main(process.argv.slice(2))
		.then((code) => {
			process.exitCode = code;
		})
		.catch(() => {
			console.error("voice_preflight_local_failed");
			process.exitCode = 1;
		});
