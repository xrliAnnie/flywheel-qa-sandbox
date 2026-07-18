#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	readFileSync,
	realpathSync,
	unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withMkdirLock } from "./mkdir-lock.js";
import {
	ClaudePoolRebuild,
	type PoolRebuildHealthPolicy,
	type PoolRebuildPaths,
	type PoolRebuildRuntime,
} from "./quota-pool-rebuild.js";
import { runtimeTreeSha256 } from "./runtime-tree-hash.js";

export { runtimeTreeSha256 };

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function processStartTime(pid: number): string | null {
	try {
		return (
			execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
				encoding: "utf8",
				timeout: 2_000,
			}).trim() || null
		);
	} catch {
		return null;
	}
}

function processCommand(pid: number): string | null {
	try {
		return (
			execFileSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], {
				encoding: "utf8",
				timeout: 2_000,
			}).trim() || null
		);
	} catch {
		return null;
	}
}

function nodeMainScript(command: string): string | null {
	const tokens = command.trim().split(/\s+/);
	if (tokens.length < 2) return null;
	const executable = tokens[0]?.replace(/^["']|["']$/g, "") ?? "";
	if (!["node", "nodejs"].includes(basename(executable))) return null;
	const main = tokens[1]?.replace(/^["']|["']$/g, "") ?? "";
	return main && !main.startsWith("-") ? main : null;
}

export function commandRunsEntrypoint(
	command: string,
	expected: string,
): boolean {
	const main = nodeMainScript(command);
	if (main === null || !main.startsWith("/")) return false;
	try {
		return realpathSync(main) === realpathSync(expected);
	} catch {
		return false;
	}
}

export function resolveQuotaMonitorEntrypoint(
	fallback: string,
	deployed = process.env.FLYWHEEL_QUOTA_MONITOR_DIST,
): string {
	const candidate = deployed ?? fallback;
	if (!isAbsolute(candidate)) {
		throw new Error("FLYWHEEL_QUOTA_MONITOR_DIST must be absolute");
	}
	return realpathSync(candidate);
}

export function quotaHealthOutcomeAllowed(
	outcome: string,
	policy?: PoolRebuildHealthPolicy,
): boolean {
	if (["blind", "error", "switch_failed"].includes(outcome)) return false;
	return (
		outcome !== "identity_conflict" || policy?.allowIdentityConflict === true
	);
}

function noOtherRebuildPublisherIsAlive(): boolean {
	try {
		const rows = execFileSync("ps", ["-axww", "-o", "pid=,command="], {
			encoding: "utf8",
			timeout: 5_000,
		});
		for (const row of rows.split("\n")) {
			const match = row.match(/^\s*(\d+)\s+(.+)$/);
			if (!match) continue;
			const pid = Number(match[1]);
			if (pid === process.pid) continue;
			const main = nodeMainScript(match[2] ?? "");
			if (main !== null && basename(main) === "quota-pool-rebuild-cli.js") {
				return false;
			}
		}
		return true;
	} catch {
		return false;
	}
}

export interface RebuildPidfileRecord {
	pid: number;
	processStartTime: string;
}

export function pidfileProcessMatches(
	record: RebuildPidfileRecord,
	deps: {
		isProcessAlive?: (pid: number) => boolean;
		readProcessStartTime?: (pid: number) => string | null;
	} = {},
): boolean {
	const isAlive = deps.isProcessAlive ?? processAlive;
	const readStart = deps.readProcessStartTime ?? processStartTime;
	return (
		isAlive(record.pid) && readStart(record.pid) === record.processStartTime
	);
}

function readPidfile(path: string): RebuildPidfileRecord | null {
	try {
		const stat = lstatSync(path);
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			stat.uid !== process.getuid?.() ||
			!([0o600, 0o400] as number[]).includes(stat.mode & 0o777)
		) {
			return null;
		}
		const value = JSON.parse(readFileSync(path, "utf8"));
		return Number.isInteger(value.pid) &&
			value.pid > 0 &&
			value.uid === stat.uid &&
			typeof value.processStartTime === "string"
			? value
			: null;
	} catch {
		return null;
	}
}

function readConfig(path: string): Record<string, unknown> {
	const value = JSON.parse(readFileSync(path, "utf8"));
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("quota config is not an object");
	}
	return value as Record<string, unknown>;
}

function requireAbsolute(value: string | undefined, name: string): string {
	if (!value || !value.startsWith("/"))
		throw new Error(`${name} must be absolute`);
	return value;
}

export function resolveClaudeProfileBin(value: string | undefined): string {
	if (!value || !isAbsolute(value)) {
		throw new Error("FLYWHEEL_CLAUDE_PROFILE_BIN must be absolute");
	}
	return value;
}

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index < 0) return undefined;
	if (!args[index + 1] || args[index + 1]?.startsWith("--")) {
		throw new Error(`${name} requires a value`);
	}
	return args[index + 1];
}

