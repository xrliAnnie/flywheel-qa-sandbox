#!/usr/bin/env node
// Offline protocol receipt: fake key, isolated home, no thread/realtime requests.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CodexLeadProcess,
	spawnCodexAppServer,
} from "../packages/teamlead/dist/codex-process.js";
import {
	assertVoiceCodexHome,
	VOICE_CODEX_HOME_CONFIG,
} from "../packages/voice-codex/dist/codex-home.js";
import { voiceCodexEnv } from "../packages/voice-codex/dist/config.js";
import { RealtimeFrontend } from "../packages/voice-codex/dist/realtime.js";

const bin = process.argv[2] ?? "codex";
const version = execFileSync(bin, ["--version"], {
	encoding: "utf8",
	timeout: 5_000,
}).trim();
assert.equal(
	version,
	"codex-cli 0.153.2",
	"local receipt requires the approved binary version",
);
const root = mkdtempSync(join(tmpdir(), "voice-api-auth-local-"));
const home = join(root, "codex-home");
mkdirSync(home, { mode: 0o700 });
writeFileSync(join(home, "config.toml"), VOICE_CODEX_HOME_CONFIG, {
	mode: 0o600,
});
const env = voiceCodexEnv({
	HOME: root,
	PATH: process.env.PATH,
	HTTPS_PROXY: "http://127.0.0.1:9",
	HTTP_PROXY: "http://127.0.0.1:9",
	ALL_PROXY: "http://127.0.0.1:9",
	OPENAI_API_KEY: "must-not-reach-child",
	TEAMLEAD_API_TOKEN: "must-not-reach-child",
	DISCORD_BOT_TOKEN: "must-not-reach-child",
});
assert.equal(env.OPENAI_API_KEY, undefined);
assert.equal(env.TEAMLEAD_API_TOKEN, undefined);
assert.equal(env.DISCORD_BOT_TOKEN, undefined);
const shim = join(root, "checked-codex");
const quotedBin = `'${bin.replaceAll("'", "'\"'\"'")}'`;
writeFileSync(
	shim,
	`#!/bin/sh
for name in OPENAI_API_KEY TEAMLEAD_API_TOKEN DISCORD_BOT_TOKEN LINEAR_API_KEY LEAD_TOKEN GH_TOKEN; do
  if /usr/bin/printenv "$name" >/dev/null 2>&1; then exit 93; fi
done
exec ${quotedBin} "$@"
`,
	{ mode: 0o700 },
);
function client() {
	return new CodexLeadProcess({
		experimentalApi: true,
		requestTimeoutMs: 5_000,
		maxStderrBytes: 0,
		logger: { warn() {}, error() {} },
		spawnChild: () =>
			spawnCodexAppServer({
				codexBin: shim,
				codexHome: home,
				mcpArgv: [],
				baseEnv: env,
			}),
	});
}
const first = client();
const second = client();
let interceptedThread = false;
try {
	assertVoiceCodexHome(home);
	const frontend = new RealtimeFrontend({
		apiKey: "sk-voice-local-fixture-not-a-real-key",
		cwd: root,
		voice: "marin",
		displayName: "local-fixture",
		process: {
			start: () => first.start(),
			request: (method, params) => first.request(method, params),
			notify: (method, params) => first.notify(method, params),
			on: (event, callback) => first.on(event, callback),
			stop: () => first.stop(),
			startThreadWithResult: async () => {
				interceptedThread = true;
				throw new Error("local_probe_complete");
			},
		},
		onTranscript() {},
		onAudio() {},
		onClosed() {},
		onFrontendDelegation() {},
	});
	await assert.rejects(frontend.start(), /^Error: realtime_thread_start$/);
	assert.equal(
		interceptedThread,
		true,
		"API auth must finish before the intercepted thread request",
	);
	assert.equal(
		existsSync(join(home, "auth.json")),
		false,
		"ephemeral login must not write an auth file",
	);
	await frontend.stop();
	await second.start();
	const afterRestart = await second.request("account/read", {
		refreshToken: false,
	});
	assert.equal(afterRestart.error, undefined);
	assert.equal(
		afterRestart.result?.account,
		null,
		"a new process must not inherit the first key",
	);
	assertVoiceCodexHome(home);
	const inspect = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) inspect(path);
			else if (entry.isFile())
				assert.equal(
					readFileSync(path).includes(
						Buffer.from("sk-voice-local-fixture-not-a-real-key"),
					),
					false,
					"fixture credential must not persist anywhere in the temporary home",
				);
		}
	};
	inspect(home);
	console.log(
		JSON.stringify({
			version,
			apiAuthReceipt: true,
			threadRequests: 0,
			realtimeRequests: 0,
			persistedAuth: false,
			credentialBytesPersisted: false,
			actualChildEnvClean: true,
			restartUnauthenticated: true,
		}),
	);
} finally {
	await first.stop();
	await second.stop();
	rmSync(root, { recursive: true, force: true });
}
