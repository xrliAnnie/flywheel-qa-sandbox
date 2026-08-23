import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	auditRetentionConsumers,
	collectProductionSources,
	scanRetentionConsumers,
} from "../fly-2006-retention-consumer-gate.mjs";

const TARGETS = ["session_events", "mailbox", "mailbox_log"];

test("fails closed when a retention target gains an unclassified anti-join", () => {
	const files = new Map([
		[
			"packages/teamlead/src/runtime.ts",
			`const sql = \`SELECT s.id FROM sessions s
			 WHERE NOT EXISTS (
				SELECT 1 FROM session_events e WHERE e.execution_id=s.execution_id
			 )\`;`,
		],
	]);
	const result = auditRetentionConsumers({
		consumers: scanRetentionConsumers({ files, targetTables: TARGETS }),
		config: { version: 1, consumers: [] },
	});
	assert.equal(result.ok, false);
	assert.deepEqual(result.errors, [
		"unclassified_retention_consumer:packages/teamlead/src/runtime.ts:session_events:anti_join",
	]);
});

test("resolves a SQL view to its base retention target", () => {
	const files = new Map([
		[
			"packages/flywheel-comm/src/schema.ts",
			"CREATE VIEW mailbox_message_projection AS SELECT id FROM mailbox;",
		],
		[
			"packages/teamlead/src/runtime.ts",
			`const sql = \`SELECT 1 WHERE NOT EXISTS (
				SELECT 1 FROM mailbox_message_projection p WHERE p.id=?
			)\`;`,
		],
	]);
	const consumers = scanRetentionConsumers({ files, targetTables: TARGETS });
	assert.deepEqual(consumers, [
		{
			file: "packages/teamlead/src/runtime.ts",
			relation: "mailbox_message_projection",
			baseTable: "mailbox",
			usage: "anti_join",
		},
	]);
	const result = auditRetentionConsumers({
		consumers,
		config: {
			version: 1,
			consumers: [
				{
					file: "packages/teamlead/src/runtime.ts",
					relation: "mailbox_message_projection",
					baseTable: "mailbox",
					usage: "anti_join",
					disposition: "protect",
				},
			],
		},
	});
	assert.equal(result.ok, true);
});

test("rejects stale config and pins archived mailbox logs as protected", () => {
	const files = new Map([
		[
			"packages/flywheel-comm/src/identity.ts",
			`const sql = \`SELECT row_json FROM mailbox_log
			 WHERE event='archived' AND message_id=?\`;`,
		],
	]);
	const consumers = scanRetentionConsumers({ files, targetTables: TARGETS });
	assert.deepEqual(consumers, [
		{
			file: "packages/flywheel-comm/src/identity.ts",
			relation: "mailbox_log",
			baseTable: "mailbox_log",
			usage: "read",
		},
	]);
	const result = auditRetentionConsumers({
		consumers,
		config: {
			version: 1,
			consumers: [
				{
					...consumers[0],
					disposition: "protect",
				},
				{
					file: "packages/teamlead/src/stale.ts",
					relation: "session_events",
					baseTable: "session_events",
					usage: "read",
					disposition: "protect",
				},
			],
		},
	});
	assert.deepEqual(result.errors, [
		"stale_retention_consumer:packages/teamlead/src/stale.ts:session_events:read",
	]);
});

test("collects runtime sources without tests, dist, docs, or the retention tool itself", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2006-consumers-"));
	try {
		for (const directory of [
			"packages/a/src",
			"packages/a/src/__tests__",
			"packages/a/dist",
			"scripts",
			"engineering/doc",
		]) {
			mkdirSync(join(root, directory), { recursive: true });
		}
		writeFileSync(join(root, "packages/a/src/runtime.ts"), "FROM mailbox");
		writeFileSync(
			join(root, "packages/a/src/__tests__/runtime.test.ts"),
			"FROM mailbox",
		);
		writeFileSync(join(root, "packages/a/dist/runtime.js"), "FROM mailbox");
		writeFileSync(join(root, "scripts/operator.mjs"), "FROM mailbox_log");
		writeFileSync(
			join(root, "scripts/fly-1998-database-retention-sweep.mjs"),
			"FROM session_events",
		);
		writeFileSync(join(root, "engineering/doc/plan.md"), "FROM mailbox");
		assert.deepEqual(
			[...collectProductionSources(root).keys()],
			["packages/a/src/runtime.ts", "scripts/operator.mjs"],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
