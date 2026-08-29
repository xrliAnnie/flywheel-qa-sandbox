#!/usr/bin/env node

const { existsSync, mkdirSync } = require("node:fs");
const { createRequire } = require("node:module");
const { dirname, isAbsolute, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const packageRequire = createRequire(
	resolve(__dirname, "../../packages/flywheel-comm/package.json"),
);
const Database = packageRequire("better-sqlite3");

const ACKED_ROWS = 63_007;
const DEAD_ROWS = 3_212;
const DEAD_RECIPIENTS = 50;

async function main() {
	const dbPath = process.argv[2];
	if (!dbPath || !isAbsolute(dbPath)) {
		throw new Error("usage: fly2136-seed-66k.cjs /absolute/path/to/comm.db");
	}
	if (existsSync(dbPath)) {
		throw new Error(`refusing to overwrite existing database: ${dbPath}`);
	}
	mkdirSync(dirname(dbPath), { recursive: true });
	const schemaUrl = pathToFileURL(
		resolve(__dirname, "../../packages/flywheel-comm/dist/mailbox-schema.js"),
	).href;
	const { MAILBOX_SCHEMA } = await import(schemaUrl);
	const db = new Database(dbPath);
	try {
		db.pragma("journal_mode = WAL");
		db.pragma("synchronous = OFF");
		db.exec(MAILBOX_SCHEMA);
		const terminalAt = new Date().toISOString();
		const reserve = db.prepare(
			"INSERT INTO mailbox_identity (id, delivery_id, insert_projection_hash) VALUES (?, ?, 'fly2136-seed')",
		);
		const insert = db.prepare(
			`INSERT INTO mailbox
			  (id, delivery_id, from_agent, to_agent, recipient_kind, type,
			   content, created_at, state, acked_at, dead_at, dead_reason)
			 VALUES (?, ?, 'bridge', ?, ?, 'instruction', 'fly2136-seed', ?, ?, ?, ?, ?)`,
		);
		db.transaction(() => {
			for (let index = 0; index < ACKED_ROWS; index += 1) {
				const id = `fly2136-acked-${index}`;
				const deliveryId = `delivery-${id}`;
				reserve.run(id, deliveryId);
				insert.run(
					id,
					deliveryId,
					"lead-fly2136-qa",
					"lead",
					terminalAt,
					"ACKED",
					terminalAt,
					null,
					null,
				);
			}
			for (let index = 0; index < DEAD_ROWS; index += 1) {
				const id = `fly2136-dead-${index}`;
				const deliveryId = `delivery-${id}`;
				reserve.run(id, deliveryId);
				insert.run(
					id,
					deliveryId,
					`runner-${String(index % DEAD_RECIPIENTS).padStart(2, "0")}`,
					"runner",
					terminalAt,
					"DEAD",
					null,
					terminalAt,
					"lease_expired_unacked",
				);
			}
		})();
		db.pragma("wal_checkpoint(TRUNCATE)");
		const counts = db
			.prepare("SELECT state, COUNT(*) AS count FROM mailbox GROUP BY state")
			.all();
		console.log(JSON.stringify({ dbPath, counts }));
	} finally {
		db.close();
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
