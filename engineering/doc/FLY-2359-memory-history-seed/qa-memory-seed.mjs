#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RED_TARGETS = {
	"backflow-disabled": new Set([
		"implement_storage_contains_current",
		"next_implement_sees_current",
	]),
	"role-leak": new Set(["qa_excludes_implement", "scale_archive_shape"]),
	"project-leak": new Set([
		"flywheel_excludes_joycon",
		"scale_archive_shape",
	]),
	"seed-disabled": new Set([
		"historical_seed_available",
		"scale_archive_shape",
		"qa_positive_control",
		"joycon_positive_control",
	]),
};
const RED_REQUIRED_FILES = {
	"backflow-disabled": ["packages/claude-runner/src/codex-home.ts"],
	"seed-disabled": ["packages/claude-runner/src/codex-home.ts"],
	"role-leak": ["packages/teamlead/src/bridge/run-infra.ts"],
	"project-leak": [
		"packages/teamlead/src/StateStore.ts",
		"packages/teamlead/src/bridge/run-infra.ts",
	],
};

function usage() {
	return `Usage:
  node engineering/doc/FLY-2359-memory-history-seed/qa-memory-seed.mjs \\
    --slot <N> --expect-head <40-hex-sha> [--fixture-only]

GREEN runs use the real Codex binary by default. --fixture-only exercises only
the real built StateStore/admit/provision/retire path and cannot be reported as
full product acceptance.

Mutation detector:
  --expect-red backflow-disabled|role-leak|project-leak|seed-disabled \\
    --mutation-base <unmutated-40-hex-sha> --mutation-diff <file>

Exit 0: every GREEN assertion passed, or the named RED guard failed as expected
Exit 1: setup, identity, build, model receipt, or assertion mismatch
`;
}

export function parseArgs(argv) {
	const args = { expectRed: "none", runModel: true };
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (value === "--slot") args.slot = Number(argv[++index]);
		else if (value === "--expect-head") args.expectHead = argv[++index];
		else if (value === "--evidence-dir") args.evidenceDir = argv[++index];
		else if (value === "--fixture-only") args.runModel = false;
		else if (value === "--expect-red") args.expectRed = argv[++index];
		else if (value === "--mutation-base") args.mutationBase = argv[++index];
		else if (value === "--mutation-diff") args.mutationDiff = argv[++index];
		else if (value === "--help" || value === "-h") args.help = true;
		else throw new Error(`unknown argument: ${value}`);
	}
	if (args.help) return args;
	if (!Number.isInteger(args.slot) || args.slot < 1)
		throw new Error("--slot must be a positive integer");
	if (!/^[a-f0-9]{40}$/.test(args.expectHead ?? ""))
		throw new Error("--expect-head must be an exact 40-character Git SHA");
	if (args.expectRed !== "none" && !RED_TARGETS[args.expectRed])
		throw new Error("--expect-red has an unsupported value");
	if (args.expectRed !== "none") {
		if (!/^[a-f0-9]{40}$/.test(args.mutationBase ?? ""))
			throw new Error("RED runs require --mutation-base <40-hex-sha>");
		if (!args.mutationDiff || !existsSync(args.mutationDiff))
			throw new Error("RED runs require --mutation-diff <existing-file>");
		if (statSync(args.mutationDiff).size === 0)
			throw new Error("RED mutation diff must not be empty");
		if (args.runModel)
			throw new Error("RED mutation runs require --fixture-only");
	}
	return args;
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function markdownFiles(root, cursor = root) {
	const output = [];
	for (const entry of readdirSync(cursor, { withFileTypes: true })) {
		const path = join(cursor, entry.name);
		if (entry.isSymbolicLink()) throw new Error(`fixture symlink refused: ${path}`);
		if (entry.isDirectory()) output.push(...markdownFiles(root, path));
		else if (entry.isFile() && entry.name.endsWith(".md")) {
			output.push(relative(root, path).split("\\").join("/"));
		} else throw new Error(`unexpected fixture entry: ${path}`);
	}
	return output.sort();
}

