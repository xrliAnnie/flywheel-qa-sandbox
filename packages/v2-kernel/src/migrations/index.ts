import { createHash } from "node:crypto";
import { BASE_SCHEMA_DDL } from "./0001-base-schema.js";
import { OBLIGATIONS_REBUILD_DDL } from "./0002-obligations-rebuild.js";
import { ACTIVATIONS_PROCESSING_ATTEMPTS_DDL } from "./0003-activations-processing-attempts.js";
import { MAILBOX_INDEX_FAMILY_DDL } from "./0004-mailbox-index-family.js";
import { AGENTS_CONFIG_MAILBOX_REBUILD_DDL } from "./0005-agents-config-mailbox-rebuild.js";
import { ACTIONS_BLACK_BOX_DDL } from "./0006-actions-black-box.js";
import { SCHEDULER_RUNTIME_DDL } from "./0007-scheduler-runtime.js";
import { RETIRED_TABLES_DDL } from "./0008-drop-retired-command-obligation-tables.js";
import { RUNTIME_BINDING_PROPOSAL_RECEIPTS_DDL } from "./0009-runtime-binding-proposal-receipts.js";

export interface Migration {
	id: string;
	ddl: string;
	fkMode: "on" | "rebuild";
}

export interface MigrationManifestEntry {
	id: string;
	checksum: string;
}

export function migrationChecksum(ddl: string): string {
	return createHash("sha256").update(ddl).digest("hex");
}

export const MIGRATIONS: readonly Migration[] = [
	{
		id: "0001-base-schema",
		ddl: BASE_SCHEMA_DDL,
		fkMode: "on",
	},
	{
		id: "0002-obligations-rebuild",
		ddl: OBLIGATIONS_REBUILD_DDL,
		fkMode: "rebuild",
	},
	{
		id: "0003-activations-processing-attempts",
		ddl: ACTIVATIONS_PROCESSING_ATTEMPTS_DDL,
		fkMode: "on",
	},
	{
		id: "0004-mailbox-index-family",
		ddl: MAILBOX_INDEX_FAMILY_DDL,
		fkMode: "on",
	},
	{
		id: "0005-agents-config-mailbox-rebuild",
		ddl: AGENTS_CONFIG_MAILBOX_REBUILD_DDL,
		fkMode: "rebuild",
	},
	{
		id: "0006-actions-black-box",
		ddl: ACTIONS_BLACK_BOX_DDL,
		fkMode: "rebuild",
	},
	{
		id: "0007-scheduler-runtime",
		ddl: SCHEDULER_RUNTIME_DDL,
		fkMode: "on",
	},
	{
		id: "0008-drop-retired-command-obligation-tables",
		ddl: RETIRED_TABLES_DDL,
		fkMode: "rebuild",
	},
	{
		id: "0009-runtime-binding-proposal-receipts",
		ddl: RUNTIME_BINDING_PROPOSAL_RECEIPTS_DDL,
		fkMode: "on",
	},
];

export const MIGRATION_MANIFEST: readonly MigrationManifestEntry[] =
	Object.freeze(
		MIGRATIONS.map((migration) =>
			Object.freeze({
				id: migration.id,
				checksum: migrationChecksum(migration.ddl),
			}),
		),
	);
