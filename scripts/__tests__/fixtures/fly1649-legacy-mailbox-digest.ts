import { createHash, type Hash } from "node:crypto";
import { Database } from "../../../packages/flywheel-comm/src/mailbox-migration.js";

const dbPath = process.argv[2];
if (!dbPath) throw new Error("usage: fly1649-legacy-mailbox-digest.ts <db>");

const TABLES = ["messages", "lead_inbox"] as const;

function quoted(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function feed(hash: Hash, value: string): void {
	hash.update(String(Buffer.byteLength(value)));
	hash.update(":");
	hash.update(value);
	hash.update(";");
}

function encoded(value: unknown): string {
	if (value === null) return "NULL";
	if (Buffer.isBuffer(value))
		return `BLOB:${value.length}:${value.toString("hex")}`;
	if (typeof value === "string") {
		return `TEXT:${Buffer.byteLength(value)}:${value}`;
	}
	if (typeof value === "bigint") return `INTEGER:${value.toString()}`;
	if (typeof value === "number") {
		return `REAL:${Object.is(value, -0) ? "-0" : String(value)}`;
	}
	throw new Error(`unsupported SQLite value type: ${typeof value}`);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
db.defaultSafeIntegers(true);
try {
	const schemaHash = createHash("sha256");
	const schema = db
		.prepare(
			`SELECT type, name, sql
			   FROM sqlite_master
			  WHERE name IN ('messages', 'lead_inbox')
			  ORDER BY type, name, sql`,
		)
		.all() as Array<{ type: string; name: string; sql: string | null }>;
	for (const row of schema) {
		feed(schemaHash, row.type);
		feed(schemaHash, row.name);
		feed(schemaHash, row.sql ?? "");
	}

	const contentHash = createHash("sha256");
	const counts: Record<string, number> = {};
	for (const table of TABLES) {
		const columns = db
			.prepare(`PRAGMA table_info(${quoted(table)})`)
			.all() as Array<{
			name: string;
			pk: bigint;
		}>;
		if (columns.length === 0) throw new Error(`legacy table missing: ${table}`);
		const primaryKey = columns
			.filter((column) => column.pk > 0n)
			.sort((left, right) => Number(left.pk - right.pk))
			.map((column) => column.name);
		const orderBy =
			primaryKey.length > 0 ? primaryKey.map(quoted).join(", ") : "rowid";
		const rows = db
			.prepare(
				`SELECT ${columns.map((column) => quoted(column.name)).join(", ")}
				   FROM ${quoted(table)}
				  ORDER BY ${orderBy}`,
			)
			.all() as Array<Record<string, unknown>>;
		counts[table] = rows.length;
		feed(contentHash, table);
		for (const column of columns) feed(contentHash, column.name);
		for (const row of rows) {
			for (const column of columns)
				feed(contentHash, encoded(row[column.name]));
		}
	}

	process.stdout.write(
		JSON.stringify({
			schemaSha256: schemaHash.digest("hex"),
			contentSha256: contentHash.digest("hex"),
			counts,
		}),
	);
} finally {
	db.close();
}
