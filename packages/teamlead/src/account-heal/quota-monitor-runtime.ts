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
	writeStore,
} from "./account-store.js";
import { drainSwitchNotification } from "./account-switch-notification.js";
import {
	withAccountsLock as acquireAccountsLock,
	type LockRunResult,
	reconcileTransitionJournal,
} from "./accounts-lock.js";
import {
	claudeProfileBinPath,
	makeClaudeProfileSwitchDeps,
	reconcileClaudeProfile,
} from "./claude-profile-cli.js";
import {
	verifyPoolCredential as defaultVerifyPoolCredential,
	type FreshnessVerdict,
} from "./freshness.js";
import {
	defaultClaudeJsonPath,
	resolveMachineAccount,
} from "./machine-account.js";
import { finalizeConfirmationFromSnapshot } from "./quota-confirmation.js";
import { recoverCommittedModelSwitchIncident } from "./quota-incident.js";
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
	drainQuotaMonitorAlertOutbox,
	type StrictDeliveryResult,
} from "./quota-monitor-alert.js";
import {
	defaultQuotaMonitorConfigPath,
	loadQuotaMonitorConfig,
} from "./quota-monitor-config.js";
import {
	listPoolAccounts,
	readKeychainMonitorCredential,
	readPoolMonitorCredential,
	readPoolMonitorCredentialSnapshot,
	readPoolProfileIdentity,
	resolvePoolProfileIdentity,
} from "./quota-monitor-credentials.js";
import {
	type DurableAlertIntent,
	defaultQuotaMonitorStatePath,
	loadQuotaMonitorState,
	writeQuotaMonitorState,
} from "./quota-monitor-state.js";
import {
	discoverPrivateLeadSockets,
	makeTmuxFleetReviveDeps,
	type makeTmuxReviveDeps,
	reviveScan,
	scanQuotaPanes,
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

const RECONCILE_RETRY_MS = 20 * 60_000;

export interface QuotaMonitorPaths {
	poolDir: string;
	configPath: string;
	statePath: string;
	storePath: string;
	cachePath: string;
	lockPath: string;
	claudeJsonPath: string;
	confirmationEvidenceDir: string;
}

export interface TmuxReviveDeps {
	listPanes: ReturnType<typeof makeTmuxReviveDeps>["listPanes"];
	capturePane: ReturnType<typeof makeTmuxReviveDeps>["capturePane"];
	sendContinue: ReturnType<typeof makeTmuxReviveDeps>["sendContinue"];
}

export interface QuotaMonitorRuntimeOptions {
	now?: () => number;
	paths?: Partial<QuotaMonitorPaths>;
	reconcileMachine?: () => Promise<boolean>;
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
	alert: (alert: QuotaMonitorAlert) => Promise<void | DeliveryReport>;
	deliverAlert?: (
		alert: DurableAlertIntent["alert"],
	) => Promise<StrictDeliveryResult>;
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
		claudeJsonPath: defaultClaudeJsonPath(),
		confirmationEvidenceDir:
			process.env.FLYWHEEL_QUOTA_CONFIRMATION_DIR ??
			join(homedir(), ".flywheel", "quota-confirmations"),
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

function confirmationEvidencePath(dir: string, eventId: string): string {
	const safeEventId = eventId.replace(/[^A-Za-z0-9._-]+/g, "-");
	return join(dir, `${safeEventId}.json`);
}

export function makeQuotaMonitorRuntime(opts: QuotaMonitorRuntimeOptions): {
	tick: () => Promise<PollOnceResult>;
} {
	const now = opts.now ?? Date.now;
	const paths = resolvePaths(opts.paths);
	const reconcileMachine =
		opts.reconcileMachine ??
		(() =>
			reconcileClaudeProfile({
				binPath: claudeProfileBinPath(),
				env: {
					FLYWHEEL_CLAUDE_PROFILES_DIR: paths.poolDir,
					FLYWHEEL_CLAUDE_ACCOUNTS_PATH: paths.storePath,
					FLYWHEEL_CLAUDE_ACCOUNTS_LOCK: paths.lockPath,
					FLYWHEEL_CLAUDE_JSON: paths.claudeJsonPath,
					FLYWHEEL_CLAUDE_TRANSITION_JOURNAL:
						process.env.FLYWHEEL_CLAUDE_TRANSITION_JOURNAL ??
						join(dirname(paths.storePath), "claude-account-transition.json"),
				},
			}));
	const emitAlert = async (alert: QuotaMonitorAlert): Promise<DeliveryReport> =>
		(await opts.alert(alert)) ?? { primary: "sent" };
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
	const drainCommittedSwitchNotification = async (): Promise<void> => {
		try {
			await drainSwitchNotification({
				withAccountsLock,
				readStore: async () => {
					const store = readStoreStrict(paths.storePath);
					if (store === null) {
						throw new Error("Claude account store is invalid");
					}
					return store;
				},
				writeStore: async (store) => writeStore(store, paths.storePath),
				send: emitAlert,
			});
		} catch (error) {
			(opts.log ?? (() => undefined))(
				`switch notification retained after delivery error: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
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
					poolDir: paths.poolDir,
					claudeJsonPath: paths.claudeJsonPath,
					storePath: paths.storePath,
					lockPath: paths.lockPath,
					quotaPreverified: input.quotaPreverified === true,
					deliverNotification: emitAlert,
				}),
			));
	const tmux =
		opts.tmux ??
		makeTmuxFleetReviveDeps({
			runnerSocket: process.env.FLYWHEEL_QUOTA_TMUX_SOCKET ?? "",
			leadSockets: discoverPrivateLeadSockets(),
		});
	const tmuxSocket = process.env.FLYWHEEL_QUOTA_TMUX_SOCKET ?? "default";
	let projectionFailureStreak = 0;
	let lastReconcileAttempt: {
		authority: string;
		live: string;
		pooled: string | null;
		at: number;
	} | null = null;
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
					await emitAlert({
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
			await drainCommittedSwitchNotification();
			const machineWitness = await runAccountsLock(async () => {
				const store = readStore(paths.storePath);
				const authority = resolveMachineAccount({
					poolDir: paths.poolDir,
					claudeJsonPath: paths.claudeJsonPath,
					store,
				});
				const live = await readKeychain();
				if (live === null) return null;
				const pooled =
					authority.kind === "resolved"
						? readPoolMonitorCredentialSnapshot(paths.poolDir, authority.name)
						: null;
				return {
					authority:
						authority.kind === "resolved"
							? `resolved:${authority.name}`
							: authority.kind,
					live: live.rawDigest ?? live.accessToken,
					pooled: pooled?.rawDigest ?? pooled?.accessToken ?? null,
					needsReconcile:
						authority.kind !== "resolved" ||
						pooled === null ||
						(live.rawDigest !== undefined && pooled.rawDigest !== undefined
							? live.rawDigest !== pooled.rawDigest
							: live.accessToken !== pooled.accessToken),
				};
			});
			if (machineWitness.kind === "ok" && machineWitness.value !== null) {
				const witness = machineWitness.value;
				if (!witness.needsReconcile) {
					lastReconcileAttempt = null;
				} else if (
					lastReconcileAttempt === null ||
					lastReconcileAttempt.authority !== witness.authority ||
					lastReconcileAttempt.live !== witness.live ||
					lastReconcileAttempt.pooled !== witness.pooled ||
					now() - lastReconcileAttempt.at >= RECONCILE_RETRY_MS
				) {
					lastReconcileAttempt = { ...witness, at: now() };
					try {
						if (!(await reconcileMachine())) {
							(opts.log ?? (() => undefined))(
								"quota monitor could not reconcile the live Claude identity",
							);
						}
					} catch (error) {
						(opts.log ?? (() => undefined))(
							`quota monitor live identity reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				}
			}
			const initialLock = await runAccountsLock(async () =>
				readStore(paths.storePath),
			);
			const currentStore =
				initialLock.kind === "ok"
					? initialLock.value
					: readStore(paths.storePath);
			const storeGeneration =
				initialLock.kind === "ok"
					? initialLock.value.generation
					: initialLock.kind === "reconciled"
						? initialLock.generation
						: 0;
			const loadedState = loadQuotaMonitorState(paths.statePath, {
				nowMs: now(),
				storeGeneration,
			});
			let state = loadedState.state;
			if (
				initialLock.kind !== "blocked" &&
				(loadedState.recovery === "corrupt" ||
					loadedState.recovery === "generation_advanced")
			) {
				await emitAlert({
					kind: "quota_monitor_down",
					severity: "warning",
					title: "Claude quota monitor state recovered conservatively",
					body: `recovery=${loadedState.recovery}; cooldown restarted; revive epoch closed`,
					signature: `quota-monitor-state-${loadedState.recovery}-${new Date(now()).toISOString().slice(0, 10)}`,
				});
				writeQuotaMonitorState(state, paths.statePath);
			} else if (loadedState.recovery === "migrated_v1") {
				writeQuotaMonitorState(state, paths.statePath);
			}

			const recovered = recoverCommittedModelSwitchIncident(
				state,
				currentStore,
				{
					nowMs: now(),
					confirmDelayMs: config.config.confirmDelayMinutes * 60_000,
				},
			);
			if (recovered.recovered) {
				state = recovered.state;
				writeQuotaMonitorState(state, paths.statePath);
			}
			if (opts.deliverAlert && state.alertOutbox.length > 0) {
				try {
					const drained = await drainQuotaMonitorAlertOutbox(state, {
						send: opts.deliverAlert,
						persistState: async (next) =>
							writeQuotaMonitorState(next, paths.statePath),
					});
					state = drained.state;
				} catch (error) {
					(opts.log ?? (() => undefined))(
						`quota alert outbox retained after delivery error: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
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
				state,
				reconcileActive: async (): Promise<ReconcileActiveResult> => {
					if (initialLock.kind !== "ok") {
						return lockInterruptionResult(initialLock);
					}
					try {
						const result = await runAccountsLock<ReconcileActiveResult>(
							async () => {
								const store = readStore(paths.storePath);
								const authority = resolveMachineAccount({
									poolDir: paths.poolDir,
									claudeJsonPath: paths.claudeJsonPath,
									store,
								});
								if (authority.kind !== "resolved") {
									return { result: "invalid_name", generation: null };
								}
								const activeName = authority.name;
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
				readSnapshot: async () => {
					const store = readStore(paths.storePath);
					const authority = resolveMachineAccount({
						poolDir: paths.poolDir,
						claudeJsonPath: paths.claudeJsonPath,
						store,
					});
					return {
						activeName: authority.kind === "resolved" ? authority.name : null,
						authority,
						store,
						activeCredential: await readKeychain(),
						poolAccounts: listPoolAccounts(paths.poolDir),
					};
				},
				readIdentity: async () => {
					const store = readStore(paths.storePath);
					const authority = resolveMachineAccount({
						poolDir: paths.poolDir,
						claudeJsonPath: paths.claudeJsonPath,
						store,
					});
					return {
						activeName: authority.kind === "resolved" ? authority.name : null,
						storeGeneration: store.generation,
					};
				},
				readPoolCredential: async (name) =>
					readPoolMonitorCredential(paths.poolDir, name),
				verifyCandidate,
				fetchUsage,
				fetchIdentity,
				resolveIdentityName: async (identity) =>
					resolvePoolProfileIdentity(paths.poolDir, identity),
				readPoolIdentity: async (name) =>
					readPoolProfileIdentity(paths.poolDir, name),
				recordObservation,
				writeStatuslineCache: async (raw) =>
					writeStatuslineCache(raw, paths.cachePath),
				persistState: async (state) =>
					writeQuotaMonitorState(state, paths.statePath),
				switchAccount,
				scanPanes: async () =>
					scanQuotaPanes({
						nowMs: now(),
						socket: tmuxSocket,
						qaInjectionEnabled: process.env.FLYWHEEL_QUOTA_QA_INJECTION === "1",
						listPanes: tmux.listPanes,
						capturePane: tmux.capturePane,
					}),
				reviveSnapshot: async (state, snapshot, actionsAllowed) =>
					reviveScan({
						state,
						nowMs: now(),
						socket: tmuxSocket,
						monitorOnly: config.monitorOnly || !actionsAllowed,
						qaInjectionEnabled: process.env.FLYWHEEL_QUOTA_QA_INJECTION === "1",
						...tmux,
						snapshot,
						persistState: async (next) =>
							writeQuotaMonitorState(next, paths.statePath),
						alert: async (alert) => {
							await emitAlert(alert);
						},
					}),
				confirmSnapshot: async (state, snapshot) => {
					const confirmation = state.confirmation;
					if (confirmation === null) return state;
					const next = finalizeConfirmationFromSnapshot(state, snapshot, {
						nowMs: now(),
						evidencePath: confirmationEvidencePath(
							paths.confirmationEvidenceDir,
							confirmation.eventId,
						),
					});
					writeQuotaMonitorState(next, paths.statePath);
					return next;
				},
				alert: emitAlert,
				log: opts.log ?? (() => undefined),
			} satisfies QuotaMonitorDeps;
			let polled: PollOnceResult;
			try {
				polled = await pollOnce(baseDeps);
			} catch (error) {
				if (!(error instanceof AccountLockInterrupted)) throw error;
				polled = await pollOnce({
					...baseDeps,
					reconcileActive: async () => lockInterruptionResult(error.result),
				});
			}
			state = polled.state;
			if (opts.deliverAlert && state.alertOutbox.length > 0) {
				try {
					const drained = await drainQuotaMonitorAlertOutbox(state, {
						send: opts.deliverAlert,
						persistState: async (next) =>
							writeQuotaMonitorState(next, paths.statePath),
					});
					state = drained.state;
				} catch (error) {
					(opts.log ?? (() => undefined))(
						`quota alert outbox retained after delivery error: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			await drainCommittedSwitchNotification();
			return { ...polled, state };
		},
	};
}
