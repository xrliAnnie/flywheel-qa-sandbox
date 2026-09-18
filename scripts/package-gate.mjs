import { execFileSync, spawn } from "node:child_process";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	classifyAttempt,
	runGateCore,
	summarizeRun,
} from "./lib/package-gate-core.mjs";

export { classifyAttempt, summarizeRun };

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

function enabledEnvironment(value) {
	return (
		value !== undefined && value !== "" && value !== "0" && value !== "false"
	);
}

function hostStateRoot(hostQueue) {
	return (
		hostQueue?.stateRoot ??
		join(userInfo().homedir, ".flywheel", "state", "package-gate", "v1")
	);
}

function readHostControl(stateRoot) {
	const path = join(stateRoot, "control.json");
	let metadata;
	try {
		metadata = lstatSync(path);
	} catch (error) {
		if (error.code === "ENOENT") return "disabled";
		throw new Error("control_unreadable");
	}
	if (
		metadata.isSymbolicLink() ||
		!metadata.isFile() ||
		(typeof process.getuid === "function" && metadata.uid !== process.getuid())
	)
		throw new Error("control_identity_invalid");
	let control;
	try {
		control = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error("control_unreadable");
	}
	if (
		control?.schemaVersion !== 1 ||
		!["enabled", "disabled"].includes(control.mode) ||
		typeof control.generation !== "string" ||
		!control.generation
	)
		throw new Error("control_invalid");
	return control.mode;
}

function infrastructureSummary({ root, receiptRoot, reason, startedAt }) {
	mkdirSync(receiptRoot, { recursive: true });
	const directory = mkdtempSync(join(receiptRoot, "flywheel-package-gate-"));
	let head = null;
	try {
		head = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		/* fixture roots can be outside git */
	}
	const summary = {
		schemaVersion: 1,
		directory,
		root,
		head,
		startedAt,
		finishedAt: new Date().toISOString(),
		packages: [],
		status: "failed",
		exitCode: 1,
		failureKind: "host_queue",
		hostQueue: { state: "infrastructure_error", reason },
	};
	writeFileSync(
		join(directory, "summary.json"),
		`${JSON.stringify(summary, null, 2)}\n`,
	);
	return summary;
}

function isWorkerSummary(result) {
	return (
		result !== null &&
		typeof result === "object" &&
		!Array.isArray(result) &&
		result.schemaVersion === 1 &&
		["passed", "failed", "artifact"].includes(result.status) &&
		Number.isInteger(result.exitCode) &&
		result.exitCode >= 0
	);
}

function workerSummaryPath(result, receiptRoot) {
	if (typeof result.directory !== "string" || !result.directory) return null;
	const base = resolve(receiptRoot);
	const directory = resolve(result.directory);
	const child = relative(base, directory);
	if (
		child === "" ||
		child === ".." ||
		child.startsWith(`..${sep}`) ||
		isAbsolute(child)
	)
		return null;
	return join(directory, "summary.json");
}

function supervisorExitCode(exitCode, signal) {
	if (signal === "SIGINT") return 130;
	if (signal === "SIGTERM") return 143;
	return Number.isInteger(exitCode) ? exitCode : 1;
}

function supervisorFailureReason({ exitCode, signal, spawnError, stderr }) {
	if (spawnError) return `host_supervisor_spawn_failed: ${spawnError}`;
	if (signal) return `host_supervisor_signal_${signal}`;
	if (Number.isInteger(exitCode)) return `host_supervisor_exit_${exitCode}`;
	const detail = stderr.trim().split("\n").filter(Boolean).at(-1);
	return detail || "host_supervisor_failed";
}

function reconcileSupervisorResult({
	workerResult,
	exitCode,
	signal,
	spawnError,
	stderr,
	receiptRoot,
}) {
	const actualExitCode = supervisorExitCode(exitCode, signal);
	if (!spawnError && !signal && actualExitCode === workerResult.exitCode)
		return workerResult;
	const cancellation = actualExitCode === 130 || actualExitCode === 143;
	const result = {
		...workerResult,
		status: "failed",
		exitCode: cancellation ? actualExitCode : 1,
		failureKind: "host_queue",
		finishedAt: new Date().toISOString(),
		hostQueue: {
			...(workerResult.hostQueue ?? {}),
			state: cancellation ? "cancelled" : "infrastructure_error",
			reason: supervisorFailureReason({
				exitCode,
				signal,
				spawnError,
				stderr,
			}),
			supervisorExitCode: exitCode,
			supervisorSignal: signal,
		},
	};
	const path = workerSummaryPath(result, receiptRoot);
	if (!path) throw new Error("host_supervisor_result_directory_invalid");
	writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
	return result;
}

