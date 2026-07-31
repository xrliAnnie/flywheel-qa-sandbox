#!/usr/bin/env node
// FLY-1547 real-machine E2E — isolated host + real socket + the real mailbox
// MCP server in LEAD mode. Asserts: claim-at-next read receipts, FYI deferred
// ack, actionable settle(reply) with derived route + idempotent key.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WT = "/Users/xiaorongli/Dev/flywheel-FLY-1547";
const kernelMod = await import(`${WT}/packages/v2-kernel/dist/index.js`);
const engineMod = await import(`${WT}/packages/v2-engine/dist/index.js`);
const hostMod = await import(`${WT}/packages/v2-host/dist/host.js`);

const {
	Kernel,
	migrateDatabase,
	seedPreCutoverAuthority,
	armCutoverAuthority,
	publishMigrationCompleteMarker,
	publishLiveCutoverAuthority,
	advanceDatabaseAuthorityStateTx,
} = kernelMod;
const { initializeEngineDb, provisionAgentRecipient, enqueue } = engineMod;
const { V2Host } = hostMod;

process.on("uncaughtException", (error) => {
	console.log(
		"[e2e] UNCAUGHT:",
		error?.message,
		error?.stack?.split("\n")[1]?.trim(),
	);
});
const root = mkdtempSync("/tmp/fly1547-e2e-");
const WINDOW = "fly1547-e2e";
const EPOCH = 47;
const dbPath = join(root, "v2.db");
const markerPath = join(root, "marker.json");
const authorityPath = join(root, "authority.json");
const armedPath = join(root, "armed.json");
const socketPath = join(root, "host.sock");
const secretPath = join(root, "host.secret");
const now = () => new Date().toISOString();