export function readFixtureManifest(root) {
	const path = join(root, "manifest.json");
	const manifest = JSON.parse(readFileSync(path, "utf8"));
	if (manifest.version !== 1 || !Array.isArray(manifest.sources))
		throw new Error("fixture manifest version=1 with sources is required");
	for (const source of manifest.sources) {
		const directory = join(root, source.key);
		const actual = Object.fromEntries(
			markdownFiles(directory).map((name) => [
				name,
				sha256(readFileSync(join(directory, name))),
			]),
		);
		if (JSON.stringify(actual) !== JSON.stringify(source.files)) {
			throw new Error(`fixture hash mismatch: ${source.key}`);
		}
	}
	return manifest;
}

export function evaluateExpectedOutcome(assertions, expectRed) {
	if (expectRed === "none") {
		return {
			passed: assertions.every((row) => row.passed),
			expectedFailureObserved: null,
		};
	}
	const allowed = RED_TARGETS[expectRed];
	const failed = assertions.filter((row) => !row.passed).map((row) => row.id);
	const targets =
		expectRed === "backflow-disabled"
			? ["implement_storage_contains_current", "next_implement_sees_current"]
			: expectRed === "role-leak"
				? ["qa_excludes_implement"]
				: expectRed === "project-leak"
					? ["flywheel_excludes_joycon"]
					: ["historical_seed_available"];
	const observed = targets.every((target) => failed.includes(target));
	return {
		passed: observed && failed.every((id) => allowed.has(id)),
		expectedFailureObserved: observed,
	};
}

