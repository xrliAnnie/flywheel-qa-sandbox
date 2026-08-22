import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LinearClient } from "@linear/sdk";
import { compileLeadIdentityRegistry } from "flywheel-comm/lead-identity";
import type {
	MailboxRecipientState,
	MailboxSettlement,
} from "flywheel-comm/mailbox-queue";
import type { AlertPayload } from "../LeadAlertNotifier.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import { markAutomatedDiscordText } from "./automated-message.js";
import { DISCORD_API, MAX_DISCORD_MESSAGE_LENGTH } from "./discord-utils.js";
import type {
	FlagRetirementScanEffects,
	FlagScanEffectResult,
	FlagScanReconcileResult,
} from "./flag-retirement-scan.js";

const GOVERNANCE_LABEL = "flag-governance";
const RECONCILE_MARKER_PREFIX = "flywheel:flag-governance run=";
const HANDOFF_MARKER_PREFIX = "flywheel:flag-governance handoff run=";
const DISCORD_PREFLIGHT_MAX_AGE_MS = 21 * 24 * 60 * 60_000;
const THREAD_ALREADY_EXISTS_CODE = 160004;
export const FLYWHEEL_CORE_CHANNEL_ID = "1516209289406971965";

interface FlagScanDiscordEvidence {
	rootMessageId?: string;
	threadId?: string;
	handoffMessageId?: string;
	inboxDeliveryId?: string;
	inboxRecipient?: string;
	preflightAt?: number;
	preflightFingerprint?: string;
	preflightSucceeded?: boolean;
}

function parseDiscordEvidence(
	raw: string | null | undefined,
): FlagScanDiscordEvidence {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as FlagScanDiscordEvidence & {
			previousEvidence?: string | null;
		};
		if (parsed.previousEvidence) {
			return { ...parseDiscordEvidence(parsed.previousEvidence), ...parsed };
		}
		return parsed;
	} catch {
		return {};
	}
}

export function mailboxSettlementAcked(settlement: MailboxSettlement): boolean {
	return (
		(settlement.kind === "live" || settlement.kind === "archived_terminal") &&
		settlement.state === "ACKED"
	);
}

export function mailboxSettlementDead(settlement: MailboxSettlement): boolean {
	return (
		(settlement.kind === "live" || settlement.kind === "archived_terminal") &&
		settlement.state === "DEAD"
	);
}

export function deliverFlagScanMailboxAlert(input: {
	primaryLeadId: string;
	fallbackLeadId: string;
	projectName: string;
	payloadFor: (leadId: string) => AlertPayload;
	enqueueLeadInbox: NonNullable<
		ProductionFlagScanEffectsOptions["enqueueLeadInbox"]
	>;
	inspectLeadInbox: NonNullable<
		ProductionFlagScanEffectsOptions["inspectLeadInbox"]
	>;
	leadRecipientState?: ProductionFlagScanEffectsOptions["leadRecipientState"];
}): {
	done: boolean;
	deliveryId: string;
	recipient: string;
} {
	const primary = input.enqueueLeadInbox(
		input.primaryLeadId,
		input.payloadFor(input.primaryLeadId),
	);
	const primarySettlement = input.inspectLeadInbox(
		input.projectName,
		primary.deliveryId,
	);
	if (mailboxSettlementAcked(primarySettlement)) {
		return {
			done: true,
			deliveryId: primary.deliveryId,
			recipient: input.primaryLeadId,
		};
	}
	const primaryState = input.leadRecipientState?.(input.primaryLeadId);
	const primaryDefinitelyUnavailable =
		mailboxSettlementDead(primarySettlement) ||
		primaryState === "terminal_or_missing";
	if (!primaryDefinitelyUnavailable) {
		return {
			done: false,
			deliveryId: primary.deliveryId,
			recipient: input.primaryLeadId,
		};
	}
	const fallback = input.enqueueLeadInbox(
		input.fallbackLeadId,
		input.payloadFor(input.fallbackLeadId),
	);
	const fallbackSettlement = input.inspectLeadInbox(
		input.projectName,
		fallback.deliveryId,
	);
	return {
		done: mailboxSettlementAcked(fallbackSettlement),
		deliveryId: fallback.deliveryId,
		recipient: input.fallbackLeadId,
	};
}

