import { createHash, randomUUID } from "node:crypto";
import type {
	ChatThreadContext,
	ChatThreadCreator,
} from "../../bridge/ChatThreadCreator.js";
import { guardChatThreadFetch } from "../../bridge/chat-thread-write-guard.js";
import {
	editDiscordMessageInChannel,
	reactDiscordMessageInChannel,
} from "../../bridge/discord-utils.js";
import type { DiscordFetcher } from "../../bridge/founder-consent/discord-fetch.js";
import { lookupThreadParent } from "../../bridge/thread-validator.js";
import type { CodexOutboundSender } from "../../lead-backends/codex/CodexOutboundSender.js";
import type { LeadOperationContext, LeadOperationHandler } from "../broker.js";
import { getLeadCapability } from "../catalog.js";

export interface DiscordIssueBinding {
	issueId: string;
	projectName: string;
	leadId: string;
	parentId: string;
	threadId: string | null;
	/** Changes whenever the durable issue/department/thread binding changes. */
	revision: string;
}
export interface DiscordCapabilityPolicy {
	botUserId?: string;
	projectName: string;
	leadId: string;
	revision: string;
	parentChannelIds: ReadonlySet<string>;
}
export interface DiscordHandlerOptions {
	threadCreator?: Pick<ChatThreadCreator, "ensureChatThread">;
	/** Canonical issue/owner metadata only. Target identity, name and credentials are pinned separately. */
	createContext?(
		binding: Readonly<DiscordIssueBinding>,
	): Pick<
		ChatThreadContext,
		"issueIdentifier" | "ownerUserId" | "routeSummary" | "modelMarker"
	>;
	messageFetcher?: Pick<DiscordFetcher, "fetchThreadMessages"> &
		Partial<Pick<DiscordFetcher, "fetchMessage">>;
	outboundSender?: Pick<
		CodexOutboundSender,
		"enqueue" | "deliverWithResult" | "getDeliveryStatus"
	>;
	bindingForThread?(threadId: string): DiscordIssueBinding | null;
	/** Durable confirmed-send evidence for this Lead; shared bot authorship alone is insufficient. */
	ownsMessage?(threadId: string, messageId: string): boolean;
	/** Current registry, not an activation-time cached policy. */
	policy(): DiscordCapabilityPolicy;
	/** Current canonical store mapping. No caller-supplied ownership fields. */
	bindingForIssue(issueId: string): DiscordIssueBinding | null;
	/** Reuse current DepartmentRegistry / issue authorization, not name-prefix inference. */
	authorizeIssue(
		binding: Readonly<DiscordIssueBinding>,
		context: LeadOperationContext,
	): Promise<void>;
	/** Captured by the trusted parent; never from a model env or request. */
	botToken(): string;
	/** Existing real REST helper by default. Injection is a trusted test seam. */
	lookupParent?: typeof lookupThreadParent;
}
const snowflake = /^\d{17,20}$/;
const deny = () => new Error("discord_scope_denied");
const bindingDigest = (binding: DiscordIssueBinding) =>
	JSON.stringify([
		binding.issueId,
		binding.projectName,
		binding.leadId,
		binding.parentId,
		binding.threadId,
		binding.revision,
	]);
const policyDigest = (policy: DiscordCapabilityPolicy) =>
	JSON.stringify([
		policy.projectName,
		policy.leadId,
		policy.revision,
		policy.botUserId ?? null,
		[...policy.parentChannelIds].sort(),
	]);
