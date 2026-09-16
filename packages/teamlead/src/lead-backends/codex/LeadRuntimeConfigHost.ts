import { lstatSync } from "node:fs";
import { dirname } from "node:path";
import {
	readRegularFileNoFollow,
	writeAtomic,
} from "flywheel-comm/lead-registry-file-io";
import { canonicalSubmissionDigest } from "flywheel-config";
import type { readLeadRuntimeSource } from "../../lead-runtime-tuning.js";
import {
	LeadRuntimeConfigCoordinator,
	type LeadRuntimeConfigIdentity,
	type LeadRuntimeConfigReceipt,
	type LeadRuntimeConfigTarget,
} from "./LeadRuntimeConfigCoordinator.js";
import {
	type LeadTurnEvidence,
	type LeadTurnObservation,
	validLeadTurnObservation,
} from "./lead-turn-evidence.js";

export interface LeadTurnConfigAdmission {
	model?: string;
	effort?: string;
	assertCurrent?: () => boolean | undefined;
}
/** Check the lease immediately before sending; never forward guards into native RPC. */
export function admitLeadTurn<T extends { model?: string; effort?: string }>(
	args: T,
	admission: LeadTurnConfigAdmission,
): T {
	const current = admission.assertCurrent?.() !== false;
	const { model: _model, effort: _effort, ...rest } = args;
	return {
		...rest,
		...(!current || admission.model === undefined
			? {}
			: { model: admission.model }),
		...(!current || admission.effort === undefined
			? {}
			: { effort: admission.effort }),
	} as T;
}
interface RecordState {
	observation?: LeadTurnObservation;
	version: 1;
	target: LeadRuntimeConfigTarget;
	receipt?: LeadRuntimeConfigReceipt;
	drifted?: true;
}
const ownerFields = [
	"projectName",
	"leadKey",
	"identityDigest",
	"carrierId",
	"ownerEpoch",
	"runtimeGeneration",
	"threadId",
] as const;
function same(a: unknown, b: unknown) {
	return canonicalSubmissionDigest(a) === canonicalSubmissionDigest(b);
}
function intent(target: LeadRuntimeConfigTarget) {
	const {
		carrierId: _carrier,
		ownerEpoch: _owner,
		runtimeGeneration: _runtime,
		threadId: _thread,
		...value
	} = target;
	return value;
}
/** Signed socket requests supply operation identity; fresh registry evidence and a durable monotonic fence authorize mutation. */
export class LeadRuntimeConfigHost {
	private coordinator: LeadRuntimeConfigCoordinator;
	private closed = false;
	constructor(
		private readonly deps: {
			process: ConstructorParameters<
				typeof LeadRuntimeConfigCoordinator
			>[0]["process"];
			beforeUpdate?: (target: LeadRuntimeConfigTarget) => Promise<void>;
			statePath: string;
			identity: () => LeadRuntimeConfigIdentity;
			isCurrentOwner: () => boolean;
			readSource: () => ReturnType<typeof readLeadRuntimeSource>;
			onAdmissionFailure?: (code: string) => void;
		},
	) {
		this.coordinator = new LeadRuntimeConfigCoordinator({
			process: deps.process,
			beforeUpdate: deps.beforeUpdate,
			initialReceipt: this.load()?.receipt,
			readAuthority: () => {
				const record = this.load();
				if (!record) throw new Error("runtime_config_not_admitted");
				this.assertCurrent(record.target);
				return record.target;
			},
			persistReceipt: (receipt) => {
				this.assertCurrent(receipt);
				const record = this.load();
				if (!record || !same(record.target, this.targetOf(receipt)))
					throw new Error("runtime_config_generation_stale");
				this.save({ ...record, receipt });
			},
			onDrift: (target) => {
				const record = this.load();
				if (record && same(record.target, this.targetOf(target)))
					this.save({ ...record, drifted: true });
			},
		});
	}
	private admissionFailure(error: unknown): LeadTurnConfigAdmission {
		if (
			error instanceof Error &&
			error.message === "runtime_config_owner_changed"
		)
			throw error;
		const code =
			error instanceof Error &&
			/^(?:runtime_config_[a-z0-9_]+|context_window_incompatible)$/.test(
				error.message,
			)
				? error.message
				: "runtime_config_admission_unavailable";
		this.deps.onAdmissionFailure?.(code);
		return {};
	}
	private targetOf(
		receipt: LeadRuntimeConfigTarget &
			Partial<
				Pick<LeadRuntimeConfigReceipt, "status" | "appliedAt" | "readback">
			>,
	): LeadRuntimeConfigTarget {
		const {
			status: _status,
			appliedAt: _at,
			readback: _readback,
			...target
		} = receipt;
		return target;
	}
	private load(): RecordState | undefined {
		const parent = lstatSync(dirname(this.deps.statePath));
		if (!parent.isDirectory() || parent.isSymbolicLink())
			throw new Error("runtime_config_receipt_path_invalid");
		try {
			lstatSync(this.deps.statePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		const record = JSON.parse(
			readRegularFileNoFollow(
				this.deps.statePath,
				"runtime config receipt",
				true,
			),
		) as RecordState;
		if (
			record.version !== 1 ||
			!record.target ||
			!Number.isSafeInteger(record.target.configGeneration) ||
			record.target.configGeneration < 1 ||
			ownerFields.some(
				(field) =>
					typeof record.target[field] !== "string" || !record.target[field],
			) ||
			typeof record.target.operationId !== "string" ||
			typeof record.target.configDigest !== "string"
		)
			throw new Error("runtime_config_receipt_invalid");
		if (
			record.receipt &&
			(record.receipt.status !== "applied" ||
				!same(this.targetOf(record.receipt), record.target))
		)
			throw new Error("runtime_config_receipt_invalid");
		return record;
	}
	private save(record: RecordState): void {
		writeAtomic(this.deps.statePath, `${JSON.stringify(record)}\n`);
	}
	assertCurrent(target: LeadRuntimeConfigTarget): void {
		if (this.closed || !this.deps.isCurrentOwner())
			throw new Error("runtime_config_owner_changed");
		const identity = this.deps.identity();
		if (ownerFields.some((field) => target[field] !== identity[field]))
			throw new Error("runtime_config_owner_changed");
		const source = this.deps.readSource();
		if (
			!source.configDigest ||
			target.configDigest !== source.configDigest ||
			target.modelRegistryRevision !== source.modelRegistryRevision ||
			target.model !== source.model ||
			target.effort !== source.reasoningEffort
		)
			throw new Error("runtime_config_source_changed");
	}
	private admit(target: LeadRuntimeConfigTarget): RecordState {
		this.assertCurrent(target);
		if (
			!Number.isSafeInteger(target.configGeneration) ||
			target.configGeneration < 1
		)
			throw new Error("runtime_config_generation_invalid");
		const prior = this.load();
		if (prior) {
			if (
				prior.target.leadKey !== target.leadKey ||
				prior.target.identityDigest !== target.identityDigest
			)
				throw new Error("runtime_config_receipt_identity_changed");
			if (
				prior.target.configGeneration > target.configGeneration ||
				(prior.target.configGeneration === target.configGeneration &&
					!same(intent(prior.target), intent(target)))
			)
				throw new Error("runtime_config_generation_stale");
			if (same(prior.target, target)) return prior;
		}
		const record: RecordState = {
			version: 1,
			target: { ...target },
			...(prior?.target.configGeneration === target.configGeneration &&
			prior.drifted
				? { drifted: true as const }
				: {}),
		};
		this.save(record);
		return record;
	}
	async apply(target: LeadRuntimeConfigTarget) {
		const record = this.admit(target);
		if (record.drifted)
			return { status: "drifted" as const, operationId: target.operationId };
		return this.coordinator.apply(target);
	}
	async read(target: LeadRuntimeConfigTarget) {
		this.assertCurrent(target);
		const record = this.load();
		if (!record || !same(record.target, this.targetOf(target)))
			throw new Error("runtime_config_not_admitted");
		const actual = await this.coordinator.readCurrent(target);
		this.assertCurrent(target);
		const current = this.load();
		if (!current || !same(current.target, this.targetOf(target)))
			throw new Error("runtime_config_generation_stale");
		return {
			...actual,
			...(current.drifted ? { drifted: true } : {}),
			...(current.observation &&
			validLeadTurnObservation(current.observation, target)
				? { observation: current.observation }
				: {}),
		};
	}
	observationTarget(): LeadRuntimeConfigTarget | undefined {
		const record = this.load();
		if (!record?.receipt) return undefined;
		this.assertCurrent(record.target);
		return { ...record.target };
	}
	recordObservation(
		target: LeadRuntimeConfigTarget,
		evidence: LeadTurnEvidence,
	): LeadTurnObservation | undefined {
		this.assertCurrent(target);
		const record = this.load();
		if (!record?.receipt || !same(record.target, target))
			throw new Error("runtime_config_generation_stale");
		const observation: LeadTurnObservation = {
			target: { ...target },
			evidence: { ...evidence },
			source:
				!record.drifted &&
				evidence.model === target.model &&
				evidence.effort === target.effort
					? "registry_hot"
					: "external_session_settings",
			observedAt: new Date().toISOString(),
		};
		if (
			!validLeadTurnObservation(observation, target) ||
			Date.parse(evidence.recordedAt) < Date.parse(record.receipt.appliedAt) ||
			Date.parse(evidence.recordedAt) > Date.parse(observation.observedAt)
		)
			return;
		if (
			record.observation?.evidence.turnId === evidence.turnId &&
			record.observation.evidence.recordDigest === evidence.recordDigest
		)
			return;
		if (
			record.observation &&
			Date.parse(record.observation.evidence.recordedAt) >
				Date.parse(evidence.recordedAt)
		)
			return;
		this.save({
			...record,
			observation,
			...(observation.source === "external_session_settings"
				? { drifted: true as const }
				: {}),
		});
		return observation;
	}
	async beforeTurn(): Promise<LeadTurnConfigAdmission | undefined> {
		try {
			const record = this.load();
			if (!record) return undefined;
			const identity = this.deps.identity();
			if (
				["carrierId", "ownerEpoch", "runtimeGeneration", "threadId"].some(
					(key) =>
						record.target[key as keyof LeadRuntimeConfigTarget] !==
						identity[key as keyof LeadRuntimeConfigIdentity],
				)
			) {
				this.deps.onAdmissionFailure?.("runtime_config_identity_changed");
				return {};
			}
			this.assertCurrent(record.target);
			if (!record.drifted) {
				if (record.receipt) await this.coordinator.readCurrent(record.target);
				else {
					const applied = await this.coordinator.apply(record.target);
					if (applied.status === "pending_runtime")
						throw new Error("runtime_config_pending");
				}
			}
			this.assertCurrent(record.target);
			const current = this.load();
			if (!current || !same(current.target, record.target))
				throw new Error("runtime_config_generation_stale");
			const token = canonicalSubmissionDigest(current);
			return {
				...(current.drifted
					? {}
					: { model: record.target.model, effort: record.target.effort }),
				assertCurrent: () => {
					try {
						this.assertCurrent(record.target);
						if (canonicalSubmissionDigest(this.load()) !== token)
							throw new Error("runtime_config_admission_changed");
						return true;
					} catch (error) {
						this.admissionFailure(error);
						return false;
					}
				},
			};
		} catch (error) {
			return this.admissionFailure(error);
		}
	}

	close(): void {
		this.closed = true;
		this.coordinator.close();
	}
}
