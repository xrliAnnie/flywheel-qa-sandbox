import { randomUUID } from "node:crypto";
import { canonicalSubmissionDigest } from "flywheel-config";
import { CodexLeadInboxRejectedError } from "../lead-backends/codex/CodexLeadInboxSocket.js";
import type {
	LeadRuntimeConfigIdentity,
	LeadRuntimeConfigResult,
	LeadRuntimeConfigTarget,
} from "../lead-backends/codex/LeadRuntimeConfigCoordinator.js";
import {
	type LeadRuntimeReadback,
	validLeadTurnObservation,
} from "../lead-backends/codex/lead-turn-evidence.js";
import type {
	LeadConfigRegistryIntent,
	LeadConfigRegistryWriter,
} from "../lead-config-registry.js";
import type { LeadConfigOperation, StateStore } from "../StateStore.js";
import type { ConfirmTokenStore } from "./fleet-admin.js";

/** Secret-free view; applied/observed are timestamped historical evidence, not current health. */
export interface LeadConfigView {
	operationId: string;
	configGeneration: number;
	effectiveStatus: string;
	checkedAt: string;
	requested: { model: string; effort: string };
	actual?: { model: string; effort: string };
	applied?: {
		model: string;
		effort: string;
		appliedAt: string;
		threadId: string;
	};
	observed?: {
		model: string;
		effort: string;
		turnId: string;
		observedAt: string;
		source: string;
	};
}
export interface LeadConfigRuntimeLease extends LeadRuntimeConfigIdentity {
	capabilities: string[];
	online: boolean;
}

export interface LeadConfigStaged {
	canonical: {
		intent: LeadConfigRegistryIntent;
		lease: LeadConfigRuntimeLease;
	};
	requestDigest: string;
	confirmToken: string;
}
export class LeadConfigError extends Error {
	constructor(
		readonly code: string,
		readonly status = 409,
	) {
		super(code);
	}
}
function fail(code: string, status = 409): never {
	throw new LeadConfigError(code, status);
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		fail("invalid_request", 400);
	return value as Record<string, unknown>;
}
function keys(raw: Record<string, unknown>, allowed: string[]) {
	if (Object.keys(raw).some((key) => !allowed.includes(key)))
		fail("unknown_field", 400);
}
function text(value: unknown, max = 1000): string {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value.length > max ||
		Array.from(value).some(
			(c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
		)
	)
		fail("invalid_text", 400);
	return value;
}
function operationId(value: unknown) {
	const id = text(value, 36);
	if (
		!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)
	)
		fail("invalid_operation_id", 400);
	return id;
}
function leaseKey(lease: LeadConfigRuntimeLease) {
	const { online: _online, ...identity } = lease;
	return canonicalSubmissionDigest(identity);
}
function runtimeDiagnostic(error: unknown): string {
	if (error instanceof LeadConfigError) return error.code;
	if (
		error instanceof CodexLeadInboxRejectedError &&
		/^(?:runtime_config_[a-z0-9_]+|runtime_hot_config_unsupported|context_window_incompatible)$/.test(
			error.reason,
		)
	)
		return error.reason;
	return "runtime_apply_unavailable";
}

