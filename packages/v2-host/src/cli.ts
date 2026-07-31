#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { Kernel } from "flywheel-v2-kernel";
import { V2Host } from "./host.js";
import {
	CommandRunnerLauncher,
	createRuntimeDagPorts,
	type RunnerLauncherPort,
} from "./runtime-ports.js";
import { FileSessionEvidenceProbe } from "./session-evidence.js";
import { TmuxRunnerLauncher } from "./tmux-runner-launcher.js";

interface HostCliOptions {
	dbPath: string;
	markerPath: string;
	authorityPath: string;
	armedPath: string;
	windowId: string;
	epoch: number;
	socketPath: string;
	secretPath: string;
	sessionProofRoot: string;
	hostEpoch: string;
	runtimeConfigPath?: string;
}

interface RuntimeConfig {
	v: 1;
	dispatchIntervalMs: number;
	lockRoot: string;
	launcher:
		| {
				kind: "tmux";
				tmuxBin: string;
				claudeBin: string;
				codexBin: string;
				clientCliPath: string;
				releaseRoot: string;
				stateRoot: string;
				/** FLY-1547: optional mailbox MCP server entry; absent = no wiring. */
				mailboxMcpPath?: string;
		  }
		| { kind: "command"; command: string[]; requestRoot: string };
	gitBin: string;
	ghBin: string;
	/** FLY-1547 founder directive: founder-facing push is default OFF. */
	founderPush: boolean;
}

const FLAGS = new Set([
	"--db",
	"--marker",
	"--authority",
	"--armed",
	"--window",
	"--epoch",
	"--socket",
	"--secret",
	"--session-proof-root",
	"--host-epoch",
	"--runtime-config",
]);

function parseValues(argv: readonly string[]): Map<string, string> {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index]!;
		if (!FLAGS.has(flag)) throw new TypeError(`unknown host option ${flag}`);
		if (values.has(flag)) throw new TypeError(`duplicate host option ${flag}`);
		const value = argv[++index];
		if (!value || value.startsWith("--")) {
			throw new TypeError(`${flag} requires a value`);
		}
		values.set(flag, value);
	}
	return values;
}

function required(values: Map<string, string>, flag: string): string {
	const value = values.get(flag);
	if (!value) throw new TypeError(`${flag} is required`);
	return value;
}

function absolute(values: Map<string, string>, flag: string): string {
	const value = required(values, flag);
	if (!isAbsolute(value)) throw new TypeError(`${flag} must be absolute`);
	return value;
}

export function parseHostCliArgs(argv: readonly string[]): HostCliOptions {
	const values = parseValues(argv);
	const epochRaw = required(values, "--epoch");
	const epoch = Number(epochRaw);
	if (
		!Number.isSafeInteger(epoch) ||
		epoch <= 0 ||
		String(epoch) !== epochRaw
	) {
		throw new TypeError("--epoch must be a canonical positive integer");
	}
	return {
		dbPath: absolute(values, "--db"),
		markerPath: absolute(values, "--marker"),
		authorityPath: absolute(values, "--authority"),
		armedPath: absolute(values, "--armed"),
		windowId: required(values, "--window"),
		epoch,
		socketPath: absolute(values, "--socket"),
		secretPath: absolute(values, "--secret"),
		sessionProofRoot: absolute(values, "--session-proof-root"),
		hostEpoch: required(values, "--host-epoch"),
		...(values.has("--runtime-config")
			? { runtimeConfigPath: absolute(values, "--runtime-config") }
			: {}),
	};
}

