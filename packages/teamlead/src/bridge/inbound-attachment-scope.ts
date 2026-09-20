import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	type ChatDeliveryEnvelopeV1,
	parseChatDeliveryEnvelope,
} from "flywheel-comm/discord-chat-ingest";
import {
	identityEnvProjection,
	resolveLeadIdentityRow,
} from "flywheel-comm/lead-identity";
import {
	forwardedLeadAuthorizationEnv,
	type LeadCarrierValidation,
	validateLeadCarrierAuthorization,
} from "flywheel-comm/lead-lease";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import {
	buildAuthorizeLeadChannel,
	buildResolveBotToken,
	type LeadChannelAuthorization,
} from "../lead-backends/codexLeadBridgeWiring.js";
import {
	DiscordInboundAttachmentError,
	type DiscordInboundAttachmentFailureReason,
} from "../lead-capabilities/discord-attachments.js";
import { parseAndValidateProjects } from "../ProjectConfig.js";
import { commDbPathForProject } from "./commdb-path.js";

const sha256 = (value: string | Buffer) =>
	createHash("sha256").update(value).digest("hex");

function failure(reason: DiscordInboundAttachmentFailureReason) {
	return new DiscordInboundAttachmentError(reason);
}

export interface InboundAttachmentScopeOptions {
	projectName: string;
	leadId: string;
	identityDigest: string;
	carrierClaim: string;
	deliveryId: string;
	attachmentId: string;
	projectsPath: string;
	homeDir: string;
	env?: NodeJS.ProcessEnv;
	commDbPath?: (projectName: string) => string;
	validateCarrier?: typeof validateLeadCarrierAuthorization;
	authorizeChannel?: (
		projectName: string,
		leadId: string,
		channelId: string,
	) => Promise<LeadChannelAuthorization>;
}

export interface InboundAttachmentScope {
	attachment: ChatDeliveryEnvelopeV1["attachments"][number];
	messageId: string;
	originChannelId: string;
	botToken: string;
	carrierInstanceDigest: string;
	receiptDigest: string;
	assertCurrent(): Promise<void>;
}

function carrierDigest(validation: LeadCarrierValidation): string | undefined {
	return validation.valid && !validation.processIndeterminate
		? sha256(JSON.stringify(validation.carrier))
		: undefined;
}

/**
 * Captures the narrow v1 authority for one immutable Discord mailbox receipt.
 * Revalidation re-reads registry, carrier evidence, and the receipt; it does
 * not reuse the v2 capability-bundle scope or trust reply routing.
 */
