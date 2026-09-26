#!/usr/bin/env node
// FLY-2860: retire what the deleted legacy voice commands left behind outside
// the repo. Guild slash commands (/glaw, /gemini, /gemini-advanced, /eleven)
// stay registered in Discord after their daemon is gone, and a host may still
// carry the com.flywheel.voice-bridge launchd unit.
//
// usage: node scripts/retire-legacy-voice.mjs [--apply] [--json <receipt>]
//
// Default is a read-only dry run. Targets come from the version-controlled
// retire-legacy-voice.targets.json (historical registrants; `required`
// targets must be fully queried or the run fails) plus optional candidates
// from ~/.flywheel/projects.json. Tokens are read from the environment, or
// from a private (mode 600) ~/.flywheel/.env by exact key; they only ever go
// into the Authorization header and never into output or the receipt.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://discord.com/api/v10";
export const LEGACY_COMMAND_NAMES = Object.freeze([
	"glaw",
	"gemini",
	"gemini-advanced",
	"eleven",
]);
const CHAT_INPUT = 1;
const SNOWFLAKE = /^\d{17,20}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
// Discord chat-input command name grammar (the subset the legacy daemons used).
const COMMAND_NAME = /^[a-z0-9_-]{1,32}$/;
const LABEL = "com.flywheel.voice-bridge";
const RETIRED_SUFFIX = ".retired-FLY-2860";
const OPTIONAL_TOKEN_ENVS = ["HUDDLE_ORCH_BOT_TOKEN", "HUDDLE_EARS_BOT_TOKEN"];

class ConfigError extends Error {}

function parseArgs(argv) {
	const args = { apply: false, json: null };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--apply") args.apply = true;
		else if (argv[i] === "--json" && argv[i + 1]) args.json = argv[++i];
		else throw new ConfigError(`unknown argument: ${argv[i]}`);
	}
	return args;
}

function loadTargets(targetsPath) {
	const parsed = JSON.parse(fs.readFileSync(targetsPath, "utf8"));
	if (!Array.isArray(parsed) || parsed.length === 0) {
		throw new ConfigError(
			"targets_empty: the target set must name at least one historical registrant",
		);
	}
	return parsed.map((t, i) => {
		if (
			!t ||
			typeof t.envName !== "string" ||
			!ENV_NAME.test(t.envName) ||
			!Array.isArray(t.guildIds) ||
			typeof t.required !== "boolean" ||
			typeof t.note !== "string" ||
			(t.appId !== undefined &&
				(typeof t.appId !== "string" || !SNOWFLAKE.test(t.appId))) ||
			(t.extraCommandNames !== undefined &&
				(!Array.isArray(t.extraCommandNames) ||
					!t.extraCommandNames.every(
						(n) => typeof n === "string" && COMMAND_NAME.test(n),
					)))
		) {
			throw new ConfigError(`targets_invalid: entry ${i}`);
		}
		return {
			envName: t.envName,
			appId: t.appId,
			guildIds: t.guildIds.map(String),
			required: t.required,
			// Per-target names on top of the four legacy commands, e.g. /meet for
			// bots that ran the staged huddle rig (its commandName was "meet").
			commandNames: commandNameSet(t.extraCommandNames ?? []),
		};
	});
}

function commandNameSet(extra) {
	return [...new Set([...LEGACY_COMMAND_NAMES, ...extra])].sort();
}

