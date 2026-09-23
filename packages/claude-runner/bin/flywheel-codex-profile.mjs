#!/usr/bin/env node
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
	identifyCodexAuth,
	loadCodexAccountPool,
	recordCodexAccountObservation,
	redactCodexEmail,
} from "./codex-account-core.mjs";

import {
	acquireCodexAccountLease,
	codexInstallAccountKey,
	withCodexInstallLock,
} from "./codex-account-install.mjs";

function withManualCredentialLocks(context, name, operation) {
	expectedProfile(context, name, operation);
	assertSafeDirectory(context.profiles, "Codex profile pool");
	const sourcePath =
		operation === "use"
			? join(context.profiles, name, "auth.json")
			: join(context.home, "auth.json");
	const initial = verifiedAuth(sourcePath, name, context.pool);
	const accountKey = codexInstallAccountKey(initial.identity);
	if (operation === "save") {
		const target = verifiedAuth(
			join(context.profiles, name, "auth.json"),
			name,
			context.pool,
		);
		if (codexInstallAccountKey(target.identity) !== accountKey) {
			fail("Codex save identity mismatch with target profile slot");
		}
	}
	const lease = acquireCodexAccountLease(context.profiles, accountKey);
	try {
		if (lease.orphanRecovery) fail("codex_candidate_recovery_required");
		assertSafeDirectory(context.home, "CODEX_HOME", {
			create: operation === "use",
		});
		return withCodexInstallLock(context.home, () => {
			const current = verifiedAuth(sourcePath, name, context.pool);
			if (codexInstallAccountKey(current.identity) !== accountKey)
				fail("codex_account_changed");
			if (operation === "save") {
				const target = verifiedAuth(
					join(context.profiles, name, "auth.json"),
					name,
					context.pool,
				);
				if (codexInstallAccountKey(target.identity) !== accountKey) {
					fail("Codex save identity mismatch with target profile slot");
				}
			}
			if (operation === "use") return use(context, name);
			return save(context, name);
		});
	} finally {
		lease.release();
	}
}

function fail(message) {
	throw new Error(message);
}

function usage() {
	return `Usage: flywheel-codex-profile <command> [args] [--json]

Manual Codex account control for one CODEX_HOME.

Commands:
  list          Show every account slot discovered in the profiles directory
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
			![
				"--home",
				"--profiles",
				"--ledger-root",
				"--registry",
				"--snapshot",
			].includes(flag)
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
	if (
		values.snapshot !== undefined &&
		(typeof values.snapshot !== "string" || !isAbsolute(values.snapshot))
	) {
		fail("--snapshot must be an explicit absolute path");
	}
	const command = argv[index];
	const rest = argv.slice(index + 1);
	const json = rest.includes("--json");
	const refresh = rest.includes("--refresh");
	const positional = rest.filter(
		(value) => value !== "--json" && value !== "--refresh",
	);
	return {
		home: values.home,
		profiles: values.profiles,
		ledgerRoot: values["ledger-root"],
		registryPath: values.registry,
		snapshotPath: values.snapshot,
		command,
		json,
		refresh,
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

function shellQuote(value) {
	return /^[A-Za-z0-9_./-]+$/.test(value)
		? value
		: `'${value.replaceAll("'", `'\\''`)}'`;
}