export function defaultPoolRebuildPaths(): PoolRebuildPaths {
	const home = homedir();
	const stateDir = process.env.FLYWHEEL_STATE_DIR ?? join(home, ".flywheel");
	const poolDir =
		process.env.FLYWHEEL_CLAUDE_PROFILES_DIR ??
		join(stateDir, "claude-profiles");
	const claudeJson =
		process.env.FLYWHEEL_CLAUDE_JSON ?? join(home, ".claude.json");
	return {
		journal:
			process.env.FLYWHEEL_POOL_REBUILD_JOURNAL ??
			join(stateDir, "claude-pool-rebuild.journal.json"),
		journalLock:
			process.env.FLYWHEEL_POOL_REBUILD_LOCK ??
			join(stateDir, "claude-pool-rebuild.lock"),
		config:
			process.env.FLYWHEEL_QUOTA_MONITOR_CONFIG ??
			join(stateDir, "quota-monitor.json"),
		configPreimage:
			process.env.FLYWHEEL_POOL_REBUILD_CONFIG_PREIMAGE ??
			join(stateDir, "claude-pool-rebuild.config-preimage.json"),
		identityMap:
			process.env.FLYWHEEL_PROFILE_IDENTITY_MAP ??
			join(poolDir, "identity-map.json"),
		poolDir,
		active: join(poolDir, ".active"),
		claudeJson,
		claudeJsonLock:
			process.env.FLYWHEEL_CLAUDE_JSON_LOCK ?? `${claudeJson}.lock`,
		store:
			process.env.FLYWHEEL_CLAUDE_ACCOUNTS_PATH ??
			join(stateDir, "claude-accounts.json"),
		state:
			process.env.FLYWHEEL_QUOTA_STATE_PATH ??
			join(stateDir, "quota-monitor-state.json"),
		accountsLock:
			process.env.FLYWHEEL_CLAUDE_ACCOUNTS_LOCK ??
			join(stateDir, "claude-accounts.lock"),
	};
}

