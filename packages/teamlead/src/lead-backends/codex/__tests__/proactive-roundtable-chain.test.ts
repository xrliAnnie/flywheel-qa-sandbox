import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { expect, it } from "vitest";
import { buildPrepareProactiveEngagement } from "../../codexLeadBridgeWiring.js";
import { CodexDiscordGateway } from "../CodexDiscordGateway.js";
import { CodexDiscordMailboxStrategy } from "../CodexDiscordMailboxStrategy.js";
import {
	CodexLeadInboxServer,
	resolveCodexLeadInboxSocketPath,
} from "../CodexLeadInboxSocket.js";
import { CodexLeadOutboundHandler } from "../CodexLeadOutboundHandler.js";
import { CodexOutboundSender } from "../CodexOutboundSender.js";
import { FileInboundCursorStore } from "../InboundCursorStore.js";
import { InMemoryJournalStore, LeadJournal } from "../LeadJournal.js";
import { buildMentionGate } from "../mention-gate.js";
import { RestPollDiscordInboundSource } from "../RestPollDiscordInboundSource.js";
import { buildReplyInThreadWiring } from "../roundtable-reply-in-thread-wiring.js";
import { persistSnapshot } from "../roundtable-subscription-ledger.js";
import { SqliteOutboundDedupStore } from "../SqliteOutboundDedupStore.js";

