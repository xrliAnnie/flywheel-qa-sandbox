#!/usr/bin/env bun
// S3 writable-spool variant: fail begin while persistence is healthy, prove
// the recovery intent is durable, restore passthrough, and use a real Discord
// message to kick the worker drain.
import { Database } from "bun:sqlite";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const [outputDir] = process.argv.slice(2);
if (!outputDir) {
	throw new Error("usage: s3-writable-spool-driver.ts OUTPUT_DIR");
}
const token = process.env.TEST_BOT_TOKEN_2;
if (!token) throw new Error("TEST_BOT_TOKEN_2 is required");

const slotDir = "/tmp/flywheel-test-slot-1";
const spoolDir = join(slotDir, "discord-state", "chat-receipt-spool");
const modePath = join(slotDir, "shim-mode");
const ledgerPath = join(slotDir, "shim-ledger.jsonl");
const channelId = "1504277055406211142";
const dbPath = "/Users/xiaorongli/.flywheel/comm/test-slot-1/comm.db";
const apiRoot = "https://discord.com/api/v10";
mkdirSync(outputDir, { recursive: true });

if (!existsSync(spoolDir) || !lstatSync(spoolDir).isDirectory()) {
	throw new Error("S3 writable variant requires the healthy spool directory");
}
if (existsSync(modePath)) throw new Error(`refusing existing mode: ${modePath}`);

const post = async (content: string) => {
	const response = await fetch(`${apiRoot}/channels/${channelId}/messages`, {
		method: "POST",
		headers: {
			Authorization: `Bot ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ content }),
	});
	if (!response.ok) throw new Error(`Discord send failed: HTTP ${response.status}`);
	const sent = (await response.json()) as {
		id: string;
		channel_id: string;
		author: { id: string; username: string; bot: boolean };
		content: string;
		message_reference?: unknown;
	};
	return {
		id: sent.id,
		channel_id: sent.channel_id,
		author: {
			id: sent.author.id,
			username: sent.author.username,
			bot: sent.author.bot,
		},
		content: sent.content,
		message_reference: sent.message_reference ?? null,
	};
};
const save = (name: string, value: unknown) =>
	writeFileSync(join(outputDir, name), `${JSON.stringify(value, null, 2)}\n`);

writeFileSync(modePath, "fail-begin\n", { mode: 0o600, flag: "wx" });
chmodSync(modePath, 0o600);
let restored = false;
try {
	const m8 = await post(
		"FLY-1439 S3 M8 writable-spool begin failure. Do not reply. If this " +
			"message later arrives with [redelivery], do not reply; the QA driver " +
			"will close the receipt from the real Lead pane.",
	);
	save("s3-m8-inbound.json", m8);
	const intentPath = join(spoolDir, `${m8.id}.json`);
	const intentDeadline = performance.now() + 15_000;
	while (!existsSync(intentPath) && performance.now() < intentDeadline) {
		await Bun.sleep(25);
	}
	if (!existsSync(intentPath)) throw new Error("M8 begin intent was not persisted");
	let initialIntentBytes = readFileSync(intentPath, "utf8");
	let initialIntent = JSON.parse(initialIntentBytes) as { attempts?: number };
	// saveBeginIntent() writes attempts=0 before the CLI call; wait for the
	// failed call to be reflected by markIntentAttempt() before freezing proof.
	while (
		(initialIntent.attempts ?? 0) < 1 &&
		performance.now() < intentDeadline
	) {
		await Bun.sleep(25);
		initialIntentBytes = readFileSync(intentPath, "utf8");
		initialIntent = JSON.parse(initialIntentBytes) as { attempts?: number };
	}
	const initialStat = statSync(intentPath);
	save("s3-m8-intent-initial.json", {
		path: intentPath,
		mode: (initialStat.mode & 0o777).toString(8),
		bytes: JSON.parse(initialIntentBytes),
	});
	if (
		typeof initialIntent.attempts !== "number" ||
		initialIntent.attempts < 1 ||
		(initialStat.mode & 0o777) !== 0o600
	) {
		throw new Error("M8 initial intent did not have attempts>=1 and mode 0600");
	}

	const failLedger = readFileSync(ledgerPath, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { argv?: string[]; mode?: string })
		.filter(
			(row) =>
				row.mode === "fail-begin" &&
				row.argv?.[0] === "chat-receipt" &&
				row.argv?.[1] === "begin" &&
				row.argv?.includes(m8.id),
		);
	save("s3-m8-fail-ledger.json", failLedger);
	if (failLedger.length < 1) throw new Error("M8 fail-begin ledger entry missing");

	renameSync(modePath, join(outputDir, "s3-m8-triggered-mode.txt"));
	restored = true;
	const kick = await post(
		"FLY-1439 S3 M8K healthy recovery kick. Please reply exactly: " +
			"S3 M8K healthy replied, using reply_to this message.",
	);
	save("s3-m8-kick-inbound.json", kick);

	const db = new Database(dbPath, { readonly: true });
	const drainDeadline = performance.now() + 60_000;
	let root:
		| {
				id: string;
				created_at: string;
				delivered_at: string | null;
				processed_at: string | null;
		  }
		| null = null;
	while (performance.now() < drainDeadline) {
		root = db
			.query(
				"SELECT id,created_at,delivered_at,processed_at FROM lead_inbox WHERE id=?",
			)
			.get(`chat:flywheel-test-1:${m8.id}`) as typeof root;
		if (!existsSync(intentPath) && root?.delivered_at) break;
		await Bun.sleep(100);
	}
	db.close();
	save("s3-m8-drain.json", {
		messageId: m8.id,
		kickMessageId: kick.id,
		intentRemoved: !existsSync(intentPath),
		root,
	});
	if (existsSync(intentPath) || !root?.delivered_at) {
		throw new Error("M8 recovery drain did not remove intent and deliver root");
	}
	process.stdout.write(
		`${JSON.stringify({ messageId: m8.id, kickMessageId: kick.id })}\n`,
	);
} finally {
	if (!restored && existsSync(modePath)) {
		renameSync(modePath, join(outputDir, "s3-m8-triggered-mode.failed.txt"));
	}
}
