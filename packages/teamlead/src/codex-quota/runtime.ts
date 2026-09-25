import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
	type CodexAccountPool,
	identifyCodexAuth,
} from "flywheel-claude-runner/bin/codex-account-core.mjs";
import {
	acquireCodexAccountLease,
	installCodexQuotaCredential,
	persistCodexCandidateCredential,
	recoverCodexCandidateCredential,
	withCodexInstallLock,
} from "flywheel-claude-runner/bin/codex-account-install.mjs";
import type { StateStore } from "../StateStore.js";
import type { CodexQuotaAvailability } from "./availability.js";
import {
	type CodexQuotaObservation,
	type CodexQuotaWindow,
	codexObservationResetElapsed,
} from "./candidate-selector.js";
import { CodexQuotaCoordinator } from "./coordinator.js";
import {
	CodexQuotaLaunchPausedError,
	createCodexQuotaLaunchBinder,
} from "./launch-binding.js";
import { CodexAccountOccupancy } from "./occupancy.js";
import {
	CodexCandidateWorkspace,
	codexQuotaIdentityReader,
	probeCodexCandidate,
} from "./probe.js";
import { readCodexQuota } from "./quota-reader.js";
import {
	type CodexQuotaReadinessOptions,
	type CodexQuotaReadinessResult,
	checkCodexQuotaReadiness,
} from "./readiness.js";
/**
 * FLY-2869: reconcile the canonical credential with the durable quota root.
 * An identity that changed outside the coordinator (`codex-profile use`,
 * `codex login`) becomes a new generation plus one N1 notification in the same
 * transaction. Read-only apart from the quota store, so it also runs when the
 * auto-switch runtime is not constructed.
 */
export async function reconcileCodexCanonicalRoot(options: {
	store: Pick<StateStore, "codexQuota">;
	canonicalHome: string;
	pool: CodexAccountPool;
	/** Fresh weekly window for an account, or [] when no fresh reading exists. */
	readingWindows?: (profile: string, accountKey: string) => CodexQuotaWindow[];
}) {
	const { pool } = options;
	const canonical = await realpath(options.canonicalHome);
	return withCodexInstallLock(canonical, () => {
		const bytes = readFileSync(join(canonical, "auth.json"), "utf8");
		const identity = codexQuotaIdentityReader(pool)(bytes);
		const rootKey = createHash("sha256").update(canonical).digest("hex");
		const authDigest = createHash("sha256").update(bytes).digest("hex");
		const quota = options.store.codexQuota;
		const root = quota.getRoot(rootKey);
		if (!root) quota.initializeRoot({ rootKey, ...identity, generation: 1 });
		else if (
			root.accountKey !== identity.accountKey ||
			root.profile !== identity.profile
		) {
			const email = (profile: string) =>
				pool.profiles.find((entry) => entry.name === profile)?.email ?? null;
			const windows = (profile: string, accountKey: string) => {
				try {
					return options.readingWindows?.(profile, accountKey) ?? [];
				} catch {
					return [];
				}
			};
			quota.reconcileExternalRoot({
				rootKey,
				expectedGeneration: root.generation,
				...identity,
				authDigest,
				notification: {
					version: 1,
					from: {
						profile: root.profile,
						accountKey: root.accountKey,
						email: email(root.profile),
						windows: windows(root.profile, root.accountKey),
					},
					to: {
						profile: identity.profile,
						accountKey: identity.accountKey,
						email: email(identity.profile),
						windows: windows(identity.profile, identity.accountKey),
					},
				},
			});
		}
		return {
			rootKey,
			...identity,
			generation: quota.getRoot(rootKey)!.generation,
			authDigest,
		};
	});
}

