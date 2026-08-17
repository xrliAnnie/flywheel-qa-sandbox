import { LinearClient } from "@linear/sdk";
import type {
	AlertAttemptOptions,
	AlertPayload,
	AlertResult,
} from "../LeadAlertNotifier.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import { DISCORD_API, postDiscordMessageToChannel } from "./discord-utils.js";
import type {
	FlagRetirementScanEffects,
	FlagScanEffectResult,
	FlagScanReconcileResult,
} from "./flag-retirement-scan.js";

const GOVERNANCE_LABEL = "flag-governance";
const RECONCILE_MARKER_PREFIX = "flywheel:flag-governance run=";

export function resolveFlagScanOwner(projects: ProjectEntry[]): {
	project: ProjectEntry;
	leadId: string;
} {
	const project = projects.find(
		(candidate) => candidate.projectName.toLowerCase() === "flywheel",
	);
	if (!project) throw new Error("Flywheel project is not configured");
	const matches = project.leads.filter(
		(lead) => lead.department?.toLowerCase() === "engineering",
	);
	if (matches.length !== 1) {
		throw new Error(
			`weekly flag scan requires exactly one Flywheel engineering Lead; found ${matches.length}`,
		);
	}
	return { project, leadId: matches[0]!.agentId };
}

async function ensureGovernanceLabel(
	client: LinearClient,
	teamId: string,
): Promise<string> {
	const existing = await client.issueLabels({
		first: 2,
		filter: {
			name: { eqIgnoreCase: GOVERNANCE_LABEL },
			team: { id: { eq: teamId } },
		},
	});
	if (existing.nodes.length > 1) {
		throw new Error("Linear flag-governance label is ambiguous");
	}
	if (existing.nodes[0]) return existing.nodes[0].id;
	const created = await client.createIssueLabel({
		teamId,
		name: GOVERNANCE_LABEL,
		color: "#5E5CE6",
		description: "Founder flag decision ledger; never dispatch a Runner",
	});
	if (!created.success || !created.issueLabelId) {
		throw new Error("Linear flag-governance label creation failed");
	}
	return created.issueLabelId;
}

export async function findLinearBatch(input: {
	client: LinearClient;
	teamId: string;
	runToken: string;
	createdAfter: number;
}): Promise<FlagScanReconcileResult> {
	const marker = `<!-- ${RECONCILE_MARKER_PREFIX}${input.runToken} -->`;
	let page = await input.client.issues({
		first: 100,
		filter: {
			team: { id: { eq: input.teamId } },
			createdAt: { gte: new Date(input.createdAfter).toISOString() },
		},
	});
	for (;;) {
		const found = page.nodes.find((issue) =>
			issue.description?.includes(marker),
		);
		if (found) return { status: "found", evidence: found.url };
		if (!page.pageInfo.hasNextPage) return { status: "missing" };
		page = await page.fetchNext();
	}
}

async function findDiscordBatch(input: {
	channelId: string;
	botToken: string;
	runToken: string;
	createdAfter: number;
}): Promise<FlagScanReconcileResult> {
	const marker = `\`${RECONCILE_MARKER_PREFIX}${input.runToken}\``;
	let before: string | undefined;
	for (;;) {
		const params = new URLSearchParams({ limit: "100" });
		if (before) params.set("before", before);
		const response = await fetch(
			`${DISCORD_API}/channels/${input.channelId}/messages?${params}`,
			{ headers: { Authorization: `Bot ${input.botToken}` } },
		);
		if (!response.ok) {
			throw new Error(`Discord reconcile failed with ${response.status}`);
		}
		const messages = (await response.json()) as Array<{
			id: string;
			content?: string;
			timestamp?: string;
		}>;
		const found = messages.find((message) => message.content?.includes(marker));
		if (found) return { status: "found", evidence: found.id };
		if (messages.length < 100) return { status: "missing" };
		const oldest = messages.at(-1);
		if (
			oldest?.timestamp &&
			Date.parse(oldest.timestamp) < input.createdAfter
		) {
			return { status: "missing" };
		}
		if (!oldest?.id) throw new Error("Discord reconcile page lacked an id");
		before = oldest.id;
	}
}