export function validateFly1252Evidence(
	path: string,
	reviewedSha: string,
	deps: {
		resolveLiveWrapper?: () => string;
		readLivePidfile?: () => RebuildPidfileRecord | null;
		isProcessAlive?: (pid: number) => boolean;
		readProcessStartTime?: (pid: number) => string | null;
		resolveLiveCommand?: (pid: number) => string;
	} = {},
): string {
	if (!path.startsWith("/"))
		throw new Error("FLY-1252 evidence path must be absolute");
	const stat = lstatSync(path);
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		stat.uid !== process.getuid?.() ||
		!([0o600, 0o400] as number[]).includes(stat.mode & 0o777)
	) {
		throw new Error("FLY-1252 evidence must be owner-only regular file");
	}
	const value = JSON.parse(readFileSync(path, "utf8"));
	const checks = value?.checks;
	const required = [
		"candidateExitMapping",
		"driftMarkerRouting",
		"postWriteIdentityVerify",
		"perTickDriftDetection",
		"notificationRouting",
	];
	const shaPattern = /^[a-f0-9]{40}$/;
	if (
		value?.version !== 1 ||
		value?.issue !== "FLY-1252" ||
		!shaPattern.test(reviewedSha) ||
		value?.reviewedSha !== reviewedSha ||
		value?.deployedSha !== reviewedSha ||
		!/^([a-f0-9]{64})$/.test(value?.runtimeTreeSha256 ?? "") ||
		value?.reviewVerdict !== "APPROVED" ||
		typeof checks !== "object" ||
		checks === null ||
		required.some((name) => checks[name] !== true)
	) {
		throw new Error("FLY-1252 reviewed/deployed evidence is incomplete");
	}
	if (
		typeof value.deployedCheckout !== "string" ||
		!value.deployedCheckout.startsWith("/")
	) {
		throw new Error("FLY-1252 deployed checkout is missing");
	}
	const checkoutStat = lstatSync(value.deployedCheckout);
	if (
		!checkoutStat.isDirectory() ||
		checkoutStat.isSymbolicLink() ||
		checkoutStat.uid !== process.getuid?.()
	) {
		throw new Error("FLY-1252 deployed checkout is unsafe");
	}
	const checkout = realpathSync(value.deployedCheckout);
	const resolveLiveWrapper =
		deps.resolveLiveWrapper ??
		(() => {
			const label =
				process.env.FLYWHEEL_QUOTA_LAUNCH_LABEL ?? "com.flywheel.quota-monitor";
			const plist =
				process.env.FLYWHEEL_QUOTA_PLIST_DEST ??
				join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
			return execFileSync(
				"plutil",
				["-extract", "ProgramArguments.1", "raw", "-o", "-", plist],
				{ encoding: "utf8", timeout: 2_000 },
			).trim();
		});
	const liveWrapper = realpathSync(resolveLiveWrapper());
	const expectedWrapper = join(
		checkout,
		"scripts",
		"flywheel-quota-monitor-wrapper.sh",
	);
	if (liveWrapper !== expectedWrapper) {
		throw new Error(
			"FLY-1252 evidence is not bound to the live launch wrapper",
		);
	}
	const deployedHead = execFileSync(
		"git",
		["-C", checkout, "rev-parse", "HEAD"],
		{
			encoding: "utf8",
			timeout: 5_000,
		},
	).trim();
	if (deployedHead !== reviewedSha || deployedHead !== value.deployedSha) {
		throw new Error(
			"FLY-1252 reviewed SHA is not the deployed repository HEAD",
		);
	}
	try {
		execFileSync("git", ["-C", checkout, "diff", "--quiet", "HEAD", "--"], {
			stdio: "ignore",
			timeout: 5_000,
		});
	} catch {
		throw new Error("FLY-1252 deployed repository has tracked worktree drift");
	}
	const runtimeDir = join(
		checkout,
		"packages",
		"teamlead",
		"dist",
		"account-heal",
	);
	const expectedEntrypoint = realpathSync(
		join(runtimeDir, "quota-monitor-cli.js"),
	);
	if (runtimeTreeSha256(runtimeDir) !== value.runtimeTreeSha256) {
		throw new Error("FLY-1252 runtime tree differs from reviewed evidence");
	}
	const stateDir =
		process.env.FLYWHEEL_STATE_DIR ?? join(homedir(), ".flywheel");
	const livePidfile =
		deps.readLivePidfile?.() ??
		readPidfile(
			process.env.FLYWHEEL_QUOTA_PIDFILE ?? join(stateDir, "quota-monitor.pid"),
		);
	if (
		livePidfile === null ||
		!pidfileProcessMatches(livePidfile, {
			isProcessAlive: deps.isProcessAlive,
			readProcessStartTime: deps.readProcessStartTime,
		})
	) {
		throw new Error("FLY-1252 live quota monitor identity cannot be proved");
	}
	const liveCommand =
		deps.resolveLiveCommand?.(livePidfile.pid) ??
		processCommand(livePidfile.pid) ??
		"";
	if (!commandRunsEntrypoint(liveCommand, expectedEntrypoint)) {
		throw new Error(
			"FLY-1252 evidence is not bound to the live quota monitor entrypoint",
		);
	}
	return value.runtimeTreeSha256;
}