export interface CodexQuotaRuntimeOptions {
	store: StateStore;
	canonicalHome: string;
	profilesRoot: string;
	stateRoot: string;
	rawBinary: string;
	pool: () => CodexAccountPool;
	model: string | ((incident: Record<string, unknown>) => string);
	limitId: string;
	collectHomes: CodexQuotaReadinessOptions["collectHomes"];
	recover(incident: Record<string, unknown>): Promise<void>;
	autoEnabled?: () => boolean;
	availability?: CodexQuotaAvailability;
	/** FLY-2869: fresh readings for the manual-switch N1 (see reconcileCodexCanonicalRoot). */
	readingWindows?: (profile: string, accountKey: string) => CodexQuotaWindow[];
	/** FLY-2869: the Bridge-wide occupancy; tests default to one over collectHomes. */
	occupancy?: CodexAccountOccupancy;
}
export interface CodexQuotaRound {
	pool: CodexAccountPool;
	observations: readonly CodexQuotaObservation[];
}
export class CodexQuotaRuntime {
	private coordinator?: CodexQuotaCoordinator;
	private tickPromise?: Promise<void>;
	private readonly abort = new AbortController();
	private readonly workspace: CodexCandidateWorkspace;
	/** FLY-2869: shared with availability and the account readings when injected. */
	private readonly occupancy: CodexAccountOccupancy;
	constructor(private readonly options: CodexQuotaRuntimeOptions) {
		for (const path of [
			options.canonicalHome,
			options.profilesRoot,
			options.stateRoot,
			options.rawBinary,
		])
			if (!isAbsolute(path))
				throw new Error("quota_runtime_absolute_paths_required");
		this.workspace = new CodexCandidateWorkspace(
			join(options.stateRoot, "candidates"),
			{ profilesRoot: options.profilesRoot },
		);
		this.occupancy =
			options.occupancy ?? new CodexAccountOccupancy(options.collectHomes);
	}
	async readinessResult(): Promise<CodexQuotaReadinessResult> {
		return checkCodexQuotaReadiness({
			canonicalAuthPath: join(this.options.canonicalHome, "auth.json"),
			collectHomes: this.occupancy.collect,
		});
	}
	async readiness(): Promise<boolean> {
		if (this.abort.signal.aborted || this.options.autoEnabled?.() === false)
			return false;
		if (this.options.availability)
			return (await this.options.availability.refresh()).mode === "automatic";
		return (await this.readinessResult()).ready;
	}
	/** An unknown occupancy fences like an in-use one. */
	private candidateInUse(accountKey: string, pool: CodexAccountPool): boolean {
		return (
			this.occupancy.isInUse(
				accountKey,
				pool,
				join(this.options.canonicalHome, "auth.json"),
			) !== false
		);
	}
	/**
	 * FLY-2688 — read-only "another live process holds these credentials" test.
	 * Fails closed as `"unknown"` when the host inventory cannot be read: the
	 * account page still skips the probe, but the page says the occupancy is
	 * unknown rather than claiming every account is busy.
	 */
	accountInUseGuard(): Promise<(accountKey: string) => boolean | "unknown"> {
		return this.occupancy.guard(
			join(this.options.canonicalHome, "auth.json"),
			this.options.pool,
		);
	}
	private async requireReadiness() {
		if (!(await this.readiness())) throw new Error("quota_readiness_failed");
	}
	async observe(): Promise<CodexQuotaRound> {
		await this.requireReadiness();
		const pool = this.options.pool();
		const observations: CodexQuotaObservation[] = [];
		const identify = codexQuotaIdentityReader(pool);
		for (const profile of pool.profiles) {
			await this.requireReadiness();
			const authPath = join(
				this.options.profilesRoot,
				profile.name,
				"auth.json",
			);
			let identity: ReturnType<typeof identify>;
			try {
				identity = identify(await readFile(authPath, "utf8"));
				if (identity.profile !== profile.name)
					throw new Error("identity_mismatch");
			} catch {
				observations.push({
					profile: profile.name,
					accountKey: "unknown",
					observedAt: Date.now(),
					identityVerified: false,
					authHealth: "unknown",
					windows: [],
					scopeKnown: false,
				});
				continue;
			}
			if (this.candidateInUse(identity.accountKey, pool)) {
				observations.push({
					profile: profile.name,
					accountKey: identity.accountKey,
					observedAt: Date.now(),
					identityVerified: true,
					authHealth: "in_use_unshared",
					windows: [],
					scopeKnown: false,
				});
				continue;
			}
			try {
				const recovered = recoverCodexCandidateCredential({
					profilesRoot: this.options.profilesRoot,
					profile: profile.name,
					registry: pool,
					accountKey: identity.accountKey,
				});
				if (!["recovered", "no_pending"].includes(recovered.status))
					throw new Error("quota_candidate_recovery_pending");
				const observation = await this.workspace.run(
					identity.accountKey,
					async () => {
						await this.requireReadiness();
						if (this.candidateInUse(identity.accountKey, pool))
							throw new Error("quota_candidate_in_use");
						return readFile(authPath, "utf8");
					},
					async (workspace) => {
						const initial = identifyCodexAuth(
							await readFile(workspace.authPath, "utf8"),
							pool,
						);
						const result = await readCodexQuota({
							workspace,
							binary: this.options.rawBinary,
							profile: profile.name,
							accountKey: identity.accountKey,
							limitId: this.options.limitId,
							identify,
							signal: this.abort.signal,
							accountMatches: (account) =>
								!!account &&
								typeof account === "object" &&
								"email" in account &&
								account.email === initial.email,
						});
						const retained = persistCodexCandidateCredential({
							profilesRoot: this.options.profilesRoot,
							profile: profile.name,
							registry: pool,
							accountKey: identity.accountKey,
							finalAuthPath: result.finalAuthPath,
							expectedProfileDigest: workspace.originalAuthDigest,
							accountLease: workspace.accountLease,
						});
						if (!retained.profilePersisted)
							throw new Error("quota_candidate_persistence_pending");
						const persisted = await readFile(authPath, "utf8");
						result.observation.credentialFingerprint = createHash("sha256")
							.update(persisted)
							.digest("hex");
						const lastRefresh = JSON.parse(persisted).last_refresh;
						if (
							typeof lastRefresh === "string" &&
							lastRefresh.length <= 40 &&
							Number.isFinite(Date.parse(lastRefresh))
						)
							result.observation.lastRefresh = lastRefresh;
						await workspace.discardAfterCredentialPersistence(authPath);
						return result.observation;
					},
				);
				observations.push(observation);
			} catch (error) {
				if (
					error instanceof Error &&
					error.message === "quota_readiness_failed"
				)
					throw error;
				observations.push({
					profile: profile.name,
					accountKey: identity.accountKey,
					observedAt: Date.now(),
					identityVerified: true,
					authHealth: "unknown",
					scopeKnown: false,
					windows: [],
				});
			}
		}
		return { pool, observations };
	}
	async rotate(
		incident: Record<string, unknown>,
		candidate: CodexQuotaObservation,
		round: CodexQuotaRound,
	): Promise<{ ok: boolean; authDigest?: string }> {
		await this.requireReadiness();
		if (!round.pool.profiles.some((p) => p.name === candidate.profile))
			return { ok: false };
		if (this.candidateInUse(candidate.accountKey, round.pool))
			return { ok: false };
		const identify = codexQuotaIdentityReader(round.pool);
		const root = this.options.store.codexQuota.getRoot(
			String(incident.root_key),
		);
		const profileEmail = (profile: string) =>
			round.pool.profiles.find((entry) => entry.name === profile)?.email ??
			null;
		const notification = root
			? {
					version: 1 as const,
					from: {
						profile: root.profile,
						accountKey: root.accountKey,
						email: profileEmail(root.profile),
						windows:
							round.observations.find(
								(observation) => observation.accountKey === root.accountKey,
							)?.windows ?? [],
					},
					to: {
						profile: candidate.profile,
						accountKey: candidate.accountKey,
						email: profileEmail(candidate.profile),
						// FLY-2869: a reset-elapsed 100% is stale; the probe only proves
						// the account works now, so its usage renders as n/a.
						windows: codexObservationResetElapsed(candidate, Date.now())
							? []
							: candidate.windows,
					},
				}
			: undefined;
		const authPath = join(
			this.options.profilesRoot,
			candidate.profile,
			"auth.json",
		);
		const recovered = recoverCodexCandidateCredential({
			profilesRoot: this.options.profilesRoot,
			profile: candidate.profile,
			registry: round.pool,
			accountKey: candidate.accountKey,
		});
		if (!["recovered", "no_pending"].includes(recovered.status))
			return { ok: false };
		const model =
			typeof this.options.model === "function"
				? this.options.model(incident)
				: this.options.model;
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model))
			throw new Error("quota_probe_model_unavailable");
		const canonicalDigest = createHash("sha256")
			.update(await readFile(join(this.options.canonicalHome, "auth.json")))
			.digest("hex");
		return this.workspace.run(
			candidate.accountKey,
			async () => {
				await this.requireReadiness();
				if (this.candidateInUse(candidate.accountKey, round.pool))
					throw new Error("quota_candidate_in_use");
				return readFile(authPath, "utf8");
			},
			async (workspace) => {
				const probe = await probeCodexCandidate({
					workspace,
					binary: this.options.rawBinary,
					model,
					profile: candidate.profile,
					accountKey: candidate.accountKey,
					identify,
					signal: this.abort.signal,
				});
				if (
					!probe.ok ||
					!probe.finalAuthDigest ||
					!(await this.readiness()) ||
					this.candidateInUse(candidate.accountKey, round.pool)
				) {
					const retained = persistCodexCandidateCredential({
						profilesRoot: this.options.profilesRoot,
						profile: candidate.profile,
						registry: round.pool,
						accountKey: candidate.accountKey,
						finalAuthPath: probe.finalAuthPath,
						expectedProfileDigest: workspace.originalAuthDigest,
						accountLease: workspace.accountLease,
					});
					if (retained.profilePersisted)
						await workspace.discardAfterCredentialPersistence(authPath);
					return { ok: false };
				}
				const installed = installCodexQuotaCredential({
					home: this.options.canonicalHome,
					profilesRoot: this.options.profilesRoot,
					profile: candidate.profile,
					registry: round.pool,
					finalAuthPath: probe.finalAuthPath,
					expectedProfileDigest: workspace.originalAuthDigest,
					expectedCanonicalDigest: canonicalDigest,
					proof: {
						ok: true,
						profile: candidate.profile,
						accountKey: candidate.accountKey,
						authDigest: probe.finalAuthDigest,
						at: Date.now(),
					},
					accountLease: workspace.accountLease,
					recordInstalling: (receipt) =>
						this.options.store.codexQuota.recordInstalling({
							incidentId: String(incident.incident_id),
							...receipt,
							notification,
						}),
				});
				if (installed.profilePersisted)
					await workspace.discardAfterCredentialPersistence(authPath);
				return {
					ok: installed.status === "installed",
					authDigest: installed.canonicalDigest,
				};
			},
		);
	}
	async reconcileInstallation(
		_incident: Record<string, unknown>,
		material: {
			profile: string;
			accountKey: string;
			priorAuthDigest: string;
			installedAuthDigest: string;
			recoveryMaterialPath: string;
		},
	): Promise<"installed" | "rolled_back" | "uncertain"> {
		if (!(await this.readiness())) return "uncertain";
		const accountPool = this.options.pool();
		if (!accountPool.profiles.some((p) => p.name === material.profile))
			return "uncertain";
		try {
			const recovered = recoverCodexCandidateCredential({
				profilesRoot: this.options.profilesRoot,
				profile: material.profile,
				registry: accountPool,
				accountKey: material.accountKey,
			});
			if (!["recovered", "no_pending"].includes(recovered.status))
				return "uncertain";
			const lease = acquireCodexAccountLease(
				this.options.profilesRoot,
				material.accountKey,
			);
			try {
				return withCodexInstallLock(this.options.canonicalHome, () => {
					const canonical = readFileSync(
						join(this.options.canonicalHome, "auth.json"),
						"utf8",
					);
					const hash = createHash("sha256").update(canonical).digest("hex");
					const pool = readFileSync(
						join(this.options.profilesRoot, material.profile, "auth.json"),
						"utf8",
					);
					const identity = codexQuotaIdentityReader(accountPool)(pool);
					if (
						identity.profile !== material.profile ||
						identity.accountKey !== material.accountKey
					)
						return "uncertain";
					if (hash === material.priorAuthDigest) return "rolled_back";
					const current = codexQuotaIdentityReader(accountPool)(canonical);
					if (
						hash === material.installedAuthDigest &&
						current.profile === material.profile &&
						current.accountKey === material.accountKey &&
						createHash("sha256").update(pool).digest("hex") === hash
					)
						return "installed";
					return "uncertain";
				});
			} finally {
				lease.release();
			}
		} catch {
			return "uncertain";
		}
	}
	credential() {
		return reconcileCodexCanonicalRoot({
			store: this.options.store,
			canonicalHome: this.options.canonicalHome,
			pool: this.options.pool(),
			...(this.options.readingWindows
				? { readingWindows: this.options.readingWindows }
				: {}),
		});
	}

	async beforeCodexDaemonStart(home: string, executionId: string) {
		if (this.abort.signal.aborted) throw new Error("quota_runtime_stopped");
		await this.credential();
		const pool = this.options.pool();
		return createCodexQuotaLaunchBinder({
			store: this.options.store,
			canonicalHome: this.options.canonicalHome,
			identify: codexQuotaIdentityReader(pool),
		})(home, executionId);
	}
	tick(): Promise<void> {
		if (this.abort.signal.aborted) return Promise.resolve();
		if (this.tickPromise) return this.tickPromise;
		this.coordinator ??= new CodexQuotaCoordinator({
			store: this.options.store.codexQuota,
			autoEnabled: this.options.autoEnabled,
			...(this.options.availability
				? { availability: () => this.options.availability!.refresh() }
				: {}),
			readiness: () => this.readiness(),
			observe: () => this.observe(),
			rotate: (incident, candidate, round) =>
				this.rotate(incident, candidate, round),
			reconcileInstallation: (incident, material) =>
				this.reconcileInstallation(incident, material),
			recover: this.options.recover,
		});
		this.tickPromise = (async () => {
			try {
				await this.credential();
			} catch (error) {
				if (
					!(error instanceof Error) ||
					error.message !== "quota_installation_pending"
				)
					throw error;
			}
			await this.coordinator!.tick();
		})().finally(() => {
			this.tickPromise = undefined;
		});
		return this.tickPromise;
	}
	async stop() {
		this.abort.abort();
		await this.tickPromise;
	}
}
export interface CodexQuotaDispatcherWiring {
	beforeCodexDaemonStart?: (
		home: string,
		executionId: string,
	) => Promise<import("flywheel-core").CodexQuotaBindingV1 | null>;
	executionQuotaPaused?: (executionId: string) => boolean;
	codexQuotaAdmission?: (input: {
		projectName: string;
		executionId: string;
	}) => { rootKey: string; generation: number } | undefined;
}

