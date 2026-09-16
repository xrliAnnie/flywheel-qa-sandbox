import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ChatThreadCreator } from "../../bridge/ChatThreadCreator.js";
import { DiscordFetcher } from "../../bridge/founder-consent/discord-fetch.js";
import { InMemoryOutboundDedupStore } from "../../lead-backends/codex/CodexLeadOutboundHandler.js";
import type { CodexOutboundSender } from "../../lead-backends/codex/CodexOutboundSender.js";
import { createBrokerDiscordOutboundSender } from "../../lead-backends/codex/capability-outbound.js";
import { StateStore } from "../../StateStore.js";
import type { LeadOperationContext } from "../broker.js";
import { getLeadCapability } from "../catalog.js";
import {
	createDiscordHandlers,
	type DiscordCapabilityPolicy,
	type DiscordHandlerOptions,
	type DiscordIssueBinding,
} from "../handlers/discord.js";

function fixture(
	defaultLookup = false,
	withReader = false,
	withCreator = false,
	withSender = false,
) {
	let policy: DiscordCapabilityPolicy = {
		projectName: "flywheel",
		leadId: "flywheel-product-lead",
		revision: "p1",
		parentChannelIds: new Set(["111111111111111111"]),
	};
	let binding: DiscordIssueBinding | null = {
		issueId: "FLY-2519",
		projectName: "flywheel",
		leadId: "flywheel-product-lead",
		parentId: "111111111111111111",
		threadId: "222222222222222222",
		revision: "b1",
	};
	const lookupParent = vi
		.fn<NonNullable<DiscordHandlerOptions["lookupParent"]>>()
		.mockResolvedValue({ state: "resolved", parentId: "111111111111111111" });
	const authorizeIssue = vi.fn(async () => {});
	const controller = new AbortController();
	const context: LeadOperationContext = {
		projectName: "flywheel",
		leadId: "flywheel-product-lead",
		activationId: "a1",
		requestId: "55555555-5555-4555-8555-555555555555",
		signal: controller.signal,
		assertCurrent: vi.fn(async () => {}),
	};
	const fetchThreadMessages = vi
		.fn<DiscordFetcher["fetchThreadMessages"]>()
		.mockResolvedValue([
			{
				id: "999999999999999999",
				authorId: "333333333333333333",
				content: "hello",
				ts: "2026-09-13T00:00:00+00:00",
				isBot: false,
			},
		]);
	const ensureChatThread = vi
		.fn<ChatThreadCreator["ensureChatThread"]>()
		.mockImplementation(async (ctx) => {
			await ctx.beforeSideEffect?.();
			ctx.assertSideEffectCurrent?.();
			binding = { ...binding!, threadId: "222222222222222222", revision: "b2" };
			ctx.onCanonicalThreadRegistered?.("222222222222222222");
			await ctx.beforeSideEffect?.();
			ctx.assertSideEffectCurrent?.();
			return { created: true, threadId: "222222222222222222" };
		});
	const fetchMessage = vi
		.fn<DiscordFetcher["fetchMessage"]>()
		.mockResolvedValue({
			id: "777777777777777777",
			authorId: "333333333333333333",
			content: "earlier",
			ts: "2026-09-13T00:00:00.000Z",
			isBot: false,
		});
	const enqueue = vi
		.fn<CodexOutboundSender["enqueue"]>()
		.mockImplementation(async (args) => args.idempotencyKey);
	const deliverWithResult = vi
		.fn<CodexOutboundSender["deliverWithResult"]>()
		.mockResolvedValue({ messageId: "444444444444444444", deduped: false });
	const getDeliveryStatus = vi
		.fn<CodexOutboundSender["getDeliveryStatus"]>()
		.mockReturnValue({ status: "sent", messageId: "444444444444444444" });
	const handlers = createDiscordHandlers({
		...(withSender
			? { outboundSender: { enqueue, deliverWithResult, getDeliveryStatus } }
			: {}),
		...(withCreator
			? {
					threadCreator: { ensureChatThread },
					createContext: () => ({
						issueIdentifier: "FLY-2519",
						ownerUserId: "333333333333333333",
					}),
				}
			: {}),
		...(withReader || withSender
			? {
					messageFetcher: { fetchThreadMessages, fetchMessage },
					bindingForThread: () => binding,
				}
			: {}),
		policy: () => policy,
		bindingForIssue: () => binding,
		authorizeIssue,
		botToken: () => "CREDENTIAL_CANARY",
		lookupParent: defaultLookup ? undefined : lookupParent,
	});
	return {
		context,
		fetchThreadMessages,
		fetchMessage,
		enqueue,
		deliverWithResult,
		getDeliveryStatus,
		ensureChatThread,
		handlers,
		lookupParent,
		authorizeIssue,
		controller,
		setBinding: (b: DiscordIssueBinding | null) => {
			binding = b;
		},
		binding: () => binding!,
		setPolicy: (p: DiscordCapabilityPolicy) => {
			policy = p;
		},
		policy: () => policy,
	};
}
const input = { issueId: "FLY-2519" };
describe("Discord canonical thread resolve", () => {
	it("checks canonical ownership and actual parent, returning only catalog evidence", async () => {
		const f = fixture(),
			handler = f.handlers.get("discord.thread.resolve")!;
		await handler.authorize(input, f.context);
		const outcome = await handler.execute(input, f.context);
		expect(outcome.status).toBe("succeeded");
		expect(outcome.providerRef).toBe("discord-thread:222222222222222222");
		expect(
			getLeadCapability("discord.thread.resolve")!.outputSchema.safeParse(
				outcome.data,
			).success,
		).toBe(true);
		expect(f.lookupParent).toHaveBeenCalledTimes(2);
		expect(f.authorizeIssue).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(outcome)).not.toContain("CREDENTIAL_CANARY");
		expect([...f.handlers.keys()]).toEqual(["discord.thread.resolve"]);
	});
	it.each(["projectName", "leadId", "parentId"] as const)(
		"denies foreign %s before any Discord request in authorize and execute",
		async (key) => {
			const f = fixture();
			f.setBinding({ ...f.binding(), [key]: "foreign" });
			const handler = f.handlers.get("discord.thread.resolve")!;
			await expect(handler.authorize(input, f.context)).rejects.toThrow(
				"discord_scope_denied",
			);
			await expect(handler.execute(input, f.context)).rejects.toThrow(
				"discord_scope_denied",
			);
			expect(f.lookupParent).not.toHaveBeenCalled();
		},
	);
	it("does not treat unknown canonical mapping as an empty successful result", async () => {
		const f = fixture();
		f.setBinding(null);
		await expect(
			f.handlers.get("discord.thread.resolve")!.execute(input, f.context),
		).rejects.toThrow("discord_scope_denied");
		expect(f.lookupParent).not.toHaveBeenCalled();
	});
	it("rechecks current binding after department authorization awaits", async () => {
		const f = fixture();
		f.authorizeIssue.mockImplementation(async () => {
			f.setBinding({ ...f.binding(), revision: "b2" });
		});
		await expect(
			f.handlers.get("discord.thread.resolve")!.execute(input, f.context),
		).rejects.toThrow("discord_scope_denied");
		expect(f.lookupParent).not.toHaveBeenCalled();
	});
	it("revocation during parent lookup prevents returning thread evidence", async () => {
		const f = fixture();
		f.lookupParent.mockImplementation(async () => {
			f.setPolicy({
				...f.policy(),
				revision: "p2",
				parentChannelIds: new Set(),
			});
			return { state: "resolved", parentId: "111111111111111111" };
		});
		await expect(
			f.handlers.get("discord.thread.resolve")!.execute(input, f.context),
		).rejects.toThrow("discord_scope_denied");
	});
	it("foreign actual Discord parent fails closed", async () => {
		const f = fixture();
		f.lookupParent.mockResolvedValue({
			state: "resolved",
			parentId: "999999999999999999",
		});
		await expect(
			f.handlers.get("discord.thread.resolve")!.authorize(input, f.context),
		).rejects.toThrow("discord_scope_denied");
	});
	it("stale context and aborted operation never return successful evidence", async () => {
		const f = fixture();
		f.controller.abort();
		await expect(
			f.handlers.get("discord.thread.resolve")!.execute(input, f.context),
		).rejects.toThrow("discord_operation_aborted");
		expect(f.lookupParent).not.toHaveBeenCalled();
	});
	it("provider exceptions are reduced to stable errors", async () => {
		const f = fixture();
		f.lookupParent.mockRejectedValue(new Error("CREDENTIAL_CANARY"));
		await expect(
			f.handlers.get("discord.thread.resolve")!.execute(input, f.context),
		).rejects.toThrow("discord_thread_unverified");
	});
});

