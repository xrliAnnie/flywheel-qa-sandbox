import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	renameSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readStore } from "./account-store.js";
import {
	claudeProfileBinPath,
	makeClaudeProfileSwitchDeps,
} from "./claude-profile-cli.js";
import {
	verifyPoolCredential as defaultVerifyPoolCredential,
	type FreshnessVerdict,
} from "./freshness.js";
import { withMkdirLock } from "./mkdir-lock.js";
import {
	type MonitorCredential,
	type PollOnceResult,
	pollOnce,
	type QuotaMonitorAlert,
} from "./quota-monitor.js";
import {
	defaultQuotaMonitorConfigPath,
	loadQuotaMonitorConfig,
} from "./quota-monitor-config.js";
import {
	listPoolAccounts,
	readActiveProfileName,
	readKeychainMonitorCredential,
	readPoolMonitorCredential,
} from "./quota-monitor-credentials.js";
import {
	defaultQuotaMonitorStatePath,
	loadQuotaMonitorState,
	writeQuotaMonitorState,
} from "./quota-monitor-state.js";
import {
	makeTmuxReviveDeps,
	reviveScan,
	type TmuxReviveOptions,
} from "./quota-revive-scan.js";
import {
	type AccountUsageResult,
	fetchAccountUsage,
	type ValidatedUsagePayload,
} from "./quota-usage-api.js";
import {
	defaultLockPath,
	switchAccount as defaultSwitchAccount,
	type SwitchInput,
	type SwitchResult,
} from "./switch-executor.js";

export interface QuotaMonitorPaths {
	poolDir: string;
	configPath: string;
	statePath: string;
	storePath: string;
	cachePath: string;
	lockPath: string;
}

export interface TmuxReviveDeps {
	listPanes: ReturnType<typeof makeTmuxReviveDeps>["listPanes"];
	capturePane: ReturnType<typeof makeTmuxReviveDeps>["capturePane"];
	sendContinue: ReturnType<typeof makeTmuxReviveDeps>["sendContinue"];
}

export interface QuotaMonitorRuntimeOptions {
	now?: () => number;
	paths?: Partial<QuotaMonitorPaths>;
	readKeychainCredential?: () => Promise<MonitorCredential | null>;
	fetchUsage?: (accessToken: string) => Promise<AccountUsageResult>;
	verifyCandidate?: (
		name: string,
		activeName: string | null,
	) => Promise<FreshnessVerdict>;
	switchAccount?: (input: SwitchInput) => Promise<SwitchResult>;
	tmux?: TmuxReviveDeps;
	alert: (alert: QuotaMonitorAlert) => Promise<void>;
	log?: (message: string) => void;
}

export function defaultQuotaMonitorPaths(): QuotaMonitorPaths {
	return {
		poolDir:
			process.env.FLYWHEEL_CLAUDE_PROFILES_DIR ??
			join(homedir(), ".flywheel", "claude-profiles"),
		configPath: defaultQuotaMonitorConfigPath(),
		statePath: defaultQuotaMonitorStatePath(),
		storePath:
			process.env.FLYWHEEL_CLAUDE_ACCOUNTS_PATH ??
			join(homedir(), ".flywheel", "claude-accounts.json"),
		cachePath:
			process.env.FLYWHEEL_QUOTA_STATUSLINE_CACHE ??
			join(homedir(), ".claude", "usage-api-cache.json"),
		lockPath: process.env.FLYWHEEL_CLAUDE_ACCOUNTS_LOCK ?? defaultLockPath(),
	};
}

function resolvePaths(
	overrides: Partial<QuotaMonitorPaths> = {},
): QuotaMonitorPaths {
	return { ...defaultQuotaMonitorPaths(), ...overrides };
}

function writeStatuslineCache(raw: ValidatedUsagePayload, path: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp.${process.pid}`;
	const fd = openSync(tmp, "w", 0o600);
	try {
		writeSync(fd, `${JSON.stringify(raw)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
}

export function makeQuotaMonitorRuntime(opts: QuotaMonitorRuntimeOptions): {
	tick: () => Promise<PollOnceResult>;
} {
	const now = opts.now ?? Date.now;
	const paths = resolvePaths(opts.paths);
	const withAccountsLock = <T>(fn: () => Promise<T>) =>
		withMkdirLock(paths.lockPath, fn);
	const readKeychain =
		opts.readKeychainCredential ?? (() => readKeychainMonitorCredential());
	const fetchUsage = opts.fetchUsage ?? ((token) => fetchAccountUsage(token));
	const verifyCandidate =
		opts.verifyCandidate ??
		((name: string, activeName: string | null) =>
			defaultVerifyPoolCredential({
				name,
				activeName,
				poolDir: paths.poolDir,
			}));
	const switchAccount =
		opts.switchAccount ??
		((input: SwitchInput) =>
			defaultSwitchAccount(
				input,
				makeClaudeProfileSwitchDeps({ binPath: claudeProfileBinPath() }),
			));
	const tmux =
		opts.tmux ??
		makeTmuxReviveDeps({
			socket: process.env.FLYWHEEL_QUOTA_TMUX_SOCKET ?? "",
		} satisfies TmuxReviveOptions);

	return {
		async tick(): Promise<PollOnceResult> {
			const config = loadQuotaMonitorConfig(paths.configPath);
			const storeGeneration = await withAccountsLock(
				async () => readStore(paths.storePath).generation,
			);
			const loadedState = loadQuotaMonitorState(paths.statePath, {
				nowMs: now(),
				storeGeneration,
			});
			if (
				loadedState.recovery === "corrupt" ||
				loadedState.recovery === "generation_advanced"
			) {
				await opts.alert({
					kind: "quota_monitor_down",
					severity: "warning",
					title: "Claude quota monitor state recovered conservatively",
					body: `recovery=${loadedState.recovery}; cooldown restarted; revive epoch closed`,
					signature: `quota-monitor-state-${loadedState.recovery}-${new Date(now()).toISOString().slice(0, 10)}`,
				});
				writeQuotaMonitorState(loadedState.state, paths.statePath);
			}

			return pollOnce({
				now,
				config,
				state: loadedState.state,
				withAccountsLock,
				readSnapshot: async () => ({
					activeName: readActiveProfileName(paths.poolDir),
					store: readStore(paths.storePath),
					activeCredential: await readKeychain(),
					poolAccounts: listPoolAccounts(paths.poolDir),
				}),
				readIdentity: async () => ({
					activeName: readActiveProfileName(paths.poolDir),
					storeGeneration: readStore(paths.storePath).generation,
				}),
				readPoolCredential: async (name) =>
					readPoolMonitorCredential(paths.poolDir, name),
				verifyCandidate,
				fetchUsage,
				writeStatuslineCache: async (raw) =>
					writeStatuslineCache(raw, paths.cachePath),
				persistState: async (state) =>
					writeQuotaMonitorState(state, paths.statePath),
				switchAccount,
				reviveScan: async (state) =>
					reviveScan({
						state,
						nowMs: now(),
						socket: process.env.FLYWHEEL_QUOTA_TMUX_SOCKET ?? "default",
						monitorOnly: config.monitorOnly,
						...tmux,
						persistState: async (next) =>
							writeQuotaMonitorState(next, paths.statePath),
						alert: opts.alert,
					}),
				alert: opts.alert,
				log: opts.log ?? (() => undefined),
			});
		},
	};
}
