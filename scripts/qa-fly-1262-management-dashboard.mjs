#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_URL = "http://127.0.0.1:9876";

function fail(message) {
	process.stderr.write(`FAIL: ${message}\n`);
	process.exitCode = 1;
}

function pass(requirement, evidence) {
	process.stdout.write(`PASS ${requirement}: ${evidence}\n`);
}

function parseArgs(argv) {
	let mode = "isolated";
	let baseUrl = process.env.FLYWHEEL_BRIDGE_URL || DEFAULT_URL;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--live-readonly") {
			mode = "live-readonly";
			continue;
		}
		if (arg === "--base-url") {
			baseUrl = argv[++index];
			if (!baseUrl) throw new Error("--base-url requires a value");
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			process.stdout.write(
				`${[
					"Usage: node scripts/qa-fly-1262-management-dashboard.mjs [--live-readonly] [--base-url URL]",
					"",
					"Default: isolated temp-source acceptance with stubbed launchctl.",
					"--live-readonly: fetch and summarize a loopback Bridge snapshot; never writes.",
				].join("\n")}\n`,
			);
			return { mode: "help", baseUrl };
		}
		throw new Error(`unknown argument: ${arg}`);
	}
	return { mode, baseUrl };
}

function assertLoopback(rawUrl) {
	const url = new URL(rawUrl);
	if (url.protocol !== "http:") {
		throw new Error("live-readonly requires an http loopback URL");
	}
	if (!["127.0.0.1", "::1", "localhost"].includes(url.hostname)) {
		throw new Error("live-readonly refuses a non-loopback host");
	}
	url.pathname = url.pathname.replace(/\/$/, "");
	return url;
}

function assertSnapshot(snapshot) {
	if (!snapshot || snapshot.schemaVersion !== 1) {
		throw new Error("Bridge returned an unsupported management schema");
	}
	for (const key of [
		"sources",
		"projects",
		"presentationGroups",
		"unassignedCrons",
		"flags",
		"extensions",
	]) {
		if (!Array.isArray(snapshot[key])) {
			throw new Error(`snapshot.${key} is not an array`);
		}
	}
	const raw = JSON.stringify(snapshot);
	for (const forbidden of ["botToken", "botTokenEnv", "SECRET_CANARY"]) {
		if (raw.includes(forbidden)) {
			throw new Error(
				`snapshot contains forbidden secret field/canary: ${forbidden}`,
			);
		}
	}
}

function runIsolated() {
	const qaHome = mkdtempSync(join(tmpdir(), "fly1262-qa-home-"));
	try {
		mkdirSync(join(qaHome, ".flywheel"), { recursive: true });
		const result = spawnSync(
			process.execPath,
			[
				join(
					REPO_ROOT,
					"packages",
					"teamlead",
					"node_modules",
					"vitest",
					"vitest.mjs",
				),
				"run",
				"src/__tests__/fly1262-ssot-acceptance.test.ts",
				"--maxWorkers=1",
				"--minWorkers=1",
				"--testTimeout=30000",
			],
			{
				cwd: join(REPO_ROOT, "packages", "teamlead"),
				env: {
					...process.env,
					HOME: qaHome,
					FLYWHEEL_QA_ISOLATED: "1",
				},
				stdio: "inherit",
			},
		);
		if (result.error) throw result.error;
		if (result.status !== 0) {
			throw new Error(`isolated acceptance exited ${String(result.status)}`);
		}
		pass("§6.1", "one versioned aggregate contains all management sections");
		pass("§6.2", "production HTML has no manual ingest or copied inventory");
		pass(
			"§6.3",
			"Lead, flag, project cron, and unmatched cron appear and disappear automatically",
		);
		pass(
			"§6.4",
			"unified canonical stage/apply writes config, DB, env, and plist with stale/partial proof",
		);
	} finally {
		rmSync(qaHome, { recursive: true, force: true });
	}
}

async function runLiveReadonly(rawUrl) {
	const base = assertLoopback(rawUrl);
	const endpoint = new URL("/api/fleet/snapshot", base);
	const response = await fetch(endpoint, {
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		throw new Error(`snapshot request returned HTTP ${response.status}`);
	}
	const snapshot = await response.json();
	assertSnapshot(snapshot);
	const projects = snapshot.projects.length;
	const leads = snapshot.projects.reduce(
		(sum, project) => sum + project.leads.length,
		0,
	);
	const roles = snapshot.projects.reduce(
		(sum, project) => sum + project.roles.length,
		0,
	);
	const dags = snapshot.projects.reduce(
		(sum, project) => sum + project.dags.length,
		0,
	);
	const projectCrons = snapshot.projects.reduce(
		(sum, project) => sum + project.crons.length,
		0,
	);
	const modelOptions = Object.values(snapshot.modelCatalog || {}).reduce(
		(sum, catalog) =>
			sum +
			(catalog?.providers || []).reduce(
				(providerSum, provider) => providerSum + provider.models.length,
				0,
			),
		0,
	);
	const failedSources = snapshot.sources
		.filter((source) => !source.ok)
		.map((source) => source.kind);
	pass(
		"live-readonly",
		`projects=${projects} leads=${leads} roles=${roles} dags=${dags} crons=${projectCrons} unassignedCrons=${snapshot.unassignedCrons.length} flags=${snapshot.flags.length} modelOptions=${modelOptions} extensions=${snapshot.extensions.length}`,
	);
	if (failedSources.length) {
		process.stdout.write(
			`SOURCE_DIAGNOSTICS failed=${failedSources.join(",")}\n`,
		);
	} else {
		process.stdout.write(
			`SOURCE_DIAGNOSTICS all=${snapshot.sources.length} ok\n`,
		);
	}
}

try {
	const args = parseArgs(process.argv.slice(2));
	if (args.mode === "isolated") runIsolated();
	if (args.mode === "live-readonly") await runLiveReadonly(args.baseUrl);
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}
