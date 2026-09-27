import { createHash } from "node:crypto";
import {
	leadOperationRequestBytes,
	leadOperationTimeoutMs,
	MAX_LEAD_OPERATION_FRAME_BYTES,
} from "flywheel-comm/lead-operation-client";
import { z } from "zod";
import { getLeadCapability, type LeadCapabilityDefinition } from "./catalog.js";
import type { OperationReceipt, OperationReceiptStore } from "./receipts.js";
import type { LeadTargetLockClient } from "./target-lock-client.js";
import {
	classifyVoiceCapabilityDenial,
	type VoiceCapabilityDenials,
} from "./voice-denial.js";
import type { VoiceRepeatWriteGate } from "./voice-repeat-gate.js";

export const OperationRequestSchema = z
	.object({
		schemaVersion: z.literal(1),
		operationId: z
			.string()
			.min(1)
			.max(256)
			.regex(/^[a-z][a-z0-9_.]+$/),
		requestId: z.string().uuid(),
		input: z.unknown(),
	})
	.strict();
export type OperationRequest = z.infer<typeof OperationRequestSchema>;
export interface OperationResult {
	requestId: string;
	status: "succeeded" | "rejected" | "pending" | "unknown";
	resourceRefs: string[];
	data?: unknown;
	errorCode?: string;
}
export type ProviderTerminalEvidence =
	| { status: "succeeded"; providerRef: string }
	| {
			status: "rejected";
			terminalEvidence: "provider_rejected" | "not_dispatched";
	  };
