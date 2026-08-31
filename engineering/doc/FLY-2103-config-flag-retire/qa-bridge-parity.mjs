#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PROJECTS = [
	"flywheel",
	"geoforge3d",
	"growth",
	"joycon-typeless",
	"personal-assistant",
	"tidal-echo",
];
const ROWS = [
	{ name: "doc_flow", scope: "flywheel", raw: "1" },
	{ name: "doc_flow", scope: "joycon-typeless", raw: "1" },
	{ name: "doc_flow", scope: "personal-assistant", raw: "1" },
	{ name: "doc_flow", scope: "tidal-echo", raw: "1" },
	{ name: "pipeline_dag", scope: "flywheel", raw: "1" },
	{ name: "pipeline_work_kind", scope: "flywheel", raw: "1" },
	{ name: "ponytail", scope: "*", raw: "0" },
];
const FLAGS = [
	"doc_flow",
	"pipeline_dag",
	"pipeline_work_kind",
	"proofshot",
	"xiaohongshu_learning",
	"ponytail",
	"skill_framework_split_participation",
];

function args(argv) {
	const baselineIndex = argv.indexOf("--baseline-root");
	const candidateIndex = argv.indexOf("--candidate-root");
	if (baselineIndex < 0 || !argv[baselineIndex + 1]) {
		throw new Error("--baseline-root is required");
	}
	return {
		baselineRoot: resolve(argv[baselineIndex + 1]),
		candidateRoot: resolve(
			candidateIndex >= 0 && argv[candidateIndex + 1]
				? argv[candidateIndex + 1]
				: process.cwd(),
		),
	};
}

function stripRetiredKeys(content) {
	let section = "";
	const out = [];
	for (const line of content.split("\n")) {
		const top = /^([a-zA-Z_][a-zA-Z0-9_]*):(?:\s|$)/.exec(line);
		if (top) section = top[1];
		if (
			section === "checkpoints" &&
			/^\s{4}enabled:\s*true\s*(?:#.*)?$/.test(line)
		)
			continue;
		if (
			section === "doc_flow" &&
			/^\s{2}enabled:\s*true\s*(?:#.*)?$/.test(line)
		)
			continue;
		if (section === "pipeline") continue;
		out.push(line);
	}
	return out.join("\n");
}

async function freePort() {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("could not allocate QA port"));
				return;
			}
			server.close((error) =>
				error ? reject(error) : resolvePort(address.port),
			);
		});
	});
}

function waitForExit(child, timeoutMs) {
	return new Promise((resolveExit, reject) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("Bridge did not stop inside the QA timeout"));
		}, timeoutMs);
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			resolveExit({ code, signal });
		});
	});
}

async function waitForSnapshot(baseUrl, child, logs) {
	// A production-shaped roster preflights every configured Lead before the
	// HTTP server starts listening. Keep the real roster and allow that bounded
	// startup work to finish instead of weakening the parity fixture.
	const deadline = Date.now() + 180_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(
				`Bridge exited before readiness (${child.exitCode}):\n${logs.slice(-40).join("")}`,
			);
		}
		try {
			const response = await fetch(`${baseUrl}/api/fleet/snapshot`);
			if (response.ok) return response.json();
		} catch {
			// Bounded readiness polling; the child exit check above is authoritative.
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 200));
	}
	throw new Error(`Bridge readiness timeout:\n${logs.slice(-40).join("")}`);
}

async function stageAndApply(baseUrl, row) {
	const headers = {
		"Content-Type": "application/json",
		Origin: baseUrl,
	};
	const staged = await fetch(`${baseUrl}/api/fleet/flag/stage`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			name: row.name,
			project: row.scope,
			to: row.raw === "1",
			op: "set",
			reason: "FLY-2103 isolated Bridge parity",
		}),
	});
	const stageBody = await staged.json();
	assert.equal(staged.status, 200, JSON.stringify(stageBody));
	const applied = await fetch(`${baseUrl}/api/fleet/flag/apply`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			canonical: stageBody.canonical,
			confirmToken: stageBody.confirmToken,
		}),
	});
	const applyBody = await applied.json();
	assert.equal(applied.status, 200, JSON.stringify(applyBody));
}

