#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SNOWFLAKE = /^\d{17,20}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;

function parseArgs(argv) {
	const result = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (
			arg === "--check" ||
			arg === "--resolve" ||
			arg === "--permission-preflight"
		) {
			result[arg.slice(2)] = true;
			continue;
		}
		if (!arg.startsWith("--") || index + 1 >= argv.length)
			throw new Error(`invalid argument: ${arg}`);
		result[arg.slice(2)] = argv[++index];
	}
	return result;
}

function readProjects(path) {
	const info = lstatSync(path);
	if (!info.isFile() || info.isSymbolicLink())
		throw new Error("unsafe projects file");
	const raw = readFileSync(path, "utf8");
	if (Buffer.byteLength(raw) > 1024 * 1024)
		throw new Error("projects file too large");
	const projects = JSON.parse(raw);
	if (!Array.isArray(projects) || projects.length === 0)
		throw new Error("projects file must be a non-empty array");
	return projects;
}

function routeFor(project, leadId, routeKey) {
	const leads = Array.isArray(project.leads)
		? project.leads.filter((lead) => lead?.agentId === leadId)
		: [];
	if (leads.length !== 1)
		throw new Error(
			`${routeKey === "primary" ? "primary" : "explicit copy"} shuttle lead must resolve exactly once: ${project.projectName}/${leadId}`,
		);
	const lead = leads[0];
	if (!SNOWFLAKE.test(lead.chatChannel ?? ""))
		throw new Error(
			`shuttle ${routeKey} channel is not a Discord snowflake: ${project.projectName}/${leadId}`,
		);
	const tokenEnv = lead.alertBotTokenEnv || lead.botTokenEnv;
	if (tokenEnv !== undefined && !ENV_NAME.test(tokenEnv))
		throw new Error(
			`invalid shuttle sender token selector: ${project.projectName}/${leadId}`,
		);
	if (lead.botUserId !== undefined && !SNOWFLAKE.test(lead.botUserId))
		throw new Error(
			`invalid shuttle sender bot user: ${project.projectName}/${leadId}`,
		);
	return {
		routeKey,
		deliveryProject: project.projectName,
		leadId,
		channelId: lead.chatChannel,
		...(tokenEnv ? { tokenEnv } : {}),
		...(lead.botUserId ? { botUserId: lead.botUserId } : {}),
	};
}

function resolvePrimary(projects) {
	const configured = projects.filter(
		(project) => project?.shuttlePrimaryEngineeringLeadId !== undefined,
	);
	if (configured.length > 1)
		throw new Error("shuttle routing requires exactly one primary identity");
	const primaryProject =
		configured[0] ??
		projects.find((project) => project?.projectName === "flywheel");
	if (!primaryProject)
		throw new Error("shuttle routing requires exactly one primary identity");
	return routeFor(
		primaryProject,
		primaryProject.shuttlePrimaryEngineeringLeadId ?? "flywheel-eng-lead",
		"primary",
	);
}

function resolveCopy(projects, originProject) {
	const origin = projects.find(
		(project) => project?.projectName === originProject,
	);
	if (!origin)
		throw new Error(`unknown shuttle origin project: ${originProject}`);
	if (origin.shuttleEngineeringLeadId === undefined) return undefined;
	return routeFor(origin, origin.shuttleEngineeringLeadId, "project_copy");
}

export function resolveShuttleAlertRoutes(projects, originProject) {
	const primary = resolvePrimary(projects);
	const candidate = resolveCopy(projects, originProject);
	const copy =
		candidate?.channelId !== primary.channelId ? candidate : undefined;
	const stable = {
		schemaVersion: 1,
		originProject,
		primary,
		...(copy ? { copy } : {}),
	};
	return {
		...stable,
		bindingDigest: createHash("sha256")
			.update(JSON.stringify(stable))
			.digest("hex"),
	};
}

function bitfield(value) {
	if (!/^[0-9]+$/.test(value ?? ""))
		throw new Error("invalid Discord permission bitfield");
	return BigInt(value);
}

function computePermissions({
	guildId,
	memberId,
	memberRoleIds,
	roles,
	overwrites,
}) {
	const everyone = roles.find((role) => role.id === guildId);
	if (!everyone) throw new Error("Discord @everyone role is missing");
	let permissions = bitfield(everyone.permissions);
	for (const role of roles)
		if (memberRoleIds.includes(role.id))
			permissions |= bitfield(role.permissions);
	if ((permissions & (1n << 3n)) !== 0n) return (1n << 63n) - 1n;
	const apply = (overwrite) => {
		if (!overwrite) return;
		permissions &= ~bitfield(overwrite.deny);
		permissions |= bitfield(overwrite.allow);
	};
	apply(
		overwrites.find(
			(overwrite) => overwrite.type === 0 && overwrite.id === guildId,
		),
	);
	let allow = 0n;
	let deny = 0n;
	for (const overwrite of overwrites) {
		if (overwrite.type === 0 && memberRoleIds.includes(overwrite.id)) {
			allow |= bitfield(overwrite.allow);
			deny |= bitfield(overwrite.deny);
		}
	}
	permissions &= ~deny;
	permissions |= allow;
	apply(
		overwrites.find(
			(overwrite) => overwrite.type === 1 && overwrite.id === memberId,
		),
	);
	return permissions;
}

