#!/usr/bin/env node
// Offline direct-Realtime protocol receipt. The fixture key never reaches the network.
import assert from "node:assert/strict";
import { once } from "node:events";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RealtimeFrontend } from "../packages/voice-codex/dist/realtime.js";
import { OPENAI_REALTIME_URL } from "../packages/voice-codex/dist/realtime-transport.js";

const requireFromVoiceCodex = createRequire(
	new URL("../packages/voice-codex/package.json", import.meta.url),
);
const wsModule = requireFromVoiceCodex("ws");
const WebSocket = wsModule.WebSocket ?? wsModule;
const { WebSocketServer } = wsModule;
const fixtureKey = "sk-voice-local-fixture-not-a-real-key";
const root = mkdtempSync(join(tmpdir(), "voice-api-auth-local-"));
const http = createServer();
const wss = new WebSocketServer({ server: http });
let authorization;
let update;
let upstream;
wss.on("connection", (socket, request) => {
	upstream = socket;
	authorization = request.headers.authorization;
	socket.send(
		JSON.stringify({
			type: "session.created",
			session: { id: "offline-session", model: "gpt-realtime-1.5" },
		}),
	);
	socket.on("message", (data) => {
		const event = JSON.parse(data.toString());
		if (event.type !== "session.update") return;
		update = event;
		socket.send(
			JSON.stringify({
				type: "session.updated",
				session: {
					id: "offline-session",
					model: "gpt-realtime-1.5",
					...event.session,
				},
			}),
		);
	});
});

let requestedUrl;
let socketOptions;
let closed;
try {
	http.listen(0, "127.0.0.1");
	await once(http, "listening");
	const address = http.address();
	assert(address && typeof address !== "string");
	const localUrl = `ws://127.0.0.1:${address.port}`;
	const frontend = new RealtimeFrontend({
		apiKey: fixtureKey,
		voice: "marin",
		displayName: "offline-fixture",
		minimumSessionLifetimeMs: 0,
		socketFactory: (url, options) => {
			requestedUrl = url;
			socketOptions = options;
			return new WebSocket(localUrl, options);
		},
		onTranscript() {},
		onSpeechAudioReady() {},
		onSpeechResult() {},
		onClosed(outcome) {
			closed?.(outcome);
		},
	});
	await frontend.start();
	assert.equal(requestedUrl, OPENAI_REALTIME_URL);
	assert.deepEqual(socketOptions.headers, {
		Authorization: `Bearer ${fixtureKey}`,
	});
	assert.equal(socketOptions.followRedirects, false);
	assert.equal(authorization, `Bearer ${fixtureKey}`);
	assert.equal(update.type, "session.update");
	assert.equal(Object.hasOwn(update.session, "model"), false);
	const closedReceipt = new Promise((resolve) => {
		closed = resolve;
	});
	upstream.send(
		JSON.stringify({
			type: "error",
			error: { message: fixtureKey },
		}),
	);
	const outcome = await closedReceipt;
	assert.deepEqual(outcome, { kind: "failed", reason: "realtime_protocol" });
	assert.equal(JSON.stringify(outcome).includes(fixtureKey), false);
	await frontend.stop();

	const inspect = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) inspect(path);
			else if (entry.isFile() && statSync(path).size > 0) {
				assert.equal(
					readFileSync(path).includes(Buffer.from(fixtureKey)),
					false,
					"fixture credential must not persist",
				);
			}
		}
	};
	inspect(root);
	console.log(
		JSON.stringify({
			transport: "openai_realtime_direct",
			offlineProtocolReceipt: true,
			fixedEndpoint: true,
			redirectsDisabled: true,
			apiRequests: 0,
			codexProcesses: 0,
			persistedAuth: false,
			credentialBytesPersisted: false,
			errorRedacted: true,
		}),
	);
} finally {
	for (const client of wss.clients) client.terminate();
	await new Promise((resolve) => wss.close(resolve));
	await new Promise((resolve) => http.close(resolve));
	rmSync(root, { recursive: true, force: true });
}