it("uses the existing real parent lookup helper by default with a fixed Discord endpoint", async () => {
	const fetch = vi
		.spyOn(globalThis, "fetch")
		.mockResolvedValue(
			new Response(
				JSON.stringify({ type: 11, parent_id: "111111111111111111" }),
				{ status: 200 },
			),
		);
	try {
		const f = fixture(true);
		const result = await f.handlers
			.get("discord.thread.resolve")!
			.execute(input, f.context);
		expect(result.status).toBe("succeeded");
		expect(fetch).toHaveBeenCalledOnce();
		expect(fetch.mock.calls[0][0]).toBe(
			"https://discord.com/api/v10/channels/222222222222222222",
		);
		expect(fetch.mock.calls[0][1]?.headers).toEqual({
			Authorization: "Bot CREDENTIAL_CANARY",
		});
		expect(JSON.stringify(result)).not.toContain("CREDENTIAL_CANARY");
	} finally {
		fetch.mockRestore();
	}
});
it.each(["absent", "not_thread", "transient"] as const)(
	"keeps %s parent evidence unverified",
	async (state) => {
		const f = fixture();
		f.lookupParent.mockResolvedValue({ state });
		await expect(
			f.handlers.get("discord.thread.resolve")!.execute(input, f.context),
		).rejects.toThrow("discord_thread_unverified");
	},
);
it("rechecks activation after a successful provider response", async () => {
	const f = fixture();
	let valid = true;
	f.context.assertCurrent = async () => {
		if (!valid) throw new Error("stale");
	};
	f.lookupParent.mockImplementation(async () => {
		valid = false;
		return { state: "resolved", parentId: "111111111111111111" };
	});
	await expect(
		f.handlers.get("discord.thread.resolve")!.execute(input, f.context),
	).rejects.toThrow("discord_activation_not_current");
});

