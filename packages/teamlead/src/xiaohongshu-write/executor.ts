import { z } from "zod";
import { canonical } from "./canonical.js";
import {
	type FrozenArtifact,
	type FrozenWrite,
	WRITE_OPERATIONS,
} from "./contracts.js";
import { signDispatchPermit } from "./permit.js";
import type { ProviderDispatchScope } from "./provider-authority.js";
import type { XhsProviderClient } from "./provider-client.js";
import type { XhsWriteStore } from "./store.js";

const requestSchema = z
	.object({
		proposalId: z.string().uuid(),
		receiptId: z.string().uuid(),
		operationId: z.enum(WRITE_OPERATIONS),
		contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
		executeRequestId: z.string().min(1).max(256),
	})
	.strict();
export type ExecuteWriteRequest = z.infer<typeof requestSchema>;
export type ExecuteWriteResult =
	| { kind: "denied"; code: string }
	| { kind: "attempt"; attemptId: string; state: string };
type Options = {
	store: XhsWriteStore;
	provider: Pick<XhsProviderClient, "prepare" | "commit">;
	/** Root registry/current requester routing adapter, never an ingress-supplied identity. */
	scope: (proposalId: string) => Promise<ProviderDispatchScope | null>;
	media: (
		frozen: FrozenWrite,
		artifact: FrozenArtifact,
		signal: AbortSignal,
	) => AsyncIterable<Uint8Array>;
	key: Buffer;
	now?: () => number;
};
const denialCodes = new Set([
	"founder_receipt_invalid",
	"founder_content_digest_mismatch",
	"founder_receipt_revoked",
	"founder_receipt_expired",
	"write_gate_closed",
	"write_scope_changed",
	"private_provider_unavailable",
]);

/** Sole authority coordinator for a write attempt. Only the store can supply
 * receipt authority; provider prepare has no dispatch permit and performs no
 * external mutation. Every path after claim preserves the consumed tombstone. */
export class XhsWriteExecutor {
	readonly #key: Buffer;
	private readonly now: () => number;
	constructor(private readonly options: Options) {
		if (!Buffer.isBuffer(options.key) || options.key.length !== 32)
			throw Error("write_executor_unavailable");
		this.#key = Buffer.from(options.key);
		this.now = options.now ?? Date.now;
	}
	async execute(
		input: unknown,
		signal?: AbortSignal,
	): Promise<ExecuteWriteResult> {
		let attemptId: string | null = null;
		try {
			const request = requestSchema.parse(input);
			const scope = structuredClone(
				await this.options.scope(request.proposalId),
			);
			if (!scope || signal?.aborted) throw Error("write_scope_changed");
			const store = this.options.store;
			const read = () => {
				const record = store.executionRecord(
					request.proposalId,
					request.contentDigest,
					scope.identity,
					this.now,
				);
				if (
					record.receiptId !== request.receiptId ||
					record.frozen.operationId !== request.operationId
				)
					throw Error("founder_receipt_invalid");
				return record;
			};
			const record = read();
			if (record.attempt)
				return {
					kind: "attempt",
					attemptId: record.attempt.attemptId,
					state: record.attempt.state,
				};
			const frozen = structuredClone(record.frozen);
			const lease = await this.options.provider.prepare(
				frozen,
				(artifact, cancelled) =>
					this.options.media(structuredClone(frozen), artifact, cancelled),
				signal,
			);
			const current = await this.options.scope(request.proposalId);
			if (
				!current ||
				canonical(scope) !== canonical(current) ||
				signal?.aborted
			)
				throw Error("write_scope_changed");
			const latest = read();
			if (latest.attempt)
				return {
					kind: "attempt",
					attemptId: latest.attempt.attemptId,
					state: latest.attempt.state,
				};
			if (
				lease.contentDigest !== request.contentDigest ||
				lease.accountUserId !== scope.identity.accountUserId ||
				lease.accountEpoch !== scope.identity.accountEpoch ||
				lease.providerGeneration !== scope.identity.providerGeneration ||
				lease.leaseExpiresAt <= this.now()
			)
				throw Error("private_provider_unavailable");
			const claim = store.claim(
				{
					proposalId: request.proposalId,
					contentDigest: request.contentDigest,
					executeRequestId: request.executeRequestId,
					receiptId: request.receiptId,
					leaseId: lease.leaseId,
					activationId: scope.activationId,
					identity: scope.identity,
				},
				this.now,
			);
			if (claim.kind === "denied") return claim;
			if (claim.kind === "existing")
				return {
					kind: "attempt",
					attemptId: claim.attemptId,
					state: claim.state,
				};
			attemptId = claim.attemptId;
			if (signal?.aborted) throw Error();
			const signed = signDispatchPermit(
				{
					audience: scope.identity.providerInstanceId,
					proposalId: request.proposalId,
					receiptId: latest.receiptId,
					attemptId,
					contentDigest: request.contentDigest,
					accountUserId: scope.identity.accountUserId,
					accountEpoch: scope.identity.accountEpoch,
					providerGeneration: scope.identity.providerGeneration,
					leaseId: lease.leaseId,
					keyId: scope.keyId,
					approvalExpiresAt: latest.approvalExpiresAt,
					leaseExpiresAt: lease.leaseExpiresAt,
				},
				this.#key,
				this.now(),
			);
			const result = await this.options.provider.commit(
				lease.leaseId,
				signed,
				signal,
			);
			const state = result === "denied" ? "failed" : result;
			store.finish(attemptId, state, this.now());
			return {
				kind: "attempt",
				attemptId,
				state:
					store.status(request.proposalId, scope.identity)?.attempt?.state ??
					"unknown",
			};
		} catch (error) {
			if (attemptId) {
				try {
					this.options.store.finish(attemptId, "unknown", this.now());
				} catch {
					/* A claimed receipt is never reopened after a persistence failure. */
				}
				return { kind: "attempt", attemptId, state: "unknown" };
			}
			return {
				kind: "denied",
				code:
					error instanceof Error && denialCodes.has(error.message)
						? error.message
						: "write_executor_unavailable",
			};
		}
	}
}
