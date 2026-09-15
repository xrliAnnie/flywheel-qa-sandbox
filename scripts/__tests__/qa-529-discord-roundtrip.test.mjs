import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { MAILBOX_CORE_SCHEMA } from "../../packages/flywheel-comm/dist/mailbox-schema.js";
import { runRoundtrip } from "../qa-529-discord-roundtrip.mjs";

const require = createRequire(resolve("packages/teamlead/package.json"));
const Database = require("better-sqlite3");
const {
	parseChatDeliveryEnvelope,
} = require("flywheel-comm/discord-chat-ingest");
const nonce = "fixture-roundtrip-1234567";
const T0 = Date.parse("2026-09-14T20:00:00.000Z");
const iso = (n) => new Date(T0 + n * 1000).toISOString();
function fixture(config = {}) {
	const root = mkdtempSync(join(tmpdir(), "fly1948-roundtrip-"));
	const runtime = join(root, "launchd", "lead-1"),
		state = join(root, "discord-state"),
		home = join(root, "home");
	mkdirSync(runtime, { recursive: true });
	mkdirSync(state);
	mkdirSync(join(home, ".flywheel"), { recursive: true });
	const c = {
		schemaVersion: 1,
		slot: 2,
		agentId: "lead-1",
		carrier: config.carrier ?? "claude-code",
		mode: config.mode ?? "slot",
		roundtripChannelId: config.mode === "roundtable" ? "333" : "111",
		botUserId: "222",
		discordStateDir: state,
		commDbPath: join(root, "comm.db"),
	};
	writeFileSync(join(runtime, "lead-coordinates.json"), JSON.stringify(c));
	writeFileSync(join(state, ".env"), "DISCORD_BOT_TOKEN=SLOT_SECRET_CANARY\n");
	writeFileSync(
		join(home, ".flywheel", ".env"),
		config.noOwner ? "" : "DISCORD_OWNER_USER_ID=444\n",
	);
	writeFileSync(
		join(home, ".flywheel", "test-slots.json"),
		JSON.stringify({ slots: [{ botAppId: "555" }] }),
	);
	writeFileSync(
		join(state, "access.json"),
		JSON.stringify({
			allowBots: config.disallowed ? [] : ["555"],
			groups: { [c.roundtripChannelId]: {} },
		}),
	);
	const db = new Database(c.commDbPath);
	db.exec(MAILBOX_CORE_SCHEMA);
	const author = config.sendAs ? "555" : "444";
	const env = {
		v: 1,
		deliveryId: "chat:lead-1:100",
		leadId: "lead-1",
		chatId: c.roundtripChannelId,
		originChannelId: c.roundtripChannelId,
		messageId: "100",
		authorId: author,
		authorName: "fixture",
		ts: iso(0),
		priority: 1,
		msgKind: config.mode === "roundtable" ? "roundtable" : "guild",
		attachments: [],
		text: `[529-rt ${nonce}]`,
		...(config.mode === "roundtable"
			? {
					replyChannelId: "999",
					replyRoute: {
						kind: "roundtable_thread_from_message",
						parentChannelId: "333",
						sourceMessageId: "100",
						threadId: "999",
					},
				}
			: {}),
	};
	const content = `[discord-chat-delivery v1] ${JSON.stringify(env)}`;
	assert.equal(
		parseChatDeliveryEnvelope(content).replyChannelId,
		config.mode === "roundtable" ? "999" : undefined,
	);
	let now = T0 + 1000,
		inserted = false,
		closed = false,
		opens = 0;
	const requests = [],
		logs = [];
	function update() {
		const t = (now - T0) / 1000;
		if (!inserted && t >= (config.ingestAt ?? 2) && !config.noIngest) {
			db.prepare(
				"INSERT INTO mailbox_identity (id,delivery_id,insert_projection_hash) VALUES (?,?,?)",
			).run("row1", "delivery1", "fixture");
			db.prepare(
				"INSERT INTO mailbox (id,delivery_id,from_agent,to_agent,recipient_kind,type,source_ref,content,created_at,relay_state) VALUES (?,?,?,?,?,?,?,?,?,?)",
			).run(
				"row1",
				"delivery1",
				config.wrongFrom ? "other" : config.sendAs ? "discord:555" : "founder",
				config.wrongRecipient ? "other-lead" : "lead-1",
				"lead",
				config.wrongType ? "instruction" : "discord_chat",
				config.wrongSource ? "chat:lead-1:100-extra" : "chat:lead-1:100",
				content,
				iso(0),
				"terminal_disposed",
			);
			inserted = true;
		}
		if (inserted) {
			db.prepare(
				"UPDATE mailbox SET notified_at=?,delivered_at=? WHERE id=?",
			).run(
				t >= (config.sessionAt ?? 3) && !config.noSession
					? iso(config.sessionAt ?? 3)
					: null,
				t >= (config.ackAt ?? 4) && !config.noAck
					? iso(config.ackAt ?? 4)
					: null,
				"row1",
			);
		}
	}
	const deps = {
		slotRoot: root,
		home,
		env: { SENDER: "SENDER_SECRET_CANARY" },
		now: () => now,
		sleep: async (ms) => {
			now += ms;
			update();
		},
		log: (x) => logs.push(x),
		probeLiveness: () => (config.dead ? 1 : 0),
		openDb: (path, options) => {
			opens++;
			assert.equal(options.readonly, true);
			assert.equal(options.fileMustExist, true);
			const ro = new Database(path, options);
			const close = ro.close.bind(ro);
			ro.close = () => {
				closed = true;
				return close();
			};
			return ro;
		},
		fetch: async (url, options) => {
			requests.push({
				url: String(url),
				method: options?.method ?? "GET",
				body: options?.body ? JSON.parse(options.body) : undefined,
				authorization: options?.headers?.Authorization,
			});
			const u = new URL(url);
			if (config.httpError)
				return {
					ok: false,
					status: 403,
					json: async () => {
						throw new Error("SECRET_BODY");
					},
				};
			if (config.slowAuthor && !u.searchParams.has("after")) {
				now += 9000;
				update();
			}
			if (u.pathname.endsWith("/users/@me"))
				return {
					ok: true,
					status: 200,
					json: async () => ({ id: config.self ? "222" : "555" }),
				};
			const isReply = u.searchParams.has("after");
			let data;
			if (options?.method === "POST")
				data = {
					id: "100",
					timestamp: iso(0),
					author: { id: author },
					content: `[529-rt ${nonce}]`,
				};
			else if (!isReply)
				data = config.noAuthor
					? []
					: [
							{
								id: "100",
								timestamp: iso(0),
								author: { id: config.wrongAuthor ? "777" : author },
								content: `[529-rt ${nonce}]`,
							},
						];
			else
				data =
					(now - T0) / 1000 >= (config.replyAt ?? 5) && !config.noReply
						? [
								{
									id: "101",
									channel_id: config.wrongChannel
										? "888"
										: (env.replyChannelId ?? env.chatId),
									timestamp: iso(config.replyAt ?? 5),
									author: { id: config.otherBot ? "777" : "222" },
									content: config.noAckText ? "hello" : `529-rt-ack:${nonce}`,
								},
							]
						: [];
			return { ok: true, status: 200, json: async () => data };
		},
	};
	update();
	return {
		root,
		c,
		requests,
		logs,
		get opens() {
			return opens;
		},
		get closed() {
			return closed;
		},
		async run() {
			return runRoundtrip(
				{
					slot: 2,
					agent: config.explicitAgent ? "lead-1" : undefined,
					nonce: config.invalidNonce ?? nonce,
					sendAs: config.sendAs ? "SENDER" : undefined,
					authorTimeout: 8,
					ingestTimeout: 10,
					sessionTimeout: 10,
					ackTimeout: 12,
					replyTimeout: 15,
					poll: 1,
				},
				deps,
			);
		},
		cleanup() {
			db.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}
for (const sendAs of [true, false]) {
	test(`mirror challenge explicitly addresses the selected Lead (${sendAs ? "automated" : "manual"})`, async () => {
		const f = fixture({ mode: "mirror", sendAs });
		try {
			const result = await f.run();
			assert.equal(result.code, 0);
			const post = f.requests.find((r) => r.method === "POST");
			const challenge = sendAs ? post.body.content : f.logs.join("\n");
			assert.ok(challenge.includes(`<@${f.c.botUserId}>`));
			assert.ok(challenge.includes(`529-rt-ack:${nonce}`));
			assert.ok(
				!challenge.includes("<@555>"),
				"must address recipient, not sender",
			);
			if (sendAs) assert.deepEqual(post.body.allowed_mentions, { parse: [] });
		} finally {
			f.cleanup();
		}
	});
}
for (const [label, config, expected] of [
	["success", {}, 0],
	["T0 observed after author budget", { slowAuthor: true }, 30],
	["source_ref is exact", { wrongSource: true }, 31],
	["recipient is exact", { wrongRecipient: true }, 31],
	["type is exact", { wrongType: true }, 31],
	["T0 timeout", { noAuthor: true }, 30],
	["ingest timeout", { noIngest: true }, 31],
	["session timeout", { noSession: true }, 32],
	["ACK timeout", { noAck: true }, 33],
	["reply timeout", { noReply: true }, 34],
	["reply before ACK", { replyAt: 4, ackAt: 9 }, 0],
	["reply does not excuse absent ACK", { replyAt: 4, noAck: true }, 33],
	["absolute session deadline", { ingestAt: 9, sessionAt: 11 }, 32],
	["wrong reply author", { otherBot: true }, 34],
	["missing challenge ACK", { noAckText: true }, 34],
	["wrong reply channel", { wrongChannel: true }, 34],
	["thread route", { mode: "roundtable" }, 0],
	["automated thread route", { mode: "roundtable", sendAs: true }, 0],
	["slot cannot send as bot", { sendAs: true }, 36],
	["self sender rejected", { mode: "mirror", sendAs: true, self: true }, 37],
	[
		"allowBots required",
		{ mode: "mirror", sendAs: true, disallowed: true },
		43,
	],
	["mailbox identity mismatch", { wrongFrom: true }, 38],
	["nonce rejected", { invalidNonce: "../../bad" }, 40],
	["founder identity required", { noOwner: true }, 42],
	["other human not founder", { wrongAuthor: true }, 30],
	["channel must be live", { dead: true }, 35],
	["REST errors redacted", { httpError: true }, 44],
	["Codex no I/O", { carrier: "codex-app-server", explicitAgent: true }, 39],
])
	test(label, async () => {
		const f = fixture(config);
		try {
			const result = await f.run();
			assert.equal(result.code, expected, JSON.stringify(result));
			assert.doesNotMatch(
				JSON.stringify(result) + f.logs.join(""),
				/SLOT_SECRET_CANARY|SENDER_SECRET_CANARY|SECRET_BODY/,
			);
			if (config.carrier) {
				assert.equal(f.opens, 0);
				assert.equal(f.requests.length, 0);
			}
			if (f.opens) assert.equal(f.closed, true);
			if (result.reportPath) {
				assert.equal(statSync(result.reportPath).mode & 0o777, 0o600);
				assert.equal(
					JSON.parse(readFileSync(result.reportPath)).exitCode,
					expected,
				);
			}
			if (expected === 0) {
				assert.notEqual(
					result.report.timestamps.ingestObservedAt,
					result.report.mailbox.createdAt,
				);
				assert.equal(result.report.timestamps.T0, iso(0));
			}
			if (config.mode === "roundtable" && expected === 0)
				assert.ok(
					f.requests.some((r) =>
						r.url.includes("/channels/999/messages?after=100"),
					),
				);
			if (config.disallowed || config.self || config.mode === "slot")
				assert.equal(
					f.requests.some((r) => r.method === "POST"),
					false,
				);
		} finally {
			f.cleanup();
		}
	});