export async function captureInboundAttachmentScope(
	options: InboundAttachmentScopeOptions,
): Promise<InboundAttachmentScope> {
	const baseEnv = options.env ?? process.env;
	const validateCarrier =
		options.validateCarrier ?? validateLeadCarrierAuthorization;
	const readProjects = () => {
		const source = readFileSync(options.projectsPath, "utf8");
		return {
			sourceDigest: sha256(source),
			projects: parseAndValidateProjects(JSON.parse(source)),
		};
	};
	let initialRow: ReturnType<typeof resolveLeadIdentityRow>;
	let projectSnapshot: ReturnType<typeof readProjects>;
	try {
		projectSnapshot = readProjects();
		initialRow = resolveLeadIdentityRow({
			projectsPath: options.projectsPath,
			homeDir: options.homeDir,
			projectName: options.projectName,
			leadId: options.leadId,
		});
	} catch {
		throw failure("scope_denied");
	}
	if (
		initialRow.identity.projectsDigest !== projectSnapshot.sourceDigest ||
		initialRow.identity.identityDigest !== options.identityDigest ||
		initialRow.identity.backend !== "codex-app-server" ||
		initialRow.lead.codexCapabilityBundleVersion !== undefined
	)
		throw failure("scope_denied");
	const identityEnvironment = Object.fromEntries(
		identityEnvProjection(initialRow.identity).map((line) => {
			const separator = line.indexOf("=");
			return [line.slice(0, separator), line.slice(separator + 1)];
		}),
	);
	const claimEnv = forwardedLeadAuthorizationEnv(
		{
			claimedLeadId: options.leadId,
			projectName: options.projectName,
			identityDigest: options.identityDigest,
			carrierClaim: options.carrierClaim,
		},
		{
			...baseEnv,
			...identityEnvironment,
			HOME: options.homeDir,
			FLYWHEEL_PROJECTS_FILE: options.projectsPath,
		},
	);
	const initialCarrier = validateCarrier({
		claimedLeadId: options.leadId,
		env: claimEnv,
	});
	const initialCarrierDigest = carrierDigest(initialCarrier);
	if (!initialCarrier.valid || !initialCarrierDigest)
		throw failure("scope_denied");

	const dbPath = (options.commDbPath ?? commDbPathForProject)(
		options.projectName,
	);
	const readReceipt = () => {
		let queue: MailboxQueue | undefined;
		try {
			queue = new MailboxQueue(dbPath, { readOnly: true });
			const mailbox = queue.getById(options.deliveryId);
			if (
				!mailbox ||
				mailbox.id !== options.deliveryId ||
				mailbox.delivery_id !== options.deliveryId ||
				mailbox.recipient_kind !== "lead" ||
				mailbox.to_agent !== options.leadId ||
				mailbox.source_kind !== "discord_chat" ||
				mailbox.source_ref !== options.deliveryId ||
				mailbox.type !== "discord_chat" ||
				!["QUEUED", "LEASED", "ACKED"].includes(mailbox.state)
			)
				throw failure("scope_denied");
			const envelope = parseChatDeliveryEnvelope(mailbox.content);
			if (
				envelope.deliveryId !== options.deliveryId ||
				envelope.leadId !== options.leadId ||
				`chat:${envelope.leadId}:${envelope.messageId}` !== options.deliveryId
			)
				throw failure("scope_denied");
			return {
				envelope,
				receiptDigest: sha256(mailbox.content),
			};
		} catch (error) {
			if (error instanceof DiscordInboundAttachmentError) throw error;
			throw failure("scope_denied");
		} finally {
			queue?.close();
		}
	};
	const receipt = readReceipt();
	const matches = receipt.envelope.attachments.filter(
		(attachment) => attachment.attachmentId === options.attachmentId,
	);
	if (matches.length !== 1) {
		if (
			receipt.envelope.attachments.some(
				(attachment) => attachment.unavailableReason === "invalid_metadata",
			)
		)
			throw failure("invalid_metadata");
		if (
			receipt.envelope.attachments.some(
				(attachment) =>
					attachment.unavailableReason === "producer_identity_missing",
			)
		)
			throw failure("producer_identity_missing");
		throw failure("scope_denied");
	}
	const attachment = matches[0]!;
	if (attachment.unavailableReason) throw failure(attachment.unavailableReason);
	const sizeBytes = attachment.sizeKb * 1024;
	if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0)
		throw failure("invalid_metadata");

	const resolveBotToken = buildResolveBotToken(
		projectSnapshot.projects,
		baseEnv,
	);
	const botToken = resolveBotToken(options.projectName, options.leadId);
	if (!botToken) throw failure("scope_denied");
	const authorize =
		options.authorizeChannel ??
		buildAuthorizeLeadChannel(projectSnapshot.projects, { resolveBotToken });
	const authorization = await authorize(
		options.projectName,
		options.leadId,
		receipt.envelope.originChannelId,
	);
	if (authorization === "unavailable") throw failure("fetch_unavailable");
	if (authorization !== true) throw failure("scope_denied");

	const assertCurrent = async () => {
		let currentRow: ReturnType<typeof resolveLeadIdentityRow>;
		try {
			const currentProjects = readProjects();
			if (currentProjects.sourceDigest !== projectSnapshot.sourceDigest)
				throw failure("scope_denied");
			currentRow = resolveLeadIdentityRow({
				projectsPath: options.projectsPath,
				homeDir: options.homeDir,
				projectName: options.projectName,
				leadId: options.leadId,
			});
			if (
				currentRow.identity.identityDigest !== options.identityDigest ||
				currentRow.identity.backend !== "codex-app-server" ||
				currentRow.lead.codexCapabilityBundleVersion !== undefined
			)
				throw failure("scope_denied");
		} catch (error) {
			if (error instanceof DiscordInboundAttachmentError) throw error;
			throw failure("scope_denied");
		}
		const currentCarrier = validateCarrier({
			claimedLeadId: options.leadId,
			env: claimEnv,
		});
		if (
			!currentCarrier.valid ||
			carrierDigest(currentCarrier) !== initialCarrierDigest
		)
			throw failure("carrier_expired");
		const currentReceipt = readReceipt();
		if (currentReceipt.receiptDigest !== receipt.receiptDigest)
			throw failure("scope_denied");
		if (
			buildResolveBotToken(projectSnapshot.projects, baseEnv)(
				options.projectName,
				options.leadId,
			) !== botToken
		)
			throw failure("scope_denied");
	};
	await assertCurrent();
	return {
		attachment,
		messageId: receipt.envelope.messageId,
		originChannelId: receipt.envelope.originChannelId,
		botToken,
		carrierInstanceDigest: initialCarrier.carrier.instanceDigest,
		receiptDigest: receipt.receiptDigest,
		assertCurrent,
	};
}
