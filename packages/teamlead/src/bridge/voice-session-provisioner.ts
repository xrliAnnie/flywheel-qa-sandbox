import { createHash } from "node:crypto";
import type {
	StateStore,
	VoiceProvisioningStep,
	VoiceSessionState,
} from "../StateStore.js";
import {
	addThreadMember,
	startThreadFromMessage,
} from "./chat-thread-utils.js";
import {
	DISCORD_API,
	postDiscordMessageToChannel,
	splitDiscordMessage,
} from "./discord-utils.js";
import { msToSnowflakeLowerBound } from "./founder-notify-utils.js";
import { voiceThreadName } from "./voice-session-labels.js";

export interface VoiceProvisionerDeps {
	captureCursor: (input: {
		channelId: string;
		botToken: string;
	}) => Promise<string>;
	postRoot: (input: {
		channelId: string;
		botToken: string;
		sessionId: string;
		nonce: string;
	}) => Promise<string>;
	startThread: (input: {
		channelId: string;
		rootMessageId: string;
		threadName: string;
		botToken: string;
	}) => Promise<string>;
	addMember: (input: {
		threadId: string;
		userId: string;
		botToken: string;
	}) => Promise<boolean>;
	postCancelled: (input: {
		threadOrChannelId: string;
		replyTo?: string;
		botToken: string;
	}) => Promise<void>;
	archiveThread: (input: {
		threadId: string;
		botToken: string;
	}) => Promise<void>;
}

export interface RunVoiceProvisionerInput {
	store: StateStore;
	sessionId: string;
	epoch: string;
	now?: () => string;
	staleMs: number;
	rootRetryWindowMs?: number;
	rootRetryAttempts?: number;
	context: {
		chatChannelId: string;
		leadBotToken: string;
		founderUserId: string;
	};
	deps: VoiceProvisionerDeps;
	afterEffect?: (step: VoiceProvisioningStep) => void;
}

function nonce(sessionId: string): string {
	return BigInt(
		`0x${createHash("sha256").update(`${sessionId}:root`).digest("hex")}`,
	)
		.toString(36)
		.slice(0, 25);
}