function writeJsonAtomic(path, value) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.tmp.${process.pid}`;
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	chmodSync(temp, 0o600);
	renameSync(temp, path);
}

function command(file, args, options = {}) {
	return execFileSync(file, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		...options,
	}).trim();
}

function verifyMutation(args, repo) {
	if (args.expectRed === "none") return null;
	const provided = readFileSync(args.mutationDiff);
	const actual = execFileSync("git", [
		"-C",
		repo,
		"diff",
		"--binary",
		`${args.mutationBase}...${args.expectHead}`,
		"--",
		"packages/",
	]);
	if (!provided.equals(actual))
		throw new Error("mutation diff does not match the deployed exact head");
	const files = command("git", [
		"-C",
		repo,
		"diff",
		"--name-only",
		`${args.mutationBase}...${args.expectHead}`,
		"--",
		"packages/",
	])
		.split("\n")
		.filter(Boolean);
	for (const required of RED_REQUIRED_FILES[args.expectRed]) {
		if (!files.includes(required))
			throw new Error(
				`mutation does not change required production file: ${required}`,
			);
	}
	return { baseSha: args.mutationBase, files, sha256: sha256(actual) };
}

async function roomContext(args) {
	const slotDir = `/tmp/flywheel-test-slot-${args.slot}`;
	const roomPath = join(slotDir, "room-info.json");
	if (!existsSync(roomPath)) throw new Error(`room not found: ${roomPath}`);
	const room = JSON.parse(readFileSync(roomPath, "utf8"));
	if (
		room.schemaVersion !== 1 ||
		room.mode !== "slot" ||
		room.generalized !== true ||
		room.runnerMode !== "real" ||
		room.slot !== args.slot
	) {
		throw new Error("a generalized real-runner slot room is required");
	}
	if (room.buildSha !== args.expectHead)
		throw new Error(`room buildSha mismatch: ${room.buildSha}`);
	const repo = resolve(room.flywheelRepo);
	if (command("git", ["-C", repo, "rev-parse", "HEAD"]) !== args.expectHead)
		throw new Error("room checkout drifted from --expect-head");
	const healthResponse = await fetch(`${room.bridgeUrl}/health`);
	const health = await healthResponse.json();
	if (
		!healthResponse.ok ||
		health.ok !== true ||
		health.buildMode !== "built" ||
		health.buildSha !== args.expectHead ||
		health.artifactBuildSha !== args.expectHead
	) {
		throw new Error(`room health identity mismatch: ${JSON.stringify(health)}`);
	}
	const buildIdentity = JSON.parse(
		readFileSync(join(repo, "packages/teamlead/dist/build-identity.json"), "utf8"),
	);
	if (buildIdentity.artifactBuildSha !== args.expectHead)
		throw new Error("TeamLead dist build identity is stale");
	const mutation = verifyMutation(args, repo);
	const evidenceDir = resolve(
		args.evidenceDir ??
			join(
				slotDir,
				"fly2359-memory-seed-evidence",
				`${args.expectHead.slice(0, 12)}-${Date.now()}`,
			),
	);
	if (existsSync(evidenceDir)) throw new Error("evidence directory already exists");
	mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
	return {
		room,
		repo,
		slotDir,
		evidenceDir,
		homesRoot: join(slotDir, "state", "codex-homes"),
		sessionsRoot: join(slotDir, "state", "codex-sessions"),
		health,
		mutation,
	};
}

function writeSessionState(root, executionId, identity, home) {
	writeJsonAtomic(join(root, executionId, "session.json"), {
		codexAgentHome: { ...identity, home },
	});
}

function copyMemoryTree(fixtureRoot, key, homesRoot, executionId) {
	const destination = join(homesRoot, executionId, "memories");
	if (existsSync(destination)) throw new Error(`fixture source exists: ${executionId}`);
	mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
	cpSync(join(fixtureRoot, key), destination, { recursive: true, errorOnExist: true });
	return destination;
}

function readCorpus(home) {
	const roots = [
		join(home, "memories"),
		join(home, ".flywheel-memory-seed", "snapshots"),
	];
	let text = "";
	for (const root of roots) {
		if (!existsSync(root)) continue;
		for (const name of markdownFiles(root))
			text += `\n${readFileSync(join(root, name), "utf8")}`;
	}
	return text;
}

function sessionRow(executionId, source, status = "completed") {
	return {
		execution_id: executionId,
		issue_id: `fixture-${executionId}`,
		issue_identifier: source.issueIdentifier,
		issue_title: source.issueTitle,
		project_name: source.identity.project,
		workflow_node_id: source.identity.role,
		adapter_type: "codex-tmux",
		started_at: source.startedAt,
		status,
	};
}

function prepareScaleFixtures(store, fixtureRoot, manifest, homesRoot, suffix) {
	const byKey = new Map(manifest.sources.map((source) => [source.key, source]));
	const physicalKeys = ["f", "conflict-a", "conflict-b"];
	const nonEmpty = [];
	for (const key of physicalKeys) {
		const source = byKey.get(key);
		const executionId = `${source.executionId}-${suffix}`;
		copyMemoryTree(fixtureRoot, key, homesRoot, executionId);
		store.upsertSession(sessionRow(executionId, source));
		nonEmpty.push({ executionId, source });
	}
	for (let index = physicalKeys.length; index < 217; index += 1) {
		const executionId = `fly2359-scale-${String(index).padStart(3, "0")}-${suffix}`;
		const memories = join(homesRoot, executionId, "memories");
		mkdirSync(memories, { recursive: true, mode: 0o700 });
		writeFileSync(
			join(memories, "MEMORY.md"),
			`# Generated history ${index}\n\nMarker: FLY2359_SCALE_${String(index).padStart(3, "0")}\n`,
			{ mode: 0o600 },
		);
		const source = {
			identity: { project: "flywheel", role: "implement" },
			issueIdentifier: `FLY-${3000 + index}`,
			issueTitle: `Scale topic ${String(index).padStart(3, "0")}`,
			startedAt: new Date(Date.UTC(2025, 0, 1 + index)).toISOString(),
		};
		store.upsertSession(sessionRow(executionId, source));
		nonEmpty.push({ executionId, source });
	}
	for (let index = 0; index < 8; index += 1) {
		const executionId = `fly2359-duplicate-${String(index).padStart(3, "0")}-${suffix}`;
		const original = nonEmpty[index];
		mkdirSync(join(homesRoot, executionId), { recursive: true, mode: 0o700 });
		cpSync(
			join(homesRoot, original.executionId, "memories"),
			join(homesRoot, executionId, "memories"),
			{ recursive: true, errorOnExist: true },
		);
		store.upsertSession(
			sessionRow(executionId, {
				...original.source,
				issueIdentifier: `FLY-${4000 + index}`,
				issueTitle: `Duplicate tree ${String(index).padStart(3, "0")}`,
				startedAt: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
			}),
		);
	}
	for (let index = 0; index < 380; index += 1) {
		const executionId = `fly2359-empty-${String(index).padStart(3, "0")}-${suffix}`;
		store.upsertSession(
			sessionRow(executionId, {
				identity: { project: "flywheel", role: "implement" },
				issueIdentifier: `FLY-${5000 + index}`,
				issueTitle: `No memory ${String(index).padStart(3, "0")}`,
				startedAt: new Date(Date.UTC(2024, 0, 1 + index)).toISOString(),
			}),
		);
	}
	return nonEmpty;
}