describe("Discord canonical thread read", () => {
	it("uses the existing typed fetcher with bounded before cursor and signal", async () => {
		const f = fixture(false, true),
			handler = f.handlers.get("discord.thread.read");
		expect(handler).toBeDefined();
		const input = {
			threadId: "222222222222222222",
			cursor: "1000000000000000000",
			limit: 1,
		};
		await handler!.authorize(input, f.context);
		expect(f.fetchThreadMessages).not.toHaveBeenCalled();
		const result = await handler!.execute(input, f.context);
		expect(f.fetchThreadMessages).toHaveBeenCalledExactlyOnceWith(
			input.threadId,
			1,
			{ before: input.cursor, signal: f.context.signal },
		);
		expect(result.data).toMatchObject({
			threadId: input.threadId,
			nextCursor: "999999999999999999",
			messages: [
				{
					messageId: "999999999999999999",
					authorId: "333333333333333333",
					text: "hello",
					createdAt: "2026-09-13T00:00:00.000Z",
				},
			],
		});
	});
	it("refuses foreign thread mappings before fetching content", async () => {
		const f = fixture(false, true);
		f.setBinding({ ...f.binding(), threadId: "666666666666666666" });
		await expect(
			f.handlers
				.get("discord.thread.read")!
				.execute({ threadId: "222222222222222222" }, f.context),
		).rejects.toThrow("discord_scope_denied");
		expect(f.fetchThreadMessages).not.toHaveBeenCalled();
	});
	it("refuses malformed cursors before any provider read", async () => {
		const f = fixture(false, true);
		await expect(
			f.handlers
				.get("discord.thread.read")!
				.authorize(
					{ threadId: "222222222222222222", cursor: "https://foreign" },
					f.context,
				),
		).rejects.toThrow("discord_scope_denied");
		expect(f.lookupParent).not.toHaveBeenCalled();
		expect(f.fetchThreadMessages).not.toHaveBeenCalled();
	});
	it("does not release content when ownership changes during the fetch", async () => {
		const f = fixture(false, true);
		f.fetchThreadMessages.mockImplementation(async () => {
			f.setBinding({ ...f.binding(), leadId: "foreign" });
			return [];
		});
		await expect(
			f.handlers
				.get("discord.thread.read")!
				.execute({ threadId: "222222222222222222" }, f.context),
		).rejects.toThrow("discord_scope_denied");
	});
	it("rejects an unordered or non-advancing page instead of inventing pagination", async () => {
		const f = fixture(false, true);
		await expect(
			f.handlers
				.get("discord.thread.read")!
				.execute(
					{ threadId: "222222222222222222", cursor: "888888888888888888" },
					f.context,
				),
		).rejects.toThrow("discord_messages_invalid");
	});
});