function behaviorMatrix(snapshot) {
	const matrix = {};
	for (const name of FLAGS) {
		const flag = snapshot.flags.find((candidate) => candidate.name === name);
		assert.ok(flag, `snapshot omitted ${name}`);
		matrix[name] = Object.fromEntries(
			PROJECTS.map((projectName) => {
				const row = flag.projectOverrides.find(
					(candidate) => candidate.projectName === projectName,
				);
				assert.ok(row, `${name} omitted project ${projectName}`);
				// The old registry marked ponytail dormant and rendered null; its runtime
				// project layer was absent, which is behaviorally identical to false.
				return [projectName, row.value.current ?? false];
			}),
		);
	}
	return matrix;
}

function expectedMatrix() {
	const all = (value) => Object.fromEntries(PROJECTS.map((name) => [name, value]));
	return {
		doc_flow: {
			flywheel: true,
			geoforge3d: false,
			growth: false,
			"joycon-typeless": true,
			"personal-assistant": true,
			"tidal-echo": true,
		},
		pipeline_dag: all(true),
		pipeline_work_kind: { ...all(false), flywheel: true },
		proofshot: all(false),
		xiaohongshu_learning: all(false),
		ponytail: all(false),
		skill_framework_split_participation: all(true),
	};
}

async function prepareArm({ arm, codeRoot, tempRoot, roster, sourceConfigs }) {
	const home = join(tempRoot, arm, "home");
	const fixtureRoot = join(tempRoot, arm, "projects");
	await mkdir(join(home, ".flywheel"), { recursive: true });
	const rewritten = [];
	for (const entry of roster) {
		if (!PROJECTS.includes(entry.projectName)) continue;
		const projectRoot = join(fixtureRoot, entry.projectName);
		await mkdir(join(projectRoot, ".flywheel"), { recursive: true });
		await writeFile(
			join(projectRoot, ".flywheel", "config.yaml"),
			sourceConfigs.get(entry.projectName),
		);
		// Delivery transports are outside this resolver parity check. Force the
		// isolated roster onto the local Claude mailbox adapter so no Discord or
		// Codex inbox credential is required (or can be contacted) during QA.
		rewritten.push({
			...entry,
			projectRoot,
			announcerBotTokenEnv: undefined,
			leads: (entry.leads ?? []).map((lead) => ({
				...lead,
				backend: "claude-code",
				botTokenEnv: undefined,
				alertBotTokenEnv: undefined,
			})),
		});
	}
	assert.deepEqual(
		rewritten.map((entry) => entry.projectName).sort(),
		[...PROJECTS].sort(),
	);
	const projectsPath = join(home, ".flywheel", "projects.json");
	await writeFile(projectsPath, `${JSON.stringify(rewritten, null, 2)}\n`);
	await writeFile(join(home, ".flywheel", ".env"), "");
	return {
		arm,
		codeRoot,
		home,
		projectsPath,
		dbPath: join(home, ".flywheel", "teamlead.db"),
		roster: rewritten,
	};
}

async function runArm(prepared, seedRows) {
	const port = await freePort();
	const baseUrl = `http://127.0.0.1:${port}`;
	const env = { ...process.env };
	delete env.FLYWHEEL_PROJECTS;
	for (const entry of prepared.roster) {
		if (entry.announcerBotTokenEnv) delete env[entry.announcerBotTokenEnv];
		for (const lead of entry.leads ?? []) {
			if (lead.botTokenEnv) delete env[lead.botTokenEnv];
			if (lead.alertBotTokenEnv) delete env[lead.alertBotTokenEnv];
		}
	}
	for (const key of [
		"ANTHROPIC_API_KEY",
		"DISCORD_BOT_TOKEN",
		"GOOGLE_API_KEY",
		"LINEAR_API_KEY",
		"SUPABASE_KEY",
		"SUPABASE_URL",
		"FLYWHEEL_BRIDGE_LOG_PATH",
		"FLYWHEEL_BRIDGE_LOG_ERROR_MARKER",
	]) {
		delete env[key];
	}
	Object.assign(env, {
		HOME: prepared.home,
		FLYWHEEL_PROJECTS_FILE: prepared.projectsPath,
		FLYWHEEL_REPO_ROOT: prepared.codeRoot,
		TEAMLEAD_DB_PATH: prepared.dbPath,
		TEAMLEAD_HOST: "127.0.0.1",
		TEAMLEAD_PORT: String(port),
		TEAMLEAD_API_TOKEN: "fly2103-qa-master",
		TEAMLEAD_INGEST_TOKEN: "fly2103-qa-ingest",
		TEAMLEAD_DEFAULT_LEAD_AGENT: "flywheel-eng-lead",
		TEAMLEAD_STUCK_INTERVAL: "600000",
		DISCORD_OWNER_USER_ID: "1",
		FLYWHEEL_SYNC_BIN_ALLOW_TEMP_ROOT: "1",
		FLYWHEEL_BRIDGE_SHUTDOWN_TIMEOUT_MS: "10000",
	});
	const logs = [];
	const child = spawn(
		join(prepared.codeRoot, "node_modules", ".bin", "tsx"),
		[join(prepared.codeRoot, "scripts", "run-bridge.ts")],
		{ cwd: prepared.codeRoot, env, stdio: ["ignore", "pipe", "pipe"] },
	);
	child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
	child.stderr.on("data", (chunk) => logs.push(chunk.toString()));
	try {
		await waitForSnapshot(baseUrl, child, logs);
		for (const row of seedRows) await stageAndApply(baseUrl, row);
		const response = await fetch(`${baseUrl}/api/fleet/snapshot`);
		assert.equal(response.status, 200);
		return { snapshot: await response.json(), baseUrl };
	} finally {
		if (child.exitCode === null) child.kill("SIGTERM");
		if (child.exitCode === null) await waitForExit(child, 15_000);
	}
}

