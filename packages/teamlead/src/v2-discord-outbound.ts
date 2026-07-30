/**
 * FLY-1544 ③④: the outbound half of the bidirectional v2 Discord messenger.
 *
 * The engine writes lifecycle events (issue opened / task dispatched / node
 * completed / PR ready / merged / issue closed) and runner progress mirrors
 * into the v2 mailbox addressed to the well-known lead-kind recipient
 * `discord-messenger` (flywheel-v2-dag outbox.ts). This service registers
 * under that id, pulls the mailbox through the normal lead delivery path
 * (`register-lead` → `next` → `submit`), performs the Discord effect —
 * create the `[FLY-XXXX]` issue thread + pull the founder in, post progress,
 * archive on close — and settles every delivery with an event effect that
 * records the outcome, so a Discord failure is a visible ledger event, never
 * a silent drop.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { markAutomatedDiscordText } from "./bridge/automated-message.js";
import {
	addThreadMember,
	archiveChatThread,
	createChatThread,
	postChatMessage,
} from "./bridge/chat-thread-utils.js";

const execFileAsync = promisify(execFile);

/** Must match flywheel-v2-dag outbox.ts DISCORD_MESSENGER_AGENT_ID. */
export const DISCORD_MESSENGER_AGENT_ID = "discord-messenger";

/** The founder's Discord user id (FLY-1544 ③ — pulled into every issue thread). */
export const FOUNDER_DISCORD_USER_ID = "1138241636057481306";

export interface V2DiscordOutboundOptions {
	v2CliBin: string;
	socketPath: string;
	secretPath: string;
	hostEpoch: string;
	/** MUST be the same proof root the v2 host reads (session evidence). */
	sessionProofRoot: string;
	/** Durable issue→thread map + delivery credential live next to this file. */
	statePath: string;
	botToken: string;
	chatChannelId: string;
	founderUserId?: string;
	logger?: Pick<Console, "log" | "warn" | "error">;
	runImpl?: typeof execFileAsync;
	/** Test seam for Discord HTTP. */
	fetchImpl?: typeof fetch;
	/** Delay between pulls after an error or an idle timeout. Default 2000ms. */
	pollDelayMs?: number;
}

interface OutboundState {
	v: 1;
	threads: Record<string, string>;
}

interface OutboundEnvelope {
	message: { messageUid: string; kind?: string; payload: string };
	handle: { attemptUid: string; messageUid: string };
	authorization?: { capabilityId: string; token: string };
}

interface OutboundPayload {
	issue_id?: string;
	[key: string]: unknown;
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function shortSha(value: unknown): string {
	const sha = text(value);
	return sha.length > 8 ? sha.slice(0, 8) : sha;
}

export class V2DiscordOutbound {
	readonly #options: V2DiscordOutboundOptions;
	readonly #logger: Pick<Console, "log" | "warn" | "error">;
	readonly #run: typeof execFileAsync;
	readonly #credentialPath: string;
	#state: OutboundState = { v: 1, threads: {} };
	#stopped = false;
	#loop?: Promise<void>;

	constructor(options: V2DiscordOutboundOptions) {
		for (const [label, value] of [
			["socketPath", options.socketPath],
			["secretPath", options.secretPath],
			["sessionProofRoot", options.sessionProofRoot],
			["statePath", options.statePath],
		] as const) {
			if (!isAbsolute(value)) {
				throw new TypeError(`${label} must be absolute`);
			}
		}
		if (!options.v2CliBin.trim()) throw new TypeError("v2CliBin is empty");
		if (!options.botToken.trim()) throw new TypeError("botToken is empty");
		if (!options.chatChannelId.trim()) {
			throw new TypeError("chatChannelId is empty");
		}
		this.#options = options;
		this.#logger = options.logger ?? console;
		this.#run = options.runImpl ?? execFileAsync;
		this.#credentialPath = join(
			dirname(options.statePath),
			"discord-messenger-credential.json",
		);
	}

	async start(): Promise<void> {
		this.#loadState();
		await this.#register();
		this.#loop = this.#runLoop();
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		await this.#loop;
	}

	#loadState(): void {
		try {
			const parsed = JSON.parse(
				readFileSync(this.#options.statePath, "utf8"),
			) as OutboundState;
			if (
				parsed &&
				parsed.v === 1 &&
				typeof parsed.threads === "object" &&
				parsed.threads !== null
			) {
				this.#state = { v: 1, threads: { ...parsed.threads } };
			}
		} catch {
			// first run: empty state
		}
	}