function modelReadPaths(transcript, home) {
	const archive = join(home, ".flywheel-memory-seed");
	const paths = [
		join(home, "memories", "MEMORY.md"),
		join(archive, "index.md"),
		join(archive, "catalog.md"),
		...markdownFiles(join(archive, "snapshots")).map((name) =>
			join(archive, "snapshots", name),
		),
	];
	return paths
		.filter((path) =>
			transcript.includes(path) ||
			transcript.includes(relative(home, path).split("\\").join("/")),
		)
		.map((path) => ({ path: relative(home, path), bytes: statSync(path).size }));
}

function runCodexProbe(context, name, home, prompt) {
	const outputPath = join(context.evidenceDir, `model-${name}-last.txt`);
	const transcriptPath = join(context.evidenceDir, `model-${name}.jsonl`);
	const workspace = join(context.slotDir, "state", "fly2359-model-workspace");
	mkdirSync(workspace, { recursive: true, mode: 0o700 });
	const result = spawnSync(
		"codex",
		[
			"exec",
			"--json",
			"--ephemeral",
			"--sandbox",
			"read-only",
			"--skip-git-repo-check",
			"--cd",
			workspace,
			"--output-last-message",
			outputPath,
			prompt,
		],
		{
			cwd: workspace,
			env: { ...process.env, CODEX_HOME: home },
			encoding: "utf8",
			timeout: 10 * 60_000,
			maxBuffer: 16 * 1024 * 1024,
		},
	);
	writeFileSync(transcriptPath, result.stdout ?? "", { mode: 0o600 });
	writeFileSync(join(context.evidenceDir, `model-${name}.stderr.txt`), result.stderr ?? "", {
		mode: 0o600,
	});
	if (result.status !== 0)
		throw new Error(`Codex ${name} probe failed with status ${result.status}`);
	const transcript = result.stdout ?? "";
	const events = transcript
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	const thread = events.find((event) => event.type === "thread.started");
	const completed = events.find((event) => event.type === "turn.completed");
	if (!thread?.thread_id || !completed)
		throw new Error(`Codex ${name} probe has no live thread receipt`);
	return {
		threadId: thread.thread_id,
		usage: completed.usage ?? null,
		answer: readFileSync(outputPath, "utf8"),
		readPaths: modelReadPaths(transcript, home),
	};
}

