#!/usr/bin/env bun
// Send M5, observe the first live settle barrier, preserve write-ahead proof,
// restore passthrough, then delegate the exact MCP/window crash to an
// unsandboxed tmux helper.
import { Database } from "bun:sqlite";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [leadWindow, oldPanePid, mcpPidText, outputDir] =
	process.argv.slice(2);
const mcpPid = Number(mcpPidText);
if (
	!leadWindow ||
	!oldPanePid ||
	!Number.isSafeInteger(mcpPid) ||
	mcpPid <= 1 ||
	!outputDir
) {
	throw new Error(
		"usage: s2c-discord-crash.ts LEAD_WINDOW OLD_PANE_PID MCP_PID OUTPUT_DIR",
	);
}
const token = process.env.TEST_BOT_TOKEN_2;
if (!token) throw new Error("TEST_BOT_TOKEN_2 is required");

const slotDir = "/tmp/flywheel-test-slot-1";
const channelId = "1504277055406211142";
const dbPath =
	"/Users/xiaorongli/.flywheel/comm/test-slot-1/comm.db";
const content =
	"FLY-1439 S2c M5 settle write-ahead crash window. " +
	"Please reply directly to this exact Discord message with: S2c M5 replied. Use reply_to.";
mkdirSync(outputDir, { recursive: true });

