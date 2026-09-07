#!/usr/bin/env node
import {
	chmodSync,
	closeSync,
	constants,
	fchmodSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readlinkSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	assertCodexSourceIdentity,
	codexCredentialTruthPath,
	migrateCodexAgentHomeCredential,
	migrateCodexHomeCredential,
} from "../dist/index.js";

function fail(message, code = 2) {
	process.stderr.write(`[link-truth] ${message}\n`);
	process.exit(code);
}

function parse(argv) {
	let inspect = false;
	let unlink = false;
	let keepBackup = false;
	let index = 0;
	while (index < argv.length - 1) {
		const value = argv[index];
		if (value === "--inspect") inspect = true;
		else if (value === "--unlink") unlink = true;
		else if (value === "--keep-backup") keepBackup = true;
		else fail("invalid helper arguments");
		index += 1;
	}
	const home = argv[index];
	if (!home || index !== argv.length - 1 || home.startsWith("--")) {
		fail("helper requires one home as the final argument");
	}
	if (inspect && (unlink || keepBackup))
		fail("inspect does not accept mutation flags");
	return { home, inspect, unlink, keepBackup };
}

function lstatOrNull(path) {
	try {
		return lstatSync(path);
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

function inspectHome(home, env, registryPath) {
	const identity = assertCodexSourceIdentity({ env, registryPath });
	const truthPath = codexCredentialTruthPath(env);
	const homeStat = lstatSync(home);
	if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) {
		throw new Error("home must be a plain directory");
	}
	const destination = join(home, "auth.json");
	const stat = lstatOrNull(destination);
	const already =
		stat?.isSymbolicLink() === true && readlinkSync(destination) === truthPath;
	return {
		state: already ? "already" : "requires-migration",
		profile: identity.profile,
	};
}

function appendReport(result, env) {
	if (result.state === "already") return;
	const reportPath =
		env.FLYWHEEL_CODEX_LINK_REPORT_PATH ||
		join(env.HOME, ".flywheel", "reports", "fly2404-link-truth.jsonl");
	const reportDirectory = dirname(reportPath);
	mkdirSync(reportDirectory, { recursive: true, mode: 0o700 });
	const directoryStat = lstatSync(reportDirectory);
	if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
		throw new Error("credential report directory is unsafe");
	}
	chmodSync(reportDirectory, 0o700);
	const existing = lstatOrNull(reportPath);
	if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
		throw new Error("credential report path is unsafe");
	}
	const reportFd = openSync(
		reportPath,
		constants.O_APPEND |
			constants.O_CREAT |
			constants.O_WRONLY |
			(constants.O_NOFOLLOW ?? 0),
		0o600,
	);
	const directoryFd = openSync(reportDirectory, constants.O_RDONLY);
	try {
		writeSync(
			reportFd,
			`${JSON.stringify({ v: 1, at: new Date().toISOString(), home: result.home, state: result.state, profile: result.profile })}\n`,
		);
		fchmodSync(reportFd, 0o600);
		fsyncSync(reportFd);
		fsyncSync(directoryFd);
	} finally {
		closeSync(reportFd);
		closeSync(directoryFd);
	}
}

const args = parse(process.argv.slice(2));
const env = process.env;
const registryPath = env.FLYWHEEL_CODEX_ACCOUNT_REGISTRY_PATH;
try {
	if (args.inspect) {
		process.stdout.write(
			`${JSON.stringify(inspectHome(args.home, env, registryPath))}\n`,
		);
		process.exit(0);
	}
	const marker = lstatOrNull(join(args.home, ".flywheel-agent-home.json"));
	const migrate = marker
		? migrateCodexAgentHomeCredential
		: migrateCodexHomeCredential;
	const result = await migrate({
		home: args.home,
		env,
		registryPath,
		keepBackup: args.keepBackup,
		unlink: args.unlink,
	});
	try {
		appendReport(result, env);
	} catch {
		process.stdout.write(
			`[link-truth] home=${result.home} state=${result.state} reason=report-write-failed\n`,
		);
		process.exit(6);
	}
	process.stdout.write(
		`[link-truth] home=${result.home} state=${result.state} reason=${result.state}\n`,
	);
	process.exit(result.state === "uncertain" ? 6 : 0);
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	if (/live leases|lock/i.test(message)) fail(`state=refused reason=active`, 3);
	fail(`state=refused reason=${message.replace(/[\r\n]/g, " ")}`, 2);
}