export function makeSystemPoolRebuildRuntime(
	paths: PoolRebuildPaths,
): PoolRebuildRuntime {
	const stateDir = dirname(paths.config);
	const pidfile =
		process.env.FLYWHEEL_QUOTA_PIDFILE ?? join(stateDir, "quota-monitor.pid");
	const runMarker =
		process.env.FLYWHEEL_QUOTA_RUN_MARKER ??
		join(stateDir, "quota-monitor.running");
	const healthMarker =
		process.env.FLYWHEEL_QUOTA_HEALTH_MARKER ??
		join(stateDir, "quota-monitor.health.json");
	const launchctl = process.env.FLYWHEEL_QUOTA_LAUNCHCTL_BIN ?? "launchctl";
	const label =
		process.env.FLYWHEEL_QUOTA_LAUNCH_LABEL ?? "com.flywheel.quota-monitor";
	const plist =
		process.env.FLYWHEEL_QUOTA_PLIST_DEST ??
		join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
	const domain = `gui/${process.getuid?.() ?? -1}`;
	const monitorModulePath = fileURLToPath(
		new URL("./quota-monitor-cli.js", import.meta.url),
	);
	const monitorEntrypoint = resolveQuotaMonitorEntrypoint(
		existsSync(monitorModulePath)
			? monitorModulePath
			: monitorModulePath.replace(/\.js$/, ".ts"),
	);
	const timeoutMs = Number(
		process.env.FLYWHEEL_POOL_REBUILD_TIMEOUT_MS ?? 90_000,
	);
	let healthNotBefore = 0;

	const waitUntil = async (
		predicate: () => boolean,
		message: string,
	): Promise<void> => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() <= deadline) {
			if (predicate()) return;
			await sleep(250);
		}
		throw new Error(message);
	};

	const assertConfig = (mode: "monitor" | "enabled", hash: string): void => {
		if (sha256(paths.config) !== hash)
			throw new Error("quota config hash mismatch");
		const config = readConfig(paths.config);
		const order = config.order;
		if (!Array.isArray(order)) throw new Error("quota config order is invalid");
		if (mode === "monitor") {
			if (order.length !== 0 || config.trigger5hPct !== 100) {
				throw new Error(
					"monitor-only config must have order=[] and trigger5hPct=100",
				);
			}
		} else if (order.length === 0 || config.trigger5hPct !== 90) {
			throw new Error("enabled config must have targets and trigger5hPct=90");
		}
	};
	const quotaDaemonMatches = (record: RebuildPidfileRecord): boolean => {
		if (!pidfileProcessMatches(record)) return false;
		const command = processCommand(record.pid);
		return (
			command !== null && commandRunsEntrypoint(command, monitorEntrypoint)
		);
	};
	const daemonMode = (): "monitor" | "enabled" | "stopped" | "unknown" => {
		const pid = readPidfile(pidfile);
		if (pid === null || !processAlive(pid.pid)) return "stopped";
		if (!quotaDaemonMatches(pid)) return "unknown";
		try {
			const config = readConfig(paths.config);
			return Array.isArray(config.order) && config.order.length === 0
				? "monitor"
				: Array.isArray(config.order) && config.order.length > 0
					? "enabled"
					: "unknown";
		} catch {
			return "unknown";
		}
	};
	const launchJobState = (): "loaded" | "absent" | "unknown" => {
		try {
			execFileSync(launchctl, ["print", `${domain}/${label}`], {
				stdio: "ignore",
				timeout: 5_000,
			});
			return "loaded";
		} catch (error) {
			return (error as { status?: number }).status === 113
				? "absent"
				: "unknown";
		}
	};

	return {
		now: Date.now,
		processIdentity: () => ({
			pid: process.pid,
			startTime:
				processStartTime(process.pid) ??
				`node-uptime:${Math.floor(Date.now() - process.uptime() * 1_000)}`,
		}),
		isProcessIdentityAlive: (pid, startTime) => {
			if (!processAlive(pid)) return false;
			const observed = processStartTime(pid);
			// Failure to prove that a live PID is different must fail closed. The
			// node-uptime fallback is only emitted for our own claim when ps is absent.
			return (
				observed === null ||
				observed === startTime ||
				startTime.startsWith("node-uptime:")
			);
		},
		canRecoverTornClaim: () => noOtherRebuildPublisherIsAlive(),
		gracefulFreeze: async (expectedHash) => {
			assertConfig("monitor", expectedHash);
			const old = readPidfile(pidfile);
			if (old === null || !quotaDaemonMatches(old)) {
				throw new Error(
					"cannot identify live quota daemon for graceful freeze",
				);
			}
			process.kill(old.pid, "SIGTERM");
			await waitUntil(
				() => !pidfileProcessMatches(old),
				"old quota daemon did not exit gracefully",
			);
			await waitUntil(() => {
				const next = readPidfile(pidfile);
				return (
					next !== null &&
					(next.pid !== old.pid ||
						next.processStartTime !== old.processStartTime) &&
					quotaDaemonMatches(next)
				);
			}, "launchd did not restart a monitor-only quota daemon");
			assertConfig("monitor", expectedHash);
			await withMkdirLock(paths.accountsLock, async () => undefined);
		},
		bootout: async () => {
			const old = readPidfile(pidfile);
			try {
				execFileSync(launchctl, ["bootout", `${domain}/${label}`], {
					stdio: "ignore",
					timeout: 10_000,
				});
			} catch {
				// Already booted out is acceptable only if the postcondition proves it.
			}
			await waitUntil(
				() =>
					(old === null || !pidfileProcessMatches(old)) &&
					!existsSync(pidfile) &&
					!existsSync(runMarker),
				"quota daemon PID/run marker remained after bootout",
			);
		},
		emergencyStop: async () => {
			for (let attempt = 0; attempt < 3; attempt++) {
				try {
					execFileSync(launchctl, ["bootout", `${domain}/${label}`], {
						stdio: "ignore",
						timeout: 10_000,
					});
				} catch {
					// The process postcondition below, not launchctl's exit, is authority.
				}
				if (launchJobState() !== "absent") {
					await sleep(250);
					continue;
				}
				const current = readPidfile(pidfile);
				if (current === null && existsSync(pidfile)) {
					// An unsafe/corrupt PID record cannot prove there is no live owner.
					// Preserve every artifact and fail closed for operator inspection.
					await sleep(250);
					continue;
				}
				if (current !== null && processAlive(current.pid)) {
					if (!quotaDaemonMatches(current)) {
						// ps/start-time/entrypoint evidence is unavailable or mismatched.
						// Never turn that uncertainty into deletion of a live daemon's
						// ownership proof.
						await sleep(250);
						continue;
					}
					try {
						process.kill(current.pid, attempt < 2 ? "SIGTERM" : "SIGKILL");
					} catch {
						// A concurrent exit is acceptable; the next probe proves it.
					}
					await sleep(attempt < 2 ? 500 : 100);
				}
				const after = readPidfile(pidfile);
				if (after === null && existsSync(pidfile)) continue;
				if (
					(current !== null && processAlive(current.pid)) ||
					(after !== null && processAlive(after.pid))
				) {
					continue;
				}
				for (const stalePath of [pidfile, runMarker]) {
					try {
						const stat = lstatSync(stalePath);
						if (
							stat.isFile() &&
							!stat.isSymbolicLink() &&
							stat.uid === process.getuid?.()
						) {
							unlinkSync(stalePath);
						}
					} catch {
						// Missing is the desired state; unsafe entries remain fail-closed.
					}
				}
				await sleep(100);
				if (daemonMode() === "stopped" && !existsSync(runMarker)) return;
			}
			throw new Error("emergency quota daemon stop could not be proved");
		},
		bootstrap: async (mode) => {
			const plistStat = lstatSync(plist);
			if (!plistStat.isFile() || plistStat.isSymbolicLink()) {
				throw new Error(
					"quota monitor plist must be a regular non-symlink file",
				);
			}
			if (mode === "monitor" && readConfig(paths.config).trigger5hPct !== 100) {
				throw new Error("refusing monitor bootstrap without frozen threshold");
			}
			healthNotBefore = Date.now();
			execFileSync(launchctl, ["bootstrap", domain, plist], {
				stdio: "ignore",
				timeout: 10_000,
			});
		},
		assertHealthy: async (mode, expectedHash, expectedRuntimeHash, policy) => {
			assertConfig(mode, expectedHash);
			await waitUntil(() => {
				const candidate = readPidfile(pidfile);
				return candidate !== null && quotaDaemonMatches(candidate);
			}, `cannot identify quota daemon for ${mode} health probe`);
			healthNotBefore = Date.now();
			execFileSync(launchctl, ["kill", "SIGUSR2", `${domain}/${label}`], {
				stdio: "ignore",
				timeout: 5_000,
			});
			await waitUntil(() => {
				const pid = readPidfile(pidfile);
				if (pid === null || !quotaDaemonMatches(pid)) return false;
				try {
					const markerStat = lstatSync(healthMarker);
					if (
						!markerStat.isFile() ||
						markerStat.isSymbolicLink() ||
						markerStat.uid !== process.getuid?.() ||
						!([0o600, 0o400] as number[]).includes(markerStat.mode & 0o777)
					) {
						return false;
					}
					const marker = JSON.parse(readFileSync(healthMarker, "utf8"));
					return (
						marker.version === 1 &&
						marker.pid === pid.pid &&
						marker.processStartTime === pid.processStartTime &&
						/^([a-f0-9]{64})$/.test(marker.runtimeTreeSha256 ?? "") &&
						(expectedRuntimeHash === undefined ||
							marker.runtimeTreeSha256 === expectedRuntimeHash) &&
						Number.isFinite(marker.completedAt) &&
						marker.completedAt >=
							Math.max(
								healthNotBefore,
								Math.floor(lstatSync(pidfile).mtimeMs),
							) &&
						typeof marker.outcome === "string" &&
						quotaHealthOutcomeAllowed(marker.outcome, policy)
					);
				} catch {
					return false;
				}
			}, `quota daemon did not produce a healthy ${mode} tick`);
			assertConfig(mode, expectedHash);
		},
		isDaemonRunning: async () => {
			const pid = readPidfile(pidfile);
			return pid !== null && quotaDaemonMatches(pid);
		},
		inspectDaemonMode: daemonMode,
		verifyProfile: async (name, source) => {
			const env = { ...process.env };
			delete env.FLYWHEEL_PROFILE_IDENTITY_BYPASS;
			const profileBin = resolveClaudeProfileBin(
				process.env.FLYWHEEL_CLAUDE_PROFILE_BIN,
			);
			execFileSync(profileBin, ["verify", name, "--source", source], {
				env,
				stdio: ["ignore", "pipe", "pipe"],
				encoding: "utf8",
				timeout: 15_000,
			});
		},
		verifyFly1252: async (reviewedSha, evidencePath) => {
			return validateFly1252Evidence(evidencePath, reviewedSha);
		},
		checkpoint: () => undefined,
	};
}