function expectedProfile(context, name, operation) {
	const profile = context.pool.profiles.find(
		(candidate) => candidate.name === name,
	);
	if (!profile) {
		const problem = context.pool.problems.find(
			(candidate) => candidate.name === name,
		);
		if (problem) {
			const login =
				operation === "save" && problem.code === "not_logged_in"
					? `; new accounts must login directly: CODEX_HOME=${shellQuote(join(context.profiles, name))} codex login`
					: "";
			fail(`Codex profile '${name}' is ${problem.code}${login}`);
		}
		const names = context.pool.profiles.map((candidate) => candidate.name);
		fail(
			`Unknown Codex profile '${name ?? ""}'; expected one of: ${names.join(", ")}`,
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
			profilesRoot: context.profiles,
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
	const actual = identifyCodexAuth(raw, context.pool);
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

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readQuotaSnapshot(path) {
	const empty = (error) => ({
		path: path ?? null,
		generatedAt: null,
		rows: [],
		error,
	});
	if (!path) return empty("not_configured");
	if (!lstatIfExists(path)) return empty("missing");
	try {
		const parsed = JSON.parse(readSafeFile(path, "Codex quota snapshot"));
		if (
			!isRecord(parsed) ||
			!Array.isArray(parsed.accounts) ||
			(typeof parsed.generatedAt !== "string" && parsed.generatedAt !== null)
		) {
			return empty("invalid");
		}
		return {
			path,
			generatedAt: parsed.generatedAt,
			rows: parsed.accounts.filter(isRecord),
			error: null,
		};
	} catch {
		return empty("unreadable");
	}
}

function exhausted(reading) {
	return [reading?.fiveH, reading?.weekly].some(
		(window) => isRecord(window) && window.usedPercent === 100,
	);
}

function tokenStatus(reading, problem) {
	if (problem === "not_logged_in") return "未登录";
	if (problem === "invalid_credential") return "凭据损坏";
	if (problem === "duplicate_email") return "重复登录";
	if (!reading) return "未探";
	if (reading.note === "token_revoked") return "已吊销";
	if (reading.note === "token_expired") return "已过期";
	if (reading.note === "refresh_invalid") return "凭据失效";
	if (reading.note === "not_logged_in") return "未登录";
	if (reading.note === "invalid_credential") return "凭据损坏";
	if (reading.note === "duplicate_email") return "重复登录";
	if (reading.authHealth === "in_use_unshared") return "在用未探";
	if (reading.authHealth === "valid")
		return exhausted(reading) ? "打满" : "正常";
	return "未探";
}

function snapshotReading(snapshot, slot) {
	if (slot.state !== "ready" || !slot.identity) return null;
	const identityKey = codexInstallAccountKey(slot.identity);
	const row = snapshot.rows.find((candidate) => candidate.name === slot.name);
	return row &&
		typeof row.identityKey === "string" &&
		/^[a-f0-9]{64}$/.test(row.identityKey) &&
		row.identityKey === identityKey
		? row
		: null;
}

function resetAt(reading, key) {
	const value = reading?.[key];
	return isRecord(value) && typeof value.resetAt === "string"
		? value.resetAt
		: null;
}

async function refreshQuotaSnapshot(context) {
	if (!context.refresh) return { requested: false, ok: true, error: null };
	const token = process.env.TEAMLEAD_API_TOKEN;
	if (!token)
		return {
			requested: true,
			ok: false,
			error: "TEAMLEAD_API_TOKEN is required",
		};
	let url;
	try {
		url = new URL(process.env.FLYWHEEL_BRIDGE_URL || "http://127.0.0.1:9876");
	} catch {
		return { requested: true, ok: false, error: "invalid FLYWHEEL_BRIDGE_URL" };
	}
	if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
		return { requested: true, ok: false, error: "bridge URL must be loopback" };
	}
	url.pathname = "/api/codex-accounts/refresh";
	url.search = "";
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(100_000),
		});
		if (!response.ok) {
			return { requested: true, ok: false, error: `HTTP ${response.status}` };
		}
		return { requested: true, ok: true, error: null };
	} catch (error) {
		return { requested: true, ok: false, error: errorMessage(error) };
	}
}