const createInput = {
	issueId: "FLY-2519",
	parentId: "111111111111111111",
	name: "Review report",
};
describe("Discord guarded thread create", () => {
	it("adopts only its exact synchronous canonical publication and maps all requested fields", async () => {
		const f = fixture(false, false, true);
		f.setBinding({ ...f.binding(), threadId: null });
		const handler = f.handlers.get("discord.thread.create");
		expect(handler).toBeDefined();
		await handler!.authorize(createInput, f.context);
		expect(f.ensureChatThread).not.toHaveBeenCalled();
		const result = await handler!.execute(createInput, f.context);
		expect(result).toMatchObject({
			status: "succeeded",
			providerRef: "discord-thread:222222222222222222",
			data: { threadId: "222222222222222222", parentId: createInput.parentId },
		});
		expect(f.ensureChatThread.mock.calls[0][0]).toMatchObject({
			issueId: createInput.issueId,
			chatChannelId: createInput.parentId,
			issueTitle: createInput.name,
			issueIdentifier: "FLY-2519",
			leadId: f.context.leadId,
			botToken: "CREDENTIAL_CANARY",
			signal: f.context.signal,
		});
		expect(JSON.stringify(result)).not.toContain("CREDENTIAL_CANARY");
	});
	it("rejects a model-supplied foreign parent before creator dispatch", async () => {
		const f = fixture(false, false, true);
		await expect(
			f.handlers
				.get("discord.thread.create")!
				.authorize(
					{ ...createInput, parentId: "999999999999999999" },
					f.context,
				),
		).rejects.toThrow("discord_scope_denied");
		expect(f.ensureChatThread).not.toHaveBeenCalled();
	});
	it("refuses unrelated publication without the synchronous own-CAS observer", async () => {
		const f = fixture(false, false, true);
		f.setBinding({ ...f.binding(), threadId: null });
		let writes = 0;
		f.ensureChatThread.mockImplementation(async (ctx) => {
			await ctx.beforeSideEffect?.();
			ctx.assertSideEffectCurrent?.();
			writes++;
			f.setBinding({
				...f.binding(),
				threadId: "999999999999999999",
				revision: "b2",
			});
			await ctx.beforeSideEffect?.();
			ctx.assertSideEffectCurrent?.();
			writes++;
			return { created: true, threadId: "999999999999999999" };
		});
		expect(
			(
				await f.handlers
					.get("discord.thread.create")!
					.execute(createInput, f.context)
			).status,
		).toBe("unknown");
		expect(writes).toBe(1);
	});
	it("observer rejects a root that does not match the actual canonical publication", async () => {
		const f = fixture(false, false, true);
		f.setBinding({ ...f.binding(), threadId: null });
		f.ensureChatThread.mockImplementation(async (ctx) => {
			f.setBinding({
				...f.binding(),
				threadId: "999999999999999999",
				revision: "b2",
			});
			ctx.onCanonicalThreadRegistered?.("222222222222222222");
			return { created: true, threadId: "222222222222222222" };
		});
		expect(
			(
				await f.handlers
					.get("discord.thread.create")!
					.execute(createInput, f.context)
			).status,
		).toBe("unknown");
	});
	it("observer never adopts changed department ownership", async () => {
		const f = fixture(false, false, true);
		f.setBinding({ ...f.binding(), threadId: null });
		f.ensureChatThread.mockImplementation(async (ctx) => {
			f.setBinding({
				...f.binding(),
				threadId: "222222222222222222",
				leadId: "foreign",
				revision: "b2",
			});
			ctx.onCanonicalThreadRegistered?.("222222222222222222");
			return { created: true, threadId: "222222222222222222" };
		});
		expect(
			(
				await f.handlers
					.get("discord.thread.create")!
					.execute(createInput, f.context)
			).status,
		).toBe("unknown");
	});
	it("retains unknown creation results without raw errors or automatic retries", async () => {
		const f = fixture(false, false, true);
		f.setBinding({ ...f.binding(), threadId: null });
		f.ensureChatThread.mockResolvedValue({
			created: false,
			error: "CREDENTIAL_CANARY",
			errorCode: "thread_start_uncertain",
			rootMessageId: "222222222222222222",
		});
		const result = await f.handlers
			.get("discord.thread.create")!
			.execute(createInput, f.context);
		expect(result).toEqual({ status: "unknown" });
		expect(f.ensureChatThread).toHaveBeenCalledOnce();
	});
});