	#saveState(): void {
		mkdirSync(dirname(this.#options.statePath), { recursive: true });
		const temporary = `${this.#options.statePath}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(this.#state)}\n`, {
			mode: 0o600,
		});
		renameSync(temporary, this.#options.statePath);
	}

	async #cli(args: string[]): Promise<string> {
		const result = await this.#run(
			this.#options.v2CliBin,
			[
				...args,
				"--socket",
				this.#options.socketPath,
				"--secret",
				this.#options.secretPath,
			],
			{ encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
		);
		return result.stdout;
	}

	async #register(): Promise<void> {
		await this.#cli([
			"register-lead",
			"--agent",
			DISCORD_MESSENGER_AGENT_ID,
			"--instance",
			randomUUID(),
			"--host-epoch",
			this.#options.hostEpoch,
			"--session-id",
			`${DISCORD_MESSENGER_AGENT_ID}:${process.pid}`,
			"--session-proof-root",
			this.#options.sessionProofRoot,
			"--pid",
			String(process.pid),
			"--delivery-credential-out",
			this.#credentialPath,
		]);
		this.#logger.log(
			`[v2-discord-outbound] registered as ${DISCORD_MESSENGER_AGENT_ID}`,
		);
	}

	async #runLoop(): Promise<void> {
		const delay = this.#options.pollDelayMs ?? 2_000;
		while (!this.#stopped) {
			let envelope: OutboundEnvelope | null = null;
			try {
				envelope = await this.#pull();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (/no delivery became available/.test(message)) continue;
				if (/credential|superseded|revoked/i.test(message)) {
					this.#logger.warn(
						`[v2-discord-outbound] re-registering after: ${message}`,
					);
					try {
						await this.#register();
					} catch (registerError) {
						this.#logger.error(
							`[v2-discord-outbound] re-register failed: ${
								registerError instanceof Error
									? registerError.message
									: String(registerError)
							}`,
						);
					}
					await sleep(delay);
					continue;
				}
				this.#logger.error(`[v2-discord-outbound] pull failed: ${message}`);
				await sleep(delay);
				continue;
			}
			if (!envelope) continue;
			let outcome: { ok: boolean; threadId?: string; error?: string };
			try {
				outcome = await this.#handle(envelope);
			} catch (error) {
				outcome = {
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				};
			}
			if (!outcome.ok) {
				this.#logger.error(
					`[v2-discord-outbound] delivery ${envelope.message.messageUid} failed: ${outcome.error}`,
				);
			}
			try {
				await this.#settle(envelope, outcome);
			} catch (error) {
				// The processing attempt stays running; a host crash-settle
				// reschedules the message. Loud, never silent.
				this.#logger.error(
					`[v2-discord-outbound] settle failed for ${envelope.message.messageUid}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
				await sleep(delay);
			}
		}
	}

	async #pull(): Promise<OutboundEnvelope | null> {
		const stdout = await this.#cli([
			"next",
			"--agent",
			DISCORD_MESSENGER_AGENT_ID,
			"--delivery-credential-file",
			this.#credentialPath,
		]);
		const parsed = JSON.parse(stdout) as OutboundEnvelope;
		if (
			!parsed?.message?.messageUid ||
			!parsed.handle?.attemptUid ||
			!parsed.authorization?.capabilityId
		) {
			throw new Error("outbound delivery envelope is malformed");
		}
		return parsed;
	}

	async #settle(
		envelope: OutboundEnvelope,
		outcome: { ok: boolean; threadId?: string; error?: string },
	): Promise<void> {
		const effectsPath = join(
			dirname(this.#options.statePath),
			`effects-${envelope.message.messageUid}.json`,
		);
		writeFileSync(
			effectsPath,
			JSON.stringify([
				{
					kind: "event",
					eventKind: outcome.ok
						? "discord_messenger_delivered"
						: "discord_messenger_failed",
					payload: JSON.stringify({
						v: 1,
						message_uid: envelope.message.messageUid,
						kind: envelope.message.kind ?? null,
						thread_id: outcome.threadId ?? null,
						error: outcome.error ?? null,
					}),
				},
			]),
			{ mode: 0o600 },
		);
		const authorization = envelope.authorization;
		if (!authorization) throw new Error("delivery carried no authorization");
		await this.#cli([
			"submit",
			"--agent",
			DISCORD_MESSENGER_AGENT_ID,
			"--attempt",
			envelope.handle.attemptUid,
			"--message",
			envelope.handle.messageUid,
			"--capability-id",
			authorization.capabilityId,
			"--token",
			authorization.token,
			"--effects-file",
			effectsPath,
		]);
	}

	#discordDeps(): { fetchImpl?: typeof fetch } {
		return this.#options.fetchImpl
			? { fetchImpl: this.#options.fetchImpl }
			: {};
	}

	async #ensureThread(
		issueId: string,
	): Promise<{ threadId: string } | { error: string }> {
		const existing = this.#state.threads[issueId];
		if (existing) return { threadId: existing };
		const created = await createChatThread(
			{
				channelId: this.#options.chatChannelId,
				threadName: `[${issueId}]`,
				messageContent: markAutomatedDiscordText(
					`🧵 **[${issueId}]** — flywheel v2 issue`,
				),
				botToken: this.#options.botToken,
			},
			this.#discordDeps(),
		);
		if (!created.created) return { error: created.error };
		const founder = this.#options.founderUserId ?? FOUNDER_DISCORD_USER_ID;
		const membership = await addThreadMember(
			created.threadId,
			founder,
			this.#options.botToken,
			this.#discordDeps(),
		);
		if (membership !== "added") {
			this.#logger.warn(
				`[v2-discord-outbound] founder membership for ${issueId} is ${membership}`,
			);
		}
		this.#state.threads[issueId] = created.threadId;
		this.#saveState();
		return { threadId: created.threadId };
	}

	#renderMessage(kind: string, payload: OutboundPayload): string {
		switch (kind) {
			case "issue_opened": {
				const kinds = Array.isArray(payload.task_kinds)
					? (payload.task_kinds as unknown[]).map(text).join(" → ")
					: "";
				return `📋 开单${kinds ? `:${kinds}` : ""}`;
			}
			case "task_dispatched":
				return `🚀 派工 ${text(payload.task_kind) || "?"} 节点 (attempt ${shortSha(payload.attempt_id)})`;
			case "node_completed":
				return `✅ 节点完成 ${text(payload.task_kind) || shortSha(payload.task_id)}${
					payload.head ? ` @ ${shortSha(payload.head)}` : ""
				}`;
			case "pr_ready":
				return `🔗 PR ready: ${text(payload.repo)}#${String(payload.pr ?? "?")} @ ${shortSha(payload.head)}`;
			case "issue_merged":
				return `🎉 已合并 @ ${shortSha(payload.merged_sha)}`;
			case "issue_closed":
				return `🧹 整单收尾完成 — 会话已回收、worktree/远端分支已清理,thread 归档。`;
			case "runner_ask": {
				const askKind = text(payload.ask_kind);
				const prefix =
					askKind === "blocked" ? "⛔" : askKind === "ask" ? "❓" : "📝";
				return `${prefix} ${text(payload.body)}`;
			}
			default:
				return `ℹ️ ${kind}: ${JSON.stringify(payload).slice(0, 500)}`;
		}
	}

	async #handle(
		envelope: OutboundEnvelope,
	): Promise<{ ok: boolean; threadId?: string; error?: string }> {
		let payload: OutboundPayload;
		try {
			payload = JSON.parse(envelope.message.payload) as OutboundPayload;
		} catch {
			return { ok: false, error: "outbound payload is not JSON" };
		}
		const kind = envelope.message.kind ?? "";
		const issueId = text(payload.issue_id);
		if (!issueId) return { ok: false, error: "outbound payload has no issue" };
		const thread = await this.#ensureThread(issueId);
		if ("error" in thread) {
			return { ok: false, error: `thread create failed: ${thread.error}` };
		}
		const content = markAutomatedDiscordText(
			this.#renderMessage(kind, payload),
		);
		const posted = await postChatMessage(
			{
				channelId: thread.threadId,
				content,
				botToken: this.#options.botToken,
			},
			this.#discordDeps(),
		);
		if (!posted.posted) {
			return { ok: false, threadId: thread.threadId, error: posted.error };
		}
		if (kind === "issue_closed") {
			const archived = await archiveChatThread(
				thread.threadId,
				this.#options.botToken,
				this.#discordDeps(),
			);
			if (!archived.archived && archived.reason !== "missing") {
				return {
					ok: false,
					threadId: thread.threadId,
					error: `archive failed: ${archived.reason}`,
				};
			}
		}
		return { ok: true, threadId: thread.threadId };
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
