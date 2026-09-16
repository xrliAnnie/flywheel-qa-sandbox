#!/usr/bin/env node
import { appendFileSync, mkdtempSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinGbrainHost } from "../packages/teamlead/dist/lead-capabilities/gbrain-host.js";
import { GbrainStdioTransport } from "../packages/teamlead/dist/lead-capabilities/gbrain-transport.js";
import { UPSTREAM_READ_BASELINES } from "../packages/teamlead/dist/lead-capabilities/handlers/upstream-read.js";
import { assertUpstreamToolsPinned } from "../packages/teamlead/dist/lead-capabilities/upstream-baseline.js";

// Lead faf43d4f: same host config and pinned serve process; only tools/list and get_stats.
// No environment DB override, model session, database copy or mutation tool is used.
if (process.argv.length !== 2)
	throw new Error("This canary accepts no arguments");
const require = createRequire(
	new URL("../packages/teamlead/package.json", import.meta.url),
);
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const evidenceRoot = realpathSync(
		mkdtempSync(join(tmpdir(), "fly2519-gbrain-evidence-")),
	),
	evidenceLog = join(evidenceRoot, "canary.jsonl");
const emit = (data) => {
	const line = JSON.stringify({ ...data, evidenceLog });
	appendFileSync(evidenceLog, `${line}\n`, { mode: 0o600 });
	console.log(line);
};
let client,
	transport,
	stage = "host-pin",
	ok = false;
try {
	const pin = pinGbrainHost();
	emit({ stage, ok: true, ...pin.evidence });
	transport = new GbrainStdioTransport(pin);
	client = new Client(
		{ name: "flywheel-qa", version: "2" },
		{ capabilities: {} },
	);
	stage = "stdio-initialize";
	await client.connect(transport, { timeout: 15000 });
	pin.assertCurrent();
	stage = "tools-list";
	const tools = await client.listTools(undefined, { timeout: 15000 });
	if (tools.nextCursor) throw new Error("baseline_drift");
	assertUpstreamToolsPinned(UPSTREAM_READ_BASELINES.gbrain, {
		serverId: "gbrain",
		version: client.getServerVersion()?.version ?? "",
		tools: tools.tools,
	});
	stage = "read-stats";
	const result = await client.callTool(
		{ name: "get_stats", arguments: {} },
		undefined,
		{ timeout: 15000 },
	);
	if (result.isError) throw new Error("gbrain_read_failed");
	pin.assertCurrent();
	if (transport.evidence.migrationsApplied !== 0)
		throw new Error("gbrain_migration_observed");
	emit({
		stage,
		ok: true,
		toolCount: tools.tools.length,
		readOperation: "get_stats",
		...transport.evidence,
	});
	ok = true;
} catch (error) {
	emit({
		stage,
		ok: false,
		error: transport?.evidence.migrationsApplied
			? "gbrain_migration_observed"
			: error instanceof Error &&
					[
						"gbrain_host_unverified",
						"baseline_drift",
						"gbrain_read_failed",
						"gbrain_session_lost",
					].includes(error.message)
				? error.message
				: "gbrain_canary_failed",
		diagnostic: transport?.evidence ?? null,
		rpcErrorCode: typeof error?.code === "number" ? error.code : null,
	});
	process.exitCode = 1;
} finally {
	try {
		try {
			await client?.close();
		} finally {
			await transport?.close();
		}
	} catch {
		ok = false;
		process.exitCode = 1;
	}
	emit({
		stage: "closed",
		ok,
		diagnostic: transport?.evidence ?? null,
	});
}
