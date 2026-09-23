import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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

test("registers the isolated voice QA mailbox read without exempting it from scanning", () => {
	const file = "scripts/qa/fly2446-two-lead-run.mjs";
	const source = readFileSync(
		new URL("../qa/fly2446-two-lead-run.mjs", import.meta.url),
		"utf8",
	);
	const consumers = scanRetentionConsumers({
		files: new Map([[file, source]]),
		targetTables: TARGETS,
	});
	assert.deepEqual(consumers, [
		{ file, relation: "mailbox", baseTable: "mailbox", usage: "read" },
	]);
	const config = JSON.parse(
		readFileSync(
			new URL(
				"../fly-2006-retention-consumer-gate.config.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	const entries = config.consumers.filter((entry) => entry.file === file);
	// This reads only current isolated-run ACK evidence, never authority inferred
	// from absence. Retention does not gain a protected row or a new deletion rule.
	assert.deepEqual(entries, [
		{ ...consumers[0], disposition: "candidate_guarded" },
	]);
	assert.equal(
		auditRetentionConsumers({
			consumers,
			config: { version: 1, consumers: entries },
		}).ok,
		true,
	);
	assert.deepEqual(
		auditRetentionConsumers({
			consumers,
			config: { version: 1, consumers: [] },
		}).errors,
		[`unclassified_retention_consumer:${file}:mailbox:read`],
	);
});

for (const [file, table] of [
	["packages/teamlead/src/bin/raya-migration-proof-evidence.ts", "mailbox"],
	[
		"packages/teamlead/src/bin/backend-migration-evidence.ts",
		"workflow_run_event",
	],
	["packages/teamlead/src/bridge/summary-presentation-store.ts", "lead_events"],
	["packages/teamlead/src/lead-backends/codex/runner-actions.ts", "mailbox"],
]) {
	test(`registers the exact guarded retention read: ${file}`, () => {
		const source = readFileSync(
			new URL(`../../${file}`, import.meta.url),
			"utf8",
		);
		const consumers = scanRetentionConsumers({
			files: new Map([[file, source]]),
			targetTables: [table],
		});
		assert.deepEqual(consumers, [
			{ file, relation: table, baseTable: table, usage: "read" },
		]);
		const config = JSON.parse(
			readFileSync(
				new URL(
					"../fly-2006-retention-consumer-gate.config.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const entries = config.consumers.filter((entry) => entry.file === file);
		// Missing retained evidence refuses or skips the operation; registration
		// does not change retention policy or make absence authoritative.
		assert.deepEqual(entries, [
			{ ...consumers[0], disposition: "candidate_guarded" },
		]);
		assert.equal(
			auditRetentionConsumers({
				consumers,
				config: { version: 1, consumers: entries },
			}).ok,
			true,
		);
		assert.deepEqual(
			auditRetentionConsumers({
				consumers,
				config: { version: 1, consumers: [] },
			}).errors,
			[`unclassified_retention_consumer:${file}:${table}:read`],
		);
		const foreign = {
			...consumers[0],
			file: "packages/teamlead/src/unregistered-reader.ts",
		};
		assert.equal(
			auditRetentionConsumers({
				consumers: [foreign],
				config: { version: 1, consumers: entries },
			}).ok,
			false,
		);
	});
}

test("registers every guarded closeout-restart retention read", () => {
	const file = "packages/teamlead/src/bin/restart-request.ts";
	const tables = [
		"chat_threads",
		"mailbox",
		"phase_chat_threads",
		"runner_phase_wakes",
	];
	const source = readFileSync(
		new URL(`../../${file}`, import.meta.url),
		"utf8",
	);
	const consumers = scanRetentionConsumers({
		files: new Map([[file, source]]),
		targetTables: tables,
	});
	const expected = tables.map((table) => ({
		file,
		relation: table,
		baseTable: table,
		usage: "read",
	}));
	assert.deepEqual(consumers, expected);
	const config = JSON.parse(
		readFileSync(
			new URL(
				"../fly-2006-retention-consumer-gate.config.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	const entries = config.consumers.filter((entry) => entry.file === file);
	assert.deepEqual(
		entries,
		expected.map((consumer) => ({
			...consumer,
			disposition: "candidate_guarded",
		})),
	);
	assert.equal(
		auditRetentionConsumers({
			consumers,
			config: { version: 1, consumers: entries },
		}).ok,
		true,
	);
	assert.deepEqual(
		auditRetentionConsumers({
			consumers,
			config: { version: 1, consumers: [] },
		}).errors,
		tables.map(
			(table) => `unclassified_retention_consumer:${file}:${table}:read`,
		),
	);
});
