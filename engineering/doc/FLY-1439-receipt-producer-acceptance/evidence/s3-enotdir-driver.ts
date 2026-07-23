#!/usr/bin/env bun
// S3 fail-open accounting fault: make chat-receipt-spool an ordinary file so
// begin fails and its recovery intent also fails with ENOTDIR/EEXIST.
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
	throw new Error("usage: s3-enotdir-driver.ts OUTPUT_DIR");
}
const token = process.env.TEST_BOT_TOKEN_2;
if (!token) throw new Error("TEST_BOT_TOKEN_2 is required");

const slotDir = "/tmp/flywheel-test-slot-1";
const stateDir = join(slotDir, "discord-state");
const spoolPath = join(stateDir, "chat-receipt-spool");
const backupPath = join(stateDir, "chat-receipt-spool.s3-backup");
const modePath = join(slotDir, "shim-mode");
const channelId = "1504277055406211142";
const dbPath =
	"/Users/xiaorongli/.flywheel/comm/test-slot-1/comm.db";
const content =
	"FLY-1439 S3 M6 ENOTDIR accounting fault. Test message: do not reply. " +
	"Delivery must continue while receipt persistence fails.";
mkdirSync(outputDir, { recursive: true });

if (!existsSync(spoolPath) || !lstatSync(spoolPath).isDirectory()) {
	throw new Error("S3 requires the healthy spool directory");
}
if (existsSync(backupPath)) {
	throw new Error(`refusing existing S3 backup: ${backupPath}`);
}
renameSync(spoolPath, backupPath);
let restored = false;
try {
	writeFileSync(spoolPath, "", { mode: 0o600, flag: "wx" });
	chmodSync(spoolPath, 0o600);
	writeFileSync(modePath, "fail-begin\n", { mode: 0o600 });

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
		join(outputDir, "s3-m6-inbound.json"),
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

	const advisoryNeedle =
		`Chat receipt could not persist its recovery intent for message ${messageId}`;
	let advisory:
		| {
				id: string;
				channel_id: string;
				author: { id: string; username: string; bot: boolean };
				content: string;
				message_reference?: unknown;
		  }
		| undefined;
	const deadline = performance.now() + 15_000;
	while (!advisory && performance.now() < deadline) {
		const fetched = await fetch(
			`https://discord.com/api/v10/channels/${channelId}/messages?after=${messageId}&limit=100`,
			{ headers: { Authorization: `Bot ${token}` } },
		);
		if (!fetched.ok) {
			throw new Error(`Discord fetch failed: HTTP ${fetched.status}`);
		}
		const rows = (await fetched.json()) as Array<typeof advisory>;
		advisory = rows.find((row) => row?.content.includes(advisoryNeedle));
		if (!advisory) await Bun.sleep(100);
	}
	if (!advisory) throw new Error("begin-spool-failed advisory was not observed");
	writeFileSync(
		join(outputDir, "s3-m6-advisory.json"),
		`${JSON.stringify(
			{
				id: advisory.id,
				channel_id: advisory.channel_id,
				author: {
					id: advisory.author.id,
					username: advisory.author.username,
					bot: advisory.author.bot,
				},
				content: advisory.content,
				message_reference: advisory.message_reference ?? null,
			},
			null,
			2,
		)}\n`,
	);

	const db = new Database(dbPath, { readonly: true });
	const rowCount = (
		db
			.query("SELECT COUNT(*) AS count FROM lead_inbox WHERE id=?")
			.get(`chat:flywheel-test-1:${messageId}`) as { count: number }
	).count;
	db.close();
	const placeholder = statSync(spoolPath);
	writeFileSync(
		join(outputDir, "s3-m6-fault-snapshot.json"),
		`${JSON.stringify(
			{
				messageId,
				dbRows: rowCount,
				spoolPathType: lstatSync(spoolPath).isFile() ? "file" : "other",
				spoolPathMode: (placeholder.mode & 0o777).toString(8),
				advisoryCount: 1,
			},
			null,
			2,
		)}\n`,
	);
	if (rowCount !== 0 || !lstatSync(spoolPath).isFile()) {
		throw new Error("S3 fault snapshot did not preserve fail-open/no-row shape");
	}

	renameSync(spoolPath, join(outputDir, "s3-enotdir-placeholder"));
	renameSync(backupPath, spoolPath);
	renameSync(modePath, join(outputDir, "s3-triggered-mode.txt"));
	restored = true;
	process.stdout.write(`${messageId}\n`);
} finally {
	if (!restored) {
		if (existsSync(spoolPath) && lstatSync(spoolPath).isFile()) {
			renameSync(
				spoolPath,
				join(outputDir, "s3-enotdir-placeholder.failed"),
			);
		}
		if (existsSync(backupPath) && !existsSync(spoolPath)) {
			renameSync(backupPath, spoolPath);
		}
		if (existsSync(modePath)) {
			renameSync(modePath, join(outputDir, "s3-triggered-mode.failed.txt"));
		}
	}
}