it.each([false, true])(
	"real creator enforces handler guards across root POST and canonical publication; revoke=%s",
	async (revoke) => {
		const store = await StateStore.create(":memory:");
		let revoked = false;
		const threadId = "222222222222222222",
			parentId = "111111111111111111",
			leadId = "flywheel-product-lead";
		const posts: string[] = [];
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (url, init) => {
				if (init?.method === "POST") {
					posts.push(String(url));
					if (revoke) revoked = true;
				}
				return new Response(
					JSON.stringify({ id: threadId, type: 11, parent_id: parentId }),
					{ status: 200 },
				);
			});
		try {
			const binding = (): DiscordIssueBinding => {
				const row = store.getChatThreadByIssue("FLY-2519", parentId);
				return {
					issueId: "FLY-2519",
					projectName: "flywheel",
					leadId: row?.lead_id ?? leadId,
					parentId,
					threadId: row?.thread_id ?? null,
					revision: row ? `mapped:${row.thread_id}` : "empty",
				};
			};
			const context: LeadOperationContext = {
				projectName: "flywheel",
				leadId,
				activationId: "a1",
				requestId: "55555555-5555-4555-8555-555555555555",
				signal: new AbortController().signal,
				assertCurrent: async () => {
					if (revoked) throw new Error("stale");
				},
			};
			const handler = createDiscordHandlers({
				policy: () => ({
					projectName: "flywheel",
					leadId,
					revision: revoked ? "p2" : "p1",
					parentChannelIds: new Set([parentId]),
				}),
				bindingForIssue: binding,
				authorizeIssue: async () => {},
				botToken: () => "CREDENTIAL_CANARY",
				threadCreator: new ChatThreadCreator(store),
				createContext: () => ({ issueIdentifier: "FLY-2519" }),
			}).get("discord.thread.create")!;
			await handler.authorize(createInput, context);
			const result = await handler.execute(createInput, context);
			expect(result.status).toBe(revoke ? "unknown" : "succeeded");
			expect(posts).toHaveLength(revoke ? 1 : 2);
			expect(binding().threadId).toBe(revoke ? null : threadId);
			if (!revoke) {
				const before = fetch.mock.calls.filter(
					([, init]) => init?.method && init.method !== "GET",
				).length;
				expect(
					(
						await handler.execute(
							{ ...createInput, name: "Do not rename existing thread" },
							{ ...context, requestId: "66666666-6666-4666-8666-666666666666" },
						)
					).status,
				).toBe("succeeded");
				expect(
					fetch.mock.calls.filter(
						([, init]) => init?.method && init.method !== "GET",
					),
				).toHaveLength(before);
			}

			expect(JSON.stringify(result)).not.toContain("CREDENTIAL_CANARY");
		} finally {
			fetch.mockRestore();
			store.close();
		}
	},
);

const replyInput = {
	threadId: "222222222222222222",
	text: "A scoped reply",
	replyTo: "777777777777777777",
	eventId: "same-event",
};
const replyKey = () =>
	createHash("sha256")
		.update(
			JSON.stringify([
				"flywheel",
				"flywheel-product-lead",
				replyInput.threadId,
				"discord.thread.reply",
				replyInput.eventId,
			]),
		)
		.digest("hex");