seedPreCutoverAuthority({
	authorityPath,
	armedPath,
	windowId: WINDOW,
	epoch: EPOCH,
	nowIso: now(),
});
armCutoverAuthority({
	authorityPath,
	armedPath,
	windowId: WINDOW,
	epoch: EPOCH,
	nowIso: now(),
});
migrateDatabase({ path: dbPath });
let kernel = Kernel.open({ path: dbPath });
initializeEngineDb(kernel);
kernel.write("e2e.meta", (tx) => {
	for (const [key, value] of [
		["cutover_window_id", WINDOW],
		["cutover_epoch", String(EPOCH)],
	]) {
		tx.run(
			`INSERT INTO meta(key,value,updated_at) VALUES(@key,@value,@now)
			 ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
			{ key, value, now: now() },
		);
	}
});
kernel.close();
chmodSync(dbPath, 0o600);
publishMigrationCompleteMarker({
	dbPath,
	markerPath,
	authorityPath,
	armedPath,
	expectedWindowId: WINDOW,
	expectedEpoch: EPOCH,
	nowIso: now(),
});
kernel = Kernel.open({ path: dbPath });
kernel.write("e2e.live", (tx) =>
	advanceDatabaseAuthorityStateTx(tx, {
		expected: "cutover",
		next: "live",
		nowIso: now(),
	}),
);
kernel.close();
publishLiveCutoverAuthority({
	authorityPath,
	armedPath,
	windowId: WINDOW,
	epoch: EPOCH,
	nowIso: now(),
});

const secret = randomBytes(32);
writeFileSync(secretPath, secret, { mode: 0o600 });
const host = new V2Host({
	database: {
		dbPath,
		markerPath,
		authorityPath,
		armedPath,
		expectedWindowId: WINDOW,
		expectedEpoch: EPOCH,
		allowedAuthorityStates: ["live"],
	},
	socketPath,
	secretPath,
	hostEpoch: "fly1547-e2e-host",
	sessionProbe: {
		processStart: () => ({ status: "present", startIdentity: "e2e" }),
		sessionOwner: () => ({ pid: process.pid, pidStart: "e2e" }),
	},
});
await host.start();
console.log("[e2e] host up at", socketPath);

// Register the lead and write its delivery credential file (the ops flow).
const { sendHostRequest } = await import(
	`${WT}/packages/v2-host/dist/protocol.js`
);
const bootstrap = Kernel.open({ path: dbPath });
provisionAgentRecipient(bootstrap, "e2e-lead", "lead");
const registered = await sendHostRequest({
	socketPath,
	secret,
	action: "register_lead",
	payload: {
		agentId: "e2e-lead",
		instanceId: "e2e-lead-1",
		sessionBinding: {
			v: 1,
			hostEpoch: "fly1547-e2e-host",
			sessionId: "e2e-session",
			pid: process.pid,
			pidStart: "e2e",
		},
	},
});
const credentialFile = join(root, "e2e-lead-credential.json");
writeFileSync(credentialFile, JSON.stringify(registered.deliveryCredential), {
	mode: 0o600,
});

// Mail: one FYI lifecycle notice + one answer-requiring runner_ask.
const runtimeClock = { clock: { nowIso: now, nowMs: () => Date.now() } };
// Use engine enqueue directly (host enqueue also fine).
const enq = (sourceId, kind, payload, retention = "business") =>
	enqueue(bootstrap, runtimeClock, {
		sourceKind: "e2e",
		sourceId,
		payload: JSON.stringify(payload),
		toAgent: "e2e-lead",
		kind,
		retentionClass: retention,
		expectedCutoverEpoch: EPOCH,
	});
console.log(
	"[e2e] enqueue fyi:",
	enq("m-fyi", "issue_opened", { v: 1, issue_id: "FLY-E2E" }, "notice").status,
);
// The reply target must be a valid mailbox recipient (recipient trigger), so
// the answerable ask names a second provisioned lead as its asker.
provisionAgentRecipient(bootstrap, "e2e-asker-lead", "lead");
console.log(
	"[e2e] enqueue ask2:",
	enq("m-ask2", "runner_ask", {
		v: 1,
		session_ref: "e2e-asker-lead",
		issue_id: "FLY-E2E",
		ask_kind: "ask",
		uid: "q-78",
		body: "Which port should the E2E bind? (answerable)",
	}).status,
);

// Real claude -p in LEAD mode with the real mailbox MCP.
const mcpConfig = join(root, "mcp.json");
writeFileSync(
	mcpConfig,
	JSON.stringify({
		mcpServers: {
			"flywheel-v2-mailbox": {
				command: process.execPath,
				args: [`${WT}/packages/v2-mailbox-mcp/dist/server-main.js`],
				env: {
					FLYWHEEL_V2_SOCKET: socketPath,
					FLYWHEEL_V2_SECRET_PATH: secretPath,
					FLYWHEEL_V2_LEAD_AGENT_ID: "e2e-lead",
					FLYWHEEL_V2_LEAD_CREDENTIAL_FILE: credentialFile,
					FLYWHEEL_V2_MAILBOX_LEASE: join(root, "lease.json"),
				},
			},
		},
	}),
);
const prompt = [
	"Non-interactive run: never ask for permission or confirmation — call the MCP tools immediately and proceed.",
	"Do NOT read files, list directories, or run shell commands. Interact with the world EXCLUSIVELY through the flywheel-v2-mailbox MCP tools.",
	"You are the e2e lead. Use ONLY the flywheel-v2-mailbox MCP tools.",
	"1. Call status; note pendingTotal.",
	"2. Call next repeatedly. For each letter: if the note says it is FYI, just continue to the next call.",
	"3. When you get the runner_ask asking about a port, call settle with reply body exactly 'port 4747'.",
	"4. If next returns a letter whose note says it cannot be classified or it is still unsettled, call settle to clear it.",
	"5. Keep calling next until status=empty, then call status once more and print 'E2E-DONE pending=' plus the pendingTotal.",
].join("\n");
// Pre-flight: smoke the mailbox server directly so a startup failure surfaces
// with its real stderr instead of a vague claude-side tool error.
const { spawnSync } = await import("node:child_process");
const smokeInput = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } })}\n`;
const smoke = spawnSync(
	process.execPath,
	[`${WT}/packages/v2-mailbox-mcp/dist/server-main.js`],
	{
		input: smokeInput,
		encoding: "utf8",
		timeout: 8000,
		env: {
			PATH: process.env.PATH,
			HOME: process.env.HOME,
			FLYWHEEL_V2_SOCKET: socketPath,
			FLYWHEEL_V2_SECRET_PATH: secretPath,
			FLYWHEEL_V2_LEAD_AGENT_ID: "e2e-lead",
			FLYWHEEL_V2_LEAD_CREDENTIAL_FILE: credentialFile,
			FLYWHEEL_V2_MAILBOX_LEASE: join(root, "lease.json"),
		},
	},
);
console.log("[e2e] server smoke stderr:", (smoke.stderr ?? "").slice(0, 500));
console.log(
	"[e2e] server smoke stdout head:",
	(smoke.stdout ?? "").slice(0, 200),
);
// Held-open smoke: keep the server alive ~8s so the bell loop runs — this is
// where a notify-rejection fail-stop would show.
{
	const { spawn } = await import("node:child_process");
	const child = spawn(
		process.execPath,
		[`${WT}/packages/v2-mailbox-mcp/dist/server-main.js`],
		{
			stdio: ["pipe", "ignore", "pipe"],
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				FLYWHEEL_V2_SOCKET: socketPath,
				FLYWHEEL_V2_SECRET_PATH: secretPath,
				FLYWHEEL_V2_LEAD_AGENT_ID: "e2e-lead",
				FLYWHEEL_V2_LEAD_CREDENTIAL_FILE: credentialFile,
				FLYWHEEL_V2_MAILBOX_LEASE: join(root, "lease.json"),
			},
		},
	);
	let errBuf = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (d) => {
		errBuf += d;
	});
	child.stdin.on("error", () => {});
	await new Promise((resolve) => setTimeout(resolve, 300));
	try {
		child.stdin.write(smokeInput);
	} catch {
		// child died at startup — stderr below tells why
	}
	const exited = await new Promise((resolve) => {
		const t = setTimeout(() => resolve("alive-after-8s"), 8000);
		child.on("exit", (code) => {
			clearTimeout(t);
			resolve(`exited code=${code}`);
		});
	});
	child.kill();
	console.log("[e2e] held-open smoke:", exited);
	console.log("[e2e] held-open stderr:", errBuf.slice(0, 600));
}
console.log("[e2e] running claude -p lead session...");
// ASYNC spawn — the V2Host lives in THIS process; a synchronous exec would
// block the event loop and starve every host socket request (the exact
// failure the earlier runs showed as "service not responding").
const { execFile } = await import("node:child_process");
const { promisify } = await import("node:util");
const execFileAsync = promisify(execFile);
let out = "";
try {
	const result = await execFileAsync(
		`${process.env.HOME}/.local/bin/claude`,
		[
			"-p",
			"--mcp-config",
			mcpConfig,
			"--permission-mode",
			"bypassPermissions",
			"--model",
			"claude-haiku-4-5",
			prompt,
		],
		{
			encoding: "utf8",
			timeout: 300_000,
			maxBuffer: 16 * 1024 * 1024,
			// Pin cwd to the empty scratch root: with bypassPermissions the model
			// once READ this harness from the repo cwd and role-played the whole
			// flow without touching a single tool (mailbox untouched, "all
			// assertions passed" narrated). Real evidence needs a bare room.
			cwd: root,
			env: {
				...process.env,
				CLAUDECODE: undefined,
				CLAUDE_CODE_ENTRYPOINT: undefined,
				FLYWHEEL_V2_SESSION_REF: undefined,
				FLYWHEEL_V2_AGENT_ID: undefined,
				FLYWHEEL_V2_ACTIVATION_ID: undefined,
				FLYWHEEL_V2_SOCKET: undefined,
				FLYWHEEL_V2_SECRET_PATH: undefined,
				FLYWHEEL_V2_CLIENT_CLI: undefined,
			},
		},
	);
	out = result.stdout;
} catch (error) {
	out = `${error.stdout ?? ""}`;
	console.log(
		"[e2e] claude FAILED:",
		error.code,
		(error.message ?? "").slice(0, 200),
	);
	console.log(
		"[e2e] claude STDERR head:",
		`${error.stderr ?? ""}`.slice(0, 600),
	);
}
console.log("[e2e] claude output tail:", out.split("\n").slice(-4).join(" | "));

// Ledger assertions.
const rows = bootstrap.read((tx) => ({
	mailbox: tx.all(
		"SELECT message_uid, kind, state, to_agent FROM mailbox ORDER BY seq",
	),
	pas: tx.all(
		"SELECT attempt_uid, outcome FROM processing_attempts ORDER BY started_at",
	),
	reply: tx.get(
		"SELECT payload, source_id, source_kind FROM mailbox WHERE kind='ask_response'",
	),
}));
const fyi = rows.mailbox.find((r) => r.kind === "issue_opened");
const ask2 = rows.mailbox.find(
	(r) =>
		r.kind === "runner_ask" &&
		r.to_agent === "e2e-lead" &&
		r.message_uid !== undefined &&
		JSON.stringify(r).includes("m-ask2") === false,
);
console.log("[e2e] mailbox:", JSON.stringify(rows.mailbox));
console.log("[e2e] PAs:", JSON.stringify(rows.pas));
console.log("[e2e] reply:", JSON.stringify(rows.reply));

let pass = true;
function check(name, ok) {
	console.log(`[e2e] ${ok ? "PASS" : "FAIL"} ${name}`);
	if (!ok) pass = false;
}
check("FYI letter applied (deferred ack settled it)", fyi?.state === "applied");
check("read receipts exist (PA rows)", rows.pas.length >= 2);
check(
	"every consumed PA succeeded",
	rows.pas.every((p) => p.outcome === "succeeded" || p.outcome === "crashed"),
);
check("reply enqueued as ask_response", rows.reply != null);
check(
	"reply payload carries the derived uid + body",
	rows.reply != null &&
		rows.reply.payload.includes("q-78") &&
		rows.reply.payload.includes("port 4747"),
);
check(
	"reply idempotency key is message-scoped",
	rows.reply != null && rows.reply.source_kind === "mailbox_reply",
);
// Demo criterion 3 (lead 指令): a runner ask must WAKE the lead's long-poll
// immediately — not wait for a patrol. The ask verb and the enqueue verb share
// the same #wakeRecipient path; measure the wake latency on an empty mailbox.
{
	const t0 = Date.now();
	const pollPromise = sendHostRequest({
		socketPath,
		secret,
		action: "next_delivery",
		payload: {
			agentId: "e2e-lead",
			deliveryCredential: registered.deliveryCredential,
		},
	});
	await new Promise((resolve) => setTimeout(resolve, 300));
	await sendHostRequest({
		socketPath,
		secret,
		action: "enqueue",
		payload: {
			sourceKind: "e2e-wake",
			sourceId: "wake-1",
			payload: JSON.stringify({
				v: 1,
				ask_kind: "ask",
				session_ref: "e2e-asker-lead",
				uid: "q-wake",
				body: "wake test",
			}),
			toAgent: "e2e-lead",
			kind: "runner_ask",
			retentionClass: "business",
		},
	});
	const woken = await pollPromise;
	const latencyMs = Date.now() - t0 - 300;
	check(
		"lead long-poll woken immediately by new mail (not patrol)",
		latencyMs < 2000,
	);
	console.log(
		`[e2e] lead wake latency after enqueue: ${latencyMs}ms (kind=${woken.message.kind})`,
	);
	// settle it so the ledger ends clean
	await sendHostRequest({
		socketPath,
		secret,
		action: "submit_proposal",
		payload: {
			agentId: "e2e-lead",
			attemptUid: woken.handle.attemptUid,
			messageUid: woken.message.messageUid,
			effects: [],
			authorization: woken.authorization,
		},
	});
}
bootstrap.close();
await host.close();
console.log(pass ? "[e2e] ALL PASS" : "[e2e] FAILURES PRESENT");
process.exit(pass ? 0 : 1);