export interface ProductionFlagScanEffectsOptions {
	linearApiKey?: string;
	projects: ProjectEntry[];
	reportBaseUrl: string;
	reportToken?: string;
	discordBotToken?: string;
	store: StateStore;
	alert(
		input: AlertPayload,
		attempt?: AlertAttemptOptions,
	): Promise<AlertResult>;
}

export function createProductionFlagScanEffects(
	opts: ProductionFlagScanEffectsOptions,
): FlagRetirementScanEffects {
	const owner = () => resolveFlagScanOwner(opts.projects);
	const linearContext = async () => {
		if (!opts.linearApiKey) throw new Error("LINEAR_API_KEY is not configured");
		const client = new LinearClient({ apiKey: opts.linearApiKey });
		const teams = await client.teams({ filter: { key: { eq: "FLY" } } });
		if (teams.nodes.length !== 1) throw new Error("FLY Linear team is missing");
		return { client, team: teams.nodes[0]! };
	};
	const discordContext = () => {
		const { project } = owner();
		if (!project.generalChannel) {
			throw new Error("Flywheel generalChannel is not configured");
		}
		if (!opts.discordBotToken) {
			throw new Error("Discord bot token is not configured");
		}
		return {
			channelId: project.generalChannel,
			botToken: opts.discordBotToken,
		};
	};

	return {
		async createLinearBatch(input): Promise<FlagScanEffectResult> {
			const { client, team } = await linearContext();
			const projects = await client.projects({
				filter: { name: { eq: "Flywheel" } },
			});
			if (projects.nodes.length !== 1) {
				throw new Error("Flywheel Linear project is missing or ambiguous");
			}
			const labelId = await ensureGovernanceLabel(client, team.id);
			const payload = await client.createIssue({
				teamId: team.id,
				projectId: projects.nodes[0]!.id,
				labelIds: [labelId],
				title: input.title,
				description: input.body,
			});
			const issue = await payload.issue;
			return issue?.url
				? { status: "done", evidence: issue.url }
				: { status: "ambiguous" };
		},

		async reconcileLinearBatch(input): Promise<FlagScanReconcileResult> {
			const { client, team } = await linearContext();
			return findLinearBatch({ ...input, client, teamId: team.id });
		},

		async publishReport(input): Promise<FlagScanEffectResult> {
			if (!opts.reportToken) {
				return { status: "degraded", evidence: "report token unavailable" };
			}
			const { project } = owner();
			try {
				const response = await fetch(
					`${opts.reportBaseUrl}/api/reports/publish`,
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${opts.reportToken}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							projectName: project.projectName,
							title: input.title,
							html: input.html,
						}),
					},
				);
				if (!response.ok) {
					return {
						status: "degraded",
						evidence: `report HTTP ${response.status}`,
					};
				}
				const data = (await response.json()) as { url?: string };
				return data.url
					? { status: "done", evidence: data.url }
					: { status: "degraded", evidence: "report response lacked URL" };
			} catch (error) {
				return {
					status: "degraded",
					evidence: error instanceof Error ? error.message : String(error),
				};
			}
		},

		async postDiscord(input): Promise<FlagScanEffectResult> {
			const discord = discordContext();
			const result = await postDiscordMessageToChannel(
				discord.channelId,
				input.body,
				discord.botToken,
				{ origin: "automation" },
			);
			return result.ok
				? { status: "done", evidence: JSON.stringify(result.messageIds) }
				: { status: "ambiguous" };
		},

		async reconcileDiscord(input): Promise<FlagScanReconcileResult> {
			return findDiscordBatch({ ...input, ...discordContext() });
		},

		async notifyLead(input): Promise<FlagScanEffectResult> {
			if (opts.store.getAlertDeliveryReceipt(input.eventId)) {
				return { status: "done", evidence: input.eventId };
			}
			const { project, leadId } = owner();
			await opts.alert(
				{
					leadId,
					projectName: project.projectName,
					eventId: input.eventId,
					eventType: "flag_scan_no_clock",
					title: `Weekly flag scan clock debt (${input.partIndex}/${input.partCount})`,
					body: input.body,
					severity: "warning",
				},
				{ replayAfterAmbiguousAttempt: true },
			);
			return opts.store.getAlertDeliveryReceipt(input.eventId)
				? { status: "done", evidence: input.eventId }
				: { status: "ambiguous" };
		},
	};
}