const unknownReceipt = {
	projectName: "flywheel",
	leadId: "flywheel-product-lead",
	operationId: "discord.thread.reply",
	requestId: "55555555-5555-4555-8555-555555555555",
	inputDigest: "a".repeat(64),
	activationId: "a1",
	state: "unknown" as const,
	providerRef: null,
	startedAt: 1,
	updatedAt: 1,
	errorCode: null,
};
describe("Discord durable thread reply", () => {
	it("checks reply target before dispatch and uses stable scoped sender key with write guards", async () => {
		const f = fixture(false, false, false, true),
			handler = f.handlers.get("discord.thread.reply");
		expect(handler).toBeDefined();
		await handler!.authorize(replyInput, f.context);
		expect(f.enqueue).not.toHaveBeenCalled();
		const result = await handler!.execute(replyInput, f.context);
		expect(f.enqueue).toHaveBeenCalledExactlyOnceWith({
			leadId: f.context.leadId,
			channelId: replyInput.threadId,
			text: replyInput.text,
			replyTo: replyInput.replyTo,
			idempotencyKey: replyKey(),
		});
		expect(f.fetchMessage).toHaveBeenCalledWith(
			replyInput.threadId,
			replyInput.replyTo,
			{ signal: f.context.signal },
		);
		expect(f.deliverWithResult.mock.calls[0][1]).toMatchObject({
			beforeSideEffect: expect.any(Function),
			assertSideEffectCurrent: expect.any(Function),
			signal: f.context.signal,
		});
		expect(result).toMatchObject({
			status: "succeeded",
			providerRef: "discord-message:444444444444444444",
			data: { threadId: replyInput.threadId, messageId: "444444444444444444" },
		});
	});
	it("malformed replyTo is rejected before any provider read", async () => {
		const f = fixture(false, false, false, true);
		await expect(
			f.handlers
				.get("discord.thread.reply")!
				.authorize({ ...replyInput, replyTo: "https://foreign" }, f.context),
		).rejects.toThrow("discord_scope_denied");
		expect(f.lookupParent).not.toHaveBeenCalled();
		expect(f.enqueue).not.toHaveBeenCalled();
	});
	it("foreign or stale bindings cannot enqueue or send", async () => {
		const f = fixture(false, false, false, true);
		f.setBinding({ ...f.binding(), leadId: "foreign" });
		await expect(
			f.handlers.get("discord.thread.reply")!.execute(replyInput, f.context),
		).rejects.toThrow("discord_scope_denied");
		expect(f.enqueue).not.toHaveBeenCalled();
		expect(f.deliverWithResult).not.toHaveBeenCalled();
	});
	it("mismatched fetched reply target cannot enqueue", async () => {
		const f = fixture(false, false, false, true);
		f.fetchMessage.mockResolvedValue({
			id: "666666666666666666",
			authorId: "333333333333333333",
			content: "other",
			ts: "2026-09-13T00:00:00.000Z",
			isBot: false,
		});
		await expect(
			f.handlers.get("discord.thread.reply")!.authorize(replyInput, f.context),
		).rejects.toThrow("discord_scope_denied");
		expect(f.enqueue).not.toHaveBeenCalled();
	});
	it("revocation after enqueue leaves unknown and prevents delivery", async () => {
		const f = fixture(false, false, false, true);
		f.enqueue.mockImplementation(async (args) => {
			f.setPolicy({ ...f.policy(), revision: "revoked" });
			return args.idempotencyKey;
		});
		const result = await f.handlers
			.get("discord.thread.reply")!
			.execute(replyInput, f.context);
		expect(result.status).toBe("unknown");
		expect(f.deliverWithResult).not.toHaveBeenCalled();
	});
	it("lost delivery is unknown and reconciles only matching local receipt without resending", async () => {
		const f = fixture(false, false, false, true);
		f.deliverWithResult.mockRejectedValue(new Error("CREDENTIAL_CANARY"));
		const handler = f.handlers.get("discord.thread.reply")!;
		expect(await handler.execute(replyInput, f.context)).toEqual({
			status: "unknown",
		});
		const reads = f.lookupParent.mock.calls.length;
		const result = await handler.reconcile!(
			unknownReceipt,
			replyInput,
			f.context,
		);
		expect(result.status).toBe("succeeded");
		expect(f.enqueue).toHaveBeenCalledOnce();
		expect(f.deliverWithResult).toHaveBeenCalledOnce();
		expect(f.lookupParent).toHaveBeenCalledTimes(reads);
		expect(f.getDeliveryStatus).toHaveBeenCalledExactlyOnceWith(replyKey(), {
			leadId: f.context.leadId,
			channelId: replyInput.threadId,
			text: replyInput.text,
			replyTo: replyInput.replyTo,
		});
	});
	it("reconcile payload conflict never attributes another sent message to this operation", async () => {
		const f = fixture(false, false, false, true);
		f.getDeliveryStatus.mockImplementation(() => {
			throw new Error("CREDENTIAL_CANARY conflict");
		});
		expect(
			await f.handlers.get("discord.thread.reply")!.reconcile!(
				unknownReceipt,
				replyInput,
				f.context,
			),
		).toEqual({ status: "unknown" });
		expect(f.deliverWithResult).not.toHaveBeenCalled();
	});
	it("requestId is the stable label when eventId is absent", async () => {
		const f = fixture(false, false, false, true);
		const { eventId: _event, ...input } = replyInput;
		await f.handlers.get("discord.thread.reply")!.execute(input, f.context);
		expect(f.enqueue.mock.calls[0][0].idempotencyKey).toBe(
			createHash("sha256")
				.update(
					JSON.stringify([
						f.context.projectName,
						f.context.leadId,
						input.threadId,
						"discord.thread.reply",
						f.context.requestId,
					]),
				)
				.digest("hex"),
		);
	});
});

it.each([false, true])(
	"real outbound services preserve one send and reconcile exact local content; lost=%s",
	async (lost) => {
		const f = fixture();
		let sends = 0;
		const sender = createBrokerDiscordOutboundSender({
			sender: {
				bridgeUrl: "http://unused.local",
				apiToken: "PRIVATE",
				projectName: f.context.projectName,
				leadId: f.context.leadId,
				channelId: replyInput.threadId,
				dbPath: ":memory:",
			},
			store: new InMemoryOutboundDedupStore(),
			resolveBotToken: () => "CREDENTIAL_CANARY",
			authorizeLeadChannel: async () => true,
			fetchImpl: async () => {
				sends++;
				if (lost) throw new Error("private timeout");
				return new Response(JSON.stringify({ id: "444444444444444444" }), {
					status: 200,
				});
			},
		});
		const fetcher = new DiscordFetcher(
			"CREDENTIAL_CANARY",
			async () =>
				new Response(
					JSON.stringify({
						id: replyInput.replyTo,
						channel_id: replyInput.threadId,
						content: "earlier",
						timestamp: "2026-09-13T00:00:00.000Z",
						author: { id: "333333333333333333", bot: false },
					}),
					{ status: 200 },
				),
		);
		try {
			const handler = createDiscordHandlers({
				policy: f.policy,
				bindingForIssue: f.binding,
				bindingForThread: f.binding,
				authorizeIssue: f.authorizeIssue,
				botToken: () => "CREDENTIAL_CANARY",
				lookupParent: f.lookupParent,
				messageFetcher: fetcher,
				outboundSender: sender,
			}).get("discord.thread.reply")!;
			await handler.authorize(replyInput, f.context);
			const result = await handler.execute(replyInput, f.context);
			expect(result.status).toBe(lost ? "unknown" : "succeeded");
			const replay = await handler.execute(replyInput, f.context);
			expect(replay.status).toBe(lost ? "unknown" : "succeeded");
			expect(sends).toBe(1);
			const reconciled = await handler.reconcile!(
				unknownReceipt,
				replyInput,
				f.context,
			);
			expect(reconciled.status).toBe(lost ? "unknown" : "succeeded");
			expect(sends).toBe(1);
			const conflict = await handler.reconcile!(
				unknownReceipt,
				{ ...replyInput, text: "different" },
				f.context,
			);
			expect(conflict.status).toBe("unknown");
			expect(sends).toBe(1);
		} finally {
			sender.close();
		}
	},
);

