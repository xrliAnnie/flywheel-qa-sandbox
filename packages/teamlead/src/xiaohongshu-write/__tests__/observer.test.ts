import { afterEach, expect, it } from "vitest";
import { canonical, contentDigest } from "../canonical.js";
import { XhsFounderInbox } from "../founder-inbox.js";
import { XhsFounderObserver } from "../observer.js";
import { XhsMessagePagination } from "../pagination.js";
import { fixture, NOW } from "./store-fixture.js";

const fixtures: ReturnType<typeof fixture>[] = [];
const snowflake = (time: number) =>
	((BigInt(time) - 1420070400000n) << 22n).toString();
afterEach(() => {
	for (const f of fixtures.splice(0)) f.close();
});
function setup() {
	const f = fixture();
	fixtures.push(f);
	f.prepare();
	const guildId = "100000000000000002",
		channelId = "100000000000000003",
		founderId = "100000000000000001",
		botId = "100000000000000004";
	const cardId = snowflake(NOW + 1000),
		messageId = snowflake(NOW + 2000),
		materialId = snowflake(NOW);
	const bytes = Buffer.from("complete review bytes");
	const manifest = {
		schemaVersion: 1,
		proposalId: f.frozen.proposalId,
		contentDigest: f.digest,
		messages: [
			{
				id: materialId,
				content: "material",
				attachments: [
					{
						id: "attachment",
						name: "review.txt",
						size: bytes.length,
						sha256: "a".repeat(64),
					},
				],
			},
		],
	};
	// Use the actual byte digest in the persisted manifest.
	const messages = new Map<string, unknown>();
	let policy = {
		founderId,
		canonicalFounderId: founderId,
		founderConfigVersion: 1,
		botId,
		...f.identity,
		guildId,
		channelId,
	};
	const transport = {
		async fetchMessage(_channelId: string, id: string) {
			return messages.get(id);
		},
		async channelGuild() {
			return guildId;
		},
		async readAttachment() {
			return bytes;
		},
	};
	return {
		f,
		messages,
		bytes,
		manifest,
		cardId,
		messageId,
		materialId,
		policy: () => policy,
		setPolicy(next: typeof policy) {
			policy = next;
		},
		transport,
		guildId,
		channelId,
		founderId,
		botId,
	};
}

import { createHash } from "node:crypto";

function ready() {
	const t = setup();
	t.manifest.messages[0]!.attachments[0]!.sha256 = createHash("sha256")
		.update(t.bytes)
		.digest("hex");
	const cardContent = "fixed card instructions";
	t.f.store.delivered(
		t.f.frozen.proposalId,
		{
			cardId: t.cardId,
			challenge: "ABCDEFGH",
			guildId: t.guildId,
			channelId: t.channelId,
			previewDigest: contentDigest(t.manifest),
			expectedContentDigest: t.f.digest,
			manifestJson: canonical({ manifest: t.manifest, cardContent }),
		},
		NOW + 1000,
	);
	const base = {
		channel_id: t.channelId,
		guild_id: t.guildId,
		author: { id: t.botId, bot: true },
		edited_timestamp: null,
	};
	t.messages.set(t.materialId, {
		...base,
		id: t.materialId,
		content: "material",
		timestamp: new Date(NOW).toISOString(),
		attachments: [
			{ id: "attachment", filename: "review.txt", size: t.bytes.length },
		],
	});
	t.messages.set(t.cardId, {
		...base,
		id: t.cardId,
		content: cardContent,
		timestamp: new Date(NOW + 1000).toISOString(),
		attachments: [],
	});
	t.messages.set(t.messageId, {
		id: t.messageId,
		channel_id: t.channelId,
		guild_id: t.guildId,
		author: { id: t.founderId, bot: false },
		type: 19,
		message_reference: {
			type: 0,
			message_id: t.cardId,
			channel_id: t.channelId,
			guild_id: t.guildId,
		},
		timestamp: new Date(NOW + 2000).toISOString(),
		edited_timestamp: null,
		content: "批准小红书 ABCDEFGH",
	});
	const observer = new XhsFounderObserver(
		t.f.store,
		t.transport,
		t.policy,
		() => NOW + 3000,
	);
	return { ...t, observer };
}
it("refetches full review and original founder reply, then persists exactly one receipt", async () => {
	const t = ready();
	const first = await t.observer.observe(t.f.frozen.proposalId, t.messageId);
	expect(first.kind).toBe("approved");
	expect(t.f.store.status(t.f.frozen.proposalId, t.f.identity)?.state).toBe(
		"approved",
	);
	const second = await t.observer.observe(t.f.frozen.proposalId, t.messageId);
	expect(second).toEqual({ ...first, existing: true });
});
it.each(["card", "bytes", "founder", "policy"])(
	"rejects changed %s without inserting approval",
	async (failure) => {
		const t = ready();
		if (failure === "card")
			t.messages.set(t.cardId, {
				...(t.messages.get(t.cardId) as object),
				content: "changed",
			});
		if (failure === "bytes")
			t.transport.readAttachment = async () => Buffer.from("changed");
		if (failure === "founder")
			t.messages.set(t.messageId, {
				...(t.messages.get(t.messageId) as object),
				author: { id: "100000000000000099", bot: false },
			});
		if (failure === "policy") {
			const read = t.transport.readAttachment;
			t.transport.readAttachment = async () => {
				t.setPolicy({ ...t.policy(), founderConfigVersion: 2 });
				return read();
			};
		}
		await expect(
			t.observer.observe(t.f.frozen.proposalId, t.messageId),
		).rejects.toThrow();
		expect(t.f.store.status(t.f.frozen.proposalId, t.f.identity)?.state).toBe(
			"awaiting_approval",
		);
	},
);
it("does not mint when Discord is unavailable", async () => {
	const t = ready();
	t.transport.fetchMessage = async () => {
		throw Error("403 private bot details");
	};
	await expect(
		t.observer.observe(t.f.frozen.proposalId, t.messageId),
	).rejects.toThrow(/^founder_source_unavailable$/);
	expect(t.f.store.status(t.f.frozen.proposalId, t.f.identity)?.state).toBe(
		"awaiting_approval",
	);
});

