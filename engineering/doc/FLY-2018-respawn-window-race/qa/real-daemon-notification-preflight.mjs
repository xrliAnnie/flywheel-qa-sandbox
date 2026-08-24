// FLY-2018 implementation preflight: observe the real Codex app-server
// notification and turn/start response shapes for an isolated revoked-token
// failure. Credential values never leave the temporary CODEX_HOME.
import { spawnCodexDaemon } from "../../../../packages/claude-runner/dist/codex-daemon-runtime.js";
import { connectDaemonTransport } from "../../../../packages/claude-runner/dist/codex-daemon-transport.js";
import {
	CodexDaemonClient,
	runGoalToTerminal,
} from "../../../../packages/claude-runner/dist/codex-daemon-client.js";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const codexBin =
	process.env.FLY2018_CODEX_BIN ?? join(homedir(), ".local", "bin", "codex");
const sourceHome =
	process.env.FLY2018_CODEX_SOURCE_HOME ?? join(homedir(), ".codex");
const scratch = mkdtempSync(join(tmpdir(), "fly2018-protocol-"));
const codexHome = join(scratch, "codex-home");
const worktree = join(scratch, "work");
const socketDir = join(scratch, "s");
const socketPath = join(socketDir, "c.sock");
const daemonTmp = join(scratch, "tmp");

mkdirSync(codexHome, { recursive: true, mode: 0o700 });
mkdirSync(worktree, { recursive: true });
mkdirSync(socketDir, { recursive: true, mode: 0o700 });
mkdirSync(daemonTmp, { recursive: true, mode: 0o700 });
copyFileSync(join(sourceHome, "config.toml"), join(codexHome, "config.toml"));

const auth = JSON.parse(readFileSync(join(sourceHome, "auth.json"), "utf8"));
if (
	typeof auth?.tokens?.access_token !== "string" ||
	typeof auth?.tokens?.refresh_token !== "string"
) {
	throw new Error("source auth.json does not contain token credentials");
}

const jwt = auth.tokens.access_token.split(".");
if (jwt.length !== 3) throw new Error("source access token is not a JWT");
const payload = JSON.parse(Buffer.from(jwt[1], "base64url").toString("utf8"));
payload.exp = 1;
payload.iat = 1;
jwt[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
auth.tokens.access_token = jwt.join(".");
auth.tokens.refresh_token = "fly2018-intentionally-revoked-refresh-token";
auth.last_refresh = "1970-01-01T00:00:01.000Z";
writeFileSync(join(codexHome, "auth.json"), `${JSON.stringify(auth)}\n`, {
	mode: 0o600,
});
writeFileSync(join(worktree, "README.md"), "FLY-2018 protocol preflight\n");

let sequence = 0;
const observed = [];
const record = (kind, value) => {
	sequence += 1;
	const entry = { sequence, kind, value: sanitize(value) };
	observed.push(entry);
	console.log(JSON.stringify(entry));
};

let daemon;
let transport;
try {
	daemon = await spawnCodexDaemon({
		codexBin,
		codexHome,
		socketPath,
		sandboxWritableRoots: [worktree, scratch],
		sandboxNetworkAccess: true,
		env: {
			PATH: process.env.PATH,
			HOME: scratch,
			TMPDIR: daemonTmp,
		},
		logger: (message) => record("daemon-log", message),
	});

	transport = await connectDaemonTransport({ socketPath });
	const client = new CodexDaemonClient({
		transport,
		logger: (message) => record("client-log", message),
	});
	await client.initialize();
	const threadId = await client.startThread({
		cwd: worktree,
		sandbox: "workspace-write",
		approvalPolicy: "never",
		baseInstructions: "This is an isolated protocol probe. Reply with DONE.",
	});
	record("thread-started", { threadId });

	// TypeScript's private modifier is compile-time only. This probe deliberately
	// calls the real request seam so it can observe the response that the current
	// public startTurn wrapper discards.
	const request = client.request.bind(client);
	client.startTurn = async (
		ownedThreadId,
		text,
		timeoutMs,
		clientUserMessageId,
	) => {
		const response = await request(
			"turn/start",
			{
				threadId: ownedThreadId,
				input: [{ type: "text", text }],
				...(clientUserMessageId ? { clientUserMessageId } : {}),
			},
			timeoutMs,
		);
		record("turn-start-response", response.result);
	};

	const result = await runGoalToTerminal(
		client,
		{
			threadId,
			objective: "Observe one isolated revoked-token turn failure, then stop.",
			kickText: "Reply with DONE.",
			overallTimeoutMs: 90_000,
			pollIntervalMs: 1_000,
		},
		{
			onNotification: (method, params) => {
				if (method.startsWith("turn/") || method.includes("goal")) {
					record("notification", { method, params });
				}
			},
			onGoalUpdate: (notification) => record("goal-update", notification),
		},
	);
	record("run-result", result);

	const turnResponse = observed.find(
		(entry) => entry.kind === "turn-start-response",
	);
	const completed = observed.find(
		(entry) =>
			entry.kind === "notification" &&
			entry.value?.method === "turn/completed",
	);
	if (!turnResponse) throw new Error("turn/start response was not observed");
	if (!completed) throw new Error("turn/completed notification was not observed");
} finally {
	try {
		transport?.close();
	} catch {}
	try {
		daemon?.stop();
		await daemon?.ensureDead();
	} catch {}
	rmSync(scratch, { recursive: true, force: true });
}

function sanitize(value, key = "") {
	if (/token|secret|authorization|cookie/i.test(key)) return "<redacted>";
	if (Array.isArray(value)) return value.map((item) => sanitize(item));
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([childKey, childValue]) => [
				childKey,
				sanitize(childValue, childKey),
			]),
		);
	}
	if (typeof value === "string" && value.length > 600) {
		return `${value.slice(0, 600)}…`;
	}
	return value;
}