export type CodexQuotaFailureReporter = (code: string, cause: unknown) => void;

export async function initializeCodexQuotaRuntime(
	enabled: () => boolean,
	construct: () => CodexQuotaRuntime | Promise<CodexQuotaRuntime>,
	report: CodexQuotaFailureReporter,
): Promise<CodexQuotaRuntime | undefined> {
	if (!enabled()) return undefined;
	try {
		return await construct();
	} catch (cause) {
		report("quota_runtime_init_failed", cause);
		return undefined;
	}
}

export function wireCodexQuotaDispatcher(
	dispatcher: CodexQuotaDispatcherWiring,
	store: StateStore,
	runtime: CodexQuotaRuntime | undefined,
	rootKey: string,
	options: { enabled: () => boolean; report: CodexQuotaFailureReporter } = {
		enabled: () => true,
		report: (code, cause) =>
			console.warn({ code, cause, rotation: "disabled" }),
	},
): void {
	const hasLaunchPolicy =
		typeof (store as Partial<StateStore>).isCodexQuotaLaunchPaused ===
		"function";
	const launchPaused = (executionId: string) => {
		const policy = (store as Partial<StateStore>).isCodexQuotaLaunchPaused;
		if (typeof policy === "function")
			return policy.call(store, executionId, rootKey);
		const casualty = store.codexQuota.isExecutionPaused(executionId);
		const safety =
			typeof store.codexQuota.hasRootSafetyGuard === "function" &&
			store.codexQuota.hasRootSafetyGuard(
				rootKey,
				Date.now(),
				options.enabled(),
			);
		return (
			casualty ||
			safety ||
			(options.enabled() && store.codexQuota.isPaused(rootKey))
		);
	};
	dispatcher.beforeCodexDaemonStart = async (home, executionId) => {
		const assertUnpaused = () => {
			if (launchPaused(executionId)) throw new CodexQuotaLaunchPausedError();
		};
		if (!options.enabled()) {
			if (!hasLaunchPolicy) return null;
			assertUnpaused();
			return null;
		}
		try {
			assertUnpaused();
			if (!runtime) return null;
			const binding = await runtime.beforeCodexDaemonStart(home, executionId);
			if (!options.enabled()) return null;
			assertUnpaused();
			return binding;
		} catch (cause) {
			if (!options.enabled()) return null;
			if (cause instanceof CodexQuotaLaunchPausedError) throw cause;
			try {
				assertUnpaused();
			} catch (pauseCause) {
				if (pauseCause instanceof CodexQuotaLaunchPausedError) throw pauseCause;
				// An unavailable quota store is infrastructure failure, not a pause.
			}
			options.report("quota_runtime_bind_failed", cause);
			return null;
		}
	};
	dispatcher.executionQuotaPaused = (executionId) =>
		store.codexQuota.isExecutionPaused(executionId);
	dispatcher.codexQuotaAdmission = () => {
		if (!options.enabled() && !hasLaunchPolicy) return undefined;
		if (!launchPaused("quota-admission")) return undefined;
		const root = store.codexQuota.getRoot(rootKey);
		if (!root) throw new Error("quota_root_unavailable");
		return { rootKey, generation: root.generation };
	};
}

