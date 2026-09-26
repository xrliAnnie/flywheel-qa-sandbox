import { createHash, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { LinearClient } from "@linear/sdk";
import { type Application, Router, raw } from "express";
import { forwardedLeadAuthorizationEnv } from "flywheel-comm/lead-lease";
import { z } from "zod";
import { DepartmentRegistry } from "../department-registry.js";
import {
	CodexLeadOutboundHandler,
	type OutboundDedupStore,
} from "../lead-backends/codex/CodexLeadOutboundHandler.js";
import type { CodexOutboundSender } from "../lead-backends/codex/CodexOutboundSender.js";
import { createBrokerDiscordOutboundSender } from "../lead-backends/codex/capability-outbound.js";
import { buildLeadDiscordSend } from "../lead-backends/codex/leadDiscordSend.js";
import { buildAuthorizeLeadChannel } from "../lead-backends/codexLeadBridgeWiring.js";
import {
	type AttachmentUploadFile,
	decodeAttachmentUpload,
	MAX_ATTACHMENT_UPLOAD_BYTES,
} from "../lead-capabilities/attachment-upload.js";
import type {
	HandlerOutcome,
	LeadOperationContext,
} from "../lead-capabilities/broker.js";
import { getLeadCapability } from "../lead-capabilities/catalog.js";
import {
	executeDiscordAttachmentSend,
	fetchDiscordAttachment,
} from "../lead-capabilities/discord-attachments.js";
import {
	createDiscordHandlers,
	type DiscordIssueBinding,
} from "../lead-capabilities/handlers/discord.js";
import type {
	OperationReceipt,
	OperationReceiptStore,
} from "../lead-capabilities/receipts.js";
import {
	linearRequestFromClient,
	resolveRootCauseScheduleIdentity,
} from "../patrol-root-causes.js";
import type { StateStore } from "../StateStore.js";
import type { ChatThreadCreator } from "./ChatThreadCreator.js";
import { DiscordFetcher } from "./founder-consent/discord-fetch.js";
import { captureLeadCapabilityScope } from "./lead-capability-scope.js";

const automaticInput = z
	.object({
		channelId: z.string().regex(/^\d{17,20}$/),
		text: z.string().min(1).max(12000),
		idempotencyKey: z.string().min(1).max(256),
		nonce: z.string().min(1).max(32),
	})
	.strict();

const automaticProbeInput = automaticInput.pick({ channelId: true });

const envelopeSchema = z
	.object({
		schemaVersion: z.literal(1),
		operationId: z.enum([
			"discord.output.deliver",
			"discord.output.authorize",
			"discord.thread.resolve",
			"discord.thread.create",
			"discord.thread.read",
			"discord.thread.reply",
			"discord.message.edit",
			"discord.message.react",
			"discord.message.attachments.get",
			"discord.message.attachments.send",
		]),
		requestId: z.string().uuid(),
		projectName: z.string().min(1).max(128),
		leadId: z.string().min(1).max(128),
		identityDigest: z.string().regex(/^[a-f0-9]{64}$/),
		carrierClaim: z.string().min(1).max(256),
		activationId: z.string().min(1).max(128),
		// Trusted authenticated parent envelope only; never part of operation input.
		deliveryContext: z
			.string()
			.regex(/^[A-Za-z0-9_.:-]{1,512}$/)
			.optional(),
		receiptOnly: z.boolean().optional(),
		input: z.unknown(),
	})
	.strict();
export interface LeadCapabilityDiscordOptions {
	attachmentFetch?: typeof fetch;
	operationReceipts?: OperationReceiptStore;
	apiToken: string;
	store: StateStore;
	projectsPath?: string;
	homeDir?: string;
	env?: NodeJS.ProcessEnv;
	linearClient?: LinearClient;
	chatThreadCreator?: ChatThreadCreator;
	ownerUserId?: string;
	outboundDedupStore?: OutboundDedupStore;
	outboundDbPath?: string;
}
const digest = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
const denied = () => new Error("discord_scope_denied");
/** Dispatch-once provider: durable dispatch/replay authority remains the parent's journal. */
export function createLeadCapabilityDiscordRouter(
	options: LeadCapabilityDiscordOptions,
): Router {
	const router = Router();
	const requests = new Map<
		string,
		{ digest: string; result?: unknown; settled?: boolean }
	>(); // Active work is pinned; completed writes replay from durable receipts.
	let uploadActive = false;
	router.post("/attachments", (req, res, next) => {
		const supplied = Buffer.from(req.headers.authorization ?? ""),
			expected = Buffer.from(`Bearer ${options.apiToken}`);
		if (
			!options.apiToken ||
			supplied.length !== expected.length ||
			!timingSafeEqual(supplied, expected)
		) {
			res.status(401).json({ status: "rejected", errorCode: "unauthorized" });
			return;
		}
		if (uploadActive) {
			res
				.status(503)
				.json({ status: "rejected", errorCode: "provider_capacity" });
			return;
		}
		if (
			req.headers["content-type"] !== "application/octet-stream" ||
			req.headers["content-encoding"]
		) {
			res.status(400).json({ status: "rejected", errorCode: "invalid_upload" });
			return;
		}
		uploadActive = true;
		const deadline = setTimeout(() => req.destroy(), 15000);
		const release = () => {
			uploadActive = false;
			clearTimeout(deadline);
			res.off("finish", release);
			res.off("close", release);
		};
		res.once("finish", release);
		res.once("close", release);
		raw({
			type: "application/octet-stream",
			limit: MAX_ATTACHMENT_UPLOAD_BYTES,
			inflate: false,
		})(req, res, (error) => {
			if (res.writableEnded) return;
			try {
				if (error) throw error;
				const decoded = decodeAttachmentUpload(req.body);
				res.locals.attachmentFiles = decoded.files;
				req.body = decoded.envelope;
				next();
			} catch {
				res
					.status(400)
					.json({ status: "rejected", errorCode: "invalid_upload" });
			}
		});
	});
	router.post(["/", "/attachments"], async (req, res) => {
		const supplied = Buffer.from(req.headers.authorization ?? ""),
			expected = Buffer.from(`Bearer ${options.apiToken}`);
		if (
			!options.apiToken ||
			supplied.length !== expected.length ||
			!timingSafeEqual(supplied, expected)
		) {
			res.status(401).json({ status: "rejected", errorCode: "unauthorized" });
			return;
		}
		const parsed = envelopeSchema.safeParse(req.body);
		if (
			!parsed.success ||
			Buffer.byteLength(JSON.stringify(req.body)) > 65536
		) {
			res
				.status(400)
				.json({ status: "rejected", errorCode: "invalid_request" });
			return;
		}
		if (
			(req.path === "/attachments") !==
				(parsed.data.operationId === "discord.message.attachments.send") ||
			(parsed.data.receiptOnly &&
				![
					"discord.message.attachments.send",
					"discord.thread.create",
					"discord.thread.reply",
					"discord.message.edit",
					"discord.message.react",
				].includes(parsed.data.operationId))
		) {
			res
				.status(400)
				.json({ status: "rejected", errorCode: "invalid_request" });
			return;
		}
		const body = parsed.data,
			definition = getLeadCapability(body.operationId)!;
		const input = (
			body.operationId === "discord.output.deliver"
				? automaticInput
				: body.operationId === "discord.output.authorize"
					? automaticProbeInput
					: definition.inputSchema
		).safeParse(body.input);
		if (!input.success) {
			res.status(400).json({ status: "rejected", errorCode: "invalid_input" });
			return;
		}
		const key = JSON.stringify([
				body.projectName,
				body.leadId,
				body.operationId,
				body.requestId,
			]),
			inputDigest = digest(input.data);
		let executing = false;
		let writeReceipt: OperationReceipt | undefined;
		const receiptKey = {
			projectName: body.projectName,
			leadId: body.leadId,
			operationId: body.operationId,
			requestId: body.requestId,
		};
		function settleWrite(result: HandlerOutcome) {
			if (!writeReceipt) return;
			writeReceipt = options.operationReceipts!.transition({
				...receiptKey,
				inputDigest,
				activationId: writeReceipt.activationId,
				now: Date.now(),
				from: writeReceipt.state,
				to: result.status,
				...(result.providerRef ? { providerRef: result.providerRef } : {}),
			});
		}
		let outboundSender: CodexOutboundSender | undefined;
		let canonicalBinding: { identifier: string; key: string } | undefined;
		const controller = new AbortController(),
			timer = setTimeout(() => controller.abort(), 15000);
		const disconnected = () => {
			if (!res.writableEnded) controller.abort();
		};
		req.once("aborted", disconnected);
		res.once("close", disconnected);

		const baseEnv = options.env ?? process.env,
			home = options.homeDir ?? homedir(),
			projectsPath =
				options.projectsPath ??
				baseEnv.FLYWHEEL_PROJECTS_FILE ??
				join(home, ".flywheel/projects.json");
		try {
			const claimEnv = forwardedLeadAuthorizationEnv(
				{
					claimedLeadId: body.leadId,
					projectName: body.projectName,
					identityDigest: body.identityDigest,
					carrierClaim: body.carrierClaim,
				},
				{ ...baseEnv, HOME: home, FLYWHEEL_PROJECTS_FILE: projectsPath },
			);
			const initial = captureLeadCapabilityScope({
				projectsPath,
				homeDir: home,
				projectName: body.projectName,
				leadId: body.leadId,
				identityDigest: body.identityDigest,
				claimEnv,
				denied,
				rejectChatChannel: baseEnv.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID,
			});
			function current() {
				controller.signal.throwIfAborted();
				if (canonicalBinding) {
					const session = options.store.getSessionByIdentifier(
						canonicalBinding.identifier,
					);
					if (
						(session?.issue_id ?? canonicalBinding.identifier) !==
							canonicalBinding.key ||
						(session && session.project_name !== body.projectName)
					)
						throw denied();
				}
				initial.assertSourceCurrent();
				return initial;
			}
			const initialRevision = digest(initial.row.lead);
			if (
				body.operationId === "discord.output.deliver" ||
				body.operationId === "discord.output.authorize"
			) {
				if (
					(body.operationId === "discord.output.deliver" &&
						!body.deliveryContext) ||
					!options.outboundDedupStore
				)
					throw denied();
				const payload = automaticProbeInput.parse({
					channelId: (body.input as Record<string, unknown>).channelId,
				});
				const revision = digest(initial.project);
				const assertScope = () => {
					const c = current();
					if (digest(c.project) !== revision) throw denied();
					return c;
				};
				const resolveToken = (project: string, lead: string) => {
					const c = assertScope();
					if (project !== body.projectName || lead !== body.leadId)
						return undefined;
					return (
						c.lead.botToken ??
						(c.lead.botTokenEnv ? baseEnv[c.lead.botTokenEnv] : undefined)
					);
				};
				const authorize = async () => {
					const c = assertScope();
					const allowed = await buildAuthorizeLeadChannel(c.projects, {
						resolveBotToken: resolveToken,
					})(body.projectName, body.leadId, payload.channelId);
					assertScope();
					if (allowed !== true) throw denied();
				};
				if (!resolveToken(body.projectName, body.leadId)) throw denied();
				await authorize();
				if (body.operationId === "discord.output.authorize") {
					res.json({
						requestId: body.requestId,
						status: "succeeded",
						resourceRefs: [],
						data: { status: "authorized" },
					});
					return;
				}
				const deliveryPayload = automaticInput.parse(body.input);
				const handler = new CodexLeadOutboundHandler({
					store: options.outboundDedupStore,
					expectedApiToken: options.apiToken,
					authorizeLeadChannel: async (project, lead, channel) => {
						if (
							project !== body.projectName ||
							lead !== body.leadId ||
							channel !== payload.channelId
						)
							return false;
						await authorize();
						return true;
					},
					send: buildLeadDiscordSend({ resolveBotToken: resolveToken }),
				});
				executing = true;
				const result = await handler.handle({
					providedToken: options.apiToken,
					deliveryContext: body.deliveryContext,
					body: {
						projectName: body.projectName,
						leadId: body.leadId,
						...deliveryPayload,
					},
					guard: {
						signal: controller.signal,
						beforeSideEffect: authorize,
						assertSideEffectCurrent: () => {
							assertScope();
						},
					},
				});
				res.status(result.httpStatus).json({
					requestId: body.requestId,
					status: ["sent", "deduped"].includes(result.status)
						? "succeeded"
						: result.status === "ambiguous"
							? "unknown"
							: "rejected",
					resourceRefs: [],
					data: result,
				});
				return;
			}
			const configuredClient =
				options.linearClient ??
				(baseEnv.LINEAR_API_KEY
					? new LinearClient({ apiKey: baseEnv.LINEAR_API_KEY })
					: undefined);
			if (!configuredClient) throw denied();
			const client = configuredClient;
			const handlerInput: Record<string, unknown> = { ...input.data };
			if (typeof handlerInput.issueId === "string") {
				const issue = await client.issue(handlerInput.issueId);
				current();
				if (!issue?.identifier) throw denied();
				const session = options.store.getSessionByIdentifier(issue.identifier);
				if (session && session.project_name !== body.projectName)
					throw denied();
				handlerInput.issueId = session?.issue_id ?? issue.identifier;
				canonicalBinding = {
					identifier: issue.identifier,
					key: handlerInput.issueId as string,
				};
			}

			function policy() {
				const c = current();
				if (digest(c.row.lead) !== initialRevision) throw denied();
				return {
					projectName: body.projectName,
					leadId: body.leadId,
					parentChannelIds: new Set([c.lead.chatChannel]),
					botUserId: c.lead.botUserId,
					revision: digest([c.row.lead, c.project.linear]),
				};
			}
			function token() {
				const c = current();
				const token =
					c.lead.botToken ??
					(c.lead.botTokenEnv ? baseEnv[c.lead.botTokenEnv] : undefined);
				if (!token) throw denied();
				return token;
			}
			let scopedIssueId: string | undefined;
			async function authorizeDepartment(issueId: string) {
				const before = current(),
					issue = await client.issue(issueId);
				current();
				if (!issue) throw denied();
				const [team, project, labels] = await Promise.all([
					issue.team,
					issue.project,
					issue.labels(),
				]);
				const after = current();
				if (
					digest([before.project.linear, before.row.lead]) !==
						digest([after.project.linear, after.row.lead]) ||
					!after.project.linear ||
					team?.key !== after.project.linear.team ||
					(after.project.linear.project &&
						project?.name !== after.project.linear.project) ||
					labels.pageInfo.hasNextPage ||
					!new DepartmentRegistry(after.projects).isLeadDepartmentMember(
						body.projectName,
						body.leadId,
						labels.nodes.map((l) => l.name),
					).allowed
				)
					throw denied();
			}
			function binding(issueId: string): DiscordIssueBinding {
				if (scopedIssueId && scopedIssueId !== issueId) throw denied();
				scopedIssueId = issueId;
				const c = current(),
					thread = options.store.getChatThreadByIssue(
						issueId,
						c.lead.chatChannel,
					);
				if (thread && (thread.lead_id !== body.leadId || thread.archived_at))
					throw denied();
				return {
					issueId,
					projectName: body.projectName,
					leadId: body.leadId,
					parentId: c.lead.chatChannel,
					threadId: thread?.thread_id ?? null,
					revision: digest([c.row.lead, thread ?? null]),
				};
			}
			const context: LeadOperationContext = {
				requestId: body.requestId,
				projectName: body.projectName,
				leadId: body.leadId,
				activationId: body.activationId,
				...(body.deliveryContext
					? { deliveryContext: body.deliveryContext }
					: {}),
				signal: controller.signal,
				assertCurrent: async () => {
					current();
					if (scopedIssueId) await authorizeDepartment(scopedIssueId);
					current();
				},
			};

			if (
				body.operationId === "discord.thread.reply" ||
				body.operationId === "discord.message.edit"
			) {
				if (!options.outboundDedupStore || !options.outboundDbPath)
					throw denied();
				outboundSender = createBrokerDiscordOutboundSender({
					sender: {
						bridgeUrl: "http://127.0.0.1",
						apiToken: options.apiToken,
						projectName: body.projectName,
						leadId: body.leadId,
						channelId: current().lead.chatChannel,
						dbPath: options.outboundDbPath,
					},
					store: options.outboundDedupStore,
					deliveryContext: body.deliveryContext,
					resolveBotToken: (project, lead) =>
						project === body.projectName && lead === body.leadId
							? token()
							: undefined,
					authorizeLeadChannel: (project, lead, channel) => {
						current();
						if (
							project !== body.projectName ||
							lead !== body.leadId ||
							!scopedIssueId
						)
							return false;
						return binding(scopedIssueId).threadId === channel;
					},
				});
			}
			const handlers = createDiscordHandlers({
				policy,
				outboundSender,
				ownsMessage: (threadId, messageId) =>
					outboundSender?.ownsSentMessage(threadId, messageId) === true,
				botToken: token,
				bindingForIssue: binding,
				bindingForThread: (threadId) => {
					current();
					const row = options.store.getChatThreadByThreadId(threadId);
					if (
						!row ||
						row.session_role !== "main" ||
						row.lead_id !== body.leadId
					)
						return null;
					const result = binding(row.issue_id);
					return result.threadId === threadId ? result : null;
				},
				messageFetcher: new DiscordFetcher(token()),
				threadCreator: options.chatThreadCreator,
				createContext: (b) => ({
					issueIdentifier: canonicalBinding?.identifier ?? b.issueId,
					ownerUserId: options.ownerUserId,
				}),
				authorizeIssue: async (b) => {
					await authorizeDepartment(b.issueId);
				},
				// FLY-2914: the parent owns the founder_ask binding; the model names only the child.
				patrolSchedule: {
					resolve: (issueUuid, scope) =>
						resolveRootCauseScheduleIdentity({
							request: linearRequestFromClient(client),
							issueUuid,
							projectName: scope.projectName,
							leadId: scope.leadId,
						}),
					reserve: (ask) => {
						const reservation = options.store.reservePatrolScheduleAsk({
							ask_id: ask.askId,
							project_name: ask.projectName,
							issue_id: ask.issueId,
							channel_id: ask.parentId,
							thread_id: ask.threadId,
							lead_id: ask.leadId,
							question_id: null,
							excerpt: ask.text,
							asked_at: new Date().toISOString(),
							patrol_schedule_key: ask.scheduleKey,
						});
						return {
							reserved: reservation.reserved,
							askId: reservation.ask.ask_id,
							messageId: reservation.ask.message_id,
						};
					},
					delivered: (askId, messageId, threadId) => {
						if (!options.store.getFounderAsk(askId)?.message_id)
							options.store.backfillFounderAskMessage(
								askId,
								messageId,
								threadId,
							);
					},
					askFor: (askId) => {
						const key = options.store.getFounderAsk(askId)?.patrol_schedule_key;
						return key ? { scheduleKey: key } : undefined;
					},
				},
			});
			if (body.operationId === "discord.message.attachments.send") {
				const files = res.locals.attachmentFiles as
					| AttachmentUploadFile[]
					| undefined;
				if (
					!options.operationReceipts ||
					!files ||
					JSON.stringify(files.map((f) => f.handle)) !==
						JSON.stringify(handlerInput.artifactHandles)
				)
					throw denied();
				const readHandler = handlers.get("discord.thread.read")!;
				const assertAttachmentCurrent = async () => {
					await readHandler.authorize(
						{ threadId: handlerInput.threadId, limit: 1 },
						context,
					);
					current();
				};
				const result = await executeDiscordAttachmentSend({
					projectName: body.projectName,
					leadId: body.leadId,
					activationId: body.activationId,
					requestId: body.requestId,
					threadId: handlerInput.threadId as string,
					text: handlerInput.text as string | undefined,
					files,
					receipts: options.operationReceipts,
					receiptOnly: body.receiptOnly,
					botToken: token(),
					secrets: [options.apiToken, body.carrierClaim],
					signal: controller.signal,
					assertCurrent: assertAttachmentCurrent,
					fetchImpl: options.attachmentFetch,
				});
				res.json(result);
				return;
			}
			if (body.operationId === "discord.message.attachments.get") {
				const readHandler = handlers.get("discord.thread.read")!;
				const assertAttachmentCurrent = async () => {
					await readHandler.authorize(
						{ threadId: handlerInput.threadId, limit: 1 },
						context,
					);
					current();
				};
				const attachment = await fetchDiscordAttachment({
					threadId: handlerInput.threadId as string,
					messageId: handlerInput.messageId as string,
					attachmentId: handlerInput.attachmentId as string,
					botToken: token(),
					secrets: [options.apiToken, body.carrierClaim],
					signal: controller.signal,
					assertCurrent: assertAttachmentCurrent,
					fetchImpl: options.attachmentFetch,
				});
				await assertAttachmentCurrent();
				res.set("x-flywheel-request-id", body.requestId);
				res.set("x-flywheel-artifact-mime", attachment.mimeType);
				res.set(
					"x-flywheel-artifact-sha256",
					createHash("sha256").update(attachment.data).digest("hex"),
				);
				res.type("application/octet-stream").send(attachment.data);
				return;
			}
			const handler = handlers.get(body.operationId);
			if (!handler) throw denied();
			await handler.authorize(handlerInput, context);
			current();
			const prior = body.receiptOnly ? undefined : requests.get(key);
			if (prior) {
				if (prior.digest !== inputDigest) {
					res.status(409).json({
						requestId: body.requestId,
						status: "rejected",
						errorCode: "request_id_conflict",
						resourceRefs: [],
					});
					return;
				}
				res.json(
					prior.result ?? {
						requestId: body.requestId,
						status: "unknown",
						resourceRefs: [],
						errorCode: "dispatch_in_flight",
					},
				);
				return;
			}
			if (definition.classification === "write") {
				if (!options.operationReceipts) throw denied();
				const receipt = options.operationReceipts.get(receiptKey);
				if (receipt) {
					if (receipt.inputDigest !== inputDigest) {
						res.status(409).json({
							requestId: body.requestId,
							status: "rejected",
							resourceRefs: [],
							errorCode: "request_id_conflict",
						});
						return;
					}
					let replay: HandlerOutcome = { status: "unknown" };
					if (receipt.state === "succeeded") {
						const thread = body.operationId === "discord.thread.create";
						const prefix = thread ? "discord-thread:" : "discord-message:";
						if (!receipt.providerRef?.startsWith(prefix)) throw denied();
						const resourceId = receipt.providerRef.slice(prefix.length);
						if (!/^\d{17,20}$/.test(resourceId)) throw denied();
						replay = {
							status: "succeeded",
							providerRef: receipt.providerRef,
							data: {
								...(thread
									? { threadId: resourceId, parentId: handlerInput.parentId }
									: {
											messageId: resourceId,
											...(body.operationId === "discord.thread.reply"
												? { threadId: handlerInput.threadId }
												: {}),
										}),
								receiptId: receipt.requestId,
								observedAt: new Date(receipt.updatedAt).toISOString(),
							},
						};
					} else if (receipt.state === "rejected") {
						replay = { status: "rejected" };
					} else if (receipt.state !== "prepared" && handler.reconcile) {
						// The existing handler performs provider reads only; never execute a replay.
						replay = await handler.reconcile(receipt, handlerInput, context);
						if (
							replay.status === "succeeded" &&
							!definition.outputSchema.safeParse(replay.data).success
						)
							throw denied();
						if (replay.status !== "unknown") {
							writeReceipt = receipt;
							settleWrite(replay);
						}
					}
					if (
						replay.status === "succeeded" &&
						!definition.outputSchema.safeParse(replay.data).success
					)
						throw denied();
					res.json({
						requestId: body.requestId,
						status: replay.status,
						resourceRefs: replay.providerRef ? [replay.providerRef] : [],
						...(replay.data ? { data: replay.data } : {}),
					});
					return;
				}
			}
			if (body.receiptOnly) {
				res.json({
					requestId: body.requestId,
					status: "unknown",
					resourceRefs: [],
				});
				return;
			}
			if (requests.size >= 64) {
				const oldestSettled = [...requests].find(([, entry]) => entry.settled);
				if (oldestSettled) requests.delete(oldestSettled[0]);
			}
			if (requests.size >= 64) {
				res.status(503).json({
					requestId: body.requestId,
					status: "rejected",
					resourceRefs: [],
					errorCode: "provider_capacity",
				});
				return;
			}
			if (definition.classification === "write") {
				const prepared = options.operationReceipts!.prepare({
					...receiptKey,
					inputDigest,
					activationId: body.activationId,
					now: Date.now(),
				});
				if (prepared.disposition !== "prepared") throw denied();
				writeReceipt = options.operationReceipts!.transition({
					...receiptKey,
					inputDigest,
					activationId: body.activationId,
					now: Date.now(),
					from: "prepared",
					to: "dispatched",
				});
			}
			requests.set(key, { digest: inputDigest });
			executing = true;
			const result = await handler.execute(handlerInput, context);
			if (
				result.status === "succeeded" &&
				!definition.outputSchema.safeParse(result.data).success
			)
				throw denied();
			const response = {
				requestId: body.requestId,
				status: result.status,
				resourceRefs: result.providerRef ? [result.providerRef] : [],
				...(result.data ? { data: result.data } : {}),
			};
			if (Buffer.byteLength(JSON.stringify(response)) > 262144) throw denied();
			settleWrite(result);
			requests.set(key, {
				digest: inputDigest,
				result: response,
				settled: true,
			});
			res.json(response);
		} catch {
			const failure = {
				requestId: body.requestId,
				status: executing ? "unknown" : "rejected",
				resourceRefs: [],
				errorCode: executing
					? "provider_outcome_unknown"
					: "discord_scope_denied",
			};
			let settled = definition?.classification === "read";
			if (executing && writeReceipt?.state === "dispatched") {
				try {
					settleWrite({ status: "unknown" });
					settled = true;
				} catch {
					/* Retain the active marker if durable storage fails. */
				}
			}
			if (executing)
				requests.set(key, {
					digest: inputDigest,
					result: failure,
					settled,
				});
			res.status(executing ? 200 : 403).json(failure);
		} finally {
			clearTimeout(timer);
			req.off("aborted", disconnected);
			res.off("close", disconnected);
			outboundSender?.close();
		}
	});
	return router;
}

export function mountLeadCapabilityDiscordProvider(
	app: Application,
	options: LeadCapabilityDiscordOptions,
): void {
	if (!options.apiToken) return;
	app.use(
		"/api/lead-capabilities/discord",
		createLeadCapabilityDiscordRouter(options),
	);
}
