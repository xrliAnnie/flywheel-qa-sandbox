#!/usr/bin/env node
import { execFile } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	probeCodexDaemonProcessBinding,
	readCodexLaunchSnapshot,
	resolveExecutionCodexHome,
} from "../packages/claude-runner/dist/index.js";
import { resolveCodexCredentialHomeRoster } from "../packages/teamlead/dist/codex-quota/credential-home-roster.js";
import {
	createCodexQuotaHostCollector,
	createRegisteredCodexQuotaHostCollectorOptions,
} from "../packages/teamlead/dist/codex-quota/host-readiness.js";
import { readBoundFly2729Dependency } from "../packages/teamlead/dist/codex-quota/qa-dependency.js";
import { checkCodexQuotaReadiness } from "../packages/teamlead/dist/codex-quota/readiness.js";
import {
	evaluateRegisteredHomeReadiness,
	writeRegisteredReadinessEvidence,
} from "../packages/teamlead/dist/codex-quota/registered-home-readiness.js";
import { createResidentHomeEvidence } from "../packages/teamlead/dist/codex-quota/resident-home-evidence.js";
import { parseAndValidateProjects } from "../packages/teamlead/dist/ProjectConfig.js";
import { StateStore } from "../packages/teamlead/dist/StateStore.js";

const execFileAsync = promisify(execFile);

function fail(reason) {
	const output = {
		schemaVersion: 1,
		scope: "registered_homes",
		registered: { ready: false, homeIds: [], failures: [{ reason }] },
		global: {
			ready: false,
			failures: [{ reason: "authority_unavailable" }],
		},
		unattributedReaders: [],
		activation: { authorized: false, ownedBy: "separate_gated_task" },
		dependencies: {
			"FLY-2729": { status: "pending" },
			desktopCredentialAuthority: { status: "unknown", issueId: null },
		},
	};
	process.stdout.write(`${JSON.stringify(output)}\n`);
	process.exitCode = 1;
}

function parseArgs(argv) {
	let acceptanceScope = "global";
	let snapshotInput;
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index],
			value = argv[index + 1];
		if (!value) throw new Error("usage");
		if (
			key === "--acceptance-scope" &&
			value === "registered_homes" &&
			acceptanceScope === "global"
		)
			acceptanceScope = value;
		else if (key === "--snapshot-input" && snapshotInput === undefined) {
			if (!isAbsolute(value) || resolve(value) !== value)
				throw new Error("snapshot_path_invalid");
			snapshotInput = value;
		} else throw new Error("usage");
	}
	return { acceptanceScope, snapshotInput };
}

function plainJson(path, maxSize = 1024 * 1024) {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxSize) {
		throw new Error("authority_file_unsafe");
	}
	return JSON.parse(readFileSync(path, "utf8"));
}

function readAttempts(root) {
	const stat = lstatSync(root);
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new Error("attempts_unsafe");
	const entries = readdirSync(root)
		.filter((name) => name.endsWith(".json"))
		.sort();
	if (entries.length > 50_000) throw new Error("attempts_unbounded");
	return entries.map((name) => plainJson(join(root, name), 64 * 1024));
}

async function resolveAuthority(authorityScript, target) {
	const { stdout } = await execFileAsync(
		authorityScript,
		["--project", target.projectName, "--lead", target.leadId, "--authority"],
		{ encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 },
	);
	const authority = JSON.parse(stdout);
	if (typeof authority?.codexHome !== "string")
		throw new Error("lead_authority_invalid");
	return { codexHome: authority.codexHome };
}