function privateEnvReader(homeDir) {
	const file = path.join(homeDir, ".flywheel", ".env");
	let state = "not_consulted";
	let source = null;
	const load = () => {
		if (state !== "not_consulted") return;
		let info;
		try {
			info = fs.lstatSync(file);
		} catch {
			state = "absent";
			return;
		}
		const uid = process.getuid?.();
		if (
			!info.isFile() ||
			(info.mode & 0o777) !== 0o600 ||
			(uid !== undefined && info.uid !== uid)
		) {
			state = "rejected_not_private";
			return;
		}
		source = fs.readFileSync(file, "utf8");
		state = "private";
	};
	return {
		get(name) {
			load();
			if (source === null) return undefined;
			const matches = [
				...source.matchAll(
					new RegExp(`^(?:export[ \\t]+)?${name}[ \\t]*=[ \\t]*(.*)$`, "gm"),
				),
			];
			if (matches.length !== 1) return undefined;
			let raw = matches[0][1].trim();
			if (
				(raw.startsWith("'") && raw.endsWith("'")) ||
				(raw.startsWith('"') && raw.endsWith('"'))
			) {
				raw = raw.slice(1, -1);
			} else if (/[\s#'"`$\\]/.test(raw)) {
				return undefined;
			}
			return raw || undefined;
		},
		get state() {
			return state;
		},
	};
}

function optionalCandidates(homeDir, invalidGuildIds) {
	let projects = [];
	try {
		const parsed = JSON.parse(
			fs.readFileSync(path.join(homeDir, ".flywheel", "projects.json"), "utf8"),
		);
		projects = Array.isArray(parsed) ? parsed : [];
	} catch {
		projects = [];
	}
	const guilds = [];
	for (const p of projects) {
		const g = p?.voiceRoom?.guildId;
		if (g === undefined || g === null) continue;
		if (typeof g === "string" && SNOWFLAKE.test(g)) {
			if (!guilds.includes(g)) guilds.push(g);
		} else if (!invalidGuildIds.includes(String(g))) {
			invalidGuildIds.push(String(g));
		}
	}
	const envNames = [];
	for (const p of projects) {
		for (const lead of Array.isArray(p?.leads) ? p.leads : []) {
			const n = lead?.botTokenEnv;
			if (typeof n === "string" && ENV_NAME.test(n) && !envNames.includes(n))
				envNames.push(n);
		}
	}
	for (const n of OPTIONAL_TOKEN_ENVS)
		if (!envNames.includes(n)) envNames.push(n);
	return envNames.map((envName) => ({
		envName,
		guildIds: guilds,
		required: false,
		optional: true,
		commandNames: commandNameSet([]),
	}));
}

async function discordJson(fetchImpl, token, method, route) {
	const res = await fetchImpl(`${API}${route}`, {
		method,
		headers: { Authorization: `Bot ${token}` },
	});
	let body = null;
	if (res.status !== 204) {
		try {
			body = await res.json();
		} catch {
			body = null;
		}
	}
	return { status: res.status, body };
}

function classify(status, body) {
	const code = typeof body?.code === "number" ? body.code : undefined;
	const base = {
		httpStatus: status,
		...(code !== undefined ? { discordCode: code } : {}),
	};
	if (status === 403) return { status: "access_denied", ...base };
	if (status === 404) return { status: "not_found", ...base };
	return { status: "error", ...base };
}

// Only the five fields the deletion predicate needs are read from Discord.
function judge(command, appId, guildId, names) {
	const name = command?.name;
	if (typeof name !== "string") return { verdict: "malformed" };
	if (!names.includes(name)) return { verdict: "ignore" };
	const id = command.id;
	const valid =
		typeof id === "string" &&
		SNOWFLAKE.test(id) &&
		command.application_id === appId &&
		command.guild_id === guildId &&
		Number.isInteger(command.type);
	if (!valid) return { verdict: "malformed", name };
	if (command.type !== CHAT_INPUT) return { verdict: "ignore" };
	return {
		verdict: "delete",
		entry: {
			appId,
			guildId,
			commandId: id,
			name,
			type: command.type,
			scope: "guild",
		},
	};
}

function launchdState(launchctl, uid, homeDir) {
	const r = launchctl(["print", `gui/${uid}/${LABEL}`]);
	const plistPath = path.join(
		homeDir,
		"Library",
		"LaunchAgents",
		`${LABEL}.plist`,
	);
	const notFound =
		r.status === 113 ||
		/Could not find service/i.test(`${r.stdout}${r.stderr}`);
	return {
		loaded: r.status === 0 ? true : notFound ? false : null,
		plist: fs.existsSync(plistPath),
		plistPath,
	};
}

export async function retireLegacyVoice({
	argv = [],
	env = process.env,
	homeDir = os.homedir(),
	targetsPath = fileURLToPath(
		new URL("./retire-legacy-voice.targets.json", import.meta.url),
	),
	fetchImpl = globalThis.fetch,
	launchctl = (args) => spawnSync("launchctl", args, { encoding: "utf8" }),
	uid = process.getuid?.() ?? 0,
	sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
	now = () => new Date(),
	write = (s) => process.stdout.write(s),
} = {}) {
	let args;
	let fileTargets;
	try {
		args = parseArgs(argv);
		fileTargets = loadTargets(targetsPath);
	} catch (error) {
		write(`retire-legacy-voice: ${error.message}\n`);
		return { code: 2, receipt: null };
	}
	const invalidGuildIds = [];
	const envFile = privateEnvReader(homeDir);
	const receipt = {
		runAt: now().toISOString(),
		apply: args.apply,
		targets: [],
		found: [],
		deleted: [],
		remaining: [],
		uncovered: [],
		malformed: [],
		invalidGuildIds,
		envFile: "not_consulted",
		launchd: null,
	};
	let failed = false;

	// Resolve tokens; dedupe by token so one bot is queried once.
	const byToken = new Map();
	for (const t of [
		...fileTargets,
		...optionalCandidates(homeDir, invalidGuildIds),
	]) {
		const token = env[t.envName] || envFile.get(t.envName);
		if (!token) {
			if (t.optional) continue; // absent optional candidates are not targets
			receipt.targets.push({
				envName: t.envName,
				appId: t.appId ?? null,
				required: t.required,
				commandNames: t.commandNames,
				guilds: t.guildIds.map((guildId) => ({
					guildId,
					required: t.required,
					commandNames: t.commandNames,
					status: "missing_credential",
				})),
				global: { status: "missing_credential" },
			});
			continue;
		}
		// One bot is queried once, but each name set stays bound to the guilds its
		// own target listed: a staged-rig target's /meet must never spread to a
		// guild the same token reaches only as a Lead candidate.
		const group = byToken.get(token);
		if (group) {
			group.required ||= t.required;
			for (const g of t.guildIds) {
				group.guildRequired.set(
					g,
					(group.guildRequired.get(g) ?? false) || t.required,
				);
			}
			for (const g of t.guildIds) {
				if (!group.guildIds.includes(g)) group.guildIds.push(g);
				group.guildNames.set(
					g,
					commandNameSet([
						...(group.guildNames.get(g) ?? []),
						...t.commandNames,
					]),
				);
			}
			if (t.appId && group.appId && t.appId !== group.appId)
				group.appIdConflict = true;
			group.appId ??= t.appId;
			group.commandNames = commandNameSet([
				...group.commandNames,
				...t.commandNames,
			]);
			continue;
		}
		byToken.set(token, {
			...t,
			guildIds: [...t.guildIds],
			guildNames: new Map(t.guildIds.map((g) => [g, t.commandNames])),
			// Coverage is owed per guild: only guilds a required target listed
			// must be queried_ok, even when the same token reaches more guilds.
			guildRequired: new Map(t.guildIds.map((g) => [g, t.required])),
		});
	}

	const listLegacy = async (token, appId, guildId, names) => {
		const r = await discordJson(
			fetchImpl,
			token,
			"GET",
			`/applications/${appId}/guilds/${guildId}/commands`,
		);
		if (r.status !== 200 || !Array.isArray(r.body))
			return { failure: classify(r.status, r.body) };
		const deletable = [];
		const malformed = [];
		for (const command of r.body) {
			const j = judge(command, appId, guildId, names);
			if (j.verdict === "delete") deletable.push(j.entry);
			else if (j.verdict === "malformed")
				malformed.push({ appId, guildId, name: j.name ?? null });
		}
		return { deletable, malformed };
	};

	for (const [token, t] of byToken) {
		const row = {
			envName: t.envName,
			appId: t.appId ?? null,
			required: t.required,
			commandNames: t.commandNames,
			guilds: [],
			global: { status: "not_queried" },
		};
		receipt.targets.push(row);
		const me = await discordJson(
			fetchImpl,
			token,
			"GET",
			"/oauth2/applications/@me",
		);
		const appId =
			typeof me.body?.id === "string" && SNOWFLAKE.test(me.body.id)
				? me.body.id
				: null;
		let identityError = null;
		if (me.status !== 200 || !appId)
			identityError = `identity_http_${me.status}`;
		else if (t.appIdConflict || (t.appId && t.appId !== appId))
			identityError = "app_id_mismatch";
		if (identityError) {
			if (identityError === "app_id_mismatch") failed = true;
			row.guilds = t.guildIds.map((guildId) => ({
				guildId,
				required: t.guildRequired.get(guildId),
				commandNames: t.guildNames.get(guildId),
				status: "error",
				detail: identityError,
			}));
			continue;
		}
		row.appId = appId;
		const global = await discordJson(
			fetchImpl,
			token,
			"GET",
			`/applications/${appId}/commands`,
		);
		if (global.status === 200 && Array.isArray(global.body)) {
			const hits = global.body
				.filter(
					(c) => c?.type === CHAT_INPUT && t.commandNames.includes(c?.name),
				)
				.map((c) => ({ commandId: String(c.id), name: c.name }));
			row.global = hits.length
				? { status: "global_found", commands: hits }
				: { status: "queried_ok" };
		} else {
			row.global = classify(global.status, global.body);
		}
		for (const guildId of t.guildIds) {
			const names = t.guildNames.get(guildId);
			const required = t.guildRequired.get(guildId);
			if (!SNOWFLAKE.test(guildId)) {
				row.guilds.push({
					guildId,
					required,
					commandNames: names,
					status: "skipped_invalid_id",
				});
				if (!invalidGuildIds.includes(guildId)) invalidGuildIds.push(guildId);
				continue;
			}
			const listed = await listLegacy(token, appId, guildId, names);
			if (listed.failure) {
				row.guilds.push({
					guildId,
					required,
					commandNames: names,
					...listed.failure,
				});
				continue;
			}
			row.guilds.push({
				guildId,
				required,
				commandNames: names,
				status: "queried_ok",
			});
			receipt.found.push(...listed.deletable);
			receipt.malformed.push(...listed.malformed);
			// A legacy-named command that cannot be judged is never deleted and is
			// never proof of cleanup: it stays in `remaining` and fails the run.
			const unresolved = (list) =>
				list.map((m) => ({ ...m, commandId: null, malformed: true }));
			if (!args.apply) {
				receipt.remaining.push(
					...listed.deletable,
					...unresolved(listed.malformed),
				);
				continue;
			}
			for (const entry of listed.deletable) {
				const route = `/applications/${appId}/guilds/${guildId}/commands/${entry.commandId}`;
				let del = await discordJson(fetchImpl, token, "DELETE", route);
				if (del.status === 429) {
					const wait = Number(del.body?.retry_after);
					await sleep(
						Number.isFinite(wait) && wait > 0 ? Math.ceil(wait * 1000) : 1000,
					);
					del = await discordJson(fetchImpl, token, "DELETE", route);
				}
				if (del.status < 200 || del.status >= 300) {
					failed = true;
					write(
						`retire-legacy-voice: delete ${entry.name} (${entry.commandId}) failed with HTTP ${del.status}\n`,
					);
					break;
				}
				receipt.deleted.push(entry);
			}
			const after = await listLegacy(token, appId, guildId, names);
			if (after.failure) {
				failed = true;
				receipt.remaining.push({
					appId,
					guildId,
					commandId: null,
					name: null,
					recheck: after.failure,
				});
			} else {
				receipt.remaining.push(
					...after.deletable,
					...unresolved(after.malformed),
				);
			}
		}
	}

	receipt.envFile = envFile.state;
	for (const row of receipt.targets) {
		const owed = row.guilds.filter((g) => g.required);
		if (
			row.required &&
			!(owed.length > 0 && owed.every((g) => g.status === "queried_ok"))
		) {
			receipt.uncovered.push(row.envName);
		}
	}
	if (receipt.uncovered.length > 0) failed = true;
	if (receipt.malformed.length > 0) failed = true;
	if (args.apply && receipt.remaining.length > 0) failed = true;

	// launchd leftover of the retired daemon.
	const before = launchdState(launchctl, uid, homeDir);
	let action = "none";
	if (args.apply) {
		const steps = [];
		if (before.loaded === true) {
			launchctl(["bootout", `gui/${uid}/${LABEL}`]);
			let gone = false;
			for (let i = 0; i < 10 && !gone; i++) {
				gone = launchdState(launchctl, uid, homeDir).loaded === false;
				if (!gone) await sleep(500);
			}
			if (!gone) failed = true;
			steps.push("bootout");
		}
		if (before.plist) {
			const retired = `${before.plistPath}${RETIRED_SUFFIX}`;
			if (fs.existsSync(retired)) {
				failed = true;
				write(
					`retire-legacy-voice: ${path.basename(retired)} already exists; leaving ${path.basename(before.plistPath)} in place\n`,
				);
			} else {
				fs.renameSync(before.plistPath, retired);
				steps.push("renamed");
			}
		}
		if (steps.length) action = steps.join("+");
	}
	if (before.loaded === null) failed = true;
	const after = args.apply ? launchdState(launchctl, uid, homeDir) : before;
	receipt.launchd = { loaded: after.loaded, plist: after.plist, action };

	const text = `${JSON.stringify(receipt, null, 2)}\n`;
	if (args.json) {
		fs.writeFileSync(args.json, text, { mode: 0o600 });
		fs.chmodSync(args.json, 0o600);
	}
	write(text);
	for (const row of receipt.targets) {
		if (row.global?.status === "global_found") {
			write(
				`retire-legacy-voice: ${row.envName} still has global legacy commands; left for a human to judge\n`,
			);
		}
	}
	return { code: failed ? 1 : 0, receipt };
}

if (
	process.argv[1] &&
	fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])
) {
	retireLegacyVoice({ argv: process.argv.slice(2) }).then(
		({ code }) => process.exit(code),
		(error) => {
			process.stderr.write(`retire-legacy-voice: ${error?.message ?? error}\n`);
			process.exit(1);
		},
	);
}
