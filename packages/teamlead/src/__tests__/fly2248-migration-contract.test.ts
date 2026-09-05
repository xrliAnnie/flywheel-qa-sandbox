import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

interface SchemaRow {
	type: "index" | "table";
	name: string;
	tbl_name: string;
}

interface DatabaseSnapshot {
	schema: SchemaRow[];
	columns: Record<string, string[]>;
	integrity: unknown[];
	foreignKeys: unknown[];
}

const tempRoots: string[] = [];

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function sqlString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function vacuumInto(source: string, destination: string): void {
	const db = new Database(source);
	try {
		db.exec(`VACUUM INTO ${sqlString(destination)}`);
	} finally {
		db.close();
	}
}

function snapshot(path: string): DatabaseSnapshot {
	const db = new Database(path, { readonly: true });
	try {
		const schema = db
			.prepare(
				`SELECT type, name, tbl_name
				   FROM sqlite_master
				  WHERE type IN ('table','index')
				    AND name NOT LIKE 'sqlite_%'
				  ORDER BY type, name`,
			)
			.all() as SchemaRow[];
		const columns = Object.fromEntries(
			schema
				.filter(({ type }) => type === "table")
				.map(({ name }) => [
					name,
					(
						db
							.prepare(`PRAGMA table_info(${JSON.stringify(name)})`)
							.all() as Array<{
							name: string;
						}>
					).map((column) => column.name),
				]),
		);
		return {
			schema,
			columns,
			integrity: db.pragma("integrity_check"),
			foreignKeys: db.pragma("foreign_key_check"),
		};
	} finally {
		db.close();
	}
}

function schemaAdditions(
	before: DatabaseSnapshot,
	after: DatabaseSnapshot,
): SchemaRow[] {
	const prior = new Set(
		before.schema.map(
			({ type, name, tbl_name }) => `${type}\u0000${name}\u0000${tbl_name}`,
		),
	);
	return after.schema.filter(
		({ type, name, tbl_name }) =>
			!prior.has(`${type}\u0000${name}\u0000${tbl_name}`),
	);
}

function existingColumnAdditions(
	before: DatabaseSnapshot,
	after: DatabaseSnapshot,
): Record<string, string[]> {
	return Object.fromEntries(
		Object.entries(before.columns)
			.map(
				([table, columns]) =>
					[
						table,
						(after.columns[table] ?? []).filter(
							(column) => !columns.includes(column),
						),
					] as const,
			)
			.filter(([, columns]) => columns.length > 0),
	);
}

describe("FLY-2248 additive migration contract", () => {
	it("migrates a VACUUM INTO StateStore snapshot with exactly three tables and seven indexes", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2248-state-migration-"));
		tempRoots.push(root);
		const currentPath = join(root, "current.db");
		const prePath = join(root, "pre.db");
		const migratedPath = join(root, "migrated.db");
		(await StateStore.create(currentPath)).close();
		const current = new Database(currentPath);
		current.exec(`
			DROP TABLE workflow_delivery_contract_episode;
			DROP TABLE workflow_delivery_operation;
			DROP TABLE workflow_delivery_attempt;
		`);
		current.close();
		vacuumInto(currentPath, prePath);
		const before = snapshot(prePath);
		copyFileSync(prePath, migratedPath);

		(await StateStore.create(migratedPath)).close();
		const first = snapshot(migratedPath);
		(await StateStore.create(migratedPath)).close();
		const second = snapshot(migratedPath);

		expect(schemaAdditions(before, first)).toEqual([
			{
				type: "index",
				name: "idx_wda_live_by_root",
				tbl_name: "workflow_delivery_attempt",
			},
			{
				type: "index",
				name: "idx_wda_projection_source",
				tbl_name: "workflow_delivery_attempt",
			},
			{
				type: "index",
				name: "idx_wda_projection_source_all",
				tbl_name: "workflow_delivery_attempt",
			},
			{
				type: "index",
				name: "idx_wdce_open_by_root",
				tbl_name: "workflow_delivery_contract_episode",
			},
			{
				type: "index",
				name: "idx_wdce_open_undeliverable_by_root",
				tbl_name: "workflow_delivery_contract_episode",
			},
			{
				type: "index",
				name: "idx_wdo_client_request",
				tbl_name: "workflow_delivery_operation",
			},
			{
				type: "index",
				name: "idx_wdo_pending_hold_by_id",
				tbl_name: "workflow_delivery_operation",
			},
			{
				type: "table",
				name: "workflow_delivery_attempt",
				tbl_name: "workflow_delivery_attempt",
			},
			{
				type: "table",
				name: "workflow_delivery_contract_episode",
				tbl_name: "workflow_delivery_contract_episode",
			},
			{
				type: "table",
				name: "workflow_delivery_operation",
				tbl_name: "workflow_delivery_operation",
			},
		]);
		expect(existingColumnAdditions(before, first)).toEqual({});
		expect(first).toEqual(second);
		expect(first.integrity).toEqual([{ integrity_check: "ok" }]);
		expect(first.foreignKeys).toEqual([]);
	});

	it("migrates a VACUUM INTO CommDB snapshot with no objects and one phase-wake column", () => {
		const root = mkdtempSync(join(tmpdir(), "fly2248-comm-migration-"));
		tempRoots.push(root);
		const currentPath = join(root, "current.db");
		const prePath = join(root, "pre.db");
		const migratedPath = join(root, "migrated.db");
		new CommDB(currentPath).close();
		const current = new Database(currentPath);
		current.exec(`
			DROP VIEW messages;
			DROP VIEW lead_inbox;
			ALTER TABLE runner_phase_wakes DROP COLUMN first_push_at;
		`);
		current.close();
		vacuumInto(currentPath, prePath);
		const before = snapshot(prePath);
		copyFileSync(prePath, migratedPath);

		new CommDB(migratedPath).close();
		const first = snapshot(migratedPath);
		new CommDB(migratedPath).close();
		const second = snapshot(migratedPath);

		expect(schemaAdditions(before, first)).toEqual([]);
		expect(existingColumnAdditions(before, first)).toEqual({
			runner_phase_wakes: ["first_push_at"],
		});
		expect(first).toEqual(second);
		expect(first.integrity).toEqual([{ integrity_check: "ok" }]);
		expect(first.foreignKeys).toEqual([]);
	});
});