export interface LeadOperationContext {
	/** Validated envelope key for downstream durable delivery; never mint a new retry identity. */
	readonly requestId: string;
	readonly projectName: string;
	readonly leadId: string;
	readonly activationId: string;
	readonly deliveryContext?: string;
	readonly signal: AbortSignal;
	assertCurrent(): Promise<void>;
	/** Parent-only receipt settlement; never grants further provider or delivery authority. */
	recordTerminalEvidence?(proof: ProviderTerminalEvidence): Promise<void>;
}
export interface HandlerOutcome {
	/** Trusted adapter evidence only; generic errors/aborts/5xx are not terminal refusal. */
	terminalEvidence?: "not_dispatched" | "provider_rejected";
	/** Only pinned terminal rejection codes are exposed by the broker. */
	errorCode?: string;
	status: "succeeded" | "rejected" | "unknown";
	providerRef?: string;
	data?: unknown;
}
export interface LeadOperationHandler {
	/** Resolve provider aliases under the same authorization before fencing. */
	resolveTargetKey?(
		input: Record<string, unknown>,
		context: LeadOperationContext,
	): Promise<string>;
	authorize(
		input: Record<string, unknown>,
		context: LeadOperationContext,
	): Promise<void>;
	execute(
		input: Record<string, unknown>,
		context: LeadOperationContext,
	): Promise<HandlerOutcome>;
	/** Provider lookup only: no create/update/send or re-dispatch. Registered by trusted parent code. */
	reconcile?(
		receipt: Readonly<OperationReceipt>,
		input: Record<string, unknown>,
		context: LeadOperationContext,
	): Promise<HandlerOutcome>;
}
export interface LeadCapabilityBrokerOptions {
	/** Only the voice runtime installs classified denial reporting. */
	voiceDenials?: VoiceCapabilityDenials;
	projectName: string;
	leadId: string;
	activationId: string;
	receipts: OperationReceiptStore;
	allowedOperationIds(): ReadonlySet<string>;
	assertCurrent(operationId: string): Promise<void>;
	handlers: ReadonlyMap<string, LeadOperationHandler>;
	/** Parent-only credential values; never exposed to the handler context or protocol. */
	secrets: readonly string[];
	/** Snapshot a parent-owned active journal binding, not a request parameter. */
	deliveryContext?: () => { id: string; assertCurrent(): void } | undefined;
	/** Present for voice, and for resident activations participating in target fencing. */
	targetLocks?: LeadTargetLockClient;
	/** Voice parent only: the write-before repeat check of the FLY-2886 Lead ruling. */
	repeatGate?: Pick<VoiceRepeatWriteGate, "admit">;
}
class BrokerFailure extends Error {
	constructor(readonly code: string) {
		super(code);
	}
}
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.keys(value)
			.sort()
			.map(
				(key) =>
					`${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
			)
			.join(",")}}`;
	return JSON.stringify(value) ?? "null";
}
export function leadOperationInputDigest(input: unknown): string {
	return createHash("sha256").update(canonical(input)).digest("hex");
}
function containsSecret(value: unknown, secrets: readonly string[]): boolean {
	if (typeof value === "string")
		return secrets.some(
			(secret) => secret.length > 0 && value.includes(secret),
		);
	if (Array.isArray(value))
		return value.some((item) => containsSecret(item, secrets));
	if (value && typeof value === "object")
		return Object.entries(value).some(
			([key, item]) =>
				containsSecret(key, secrets) || containsSecret(item, secrets),
		);
	return false;
}
/** Transport-independent engine. No socket, credential export, dynamic handlers, or provider implementation. */
export class LeadCapabilityBroker {
	private closed = false;
	private readonly active = new Map<AbortController, Promise<void>>();
	private readonly handlers: ReadonlyMap<string, LeadOperationHandler>;
	private readonly secrets: readonly string[];
	constructor(private readonly options: LeadCapabilityBrokerOptions) {
		this.handlers = new Map(options.handlers);
		this.secrets = [...options.secrets];
	}
	/** Stop admission and settle receipts before the parent closes the shared journal. */
	async close(): Promise<void> {
		this.closed = true;
		const pending = [...this.active.values()];
		for (const controller of this.active.keys())
			controller.abort(new BrokerFailure("broker_closed"));
		await Promise.all(pending);
	}
	async execute(raw: unknown): Promise<OperationResult> {
		let request: OperationRequest;
		try {
			const json = typeof raw === "string" ? raw : JSON.stringify(raw);
			if (
				typeof json !== "string" ||
				Buffer.byteLength(json) > MAX_LEAD_OPERATION_FRAME_BYTES
			)
				throw new BrokerFailure("request_too_large");
			request = OperationRequestSchema.parse(JSON.parse(json));
			if (
				Buffer.byteLength(json) > leadOperationRequestBytes(request.operationId)
			)
				throw new BrokerFailure("request_too_large");
		} catch (error) {
			return {
				requestId: "",
				status: "rejected",
				resourceRefs: [],
				errorCode:
					error instanceof BrokerFailure ? error.code : "invalid_request",
			};
		}
		const reject = (
			code: string,
			status: OperationResult["status"] = "rejected",
		): OperationResult => ({
			requestId: request.requestId,
			status,
			resourceRefs: [],
			errorCode: code,
		});
		if (this.closed) return reject("broker_closed");
		if (this.options.voiceDenials) {
			const denial = await classifyVoiceCapabilityDenial(
				request,
				this.options.allowedOperationIds(),
				this.options.voiceDenials,
				() => this.options.assertCurrent(request.operationId),
			);
			if (denial) return denial;
		}
		const operation = getLeadCapability(request.operationId);
		if (!operation) return reject("unknown_operation");
		if (operation.classification === "reserved")
			return reject("reserved_operation");
		// Governance denial precedes provider hooks and historical success receipts.
		if (operation.unconditionalDenial)
			return reject(operation.unconditionalDenial);
		const parsed = operation.inputSchema.safeParse(request.input);
		if (!parsed.success) return reject("invalid_input");
		const input = parsed.data;
		let targetKey =
			operation.classification === "write" && operation.targetKey
				? `${this.options.projectName}:${operation.targetKey(input)}`
				: undefined;
		if (
			operation.classification === "write" &&
			this.options.targetLocks?.actor === "voice" &&
			!targetKey
		)
			return reject("unclassified_write");
		const handler = this.handlers.get(operation.handlerKey!);
		if (!handler) return reject("handler_unavailable");
		let targetLocks: LeadTargetLockClient | undefined;
		try {
			targetLocks =
				this.options.targetLocks?.participates?.() === false
					? undefined
					: this.options.targetLocks;
		} catch {
			return reject("activation_not_current");
		}
		let delivery: { id: string; assertCurrent(): void } | undefined;
		try {
			delivery = this.options.deliveryContext?.();
			if (
				this.options.deliveryContext &&
				request.operationId === "discord.thread.reply" &&
				!delivery
			)
				return reject("delivery_context_not_current");
			delivery?.assertCurrent();
		} catch {
			return reject("delivery_context_not_current");
		}
		const controller = new AbortController();
		let settled!: () => void;
		this.active.set(
			controller,
			new Promise<void>((resolve) => {
				settled = resolve;
			}),
		);
		const context: LeadOperationContext = {
			requestId: request.requestId,
			projectName: this.options.projectName,
			leadId: this.options.leadId,
			activationId: this.options.activationId,
			...(delivery ? { deliveryContext: delivery.id } : {}),
			signal: controller.signal,
			recordTerminalEvidence: (proof) => settleProviderEvidence(proof),
			assertCurrent: async () => {
				if (controller.signal.aborted)
					throw new BrokerFailure(
						this.closed ? "broker_closed" : "operation_timeout",
					);
				if (!this.options.allowedOperationIds().has(request.operationId))
					throw new BrokerFailure("capability_revoked");
				try {
					delivery?.assertCurrent();
					await this.options.assertCurrent(request.operationId);
					delivery?.assertCurrent();
				} catch {
					throw new BrokerFailure("activation_not_current");
				}
				if (controller.signal.aborted)
					throw new BrokerFailure(
						this.closed ? "broker_closed" : "operation_timeout",
					);
				if (!this.options.allowedOperationIds().has(request.operationId))
					throw new BrokerFailure("capability_revoked");
			},
		};
		const key = {
			projectName: context.projectName,
			leadId: context.leadId,
			operationId: request.operationId,
			requestId: request.requestId,
		};
		const writeInput = {
			...key,
			inputDigest: leadOperationInputDigest(input),
			activationId: context.activationId,
			...(targetKey ? { targetKey } : {}),
		};
		let prepared = false,
			dispatched = false,
			finished = false,
			reconciling = false;
		let providerInvoked = false;
		let terminalEvidenceRecorded = false;
		let targetFence: string | undefined,
			targetDispatched = false,
			targetReleased = false,
			waitingForTarget = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeoutMs = leadOperationTimeoutMs(request.operationId);
		const deadline = Date.now() + timeoutMs;
		const targetInput = () => ({
			operationId: request.operationId,
			requestId: request.requestId,
			targetKey: targetKey!,
		});
		// Late terminal proof after a timeout/abort settles the original receipt only
		// for fenced or voice-originated requests; resident paths keep the pre-voice
		// behavior (plan §2 rollback: disabled Leads' write path is unchanged).
		const settlesLateProof = () =>
			targetFence !== undefined ||
			this.options.activationId.startsWith("voice:");
		const settleProviderEvidence = async (proof: ProviderTerminalEvidence) => {
			if (!providerInvoked || !dispatched || terminalEvidenceRecorded) return;
			if (!settlesLateProof()) return;
			if (
				containsSecret(proof, this.secrets) ||
				(proof.status === "succeeded" &&
					!/^[A-Za-z0-9_.:-]{1,256}$/.test(proof.providerRef)) ||
				(proof.status === "rejected" &&
					!["provider_rejected", "not_dispatched"].includes(
						proof.terminalEvidence,
					))
			)
				throw new BrokerFailure("invalid_provider_output");
			try {
				const prior = this.options.receipts.get(key);
				if (prior?.state === "dispatched" || prior?.state === "unknown")
					this.options.receipts.transition({
						...writeInput,
						now: Date.now(),
						from: prior.state,
						to: proof.status,
						...(proof.status === "succeeded"
							? { providerRef: proof.providerRef }
							: { errorCode: "provider_rejected" }),
					});
			} catch (error) {
				if (!controller.signal.aborted && !this.closed) throw error;
			}
			terminalEvidenceRecorded = true;
			if (!targetFence || !targetLocks || targetReleased) return;
			try {
				await targetLocks.release({
					...targetInput(),
					fence: targetFence,
					outcome: proof.status,
					...(proof.status === "succeeded"
						? { providerRef: proof.providerRef }
						: {}),
					signal: AbortSignal.timeout(2000),
				});
				targetReleased = true;
			} catch {
				/* The durable success remains available to trusted reconciliation. */
			}
		};

		const associateDelivery = () => {
			if (!delivery || targetLocks?.actor !== "voice") return;
			this.options.receipts.associateDelivery({
				projectName: context.projectName,
				leadId: context.leadId,
				activationId: context.activationId,
				entryId: delivery.id,
				operationId: request.operationId,
				requestId: request.requestId,
				now: Date.now(),
			});
		};
		const work = async (): Promise<OperationResult> => {
			await context.assertCurrent();
			try {
				await handler.authorize(input, context);
			} catch (error) {
				if (error instanceof BrokerFailure) throw error;
				if (error instanceof Error && error.message === "pr_not_bound_to_lead")
					throw new BrokerFailure("pr_not_bound_to_lead");
				throw new BrokerFailure(
					operation.operationId === "terminal.input"
						? "terminal_scope_denied"
						: "target_not_authorized",
				);
			}
			await context.assertCurrent();
			if (operation.classification === "write") {
				if (handler.resolveTargetKey && targetLocks) {
					const normalized = await handler.resolveTargetKey(input, context);
					if (!/^[A-Za-z0-9_.:#/-]{1,400}$/.test(normalized))
						throw new BrokerFailure("target_not_authorized");
					await context.assertCurrent();
					targetKey = `${this.options.projectName}:${normalized}`;
					writeInput.targetKey = targetKey;
				}
				const prior = this.options.receipts.get(key);
				if (prior) {
					if (prior.inputDigest !== writeInput.inputDigest)
						throw new BrokerFailure("input_digest_conflict");
					associateDelivery();
					if (prior.state === "unknown" && handler.reconcile) {
						reconciling = true;
						await context.assertCurrent();
						const reconciled = await handler.reconcile(
							Object.freeze({ ...prior }),
							input,
							context,
						);
						await context.assertCurrent();
						const result = this.validateOutcome(
							operation,
							reconciled,
							request.requestId,
							true,
							operation.githubTier === "B",
						);
						// Cross-activation replay is reconciliation only; never mutate or re-dispatch the old receipt.
						if (
							prior.activationId === context.activationId &&
							result.status === "succeeded"
						)
							this.options.receipts.transition({
								...writeInput,
								now: Date.now(),
								from: "unknown",
								to: "succeeded",
								providerRef: result.resourceRefs[0]!,
							});
						return result;
					}
					return this.replay(prior, request.requestId);
				}
				let dedupeDigest: string | undefined;
				if (this.options.repeatGate && targetKey) {
					// A new requestId only: same-requestId retries replay above.
					const decision = this.options.repeatGate.admit({
						operationId: request.operationId,
						requestId: request.requestId,
						targetKey,
						input,
						...(delivery ? { deliveryId: delivery.id } : {}),
					});
					if (decision.kind === "duplicate")
						return containsSecret(decision.result, this.secrets)
							? reject("duplicate_recent_write")
							: decision.result;
					dedupeDigest = decision.fingerprint;
				}
				const receipt = this.options.receipts.prepare({
					...writeInput,
					...(dedupeDigest ? { dedupeDigest } : {}),
					now: Date.now(),
				});
				associateDelivery();
				if (receipt.disposition !== "prepared")
					return this.replay(receipt.receipt, request.requestId);
				prepared = true;
				if (targetKey && targetLocks) {
					for (;;) {
						await context.assertCurrent();
						const lock = await targetLocks.acquire({
							...targetInput(),
							deadline,
							signal: context.signal,
						});
						if (
							lock.status === "unguarded" &&
							targetLocks.actor === "resident"
						) {
							waitingForTarget = false;
							break;
						}
						if (lock.status === "acquired") {
							targetFence = lock.fence;
							waitingForTarget = false;
							break;
						}
						if (lock.status !== "waiting") throw new BrokerFailure(lock.status);
						waitingForTarget = true;
						await new Promise<void>((resolve, rejectDelay) => {
							const abort = () => {
								clearTimeout(delay);
								rejectDelay(new BrokerFailure("operation_timeout"));
							};
							const delay = setTimeout(() => {
								context.signal.removeEventListener("abort", abort);
								resolve();
							}, 100);
							context.signal.addEventListener("abort", abort, { once: true });
						});
					}
				}
				await context.assertCurrent();
				this.options.receipts.transition({
					...writeInput,
					now: Date.now(),
					from: "prepared",
					to: "dispatched",
				});
				dispatched = true;
				if (targetFence && targetLocks) {
					const marked = await targetLocks.markDispatched({
						...targetInput(),
						fence: targetFence,
						signal: context.signal,
					});
					if (!marked) throw new BrokerFailure("target_lock_lost");
					targetDispatched = true;
				}
			}
			// No await between this guard resolving and invoking the trusted handler.
			await context.assertCurrent();
			// A concurrent close/timeout that aborted after the guard resolved must
			// not reach the provider: the catch may already have settled not_dispatched.
			if (controller.signal.aborted)
				throw new BrokerFailure(
					this.closed ? "broker_closed" : "operation_timeout",
				);
			providerInvoked = true;
			const outcome = await handler.execute(input, context);
			// Terminal provider evidence remains valid after the caller times out.
			// Settle only the original receipt/fence before checking delivery authority.
			const result = this.validateOutcome(
				operation,
				outcome,
				request.requestId,
				operation.classification === "write",
			);
			if (dispatched) {
				const to =
					result.status === "succeeded"
						? "succeeded"
						: result.status === "rejected"
							? "rejected"
							: "unknown";
				try {
					const prior = this.options.receipts.get(key);
					if (
						prior?.state === "dispatched" ||
						(prior?.state === "unknown" &&
							to !== "unknown" &&
							settlesLateProof())
					)
						this.options.receipts.transition({
							...writeInput,
							now: Date.now(),
							from: prior.state,
							to,
							...(result.resourceRefs[0]
								? { providerRef: result.resourceRefs[0] }
								: {}),
							...(result.errorCode ? { errorCode: result.errorCode } : {}),
						});
				} catch (error) {
					// Parent shutdown may have closed its journal; the Bridge fence can
					// still accept terminal proof, without re-opening operation admission.
					if (!controller.signal.aborted && !this.closed) throw error;
				}
				if (targetFence && targetLocks && !targetReleased) {
					await targetLocks.release({
						...targetInput(),
						fence: targetFence,
						outcome:
							result.status === "succeeded"
								? "succeeded"
								: result.status === "rejected"
									? "rejected"
									: "unknown",
						...(result.errorCode ? { reason: result.errorCode } : {}),
						...(result.resourceRefs[0]
							? { providerRef: result.resourceRefs[0] }
							: {}),
						signal: AbortSignal.timeout(2000),
					});
					targetReleased = true;
				}
			}
			finished = true;
			await context.assertCurrent();
			return result;
		};
		let onAbort = () => {};
		const canceled = new Promise<never>((_resolve, rejectAbort) => {
			onAbort = () =>
				rejectAbort(
					controller.signal.reason instanceof BrokerFailure
						? controller.signal.reason
						: new BrokerFailure("operation_timeout"),
				);
			controller.signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			timer = setTimeout(
				() => controller.abort(new BrokerFailure("operation_timeout")),
				timeoutMs,
			);
			return await Promise.race([work(), canceled]);
		} catch (error) {
			const code =
				error instanceof BrokerFailure ? error.code : "provider_failure";
			// Provably never sent: marked/dispatched, but the provider was not invoked.
			const neverSent = dispatched && !providerInvoked && settlesLateProof();
			if (prepared && !finished) {
				try {
					this.options.receipts.transition({
						...writeInput,
						now: Date.now(),
						from: dispatched ? "dispatched" : "prepared",
						to: dispatched && !neverSent ? "unknown" : "rejected",
						errorCode: code,
					});
				} catch {
					/* A concurrent trusted recovery may already have finalized the receipt. */
				}
			}
			if (targetKey && targetLocks && !targetReleased) {
				const cleanupSignal = controller.signal.aborted
					? AbortSignal.timeout(2000)
					: controller.signal;
				try {
					if (targetFence)
						await targetLocks.release({
							...targetInput(),
							fence: targetFence,
							outcome: !targetDispatched
								? "not_dispatched"
								: neverSent
									? "never_invoked"
									: "unknown",
							reason: code,
							signal: cleanupSignal,
						});
					else if (waitingForTarget)
						await targetLocks.cancel({
							...targetInput(),
							signal: cleanupSignal,
						});
				} catch {
					/* Bridge deadline recovery preserves dispatched uncertainty. */
				}
			}
			return reject(
				code,
				(dispatched && !neverSent) || reconciling ? "unknown" : "rejected",
			);
		} finally {
			if (timer) clearTimeout(timer);
			controller.signal.removeEventListener("abort", onAbort);
			controller.abort();
			this.active.delete(controller);
			settled();
		}
	}
	private replay(
		receipt: OperationReceipt,
		requestId: string,
	): OperationResult {
		if (containsSecret(receipt.providerRef, this.secrets))
			return {
				requestId,
				status: "unknown",
				resourceRefs: [],
				errorCode: "unsafe_provider_output",
			};
		return {
			requestId,
			status:
				receipt.state === "prepared" || receipt.state === "dispatched"
					? "pending"
					: receipt.state,
			resourceRefs: receipt.providerRef ? [receipt.providerRef] : [],
			...(receipt.errorCode ? { errorCode: receipt.errorCode } : {}),
		};
	}
	private validateOutcome(
		operation: LeadCapabilityDefinition,
		outcome: HandlerOutcome,
		requestId: string,
		write: boolean,
		receiptOnly = false,
	): OperationResult {
		if (containsSecret(outcome, this.secrets))
			throw new BrokerFailure("unsafe_provider_output");
		const serialized = JSON.stringify(outcome);
		if (Buffer.byteLength(serialized) > 262144)
			throw new BrokerFailure("output_too_large");
		const terminalCode =
			operation.operationId === "terminal.input" &&
			[
				"terminal_scope_denied",
				"terminal_not_running",
				"terminal_session_changed",
				"terminal_not_waiting",
				"terminal_input_invalid",
				"terminal_unavailable",
			].includes(outcome.errorCode ?? "")
				? outcome.errorCode
				: undefined;
		const providerCode =
			([
				"baseline_drift",
				"pr_not_bound_to_lead",
				"founder_write_gate_absent",
				"unclassified_write",
			].includes(outcome.errorCode ?? "")
				? outcome.errorCode
				: undefined) ??
			terminalCode ??
			(operation.operationId.startsWith("browser.") &&
			[
				"browser_unavailable",
				"browser_tool_denied",
				"browser_egress_denied",
				"browser_scope_denied",
			].includes(outcome.errorCode ?? "")
				? outcome.errorCode
				: undefined) ??
			(operation.operationId.startsWith("docs.") &&
			outcome.errorCode === "context7_scope_denied"
				? outcome.errorCode
				: undefined) ??
			(operation.operationId === "inbox.event.ack" &&
			outcome.errorCode === "inbox_event_ack_disabled"
				? outcome.errorCode
				: undefined) ??
			// FLY-2701: a voice start refused because it disagreed with an existing
			// booking is a trusted, named refusal that carries that booking's ref.
			(operation.operationId === "voice.session.start" &&
			outcome.errorCode === "voice_schedule_binding_conflict"
				? outcome.errorCode
				: undefined);
		if (outcome.status === "unknown")
			return {
				requestId,
				status: "unknown",
				resourceRefs: [],
				errorCode: providerCode ?? "provider_unknown",
			};
		if (outcome.status === "rejected") {
			// A refusal normally names nothing. The exception is a *trusted* code
			// that points at a resource the Lead should look at; that ref goes
			// through the same validation a successful one does.
			const rejectedRef =
				providerCode !== undefined &&
				outcome.providerRef !== undefined &&
				/^[a-zA-Z0-9_.:-]{1,256}$/.test(outcome.providerRef)
					? outcome.providerRef
					: undefined;
			return {
				requestId,
				status: "rejected",
				resourceRefs: rejectedRef ? [rejectedRef] : [],
				errorCode: providerCode ?? "provider_rejected",
			};
		}
		if (outcome.status !== "succeeded")
			throw new BrokerFailure("invalid_provider_output");
		if (
			outcome.providerRef !== undefined &&
			!/^[a-zA-Z0-9_.:-]{1,256}$/.test(outcome.providerRef)
		)
			throw new BrokerFailure("invalid_provider_ref");
		if (write && !outcome.providerRef)
			throw new BrokerFailure("invalid_provider_ref");
		// GitHub's receipt-only endpoint proves the recorded write by its reference.
		// Do not fabricate a DTO or permit dataless success on an initial dispatch.
		if (receiptOnly && outcome.data === undefined)
			return {
				requestId,
				status: "succeeded",
				resourceRefs: [outcome.providerRef!],
			};
		const data = operation.outputSchema.safeParse(outcome.data);
		if (!data.success) throw new BrokerFailure("invalid_provider_output");
		const result: OperationResult = {
			requestId,
			status: "succeeded",
			resourceRefs: outcome.providerRef ? [outcome.providerRef] : [],
			data: data.data,
		};
		if (Buffer.byteLength(JSON.stringify(result)) > 262144)
			throw new BrokerFailure("output_too_large");
		return result;
	}
}