function runHostSupervisor({
	root,
	pnpm,
	receiptRoot,
	quiet,
	head,
	hostQueue,
	python,
}) {
	mkdirSync(receiptRoot, { recursive: true });
	const controlDirectory = mkdtempSync(
		join(receiptRoot, "flywheel-package-gate-host-"),
	);
	const configPath = join(controlDirectory, "worker.json");
	const resultPath = join(controlDirectory, "result.json");
	writeFileSync(
		configPath,
		`${JSON.stringify({ root, pnpm, receiptRoot, quiet, resultPath })}\n`,
		{ mode: 0o600 },
	);
	const worker = join(scriptDirectory, "package-gate-worker.mjs");
	const args = hostQueue?.stateRoot
		? [
				join(scriptDirectory, "package-gate-host.py"),
				"_test-run",
				"--state-root",
				hostQueue.stateRoot,
				"--worktree",
				root,
				...(head ? ["--head", head] : []),
				"--result-path",
				resultPath,
				"--",
				process.execPath,
				worker,
				configPath,
			]
		: [
				join(scriptDirectory, "package-gate-host.py"),
				"run",
				"--worktree",
				root,
				...(head ? ["--head", head] : []),
				"--result-path",
				resultPath,
				"--",
				process.execPath,
				worker,
				configPath,
			];
	return new Promise((resolveResult) => {
		let stderr = "";
		let spawnError;
		const child = spawn(python, args, {
			cwd: root,
			env: {
				...process.env,
				...(hostQueue?.stateRoot ? { FLYWHEEL_PACKAGE_GATE_TESTING: "1" } : {}),
			},
			stdio: ["pipe", quiet ? "ignore" : "inherit", "pipe"],
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
			process.stderr.write(chunk);
		});
		child.once("error", (error) => {
			spawnError = error.message;
		});
		child.once("close", (exitCode, signal) => {
			try {
				let rawResult;
				try {
					rawResult = readFileSync(resultPath, "utf8");
				} catch (error) {
					throw new Error(
						error.code === "ENOENT"
							? "host_supervisor_result_missing"
							: "host_supervisor_result_unreadable",
					);
				}
				let workerResult;
				try {
					workerResult = JSON.parse(rawResult);
				} catch {
					throw new Error("host_supervisor_result_invalid");
				}
				if (!isWorkerSummary(workerResult))
					throw new Error("host_supervisor_result_invalid");
				resolveResult(
					reconcileSupervisorResult({
						workerResult,
						exitCode,
						signal,
						spawnError,
						stderr,
						receiptRoot,
					}),
				);
			} catch (error) {
				const resultReason =
					error instanceof Error &&
					error.message.startsWith("host_supervisor_result_")
						? error.message
						: null;
				resolveResult(
					infrastructureSummary({
						root,
						receiptRoot,
						reason:
							!spawnError && !signal && exitCode === 0 && resultReason
								? resultReason
								: supervisorFailureReason({
										exitCode,
										signal,
										spawnError,
										stderr,
									}),
						startedAt: new Date().toISOString(),
					}),
				);
			}
		});
	});
}

export async function runGate({
	root = resolve(scriptDirectory, ".."),
	pnpm = "pnpm",
	receiptRoot = tmpdir(),
	quiet = false,
	environment = process.env,
	hostQueue,
	python = "/usr/bin/python3",
	statusSink = (message) => process.stderr.write(message),
} = {}) {
	const limit = environment.FLYWHEEL_PACKAGE_GATE_HOST_LIMIT;
	if (limit !== undefined && !["", "0", "1", "false"].includes(limit)) {
		return infrastructureSummary({
			root,
			receiptRoot,
			reason: "FLYWHEEL_PACKAGE_GATE_HOST_LIMIT must be 0 or 1",
			startedAt: new Date().toISOString(),
		});
	}
	const ci =
		enabledEnvironment(environment.CI) || environment.GITHUB_ACTIONS === "true";
	if (ci || limit === "0" || limit === "false" || limit === "") {
		const bypassReason = ci ? "ci" : "environment_disabled";
		if (!ci) statusSink(`PACKAGE_GATE_HOST_BYPASS reason=${bypassReason}\n`);
		const result = await runGateCore({ root, pnpm, receiptRoot, quiet });
		result.hostQueue = {
			state: "bypassed",
			reason: bypassReason,
		};
		return result;
	}
	let controlMode;
	try {
		controlMode = readHostControl(hostStateRoot(hostQueue));
	} catch (error) {
		return infrastructureSummary({
			root,
			receiptRoot,
			reason: error.message,
			startedAt: new Date().toISOString(),
		});
	}
	if (controlMode === "disabled") {
		statusSink("PACKAGE_GATE_HOST_BYPASS reason=host_control_disabled\n");
		const result = await runGateCore({ root, pnpm, receiptRoot, quiet });
		result.hostQueue = {
			state: "bypassed",
			reason: "host_control_disabled",
		};
		return result;
	}
	let head = null;
	try {
		head = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		/* fixture roots can be outside git */
	}
	return runHostSupervisor({
		root,
		pnpm,
		receiptRoot,
		quiet,
		head,
		hostQueue,
		python,
	});
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	runGate()
		.then((result) => {
			process.exitCode = result.exitCode;
		})
		.catch((error) => {
			console.error(error);
			process.exitCode = 1;
		});
}