const failureAlertTimes = new Map<string, number>();
const FAILURE_ALERT_WINDOW_MS = 60 * 60 * 1000;
type QuotaFailureDiagnostic = {
	code: string;
	cause: string;
	host: string;
	rotation: "disabled";
};
export function createCodexQuotaFailureReporter(options: {
	host: string;
	now?: () => number;
	log: (diagnostic: QuotaFailureDiagnostic) => void;
	alert: (diagnostic: QuotaFailureDiagnostic, eventId: string) => void;
}): CodexQuotaFailureReporter {
	return (code, cause) => {
		const diagnostic: QuotaFailureDiagnostic = {
			code,
			cause: cause instanceof Error ? cause.message : String(cause),
			host: options.host,
			rotation: "disabled",
		};
		options.log(diagnostic);
		const now = (options.now ?? Date.now)();
		const prior = failureAlertTimes.get(options.host);
		if (prior !== undefined && now - prior < FAILURE_ALERT_WINDOW_MS) return;
		const eventId = `codex-quota-runtime:${options.host}:${Math.floor(now / FAILURE_ALERT_WINDOW_MS)}`;
		try {
			options.alert(diagnostic, eventId);
			failureAlertTimes.set(options.host, now);
		} catch (error) {
			options.log({
				...diagnostic,
				code: "quota_runtime_alert_failed",
				cause: error instanceof Error ? error.message : String(error),
			});
		}
	};
}