async function exactRows(candidateRoot, dbPath) {
	const module = await import(
		pathToFileURL(join(candidateRoot, "packages/teamlead/dist/StateStore.js"))
			.href
	);
	const store = await module.StateStore.openForMaintenance(dbPath, {
		readonly: true,
	});
	try {
		return store
			.listScopedFlagValueRows()
			.filter((row) => FLAGS.includes(row.flagName))
			.map((row) => ({ name: row.flagName, scope: row.scope, raw: row.raw }))
			.sort((left, right) =>
				`${left.name}/${left.scope}`.localeCompare(`${right.name}/${right.scope}`),
			);
	} finally {
		store.close();
	}
}

async function main() {
	const { baselineRoot, candidateRoot } = args(process.argv.slice(2));
	const tempRoot = await mkdtemp(join(tmpdir(), "fly2103-bridge-parity-"));
	try {
		const liveRoster = JSON.parse(
			await readFile(join(homedir(), ".flywheel", "projects.json"), "utf8"),
		);
		const baselineConfigs = new Map();
		const candidateConfigs = new Map();
		for (const entry of liveRoster) {
			if (!PROJECTS.includes(entry.projectName)) continue;
			const source =
				entry.projectName === "flywheel"
					? join(baselineRoot, ".flywheel", "config.yaml")
					: join(entry.projectRoot, ".flywheel", "config.yaml");
			const baseline = await readFile(source, "utf8");
			baselineConfigs.set(entry.projectName, baseline);
			candidateConfigs.set(
				entry.projectName,
				entry.projectName === "flywheel"
					? await readFile(
							join(candidateRoot, ".flywheel", "config.yaml"),
							"utf8",
						)
					: stripRetiredKeys(baseline),
			);
		}
		const baseline = await prepareArm({
			arm: "baseline",
			codeRoot: baselineRoot,
			tempRoot,
			roster: liveRoster,
			sourceConfigs: baselineConfigs,
		});
		const candidate = await prepareArm({
			arm: "candidate",
			codeRoot: candidateRoot,
			tempRoot,
			roster: liveRoster,
			sourceConfigs: candidateConfigs,
		});
		const baselineResult = await runArm(baseline, []);
		const candidateResult = await runArm(candidate, ROWS);
		const before = behaviorMatrix(baselineResult.snapshot);
		const after = behaviorMatrix(candidateResult.snapshot);
		const expected = expectedMatrix();
		assert.deepEqual(before, expected);
		assert.deepEqual(after, expected);
		assert.deepEqual(after, before);
		const storedRows = await exactRows(candidateRoot, candidate.dbPath);
		const expectedRows = [...ROWS].sort((left, right) =>
			`${left.name}/${left.scope}`.localeCompare(`${right.name}/${right.scope}`),
		);
		assert.deepEqual(storedRows, expectedRows);
		console.log(
			JSON.stringify(
				{
					baselineCommit: "d4e08f4a55aee01ef261e7f90c40a541e03d0863",
					candidateCommit: process.env.FLY2103_CANDIDATE_COMMIT ?? "working-tree",
					manifest: ROWS,
					baseline: before,
					candidate: after,
					exactRows: storedRows,
					parity: true,
				},
				null,
				2,
			),
		);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
