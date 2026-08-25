#!/usr/bin/env node
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
	identifyCodexAuth,
	loadCodexAccountRegistry,
	readCodexAccountSnapshot,
	recordCodexAccountObservation,
	redactCodexEmail,
} from "./codex-account-core.mjs";

function fail(message) {
	throw new Error(message);
}

function usage() {
	return `Usage: flywheel-codex-profile <command> [args] [--json]

Manual Codex account control for one CODEX_HOME.

Commands:
  list          Show the canonical School/Personal/Business pool
  use <name>    Install a verified pool credential into this home
  save <name>   Save this home's credential to its matching pool slot
  status        Inspect the live auth.json identity and sidecar drift
  next          Disabled: automatic account switching is retired`;
}

function parseArgs(argv) {
	const values = {};
	let index = 0;
	while (index < argv.length && argv[index]?.startsWith("--")) {
		const flag = argv[index];
		if (flag === "--json") break;
		if (
			!["--home", "--profiles", "--ledger-root", "--registry"].includes(flag)
		) {
			fail(`Unknown option: ${flag}`);
		}
		const value = argv[index + 1];
		if (!value) fail(`Missing value for ${flag}`);
		values[flag.slice(2)] = value;
		index += 2;
	}
	for (const key of ["home", "profiles", "ledger-root", "registry"]) {
		const value = values[key];
		if (typeof value !== "string" || !isAbsolute(value)) {
			fail(`--${key} must be an explicit absolute path`);
		}
	}
	const command = argv[index];
	const rest = argv.slice(index + 1);
	const json = rest.includes("--json");
	const positional = rest.filter((value) => value !== "--json");
	return {
		home: values.home,
		profiles: values.profiles,
		ledgerRoot: values["ledger-root"],
		registryPath: values.registry,
		command,
		json,
		positional,
	};
}

function assertSafeDirectory(path, label, { create = false } = {}) {
	if (!lstatIfExists(path)) {
		if (!create) fail(`${label} does not exist: ${path}`);
		mkdirSync(path, { recursive: true, mode: 0o700 });
	}
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		fail(`${label} must be a real directory, not a symlink: ${path}`);
	}
}

