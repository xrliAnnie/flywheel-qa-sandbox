import { createHash } from "node:crypto";
import {
	leadOperationRequestBytes,
	leadOperationTimeoutMs,
	MAX_LEAD_OPERATION_FRAME_BYTES,
} from "flywheel-comm/lead-operation-client";
import { z } from "zod";
import { getLeadCapability, type LeadCapabilityDefinition } from "./catalog.js";
import type { OperationReceipt, OperationReceiptStore } from "./receipts.js";

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
export interface LeadOperationContext {
	/** Validated envelope key for downstream durable delivery; never mint a new retry identity. */
	readonly requestId: string;
	readonly projectName: string;
	readonly leadId: string;
	readonly activationId: string;
	readonly deliveryContext?: string;
	readonly signal: AbortSignal;
	assertCurrent(): Promise<void>;
}
export interface HandlerOutcome {
	/** Only pinned terminal rejection codes are exposed by the broker. */
	errorCode?: string;
	status: "succeeded" | "rejected" | "unknown";
	providerRef?: string;
	data?: unknown;
}
export interface LeadOperationHandler {
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
		const handler = this.handlers.get(operation.handlerKey!);
		if (!handler) return reject("handler_unavailable");
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
		};
		let prepared = false,
			dispatched = false,
			finished = false,
			reconciling = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
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
				const prior = this.options.receipts.get(key);
				if (prior) {
					if (prior.inputDigest !== writeInput.inputDigest)
						throw new BrokerFailure("input_digest_conflict");
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
				const receipt = this.options.receipts.prepare({
					...writeInput,
					now: Date.now(),
				});
				if (receipt.disposition !== "prepared")
					return this.replay(receipt.receipt, request.requestId);
				prepared = true;
				await context.assertCurrent();
				this.options.receipts.transition({
					...writeInput,
					now: Date.now(),
					from: "prepared",
					to: "dispatched",
				});
				dispatched = true;
			}
			// No await between this guard resolving and invoking the trusted handler.
			await context.assertCurrent();
			const outcome = await handler.execute(input, context);
			await context.assertCurrent();
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
				this.options.receipts.transition({
					...writeInput,
					now: Date.now(),
					from: "dispatched",
					to,
					...(result.resourceRefs[0]
						? { providerRef: result.resourceRefs[0] }
						: {}),
					...(result.errorCode ? { errorCode: result.errorCode } : {}),
				});
			}
			finished = true;
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
				leadOperationTimeoutMs(request.operationId),
			);
			return await Promise.race([work(), canceled]);
		} catch (error) {
			const code =
				error instanceof BrokerFailure ? error.code : "provider_failure";
			if (prepared && !finished) {
				try {
					this.options.receipts.transition({
						...writeInput,
						now: Date.now(),
						from: dispatched ? "dispatched" : "prepared",
						to: dispatched ? "unknown" : "rejected",
						errorCode: code,
					});
				} catch {
					/* A concurrent trusted recovery may already have finalized the receipt. */
				}
			}
			return reject(code, dispatched || reconciling ? "unknown" : "rejected");
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
				: undefined);
		if (outcome.status === "unknown")
			return {
				requestId,
				status: "unknown",
				resourceRefs: [],
				errorCode: providerCode ?? "provider_unknown",
			};
		if (outcome.status === "rejected")
			return {
				requestId,
				status: "rejected",
				resourceRefs: [],
				errorCode: providerCode ?? "provider_rejected",
			};
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
