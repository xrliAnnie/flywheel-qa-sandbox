#!/usr/bin/env node
/**
 * README — FLY-2519 isolated 529 fixture drill (ruling 7eddea27).
 * Run after build: node scripts/qa-fly-2519-529-drill.mjs (no arguments).
 * Follows qa-529-generalized-e2e's request/readback/receipt/cleanup sequence and
 * reuses its bounded waitFor helper, without its host-slot/dispatch/ship path.
 * Proves: two synthetic Lead clients exchange messages through a loopback Bridge
 * outbound route, real Codex outbound SQLite stores, production Discord send
 * formatting, fixture provider readback, Bridge replay dedup and scope rejection.
 * All registry/home/database state is temporary; tokens are random test values.
 * Does NOT prove: model-driven Leads, generalized workflow advancement, v2
 * carrier/broker authorization, real Discord, Chrome, Linear, or production parity.
 * Those boundaries remain QA-owned; this script never calls real channels, uses
 * host test-slots, restarts a Lead, launches runners, or requests ship authority.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexLeadOutboundHandler } from "../packages/teamlead/dist/lead-backends/codex/CodexLeadOutboundHandler.js";
import { CodexOutboundSender } from "../packages/teamlead/dist/lead-backends/codex/CodexOutboundSender.js";
import { buildLeadDiscordSend } from "../packages/teamlead/dist/lead-backends/codex/leadDiscordSend.js";
import { SqliteOutboundDedupStore } from "../packages/teamlead/dist/lead-backends/codex/SqliteOutboundDedupStore.js";
import {
	buildAuthorizeLeadChannel,
	buildLeadOutboundExpressHandler,
	buildResolveBotToken,
} from "../packages/teamlead/dist/lead-backends/codexLeadBridgeWiring.js";
import { waitFor } from "./lib/qa-generalized-e2e-lib.mjs";

const require = createRequire(
	new URL("../packages/teamlead/package.json", import.meta.url),
);
const express = require("express");
if (process.argv.length !== 2) throw new Error("no_arguments_allowed");
const root = realpathSync(mkdtempSync(join(tmpdir(), "fly2519-529-")));
const runId = randomUUID(),
	apiToken = randomUUID();
const guildId = "900000000000000001",
	channelId = "900000000000000002";
const participants = ["lead-a", "lead-b"];
const tokens = Object.fromEntries(
	participants.map((id) => [id, `synthetic-${randomUUID()}`]),
);
const projects = [
	{
		projectName: "isolated-529",
		projectRoot: root,
		leads: participants.map((agentId) => ({
			agentId,
			botTokenEnv: agentId,
			chatChannel: channelId,
		})),
	},
];
writeFileSync(join(root, "projects.json"), JSON.stringify(projects), {
	mode: 0o600,
});
const resolveBotToken = buildResolveBotToken(projects, tokens);
const messages = [],
	requests = [],
	senders = [];
let dedup, server, receipt;
try {
	dedup = new SqliteOutboundDedupStore(join(root, "bridge-dedup.db"));
	const provider = async (url, init) => {
		assert.equal(
			String(url),
			`https://discord.com/api/v10/channels/${channelId}/messages`,
		);
		assert.equal(init.method, "POST");
		const authorization = new Headers(init.headers).get("authorization");
		const author = participants.find(
			(id) => authorization === `Bot ${tokens[id]}`,
		);
		assert.ok(author, "only throwaway bot credentials accepted");
		const body = JSON.parse(init.body);
		const message = {
			id: String(900000000000000010n + BigInt(messages.length)),
			guildId,
			channelId,
			author,
			text: body.content,
			replyTo: body.message_reference?.message_id,
		};
		messages.push(message);
		return Response.json({ id: message.id, channel_id: channelId });
	};
	const handler = new CodexLeadOutboundHandler({
		store: dedup,
		expectedApiToken: apiToken,
		send: buildLeadDiscordSend({ resolveBotToken, fetchImpl: provider }),
		authorizeLeadChannel: buildAuthorizeLeadChannel(projects, {
			resolveBotToken,
			lookupThreadParent: async () => ({ state: "not_thread" }),
		}),
	});
	const app = express();
	app.use(express.json({ limit: "32kb" }));
	app.post("/api/lead-outbound/send", buildLeadOutboundExpressHandler(handler));
	server = app.listen(0, "127.0.0.1");
	await waitFor("isolated Bridge listener", () => server.address(), 5000);
	const base = `http://127.0.0.1:${server.address().port}`;
	const post = async (request) => {
		assert.equal(request.url, `${base}/api/lead-outbound/send`);
		requests.push({ ...request });
		const response = await fetch(request.url, {
			method: "POST",
			headers: request.headers,
			body: request.body,
			signal: AbortSignal.timeout(5000),
		});
		return { status: response.status, body: await response.text() };
	};
	for (const leadId of participants)
		senders.push(
			new CodexOutboundSender({
				bridgeUrl: base,
				apiToken,
				projectName: "isolated-529",
				leadId,
				channelId,
				dbPath: join(root, `${leadId}.db`),
				post,
			}),
		);
	const firstId = await senders[0].enqueue({
		leadId: participants[0],
		channelId,
		text: `529 ${runId}: question`,
		idempotencyKey: `${runId}:a`,
	});
	await senders[0].deliver(firstId);
	const first = await waitFor(
		"fixture member readback",
		() => messages.find((m) => m.author === "lead-a"),
		5000,
	);
	const secondId = await senders[1].enqueue({
		leadId: participants[1],
		channelId,
		text: `529 ${runId}: reply`,
		replyTo: first.id,
		idempotencyKey: `${runId}:b`,
	});
	await senders[1].deliver(secondId);
	assert.equal(messages.length, 2);
	assert.equal(messages[1].replyTo, first.id);
	assert.deepEqual(
		messages.map((m) => m.author),
		participants,
	);
	const firstRequest = requests.find((r) =>
		JSON.parse(r.body).text?.includes(": question"),
	);
	assert.ok(firstRequest);
	assert.equal((await post(firstRequest)).status, 200);
	assert.equal(messages.length, 2, "Bridge replay must not send again");
	const before = messages.length;
	for (const extra of [
		{ leadId: "foreign" },
		{ projectName: "foreign" },
		{ channelId: "900000000000000999" },
	]) {
		const denied = await post({
			...firstRequest,
			body: JSON.stringify({
				...JSON.parse(firstRequest.body),
				...extra,
				idempotencyKey: randomUUID(),
			}),
		});
		assert.equal(denied.status, 403);
	}
	assert.equal(
		messages.length,
		before,
		"rejected requests must have zero provider writes",
	);
	receipt = {
		schemaVersion: 1,
		runId,
		status: "passed",
		scope: "isolated_fixture",
		participants,
		messages,
		providerWrites: messages.length,
		replayDeduped: true,
		foreignRejected: true,
		realDiscordVerified: false,
		productionActivation: false,
	};
} finally {
	for (const sender of senders) sender.close();
	dedup?.close();
	if (server)
		await new Promise((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	rmSync(root, { recursive: true, force: true });
}
assert.ok(receipt);
assert.equal(existsSync(root), false);
console.log(
	JSON.stringify({
		...receipt,
		bridgeClosed: !server.listening,
		rootRemoved: !existsSync(root),
	}),
);