function messageActionFixture(authorId = "333333333333333333", owned = true) {
	const f = fixture();
	f.setPolicy({ ...f.policy(), botUserId: "333333333333333333" });
	const writes: Array<{ url: string; init?: RequestInit }> = [];
	const fetch = vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async (url, init) => {
			if (init?.method === "PATCH" || init?.method === "PUT") {
				writes.push({ url: String(url), init });
				return new Response(null, { status: 204 });
			}
			if (String(url).includes("/messages/"))
				return new Response(
					JSON.stringify({
						id: "777777777777777777",
						channel_id: "222222222222222222",
						content: "old",
						timestamp: "2026-09-13T00:00:00.000Z",
						author: { id: authorId, bot: true },
					}),
					{ status: 200 },
				);
			return new Response(
				JSON.stringify({ type: 11, parent_id: "111111111111111111" }),
				{ status: 200 },
			);
		});
	const handlers = createDiscordHandlers({
		policy: f.policy,
		bindingForIssue: f.binding,
		bindingForThread: f.binding,
		authorizeIssue: f.authorizeIssue,
		botToken: () => "CREDENTIAL_CANARY",
		messageFetcher: new DiscordFetcher("CREDENTIAL_CANARY"),
		ownsMessage: () => owned,
	});
	return { ...f, handlers, fetch, writes, close: () => fetch.mockRestore() };
}
const editInput = {
	threadId: "222222222222222222",
	messageId: "777777777777777777",
	text: "Edited by this Lead",
};
it("edits this bot's message through the actual PATCH helper after ownership checks", async () => {
	const f = messageActionFixture();
	try {
		const handler = f.handlers.get("discord.message.edit");
		expect(handler).toBeDefined();
		await handler!.authorize(editInput, f.context);
		expect(f.writes).toHaveLength(0);
		const result = await handler!.execute(editInput, f.context);
		expect(result).toMatchObject({
			status: "succeeded",
			providerRef: "discord-message:777777777777777777",
			data: { messageId: editInput.messageId },
		});
		expect(f.writes).toHaveLength(1);
		expect(f.writes[0].url).toBe(
			"https://discord.com/api/v10/channels/222222222222222222/messages/777777777777777777",
		);
		expect(JSON.parse(f.writes[0].init!.body as string)).toEqual({
			content: editInput.text,
			allowed_mentions: { parse: [] },
		});
	} finally {
		f.close();
	}
});
it("denies shared-bot gate cards absent this Lead's durable send evidence", async () => {
	const f = messageActionFixture("333333333333333333", false);
	try {
		const handler = f.handlers.get("discord.message.edit")!;
		await expect(handler.authorize(editInput, f.context)).rejects.toThrow(
			"discord_scope_denied",
		);
		await expect(handler.execute(editInput, f.context)).rejects.toThrow(
			"discord_scope_denied",
		);
		expect(f.writes).toHaveLength(0);
	} finally {
		f.close();
	}
});
it("rejects oversized edits before provider reads or writes", async () => {
	const f = messageActionFixture();
	try {
		const handler = f.handlers.get("discord.message.edit")!;
		await expect(
			handler.authorize({ ...editInput, text: "x".repeat(2001) }, f.context),
		).rejects.toThrow();
		expect(f.fetch).not.toHaveBeenCalled();
	} finally {
		f.close();
	}
});
it("reacts to an owned thread message with one encoded @me PUT", async () => {
	const f = messageActionFixture("888888888888888888");
	try {
		const handler = f.handlers.get("discord.message.react");
		expect(handler).toBeDefined();
		const input = {
			threadId: editInput.threadId,
			messageId: editInput.messageId,
			emoji: "🔍",
		};
		await handler!.authorize(input, f.context);
		expect(f.writes).toHaveLength(0);
		expect(await handler!.execute(input, f.context)).toMatchObject({
			status: "succeeded",
			data: { messageId: editInput.messageId },
		});
		expect(f.writes).toHaveLength(1);
		expect(f.writes[0].url).toBe(
			`https://discord.com/api/v10/channels/${editInput.threadId}/messages/${editInput.messageId}/reactions/%F0%9F%94%8D/@me`,
		);
		expect(f.writes[0].init!.method).toBe("PUT");
	} finally {
		f.close();
	}
});
it("denies edits authored by another bot", async () => {
	const f = messageActionFixture("888888888888888888");
	try {
		const h = f.handlers.get("discord.message.edit")!;
		await expect(h.authorize(editInput, f.context)).rejects.toThrow();
		await expect(h.execute(editInput, f.context)).rejects.toThrow();
		expect(f.writes).toHaveLength(0);
	} finally {
		f.close();
	}
});
it.each(["edit", "react"])(
	"denies %s foreign threads and revoked message reads",
	async (action) => {
		const f = messageActionFixture();
		try {
			const h = f.handlers.get(`discord.message.${action}`)!;
			const input =
				action === "edit"
					? editInput
					: {
							threadId: editInput.threadId,
							messageId: editInput.messageId,
							emoji: "✅",
						};
			await expect(
				h.authorize({ ...input, threadId: "999999999999999999" }, f.context),
			).rejects.toThrow();
			expect(f.fetch).not.toHaveBeenCalled();
			const real = f.fetch.getMockImplementation()!;
			f.fetch.mockImplementation(async (url, init) => {
				const response = await real(url, init);
				if (String(url).includes("/messages/"))
					f.setPolicy({ ...f.policy(), botUserId: "888888888888888888" });
				return response;
			});
			await expect(h.execute(input, f.context)).rejects.toThrow();
			expect(f.writes).toHaveLength(0);
		} finally {
			f.close();
		}
	},
);
it.each(["edit", "react"])(
	"returns unknown after a lost %s response without retrying",
	async (action) => {
		const f = messageActionFixture();
		try {
			const h = f.handlers.get(`discord.message.${action}`)!;
			const input =
				action === "edit"
					? editInput
					: {
							threadId: editInput.threadId,
							messageId: editInput.messageId,
							emoji: "✅",
						};
			const real = f.fetch.getMockImplementation()!;
			let attempts = 0;
			f.fetch.mockImplementation(async (url, init) => {
				if (init?.method === "PATCH" || init?.method === "PUT") {
					attempts++;
					throw new Error("CREDENTIAL_CANARY");
				}
				return real(url, init);
			});
			expect(await h.execute(input, f.context)).toEqual({ status: "unknown" });
			expect(attempts).toBe(1);
		} finally {
			f.close();
		}
	},
);
it.each(["", "\n", "x".repeat(129)])(
	"rejects invalid reaction %j before provider access",
	async (emoji) => {
		const f = messageActionFixture();
		try {
			const h = f.handlers.get("discord.message.react")!;
			await expect(
				h.authorize(
					{
						threadId: editInput.threadId,
						messageId: editInput.messageId,
						emoji,
					},
					f.context,
				),
			).rejects.toThrow();
			expect(f.fetch).not.toHaveBeenCalled();
		} finally {
			f.close();
		}
	},
);
it("omits edit without configured bot identity while retaining reaction support", () => {
	const f = fixture();
	const handlers = createDiscordHandlers({
		policy: f.policy,
		bindingForIssue: f.binding,
		bindingForThread: f.binding,
		authorizeIssue: f.authorizeIssue,
		botToken: () => "CREDENTIAL_CANARY",
		messageFetcher: new DiscordFetcher("CREDENTIAL_CANARY"),
	});
	expect(handlers.has("discord.message.edit")).toBe(false);
	expect(handlers.has("discord.message.react")).toBe(true);
});
it.each(["edit", "react"])(
	"does not report %s success when policy changes during the write",
	async (action) => {
		const f = messageActionFixture();
		try {
			const h = f.handlers.get(`discord.message.${action}`)!;
			const input =
				action === "edit"
					? editInput
					: {
							threadId: editInput.threadId,
							messageId: editInput.messageId,
							emoji: "✅",
						};
			const real = f.fetch.getMockImplementation()!;
			f.fetch.mockImplementation(async (url, init) => {
				const response = await real(url, init);
				if (init?.method === "PATCH" || init?.method === "PUT")
					f.setPolicy({ ...f.policy(), revision: "revoked" });
				return response;
			});
			expect(await h.execute(input, f.context)).toEqual({ status: "unknown" });
			expect(f.writes).toHaveLength(1);
		} finally {
			f.close();
		}
	},
);
