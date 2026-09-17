import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { XhsFrozenArtifactStore } from "./artifacts.js";
import {
	type AttachmentLimit,
	resolveAttachmentLimit,
} from "./attachment-probe.js";
import type { XhsAuthorityRegistry } from "./authority-registry.js";
import { canonical, contentDigest } from "./canonical.js";
import { deliverReview, type ReviewTransport } from "./cards.js";
import {
	type FrozenWrite,
	freezeWrite,
	WRITE_OPERATIONS,
} from "./contracts.js";
import type { ObserverPolicy } from "./observer.js";
import type { XhsWriteStore } from "./store.js";

const id = z.string().min(1).max(256);
const schema = z
	.object({
		projectId: id,
		leadId: id,
		activationId: id,
		prepareRequestId: id,
		accountSelector: id,
		operationId: z.enum(WRITE_OPERATIONS),
		payload: z.unknown(),
		artifactIds: z.array(id).max(18).default([]),
		targetHandle: id.nullable().default(null),
		supersedesProposalId: z.string().uuid().nullable().default(null),
	})
	.strict();
type Input = z.infer<typeof schema>;
type Options = {
	store: XhsWriteStore;
	registry: Pick<XhsAuthorityRegistry, "proveAccount">;
	artifacts: Pick<XhsFrozenArtifactStore, "read">;
	target: (
		policy: ObserverPolicy,
		handle: string,
		activationId: string,
	) => Promise<FrozenWrite["target"]>;
	transport: (policy: ObserverPolicy) => ReviewTransport;
	upstream: FrozenWrite["upstream"];
	attachmentLimit: AttachmentLimit;
	now?: () => number;
};
export type PreparedWrite = {
	proposalId: string;
	contentDigest: string;
	state: string;
	expiresAt: number;
	cardRef: { guildId: string; channelId: string; messageId: string } | null;
};
const errors = new Set([
	"prepare_conflict",
	"prepare_expired",
	"target_unbound",
	"artifact_unverified",
	"preview_delivery_failed",
	"preview_media_too_large",
	"write_scope_unavailable",
	"proposal_rate_limited",
	"supersede_denied",
]);

/** Authority-only preparation. IDs, account, media metadata, expiry and card
 * destination are derived here; the model supplies draft content and handles. */
export class XhsWritePreparation {
	private readonly active = new Map<
		string,
		{ input: string; result: Promise<PreparedWrite> }
	>();
	private readonly now: () => number;
	constructor(private readonly options: Options) {
		this.now = options.now ?? Date.now;
	}
	async prepare(
		peerUid: number,
		raw: unknown,
		signal?: AbortSignal,
	): Promise<PreparedWrite> {
		try {
			const input = schema.parse(raw);
			const serialized = canonical(input);
			const key = canonical([
				peerUid,
				input.projectId,
				input.leadId,
				input.prepareRequestId,
			]);
			const prior = this.active.get(key);
			if (prior) {
				if (prior.input !== serialized) throw Error("prepare_conflict");
				return await prior.result;
			}
			if (this.active.size >= 64) throw Error("proposal_rate_limited");
			const result = this.run(peerUid, input, signal);
			this.active.set(key, { input: serialized, result });
			try {
				return await result;
			} finally {
				this.active.delete(key);
			}
		} catch (error) {
			throw Error(
				error instanceof Error && errors.has(error.message)
					? error.message
					: "prepare_invalid",
			);
		}
	}
	private async run(
		peerUid: number,
		input: Input,
		signal?: AbortSignal,
	): Promise<PreparedWrite> {
		const policy = await this.options.registry.proveAccount(
			peerUid,
			{ projectId: input.projectId, leadId: input.leadId },
			signal,
		);
		if (signal?.aborted) throw Error();
		// A selector expresses intent; only the private provider establishes identity.
		if (input.accountSelector !== policy.accountUserId)
			throw Error("write_scope_unavailable");
		const store = this.options.store;
		const prior = store.preparedRequest(input.prepareRequestId, policy);
		const now = this.now(),
			expiresAt = prior?.expiresAt ?? now + 15 * 60000;
		const publish = [
			"xiaohongshu.publish_content",
			"xiaohongshu.publish_with_video",
		].includes(input.operationId);
		if (publish && input.targetHandle !== null) throw Error("target_unbound");
		const target =
			input.targetHandle === null
				? null
				: await this.options.target(
						policy,
						input.targetHandle,
						input.activationId,
					);
		if (!publish && target === null) throw Error("target_unbound");
		const media = input.artifactIds.map((artifactId) => {
			const item = store.artifact(artifactId, policy.projectId);
			if (!item) throw Error("artifact_unverified");
			return {
				artifactId: item.artifactId,
				sha256: item.sha256,
				sizeBytes: item.sizeBytes,
				mimeType: item.mimeType,
			};
		});
		const frozen = freezeWrite(
			{
				schemaVersion: 1,
				purpose: "xiaohongshu_founder_write",
				proposalId: prior?.frozen.proposalId ?? randomUUID(),
				requesterUid: policy.requesterUid,
				authorityPolicyVersion: policy.authorityPolicyVersion,
				projectId: policy.projectId,
				leadId: policy.leadId,
				account: {
					providerInstanceId: policy.providerInstanceId,
					accountUserId: policy.accountUserId,
					accountEpoch: policy.accountEpoch,
					providerGeneration: policy.providerGeneration,
				},
				operationId: input.operationId,
				target,
				payload: input.payload,
				media,
				upstream: this.options.upstream,
			},
			now,
		);
		if (
			prior &&
			(canonical(prior.frozen) !== canonical(frozen) ||
				prior.supersedesProposalId !== input.supersedesProposalId)
		)
			throw Error("prepare_conflict");
		const result = (): PreparedWrite => {
			const status = store.status(frozen.proposalId, policy);
			if (!status) throw Error();
			const review = store.review(frozen.proposalId);
			return {
				proposalId: frozen.proposalId,
				contentDigest: contentDigest(frozen),
				state: status.state,
				expiresAt,
				cardRef: review
					? {
							guildId: policy.guildId,
							channelId: policy.channelId,
							messageId: review.cardId,
						}
					: null,
			};
		};
		if (prior && prior.state !== "awaiting_delivery") return result();
		if (expiresAt <= this.now()) throw Error("prepare_expired");
		if (!prior)
			store.prepare(
				{
					frozen,
					prepareRequestId: input.prepareRequestId,
					expiresAt,
					...(input.supersedesProposalId
						? { supersedesProposalId: input.supersedesProposalId }
						: {}),
				},
				this.now(),
			);
		const bytes: Buffer[] = [];
		for (const artifact of frozen.media)
			bytes.push(await this.options.artifacts.read(policy.projectId, artifact));
		if (signal?.aborted) throw Error();
		await deliverReview(
			{
				frozen,
				expiresAt,
				now: this.now(),
				challenge: Array.from(
					randomBytes(8),
					(byte) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[byte & 31],
				).join(""),
				attachmentLimit: resolveAttachmentLimit(
					this.options.attachmentLimit,
					policy,
				),
				botId: policy.botId,
				channelId: policy.channelId,
				guildId: policy.guildId,
				media: bytes,
			},
			this.options.transport(policy),
			{
				delivered: (proposalId, card) => {
					if (signal?.aborted) throw Error();
					store.delivered(proposalId, card, this.now());
				},
			},
		);
		return result();
	}
}
