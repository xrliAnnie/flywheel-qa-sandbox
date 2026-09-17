import { afterEach, expect, it } from "vitest";
import type { ReviewMessage, ReviewTransport } from "../cards.js";
import { XhsWritePreparation } from "../preparation.js";
import { fixture, NOW } from "./store-fixture.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanup.splice(0)) close();
});
function setup() {
	const f = fixture();
	cleanup.push(() => f.close());
	const state = {
		sends: 0,
		fail: false,
		now: NOW,
		probes: 0,
		targetActivation: undefined as string | undefined,
		limit: 1024 * 1024,
		limitCalls: 0,
	};
	const messages = new Map<string, ReviewMessage>(),
		bytes = new Map<string, Buffer>();
	const transport: ReviewTransport = {
		async send(content, files) {
			if (state.fail && state.sends > 0) throw Error("unavailable");
			const id = String(100000000000000000n + BigInt(state.sends++));
			const attachments = files.map((file, n) => {
				const attachmentId = `${id}-${n}`;
				bytes.set(attachmentId, file.bytes);
				return { id: attachmentId, name: file.name, size: file.bytes.length };
			});
			messages.set(id, {
				id,
				authorId: "bot",
				channelId: "thread",
				content,
				attachments,
			});
			return id;
		},
		async fetch(id) {
			return messages.get(id)!;
		},
		async readAttachment(id) {
			return bytes.get(id)!;
		},
		async remove(id) {
			messages.delete(id);
		},
	};
	const policy = {
		...f.identity,
		founderId: "founder",
		canonicalFounderId: "founder",
		botId: "bot",
		guildId: "guild",
		channelId: "thread",
		initialCursor: "100000000000000000",
	};
	const make = () =>
		new XhsWritePreparation({
			store: f.store,
			registry: {
				proveAccount: async () => {
					state.probes++;
					return policy;
				},
			},
			artifacts: {
				read: async () => {
					throw Error("no-media");
				},
			},
			target: async (_, handle, activationId) => {
				state.targetActivation = activationId;
				return handle === "resource-1" ? f.frozen.target : null;
			},
			transport: () => transport,
			upstream: f.frozen.upstream,
			attachmentLimit: (scope) => {
				expect(scope.projectId).toBe(f.identity.projectId);
				expect(scope.leadId).toBe(f.identity.leadId);
				state.limitCalls++;
				return state.limit;
			},
			now: () => state.now,
		});
	const input = {
		activationId: "activation-a",
		accountSelector: f.identity.accountUserId,
		projectId: f.identity.projectId,
		leadId: f.identity.leadId,
		prepareRequestId: "prepare-a",
		operationId: "xiaohongshu.like_feed",
		payload: {},
		artifactIds: [],
		targetHandle: "resource-1",
	};
	return { f, state, messages, make, input };
}
it("freezes a server-assigned proposal and delivers a complete review without approving", async () => {
	const s = setup();
	const result = await s.make().prepare(501, s.input);
	expect(result.state).toBe("awaiting_approval");
	expect(result.expiresAt).toBe(NOW + 15 * 60000);
	expect(s.f.store.status(result.proposalId, s.f.identity)?.attempt).toBeNull();
	expect(s.f.store.review(result.proposalId)?.cardId).toBeTruthy();
	expect(s.state.targetActivation).toBe("activation-a");
});
it("requires ingress activation attribution before resolving any resource", async () => {
	const s = setup();
	for (const activationId of [undefined, ""])
		await expect(
			s.make().prepare(501, { ...s.input, activationId }),
		).rejects.toThrow("prepare_invalid");
	expect(s.state.probes).toBe(0);
	expect(s.state.targetActivation).toBeUndefined();
	expect(s.state.sends).toBe(0);
});
it("reuses the exact assigned ID/expiry/card after restart and rejects changed content", async () => {
	const s = setup();
	const first = await s.make().prepare(501, s.input);
	const sends = s.state.sends;
	s.f.restart();
	s.state.now += 1000;
	expect(await s.make().prepare(501, s.input)).toEqual(first);
	expect(s.state.sends).toBe(sends);
	await expect(
		s.make().prepare(501, { ...s.input, payload: { unlike: true } }),
	).rejects.toThrow("prepare_conflict");
	expect(s.state.sends).toBe(sends);
});
it("rejects forged account/approval fields and unbound resources before any card", async () => {
	const s = setup();
	await expect(
		s.make().prepare(501, { ...s.input, approved: true }),
	).rejects.toThrow("prepare_invalid");
	await expect(
		s.make().prepare(501, { ...s.input, targetHandle: "unseen" }),
	).rejects.toThrow("target_unbound");
	expect(s.state.sends).toBe(0);
});
it("partial delivery never enables approval and can resume the same proposal", async () => {
	const s = setup();
	s.state.fail = true;
	await expect(s.make().prepare(501, s.input)).rejects.toThrow(
		"preview_delivery_failed",
	);
	const prior = s.f.store.preparedRequest("prepare-a", s.f.identity)!;
	expect(prior.state).toBe("awaiting_delivery");
	expect(s.messages.size).toBe(0);
	s.state.fail = false;
	const result = await s.make().prepare(501, s.input);
	expect(result.proposalId).toBe(prior.frozen.proposalId);
	expect(result.state).toBe("awaiting_approval");
});
it("coalesces identical concurrent preparation into one delivery", async () => {
	const s = setup();
	const service = s.make();
	const [a, b] = await Promise.all([
		service.prepare(501, s.input),
		service.prepare(501, s.input),
	]);
	expect(a).toEqual(b);
	expect(s.state.sends).toBe(2);
});

it("enforces durable per-peer/project three-pending and three-per-ten-minute admission", async () => {
	const s = setup();
	const results = [];
	for (let i = 0; i < 3; i++)
		results.push(
			await s
				.make()
				.prepare(501, { ...s.input, prepareRequestId: `prepare-${i}` }),
		);
	s.f.restart();
	await expect(
		s.make().prepare(501, { ...s.input, prepareRequestId: "fourth" }),
	).rejects.toThrow("proposal_rate_limited");
	expect(s.state.sends).toBe(6);
	for (const result of results)
		s.f.store.cancel(result.proposalId, s.f.identity, s.state.now);
	await expect(
		s.make().prepare(501, { ...s.input, prepareRequestId: "fourth" }),
	).rejects.toThrow("proposal_rate_limited");
	s.state.now += 600001;
	expect(
		(await s.make().prepare(501, { ...s.input, prepareRequestId: "fourth" }))
			.state,
	).toBe("awaiting_approval");
});

it("requires an explicit stable account selector before resolving resources or sending a card", async () => {
	const s = setup();
	await expect(
		s.make().prepare(501, {
			...s.input,
			accountSelector: "other-account",
			artifactIds: ["unverified-media"],
			targetHandle: "unseen",
		}),
	).rejects.toThrow("write_scope_unavailable");
	expect(s.state.sends).toBe(0);
	const { accountSelector: _selector, ...missing } = s.input;
	await expect(s.make().prepare(501, missing)).rejects.toThrow(
		"prepare_invalid",
	);
	expect(s.state.sends).toBe(0);
	expect((await s.make().prepare(501, s.input)).state).toBe(
		"awaiting_approval",
	);
});

it("uses the current per-scope attachment limit before sending any review files", async () => {
	const s = setup();
	s.state.limit = 1;
	await expect(s.make().prepare(501, s.input)).rejects.toThrow(
		"preview_media_too_large",
	);
	expect(s.state.limitCalls).toBe(1);
	expect(s.state.sends).toBe(0);
});
