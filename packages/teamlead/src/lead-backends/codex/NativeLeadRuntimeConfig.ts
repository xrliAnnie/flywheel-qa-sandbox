import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getModelConfigSnapshot } from "flywheel-config";
import {
	readLeadRuntimeSource,
	type readLeadRuntimeTuning,
} from "../../lead-runtime-tuning.js";
import type { CodexLeadInboxServerOptions } from "./CodexLeadInboxSocket.js";
import type { LeadRuntimeConfigTarget } from "./LeadRuntimeConfigCoordinator.js";
import {
	LeadRuntimeConfigHost,
	type LeadTurnConfigAdmission,
} from "./LeadRuntimeConfigHost.js";
import { LeadModelContextGuard } from "./lead-model-context.js";
import { readLeadTurnEvidence } from "./lead-turn-evidence.js";
export class NativeLeadRuntimeConfig {
	readonly socketOwnerId = randomUUID();
	private readonly epoch = randomUUID();
	private readonly generation = randomUUID();
	private threadId = "";
	private ready = false;
	private bootstrapTuning?: ReturnType<typeof readLeadRuntimeTuning>;
	private closed = false;
	private owner = () => false;
	private readonly host: LeadRuntimeConfigHost;
	private observing = false;
	private readonly modelContext = new LeadModelContextGuard();
	private turnTargets = new Map<string, LeadRuntimeConfigTarget>();
	private pendingObservations = new Map<string, LeadRuntimeConfigTarget>();
	readonly hooks: NonNullable<CodexLeadInboxServerOptions["runtimeConfig"]>;
	constructor(
		private readonly deps: {
			config: Parameters<typeof readLeadRuntimeSource>[0] & {
				stateDir: string;
				codexHome?: string;
			};
			process: ConstructorParameters<
				typeof LeadRuntimeConfigHost
			>[0]["process"] & {
				readThreadRolloutPath?: (threadId: string) => Promise<string>;
			};
			build: { artifactBuildSha: string; bootstrapBuildSha: string };
			log: (message: string) => void;
		},
	) {
		this.host = new LeadRuntimeConfigHost({
			process: deps.process,
			beforeUpdate: async (target) => {
				const current = await deps.process.readThreadSettings(target.threadId);
				this.host.assertCurrent(target);
				if (current.model === target.model) return;
				const snapshot = getModelConfigSnapshot();
				if (snapshot.revision !== target.modelRegistryRevision)
					throw new Error("runtime_config_source_changed");
				this.modelContext.assertCompatible(
					target.threadId,
					snapshot.getModelRegistryEntry(target.model)?.contextWindowTokens,
					deps.config.modelContextWindow,
				);
			},
			statePath: join(deps.config.stateDir, "runtime-config.json"),
			identity: () => this.identity(),
			isCurrentOwner: () => this.ready && !this.closed && this.owner(),
			readSource: () => readLeadRuntimeSource(deps.config),
			onAdmissionFailure: (code) =>
				deps.log(
					`runtime config admission unavailable: ${code}; using existing session settings`,
				),
		});
		deps.process.on("notification", this.onTurn);
		this.hooks = {
			isSupported: () => {
				if (!this.ready || this.closed) return false;
				try {
					readLeadRuntimeSource(deps.config);
					return true;
				} catch {
					return false;
				}
			},
			identity: () => this.identity(),
			assertCurrent: (target) => this.host.assertCurrent(target),
			apply: async (target, guard) => {
				guard();
				const result = await this.host.apply(target);
				guard();
				return result;
			},
			read: async (target, guard) => {
				guard();
				const result = await this.host.read(target);
				guard();
				return result;
			},
		};
	}
	private readonly onTurn = (method: string, params: unknown): void => {
		if (!this.closed && method === "thread/tokenUsage/updated") {
			this.modelContext.observe(params);
			return;
		}
		if (
			this.closed ||
			!this.ready ||
			(method !== "turn/started" && method !== "turn/completed")
		)
			return;
		const raw = params as
			| { threadId?: unknown; turn?: { id?: unknown } }
			| undefined;
		if (
			raw?.threadId !== this.threadId ||
			typeof raw.turn?.id !== "string" ||
			!raw.turn.id
		)
			return;
		try {
			// Detection after turn/started cannot retroactively change that turn.
			readLeadRuntimeSource(this.deps.config);
			const target =
				method === "turn/started"
					? this.host.observationTarget()
					: this.turnTargets.get(raw.turn.id);
			if (method === "turn/completed") this.turnTargets.delete(raw.turn.id);
			else if (target) {
				this.turnTargets.set(raw.turn.id, target);
				if (this.turnTargets.size > 8)
					this.turnTargets.delete(this.turnTargets.keys().next().value!);
			}
			if (
				!target ||
				!this.deps.config.codexHome ||
				!this.deps.process.readThreadRolloutPath
			)
				return;
			this.pendingObservations.set(raw.turn.id, target);
			if (this.pendingObservations.size > 8)
				this.pendingObservations.delete(
					this.pendingObservations.keys().next().value!,
				);
			void this.drainObservations();
		} catch {
			this.deps.log("runtime turn source unavailable; observation withheld");
		}
	};
	private async drainObservations(): Promise<void> {
		if (this.observing) return;
		this.observing = true;
		try {
			while (!this.closed && this.pendingObservations.size) {
				const [turnId, target] = this.pendingObservations.entries().next()
					.value!;
				this.pendingObservations.delete(turnId);
				try {
					const path = await this.deps.process.readThreadRolloutPath!(
						target.threadId,
					);
					this.host.assertCurrent(target);
					const evidence = readLeadTurnEvidence({
						codexHome: this.deps.config.codexHome!,
						path,
						threadId: target.threadId,
						turnId,
					});
					if (evidence) {
						const observed = this.host.recordObservation(target, evidence);
						if (observed)
							this.deps.log(
								`runtime turn observed: ${JSON.stringify(observed)}`,
							);
					}
				} catch {
					this.deps.log(
						"runtime turn evidence unavailable; observation withheld",
					);
				}
			}
		} finally {
			this.observing = false;
		}
	}
	private identity() {
		return {
			projectName: this.deps.config.projectName,
			leadKey: this.deps.config.leadKey,
			identityDigest: this.deps.config.identityDigest,
			carrierId: this.socketOwnerId,
			ownerEpoch: this.epoch,
			runtimeGeneration: this.generation,
			threadId: this.threadId,
			...this.deps.build,
		};
	}
	bindOwner(check: () => boolean): void {
		this.owner = check;
	}
	/** Readback is bootstrap/settings evidence only, never an operation or actual-turn receipt. */
	async bootstrap(
		threadId: string,
		tuning: ReturnType<typeof readLeadRuntimeTuning>,
	): Promise<void> {
		this.ready = false;
		this.threadId = threadId;
		this.bootstrapTuning = { ...tuning };
		try {
			const pair = await this.deps.process.readThreadSettings(threadId);
			if (this.closed) return;
			if (
				!tuning.model ||
				!tuning.reasoningEffort ||
				pair.model !== tuning.model ||
				pair.effort !== tuning.reasoningEffort
			)
				throw new Error("bootstrap_settings_mismatch");
			// A no-op probes the native update protocol without changing the verified pair.
			await this.deps.process.updateThreadSettings({
				threadId,
				model: pair.model,
				effort: pair.effort,
			});
			if (this.closed) return;
			const after = await this.deps.process.readThreadSettings(threadId);
			if (after.model !== pair.model || after.effort !== pair.effort)
				throw new Error("bootstrap_settings_changed");
			this.ready = !this.closed;
		} catch (error) {
			this.deps.log(
				"native runtime config unavailable: " +
					(error instanceof Error ? error.message : String(error)),
			);
		}
	}
	async beforeTurn(bootstrap = false): Promise<LeadTurnConfigAdmission> {
		const assertBootstrap = () => {
			if (this.closed || (!bootstrap && this.ready && !this.owner()))
				throw new Error("runtime_config_owner_changed");
			const source = readLeadRuntimeSource(this.deps.config);
			if (
				!this.bootstrapTuning ||
				source.model !== this.bootstrapTuning.model ||
				source.reasoningEffort !== this.bootstrapTuning.reasoningEffort
			)
				throw new Error("runtime_config_source_changed");
		};
		if (this.closed) throw new Error("runtime_config_owner_changed");
		if (!bootstrap && this.ready) {
			if (!this.owner()) throw new Error("runtime_config_owner_changed");
			const managed = await this.host.beforeTurn();
			if (managed) return managed;
		}
		const validateBootstrap = () => {
			try {
				assertBootstrap();
				return true;
			} catch (error) {
				if (
					error instanceof Error &&
					error.message === "runtime_config_owner_changed"
				)
					throw error;
				this.deps.log(
					"runtime config admission unavailable: " +
						(error instanceof Error
							? error.message
							: "runtime_config_admission_unavailable") +
						"; using existing session settings",
				);
				return false;
			}
		};
		if (!validateBootstrap()) return {};
		// Native thread already owns the bootstrap pair. Omit overrides so an
		// external session change is never reset by a later sidecar dispatch.
		return { assertCurrent: validateBootstrap };
	}
	close(): void {
		this.closed = true;
		this.ready = false;
		this.pendingObservations.clear();
		this.turnTargets.clear();
		this.deps.process.off("notification", this.onTurn);
		this.host.close();
	}
}