export function createDiscordVoiceProvisionerDeps(
	fetchImpl: typeof fetch = fetch,
): VoiceProvisionerDeps {
	return {
		captureCursor: async ({ channelId, botToken }) => {
			const response = await fetchImpl(
				`${DISCORD_API}/channels/${channelId}/messages?limit=1`,
				{ headers: { Authorization: `Bot ${botToken}` } },
			);
			if (!response.ok) throw new Error(`cursor_http_${response.status}`);
			const messages = (await response.json()) as Array<{ id?: unknown }>;
			if (!Array.isArray(messages)) throw new Error("cursor_missing");
			if (messages.length === 0) return msToSnowflakeLowerBound(Date.now());
			const id = messages[0]?.id;
			if (typeof id !== "string" || !/^\d+$/.test(id)) {
				throw new Error("cursor_missing");
			}
			return id;
		},
		postRoot: async ({ channelId, botToken, sessionId, nonce }) => {
			const text = `📻 语音会话已请求\nsession: ${sessionId}`;
			if (splitDiscordMessage(text).length !== 1) {
				throw new Error("voice_root_must_be_one_chunk");
			}
			const result = await postDiscordMessageToChannel(
				channelId,
				text,
				botToken,
				{ origin: "automation", nonce, enforceNonce: true },
				fetchImpl,
			);
			if (!result.ok || result.messageIds.length !== 1) {
				throw new Error("root_post_unknown");
			}
			return result.messageIds[0]!;
		},
		startThread: async ({ channelId, rootMessageId, threadName, botToken }) => {
			const result = await startThreadFromMessage(
				{
					channelId,
					rootMessageId,
					threadName,
					botToken,
				},
				{ fetchImpl },
			);
			if (result.created) return result.threadId;
			const response = await fetchImpl(
				`${DISCORD_API}/channels/${channelId}/messages/${rootMessageId}`,
				{ headers: { Authorization: `Bot ${botToken}` } },
			);
			if (!response.ok) throw new Error("thread_create_failed");
			const message = (await response.json()) as { thread?: { id?: unknown } };
			if (typeof message.thread?.id !== "string") {
				throw new Error("thread_create_failed");
			}
			return message.thread.id;
		},
		addMember: async ({ threadId, userId, botToken }) =>
			(await addThreadMember(threadId, userId, botToken, { fetchImpl })) ===
			"added",
		postCancelled: async ({ threadOrChannelId, replyTo, botToken }) => {
			const result = await postDiscordMessageToChannel(
				threadOrChannelId,
				"📻 语音会话已取消",
				botToken,
				{ origin: "automation", ...(replyTo ? { replyTo } : {}) },
				fetchImpl,
			);
			if (!result.ok) throw new Error("cancel_status_failed");
		},
		archiveThread: async ({ threadId, botToken }) => {
			const response = await fetchImpl(`${DISCORD_API}/channels/${threadId}`, {
				method: "PATCH",
				headers: {
					Authorization: `Bot ${botToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ archived: true }),
			});
			if (!response.ok)
				throw new Error(`thread_archive_http_${response.status}`);
		},
	};
}

export async function runVoiceProvisioner(
	input: RunVoiceProvisionerInput,
): Promise<VoiceSessionState | "not_owner"> {
	const now = input.now ?? (() => new Date().toISOString());
	const claimedAt = now();
	const staleBefore = new Date(
		Date.parse(claimedAt) - input.staleMs,
	).toISOString();
	if (
		!input.store.claimVoiceProvisioner(
			input.sessionId,
			input.epoch,
			claimedAt,
			staleBefore,
		)
	) {
		return "not_owner";
	}

	let rootAttempts = 0;
	for (let safety = 0; safety < 8; safety++) {
		const session = input.store.getVoiceSession(input.sessionId);
		if (!session) return "failed";
		if (session.state !== "provisioning") return session.state;
		if (session.provisionerEpoch !== input.epoch) return "not_owner";
		if (session.cancelRequestedAt) {
			const cleanupFailures: string[] = [];
			if (session.rootMessageId) {
				await input.deps
					.postCancelled({
						threadOrChannelId: session.threadId ?? input.context.chatChannelId,
						...(session.threadId ? {} : { replyTo: session.rootMessageId }),
						botToken: input.context.leadBotToken,
					})
					.catch(() => {
						cleanupFailures.push("status_failed");
					});
			}
			if (session.threadId) {
				await input.deps
					.archiveThread({
						threadId: session.threadId,
						botToken: input.context.leadBotToken,
					})
					.catch(() => {
						cleanupFailures.push("archive_failed");
					});
			}
			input.store.updateVoiceProvisioning({
				sessionId: input.sessionId,
				expectedStep: session.provisioningStep,
				nextStep: "done",
				nextState: "cancelled",
				reason: ["text-stop", ...cleanupFailures].join(":"),
				orphanCandidates: [
					...new Set([
						...session.orphanCandidates,
						...(session.provisioningNonce && !session.rootMessageId
							? [`nonce:${session.provisioningNonce}`]
							: []),
					]),
				],
				updatedAt: now(),
				provisionerEpoch: input.epoch,
			});
			return input.store.getVoiceSession(input.sessionId)?.state ?? "failed";
		}

		if (session.provisioningStep === "reserved") {
			let cursor: string;
			try {
				cursor = await input.deps.captureCursor({
					channelId: input.context.chatChannelId,
					botToken: input.context.leadBotToken,
				});
			} catch {
				input.store.updateVoiceProvisioning({
					sessionId: input.sessionId,
					expectedStep: "reserved",
					nextStep: "done",
					nextState: "failed",
					reason: "provisioning_cursor",
					updatedAt: now(),
					provisionerEpoch: input.epoch,
				});
				return "failed";
			}
			input.afterEffect?.("reserved");
			input.store.updateVoiceProvisioning({
				sessionId: input.sessionId,
				expectedStep: "reserved",
				nextStep: "root_requested",
				updatedAt: now(),
				provisionerEpoch: input.epoch,
				provisioningNonce: nonce(input.sessionId),
				outboundCursor: {
					...session.outboundCursor,
					[input.context.chatChannelId]: cursor,
				},
			});
			continue;
		}

		if (session.provisioningStep === "root_requested") {
			const withinWindow = () =>
				Date.parse(now()) <
				Date.parse(session.rootRequestedAt ?? session.createdAt) +
					(input.rootRetryWindowMs ?? 30_000);
			const failUnknown = () => {
				input.store.updateVoiceProvisioning({
					sessionId: input.sessionId,
					expectedStep: "root_requested",
					nextStep: "done",
					nextState: "failed",
					reason: "provisioning_root_unknown",
					updatedAt: now(),
					provisionerEpoch: input.epoch,
					orphanCandidates: [
						...session.orphanCandidates,
						`nonce:${session.provisioningNonce}`,
					],
				});
			};
			if (!withinWindow()) {
				failUnknown();
				return input.store.getVoiceSession(input.sessionId)?.state ?? "failed";
			}
			let rootMessageId: string;
			try {
				rootAttempts++;
				rootMessageId = await input.deps.postRoot({
					channelId: input.context.chatChannelId,
					botToken: input.context.leadBotToken,
					sessionId: input.sessionId,
					nonce: session.provisioningNonce!,
				});
			} catch {
				const current = input.store.getVoiceSession(input.sessionId);
				if (
					current?.cancelRequestedAt ||
					current?.provisionerEpoch !== input.epoch
				)
					continue;
				if (!withinWindow()) {
					failUnknown();
					return (
						input.store.getVoiceSession(input.sessionId)?.state ?? "failed"
					);
				}
				if (rootAttempts < (input.rootRetryAttempts ?? 2)) continue;
				return "provisioning";
			}
			input.afterEffect?.("root_requested");
			input.store.updateVoiceProvisioning({
				sessionId: input.sessionId,
				expectedStep: "root_requested",
				nextStep: "thread_requested",
				updatedAt: now(),
				provisionerEpoch: input.epoch,
				rootMessageId,
			});
			continue;
		}

		if (session.provisioningStep === "thread_requested") {
			let threadId: string;
			try {
				threadId = await input.deps.startThread({
					channelId: input.context.chatChannelId,
					rootMessageId: session.rootMessageId!,
					threadName: voiceThreadName({
						mode: session.mode,
						topic: session.topic,
						createdAt: session.createdAt,
						rootMessageId: session.rootMessageId!,
					}),
					botToken: input.context.leadBotToken,
				});
			} catch {
				const current = input.store.getVoiceSession(input.sessionId);
				if (
					current?.cancelRequestedAt ||
					current?.provisionerEpoch !== input.epoch
				)
					continue;
				input.store.updateVoiceProvisioning({
					sessionId: input.sessionId,
					expectedStep: "thread_requested",
					nextStep: "done",
					nextState: "failed",
					reason: "provisioning_thread",
					updatedAt: now(),
					provisionerEpoch: input.epoch,
				});
				return "failed";
			}
			input.afterEffect?.("thread_requested");
			input.store.updateVoiceProvisioning({
				sessionId: input.sessionId,
				expectedStep: "thread_requested",
				nextStep: "member_requested",
				updatedAt: now(),
				provisionerEpoch: input.epoch,
				threadId,
			});
			continue;
		}

		if (session.provisioningStep === "member_requested") {
			let added = false;
			try {
				added = await input.deps.addMember({
					threadId: session.threadId!,
					userId: input.context.founderUserId,
					botToken: input.context.leadBotToken,
				});
			} catch {
				// handled by the common failure below
			}
			if (!added) {
				input.store.updateVoiceProvisioning({
					sessionId: input.sessionId,
					expectedStep: "member_requested",
					nextStep: "done",
					nextState: "failed",
					reason: "provisioning_member",
					updatedAt: now(),
					provisionerEpoch: input.epoch,
				});
				return "failed";
			}
			input.afterEffect?.("member_requested");
			input.store.updateVoiceProvisioning({
				sessionId: input.sessionId,
				expectedStep: "member_requested",
				nextStep: "thread_cursor",
				updatedAt: now(),
				provisionerEpoch: input.epoch,
				memberAddedAt: now(),
			});
			continue;
		}

		if (session.provisioningStep === "thread_cursor") {
			input.store.updateVoiceProvisioning({
				sessionId: input.sessionId,
				expectedStep: "thread_cursor",
				nextStep: "finalize",
				updatedAt: now(),
				provisionerEpoch: input.epoch,
				boundChannelIds: [input.context.chatChannelId, session.threadId!],
				outboundCursor: {
					...session.outboundCursor,
					[session.threadId!]: session.rootMessageId!,
				},
			});
			continue;
		}

		if (session.provisioningStep === "finalize") {
			input.store.updateVoiceProvisioning({
				sessionId: input.sessionId,
				expectedStep: "finalize",
				nextStep: "done",
				nextState: "desired",
				updatedAt: now(),
				provisionerEpoch: input.epoch,
			});
			return input.store.getVoiceSession(input.sessionId)?.state ?? "failed";
		}
	}
	return "failed";
}