it("records explicit founder revocation once and never reopens it", async () => {
	const t = ready();
	await t.observer.observe(t.f.frozen.proposalId, t.messageId);
	const revokeId = snowflake(NOW + 2500);
	t.messages.set(revokeId, {
		...(t.messages.get(t.messageId) as object),
		id: revokeId,
		timestamp: new Date(NOW + 2500).toISOString(),
		content: "撤回小红书 ABCDEFGH",
	});
	expect(await t.observer.observe(t.f.frozen.proposalId, revokeId)).toEqual({
		kind: "revoked",
		existing: false,
		state: "revoked",
	});
	expect(await t.observer.observe(t.f.frozen.proposalId, revokeId)).toEqual({
		kind: "revoked",
		existing: true,
		state: "revoked",
	});
	expect(t.f.store.status(t.f.frozen.proposalId, t.f.identity)?.state).toBe(
		"revoked",
	);
});
it("preserves the dedicated empty Message Content error for founder feedback", async () => {
	const t = ready();
	t.messages.set(t.messageId, {
		...(t.messages.get(t.messageId) as object),
		content: "",
	});
	await expect(
		t.observer.observe(t.f.frozen.proposalId, t.messageId),
	).rejects.toThrow("founder_content_unavailable");
});
it("checks the latest original reply after awaiting attachment revalidation", async () => {
	const t = ready();
	const read = t.transport.readAttachment;
	t.transport.readAttachment = async () => {
		t.messages.set(t.messageId, {
			...(t.messages.get(t.messageId) as object),
			edited_timestamp: new Date(NOW + 2500).toISOString(),
		});
		return read();
	};
	await expect(
		t.observer.observe(t.f.frozen.proposalId, t.messageId),
	).rejects.toThrow();
	expect(t.f.store.status(t.f.frozen.proposalId, t.f.identity)?.state).toBe(
		"awaiting_approval",
	);
});

it("rechecks policy inside the writer transaction before minting", async () => {
	const t = ready();
	let reads = 0;
	const observer = new XhsFounderObserver(
		t.f.store,
		t.transport,
		() => {
			reads++;
			return reads >= 3
				? { ...t.policy(), founderConfigVersion: 2 }
				: t.policy();
		},
		() => NOW + 3000,
	);
	await expect(
		observer.observe(t.f.frozen.proposalId, t.messageId),
	).rejects.toThrow("founder_policy_changed");
	expect(reads).toBe(3);
	expect(t.f.store.receiptForFounderMessage(t.messageId)).toBeNull();
});
it("does not mint after cancellation wins during the remote reads", async () => {
	const t = ready();
	const read = t.transport.readAttachment;
	t.transport.readAttachment = async () => {
		t.f.store.cancel(t.f.frozen.proposalId, t.f.identity, NOW + 2500);
		return read();
	};
	await expect(
		t.observer.observe(t.f.frozen.proposalId, t.messageId),
	).rejects.toThrow();
	expect(t.f.store.receiptForFounderMessage(t.messageId)).toBeNull();
	expect(t.f.store.status(t.f.frozen.proposalId, t.f.identity)?.state).toBe(
		"revoked",
	);
});

it("replays the same original message after a later observation without changing receipt evidence", async () => {
	const t = ready();
	let time = NOW + 3000;
	const observer = new XhsFounderObserver(
		t.f.store,
		t.transport,
		t.policy,
		() => time,
	);
	const first = await observer.observe(t.f.frozen.proposalId, t.messageId);
	time += 1000;
	expect(await observer.observe(t.f.frozen.proposalId, t.messageId)).toEqual({
		...first,
		existing: true,
	});
});