async function liveInput() {
	const userHome = homedir();
	const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
	const stateRoot =
		process.env.FLYWHEEL_STATE_DIR?.trim() || join(userHome, ".flywheel");
	const canonicalHome =
		process.env.FLYWHEEL_CODEX_SOURCE_HOME?.trim() || join(userHome, ".codex");
	const homesRoot =
		process.env.FLYWHEEL_CODEX_HOMES_ROOT?.trim() ||
		join(stateRoot, "codex-homes");
	const commRoot =
		process.env.FLYWHEEL_COMM_ROOT?.trim() || join(stateRoot, "comm");
	const projectsPath =
		process.env.FLYWHEEL_CODEX_PROJECTS_FILE?.trim() ||
		join(stateRoot, "projects.json");
	const policyPath =
		process.env.FLYWHEEL_CODEX_HOME_POLICY?.trim() ||
		join(repositoryRoot, "scripts/config/codex-quota-home-policy.json");
	const authorityScript =
		process.env.FLYWHEEL_CODEX_LEAD_AUTHORITY_BIN?.trim() ||
		join(repositoryRoot, "scripts/resident-codex-lead-recover.sh");
	for (const path of [
		stateRoot,
		canonicalHome,
		homesRoot,
		commRoot,
		projectsPath,
		policyPath,
		authorityScript,
	]) {
		if (!isAbsolute(path) || resolve(path) !== path)
			throw new Error("authority_path_invalid");
	}
	const projects = parseAndValidateProjects(plainJson(projectsPath));
	const policy = plainJson(policyPath);
	if (policy?.schemaVersion !== 1 || !Array.isArray(policy.runnerHomes))
		throw new Error("policy_invalid");
	const roster = await resolveCodexCredentialHomeRoster(projects, {
		homeDir: userHome,
		runnerHomes: policy.runnerHomes,
		resolveLeadAuthority: (target) => resolveAuthority(authorityScript, target),
	});
	const deployedSha = readFileSync(
		join(stateRoot, "deployed-sha"),
		"utf8",
	).trim();
	if (!/^[a-f0-9]{40}$/.test(deployedSha))
		throw new Error("deployed_sha_invalid");
	const dependencyInputPath =
		process.env.FLYWHEEL_FLY2729_DEPENDENCY_INPUT?.trim();
	const fly2729 = dependencyInputPath
		? readBoundFly2729Dependency(
				{
					expectedRoot: join(stateRoot, "state", "qa-evidence", "FLY-2729"),
					expectedDeployedSha: deployedSha,
				},
				plainJson(dependencyInputPath, 64 * 1024),
			)
		: { status: "pending" };
	const quotaRoot = join(stateRoot, "codex-quota");
	const manifestPath = join(quotaRoot, "readiness-receipt.json");
	const migrationRoot = join(quotaRoot, "home-migration");
	const store = await StateStore.openForMaintenance(
		process.env.TEAMLEAD_DB_PATH?.trim() || join(stateRoot, "teamlead.db"),
		{ readonly: true },
	);
	try {
		const collectHomes = createCodexQuotaHostCollector(
			createRegisteredCodexQuotaHostCollectorOptions(projects, {
				homesRoot,
				canonicalHome,
				commRoot,
				projectNames: projects.map((project) => project.projectName),
				approvedManifestPath: manifestPath,
				leadAuthorityScript: authorityScript,
				residentEvidence: createResidentHomeEvidence({
					getSession: (executionId) => store.getSession(executionId),
					resolveExecutionHome: resolveExecutionCodexHome,
					readLaunchSnapshot: readCodexLaunchSnapshot,
					probeDaemonProcessBinding: probeCodexDaemonProcessBinding,
				}),
			}),
		);
		const inventory = await collectHomes();
		const global = await checkCodexQuotaReadiness({
			canonicalAuthPath: join(canonicalHome, "auth.json"),
			collectHomes: async () => inventory,
		});
		return {
			stateRoot,
			canonicalHome,
			roster,
			expectedBuildSha: deployedSha,
			migrationState: plainJson(join(migrationRoot, "state.json")),
			attemptReceipts: readAttempts(join(migrationRoot, "attempts")),
			manifest: plainJson(manifestPath),
			inventory,
			global,
			dependencies: {
				"FLY-2729": fly2729,
				desktopCredentialAuthority: { status: "unknown", issueId: null },
			},
		};
	} finally {
		store.close();
	}
}

try {
	const args = parseArgs(process.argv.slice(2));
	const input = args.snapshotInput
		? plainJson(args.snapshotInput, 4 * 1024 * 1024)
		: await liveInput();
	const result = await evaluateRegisteredHomeReadiness(input);
	const evidence = {
		schemaVersion: 1,
		scope: "registered_homes",
		inventoryDigest: input.manifest.inventoryDigest,
		deployedSha: input.expectedBuildSha,
		checkedAt: new Date().toISOString(),
		...result,
	};
	const reference = writeRegisteredReadinessEvidence({
		stateRoot: input.stateRoot,
		evidence,
	});
	process.stdout.write(
		`${JSON.stringify({ ...evidence, evidence: reference })}\n`,
	);
	process.exitCode =
		args.acceptanceScope === "registered_homes"
			? result.registered.ready
				? 0
				: 1
			: result.global.ready
				? 0
				: 1;
} catch (error) {
	fail(
		error instanceof Error && /^[a-zA-Z0-9_:-]+$/.test(error.message)
			? error.message
			: "readiness_unavailable",
	);
}
