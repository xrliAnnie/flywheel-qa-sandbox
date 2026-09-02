#!/usr/bin/env node
import {
	accessSync,
	chmodSync,
	closeSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import process from "node:process";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_NAME =
	/(TOKEN|KEY|SECRET|PASSWORD|PASSWD|BEARER|CREDENTIAL|AUTH)/i;

function fail(message) {
	process.stderr.write(`[qa-slot-bridge-spec] ${message}\n`);
	process.exit(64);
}

function requireValue(args, index, flag) {
	const value = args[index + 1];
	if (value === undefined || value === "") fail(`${flag} requires a value`);
	return value;
}

function positiveInteger(raw, flag) {
	if (!/^[1-9][0-9]*$/.test(raw)) fail(`${flag} must be a positive integer`);
	const value = Number(raw);
	if (!Number.isSafeInteger(value))
		fail(`${flag} is outside the safe integer range`);
	return value;
}

function absolutePath(raw, flag) {
	if (!isAbsolute(raw) || raw.includes("\0") || raw.includes("\n")) {
		fail(`${flag} must be an absolute single-line path`);
	}
	return raw;
}

function regularPath(path, flag) {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink())
		fail(`${flag} must be a regular non-symlink file`);
	return realpathSync(path);
}

function executablePath(path, flag) {
	const resolved = realpathSync(path);
	const stat = lstatSync(resolved);
	if (!stat.isFile() || stat.isSymbolicLink()) {
		fail(`${flag} must resolve to a regular file`);
	}
	accessSync(resolved, constants.X_OK);
	return resolved;
}

function directoryPath(path, flag) {
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		fail(`${flag} must be a regular non-symlink directory`);
	}
	return realpathSync(path);
}

function resolveExecutable(raw, envPath) {
	const candidates = isAbsolute(raw)
		? [raw]
		: (envPath ?? "")
				.split(delimiter)
				.filter(Boolean)
				.map((entry) => join(entry, raw));
	for (const candidate of candidates) {
		try {
			return executablePath(candidate, "command[0]");
		} catch {
			// Try the next PATH entry.
		}
	}
	fail(`command[0] is not executable: ${raw}`);
}

function ensurePrivateDirectory(path) {
	if (existsSync(path)) {
		const stat = lstatSync(path);
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			fail(`secret directory must be a regular directory: ${path}`);
		}
	} else {
		mkdirSync(path, { recursive: true, mode: 0o700 });
	}
	chmodSync(path, 0o700);
}

function atomicWrite(path, contents, mode) {
	const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
	let fd;
	try {
		fd = openSync(tmp, "wx", mode);
		writeFileSync(fd, contents, { encoding: "utf8" });
		closeSync(fd);
		fd = undefined;
		chmodSync(tmp, mode);
		renameSync(tmp, path);
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		try {
			unlinkSync(tmp);
		} catch {
			// Best effort cleanup of an uncommitted temp file.
		}
		throw error;
	}
}