export function resolveFlagScanOwner(projects: ProjectEntry[]): {
	project: ProjectEntry;
	leadId: string;
	engineeringLead: ProjectEntry["leads"][number];
	senderLeadId: string;
	senderLead: ProjectEntry["leads"][number];
} {
	const project = findFlywheelProject(projects);
	if (!project) throw new Error("Flywheel project is not configured");
	if (project.generalChannel !== FLYWHEEL_CORE_CHANNEL_ID) {
		throw new Error(
			`Flywheel generalChannel must be ${FLYWHEEL_CORE_CHANNEL_ID}`,
		);
	}
	const matches = project.leads.filter(
		(lead) => lead.department?.toLowerCase() === "engineering",
	);
	if (matches.length !== 1) {
		throw new Error(
			`weekly flag scan requires exactly one Flywheel engineering Lead; found ${matches.length}`,
		);
	}
	const engineeringLead = matches[0]!;
	if (!engineeringLead.botUserId) {
		throw new Error("weekly flag scan Engineering Lead bot user id is missing");
	}
	const senders = project.leads.filter(
		(lead) =>
			lead.agentId === "flywheel-cos-lead" &&
			lead.chatChannel === project.generalChannel,
	);
	if (senders.length !== 1) {
		throw new Error(
			`weekly flag scan requires exactly one core-channel CoS sender; found ${senders.length}`,
		);
	}
	const senderLead = senders[0]!;
	if (!senderLead.botUserId || !senderLead.botToken) {
		throw new Error("weekly flag scan CoS sender bot id/token is missing");
	}
	return {
		project,
		leadId: engineeringLead.agentId,
		engineeringLead,
		senderLeadId: senderLead.agentId,
		senderLead,
	};
}

function findFlywheelProject(
	projects: ProjectEntry[],
): ProjectEntry | undefined {
	return projects.find(
		(candidate) => candidate.projectName.toLowerCase() === "flywheel",
	);
}

export type FlagScanOwnerStatus =
	| { kind: "not_hosted" }
	| { kind: "ready"; owner: ReturnType<typeof resolveFlagScanOwner> }
	| {
			kind: "invalid";
			project: ProjectEntry;
			leadId: string;
			message: string;
	  };