it.each(["ensure", "ledger", "activate", "after_progress"])(
	"recovers an already posted topic after %s failure through the authenticated socket chain",
	async (failurePoint) => {
		const dir = mkdtempSync(join(tmpdir(), "rt-chain-"));
		const parent = "99999999999999999",
			root = "11111111111111111",
			reply = "11111111111111112";
		let failEnsure = true,
			posts = 0,
			replyExists = false;
		const fetchDiscord = async (url: RequestInfo | URL) => {
			const u = new URL(String(url));
			if (
				u.pathname.endsWith("/threads") &&
				failEnsure &&
				failurePoint === "ensure"
			)
				return { ok: false, status: 503, json: async () => ({}) } as Response;
			const json = u.pathname.endsWith("/messages")
				? replyExists && u.searchParams.get("after") === root
					? [
							{
								id: reply,
								channel_id: root,
								content: "early sibling answer",
								author: { id: "22222222222222222", bot: true },
							},
						]
					: []
				: {
						id: root,
						parent_id: parent,
						type: 11,
						default_auto_archive_duration: 1440,
					};
			return { ok: true, status: 200, json: async () => json } as Response;
		};
		const dbPath = join(dir, "comm.db");
		let queue = new MailboxQueue(dbPath);
		let socket: CodexLeadInboxServer | undefined;
		let dedup = new SqliteOutboundDedupStore(join(dir, "dedup.db"));
		let sender: CodexOutboundSender | undefined;
		async function runtime() {
			const source = new RestPollDiscordInboundSource({
				botToken: "fixture",
				channelIds: [],
				cursorStore: new FileInboundCursorStore(join(dir, "cursor.json")),
				fetchImpl: fetchDiscord,
			});
			const originalCatchup = source.catchUpProactiveChannel.bind(source);
			source.catchUpProactiveChannel = async (...args) => {
				if (failEnsure && failurePoint === "activate")
					throw Error("activation failure");
				return originalCatchup(...args);
			};
			const wiring = buildReplyInThreadWiring({
				cfg: {
					enabled: true,
					parentChannelId: parent,
					autoContinue: true,
					budgetN: 2,
				},
				stateDir: dir,
				persistSnapshot: (path, snapshot) => {
					const proactive = snapshot.entries.find(
						(e) => e.proactive,
					)?.proactive;
					if (failEnsure && failurePoint === "ledger" && proactive)
						throw Error("ledger failure");
					persistSnapshot(path, snapshot);
					if (
						failEnsure &&
						failurePoint === "after_progress" &&
						proactive?.after === reply
					)
						throw Error("crash after progress persisted");
				},
				botToken: "fixture",
				botUserId: "33333333333333333",
				crossDeptChannelIds: [parent],
				source,
				fetchImpl: fetchDiscord,
			})!;
			const strategy = new CodexDiscordMailboxStrategy({
				leadId: "lead",
				dbPath,
				queue,
				journal: new LeadJournal({ store: new InMemoryJournalStore() }),
				router: {
					submit: () => {
						throw Error("must use durable mailbox");
					},
				},
				externalReceiptSaga: { complete: () => {} },
				mailboxReady: () => true,
			});
			const gate = buildMentionGate({
				botUserId: "33333333333333333",
				sharedChannelIds: [parent],
				dynamicSharedChannels: wiring.registry,
				autoContinue: true,
				budgetStore: wiring.budgetStore,
				budgetN: 2,
			});
			const gateway = new CodexDiscordGateway({
				source,
				router: {
					submit: () => {
						throw Error("must use durable mailbox");
					},
				} as never,
				botUserId: "33333333333333333",
				channelIds: [parent],
				registry: wiring.registry,
				resolveReplyRoute: wiring.resolveReplyRoute,
				shouldHandle: gate,
				durableAccept: (i) => strategy.accept(i),
			});
			source.onMessage((m) => gateway.handle(m));
			await wiring.restoreState();
			socket = new CodexLeadInboxServer({
				socketPath: resolveCodexLeadInboxSocketPath(dir),
				leadId: "lead",
				authSecret: "fixture",
				router: {
					submitBatch: () => {
						throw Error("engage must not start turn");
					},
				},
				proactiveTopic: {
					parentChannelId: parent,
					isCurrentOwner: () => true,
					engage: wiring.onProactiveTopicEngaged,
				},
			});
			await socket.listen();
			return wiring;
		}
		const projects = [
			{
				projectName: "p",
				leads: [{ agentId: "lead", roundtableChannel: parent }],
			},
		] as never;
		const makeHandler = () =>
			new CodexLeadOutboundHandler({
				store: dedup,
				expectedApiToken: "api",
				authorizeLeadChannel: (_p, _l, c) => c === parent,
				send: async () => {
					posts++;
					replyExists = true;
					return root;
				},
				prepareProactiveEngagement: buildPrepareProactiveEngagement(projects, {
					resolveBotToken: () => "fixture",
					resolveStateDir: () => dir,
				}),
			});
		let handler = makeHandler();
		const http = createServer((req, res) => {
			let raw = "";
			req.on("data", (c) => {
				raw += c;
			});
			req.on("end", () => {
				void handler
					.handle({
						body: JSON.parse(raw),
						providedToken: req.headers.authorization?.replace("Bearer ", ""),
					})
					.then((result) => {
						res.statusCode = result.httpStatus;
						res.setHeader("content-type", "application/json");
						res.end(JSON.stringify(result));
					})
					.catch((error) => {
						res.statusCode = 500;
						res.end(String(error));
					});
			});
		});
		try {
			await runtime();
			await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
			const port = (http.address() as { port: number }).port;
			const options = {
				bridgeUrl: `http://127.0.0.1:${port}`,
				apiToken: "api",
				projectName: "p",
				leadId: "lead",
				channelId: parent,
				dbPath: join(dir, "outbox.db"),
			};
			sender = new CodexOutboundSender(options);
			await sender.enqueue({
				leadId: "lead",
				text: "question",
				idempotencyKey: "event",
				roundtableEngage: true,
			});
			expect(await sender.deliverWithResult("event")).toMatchObject({
				engagement: "pending",
				sendStatus: "sent",
				messageId: root,
			});
			expect(posts).toBe(1);
			if (failurePoint !== "after_progress")
				expect(queue.getById(`chat:lead:${reply}`)).toBeUndefined();
			else expect(queue.getById(`chat:lead:${reply}`)).toBeDefined();
			await socket!.close();
			socket = undefined;
			sender.close();
			sender = undefined;
			dedup.close();
			queue.close();
			queue = new MailboxQueue(dbPath);
			dedup = new SqliteOutboundDedupStore(join(dir, "dedup.db"));
			handler = makeHandler();
			failEnsure = false;
			const restarted = await runtime();
			sender = new CodexOutboundSender(options);
			expect(await sender.deliverWithResult("event")).toMatchObject({
				engagement: "ready",
				threadId: root,
			});
			expect(posts).toBe(1);
			expect(queue.getById(`chat:lead:${reply}`)?.delivery_content).toContain(
				"early sibling answer",
			);
			expect(restarted.registry.entries()[0].continuation).toEqual({
				remaining: 1,
				admissions: { [reply]: true },
			});
			await sender.deliverWithResult("event");
			expect(posts).toBe(1);
		} finally {
			sender?.close();
			await socket?.close();
			await new Promise<void>((r) => http.close(() => r()));
			dedup.close();
			queue.close();
			rmSync(dir, { recursive: true, force: true });
		}
	},
	20000,
);
