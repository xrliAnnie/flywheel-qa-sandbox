#!/usr/bin/env bun
// Send M4 and observe its first complete barrier in one process. This avoids
// mistaking a timeout-left stale barrier for a live crash window.
import { Database } from "bun:sqlite";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const [leadWindow, oldPanePid, outputDir] = process.argv.slice(2);
if (!leadWindow || !oldPanePid || !outputDir) {
	throw new Error(
		"usage: s2b-discord-crash.ts LEAD_WINDOW OLD_PANE_PID OUTPUT_DIR",
	);
}
const token = process.env.TEST_BOT_TOKEN_2;
if (!token) throw new Error("TEST_BOT_TOKEN_2 is required");

const slotDir = "/tmp/flywheel-test-slot-1";
const channelId = "1504277055406211142";
const dbPath =
	"/Users/xiaorongli/.flywheel/comm/test-slot-1/comm.db";
const content =
	"FLY-1439 S2b M4 integrated final: notify-to-complete crash window. " +
	"Test message: do not reply. A forced Lead crash and recovery redelivery are expected.";
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
	join(outputDir, "s2b-m4-inbound.json"),
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
	`shim-barrier-complete-${messageId}.json`,
);
const ledgerPath = join(slotDir, "shim-ledger.jsonl");
const modePath = join(slotDir, "shim-mode");
const waitDeadline = performance.now() + 5_000;
while (!existsSync(barrierPath) && performance.now() < waitDeadline) {
	await Bun.sleep(5);
}
if (!existsSync(barrierPath)) {
	throw new Error(`live barrier not observed: ${barrierPath}`);
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
	barrier.sub !== "complete" ||
	barrier.msgId !== messageId ||
	!Number.isSafeInteger(barrier.shimPid) ||
	typeof barrier.callId !== "string"
) {
	throw new Error("barrier identity mismatch");
}
const barrierAgeMs = barrierWallAt - Date.parse(barrier.ts);
if (!Number.isFinite(barrierAgeMs) || barrierAgeMs < 0 || barrierAgeMs >= 2_000) {
	throw new Error(`barrier was not live/fresh: age=${barrierAgeMs}ms`);
}
writeFileSync(join(outputDir, "s2b-barrier.json"), barrierRaw, {
	mode: 0o600,
});

const ledgerRows = readFileSync(ledgerPath, "utf8")
	.trim()
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line) as Record<string, unknown>)
	.filter((row) => row.callId === barrier.callId);
writeFileSync(
	join(outputDir, "s2b-barrier-ledger.jsonl"),
	`${ledgerRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
);
if (ledgerRows.length !== 1 || ledgerRows[0]?.phase !== "start") {
	throw new Error("barrier call was not start-without-end");
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
	join(outputDir, "s2b-kill-db-snapshot.json"),
	`${JSON.stringify(row ? [row] : [], null, 2)}\n`,
);
if (
	!row ||
	row.carrier !== "external" ||
	row.delivered_at !== null ||
	row.processed_at !== null
) {
	throw new Error("kill snapshot was not a pending external receipt");
}

renameSync(modePath, join(outputDir, "s2b-triggered-mode.txt"));
const killAt = performance.now();
const barrierToKillMs = killAt - barrierSeenAt;
const timingPath = join(outputDir, "s2b-crash-timing.txt");
writeFileSync(
	timingPath,
	[
		`message_id=${messageId}`,
		`call_id=${barrier.callId}`,
		`shim_pid=${barrier.shimPid}`,
		`old_window=${leadWindow}`,
		`old_pane_pid=${oldPanePid}`,
		`barrier_ts=${barrier.ts}`,
		`barrier_observed_wall_ms=${barrierWallAt}`,
		`barrier_age_at_observation_ms=${barrierAgeMs}`,
		`kill_wall_ms=${Date.now()}`,
		`barrier_to_kill_ms=${barrierToKillMs.toFixed(3)}`,
		"kill_command_status=pending",
		"",
	].join("\n"),
);
if (barrierToKillMs >= 2_000) {
	throw new Error(`barrier-to-kill budget missed: ${barrierToKillMs}ms`);
}

const killed = Bun.spawnSync([
	"tmux",
	"kill-window",
	"-t",
	`flywheel:${leadWindow}`,
]);
writeFileSync(
	timingPath,
	`${readFileSync(timingPath, "utf8")}kill_command_final_status=${killed.exitCode}\n`,
);
if (killed.exitCode !== 0) {
	throw new Error(
		`tmux kill-window failed: ${killed.stderr.toString().trim()}`,
	);
}
process.stdout.write(`${messageId}\n`);