function object(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function configPath(value: unknown, label: string): string {
	if (typeof value !== "string" || !isAbsolute(value)) {
		throw new TypeError(`${label} must be an absolute path`);
	}
	return value;
}

export function parseRuntimeConfig(value: unknown): RuntimeConfig {
	const config = object(value, "runtime config");
	// FLY-1550: `injection_root` is gone with the per-activation Claude config
	// dir (runners share the operator's ~/.claude). Exact-shape parsing keeps the
	// break loud: migrate an old runtime-config.json with
	// `install-v2-host.sh --migrate-fly1550` (atomic validate-then-replace).
	// FLY-1547: `founder_push` is the single optional key (founder directive —
	// absent means OFF). Both shapes are exact; anything else is refused.
	const keyShape = Object.keys(config).sort().join(",");
	if (
		(keyShape !== "dispatch_interval_ms,gh_bin,git_bin,launcher,lock_root,v" &&
			keyShape !==
				"dispatch_interval_ms,founder_push,gh_bin,git_bin,launcher,lock_root,v") ||
		config.v !== 1
	) {
		throw new TypeError("runtime config has an invalid shape");
	}
	if ("founder_push" in config && typeof config.founder_push !== "boolean") {
		throw new TypeError("runtime founder_push must be a boolean");
	}
	if (
		!Number.isSafeInteger(config.dispatch_interval_ms) ||
		(config.dispatch_interval_ms as number) < 100 ||
		(config.dispatch_interval_ms as number) > 60_000
	) {
		throw new TypeError(
			"runtime dispatch_interval_ms must be an integer in 100..60000",
		);
	}
	const launcher = object(config.launcher, "runtime launcher");
	let parsedLauncher: RuntimeConfig["launcher"];
	const tmuxKeyShape = Object.keys(launcher).sort().join(",");
	if (
		launcher.kind === "tmux" &&
		(tmuxKeyShape ===
			"claude_bin,client_cli,codex_bin,kind,release_root,state_root,tmux_bin" ||
			tmuxKeyShape ===
				"claude_bin,client_cli,codex_bin,kind,mailbox_mcp,release_root,state_root,tmux_bin")
	) {
		parsedLauncher = {
			kind: "tmux",
			tmuxBin: configPath(launcher.tmux_bin, "runtime tmux_bin"),
			claudeBin: configPath(launcher.claude_bin, "runtime claude_bin"),
			codexBin: configPath(launcher.codex_bin, "runtime codex_bin"),
			clientCliPath: configPath(launcher.client_cli, "runtime client_cli"),
			releaseRoot: configPath(launcher.release_root, "runtime release_root"),
			stateRoot: configPath(launcher.state_root, "runtime state_root"),
			...("mailbox_mcp" in launcher
				? {
						mailboxMcpPath: configPath(
							launcher.mailbox_mcp,
							"runtime mailbox_mcp",
						),
					}
				: {}),
		};
	} else if (
		launcher.kind === "command" &&
		Object.keys(launcher).sort().join(",") === "command,kind,request_root" &&
		Array.isArray(launcher.command) &&
		launcher.command.length > 0 &&
		launcher.command.every(
			(entry) => typeof entry === "string" && entry.length > 0,
		)
	) {
		configPath(launcher.command[0], "runtime launcher executable");
		parsedLauncher = {
			kind: "command",
			command: launcher.command as string[],
			requestRoot: configPath(launcher.request_root, "runtime request_root"),
		};
	} else {
		throw new TypeError("runtime launcher has an invalid shape");
	}
	return {
		v: 1,
		dispatchIntervalMs: config.dispatch_interval_ms as number,
		lockRoot: configPath(config.lock_root, "runtime lock_root"),
		launcher: parsedLauncher,
		gitBin: configPath(config.git_bin, "runtime git_bin"),
		ghBin: configPath(config.gh_bin, "runtime gh_bin"),
		founderPush: config.founder_push === true,
	};
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
	const options = parseHostCliArgs(argv);
	const runtime = options.runtimeConfigPath
		? parseRuntimeConfig(
				JSON.parse(readFileSync(options.runtimeConfigPath, "utf8")) as unknown,
			)
		: undefined;
	const launcher: RunnerLauncherPort | undefined = runtime
		? runtime.launcher.kind === "tmux"
			? new TmuxRunnerLauncher({
					hostEpoch: options.hostEpoch,
					tmuxBin: runtime.launcher.tmuxBin,
					claudeBin: runtime.launcher.claudeBin,
					codexBin: runtime.launcher.codexBin,
					clientCliPath: runtime.launcher.clientCliPath,
					socketPath: options.socketPath,
					secretPath: options.secretPath,
					sessionProofRoot: options.sessionProofRoot,
					releaseRoot: runtime.launcher.releaseRoot,
					stateRoot: runtime.launcher.stateRoot,
					...(runtime.launcher.mailboxMcpPath
						? { mailboxMcpPath: runtime.launcher.mailboxMcpPath }
						: {}),
				})
			: new CommandRunnerLauncher({
					command: runtime.launcher.command,
					requestRoot: runtime.launcher.requestRoot,
				})
		: undefined;
	const host = new V2Host({
		database: {
			dbPath: options.dbPath,
			markerPath: options.markerPath,
			authorityPath: options.authorityPath,
			armedPath: options.armedPath,
			expectedWindowId: options.windowId,
			expectedEpoch: options.epoch,
			allowedAuthorityStates: ["cutover", "live"],
		},
		socketPath: options.socketPath,
		secretPath: options.secretPath,
		hostEpoch: options.hostEpoch,
		sessionProbe: new FileSessionEvidenceProbe(options.sessionProofRoot),
		founderPush: runtime?.founderPush === true,
		...(runtime
			? {
					coordinator: {
						intervalMs: runtime.dispatchIntervalMs,
						createPorts: (kernel: Kernel) => {
							if (!launcher) {
								throw new Error("runtime launcher is unavailable");
							}
							return createRuntimeDagPorts({
								kernel,
								hostEpoch: options.hostEpoch,
								expectedEpoch: options.epoch,
								lockRoot: runtime.lockRoot,
								launcher,
								gitBin: runtime.gitBin,
								ghBin: runtime.ghBin,
							});
						},
						...(launcher?.activate
							? {
									activateSession: (sessionRef: string) =>
										launcher.activate?.(sessionRef) ?? Promise.resolve(),
								}
							: {}),
						// FLY-1556: deliberately NO onError→process-death wiring. A tick
						// or session error is recorded durably by the host and the engine
						// keeps serving; the old rejection race here is what turned one
						// session's stale instruction pin into launchd crash-looping the
						// whole engine, killing the socket and the outbound service.
					},
				}
			: {}),
	});
	// Codex R6 HIGH-1: start() is inside the close path. It was outside, so a
	// failure after the socket was published left the listener open while the top
	// level only set process.exitCode -- a resident process that answered requests,
	// dispatched nothing, and reported healthy. start() now tears itself down on
	// failure; this guarantees the same thing from the caller's side even if a later
	// step between start and the wait throws.
	try {
		await host.start();
		process.stdout.write(
			`${JSON.stringify({
				status: "ready",
				socketPath: options.socketPath,
				windowId: options.windowId,
				epoch: options.epoch,
			})}\n`,
		);
		await new Promise<void>((resolve) => {
			const stop = () => resolve();
			process.once("SIGINT", stop);
			process.once("SIGTERM", stop);
		});
	} finally {
		await host.close();
	}
	return 0;
}

const invokedPath = process.argv[1]
	? pathToFileURL(process.argv[1]).href
	: undefined;
if (invokedPath === import.meta.url) {
	main()
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error) => {
			process.stderr.write(
				`${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`,
			);
			process.exitCode = 1;
		});
}
