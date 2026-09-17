import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentDigest } from "../canonical.js";
import { freezeWrite } from "../contracts.js";
import { XhsWriteStore } from "../store.js";

export const NOW = Date.parse("2026-09-14T20:00:00Z");
export function fixture(requesterUid = 501) {
	const dir = mkdtempSync(join(tmpdir(), "xhs-store-"));
	const path = join(dir, "ledger.db");
	let store = new XhsWriteStore(path, {
		initialize: true,
		providerGeneration: "generation-a",
	});
	store.setDispatchEnabled(true, NOW);
	const frozen = freezeWrite(
		{
			schemaVersion: 1,
			purpose: "xiaohongshu_founder_write",
			proposalId: randomUUID(),
			requesterUid,
			authorityPolicyVersion: 1,
			projectId: "project-a",
			leadId: "lead-a",
			operationId: "xiaohongshu.like_feed",
			account: {
				providerInstanceId: "provider-a",
				accountUserId: "account-a",
				accountEpoch: 1,
				providerGeneration: "generation-a",
			},
			target: { feedId: "feed-a", commentId: null, userId: null },
			payload: {},
			media: [],
			upstream: {
				binarySha256: "a".repeat(64),
				toolSchemaDigest: "b".repeat(64),
				guardProtocol: 1,
			},
		},
		NOW,
	);
	const digest = contentDigest(frozen);
	const receiptId = randomUUID();
	const identity = {
		requesterUid,
		projectId: "project-a",
		leadId: "lead-a",
		authorityPolicyVersion: 1,
		founderConfigVersion: 1,
		...frozen.account,
	};
	const decision = {
		receiptId,
		proposalId: frozen.proposalId,
		contentDigest: digest,
		purpose: "xiaohongshu_founder_write" as const,
		decision: "approved" as const,
		founderId: "founder-a",
		founderConfigVersion: 1,
		founderMessageId: "message-a",
		guildId: "guild-a",
		channelId: "channel-a",
		cardId: "card-a",
		messageDigest: "c".repeat(64),
		messageCreatedAt: NOW + 1000,
		observedAt: NOW + 2000,
		expiresAt: NOW + 300000,
	};
	const request = {
		proposalId: frozen.proposalId,
		receiptId,
		contentDigest: digest,
		activationId: "activation-a",
		executeRequestId: "execute-a",
		leaseId: "lease-a",
		identity,
	};
	return {
		get store() {
			return store;
		},
		path,
		frozen,
		digest,
		receiptId,
		identity,
		decision,
		request,
		prepare() {
			return store.prepare(
				{ frozen, prepareRequestId: "prepare-a", expiresAt: NOW + 600000 },
				NOW,
			);
		},
		approve() {
			this.prepare();
			store.delivered(
				frozen.proposalId,
				{
					previewDigest: "d".repeat(64),
					cardId: "card-a",
					challenge: "ABCDEFGH",
					guildId: "guild-a",
					channelId: "channel-a",
				},
				NOW,
			);
			return store.recordDecision(decision);
		},
		restart() {
			store.close();
			store = new XhsWriteStore(path, { providerGeneration: "generation-a" });
		},
		close() {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