async function discordJson(token, pathname) {
	const response = await fetch(`https://discord.com/api/v10${pathname}`, {
		headers: { Authorization: `Bot ${token}` },
		signal: AbortSignal.timeout(5_000),
	});
	if (!response.ok)
		throw new Error(
			`Discord permission preflight failed HTTP ${response.status}`,
		);
	return response.json();
}

async function permissionPreflight(route, senderTokenEnv) {
	const tokenEnv = senderTokenEnv || route.tokenEnv;
	if (!tokenEnv || !ENV_NAME.test(tokenEnv) || !process.env[tokenEnv])
		throw new Error("shuttle sender token is unavailable");
	const token = process.env[tokenEnv];
	const me = await discordJson(token, "/users/@me");
	const usingRouteIdentity =
		!senderTokenEnv || senderTokenEnv === route.tokenEnv;
	if (
		!SNOWFLAKE.test(me.id ?? "") ||
		(usingRouteIdentity && route.botUserId && route.botUserId !== me.id)
	)
		throw new Error("shuttle sender identity mismatch");
	const channel = await discordJson(token, `/channels/${route.channelId}`);
	if (!SNOWFLAKE.test(channel.guild_id ?? ""))
		throw new Error("shuttle route is not a guild channel");
	const [member, roles] = await Promise.all([
		discordJson(token, `/guilds/${channel.guild_id}/members/${me.id}`),
		discordJson(token, `/guilds/${channel.guild_id}/roles`),
	]);
	const permissions = computePermissions({
		guildId: channel.guild_id,
		memberId: me.id,
		memberRoleIds: Array.isArray(member.roles) ? member.roles : [],
		roles,
		overwrites: Array.isArray(channel.permission_overwrites)
			? channel.permission_overwrites
			: [],
	});
	const missing = [];
	if ((permissions & VIEW_CHANNEL) === 0n) missing.push("VIEW_CHANNEL");
	if ((permissions & SEND_MESSAGES) === 0n) missing.push("SEND_MESSAGES");
	if (missing.length)
		throw new Error(`shuttle sender lacks ${missing.join("+")}`);
	return {
		checked: true,
		botUserId: me.id,
		permissions: permissions.toString(),
	};
}

function permissionFixturePreflight(route, path, senderTokenEnv) {
	const fixture = JSON.parse(readFileSync(path, "utf8"));
	const usingRouteIdentity =
		!senderTokenEnv || senderTokenEnv === route.tokenEnv;
	if (
		usingRouteIdentity &&
		route.botUserId &&
		fixture.memberId !== route.botUserId
	)
		throw new Error("shuttle sender identity mismatch");
	const permissions = computePermissions(fixture);
	const missing = [];
	if ((permissions & VIEW_CHANNEL) === 0n) missing.push("VIEW_CHANNEL");
	if ((permissions & SEND_MESSAGES) === 0n) missing.push("SEND_MESSAGES");
	if (missing.length)
		throw new Error(`shuttle sender lacks ${missing.join("+")}`);
	return {
		checked: true,
		botUserId: fixture.memberId,
		permissions: permissions.toString(),
	};
}

async function main(argv) {
	const args = parseArgs(argv);
	if (!args["projects-file"] || Boolean(args.check) === Boolean(args.resolve))
		throw new Error(
			"choose exactly one of --check or --resolve with --projects-file",
		);
	const projects = readProjects(args["projects-file"]);
	const origins = projects.map((project) => project.projectName);
	if (args.check) {
		const receipts = origins.map((origin) =>
			resolveShuttleAlertRoutes(projects, origin),
		);
		const primary = receipts[0].primary;
		if (
			receipts.some(
				(receipt) =>
					receipt.primary.channelId !== primary.channelId ||
					receipt.primary.leadId !== primary.leadId,
			)
		)
			throw new Error("primary shuttle route drifted across origins");
		return {
			schemaVersion: 1,
			ok: true,
			primary,
			copyProjects: receipts
				.filter((receipt) => receipt.copy)
				.map((receipt) => receipt.originProject)
				.sort(),
		};
	}
	if (
		!args["origin-project"] ||
		!["primary", "project_copy"].includes(args["route-key"])
	)
		throw new Error("--resolve requires --origin-project and --route-key");
	const primary = resolvePrimary(projects);
	const route =
		args["route-key"] === "primary"
			? primary
			: resolveCopy(projects, args["origin-project"]);
	if (!route) throw new Error("explicit copy route is not configured");
	if (
		route.routeKey === "project_copy" &&
		route.channelId === primary.channelId
	)
		throw new Error("explicit copy route duplicates the primary channel");
	const stable = {
		schemaVersion: 1,
		originProject: args["origin-project"],
		route,
	};
	const bindingDigest = createHash("sha256")
		.update(JSON.stringify(stable))
		.digest("hex");
	const senderTokenEnv = args["sender-token-env"];
	const preflight = args["permission-preflight"]
		? args["permission-fixture"]
			? permissionFixturePreflight(
					route,
					args["permission-fixture"],
					senderTokenEnv,
				)
			: await permissionPreflight(route, senderTokenEnv)
		: { checked: false };
	return { ...route, bindingDigest, permissionPreflight: preflight };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main(process.argv.slice(2))
		.then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
		.catch((error) => {
			process.stderr.write(
				`shuttle-route-bindings: ${error instanceof Error ? error.message : String(error)}\n`,
			);
			process.exitCode = 2;
		});
}
