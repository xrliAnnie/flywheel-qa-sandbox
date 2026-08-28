import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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
import { resolveInfraNotifyIdentity } from "./infra-notify.js";

const RECONCILE_MARKER_PREFIX = "flywheel:flag-governance run=";
const HANDOFF_MARKER_PREFIX = "flywheel:flag-governance handoff run=";
const DISCORD_PREFLIGHT_MAX_AGE_MS = 21 * 24 * 60 * 60_000;
const THREAD_ALREADY_EXISTS_CODE = 160004;
const DISCORD_SNOWFLAKE = /^\d{17,20}$/;
const DISCORD_REQUEST_TIMEOUT_MS = 15_000;

const execFileP = promisify(execFile);

interface FlagScanDiscordEvidence {
	reportUrl?: string;
	reportId?: string;
	rootMessageId?: string;
	threadId?: string;
	handoffMessageId?: string;
	inboxDeliveryId?: string;
	inboxRecipient?: string;
	preflightAt?: number;
	preflightFingerprint?: string;
	preflightSucceeded?: boolean;
	deliveryError?: string;
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
		(lead) => lead.agentId === "flywheel-cos-lead",
	);
	if (senders.length !== 1) {
		throw new Error(
			`weekly flag scan requires exactly one CoS fallback Lead; found ${senders.length}`,
		);
	}
	const senderLead = senders[0]!;
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
			{
				headers: { Authorization: `Bot ${input.botToken}` },
				signal: AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT_MS),
			},
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
	projects: ProjectEntry[];
	reportBaseUrl: string;
	reportToken?: string;
	store: StateStore;
	env?: NodeJS.ProcessEnv;
	commCliPath?: string;
	runCommand?: (
		file: string,
		args: string[],
		options: {
			env: NodeJS.ProcessEnv;
			timeout: number;
			maxBuffer: number;
			encoding: "utf8";
		},
	) => Promise<{ stdout: string; stderr: string }>;
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

interface PublishReportEnvelope {
	url: string | null;
	reportId?: string | null;
	messageId: string | null;
	screenshot?: string | null;
	delivered: boolean;
	error?: string;
}