const response = await fetch(
	`https://discord.com/api/v10/channels/${channelId}/messages`,
	{
		method: "POST",
		headers: {
			Authorization: `Bot ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ content }),
	},
);
if (!response.ok) {
	throw new Error(`Discord send failed: HTTP ${response.status}`);
}
const sent = (await response.json()) as {
	id: string;
	channel_id: string;
	author: { id: string; username: string; bot: boolean };
	content: string;
	message_reference?: unknown;
};
const messageId = sent.id;
writeFileSync(
	join(outputDir, "s2c-m5-inbound.json"),
	`${JSON.stringify(
		{
			id: sent.id,
			channel_id: sent.channel_id,
			author: {
				id: sent.author.id,
				username: sent.author.username,
				bot: sent.author.bot,
			},
			content: sent.content,
			message_reference: sent.message_reference ?? null,
		},
		null,
		2,
	)}\n`,
);

const barrierPath = join(
	slotDir,
	`shim-barrier-settle-${messageId}.json`,
);
const settleIntentPath = join(
	slotDir,
	"discord-state",
	"chat-receipt-spool",
	"settle",
	`${messageId}.json`,
);
const ledgerPath = join(slotDir, "shim-ledger.jsonl");
const modePath = join(slotDir, "shim-mode");
const waitDeadline = performance.now() + 180_000;
while (!existsSync(barrierPath) && performance.now() < waitDeadline) {
	await Bun.sleep(10);
}
if (!existsSync(barrierPath)) {
	throw new Error(`live settle barrier not observed: ${barrierPath}`);
}

const barrierSeenAt = performance.now();
const barrierWallAt = Date.now();
const barrierRaw = readFileSync(barrierPath, "utf8");
const barrier = JSON.parse(barrierRaw) as {
	shimPid: number;
	callId: string;
	sub: string;
	msgId: string;
	ts: string;
};
if (
	barrier.sub !== "settle" ||
	barrier.msgId !== messageId ||
	!Number.isSafeInteger(barrier.shimPid) ||
	typeof barrier.callId !== "string"
) {
	throw new Error("settle barrier identity mismatch");
}
const barrierAgeMs = barrierWallAt - Date.parse(barrier.ts);
if (!Number.isFinite(barrierAgeMs) || barrierAgeMs < 0 || barrierAgeMs >= 2_000) {
	throw new Error(`settle barrier was not live/fresh: age=${barrierAgeMs}ms`);
}
writeFileSync(join(outputDir, "s2c-barrier.json"), barrierRaw, {
	mode: 0o600,
});

if (!existsSync(settleIntentPath)) {
	throw new Error("write-ahead settle intent was absent at the barrier");
}
const settleIntentRaw = readFileSync(settleIntentPath, "utf8");
const settleIntentMode = statSync(settleIntentPath).mode & 0o777;
if (settleIntentMode !== 0o600) {
	throw new Error(
		`settle intent mode was ${settleIntentMode.toString(8)}, expected 600`,
	);
}
writeFileSync(
	join(outputDir, "s2c-settle-intent-at-kill.json"),
	settleIntentRaw,
	{ mode: 0o600 },
);

const settleIntent = JSON.parse(settleIntentRaw) as {
	messageId: string;
	replyId: string;
};
if (settleIntent.messageId !== messageId || !settleIntent.replyId) {
	throw new Error("settle intent identity mismatch");
}
const ledgerRows = readFileSync(ledgerPath, "utf8")
	.trim()
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line) as Record<string, unknown>)
	.filter((row) => row.callId === barrier.callId);
writeFileSync(
	join(outputDir, "s2c-barrier-ledger.jsonl"),
	`${ledgerRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
);
if (ledgerRows.length !== 1 || ledgerRows[0]?.phase !== "start") {
	throw new Error("settle barrier call was not start-without-end");
}

const db = new Database(dbPath, { readonly: true });
const row = db
	.query(
		`SELECT id,carrier,delivered_at,processed_at,next_unprocessed_at
		   FROM lead_inbox
		  WHERE id=?`,
	)
	.get(`chat:flywheel-test-1:${messageId}`) as
	| {
			id: string;
			carrier: string;
			delivered_at: string | null;
			processed_at: string | null;
			next_unprocessed_at: string | null;
	  }
	| null;
db.close();
writeFileSync(
	join(outputDir, "s2c-kill-db-snapshot.json"),
	`${JSON.stringify(row ? [row] : [], null, 2)}\n`,
);
if (!row || row.delivered_at === null || row.processed_at !== null) {
	throw new Error("settle kill snapshot was not delivered and unprocessed");
}

renameSync(modePath, join(outputDir, "s2c-triggered-mode.txt"));
const helperRequestAt = performance.now();
const helperOutput = join(outputDir, "s2c-kill-helper.txt");
const helperScript = join(
	dirname(fileURLToPath(import.meta.url)),
	"s2c-kill-mcp-window.ts",
);
const expectedMcpCommand =
	"/tmp/flywheel-test-slot-1/claude-config/plugins/cache/claude-plugins-official/discord/0.0.4/server.ts";
const helperCommand = [
	"exec",
	"bun",
	JSON.stringify(helperScript),
	String(mcpPid),
	leadWindow,
	JSON.stringify(expectedMcpCommand),
	JSON.stringify(helperOutput),
].join(" ");
const launched = Bun.spawnSync([
	"tmux",
	"new-window",
	"-d",
	"-P",
	"-F",
	"#{window_id}",
	"-n",
	"fly1439-s2c-crash",
	helperCommand,
]);
if (launched.exitCode !== 0) {
	throw new Error(
		`could not launch S2c kill helper: ${launched.stderr.toString().trim()}`,
	);
}

const helperDeadline = performance.now() + 5_000;
while (!existsSync(helperOutput) && performance.now() < helperDeadline) {
	await Bun.sleep(5);
}
if (!existsSync(helperOutput)) {
	throw new Error("S2c kill helper produced no evidence");
}
let helperText = "";
while (
	!helperText.includes("window_kill_status=") &&
	performance.now() < helperDeadline
) {
	helperText = readFileSync(helperOutput, "utf8");
	await Bun.sleep(5);
}
const values = Object.fromEntries(
	helperText
		.trim()
		.split("\n")
		.map((line) => line.split(/=(.*)/s).slice(0, 2)),
);
const signalWallMs = Number(values.signal_wall_ms);
const barrierToSignalMs = signalWallMs - barrierWallAt;
const timing = [
	`message_id=${messageId}`,
	`reply_id=${settleIntent.replyId}`,
	`call_id=${barrier.callId}`,
	`shim_pid=${barrier.shimPid}`,
	`mcp_pid=${mcpPid}`,
	`old_window=${leadWindow}`,
	`old_pane_pid=${oldPanePid}`,
	`barrier_ts=${barrier.ts}`,
	`barrier_observed_wall_ms=${barrierWallAt}`,
	`barrier_age_at_observation_ms=${barrierAgeMs}`,
	`helper_request_after_barrier_ms=${(helperRequestAt - barrierSeenAt).toFixed(3)}`,
	`mcp_signal_wall_ms=${signalWallMs}`,
	`barrier_to_mcp_signal_ms=${barrierToSignalMs}`,
	`mcp_dead=${values.mcp_dead}`,
	`window_kill_status=${values.window_kill_status}`,
	"",
].join("\n");
writeFileSync(join(outputDir, "s2c-crash-timing.txt"), timing);
if (
	!Number.isFinite(barrierToSignalMs) ||
	barrierToSignalMs < 0 ||
	barrierToSignalMs >= 2_000 ||
	values.mcp_dead !== "true" ||
	values.window_kill_status !== "0"
) {
	throw new Error(`S2c crash contract failed:\n${timing}`);
}
process.stdout.write(
	`${JSON.stringify({ messageId, replyId: settleIntent.replyId })}\n`,
);