async function runAcceptance(args, context) {
	const fixtureRoot = join(HERE, "fixtures");
	const fixtureManifest = readFixtureManifest(fixtureRoot);
	const suffix = args.expectHead.slice(0, 12);
	const env = {
		...process.env,
		FLYWHEEL_CODEX_HOMES_ROOT: context.homesRoot,
		FLYWHEEL_CODEX_SESSION_DIR: context.sessionsRoot,
	};
	process.env.FLYWHEEL_CODEX_HOMES_ROOT = context.homesRoot;
	process.env.FLYWHEEL_CODEX_SESSION_DIR = context.sessionsRoot;
	mkdirSync(context.homesRoot, { recursive: true, mode: 0o700 });
	mkdirSync(context.sessionsRoot, { recursive: true, mode: 0o700 });

	const runner = await import(
		`${pathToFileURL(join(context.repo, "packages/claude-runner/dist/index.js")).href}?fly2359=${suffix}`
	);
	const { StateStore } = await import(
		`${pathToFileURL(join(context.repo, "packages/teamlead/dist/StateStore.js")).href}?fly2359=${suffix}`
	);
	const { createCodexMemorySeedSourcesLoader } = await import(
		`${pathToFileURL(join(context.repo, "packages/teamlead/dist/bridge/run-infra.js")).href}?fly2359=${suffix}`
	);
	const identities = {
		f: { project: "flywheel", role: "implement" },
		q: { project: "flywheel", role: "qa" },
		j: { project: "joycon-typeless", role: "implement" },
	};
	for (const identity of Object.values(identities)) {
		const home = runner.codexAgentHomeDir(identity, env);
		if (existsSync(home))
			throw new Error(`target home already exists; rebuild the slot: ${home}`);
	}

	const store = await StateStore.create(context.room.dbPath);
	const active = new Map();
	const assertions = [];
	const check = (id, passed, detail) =>
		assertions.push({ id, passed: Boolean(passed), detail });
	try {
		prepareScaleFixtures(store, fixtureRoot, fixtureManifest, context.homesRoot, suffix);
		for (const key of ["q", "j"]) {
			const source = fixtureManifest.sources.find((row) => row.key === key);
			const executionId = `${source.executionId}-${suffix}`;
			copyMemoryTree(fixtureRoot, key, context.homesRoot, executionId);
			store.upsertSession(sessionRow(executionId, source));
		}
		store.upsertSession({
			execution_id: `fly2359-no-node-${suffix}`,
			issue_id: "fixture-no-node",
			project_name: "flywheel",
			adapter_type: "codex-tmux",
			status: "completed",
		});
		store.upsertSession({
			execution_id: `fly2359-bad-adapter-${suffix}`,
			issue_id: "fixture-bad-adapter",
			project_name: "flywheel",
			workflow_node_id: "implement",
			adapter_type: "claude-tmux",
			status: "completed",
		});
		const loader = createCodexMemorySeedSourcesLoader(store);
		const provision = async (admission) => {
			active.set(admission.handle.executionId, admission.handle);
			await runner.provisionCodexAgentHome(admission.handle, {
				env,
				contractSourcePath: join(
					context.repo,
					"packages/claude-runner/agents/codex-runner-contract.md",
				),
				skillFrameworkMode: admission.effectiveAssemblyArm,
				trustedProjectPath: context.repo,
			});
		};
		const retire = async (executionId, identity, home) => {
			writeSessionState(context.sessionsRoot, executionId, identity, home);
			await runner.retireCodexExecutionHome(executionId, identity, env);
			active.delete(executionId);
		};

		const f1 = `fly2359-current-f1-${suffix}`;
		store.upsertSession(
			sessionRow(
				f1,
				{
					identity: identities.f,
					issueIdentifier: "FLY-2359-F1",
					issueTitle: "Current implement fixture one",
					startedAt: "2026-09-08T00:00:00Z",
				},
				"running",
			),
		);
		const seedStarted = process.hrtime.bigint();
		const first = await runner.admitCodexAgentHome({
			...identities.f,
			executionId: f1,
			requestedAssemblyArm: "bare",
			loadMemorySeedSources: () => loader({ ...identities.f, currentExecutionId: f1 }),
		}, env);
		const seedDurationMs = Number(process.hrtime.bigint() - seedStarted) / 1e6;
		check(
			"scale_lock_under_5s",
			seedDurationMs < 5000,
			`${seedDurationMs.toFixed(1)}ms`,
		);
		await provision(first);
		const currentMarker = `FLY2359_CURRENT_IMPLEMENT_${suffix.toUpperCase()}`;
		const nativeMemory = join(first.handle.home, "memories", "MEMORY.md");
		mkdirSync(dirname(nativeMemory), { recursive: true, mode: 0o700 });
		writeFileSync(nativeMemory, `# Distilled current memory\n\nMarker: ${currentMarker}\n`, {
			mode: 0o600,
		});
		await retire(f1, identities.f, first.handle.home);
		store.upsertSession(
			sessionRow(f1, {
				identity: identities.f,
				issueIdentifier: "FLY-2359-F1",
				issueTitle: "Current implement fixture one",
				startedAt: "2026-09-08T00:00:00Z",
			}),
		);
		check(
			"implement_storage_contains_current",
			existsSync(
				join(runner.codexAgentHomeDir(identities.f, env), "memories", "MEMORY.md"),
			) &&
				readFileSync(
					join(
						runner.codexAgentHomeDir(identities.f, env),
						"memories",
						"MEMORY.md",
					),
					"utf8",
				).includes(currentMarker),
			runner.codexAgentHomeDir(identities.f, env),
		);

		let reusedLoaderCalls = 0;
		const f2 = `fly2359-current-f2-${suffix}`;
		store.upsertSession(
			sessionRow(
				f2,
				{
					identity: identities.f,
					issueIdentifier: "FLY-2359-F2",
					issueTitle: "Current implement fixture two",
					startedAt: "2026-09-08T00:01:00Z",
				},
				"running",
			),
		);
		const second = await runner.admitCodexAgentHome({
			...identities.f,
			executionId: f2,
			requestedAssemblyArm: "bare",
			loadMemorySeedSources: async () => {
				reusedLoaderCalls += 1;
				return loader({ ...identities.f, currentExecutionId: f2 });
			},
		}, env);
		await provision(second);
		const secondNativeMemory = join(second.handle.home, "memories", "MEMORY.md");
		check(
			"next_implement_sees_current",
			existsSync(secondNativeMemory) &&
				readFileSync(secondNativeMemory, "utf8").includes(currentMarker) &&
				second.handle.home === first.handle.home &&
				reusedLoaderCalls === 0,
			`memorySeed=${second.memorySeed} loaderCalls=${reusedLoaderCalls}`,
		);

		const fArchive = join(second.handle.home, ".flywheel-memory-seed");
		const fManifest = existsSync(join(fArchive, "manifest.json"))
			? JSON.parse(readFileSync(join(fArchive, "manifest.json"), "utf8"))
			: null;
		const fCorpus = readCorpus(second.handle.home);
		const fIndex = existsSync(join(fArchive, "index.md"))
			? readFileSync(join(fArchive, "index.md"), "utf8")
			: "";
		const fCatalog = existsSync(join(fArchive, "catalog.md"))
			? readFileSync(join(fArchive, "catalog.md"), "utf8")
			: "";
		const fMarker = fixtureManifest.sources.find((row) => row.key === "f").marker;
		const qMarker = fixtureManifest.sources.find((row) => row.key === "q").marker;
		const jMarker = fixtureManifest.sources.find((row) => row.key === "j").marker;
		check(
			"historical_seed_available",
			fCorpus.includes(fMarker) &&
				!fIndex.includes("Amber river retrospective") &&
				fCatalog.includes("Amber river retrospective"),
			"old F topic is outside the recent index and catalog-searchable",
		);
		check(
			"scale_archive_shape",
			fManifest?.sources?.length === 225 &&
				fManifest?.snapshots?.length === 217 &&
				fManifest?.skipped?.filter((row) => row.reason === "no_memory").length === 380 &&
				fixtureManifest.controls.every((control) =>
					fManifest?.skipped?.some(
						(row) =>
							row.executionId === `fly2359-${control.key}-${suffix}` &&
							row.reason === control.expectedSkip,
					),
				) &&
				statSync(join(fArchive, "index.md")).size <= 8192,
			fManifest
				? `sources=${fManifest.sources.length} snapshots=${fManifest.snapshots.length} skipped=${fManifest.skipped.length} index=${statSync(join(fArchive, "index.md")).size}`
				: "archive missing",
		);

		const homes = { f: second.handle.home };
		const current = {};
		for (const key of ["q", "j"]) {
			const identity = identities[key];
			const executionId = `fly2359-current-${key}-${suffix}`;
			store.upsertSession(
				sessionRow(
					executionId,
					{
						identity,
						issueIdentifier: key === "q" ? "FLY-2359-Q" : "JOY-2359-J",
						issueTitle: `${key.toUpperCase()} isolation fixture`,
						startedAt: "2026-09-08T00:02:00Z",
					},
					"running",
				),
			);
			const admission = await runner.admitCodexAgentHome({
				...identity,
				executionId,
				requestedAssemblyArm: "bare",
				loadMemorySeedSources: () => loader({ ...identity, currentExecutionId: executionId }),
			}, env);
			await provision(admission);
			homes[key] = admission.handle.home;
			writeSessionState(
				context.sessionsRoot,
				executionId,
				identity,
				admission.handle.home,
			);
			current[key] = { executionId, identity, admission };
		}
		const qCorpus = readCorpus(homes.q);
		const jCorpus = readCorpus(homes.j);
		check("qa_positive_control", qCorpus.includes(qMarker), homes.q);
		check("qa_excludes_implement", !qCorpus.includes(fMarker), homes.q);
		check("joycon_positive_control", jCorpus.includes(jMarker), homes.j);
		check("flywheel_excludes_joycon", !fCorpus.includes(jMarker), homes.f);

		const model = {};
		if (args.runModel) {
			model.f = runCodexProbe(
				context,
				"flywheel-implement",
				homes.f,
				"This is a fresh task. Follow the home contract. Report the marker from the most recent native distilled current memory, then find the older historical note about the amber river retrospective and report its marker. Do not use web search or inspect another home. Report the exact home-relative files you read.",
			);
			model.q = runCodexProbe(
				context,
				"flywheel-qa",
				homes.q,
				"This is a fresh QA task. Follow the home contract to find the quartz lake note. Do not use web search or inspect another home. Report its exact marker, whether an implementation marker is present, and the exact home-relative files you read.",
			);
			model.j = runCodexProbe(
				context,
				"joycon-implement",
				homes.j,
				"This is a fresh implementation task. Follow the home contract to find the juniper field note. Do not use web search or inspect another home. Report its exact marker, whether a flywheel marker is present, and the exact home-relative files you read.",
			);
			check(
				"model_f_reads_current_and_seed",
				model.f.answer.includes(currentMarker) &&
					model.f.answer.includes(fMarker) &&
					model.f.readPaths.some((row) => row.path === "memories/MEMORY.md") &&
					model.f.readPaths.some((row) => row.path === ".flywheel-memory-seed/index.md") &&
					model.f.readPaths.some((row) => row.path === ".flywheel-memory-seed/catalog.md") &&
					model.f.readPaths.some((row) => row.path.includes("snapshots/")),
				model.f.threadId,
			);
			check(
				"model_q_isolated",
				model.q.answer.includes(qMarker) && !model.q.answer.includes(fMarker),
				model.q.threadId,
			);
			check(
				"model_j_isolated",
				model.j.answer.includes(jMarker) && !model.j.answer.includes(fMarker),
				model.j.threadId,
			);
		} else {
			model.skipped = "fixture-only is not real-model acceptance";
		}
		await retire(f2, identities.f, second.handle.home);
		store.upsertSession(
			sessionRow(f2, {
				identity: identities.f,
				issueIdentifier: "FLY-2359-F2",
				issueTitle: "Current implement fixture two",
				startedAt: "2026-09-08T00:01:00Z",
			}),
		);
		for (const key of ["q", "j"]) {
			const row = current[key];
			await retire(row.executionId, row.identity, row.admission.handle.home);
			store.upsertSession(
				sessionRow(row.executionId, {
					identity: row.identity,
					issueIdentifier: key === "q" ? "FLY-2359-Q" : "JOY-2359-J",
					issueTitle: `${key.toUpperCase()} isolation fixture`,
					startedAt: "2026-09-08T00:02:00Z",
				}),
			);
		}

		const identityRows = ["flywheel", "joycon-typeless"]
			.flatMap((project) => store.getProjectSessions(project))
			.filter((row) => row.execution_id.includes(suffix))
			.map((row) => ({
				executionId: row.execution_id,
				projectName: row.project_name,
				workflowNodeId: row.workflow_node_id ?? null,
				adapterType: row.adapter_type ?? null,
				status: row.status,
			}));
		const result = evaluateExpectedOutcome(assertions, args.expectRed);
		return { assertions, result, model, identityRows, homes, fixtureManifest };
	} finally {
		for (const handle of active.values()) {
			try {
				await runner.releaseCodexAgentHomeLease(handle, env);
			} catch {
				// Evidence is already fail-closed; make a best-effort exact-lease release.
			}
		}
		store.close();
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		process.stdout.write(usage());
		return;
	}
	const context = await roomContext(args);
	const codexVersion = command("codex", ["--version"]);
	const startedAt = new Date().toISOString();
	const baseEvidence = {
		schemaVersion: 1,
		issue: "FLY-2359",
		testedSha: args.expectHead,
		expectRed: args.expectRed,
		fixtureOnly: !args.runModel,
		startedAt,
		codexVersion,
		health: {
			buildMode: context.health.buildMode,
			buildSha: context.health.buildSha,
			artifactBuildSha: context.health.artifactBuildSha,
		},
		mutationDiff: args.mutationDiff
			? {
					path: resolve(args.mutationDiff),
					...context.mutation,
				}
			: null,
	};
	writeJsonAtomic(join(context.evidenceDir, "preflight.json"), baseEvidence);
	try {
		const acceptance = await runAcceptance(args, context);
		writeJsonAtomic(join(context.evidenceDir, "assertions.json"), {
			...baseEvidence,
			completedAt: new Date().toISOString(),
			...acceptance,
		});
		process.stdout.write(
			`${acceptance.result.passed ? "PASS" : "FAIL"} FLY-2359 memory seed (${args.expectRed})\nEvidence: ${context.evidenceDir}\n`,
		);
		if (!acceptance.result.passed) process.exitCode = 1;
	} catch (error) {
		writeJsonAtomic(join(context.evidenceDir, "failure.json"), {
			...baseEvidence,
			failedAt: new Date().toISOString(),
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
		process.exitCode = 1;
	});
}