function capture(args) {
	let specPath = "";
	let slotRaw = "";
	let portRaw = "";
	let cwdRaw = "";
	let repoRootRaw = "";
	let logPath = "";
	let bridgeUrl = "";
	let scriptRaw = "";
	let sessionLauncherRaw = "";
	const ownershipPidFiles = [];
	const extraSecretNames = new Set();
	let command = [];

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--") {
			command = args.slice(index + 1);
			break;
		}
		switch (arg) {
			case "--spec":
				specPath = requireValue(args, index, arg);
				index += 1;
				break;
			case "--slot":
				slotRaw = requireValue(args, index, arg);
				index += 1;
				break;
			case "--port":
				portRaw = requireValue(args, index, arg);
				index += 1;
				break;
			case "--cwd":
				cwdRaw = requireValue(args, index, arg);
				index += 1;
				break;
			case "--repo-root":
				repoRootRaw = requireValue(args, index, arg);
				index += 1;
				break;
			case "--log":
				logPath = requireValue(args, index, arg);
				index += 1;
				break;
			case "--bridge-url":
				bridgeUrl = requireValue(args, index, arg);
				index += 1;
				break;
			case "--script":
				scriptRaw = requireValue(args, index, arg);
				index += 1;
				break;
			case "--session-launcher":
				sessionLauncherRaw = requireValue(args, index, arg);
				index += 1;
				break;
			case "--ownership-pid-file":
				ownershipPidFiles.push(requireValue(args, index, arg));
				index += 1;
				break;
			case "--secret-name": {
				const name = requireValue(args, index, arg);
				if (!ENV_NAME.test(name)) fail(`invalid --secret-name: ${name}`);
				extraSecretNames.add(name);
				index += 1;
				break;
			}
			default:
				fail(`unknown argument: ${arg}`);
		}
	}

	const slot = positiveInteger(slotRaw, "--slot");
	const port = positiveInteger(portRaw, "--port");
	if (port > 65535) fail("--port must be <= 65535");
	const slotDirectory = `/tmp/flywheel-test-slot-${slot}`;
	specPath = absolutePath(specPath, "--spec");
	logPath = absolutePath(logPath, "--log");
	if (specPath !== join(slotDirectory, "bridge-launch.json")) {
		fail("--spec must be the canonical slot Bridge launch path");
	}
	if (logPath !== join(slotDirectory, "bridge.log")) {
		fail("--log must be the canonical slot Bridge log path");
	}
	const cwd = directoryPath(absolutePath(cwdRaw, "--cwd"), "--cwd");
	const repoRoot = directoryPath(
		absolutePath(repoRootRaw, "--repo-root"),
		"--repo-root",
	);
	const scriptPath = regularPath(
		absolutePath(scriptRaw, "--script"),
		"--script",
	);
	if (scriptPath !== join(repoRoot, "scripts", "run-bridge.ts")) {
		fail("--script must be the canonical run-bridge.ts under --repo-root");
	}
	const sessionLauncher = executablePath(
		absolutePath(sessionLauncherRaw, "--session-launcher"),
		"--session-launcher",
	);
	const bridgeUrlMatch =
		/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):([1-9][0-9]*)$/.exec(
			bridgeUrl,
		);
	if (!bridgeUrlMatch) {
		fail("--bridge-url must be an explicit loopback HTTP URL with a port");
	}
	if (Number(bridgeUrlMatch[1]) !== port) {
		fail("--bridge-url port must match --port");
	}
	if (
		command.length === 0 ||
		command.some(
			(value) => value === "" || value.includes("\0") || value.includes("\n"),
		)
	) {
		fail("Bridge command must contain only non-empty single-line arguments");
	}
	command[0] = resolveExecutable(command[0], process.env.PATH);
	let scriptMatched = false;
	command = command.map((value) => {
		if (value === scriptRaw) {
			scriptMatched = true;
			return scriptPath;
		}
		try {
			if (realpathSync(value) === scriptPath) {
				scriptMatched = true;
				return scriptPath;
			}
		} catch {
			// Ordinary command arguments need not name files.
		}
		return value;
	});
	if (!scriptMatched)
		fail("Bridge command does not contain the canonical run-bridge.ts path");
	if (ownershipPidFiles.length === 0)
		fail("at least one --ownership-pid-file is required");
	const ownerPidFile = `/tmp/flywheel-test-slot-${slot}.lock/pid`;
	for (let index = 0; index < ownershipPidFiles.length; index += 1) {
		ownershipPidFiles[index] = absolutePath(
			ownershipPidFiles[index],
			"--ownership-pid-file",
		);
		if (
			!/^\/tmp\/flywheel-test-slot-[1-9][0-9]*\.lock\/pid$/.test(
				ownershipPidFiles[index],
			)
		) {
			fail("--ownership-pid-file must be a canonical slot lock path");
		}
	}
	if (!ownershipPidFiles.includes(ownerPidFile)) {
		fail("--ownership-pid-file must include the owner slot lock");
	}

	const normalized = { ...process.env, PWD: cwd };
	delete normalized._;
	delete normalized.SHLVL;
	const secretDirectory = join(
		dirname(specPath),
		"state",
		"bridge-env-secrets",
	);
	ensurePrivateDirectory(secretDirectory);
	const environment = [];
	const secretEnvironment = [];
	for (const name of Object.keys(normalized).sort()) {
		if (!ENV_NAME.test(name)) fail(`invalid environment name: ${name}`);
		const value = normalized[name] ?? "";
		if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
			fail(`environment value for ${name} must be single-line and NUL-free`);
		}
		if (SECRET_NAME.test(name) || extraSecretNames.has(name)) {
			const path = join(secretDirectory, name);
			atomicWrite(path, value, 0o600);
			secretEnvironment.push({ name, path });
		} else {
			environment.push(`${name}=${value}`);
		}
	}

	const spec = {
		schemaVersion: 1,
		slot,
		port,
		bridgeUrl,
		host: normalized.TEAMLEAD_HOST || "127.0.0.1",
		cwd,
		repoRoot,
		sessionLauncher,
		logPath,
		scriptPath,
		environment,
		secretEnvironment,
		command,
		ownershipPidFiles: [...new Set(ownershipPidFiles)],
	};
	atomicWrite(specPath, `${JSON.stringify(spec, null, 2)}\n`, 0o600);
}

const [subcommand, ...args] = process.argv.slice(2);
if (subcommand !== "capture")
	fail("usage: qa-slot-bridge-spec.mjs capture [options] -- command [args...]");
capture(args);