/** Concrete service adapters. Creation requires the existing creator with guards at each actual write and canonical publication. */
export function createDiscordHandlers(
	options: DiscordHandlerOptions,
): ReadonlyMap<string, LeadOperationHandler> {
	const definition = getLeadCapability("discord.thread.resolve")!;
	async function resolve(
		raw: Record<string, unknown>,
		context: LeadOperationContext,
		probe = true,
	) {
		const parsed = definition.inputSchema.safeParse(raw);
		if (!parsed.success) throw deny();
		const issueId = parsed.data.issueId as string;
		const initial = options.bindingForIssue(issueId);
		const policy = options.policy();
		if (!initial) throw deny();
		const binding = Object.freeze({ ...initial });
		const expectedBinding = bindingDigest(binding),
			expectedPolicy = policyDigest(policy);
		function assertScope() {
			const currentPolicy = options.policy(),
				currentBinding = options.bindingForIssue(issueId);
			if (
				!currentBinding ||
				!currentBinding.revision ||
				!currentPolicy.revision ||
				policyDigest(currentPolicy) !== expectedPolicy ||
				bindingDigest(currentBinding) !== expectedBinding ||
				currentPolicy.projectName !== context.projectName ||
				currentPolicy.leadId !== context.leadId ||
				binding.issueId !== issueId ||
				binding.projectName !== context.projectName ||
				binding.leadId !== context.leadId ||
				!currentPolicy.parentChannelIds.has(binding.parentId) ||
				!snowflake.test(binding.parentId) ||
				!binding.threadId ||
				!snowflake.test(binding.threadId)
			)
				throw deny();
		}
		async function current() {
			if (context.signal.aborted) throw new Error("discord_operation_aborted");
			assertScope();
			try {
				await context.assertCurrent();
			} catch {
				throw new Error("discord_activation_not_current");
			}
			if (context.signal.aborted) throw new Error("discord_operation_aborted");
			assertScope();
		}
		await current();
		try {
			await options.authorizeIssue(binding, context);
		} catch {
			throw deny();
		}
		await current();
		if (!probe) return { binding, current, assertScope };
		let token: string;
		try {
			token = options.botToken();
			if (!token.trim()) throw deny();
		} catch {
			throw new Error("discord_credentials_unavailable");
		}
		// No await between the final local scope check and the provider request.
		assertScope();
		let parent: Awaited<ReturnType<typeof lookupThreadParent>>;
		try {
			parent = await (options.lookupParent ?? lookupThreadParent)(
				binding.threadId!,
				token,
			);
		} catch {
			throw new Error("discord_thread_unverified");
		}
		await current();
		if (parent.state !== "resolved")
			throw new Error("discord_thread_unverified");
		if (parent.parentId !== binding.parentId) throw deny();
		return { binding, current, assertScope };
	}
	const handler: LeadOperationHandler = {
		authorize: async (raw, context) => {
			await resolve(raw, context);
		},
		execute: async (raw, context) => {
			const { binding } = await resolve(raw, context);
			const data = {
				threadId: binding.threadId!,
				parentId: binding.parentId,
				receiptId: randomUUID(),
				observedAt: new Date().toISOString(),
			};
			definition.outputSchema.parse(data);
			return {
				status: "succeeded",
				providerRef: `discord-thread:${binding.threadId}`,
				data,
			};
		},
	};
	const handlers = new Map([[definition.operationId, handler]]);
	if (options.messageFetcher) {
		const fetcher = options.messageFetcher,
			lookup = options.bindingForThread;
		if (!lookup) throw new Error("discord_read_binding_required");
		const readDefinition = getLeadCapability("discord.thread.read")!;
		async function readTarget(
			raw: Record<string, unknown>,
			context: LeadOperationContext,
		) {
			const parsed = readDefinition.inputSchema.safeParse(raw);
			if (!parsed.success) throw deny();
			const input = parsed.data,
				threadId = input.threadId as string,
				cursor = input.cursor as string | undefined;
			if (cursor !== undefined && !/^[0-9]{1,20}$/.test(cursor)) throw deny();
			const initial = lookup!(threadId);
			if (!initial || initial.threadId !== threadId) throw deny();
			const expected = bindingDigest(initial);
			const check = () => {
				const binding = lookup!(threadId);
				if (!binding || bindingDigest(binding) !== expected) throw deny();
			};
			const scoped = await resolve({ issueId: initial.issueId }, context);
			check();
			if (bindingDigest(scoped.binding) !== expected) throw deny();
			return { input, threadId, cursor, scoped, check };
		}
		handlers.set(readDefinition.operationId, {
			authorize: async (raw, context) => {
				await readTarget(raw, context);
			},
			execute: async (raw, context) => {
				const { input, threadId, cursor, scoped, check } = await readTarget(
					raw,
					context,
				);
				const limit = (input.limit as number | undefined) ?? 50;
				await scoped.current();
				check();
				let rows: Awaited<ReturnType<DiscordFetcher["fetchThreadMessages"]>>;
				try {
					rows = await fetcher.fetchThreadMessages(threadId, limit, {
						...(cursor !== undefined ? { before: cursor } : {}),
						signal: context.signal,
					});
				} catch {
					throw new Error("discord_messages_unverified");
				}
				await scoped.current();
				check();
				let previous = cursor === undefined ? null : BigInt(cursor);
				if (rows.length > limit) throw new Error("discord_messages_invalid");
				const messages = rows.map((row) => {
					if (
						!/^[0-9]{1,20}$/.test(row.id) ||
						!snowflake.test(row.authorId) ||
						!Number.isFinite(Date.parse(row.ts))
					)
						throw new Error("discord_messages_invalid");
					const id = BigInt(row.id);
					if (previous !== null && id >= previous)
						throw new Error("discord_messages_invalid");
					previous = id;
					return {
						messageId: row.id,
						authorId: row.authorId,
						text: row.content,
						createdAt: new Date(row.ts).toISOString(),
					};
				});
				const data = {
					threadId,
					messages,
					nextCursor: rows.length === limit ? rows.at(-1)!.id : null,
					receiptId: randomUUID(),
					observedAt: new Date().toISOString(),
				};
				if (!readDefinition.outputSchema.safeParse(data).success)
					throw new Error("discord_messages_invalid");
				return {
					status: "succeeded",
					providerRef: `discord-thread:${threadId}`,
					data,
				};
			},
		});
	}
	if (options.threadCreator) {
		const creator = options.threadCreator,
			metadata = options.createContext;
		if (!metadata) throw new Error("discord_create_context_required");
		const createDefinition = getLeadCapability("discord.thread.create")!;
		async function createTarget(
			raw: Record<string, unknown>,
			context: LeadOperationContext,
		) {
			const parsed = createDefinition.inputSchema.safeParse(raw);
			if (!parsed.success) throw deny();
			const input = parsed.data,
				issueId = input.issueId as string;
			const initial = options.bindingForIssue(issueId);
			if (!initial) throw deny();
			let expected = Object.freeze({ ...initial }),
				published = false;
			const expectedPolicy = policyDigest(options.policy());
			function routing() {
				const policy = options.policy(),
					binding = options.bindingForIssue(issueId);
				if (context.signal.aborted)
					throw new Error("discord_operation_aborted");
				if (
					!binding ||
					!binding.revision ||
					!policy.revision ||
					policyDigest(policy) !== expectedPolicy ||
					policy.projectName !== context.projectName ||
					policy.leadId !== context.leadId ||
					binding.issueId !== issueId ||
					binding.projectName !== context.projectName ||
					binding.leadId !== context.leadId ||
					binding.parentId !== input.parentId ||
					binding.parentId !== initial!.parentId ||
					!policy.parentChannelIds.has(binding.parentId) ||
					!snowflake.test(binding.parentId) ||
					(binding.threadId !== null && !snowflake.test(binding.threadId))
				)
					throw deny();
				return binding;
			}
			function assertScope() {
				if (bindingDigest(routing()) !== bindingDigest(expected)) throw deny();
			}
			async function current() {
				assertScope();
				try {
					await context.assertCurrent();
				} catch {
					throw new Error("discord_activation_not_current");
				}
				assertScope();
			}
			await current();
			try {
				await options.authorizeIssue(expected, context);
			} catch {
				throw deny();
			}
			await current();
			if (expected.threadId) {
				await resolve({ issueId }, context);
				await current();
			}
			function publishedRoot(threadId: string) {
				const binding = routing();
				if (
					published ||
					expected.threadId !== null ||
					!snowflake.test(threadId) ||
					binding.threadId !== threadId ||
					binding.revision === expected.revision
				)
					throw deny();
				// This observer runs only synchronously after this creator's successful CAS.
				// A competing publication cannot advance expected outside this hook.
				expected = Object.freeze({ ...binding });
				published = true;
			}
			return {
				input,
				initial: expected,
				current,
				assertScope,
				publishedRoot,
				binding: () => expected,
			};
		}
		handlers.set(createDefinition.operationId, {
			authorize: async (raw, context) => {
				await createTarget(raw, context);
			},
			execute: async (raw, context) => {
				const target = await createTarget(raw, context);
				if (target.initial.threadId) {
					// createTarget already verifies the live canonical thread and owner.
					// Reusing it must not trigger the legacy creator's rename/notification path.
					await target.current();
					return {
						status: "succeeded",
						providerRef: `discord-thread:${target.initial.threadId}`,
						data: {
							threadId: target.initial.threadId,
							parentId: target.initial.parentId,
							receiptId: randomUUID(),
							observedAt: new Date().toISOString(),
						},
					};
				}
				let source: ReturnType<
						NonNullable<DiscordHandlerOptions["createContext"]>
					>,
					token: string;
				try {
					source = metadata!(target.initial);
					token = options.botToken();
					if (!token.trim()) throw deny();
				} catch {
					throw new Error("discord_create_context_unavailable");
				}
				const creatorContext: ChatThreadContext = {
					issueId: target.initial.issueId,
					chatChannelId: target.initial.parentId,
					leadId: context.leadId,
					botToken: token,
					issueTitle: target.input.name as string,
					issueIdentifier: source.issueIdentifier,
					ownerUserId: source.ownerUserId,
					routeSummary: source.routeSummary,
					modelMarker: source.modelMarker,
					beforeSideEffect: target.current,
					assertSideEffectCurrent: target.assertScope,
					onCanonicalThreadRegistered: target.publishedRoot,
					signal: context.signal,
				};
				await target.current();
				target.assertScope();
				try {
					const result = await creator.ensureChatThread(creatorContext);
					if (
						result.error ||
						result.errorCode ||
						!result.threadId ||
						!snowflake.test(result.threadId)
					)
						return { status: "unknown" };
					await target.current();
					if (target.binding().threadId !== result.threadId)
						return { status: "unknown" };
					const verified = await resolve(
						{ issueId: target.initial.issueId },
						context,
					);
					await target.current();
					if (verified.binding.threadId !== result.threadId)
						return { status: "unknown" };
					const data = {
						threadId: result.threadId,
						parentId: target.initial.parentId,
						receiptId: randomUUID(),
						observedAt: new Date().toISOString(),
					};
					createDefinition.outputSchema.parse(data);
					return {
						status: "succeeded",
						providerRef: `discord-thread:${result.threadId}`,
						data,
					};
				} catch {
					return { status: "unknown" };
				}
			},
		});
	}
	if (options.outboundSender) {
		const sender = options.outboundSender,
			fetcher = options.messageFetcher,
			lookup = options.bindingForThread;
		if (!lookup || !fetcher?.fetchMessage)
			throw new Error("discord_reply_dependencies_required");
		const replyDefinition = getLeadCapability("discord.thread.reply")!;
		async function replyTarget(
			raw: Record<string, unknown>,
			context: LeadOperationContext,
			probe = true,
		) {
			const parsed = replyDefinition.inputSchema.safeParse(raw);
			if (!parsed.success) throw deny();
			const input = parsed.data,
				threadId = input.threadId as string,
				replyTo = input.replyTo as string | undefined;
			if (
				!snowflake.test(threadId) ||
				(replyTo !== undefined && !snowflake.test(replyTo))
			)
				throw deny();
			const initial = lookup!(threadId);
			if (!initial || initial.threadId !== threadId) throw deny();
			const expectedBinding = bindingDigest(initial);
			const scoped = await resolve(
				{ issueId: initial.issueId },
				context,
				probe,
			);
			function assertScope() {
				scoped.assertScope();
				const binding = lookup!(threadId);
				if (
					!binding ||
					bindingDigest(binding) !== expectedBinding ||
					bindingDigest(scoped.binding) !== expectedBinding
				)
					throw deny();
			}
			async function current() {
				await scoped.current();
				assertScope();
			}
			await current();
			if (probe && replyTo !== undefined) {
				let message: Awaited<ReturnType<DiscordFetcher["fetchMessage"]>>;
				try {
					message = await fetcher!.fetchMessage!(threadId, replyTo, {
						signal: context.signal,
					});
				} catch {
					throw new Error("discord_reply_target_unverified");
				}
				await current();
				if (!message || message.id !== replyTo) throw deny();
			}
			const expected = {
				leadId: context.leadId,
				channelId: threadId,
				text: input.text as string,
				...(context.deliveryContext
					? { deliveryContext: context.deliveryContext }
					: {}),
				...(replyTo !== undefined ? { replyTo } : {}),
			};
			const key = createHash("sha256")
				.update(
					JSON.stringify([
						context.projectName,
						context.leadId,
						threadId,
						replyDefinition.operationId,
						(input.eventId as string | undefined) ?? context.requestId,
						...(context.deliveryContext ? [context.deliveryContext] : []),
					]),
				)
				.digest("hex");
			return { threadId, current, assertScope, expected, key };
		}
		const success = (threadId: string, messageId: string) => ({
			status: "succeeded" as const,
			providerRef: `discord-message:${messageId}`,
			data: {
				threadId,
				messageId,
				receiptId: randomUUID(),
				observedAt: new Date().toISOString(),
			},
		});
		handlers.set(replyDefinition.operationId, {
			authorize: async (raw, context) => {
				await replyTarget(raw, context);
			},
			execute: async (raw, context) => {
				const target = await replyTarget(raw, context);
				await target.current();
				target.assertScope();
				try {
					const outboxId = await sender.enqueue({
						...target.expected,
						idempotencyKey: target.key,
					});
					await target.current();
					if (outboxId !== target.key) return { status: "unknown" };
					target.assertScope();
					const result = await sender.deliverWithResult(outboxId, {
						beforeSideEffect: target.current,
						assertSideEffectCurrent: target.assertScope,
						signal: context.signal,
					});
					await target.current();
					if (!result.messageId || !snowflake.test(result.messageId))
						return { status: "unknown" };
					return success(target.threadId, result.messageId);
				} catch {
					return { status: "unknown" };
				}
			},
			reconcile: async (receipt, raw, context) => {
				if (
					receipt.projectName !== context.projectName ||
					receipt.leadId !== context.leadId ||
					receipt.operationId !== replyDefinition.operationId ||
					receipt.requestId !== context.requestId
				)
					return { status: "unknown" };
				const target = await replyTarget(raw, context, false);
				await target.current();
				target.assertScope();
				try {
					const status = sender.getDeliveryStatus(target.key, target.expected);
					await target.current();
					if (
						status?.status !== "sent" ||
						!status.messageId ||
						!snowflake.test(status.messageId)
					)
						return { status: "unknown" };
					return success(target.threadId, status.messageId);
				} catch {
					return { status: "unknown" };
				}
			},
		});
	}
	if (options.messageFetcher?.fetchMessage && options.bindingForThread) {
		for (const operation of [
			"discord.message.edit",
			"discord.message.react",
		] as const) {
			const isEdit = operation === "discord.message.edit";
			if (isEdit && !options.policy().botUserId) continue;
			const fetcher = options.messageFetcher,
				lookup = options.bindingForThread;
			const messageDefinition = getLeadCapability(operation)!;
			async function messageTarget(
				raw: Record<string, unknown>,
				context: LeadOperationContext,
			) {
				const parsed = messageDefinition.inputSchema.safeParse(raw);
				if (!parsed.success) throw deny();
				const input = parsed.data,
					threadId = input.threadId as string,
					messageId = input.messageId as string;
				if (isEdit && (input.text as string).length > 2000) throw deny();
				if (!isEdit) {
					const emoji = input.emoji as string;
					if (
						!emoji.trim() ||
						[...emoji].some(
							(c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
						)
					)
						throw deny();
				}
				if (!snowflake.test(threadId) || !snowflake.test(messageId))
					throw deny();
				const initial = lookup!(threadId);
				if (!initial || initial.threadId !== threadId) throw deny();
				const expected = bindingDigest(initial);
				const scoped = await resolve({ issueId: initial.issueId }, context);
				function assertScope() {
					scoped.assertScope();
					if (isEdit && !options.ownsMessage?.(threadId, messageId))
						throw deny();
					const binding = lookup!(threadId);
					if (
						!binding ||
						bindingDigest(binding) !== expected ||
						bindingDigest(scoped.binding) !== expected
					)
						throw deny();
				}
				async function current() {
					await scoped.current();
					assertScope();
				}
				await current();
				let message: Awaited<ReturnType<DiscordFetcher["fetchMessage"]>>;
				try {
					message = await fetcher.fetchMessage!(threadId, messageId, {
						signal: context.signal,
					});
				} catch {
					throw new Error("discord_message_unverified");
				}
				await current();
				const botUserId = options.policy().botUserId;
				if (
					!message ||
					message.id !== messageId ||
					(isEdit &&
						(!botUserId ||
							!snowflake.test(botUserId) ||
							message.authorId !== botUserId))
				)
					throw deny();
				return { input, threadId, messageId, current, assertScope };
			}
			handlers.set(messageDefinition.operationId, {
				authorize: async (raw, context) => {
					await messageTarget(raw, context);
				},
				execute: async (raw, context) => {
					const target = await messageTarget(raw, context);
					await target.current();
					target.assertScope();
					try {
						const guardedFetch = guardChatThreadFetch({
							beforeSideEffect: target.current,
							assertSideEffectCurrent: target.assertScope,
							signal: context.signal,
						});
						const result = isEdit
							? await editDiscordMessageInChannel(
									target.threadId,
									target.messageId,
									target.input.text as string,
									options.botToken(),
									{ origin: "lead_authored", signal: context.signal },
									guardedFetch,
								)
							: await reactDiscordMessageInChannel(
									target.threadId,
									target.messageId,
									target.input.emoji as string,
									options.botToken(),
									{ signal: context.signal },
									guardedFetch,
								);
						await target.current();
						if (!result.ok) return { status: "unknown" };
						return {
							status: "succeeded",
							providerRef: `discord-message:${target.messageId}`,
							data: {
								messageId: target.messageId,
								receiptId: randomUUID(),
								observedAt: new Date().toISOString(),
							},
						};
					} catch {
						return { status: "unknown" };
					}
				},
			});
		}
	}
	return handlers;
}
