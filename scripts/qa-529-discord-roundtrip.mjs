#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(repo, "packages/teamlead/package.json"));
class ProbeFailure extends Error {
	constructor(code, reason, status) {
		super(reason);
		this.code = code;
		this.reason = reason;
		this.status = status;
	}
}
const fail = (code, reason, status) => {
	throw new ProbeFailure(code, reason, status);
};
function boundedFile(path, limit = 65536) {
	const fd = openSync(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > limit)
			throw new Error("invalid bounded input");
		const data = readFileSync(fd, "utf8");
		if (Buffer.byteLength(data) > limit) throw new Error("oversized input");
		return data;
	} finally {
		closeSync(fd);
	}
}
function jsonFile(path) {
	return JSON.parse(boundedFile(path));
}
function envValue(path, key) {
	const values = boundedFile(path)
		.split(/\r?\n/)
		.filter((line) => line.startsWith(`${key}=`));
	if (values.length !== 1) return undefined;
	let value = values[0].slice(key.length + 1).trim();
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	)
		value = value.slice(1, -1);
	return value;
}
function time(value) {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
	)
		return NaN;
	return Date.parse(value);
}
const snowflake = (value) => typeof value === "string" && /^\d+$/.test(value);
function selectCoordinates(root, agent) {
	const base = join(root, "launchd");
	if (lstatSync(base).isSymbolicLink()) fail(41, "invalid_coordinates");
	const paths = readdirSync(base, { withFileTypes: true })
		.filter((x) => x.isDirectory() && (!agent || x.name === agent))
		.map((x) => join(base, x.name, "lead-coordinates.json"));
	const entries = paths.map((path) => ({ path, value: jsonFile(path) }));
	const selected = agent
		? entries
		: entries.filter((x) => x.value.carrier === "claude-code");
	if (selected.length !== 1) {
		if (
			!agent &&
			entries.length === 1 &&
			entries[0].value.carrier === "codex-app-server"
		)
			return entries[0];
		fail(41, "agent_selection_required");
	}
	return selected[0];
}

/** Read-only observation by default; sendAs is an explicit slot-bot opt-in.
 * Seams are passed as dependencies for hermetic tests, never loaded from JSON.
 */