it("discovers a persisted card from a reply and processes approval without a Bridge hint", async () => {
	const t = ready();
	t.f.restart();
	const dispatcher = new XhsFounderInbox(
		t.f.store,
		t.transport,
		t.policy,
		() => NOW + 3000,
	);
	expect(await dispatcher.process(t.messageId)).toBe("handled");
	expect(t.f.store.status(t.f.frozen.proposalId, t.f.identity)?.state).toBe(
		"approved",
	);
	expect(await dispatcher.process(t.messageId)).toBe("handled");
});
it.each(["ordinary", "wrong-founder", "unknown-card", "wrong-scope", "edited"])(
	"ignores %s without granting or stalling later messages",
	async (kind) => {
		const t = ready();
		const message = t.messages.get(t.messageId) as Record<string, unknown>;
		if (kind === "ordinary") message.content = "I think this looks good";
		if (kind === "wrong-founder") message.author = { id: t.botId, bot: false };
		if (kind === "unknown-card")
			message.message_reference = {
				type: 0,
				message_id: t.materialId,
				channel_id: t.channelId,
			};
		if (kind === "wrong-scope")
			t.setPolicy({ ...t.policy(), projectId: "other" });
		if (kind === "edited")
			message.edited_timestamp = new Date(NOW + 2500).toISOString();
		const dispatcher = new XhsFounderInbox(
			t.f.store,
			t.transport,
			t.policy,
			() => NOW + 3000,
		);
		expect(await dispatcher.process(t.messageId)).toBe("ignored");
		expect(t.f.store.receiptForFounderMessage(t.messageId)).toBeNull();
	},
);
it("propagates an unavailable original message so pagination retains its cursor", async () => {
	const t = ready();
	t.transport.fetchMessage = async () => {
		throw Error("429");
	};
	const dispatcher = new XhsFounderInbox(
		t.f.store,
		t.transport,
		t.policy,
		() => NOW + 3000,
	);
	await expect(dispatcher.process(t.messageId)).rejects.toThrow(
		"founder_source_unavailable",
	);
	expect(t.f.store.receiptForFounderMessage(t.messageId)).toBeNull();
});
it("does not drop an empty founder reply as ordinary discussion", async () => {
	const t = ready();
	(t.messages.get(t.messageId) as Record<string, unknown>).content = "";
	const dispatcher = new XhsFounderInbox(
		t.f.store,
		t.transport,
		t.policy,
		() => NOW + 3000,
	);
	await expect(dispatcher.process(t.messageId)).rejects.toThrow(
		"founder_content_unavailable",
	);
});
it("rechecks canonical policy after message discovery awaits", async () => {
	const t = ready();
	const fetch = t.transport.fetchMessage;
	t.transport.fetchMessage = async (...args) => {
		const raw = await fetch(...args);
		t.setPolicy({ ...t.policy(), founderConfigVersion: 2 });
		return raw;
	};
	const dispatcher = new XhsFounderInbox(
		t.f.store,
		t.transport,
		t.policy,
		() => NOW + 3000,
	);
	await expect(dispatcher.process(t.messageId)).rejects.toThrow(
		"founder_policy_changed",
	);
	expect(t.f.store.receiptForFounderMessage(t.messageId)).toBeNull();
});

it("resumes the real discovery/approval pipeline after a transient read without skipping its cursor", async () => {
	const t = ready();
	const original = t.transport.fetchMessage;
	let unavailable = true;
	t.transport.fetchMessage = async (...args) => {
		if (unavailable && args[1] === t.messageId) throw Error("429");
		return original(...args);
	};
	const make = () => {
		const inbox = new XhsFounderInbox(
			t.f.store,
			t.transport,
			t.policy,
			() => NOW + 3000,
		);
		return new XhsMessagePagination(
			t.f.store,
			t.channelId,
			t.cardId,
			async () => [t.messageId, t.cardId],
			async (id) => {
				await inbox.process(id);
			},
		);
	};
	await expect(make().poll()).rejects.toThrow("founder_source_unavailable");
	expect(t.f.store.observerState(t.channelId, t.cardId).cursor).toBe(t.cardId);
	t.f.restart();
	unavailable = false;
	expect((await make().poll()).processed).toBe(1);
	expect(t.f.store.observerState(t.channelId, t.cardId).cursor).toBe(
		t.messageId,
	);
	const receipt = t.f.store.receiptForFounderMessage(t.messageId);
	expect(receipt).not.toBeNull();
	await make().poll();
	expect(t.f.store.receiptForFounderMessage(t.messageId)).toBe(receipt);
}, 30000);
