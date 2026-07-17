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
import {
	fetchProfileIdentity,
	type ProfileIdentityResult,
} from "./account-identity.js";
import {
	type AccountQuotaObservation,
	type RecordObservationResult,
	readStore,
	readStoreStrict,
	recordObservationInStore,
	syncActiveAccountInStore,
} from "./account-store.js";
import {
	withAccountsLock as acquireAccountsLock,
	type LockRunResult,
	reconcileTransitionJournal,
} from "./accounts-lock.js";
import {
	claudeProfileBinPath,
	makeClaudeProfileSwitchDeps,
} from "./claude-profile-cli.js";
import {
	verifyPoolCredential as defaultVerifyPoolCredential,
	type FreshnessVerdict,
} from "./freshness.js";
import {
	type MonitorCredential,
	type PollOnceResult,
	pollOnce,
	type QuotaMonitorAlert,
	type QuotaMonitorDeps,
	type ReconcileActiveResult,
} from "./quota-monitor.js";
import type { DeliveryReport } from "./quota-monitor-alert.js";
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
	fetchIdentity?: (accessToken: string) => Promise<ProfileIdentityResult>;
	verifyCandidate?: (
		name: string,
		activeName: string | null,
	) => Promise<FreshnessVerdict>;
	recordObservation?: (
		name: string,
		observation: AccountQuotaObservation,
		expectedGeneration: number,
	) => Promise<RecordObservationResult>;
	switchAccount?: (input: SwitchInput) => Promise<SwitchResult>;
	tmux?: TmuxReviveDeps;
	alert: (alert: QuotaMonitorAlert) => Promise<DeliveryReport>;
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
	const runAccountsLock = <T>(fn: () => Promise<T>) =>
		acquireAccountsLock(paths.lockPath, async () => fn(), {
			reconcile: (lease) =>
				reconcileTransitionJournal(lease, {
					binPath: claudeProfileBinPath(),
					journalPath:
						process.env.FLYWHEEL_CLAUDE_TRANSITION_JOURNAL ??
						join(dirname(paths.storePath), "claude-account-transition.json"),
				}),
		});
	class AccountLockInterrupted extends Error {
		constructor(
			public readonly result: Exclude<LockRunResult<never>, { kind: "ok" }>,
		) {
			super(`account lock interrupted: ${result.kind}`);
			this.name = "AccountLockInterrupted";
		}
	}
	const withAccountsLock = async <T>(fn: () => Promise<T>): Promise<T> => {
		const result = await runAccountsLock(fn);
		if (result.kind === "ok") return result.value;
		throw new AccountLockInterrupted(result);
	};
	const readKeychain =
		opts.readKeychainCredential ?? (() => readKeychainMonitorCredential());
	const fetchUsage = opts.fetchUsage ?? ((token) => fetchAccountUsage(token));
	const fetchIdentity =
		opts.fetchIdentity ?? ((token) => fetchProfileIdentity(token));
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
				makeClaudeProfileSwitchDeps({
					binPath: claudeProfileBinPath(),
					quotaPreverified: input.quotaPreverified === true,
				}),
			));
	const tmux =
		opts.tmux ??
		makeTmuxReviveDeps({
			socket: process.env.FLYWHEEL_QUOTA_TMUX_SOCKET ?? "",
		} satisfies TmuxReviveOptions);
	let projectionFailureStreak = 0;
	const recordObservation = async (
		name: string,
		observation: AccountQuotaObservation,
		expectedGeneration: number,
	): Promise<RecordObservationResult> => {
		let projection: RecordObservationResult;
		try {
			projection = opts.recordObservation
				? await opts.recordObservation(name, observation, expectedGeneration)
				: await withAccountsLock(async () =>
						recordObservationInStore(paths.storePath, name, observation, {
							expectedGeneration,
						}),
					);
		} catch (error) {
			if (error instanceof AccountLockInterrupted) throw error;
			projection = "write_failed";
		}

		if (projection === "write_failed" || projection === "invalid_store") {
			projectionFailureStreak += 1;
			if (projectionFailureStreak >= 3) {
				try {
					await opts.alert({
						kind: "quota_monitor_down",
						severity: "severe",
						title: "Claude quota store projection is failing",
						body: `account=${name}; consecutive_projection_failures=${projectionFailureStreak}; result=${projection}`,
						signature: `quota-monitor-store-projection-${new Date(now()).toISOString().slice(0, 10)}`,
					});
				} catch {
					// Projection failures must never stop usage polling or switching.
				}
			}
		} else {
			projectionFailureStreak = 0;
		}
		return projection;
	};

	return {
		async tick(): Promise<PollOnceResult> {
			const config = loadQuotaMonitorConfig(paths.configPath);
			const initialLock = await runAccountsLock(
				async () => readStore(paths.storePath).generation,
			);
			const storeGeneration =
				initialLock.kind === "ok"
					? initialLock.value
					: initialLock.kind === "reconciled"
						? initialLock.generation
						: 0;
			const loadedState = loadQuotaMonitorState(paths.statePath, {
				nowMs: now(),
				storeGeneration,
			});
			if (
				initialLock.kind !== "blocked" &&
				(loadedState.recovery === "corrupt" ||
					loadedState.recovery === "generation_advanced")
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

			const lockInterruptionResult = (
				result: Exclude<LockRunResult<never>, { kind: "ok" }>,
			): ReconcileActiveResult =>
				result.kind === "reconciled"
					? {
							result: "synced" as const,
							generation: result.generation,
						}
					: {
							result:
								result.reason.kind === "conflict"
									? ("transition_journal_conflict" as const)
									: ("transition_journal_writer_alive" as const),
							generation: null,
						};
			const baseDeps = {
				now,
				config,
				state: loadedState.state,
				reconcileActive: async (): Promise<ReconcileActiveResult> => {
					if (initialLock.kind !== "ok") {
						return lockInterruptionResult(initialLock);
					}
					try {
						const result = await runAccountsLock<ReconcileActiveResult>(
							async () => {
								const activeName = readActiveProfileName(paths.poolDir);
								if (activeName === null) {
									return { result: "invalid_name", generation: null };
								}
								if (readStoreStrict(paths.storePath) === null) {
									return { result: "invalid_store", generation: null };
								}
								const result = syncActiveAccountInStore(
									paths.storePath,
									activeName,
								);
								if (result !== "synced" && result !== "noop") {
									return { result, generation: null };
								}
								const authoritative = readStoreStrict(paths.storePath);
								if (authoritative === null) {
									return { result: "invalid_store", generation: null };
								}
								return { result, generation: authoritative.generation };
							},
						);
						return result.kind === "ok"
							? result.value
							: lockInterruptionResult(result);
					} catch {
						return { result: "write_failed", generation: null };
					}
				},
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
				fetchIdentity,
				recordObservation,
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
						alert: async (alert) => {
							await opts.alert(alert);
						},
					}),
				alert: opts.alert,
				log: opts.log ?? (() => undefined),
			} satisfies QuotaMonitorDeps;
			try {
				return await pollOnce(baseDeps);
			} catch (error) {
				if (!(error instanceof AccountLockInterrupted)) throw error;
				return pollOnce({
					...baseDeps,
					reconcileActive: async () => lockInterruptionResult(error.result),
				});
			}
		},
	};
}
