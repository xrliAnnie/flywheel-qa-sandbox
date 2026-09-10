import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
	type CodexAccountRegistry,
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
import type { CodexQuotaObservation } from "./candidate-selector.js";
import { CodexQuotaCoordinator } from "./coordinator.js";
import {
	CodexQuotaLaunchPausedError,
	createCodexQuotaLaunchBinder,
} from "./launch-binding.js";
import {
	CodexCandidateWorkspace,
	codexQuotaIdentityReader,
	probeCodexCandidate,
} from "./probe.js";
import { readCodexQuota } from "./quota-reader.js";
import {
	type CodexQuotaReadinessOptions,
	checkCodexQuotaReadiness,
} from "./readiness.js";
export interface CodexQuotaRuntimeOptions {
	store: StateStore;
	canonicalHome: string;
	profilesRoot: string;
	stateRoot: string;
	rawBinary: string;
	registry: CodexAccountRegistry;
	model: string | ((incident: Record<string, unknown>) => string);
	limitId: string;
	collectHomes: CodexQuotaReadinessOptions["collectHomes"];
	recover(incident: Record<string, unknown>): Promise<void>;
	autoEnabled?: () => boolean;
}
export class CodexQuotaRuntime {
	private canonicalChainActive = false;
	private activeUnsharedAccountKeys = new Set<string>();
	private coordinator?: CodexQuotaCoordinator;
	private tickPromise?: Promise<void>;
	private readonly abort = new AbortController();
	private readonly workspace: CodexCandidateWorkspace;
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
	}
	async readiness(): Promise<boolean> {
		if (this.abort.signal.aborted || this.options.autoEnabled?.() === false)
			return false;
		return (
			await checkCodexQuotaReadiness({
				canonicalAuthPath: join(this.options.canonicalHome, "auth.json"),
				collectHomes: async () => {
					const inventory = await this.options.collectHomes();
					this.canonicalChainActive =
						(inventory as typeof inventory & { canonicalChainActive?: boolean })
							.canonicalChainActive === true ||
						inventory.homes.some(
							(home) =>
								home.ownership === "managed" && home.activity === "active",
						);
					this.activeUnsharedAccountKeys = new Set(
						(
							inventory as typeof inventory & {
								activeUnsharedAccountKeys?: string[];
							}
						).activeUnsharedAccountKeys ?? [],
					);
					return inventory;
				},
			})
		).ready;
	}
	private candidateInUse(accountKey: string): boolean {
		if (this.activeUnsharedAccountKeys.has(accountKey)) return true;
		return (
			this.canonicalChainActive &&
			codexQuotaIdentityReader(this.options.registry)(
				readFileSync(join(this.options.canonicalHome, "auth.json"), "utf8"),
			).accountKey === accountKey
		);
	}
	private async requireReadiness() {
		if (!(await this.readiness())) throw new Error("quota_readiness_failed");
	}
	async observe(): Promise<CodexQuotaObservation[]> {
		await this.requireReadiness();
		const observations: CodexQuotaObservation[] = [];
		const identify = codexQuotaIdentityReader(this.options.registry);
		for (const profile of this.options.registry.profiles) {
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
			if (this.candidateInUse(identity.accountKey)) {
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
					registry: this.options.registry,
					accountKey: identity.accountKey,
				});
				if (!["recovered", "no_pending"].includes(recovered.status))
					throw new Error("quota_candidate_recovery_pending");
				const observation = await this.workspace.run(
					identity.accountKey,
					async () => {
						await this.requireReadiness();
						if (this.candidateInUse(identity.accountKey))
							throw new Error("quota_candidate_in_use");
						return readFile(authPath, "utf8");
					},
					async (workspace) => {
						const initial = identifyCodexAuth(
							await readFile(workspace.authPath, "utf8"),
							this.options.registry,
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
							registry: this.options.registry,
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
		return observations;
	}
	async rotate(
		incident: Record<string, unknown>,
		candidate: CodexQuotaObservation,
	): Promise<{ ok: boolean; authDigest?: string }> {
		await this.requireReadiness();
		if (
			!this.options.registry.profiles.some((p) => p.name === candidate.profile)
		)
			return { ok: false };
		if (this.candidateInUse(candidate.accountKey)) return { ok: false };
		const identify = codexQuotaIdentityReader(this.options.registry);
		const authPath = join(
			this.options.profilesRoot,
			candidate.profile,
			"auth.json",
		);
		const recovered = recoverCodexCandidateCredential({
			profilesRoot: this.options.profilesRoot,
			profile: candidate.profile,
			registry: this.options.registry,
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
				if (this.candidateInUse(candidate.accountKey))
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
					this.candidateInUse(candidate.accountKey)
				) {
					const retained = persistCodexCandidateCredential({
						profilesRoot: this.options.profilesRoot,
						profile: candidate.profile,
						registry: this.options.registry,
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
					registry: this.options.registry,
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
		if (
			!this.options.registry.profiles.some((p) => p.name === material.profile)
		)
			return "uncertain";
		try {
			const recovered = recoverCodexCandidateCredential({
				profilesRoot: this.options.profilesRoot,
				profile: material.profile,
				registry: this.options.registry,
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
					const identity = codexQuotaIdentityReader(this.options.registry)(
						pool,
					);
					if (
						identity.profile !== material.profile ||
						identity.accountKey !== material.accountKey
					)
						return "uncertain";
					if (hash === material.priorAuthDigest) return "rolled_back";
					const current = codexQuotaIdentityReader(this.options.registry)(
						canonical,
					);
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
	async credential() {
		const canonical = await realpath(this.options.canonicalHome);
		return withCodexInstallLock(canonical, () => {
			const bytes = readFileSync(join(canonical, "auth.json"), "utf8");
			const identity = codexQuotaIdentityReader(this.options.registry)(bytes);
			const rootKey = createHash("sha256").update(canonical).digest("hex");
			const authDigest = createHash("sha256").update(bytes).digest("hex");
			const quota = this.options.store.codexQuota;
			const root = quota.getRoot(rootKey);
			if (!root) quota.initializeRoot({ rootKey, ...identity, generation: 1 });
			else if (
				root.accountKey !== identity.accountKey ||
				root.profile !== identity.profile
			)
				quota.reconcileExternalRoot({
					rootKey,
					expectedGeneration: root.generation,
					...identity,
					authDigest,
				});
			return {
				rootKey,
				...identity,
				generation: quota.getRoot(rootKey)!.generation,
				authDigest,
			};
		});
	}

	async beforeCodexDaemonStart(home: string, executionId: string) {
		if (this.abort.signal.aborted) throw new Error("quota_runtime_stopped");
		await this.credential();
		return createCodexQuotaLaunchBinder({
			store: this.options.store,
			canonicalHome: this.options.canonicalHome,
			identify: codexQuotaIdentityReader(this.options.registry),
		})(home, executionId);
	}
	tick(): Promise<void> {
		if (this.abort.signal.aborted) return Promise.resolve();
		if (this.tickPromise) return this.tickPromise;
		this.coordinator ??= new CodexQuotaCoordinator({
			store: this.options.store.codexQuota,
			autoEnabled: this.options.autoEnabled,
			readiness: () => this.readiness(),
			observe: () => this.observe(),
			rotate: (incident, candidate) => this.rotate(incident, candidate),
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
	dispatcher.beforeCodexDaemonStart = async (home, executionId) => {
		if (!options.enabled()) return null;
		const assertUnpaused = () => {
			if (
				store.codexQuota.isPaused(rootKey) ||
				store.codexQuota.isExecutionPaused(executionId)
			)
				throw new CodexQuotaLaunchPausedError();
		};
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
		if (!options.enabled() || !runtime) return undefined;
		if (!store.codexQuota.isPaused(rootKey)) return undefined;
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