export async function runRoundtrip(options = {}, dependencies = {}) {
	const now = dependencies.now ?? Date.now;
	const sleep =
		dependencies.sleep ??
		((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	const fetcher = dependencies.fetch ?? globalThis.fetch;
	const log = dependencies.log ?? console.log;
	const home = dependencies.home ?? homedir();
	const env = dependencies.env ?? process.env;
	const root =
		dependencies.slotRoot ?? `/tmp/flywheel-test-slot-${options.slot}`;
	const report = {
		schemaVersion: 1,
		slot: options.slot,
		nonce: options.nonce ?? randomBytes(12).toString("hex"),
		success: false,
		exitCode: null,
		reason: null,
		requestCount: 0,
		timestamps: {
			T0: null,
			ingestObservedAt: null,
			T2: null,
			T3: null,
			T4: null,
		},
		mailbox: null,
	};
	let reportPath = null,
		db = null;
	function persist() {
		if (!reportPath) return;
		const tmp = `${reportPath}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
		try {
			writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`, {
				mode: 0o600,
				flag: "wx",
			});
			renameSync(tmp, reportPath);
		} catch (writeError) {
			try {
				unlinkSync(tmp);
			} catch (error) {
				if (error.code !== "ENOENT")
					throw new AggregateError(
						[writeError, error],
						"evidence write failed",
					);
			}
			throw writeError;
		}
	}
	async function rest(path, token, method = "GET", body) {
		let response;
		report.requestCount++;
		try {
			response = await fetcher(`https://discord.com/api/v10${path}`, {
				method,
				headers: {
					Authorization: `Bot ${token}`,
					...(body ? { "Content-Type": "application/json" } : {}),
				},
				...(body ? { body: JSON.stringify(body) } : {}),
				signal: AbortSignal.timeout(10000),
			});
		} catch {
			fail(44, "rest_unavailable");
		}
		if (!response.ok) fail(44, "rest_error", response.status);
		try {
			return await response.json();
		} catch {
			fail(44, "rest_invalid_json");
		}
	}
	try {
		if (!/^[A-Za-z0-9-]{16,64}$/.test(report.nonce)) fail(40, "invalid_nonce");
		if (
			!/^[1-9][0-9]*$/.test(String(options.slot)) ||
			(options.agent && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.agent))
		)
			fail(41, "invalid_coordinates");
		let selected;
		try {
			selected = selectCoordinates(root, options.agent);
		} catch (error) {
			if (error instanceof ProbeFailure) throw error;
			fail(41, "invalid_coordinates");
		}
		const c = selected.value;
		if (
			!c ||
			typeof c !== "object" ||
			c.schemaVersion !== 1 ||
			c.agentId !== dirname(selected.path).split("/").at(-1)
		)
			fail(41, "invalid_coordinates");
		report.agentId = c.agentId;
		report.carrier = c.carrier;
		const evidence = join(root, "e2e-evidence");
		mkdirSync(evidence, { recursive: true, mode: 0o700 });
		if (lstatSync(evidence).isSymbolicLink()) fail(41, "invalid_evidence_path");
		reportPath = join(evidence, `discord-roundtrip-${report.nonce}.json`);
		if (c.carrier !== "claude-code") fail(39, "not_applicable");
		if (
			!snowflake(c.roundtripChannelId) ||
			!snowflake(c.botUserId) ||
			!["slot", "mirror", "roundtable"].includes(c.mode) ||
			typeof c.commDbPath !== "string" ||
			!c.commDbPath.startsWith("/") ||
			typeof c.discordStateDir !== "string" ||
			!c.discordStateDir.startsWith("/")
		)
			fail(41, "invalid_coordinates");
		const canonicalRoot = realpathSync(root) + sep;
		if (
			![c.discordStateDir, c.commDbPath].every((path) =>
				realpathSync(path).startsWith(canonicalRoot),
			)
		)
			fail(41, "coordinates_outside_slot");
		const budgets = {
			author: options.authorTimeout ?? 600,
			ingest: options.ingestTimeout ?? 10,
			session: options.sessionTimeout ?? 60,
			ack: options.ackTimeout ?? 120,
			reply: options.replyTimeout ?? 180,
		};
		const poll = options.poll ?? 2;
		if (
			!Object.values(budgets).every(
				(x) => Number.isFinite(x) && x > 0 && x <= 86400,
			) ||
			!Number.isFinite(poll) ||
			poll <= 0 ||
			poll > 60
		)
			fail(41, "invalid_timeout");
		report.budgets = budgets;
		report.pollSeconds = poll;
		report.ingestObservationErrorSeconds = [0, poll];
		report.roundtripChannelId = c.roundtripChannelId;
		const liveness =
			dependencies.probeLiveness ??
			((slot, agent) =>
				spawnSync(
					"bash",
					[
						join(repo, "scripts/qa-529-discord-liveness.sh"),
						String(slot),
						"--agent",
						agent,
						"--json",
					],
					{ stdio: "ignore" },
				).status);
		if ((await liveness(options.slot, c.agentId)) !== 0)
			fail(35, "channel_not_live");
		let slotToken;
		try {
			slotToken = envValue(
				join(c.discordStateDir, ".env"),
				"DISCORD_BOT_TOKEN",
			);
		} catch {
			fail(41, "slot_token_missing");
		}
		if (!slotToken) fail(41, "slot_token_missing");
		let senderId, initial;
		const text = `<@${c.botUserId}> [529-rt ${report.nonce}] 请在回复里原样带上 529-rt-ack:${report.nonce}`;
		const started = now();
		if (options.sendAs) {
			if (!["mirror", "roundtable"].includes(c.mode))
				fail(36, "send_as_not_allowed_in_slot");
			if (
				!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.sendAs) ||
				!env[options.sendAs]
			)
				fail(43, "send_as_not_allowlisted");
			const sender = await rest("/users/@me", env[options.sendAs]);
			senderId = sender.id;
			if (senderId === c.botUserId) fail(37, "self_sender");
			let slots, access;
			try {
				slots = jsonFile(join(home, ".flywheel", "test-slots.json"));
				access = jsonFile(join(c.discordStateDir, "access.json"));
			} catch {
				fail(43, "send_as_not_allowlisted");
			}
			if (
				!snowflake(senderId) ||
				!Array.isArray(slots?.slots) ||
				!slots.slots.some((slot) => slot.botAppId === senderId) ||
				!Array.isArray(access.allowBots) ||
				!access.allowBots.includes(senderId) ||
				!Object.hasOwn(access.groups ?? {}, c.roundtripChannelId)
			)
				fail(43, "send_as_not_allowlisted");
			initial = await rest(
				`/channels/${c.roundtripChannelId}/messages`,
				env[options.sendAs],
				"POST",
				{ content: text, allowed_mentions: { parse: [] } },
			);
		} else {
			try {
				senderId = envValue(
					join(home, ".flywheel", ".env"),
					"DISCORD_OWNER_USER_ID",
				);
			} catch {
				fail(42, "founder_identity_missing");
			}
			if (!snowflake(senderId)) fail(42, "founder_identity_missing");
			log(`请以 founder 身份在频道 ${c.roundtripChannelId} 发送：${text}`);
		}
		report.authorId = senderId;
		persist();
		let message;
		while (!message) {
			const candidates = initial
				? [initial]
				: await rest(
						`/channels/${c.roundtripChannelId}/messages?limit=50`,
						slotToken,
					);
			initial = null;
			if (now() > started + budgets.author * 1000) fail(30, "author_timeout");
			if (!Array.isArray(candidates)) fail(44, "rest_invalid_shape");
			message = candidates.find(
				(item) =>
					item.author?.id === senderId &&
					typeof item.content === "string" &&
					item.content.includes(`[529-rt ${report.nonce}]`) &&
					snowflake(item.id) &&
					Number.isFinite(time(item.timestamp)),
			);
			if (message) break;
			if (now() >= started + budgets.author * 1000) fail(30, "author_timeout");
			await sleep(poll * 1000);
		}
		const t0 = time(message.timestamp);
		report.message = { id: message.id, authorId: senderId };
		report.timestamps.T0 = message.timestamp;
		report.deadlines = Object.fromEntries(
			Object.entries(budgets)
				.filter(([key]) => key !== "author")
				.map(([key, value]) => [
					key,
					new Date(t0 + value * 1000).toISOString(),
				]),
		);
		persist();
		const {
			parseChatDeliveryEnvelope,
		} = require("flywheel-comm/discord-chat-ingest");
		const openDb =
			dependencies.openDb ??
			((path, opts) => new (require("better-sqlite3"))(path, opts));
		db = openDb(c.commDbPath, { readonly: true, fileMustExist: true });
		db.pragma("busy_timeout = 2000");
		const query = db.prepare(
			"SELECT seq, from_agent, created_at, notified_at, delivered_at, content FROM mailbox WHERE to_agent = ? AND type = 'discord_chat' AND source_ref = ?",
		);
		let replyTarget;
		while (true) {
			const row = query.get(c.agentId, `chat:${c.agentId}:${message.id}`);
			if (row) {
				if (
					row.from_agent !==
					(options.sendAs ? `discord:${senderId}` : "founder")
				)
					fail(38, "author_identity_mismatch");
				if (!report.timestamps.ingestObservedAt) {
					report.timestamps.ingestObservedAt = new Date(now()).toISOString();
					report.mailbox = {
						seq: row.seq,
						fromAgent: row.from_agent,
						createdAt: row.created_at,
					};
					const envelope = parseChatDeliveryEnvelope(row.content);
					if (
						envelope.leadId !== c.agentId ||
						envelope.messageId !== message.id ||
						envelope.authorId !== senderId
					)
						fail(38, "author_identity_mismatch");
					replyTarget = envelope.replyChannelId ?? envelope.chatId;
					report.replyTarget = replyTarget;
					report.replyRoute = envelope.replyRoute
						? {
								kind: envelope.replyRoute.kind,
								parentChannelId: envelope.replyRoute.parentChannelId,
								sourceMessageId: envelope.replyRoute.sourceMessageId,
								threadId: envelope.replyRoute.threadId,
							}
						: null;
				}
				if (row.notified_at) report.timestamps.T2 = row.notified_at;
				if (row.delivered_at) report.timestamps.T3 = row.delivered_at;
			}
			// Timestamp values and missing observations are both checked against T0;
			// advancing to another stage never replenishes its time budget.
			for (const [field, budget, code, reason] of [
				["ingestObservedAt", "ingest", 31, "ingest_timeout"],
				["T2", "session", 32, "session_timeout"],
				["T3", "ack", 33, "ack_timeout"],
			]) {
				const value = report.timestamps[field];
				const deadline = t0 + budgets[budget] * 1000;
				if (
					value &&
					(!Number.isFinite(time(value)) ||
						time(value) < t0 ||
						time(value) > deadline)
				)
					fail(code, reason);
				if (!value && now() >= deadline) fail(code, reason);
			}
			if (replyTarget && !report.timestamps.T4) {
				const replies = await rest(
					`/channels/${replyTarget}/messages?after=${message.id}&limit=50`,
					slotToken,
				);
				if (!Array.isArray(replies)) fail(44, "rest_invalid_shape");
				const reply = replies.find(
					(item) =>
						item.author?.id === c.botUserId &&
						item.channel_id === replyTarget &&
						typeof item.content === "string" &&
						item.content.includes(`529-rt-ack:${report.nonce}`) &&
						time(item.timestamp) > t0 &&
						time(item.timestamp) <= t0 + budgets.reply * 1000,
				);
				if (reply) {
					report.timestamps.T4 = reply.timestamp;
					report.reply = {
						id: reply.id,
						referenceMatches:
							reply.message_reference?.message_id === message.id,
					};
				}
			}
			if (!report.timestamps.T4 && now() >= t0 + budgets.reply * 1000)
				fail(34, "reply_timeout");
			persist();
			if (Object.values(report.timestamps).every(Boolean)) break;
			await sleep(poll * 1000);
		}
		report.success = true;
		report.exitCode = 0;
	} catch (error) {
		report.exitCode = error instanceof ProbeFailure ? error.code : 44;
		report.reason =
			error instanceof ProbeFailure ? error.reason : "probe_error";
		if (error instanceof ProbeFailure && Number.isInteger(error.status))
			report.httpStatus = error.status;
	} finally {
		if (db) db.close();
		try {
			persist();
		} catch {
			report.success = false;
			report.exitCode = 44;
			report.reason = "evidence_write_failed";
		}
	}
	return { code: report.exitCode, report, reportPath };
}

async function main(argv) {
	const slot = argv.shift();
	const options = { slot };
	const keys = {
		"--agent": "agent",
		"--send-as": "sendAs",
		"--nonce": "nonce",
		"--author-timeout": "authorTimeout",
		"--ingest-timeout": "ingestTimeout",
		"--session-timeout": "sessionTimeout",
		"--ack-timeout": "ackTimeout",
		"--reply-timeout": "replyTimeout",
		"--poll": "poll",
	};
	while (argv.length) {
		const arg = argv.shift();
		const key = keys[arg];
		if (!key || !argv.length) {
			console.error("Invalid roundtrip arguments");
			return 41;
		}
		const value = argv.shift();
		options[key] = ["agent", "sendAs", "nonce"].includes(key)
			? value
			: Number(value);
	}
	const result = await runRoundtrip(options);
	console.log(JSON.stringify(result));
	return result.code;
}
if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	process.exitCode = await main(process.argv.slice(2));