function usage(): never {
	throw new Error(
		"usage: flywheel-claude-pool-rebuild status|prepare|install-map|begin-slots|mark-slot-verified|commit|resume|promote-enabled|abort-restore",
	);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
	const command = argv[0] ?? usage();
	const args = argv.slice(1);
	const paths = defaultPoolRebuildPaths();
	const rebuild = new ClaudePoolRebuild(
		paths,
		makeSystemPoolRebuildRuntime(paths),
	);
	switch (command) {
		case "status":
			break;
		case "prepare":
			await rebuild.prepare({
				finalActive: option(args, "--final-active") ?? usage(),
				identityMapEvidence: requireAbsolute(
					option(args, "--identity-map-evidence"),
					"--identity-map-evidence",
				),
				enabledPreimage: option(args, "--enabled-preimage"),
			});
			break;
		case "install-map":
			await rebuild.installIdentityMap();
			break;
		case "begin-slots":
			await rebuild.beginSlots();
			break;
		case "mark-slot-verified":
			await rebuild.markSlotVerified(args[0] ?? usage());
			break;
		case "commit":
			await rebuild.commit();
			break;
		case "resume":
			await rebuild.resume();
			break;
		case "promote-enabled":
			await rebuild.promoteEnabled({
				fly1252ReviewedSha: option(args, "--fly-1252-sha") ?? usage(),
				fly1252Evidence: requireAbsolute(
					option(args, "--fly-1252-evidence"),
					"--fly-1252-evidence",
				),
			});
			break;
		case "abort-restore":
			await rebuild.abortRestore();
			break;
		default:
			usage();
	}
	process.stdout.write(`${JSON.stringify(rebuild.status(), null, 2)}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
	main().catch((error) => {
		process.stderr.write(
			`${JSON.stringify({
				component: "flywheel-claude-pool-rebuild",
				status: "failed",
				error: error instanceof Error ? error.message : "unknown",
			})}\n`,
		);
		process.exitCode = 1;
	});
}
