import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getStateDir } from "flywheel-agent-team-transport";
import { commDbRootDir } from "../bridge/commdb-path.js";
import { isDiscordSnowflake } from "../bridge/founder-notify-utils.js";
import {
	activateFounderThreadIngressRollout,
	type FounderThreadIngressOwner,
	freezeFounderThreadIngressRollout,
	loadFounderThreadIngressRollout,
	resolveFounderThreadIngressEnvironment,
} from "../bridge/founder-thread-ingress-rollout.js";
import { loadConfig } from "../config.js";
import { loadProjects } from "../ProjectConfig.js";

export function runFounderThreadIngressRollout(argv: string[]): number {
	const { positionals, values } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			owner: { type: "string", multiple: true },
			"rollout-after": { type: "string" },
			"automatic-replay-before-boundary": { type: "string" },
		},
	});
	const command = positionals[0];
	if (!command || !["freeze", "activate", "status"].includes(command))
		throw new Error(
			"usage: founder-thread-ingress-rollout freeze|activate|status",
		);
	const config = loadConfig();
	const projects = loadProjects();
	const stateDir = getStateDir();
	const environment = resolveFounderThreadIngressEnvironment({
		stateDir,
		teamleadDbPath: config.dbPath,
		commRoot: commDbRootDir(),
	});
	const currentOwners = projects.flatMap((project) =>
		project.leads.flatMap((lead) =>
			isDiscordSnowflake(lead.chatChannel)
				? [
						{
							projectName: project.projectName,
							leadId: lead.agentId,
							chatChannelId: lead.chatChannel,
						},
					]
				: [],
		),
	);
	if (command === "status") {
		console.log(
			JSON.stringify(
				loadFounderThreadIngressRollout({
					stateDir,
					environment,
					currentOwners,
				}),
			),
		);
		return 0;
	}
	const owners = resolveOwners(values.owner ?? [], currentOwners);
	const rolloutAfter = values["rollout-after"];
	if (!rolloutAfter) throw new Error("--rollout-after is required");
	const result =
		command === "freeze"
			? freezeFounderThreadIngressRollout({
					stateDir,
					environment,
					owners,
					rolloutAfter,
				})
			: activateFounderThreadIngressRollout({
					stateDir,
					environment,
					currentOwners,
					expectedOwners: owners,
					dryRun: {
						rolloutAfter,
						automaticReplayBeforeBoundary: parseZero(
							values["automatic-replay-before-boundary"],
						),
					},
				});
	console.log(JSON.stringify(result));
	return 0;
}

function resolveOwners(
	requested: string[],
	current: FounderThreadIngressOwner[],
): FounderThreadIngressOwner[] {
	if (requested.length === 0)
		throw new Error("at least one --owner is required");
	return requested.map((value) => {
		const slash = value.indexOf("/");
		if (slash <= 0 || slash === value.length - 1)
			throw new Error(`invalid owner: ${value}`);
		const projectName = value.slice(0, slash);
		const leadId = value.slice(slash + 1);
		const owner = current.find(
			(candidate) =>
				candidate.projectName === projectName && candidate.leadId === leadId,
		);
		if (!owner) throw new Error(`owner_not_configured: ${value}`);
		return owner;
	});
}

function parseZero(value: string | undefined): number {
	if (value !== "0")
		throw new Error("--automatic-replay-before-boundary must be exactly 0");
	return 0;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		process.exitCode = runFounderThreadIngressRollout(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