async function list(context) {
	const refresh = await refreshQuotaSnapshot(context);
	const snapshot = readQuotaSnapshot(context.snapshotPath);
	const profileByName = new Map(
		context.pool.profiles.map((profile) => [profile.name, profile]),
	);
	const problemByName = new Map(
		context.pool.problems.map((problem) => [problem.name, problem.code]),
	);
	const accounts = context.pool.slots
		.filter((slot) => slot.state !== "invalid_name")
		.map((slot) => {
			const profile = profileByName.get(slot.name);
			const problem = problemByName.get(slot.name) ?? null;
			const reading = snapshotReading(snapshot, slot);
			return {
				name: slot.name,
				role: profile?.role ?? null,
				email: slot.identity?.email ?? null,
				plan: slot.identity?.plan ?? null,
				tokenStatus: tokenStatus(reading, problem),
				fiveHResetAt: resetAt(reading, "fiveH"),
				weeklyResetAt: resetAt(reading, "weekly"),
				observedAt:
					reading && typeof reading.observedAt === "string"
						? reading.observedAt
						: null,
				problem,
			};
		});
	const result = {
		primary: context.pool.primary,
		accounts,
		problems: context.pool.problems,
		snapshot: {
			path: snapshot.path,
			generatedAt: snapshot.generatedAt,
		},
		refresh,
	};
	if (context.json) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		for (const account of accounts) {
			console.log(
				`${account.name}: ${account.role ?? account.problem ?? "unknown"} | ${account.email ?? "—"} | ${account.plan ?? "—"} | token ${account.tokenStatus} | 5h ${account.fiveHResetAt ?? "—"} | weekly ${account.weeklyResetAt ?? "—"} | observed ${account.observedAt ?? "—"}`,
			);
		}
		if (snapshot.error) console.log(`Snapshot: ${snapshot.error}`);
		if (!refresh.ok) console.error(`REFRESH FAILED: ${refresh.error}`);
	}
	if (!refresh.ok) process.exitCode = 3;
}

function use(context, name) {
	expectedProfile(context, name, "use");
	assertSafeDirectory(context.profiles, "Codex profile pool");
	const profileDir = join(context.profiles, name);
	assertSafeDirectory(profileDir, `Codex ${name} profile`);
	const source = verifiedAuth(
		join(profileDir, "auth.json"),
		name,
		context.pool,
	);
	assertSafeDirectory(context.home, "CODEX_HOME", { create: true });
	atomicWrite(
		join(context.home, "auth.json"),
		source.raw,
		0o600,
		(tempPath) => {
			verifiedAuth(tempPath, name, context.pool);
		},
	);
	atomicWrite(join(context.home, ".active"), `${name}\n`, 0o600);
	console.log(
		`Selected Codex profile '${name}' for this home (${source.identity.mode})`,
	);
	recordObservationBestEffort(context, source.identity, "use");
}

function save(context, name) {
	expectedProfile(context, name, "save");
	assertSafeDirectory(context.home, "CODEX_HOME");
	const source = verifiedAuth(
		join(context.home, "auth.json"),
		name,
		context.pool,
	);
	assertSafeDirectory(context.profiles, "Codex profile pool");
	const profileDir = join(context.profiles, name);
	assertSafeDirectory(profileDir, `Codex ${name} profile`);
	atomicWrite(join(profileDir, "auth.json"), source.raw, 0o600, (tempPath) => {
		verifiedAuth(tempPath, name, context.pool);
	});
	console.log(
		`Saved verified Codex profile '${name}' (${source.identity.mode})`,
	);
	recordObservationBestEffort(context, source.identity, "save");
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const pool = loadCodexAccountPool({
		profilesRoot: options.profiles,
		registryPath: options.registryPath,
	});
	const context = { ...options, pool };
	switch (options.command) {
		case "status":
			if (options.positional.length > 0) fail(usage());
			status(context);
			break;
		case "list":
			if (options.positional.length > 0) fail(usage());
			await list(context);
			break;
		case "use":
			if (options.positional.length !== 1) fail(usage());
			withManualCredentialLocks(context, options.positional[0], "use");
			break;
		case "save":
			if (options.positional.length !== 1) fail(usage());
			withManualCredentialLocks(context, options.positional[0], "save");
			break;
		case "next":
			fail(
				"Automatic Codex account switching is retired. Run 'flywheel-codex-profile list', then use '<name>'.",
			);
			break;
		default:
			fail(usage());
	}
}

try {
	await main();
} catch (error) {
	console.error(
		`Error: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exitCode = 2;
}
