import { createHash } from "node:crypto";
import type { ProjectEntry } from "../ProjectConfig.js";
import { DISCORD_PERMISSIONS } from "./channel-permissions.js";

const SNOWFLAKE = /^\d{17,20}$/;
const DEFAULT_PRIMARY_PROJECT = "flywheel";
const DEFAULT_PRIMARY_LEAD = "flywheel-eng-lead";

export interface ShuttleAlertRoute {
	routeKey: "primary" | "project_copy";
	deliveryProject: string;
	leadId: string;
	channelId: string;
	tokenEnv?: string;
	botUserId?: string;
}

export interface ShuttleAlertRoutes {
	schemaVersion: 1;
	originProject: string;
	primary: ShuttleAlertRoute;
	copy?: ShuttleAlertRoute;
	bindingDigest: string;
}

function routeFor(
	project: ProjectEntry,
	leadId: string,
	routeKey: ShuttleAlertRoute["routeKey"],
): ShuttleAlertRoute {
	const matches = project.leads.filter((lead) => lead.agentId === leadId);
	if (matches.length !== 1) {
		throw new Error(
			`${routeKey === "primary" ? "primary" : "explicit copy"} shuttle lead must resolve exactly once: ${project.projectName}/${leadId}`,
		);
	}
	const lead = matches[0]!;
	if (!SNOWFLAKE.test(lead.chatChannel)) {
		throw new Error(
			`shuttle ${routeKey} channel is not a Discord snowflake: ${project.projectName}/${leadId}`,
		);
	}
	return {
		routeKey,
		deliveryProject: project.projectName,
		leadId,
		channelId: lead.chatChannel,
		...(lead.alertBotTokenEnv || lead.botTokenEnv
			? { tokenEnv: lead.alertBotTokenEnv ?? lead.botTokenEnv }
			: {}),
		...(lead.botUserId ? { botUserId: lead.botUserId } : {}),
	};
}

/** Resolve the infrastructure primary and an explicitly opted-in project copy. */
export function resolveShuttleAlertRoutes(
	projects: ProjectEntry[],
	originProject: string,
): ShuttleAlertRoutes {
	const configuredPrimaries = projects.filter(
		(project) => project.shuttlePrimaryEngineeringLeadId !== undefined,
	);
	if (configuredPrimaries.length > 1) {
		throw new Error("shuttle routing requires exactly one primary identity");
	}
	const primaryProject =
		configuredPrimaries[0] ??
		projects.find((project) => project.projectName === DEFAULT_PRIMARY_PROJECT);
	if (!primaryProject) {
		throw new Error("shuttle routing requires exactly one primary identity");
	}
	const primaryLead =
		primaryProject.shuttlePrimaryEngineeringLeadId ?? DEFAULT_PRIMARY_LEAD;
	const primary = routeFor(primaryProject, primaryLead, "primary");

	const origin = projects.find(
		(project) => project.projectName === originProject,
	);
	if (!origin)
		throw new Error(`unknown shuttle origin project: ${originProject}`);
	let copy: ShuttleAlertRoute | undefined;
	if (origin.shuttleEngineeringLeadId !== undefined) {
		const candidate = routeFor(
			origin,
			origin.shuttleEngineeringLeadId,
			"project_copy",
		);
		if (candidate.channelId !== primary.channelId) copy = candidate;
	}

	const stable: Omit<ShuttleAlertRoutes, "bindingDigest"> = {
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

/** Fail closed before sending when the selected bot cannot see or post. */
export function assertShuttleSendPermissions(permissions: bigint): void {
	const missing: string[] = [];
	if ((permissions & DISCORD_PERMISSIONS.VIEW_CHANNEL) === 0n)
		missing.push("VIEW_CHANNEL");
	if ((permissions & DISCORD_PERMISSIONS.SEND_MESSAGES) === 0n)
		missing.push("SEND_MESSAGES");
	if (missing.length > 0) {
		throw new Error(`shuttle sender lacks ${missing.join("+")}`);
	}
}