function lstatIfExists(path) {
	try {
		return lstatSync(path);
	} catch (error) {
		if (error && typeof error === "object" && error.code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

function readSafeFile(path, label) {
	let stat;
	try {
		stat = lstatSync(path);
	} catch (error) {
		fail(
			`${label} is unavailable at ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (stat.isSymbolicLink() || !stat.isFile()) {
		fail(`${label} must be a regular file, not a symlink: ${path}`);
	}
	let fd;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const opened = fstatSync(fd);
		if (!opened.isFile()) fail(`${label} must be a regular file: ${path}`);
		return readFileSync(fd, "utf8");
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function assertReplaceableFile(path, label) {
	const stat = lstatIfExists(path);
	if (!stat) return;
	if (stat.isSymbolicLink() || !stat.isFile()) {
		fail(`${label} must be a regular file, not a symlink: ${path}`);
	}
}

function atomicWrite(path, contents, mode, verify) {
	assertReplaceableFile(path, basename(path));
	const tempPath = join(
		dirname(path),
		`.${basename(path)}.${process.pid}.${Date.now()}.tmp`,
	);
	let fd;
	try {
		fd = openSync(
			tempPath,
			constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
			mode,
		);
		writeFileSync(fd, contents);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		if (verify) verify(tempPath);
		renameSync(tempPath, path);
		const directoryFd = openSync(dirname(path), constants.O_RDONLY);
		try {
			fsyncSync(directoryFd);
		} finally {
			closeSync(directoryFd);
		}
	} finally {
		if (fd !== undefined) closeSync(fd);
		rmSync(tempPath, { force: true });
	}
}

function expectedProfile(registry, name) {
	const profile = registry.profiles.find(
		(candidate) => candidate.name === name,
	);
	if (!profile) {
		fail(
			`Unknown Codex profile '${name ?? ""}'; expected school, personal, or business`,
		);
	}
	return profile;
}

function verifiedAuth(path, expected, registry) {
	const raw = readSafeFile(path, `Codex ${expected} auth.json`);
	const identity = identifyCodexAuth(raw, registry);
	if (identity.profile !== expected) {
		fail(
			`Codex credential identity mismatch: expected ${expected}, found ${identity.profile} (${redactCodexEmail(identity.email)})`,
		);
	}
	return { raw, identity };
}

function readSidecar(home) {
	const path = join(home, ".active");
	if (!lstatIfExists(path)) return null;
	return readSafeFile(path, "Codex profile sidecar").trim() || null;
}

function ledgerSnapshotPath(context, profile) {
	return join(context.ledgerRoot, `${profile}.json`);
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

function recordObservationBestEffort(context, identity, source) {
	try {
		recordCodexAccountObservation({
			identity,
			home: context.home,
			source,
			ledgerRoot: context.ledgerRoot,
			registryPath: context.registryPath,
		});
	} catch (error) {
		console.warn(
			`[codex-profile] account ledger observation failed for ${identity.profile}; live identity remains authoritative; ledger snapshot ${ledgerSnapshotPath(context, identity.profile)}: ${errorMessage(error)}`,
		);
	}
}

function status(context) {
	assertSafeDirectory(context.home, "CODEX_HOME");
	const raw = readSafeFile(
		join(context.home, "auth.json"),
		"Codex home auth.json",
	);
	const actual = identifyCodexAuth(raw, context.registry);
	const sidecarHint = readSidecar(context.home);
	const drift = sidecarHint !== null && sidecarHint !== actual.profile;
	const result = { actual, sidecarHint, drift };
	if (context.json) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		console.log(`Actual profile: ${actual.profile}`);
		console.log(`Email: ${redactCodexEmail(actual.email)}`);
		console.log(`Account: ${actual.accountId ?? "unknown"}`);
		console.log(`Plan: ${actual.plan ?? "unknown"}`);
		console.log(`Mode: ${actual.mode}`);
		console.log(
			`Sidecar hint: ${sidecarHint ?? "none"}${drift ? " (DRIFT)" : ""}`,
		);
	}
	recordObservationBestEffort(context, actual, "status");
}

function list(context) {
	assertSafeDirectory(context.profiles, "Codex profile pool");
	const profiles = context.registry.profiles.map((profile) => {
		const profileDir = join(context.profiles, profile.name);
		let lastObservation = null;
		let ledgerUnreadable = false;
		try {
			lastObservation = readCodexAccountSnapshot(profile.name, {
				ledgerRoot: context.ledgerRoot,
				registryPath: context.registryPath,
			});
		} catch (error) {
			ledgerUnreadable = true;
			console.warn(
				`[codex-profile] ledger snapshot unreadable for ${profile.name} at ${ledgerSnapshotPath(context, profile.name)}; live identity remains authoritative: ${errorMessage(error)}`,
			);
		}
		const ledgerStatus = ledgerUnreadable ? { ledgerUnreadable: true } : {};
		try {
			assertSafeDirectory(profileDir, `Codex ${profile.name} profile`);
			const identity = verifiedAuth(
				join(profileDir, "auth.json"),
				profile.name,
				context.registry,
			).identity;
			return {
				...profile,
				status: "ready",
				identity,
				lastObservation,
				...ledgerStatus,
			};
		} catch (error) {
			return {
				...profile,
				status: "invalid",
				lastObservation,
				...ledgerStatus,
				error: errorMessage(error),
			};
		}
	});
	const canonical = new Set(
		context.registry.profiles.map((profile) => profile.name),
	);
	const untracked = readdirSync(context.profiles, { withFileTypes: true })
		.filter(
			(entry) =>
				(entry.isDirectory() || entry.isSymbolicLink()) &&
				!canonical.has(entry.name),
		)
		.map((entry) => entry.name)
		.sort();
	const result = { primary: context.registry.primary, profiles, untracked };
	if (context.json) {
		console.log(JSON.stringify(result, null, 2));
		return;
	}
	for (const profile of profiles) {
		const ledgerStatus = profile.ledgerUnreadable ? " [ledger unreadable]" : "";
		console.log(
			`${profile.name}: ${profile.status} (${profile.role})${ledgerStatus}`,
		);
	}
	if (untracked.length > 0) console.log(`Untracked: ${untracked.join(", ")}`);
}

function use(context, name) {
	expectedProfile(context.registry, name);
	assertSafeDirectory(context.profiles, "Codex profile pool");
	const profileDir = join(context.profiles, name);
	assertSafeDirectory(profileDir, `Codex ${name} profile`);
	const source = verifiedAuth(
		join(profileDir, "auth.json"),
		name,
		context.registry,
	);
	assertSafeDirectory(context.home, "CODEX_HOME", { create: true });
	atomicWrite(
		join(context.home, "auth.json"),
		source.raw,
		0o600,
		(tempPath) => {
			verifiedAuth(tempPath, name, context.registry);
		},
	);
	atomicWrite(join(context.home, ".active"), `${name}\n`, 0o600);
	console.log(
		`Selected Codex profile '${name}' for this home (${source.identity.mode})`,
	);
	recordObservationBestEffort(context, source.identity, "use");
}

function save(context, name) {
	expectedProfile(context.registry, name);
	assertSafeDirectory(context.home, "CODEX_HOME");
	const source = verifiedAuth(
		join(context.home, "auth.json"),
		name,
		context.registry,
	);
	assertSafeDirectory(context.profiles, "Codex profile pool");
	const profileDir = join(context.profiles, name);
	assertSafeDirectory(profileDir, `Codex ${name} profile`);
	atomicWrite(join(profileDir, "auth.json"), source.raw, 0o600, (tempPath) => {
		verifiedAuth(tempPath, name, context.registry);
	});
	console.log(
		`Saved verified Codex profile '${name}' (${source.identity.mode})`,
	);
	recordObservationBestEffort(context, source.identity, "save");
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const registry = loadCodexAccountRegistry(options.registryPath);
	const context = { ...options, registry };
	switch (options.command) {
		case "status":
			if (options.positional.length > 0) fail(usage());
			status(context);
			break;
		case "list":
			if (options.positional.length > 0) fail(usage());
			list(context);
			break;
		case "use":
			if (options.positional.length !== 1) fail(usage());
			use(context, options.positional[0]);
			break;
		case "save":
			if (options.positional.length !== 1) fail(usage());
			save(context, options.positional[0]);
			break;
		case "next":
			fail(
				"Automatic Codex account switching is retired. Use 'flywheel-codex-profile use <school|personal|business>' after checking status.",
			);
			break;
		default:
			fail(usage());
	}
}

try {
	main();
} catch (error) {
	console.error(
		`Error: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exitCode = 2;
}