export function createProductionFlagScanEffects(
	opts: ProductionFlagScanEffectsOptions,
): FlagRetirementScanEffects {
	const owner = () => resolveFlagScanOwner(opts.projects);
	const fetchImpl = opts.fetchImpl ?? fetch;
	const runtimeEnv = opts.env ?? process.env;
	const now = opts.now ?? (() => Date.now());
	const accessFileReader =
		opts.accessFileReader ?? ((path) => readFileSync(path, "utf8"));
	const runCommand =
		opts.runCommand ??
		(async (file, args, options) => {
			const result = await execFileP(file, args, options);
			return {
				stdout: String(result.stdout),
				stderr: String(result.stderr),
			};
		});
	const discordContext = async () => {
		const resolved = owner();
		const { engineeringLead } = resolved;
		const notifyIdentity = resolveInfraNotifyIdentity(runtimeEnv);
		if (!notifyIdentity) {
			throw new Error(
				"weekly flag scan notification identity is not configured",
			);
		}
		if (!DISCORD_SNOWFLAKE.test(notifyIdentity.notifyChannelId)) {
			throw new Error(
				"weekly flag scan notification channel is not a valid Discord snowflake",
			);
		}
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
		const sender = await requestJson(
			`${DISCORD_API}/users/@me`,
			notifyIdentity.botToken,
		);
		const senderBotUserId =
			typeof sender.body.id === "string" ? sender.body.id : "";
		if (!sender.response.ok || !DISCORD_SNOWFLAKE.test(senderBotUserId)) {
			throw new Error("weekly flag scan sender token identity is invalid");
		}
		if (!access.groups?.[notifyIdentity.notifyChannelId]) {
			throw new Error(
				"Engineering Lead access.json lacks the Flywheel notification group",
			);
		}
		if (
			!Array.isArray(access.allowBots) ||
			!access.allowBots.includes(senderBotUserId)
		) {
			throw new Error(
				"Engineering Lead allowBots lacks the notification sender bot id",
			);
		}
		return {
			...resolved,
			channelId: notifyIdentity.notifyChannelId,
			botToken: notifyIdentity.botToken,
			senderBotUserId,
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
			signal: init.signal ?? AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT_MS),
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
		input: Awaited<ReturnType<typeof discordContext>>,
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
		discord: Awaited<ReturnType<typeof discordContext>>,
	): Promise<FlagScanDiscordEvidence> {
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
						signal: AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT_MS),
					},
				).catch(() => undefined);
			}
		}
	}

	async function deliverInboxHandoff(input: {
		runToken: string;
		threadId: string;
		discord: Awaited<ReturnType<typeof discordContext>>;
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
			body: `Flywheel notification thread=${input.threadId} channel=${input.discord.channelId}. Answer Annie there; write verdict + run preflight before any cleanup.`,
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

	async function invokePublishReport(input: {
		runToken: string;
		title: string;
		html: string;
		discord: Awaited<ReturnType<typeof discordContext>>;
	}): Promise<PublishReportEnvelope> {
		if (!opts.reportToken) {
			throw new Error("weekly flag scan report token is not configured");
		}
		const tempDir = mkdtempSync(join(tmpdir(), "fly2104-flag-report-"));
		const htmlPath = join(tempDir, "weekly-flag-scan.html");
		writeFileSync(htmlPath, input.html, { encoding: "utf8", mode: 0o600 });
		try {
			const cliPath =
				opts.commCliPath ??
				join(
					input.discord.project.projectRoot,
					"packages/flywheel-comm/dist/index.js",
				);
			const title = `${input.title}\n\`${RECONCILE_MARKER_PREFIX}${input.runToken}\``;
			let stdout = "";
			try {
				const result = await runCommand(
					process.execPath,
					[
						cliPath,
						"publish-report",
						"--html",
						htmlPath,
						"--project",
						input.discord.project.projectName,
						"--title",
						title,
						"--channel",
						input.discord.channelId,
						"--no-screenshot",
					],
					{
						env: {
							...process.env,
							...runtimeEnv,
							FLYWHEEL_BRIDGE_URL: opts.reportBaseUrl,
							TEAMLEAD_API_TOKEN: opts.reportToken,
						},
						timeout: 90_000,
						maxBuffer: 2 * 1024 * 1024,
						encoding: "utf8",
					},
				);
				stdout = result.stdout;
			} catch (error) {
				const failed = error as { stdout?: string | Buffer; message?: string };
				stdout = String(failed.stdout ?? "");
				if (!stdout.trim()) {
					throw new Error(
						`flywheel-comm publish-report failed: ${failed.message ?? String(error)}`,
					);
				}
			}
			const lastLine = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
			if (!lastLine) {
				throw new Error("flywheel-comm publish-report returned no envelope");
			}
			let envelope: PublishReportEnvelope;
			try {
				envelope = JSON.parse(lastLine) as PublishReportEnvelope;
			} catch {
				throw new Error("flywheel-comm publish-report returned invalid JSON");
			}
			return envelope;
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	}

	return {
		async publishReport(input): Promise<FlagScanEffectResult> {
			const discord = await discordContext();
			const preflight = await runDiscordPreflight(input.runToken, discord);
			const envelope = await invokePublishReport({ ...input, discord });
			const evidence: FlagScanDiscordEvidence = {
				...preflight,
				...(envelope.url ? { reportUrl: envelope.url } : {}),
				...(envelope.reportId ? { reportId: envelope.reportId } : {}),
				...(envelope.messageId ? { rootMessageId: envelope.messageId } : {}),
			};
			if (!envelope.delivered || !envelope.messageId) {
				return {
					status: "ambiguous",
					evidence: JSON.stringify({
						...evidence,
						deliveryError:
							envelope.error ?? "publish-report delivery was not confirmed",
					}),
				};
			}
			try {
				const threadId = await ensureThread({
					channelId: discord.channelId,
					rootMessageId: envelope.messageId,
					botToken: discord.botToken,
					name: `flag 周扫描 · ${new Date(now()).toISOString().slice(0, 10)}`,
				});
				evidence.threadId = threadId;
				const handoffMessageId = await postSingleMessage({
					channelId: threadId,
					botToken: discord.botToken,
					content: `<@${discord.engineeringBotUserId}> Annie 会在这里问/定 flag；请在本 thread 解释并把裁决写回 verdict + preflight.\n\`${HANDOFF_MARKER_PREFIX}${input.runToken}\``,
					mentionUserIds: [discord.engineeringBotUserId],
				});
				evidence.handoffMessageId = handoffMessageId;
				const handoff = await deliverInboxHandoff({
					runToken: input.runToken,
					threadId,
					discord,
					evidence,
				});
				return {
					status: handoff.done ? "done" : "ambiguous",
					evidence: JSON.stringify(handoff.evidence),
				};
			} catch (error) {
				return {
					status: "ambiguous",
					evidence: JSON.stringify({
						...evidence,
						deliveryError:
							error instanceof Error ? error.message : String(error),
					}),
				};
			}
		},

		async postDiscord(input): Promise<FlagScanEffectResult> {
			const discord = await discordContext();
			const preflight = await runDiscordPreflight(input.runToken, discord);
			const marker = `\`${RECONCILE_MARKER_PREFIX}${input.runToken}\``;
			const withoutMarker = input.body
				.split("\n")
				.filter((line) => !line.includes(RECONCILE_MARKER_PREFIX))
				.join("\n");
			const rootMessageId = await postSingleMessage({
				channelId: discord.channelId,
				botToken: discord.botToken,
				content: `${withoutMarker} · ${marker}`,
			});
			return {
				status: "done",
				evidence: JSON.stringify({ ...preflight, rootMessageId }),
			};
		},

		async reconcileDiscord(input): Promise<FlagScanReconcileResult> {
			const discord = await discordContext();
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
			if (priorRun?.candidateCount === 0) {
				return {
					status: "found",
					evidence: JSON.stringify({
						...priorEvidence,
						rootMessageId: root.evidence,
					}),
				};
			}
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