export function resolveFlagScanOwnerStatus(
	projects: ProjectEntry[],
): FlagScanOwnerStatus {
	const project = findFlywheelProject(projects);
	if (!project) return { kind: "not_hosted" };
	try {
		return { kind: "ready", owner: resolveFlagScanOwner(projects) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const alertLead =
			project.leads.find((lead) => lead.agentId === "flywheel-eng-lead") ??
			project.leads.find(
				(lead) => lead.department?.toLowerCase() === "engineering",
			) ??
			project.leads[0];
		return {
			kind: "invalid",
			project,
			leadId: alertLead?.agentId ?? "flywheel-eng-lead",
			message,
		};
	}
}

export async function reportFlagScanOwnerResolution(
	resolution: FlagScanOwnerStatus,
	alertSink: { alert(payload: AlertPayload): Promise<unknown> },
): Promise<void> {
	if (resolution.kind !== "invalid") return;
	const fingerprint = createHash("sha256")
		.update(`${resolution.project.projectName}\0${resolution.message}`)
		.digest("hex")
		.slice(0, 24);
	await alertSink.alert({
		leadId: resolution.leadId,
		projectName: resolution.project.projectName,
		eventId: `flag-scan-owner-resolution:${process.pid}:${fingerprint}`,
		eventType: "flag_scan_failed",
		title: "Weekly flag scan owner resolution failed",
		body: `Weekly flag scan is disabled until the Flywheel owner configuration is repaired: ${resolution.message}`,
		severity: "warning",
	});
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
	fetchImpl?: typeof fetch;
	markerPrefix?: string;
}): Promise<FlagScanReconcileResult> {
	const fetchImpl = input.fetchImpl ?? fetch;
	const marker = `\`${input.markerPrefix ?? RECONCILE_MARKER_PREFIX}${input.runToken}\``;
	let before: string | undefined;
	for (;;) {
		const params = new URLSearchParams({ limit: "100" });
		if (before) params.set("before", before);
		const response = await fetchImpl(
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
	store: StateStore;
	fetchImpl?: typeof fetch;
	identityHomeDir?: string;
	accessFileReader?: (path: string) => string;
	now?: () => number;
	enqueueLeadInbox?: (
		leadId: string,
		payload: AlertPayload,
	) => { queued: true; deliveryId: string };
	inspectLeadInbox?: (
		projectName: string,
		deliveryId: string,
	) => MailboxSettlement;
	leadRecipientState?: (leadId: string) => MailboxRecipientState;
}

export function createProductionFlagScanEffects(
	opts: ProductionFlagScanEffectsOptions,
): FlagRetirementScanEffects {
	const owner = () => resolveFlagScanOwner(opts.projects);
	const fetchImpl = opts.fetchImpl ?? fetch;
	const now = opts.now ?? (() => Date.now());
	const accessFileReader =
		opts.accessFileReader ?? ((path) => readFileSync(path, "utf8"));
	const linearContext = async () => {
		if (!opts.linearApiKey) throw new Error("LINEAR_API_KEY is not configured");
		const client = new LinearClient({ apiKey: opts.linearApiKey });
		const teams = await client.teams({ filter: { key: { eq: "FLY" } } });
		if (teams.nodes.length !== 1) throw new Error("FLY Linear team is missing");
		return { client, team: teams.nodes[0]! };
	};
	const discordContext = () => {
		const resolved = owner();
		const { engineeringLead, senderLead } = resolved;
		const identity = compileLeadIdentityRegistry(opts.projects, {
			homeDir: opts.identityHomeDir ?? homedir(),
		}).find(
			(row) =>
				row.projectName.toLowerCase() === "flywheel" &&
				row.leadId === engineeringLead.agentId,
		);
		if (!identity)
			throw new Error("Flywheel Engineering Lead identity is missing");
		const accessPath = join(identity.discordStateDir, "access.json");
		let access: {
			allowBots?: unknown;
			groups?: Record<string, unknown>;
		};
		try {
			access = JSON.parse(accessFileReader(accessPath)) as typeof access;
		} catch (error) {
			throw new Error(
				`weekly flag scan cannot read Engineering Lead access.json: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!access.groups?.[FLYWHEEL_CORE_CHANNEL_ID]) {
			throw new Error(
				"Engineering Lead access.json lacks the Flywheel core group",
			);
		}
		if (
			!Array.isArray(access.allowBots) ||
			!access.allowBots.includes(senderLead.botUserId)
		) {
			throw new Error("Engineering Lead allowBots lacks the CoS sender bot id");
		}
		return {
			...resolved,
			channelId: FLYWHEEL_CORE_CHANNEL_ID,
			botToken: senderLead.botToken!,
			senderBotUserId: senderLead.botUserId!,
			engineeringBotUserId: engineeringLead.botUserId!,
			accessPath,
		};
	};

	async function requestJson(
		url: string,
		botToken: string,
		init: RequestInit = {},
	): Promise<{ response: Response; body: Record<string, unknown> }> {
		const response = await fetchImpl(url, {
			...init,
			headers: {
				Authorization: `Bot ${botToken}`,
				...(init.body ? { "Content-Type": "application/json" } : {}),
				...init.headers,
			},
		});
		const body = (await response.json().catch(() => ({}))) as Record<
			string,
			unknown
		>;
		return { response, body };
	}

	async function postSingleMessage(input: {
		channelId: string;
		botToken: string;
		content: string;
		mentionUserIds?: string[];
	}): Promise<string> {
		const content = markAutomatedDiscordText(input.content);
		if (content.length > MAX_DISCORD_MESSAGE_LENGTH) {
			throw new Error("weekly flag scan Discord root must fit one message");
		}
		const { response, body } = await requestJson(
			`${DISCORD_API}/channels/${input.channelId}/messages`,
			input.botToken,
			{
				method: "POST",
				body: JSON.stringify({
					content,
					allowed_mentions: {
						parse: [],
						...(input.mentionUserIds ? { users: input.mentionUserIds } : {}),
					},
				}),
			},
		);
		if (!response.ok || typeof body.id !== "string") {
			throw new Error(`Discord message POST failed with ${response.status}`);
		}
		return body.id;
	}

	async function ensureThread(input: {
		channelId: string;
		rootMessageId: string;
		botToken: string;
		name: string;
	}): Promise<string> {
		const { response, body } = await requestJson(
			`${DISCORD_API}/channels/${input.channelId}/messages/${input.rootMessageId}/threads`,
			input.botToken,
			{
				method: "POST",
				body: JSON.stringify({
					name: input.name.slice(0, 100),
					auto_archive_duration: 1440,
				}),
			},
		);
		if (response.ok) {
			return typeof body.id === "string" ? body.id : input.rootMessageId;
		}
		if (response.status === 400 && body.code === THREAD_ALREADY_EXISTS_CODE) {
			const confirmed = await requestJson(
				`${DISCORD_API}/channels/${input.rootMessageId}`,
				input.botToken,
			);
			if (
				confirmed.response.ok &&
				confirmed.body.parent_id === input.channelId
			) {
				return input.rootMessageId;
			}
		}
		throw new Error(`Discord thread create failed with ${response.status}`);
	}

	function preflightFingerprint(
		input: ReturnType<typeof discordContext>,
	): string {
		return createHash("sha256")
			.update(
				[
					input.channelId,
					input.senderBotUserId,
					input.engineeringBotUserId,
					input.accessPath,
				].join("\u001f"),
			)
			.digest("hex");
	}

	function latestPreflightEvidence(runToken: string): FlagScanDiscordEvidence {
		const current = opts.store.getFlagScanRunByToken?.(runToken);
		if (current) {
			const leg = opts.store
				.getFlagScanRunLegs(current.runId)
				.find((candidate) => candidate.leg === "discord");
			const evidence = parseDiscordEvidence(leg?.evidence);
			if (evidence.preflightAt) return evidence;
		}
		for (const run of [...opts.store.listFlagScanRuns()].reverse()) {
			const leg = opts.store
				.getFlagScanRunLegs(run.runId)
				.find((candidate) => candidate.leg === "discord");
			const evidence = parseDiscordEvidence(leg?.evidence);
			if (evidence.preflightAt) return evidence;
		}
		return {};
	}

	async function runDiscordPreflight(
		runToken: string,
		discord: ReturnType<typeof discordContext>,
	): Promise<FlagScanDiscordEvidence> {
		const identity = await requestJson(
			`${DISCORD_API}/users/@me`,
			discord.botToken,
		);
		if (!identity.response.ok || identity.body.id !== discord.senderBotUserId) {
			throw new Error("weekly flag scan sender token identity mismatch");
		}
		const fingerprint = preflightFingerprint(discord);
		const previous = latestPreflightEvidence(runToken);
		if (
			previous.preflightSucceeded === true &&
			previous.preflightFingerprint === fingerprint &&
			typeof previous.preflightAt === "number" &&
			now() - previous.preflightAt < DISCORD_PREFLIGHT_MAX_AGE_MS
		) {
			return previous;
		}
		const attemptedAt = now();
		let probeRootId: string | undefined;
		let probeThreadId: string | undefined;
		try {
			probeRootId = await postSingleMessage({
				channelId: discord.channelId,
				botToken: discord.botToken,
				content: "flag-scan Discord permission probe · 自动清理 · 不需回复",
			});
			probeThreadId = await ensureThread({
				channelId: discord.channelId,
				rootMessageId: probeRootId,
				botToken: discord.botToken,
				name: "flag-scan permission probe",
			});
			await postSingleMessage({
				channelId: probeThreadId,
				botToken: discord.botToken,
				content: "flag-scan send-in-thread permission probe",
			});
			return {
				preflightAt: attemptedAt,
				preflightFingerprint: fingerprint,
				preflightSucceeded: true,
			};
		} finally {
			if (probeThreadId) {
				await requestJson(
					`${DISCORD_API}/channels/${probeThreadId}`,
					discord.botToken,
					{ method: "PATCH", body: JSON.stringify({ archived: true }) },
				).catch(() => undefined);
			}
			if (probeRootId) {
				await fetchImpl(
					`${DISCORD_API}/channels/${discord.channelId}/messages/${probeRootId}`,
					{
						method: "DELETE",
						headers: { Authorization: `Bot ${discord.botToken}` },
					},
				).catch(() => undefined);
			}
		}
	}

	async function deliverInboxHandoff(input: {
		runToken: string;
		threadId: string;
		discord: ReturnType<typeof discordContext>;
		evidence: FlagScanDiscordEvidence;
	}): Promise<{ done: boolean; evidence: FlagScanDiscordEvidence }> {
		if (!opts.enqueueLeadInbox || !opts.inspectLeadInbox) {
			throw new Error("weekly flag scan Lead inbox is not configured");
		}
		const payloadFor = (leadId: string): AlertPayload => ({
			leadId,
			projectName: input.discord.project.projectName,
			eventId: input.runToken,
			eventType: "flag_scan_handoff",
			title: "Weekly flag scan is ready for founder questions",
			body: `Flywheel core thread=${input.threadId} channel=${input.discord.channelId}. Answer Annie there; write verdict + run preflight before any cleanup.`,
			severity: "info",
		});
		const delivered = deliverFlagScanMailboxAlert({
			primaryLeadId: input.discord.leadId,
			fallbackLeadId: input.discord.senderLeadId,
			projectName: input.discord.project.projectName,
			payloadFor,
			enqueueLeadInbox: opts.enqueueLeadInbox,
			inspectLeadInbox: opts.inspectLeadInbox,
			leadRecipientState: opts.leadRecipientState,
		});
		return {
			done: delivered.done,
			evidence: {
				...input.evidence,
				inboxDeliveryId: delivered.deliveryId,
				inboxRecipient: delivered.recipient,
			},
		};
	}

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
			const preflight = await runDiscordPreflight(input.runToken, discord);
			const marker = `\`${RECONCILE_MARKER_PREFIX}${input.runToken}\``;
			const withoutMarker = input.body
				.split("\n")
				.filter((line) => !line.includes(RECONCILE_MARKER_PREFIX))
				.join("\n");
			const rootMessageId = await postSingleMessage({
				channelId: discord.channelId,
				botToken: discord.botToken,
				content: `${marker}\n${withoutMarker}`,
			});
			const threadId = await ensureThread({
				channelId: discord.channelId,
				rootMessageId,
				botToken: discord.botToken,
				name: `flag 周扫描 · ${new Date(now()).toISOString().slice(0, 10)}`,
			});
			const handoffMessageId = await postSingleMessage({
				channelId: threadId,
				botToken: discord.botToken,
				content: `<@${discord.engineeringBotUserId}> Annie 会在这里问/定 flag；请在本 thread 解释并把裁决写回 verdict + preflight。\n\`${HANDOFF_MARKER_PREFIX}${input.runToken}\``,
				mentionUserIds: [discord.engineeringBotUserId],
			});
			const handoff = await deliverInboxHandoff({
				runToken: input.runToken,
				threadId,
				discord,
				evidence: {
					...preflight,
					rootMessageId,
					threadId,
					handoffMessageId,
				},
			});
			return {
				status: handoff.done ? "done" : "ambiguous",
				evidence: JSON.stringify(handoff.evidence),
			};
		},

		async reconcileDiscord(input): Promise<FlagScanReconcileResult> {
			const discord = discordContext();
			const root = await findDiscordBatch({
				...input,
				...discord,
				fetchImpl,
			});
			if (root.status === "missing") return root;
			if (root.status === "pending") return root;
			const priorRun = opts.store.getFlagScanRunByToken?.(input.runToken);
			const priorEvidence = priorRun
				? parseDiscordEvidence(
						opts.store
							.getFlagScanRunLegs(priorRun.runId)
							.find((leg) => leg.leg === "discord")?.evidence,
					)
				: {};
			const threadId = await ensureThread({
				channelId: discord.channelId,
				rootMessageId: root.evidence,
				botToken: discord.botToken,
				name: `flag 周扫描 · ${new Date(now()).toISOString().slice(0, 10)}`,
			});
			const visibleHandoff = await findDiscordBatch({
				channelId: threadId,
				botToken: discord.botToken,
				runToken: input.runToken,
				createdAfter: input.createdAfter,
				fetchImpl,
				markerPrefix: HANDOFF_MARKER_PREFIX,
			});
			let handoffMessageId: string;
			if (visibleHandoff.status === "found") {
				handoffMessageId = visibleHandoff.evidence;
			} else {
				handoffMessageId = await postSingleMessage({
					channelId: threadId,
					botToken: discord.botToken,
					content: `<@${discord.engineeringBotUserId}> Annie 会在这里问/定 flag；请在本 thread 解释并把裁决写回 verdict + preflight。\n\`${HANDOFF_MARKER_PREFIX}${input.runToken}\``,
					mentionUserIds: [discord.engineeringBotUserId],
				});
			}
			const handoff = await deliverInboxHandoff({
				runToken: input.runToken,
				threadId,
				discord,
				evidence: {
					...priorEvidence,
					rootMessageId: root.evidence,
					threadId,
					handoffMessageId,
				},
			});
			return {
				status: handoff.done ? "found" : "pending",
				evidence: JSON.stringify(handoff.evidence),
			};
		},

		async notifyLead(input): Promise<FlagScanEffectResult> {
			if (!opts.enqueueLeadInbox || !opts.inspectLeadInbox) {
				throw new Error("weekly flag scan Lead inbox is not configured");
			}
			const { project, leadId, senderLeadId } = owner();
			const delivered = deliverFlagScanMailboxAlert({
				primaryLeadId: leadId,
				fallbackLeadId: senderLeadId,
				projectName: project.projectName,
				payloadFor: (recipient) => ({
					leadId: recipient,
					projectName: project.projectName,
					eventId: input.eventId,
					eventType: "flag_scan_no_clock",
					title: `Weekly flag scan clock debt (${input.partIndex}/${input.partCount})`,
					body: input.body,
					severity: "warning",
				}),
				enqueueLeadInbox: opts.enqueueLeadInbox,
				inspectLeadInbox: opts.inspectLeadInbox,
				leadRecipientState: opts.leadRecipientState,
			});
			const evidence = JSON.stringify({
				inboxDeliveryId: delivered.deliveryId,
				inboxRecipient: delivered.recipient,
			});
			return delivered.done
				? { status: "done", evidence }
				: { status: "ambiguous", evidence };
		},
	};
}