/** Routes must authenticate before stage/apply/status, including receipt replay. */
export class LeadConfigService {
	private readonly committing = new Map<string, number>();
	private readonly flights = new Map<
		string,
		Promise<Awaited<ReturnType<LeadConfigService["status"]>>>
	>();
	constructor(
		private readonly deps: {
			store: StateStore;
			writer: Pick<
				LeadConfigRegistryWriter,
				"plan" | "commit" | "recover" | "assertCurrent"
			> &
				Partial<
					Pick<LeadConfigRegistryWriter, "externalCandidates" | "adoptExternal">
				>;
			tokens: Pick<ConfirmTokenStore, "issue" | "verifyAndConsume" | "prune">;
			runtimeBuildSha: string;
			runtime: {
				preflight: (
					intent: LeadConfigRegistryIntent,
				) => Promise<LeadConfigRuntimeLease>;
				apply: (
					target: LeadRuntimeConfigTarget,
				) => Promise<LeadRuntimeConfigResult>;
				read: (target: LeadRuntimeConfigTarget) => Promise<LeadRuntimeReadback>;
			};
		},
	) {}
	private async admit(intent: LeadConfigRegistryIntent) {
		const lease = await this.deps.runtime.preflight(intent);
		if (
			!lease.capabilities.includes("lead_runtime_config_v1") ||
			!lease.capabilities.includes("registry_tuning_v1") ||
			!/^[a-f0-9]{40}$/i.test(lease.artifactBuildSha) ||
			lease.artifactBuildSha !== lease.bootstrapBuildSha ||
			lease.artifactBuildSha !== this.deps.runtimeBuildSha
		)
			fail("runtime_hot_config_unsupported");
		if (
			lease.projectName !== intent.projectName ||
			lease.leadKey !== intent.leadKey ||
			lease.identityDigest !== intent.identityDigest ||
			!lease.carrierId ||
			!lease.ownerEpoch ||
			!lease.runtimeGeneration ||
			!lease.threadId
		)
			fail("runtime_identity_changed");
		return lease;
	}
	async stage(input: unknown): Promise<LeadConfigStaged> {
		const raw = object(input);
		keys(raw, [
			"operationId",
			"projectName",
			"leadId",
			"reason",
			"model",
			"effort",
			"rollbackOperationId",
		]);
		const id =
			raw.operationId === undefined
				? randomUUID()
				: operationId(raw.operationId);
		const reason = text(raw.reason);
		let intent: LeadConfigRegistryIntent;
		if (raw.rollbackOperationId !== undefined) {
			if (
				raw.model !== undefined ||
				raw.effort !== undefined ||
				raw.projectName !== undefined ||
				raw.leadId !== undefined
			)
				fail("rollback_fields_conflict", 400);
			const old = this.deps.store.getLeadConfigOperation(
				operationId(raw.rollbackOperationId),
			);
			if (!old || ["prepared", "conflict"].includes(old.status))
				fail("rollback_operation_unavailable");
			const original = old.input as LeadConfigRegistryIntent;
			this.deps.writer.assertCurrent(original);
			intent = this.deps.writer.plan({
				operationId: id,
				reason,
				projectName: original.projectName,
				leadId: original.leadId,
				restore: original.preimage,
			});
		} else {
			const patch = {
				...(raw.model === undefined ? {} : { model: raw.model }),
				...(raw.effort === undefined ? {} : { effort: raw.effort }),
			};
			intent = this.deps.writer.plan({
				operationId: id,
				reason,
				projectName: text(raw.projectName, 128),
				leadId: text(raw.leadId, 128),
				patch,
			});
		}
		const lease = await this.admit(intent);
		const canonical = { intent, lease };
		const requestDigest = canonicalSubmissionDigest(canonical);
		this.deps.tokens.prune();
		return {
			canonical,
			requestDigest,
			confirmToken: this.deps.tokens.issue(requestDigest),
		};
	}
	async apply(input: unknown) {
		const raw = object(input);
		keys(raw, ["canonical", "requestDigest", "confirmToken"]);
		const canonical = object(raw.canonical);
		keys(canonical, ["intent", "lease"]);
		const intent = object(
			canonical.intent,
		) as unknown as LeadConfigRegistryIntent;
		operationId(intent.operationId);
		if (canonicalSubmissionDigest(canonical) !== raw.requestDigest)
			fail("request_digest_mismatch", 400);
		const { requestDigest, ...body } = intent;
		if (requestDigest !== canonicalSubmissionDigest(body))
			fail("intent_digest_mismatch", 400);
		const prior = this.deps.store.getLeadConfigOperation(intent.operationId);
		if (prior && prior.input.requestDigest !== intent.requestDigest)
			fail("operation_id_conflict");
		if (!prior || prior.status === "prepared") {
			const token = text(raw.confirmToken, 128);
			if (
				!this.deps.tokens.verifyAndConsume(token, String(raw.requestDigest)).ok
			)
				fail("confirmation_rejected", 403);
			const lease = await this.admit(intent);
			if (
				leaseKey(lease) !== leaseKey(canonical.lease as LeadConfigRuntimeLease)
			)
				fail("runtime_identity_changed");
			this.committing.set(
				intent.operationId,
				(this.committing.get(intent.operationId) ?? 0) + 1,
			);
			try {
				await this.deps.writer.commit(intent);
			} finally {
				const count = (this.committing.get(intent.operationId) ?? 1) - 1;
				if (count === 0) this.committing.delete(intent.operationId);
				else this.committing.set(intent.operationId, count);
			}
		}
		this.supersedeOlder(intent.leadKey);
		return this.push(intent.operationId);
	}
	private latest(leadKey: string) {
		return this.deps.store
			.listLeadConfigOperations(leadKey)
			.filter((op) => op.status !== "prepared" && op.status !== "conflict")
			.at(-1);
	}
	private supersedeOlder(leadKey: string) {
		const latest = this.latest(leadKey);
		if (!latest) return;
		for (const op of this.deps.store.listLeadConfigOperations(leadKey))
			if (
				op.configGeneration < latest.configGeneration &&
				[
					"registry_committed",
					"pending_runtime",
					"applied",
					"observed",
				].includes(op.status)
			)
				this.deps.store.transitionLeadConfigOperation(
					op.input.operationId,
					op.status,
					"superseded",
					{ supersededBy: latest.input.operationId },
				);
	}
	private target(
		op: LeadConfigOperation,
		lease: LeadConfigRuntimeLease,
	): LeadRuntimeConfigTarget {
		const intent = op.input as LeadConfigRegistryIntent;
		return {
			projectName: intent.projectName,
			leadKey: intent.leadKey,
			identityDigest: intent.identityDigest,
			carrierId: lease.carrierId,
			ownerEpoch: lease.ownerEpoch,
			runtimeGeneration: lease.runtimeGeneration,
			threadId: lease.threadId,
			operationId: intent.operationId,
			configDigest: intent.configDigest,
			configGeneration: op.configGeneration,
			modelRegistryRevision: intent.modelRegistryRevision,
			model: intent.resolved.model,
			effort: intent.resolved.effort,
		};
	}
	async push(id: string) {
		const flight = this.flights.get(id);
		if (flight) return flight;
		const task = this.pushOnce(id);
		this.flights.set(id, task);
		try {
			return await task;
		} finally {
			if (this.flights.get(id) === task) this.flights.delete(id);
		}
	}
	private hasDriftBarrier(id: string): boolean {
		return this.deps.store
			.listLeadConfigAudit(id)
			.some(
				(row) =>
					JSON.parse(row.detail).diagnostic === "external_session_settings",
			);
	}
	private async pushOnce(id: string) {
		let op = this.deps.store.getLeadConfigOperation(operationId(id));
		if (!op) fail("operation_not_found", 404);
		if (this.hasDriftBarrier(id)) return this.status(id);
		if (!["registry_committed", "pending_runtime"].includes(op.status))
			return this.status(id);
		if (this.latest(op.input.leadKey)?.input.operationId !== id) {
			this.supersedeOlder(op.input.leadKey);
			return this.status(id);
		}
		if (op.status === "registry_committed")
			op = this.deps.store.transitionLeadConfigOperation(
				id,
				"registry_committed",
				"pending_runtime",
				{},
			);
		try {
			const intent = op.input as LeadConfigRegistryIntent;
			this.deps.writer.assertCurrent(intent);
			const lease = await this.admit(intent);
			this.deps.writer.assertCurrent(intent);
			if (this.latest(intent.leadKey)?.input.operationId !== id)
				return this.status(id);
			if (!lease.online) return this.status(id);
			const target = this.target(op, lease);
			const receipt = await this.deps.runtime.apply(target);
			const fresh = await this.admit(intent);
			this.deps.writer.assertCurrent(intent);
			if (
				leaseKey(fresh) !== leaseKey(lease) ||
				this.latest(intent.leadKey)?.input.operationId !== id
			)
				return this.status(id);
			if (receipt.status === "drifted")
				this.deps.store.recordLeadConfigDiagnostic(
					id,
					"external_session_settings",
				);
			if (receipt.status === "applied") {
				const { status: _status, appliedAt, readback, ...binding } = receipt;
				if (
					canonicalSubmissionDigest(binding) !==
						canonicalSubmissionDigest(target) ||
					!Number.isFinite(Date.parse(appliedAt)) ||
					(readback !== undefined &&
						(readback.source !== "native_readback" ||
							readback.model !== target.model ||
							readback.effort !== target.effort ||
							!Number.isFinite(Date.parse(readback.readAt))))
				)
					fail("runtime_receipt_mismatch");
				this.deps.store.transitionLeadConfigOperation(
					id,
					"pending_runtime",
					"applied",
					{ receipt },
				);
			}
		} catch (error) {
			this.deps.store.recordLeadConfigDiagnostic(id, runtimeDiagnostic(error));
		}
		return this.status(id);
	}
	async status(id: string) {
		const operation = this.deps.store.getLeadConfigOperation(operationId(id));
		if (!operation) fail("operation_not_found", 404);
		const result = (
			effectiveStatus: string,
			actual?: { model: string; effort: string },
		) => {
			const current = this.deps.store.getLeadConfigOperation(id)!;
			return {
				operation: current,
				effectiveStatus: ["prepared", "conflict", "superseded"].includes(
					current.status,
				)
					? current.status
					: effectiveStatus,
				...(actual ? { actual } : {}),
			};
		};
		if (["prepared", "conflict", "superseded"].includes(operation.status))
			return result(operation.status);
		try {
			const intent = operation.input as LeadConfigRegistryIntent;
			this.deps.writer.assertCurrent(intent);
			const lease = await this.admit(intent);
			this.deps.writer.assertCurrent(intent);
			if (!lease.online) return result("pending_runtime");
			if (operation.status !== "applied" && operation.status !== "observed")
				return result(this.hasDriftBarrier(id) ? "drifted" : "pending_runtime");
			const applied = this.deps.store
				.listLeadConfigAudit(id)
				.reverse()
				.find(
					(row) =>
						row.to_status === "applied" &&
						row.from_status === "pending_runtime",
				);
			const receipt = applied ? JSON.parse(applied.detail).receipt : undefined;
			if (
				!receipt ||
				receipt.carrierId !== lease.carrierId ||
				receipt.ownerEpoch !== lease.ownerEpoch ||
				receipt.runtimeGeneration !== lease.runtimeGeneration ||
				receipt.threadId !== lease.threadId
			)
				return result("pending_runtime");
			const actual = await this.deps.runtime.read(
				this.target(operation, lease),
			);
			this.deps.writer.assertCurrent(intent);
			const fresh = await this.admit(intent);
			if (leaseKey(fresh) !== leaseKey(lease)) return result("unavailable");
			if (
				actual.drifted ||
				actual.model !== intent.resolved.model ||
				actual.effort !== intent.resolved.effort
			)
				this.deps.store.recordLeadConfigDiagnostic(
					id,
					"external_session_settings",
				);
			const observation = actual.observation;
			if (
				!actual.drifted &&
				actual.model === intent.resolved.model &&
				actual.effort === intent.resolved.effort &&
				observation?.source === "registry_hot" &&
				validLeadTurnObservation(observation, this.target(operation, lease)) &&
				Date.parse(observation.evidence.recordedAt) >=
					Date.parse(receipt.appliedAt) &&
				Date.parse(observation.evidence.recordedAt) <=
					Date.parse(observation.observedAt) &&
				this.deps.store.getLeadConfigOperation(id)?.status === "applied"
			) {
				this.deps.store.transitionLeadConfigOperation(
					id,
					"applied",
					"observed",
					{ observation },
				);
			}
			return result(
				!actual.drifted &&
					actual.model === intent.resolved.model &&
					actual.effort === intent.resolved.effort
					? this.deps.store.getLeadConfigOperation(id)!.status
					: "drifted",
				actual,
			);
		} catch {
			return result("unavailable");
		}
	}
	async viewForLead(leadKey: string): Promise<LeadConfigView | undefined> {
		const latest = this.latest(leadKey);
		if (!latest) return undefined;
		const result = await this.status(latest.input.operationId);
		const intent = result.operation.input as LeadConfigRegistryIntent;
		const audits = this.deps.store
			.listLeadConfigAudit(intent.operationId)
			.reverse();
		const appliedRow = audits.find(
			(row) =>
				row.from_status === "pending_runtime" && row.to_status === "applied",
		);
		const applied = appliedRow
			? JSON.parse(appliedRow.detail).receipt
			: undefined;
		const observedRow = audits.find(
			(row) => row.from_status === "applied" && row.to_status === "observed",
		);
		const observed = observedRow
			? JSON.parse(observedRow.detail).observation
			: undefined;
		return {
			operationId: intent.operationId,
			configGeneration: result.operation.configGeneration,
			effectiveStatus: result.effectiveStatus,
			checkedAt: new Date().toISOString(),
			requested: { ...intent.resolved },
			...(result.actual
				? {
						actual: {
							model: result.actual.model,
							effort: result.actual.effort,
						},
					}
				: {}),
			...(applied
				? {
						applied: {
							model: applied.model,
							effort: applied.effort,
							appliedAt: applied.appliedAt,
							threadId: applied.threadId,
						},
					}
				: {}),
			...(observed
				? {
						observed: {
							model: observed.evidence.model,
							effort: observed.evidence.effort,
							turnId: observed.evidence.turnId,
							observedAt: observed.observedAt,
							source: observed.source,
						},
					}
				: {}),
		};
	}
	private async reconcileOwner(operation: LeadConfigOperation): Promise<void> {
		const id = operation.input.operationId;
		try {
			const intent = operation.input as LeadConfigRegistryIntent;
			this.deps.writer.assertCurrent(intent);
			const lease = await this.admit(intent);
			this.deps.writer.assertCurrent(intent);
			if (
				!lease.online ||
				this.latest(intent.leadKey)?.input.operationId !== id
			)
				return;
			const receiptRow = this.deps.store
				.listLeadConfigAudit(id)
				.reverse()
				.find(
					(row) =>
						row.from_status === "pending_runtime" &&
						row.to_status === "applied",
				);
			const receipt = receiptRow
				? JSON.parse(receiptRow.detail).receipt
				: undefined;
			if (
				receipt &&
				["carrierId", "ownerEpoch", "runtimeGeneration", "threadId"].every(
					(key) => receipt[key] === lease[key as keyof LeadConfigRuntimeLease],
				)
			)
				return;
			const current = this.deps.store.getLeadConfigOperation(id);
			if (
				!current ||
				(current.status !== "applied" && current.status !== "observed")
			)
				return;
			this.deps.store.transitionLeadConfigOperation(
				id,
				current.status,
				"pending_runtime",
				{
					reason: "runtime_owner_changed",
					carrierId: lease.carrierId,
					ownerEpoch: lease.ownerEpoch,
					runtimeGeneration: lease.runtimeGeneration,
					threadId: lease.threadId,
				},
			);
			await this.push(id);
		} catch {
			this.deps.store.recordLeadConfigDiagnostic(
				id,
				"runtime_rebind_unavailable",
			);
		}
	}
	async reconcile() {
		for (const operation of this.deps.store.listPendingLeadConfigOperations()) {
			if (this.committing.has(operation.input.operationId)) continue;
			try {
				if (operation.status === "prepared")
					await this.deps.writer.recover(operation.input.operationId);
				this.supersedeOlder(operation.input.leadKey);
				await this.push(operation.input.operationId);
			} catch {
				this.deps.store.recordLeadConfigDiagnostic(
					operation.input.operationId,
					"recovery_unavailable",
				);
			}
		}
		let externalFailed = false;
		if (this.deps.writer.externalCandidates && this.deps.writer.adoptExternal) {
			let candidates: LeadConfigRegistryIntent[] = [];
			try {
				candidates = this.deps.writer.externalCandidates();
			} catch {
				externalFailed = true;
			}
			for (const intent of candidates) {
				try {
					await this.admit(intent);
					const adopted = await this.deps.writer.adoptExternal(intent);
					this.supersedeOlder(intent.leadKey);
					await this.push(adopted.input.operationId);
				} catch {
					externalFailed = true;
					const prior = this.latest(intent.leadKey);
					if (prior)
						this.deps.store.recordLeadConfigDiagnostic(
							prior.input.operationId,
							"external_registry_unavailable",
						);
				}
			}
		}
		for (const operation of this.deps.store.listAppliedLeadConfigOperations()) {
			if (
				this.latest(operation.input.leadKey)?.input.operationId !==
				operation.input.operationId
			)
				continue;
			await this.reconcileOwner(operation);
			await this.status(operation.input.operationId);
		}
		if (externalFailed)
			throw new Error("external_registry_observation_unavailable");
	}
}
