import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { XhsWriteStore } from "../store.js";
import { fixture, NOW } from "./store-fixture.js";

const fixtures: ReturnType<typeof fixture>[] = [];
function setup() {
	const f = fixture();
	fixtures.push(f);
	return f;
}
afterEach(() => {
	for (const f of fixtures.splice(0)) f.close();
});

describe("authority-only receipt ledger", () => {
	it("refuses missing receipt and approval before complete card delivery", () => {
		const f = setup();
		f.prepare();
		expect(f.store.claim(f.request, NOW + 3000).kind).toBe("denied");
		expect(() => f.store.recordDecision(f.decision)).toThrow(
			"preview_unavailable",
		);
		expect(f.store.status(f.frozen.proposalId, f.identity)?.state).toBe(
			"awaiting_delivery",
		);
	});
	it("atomically consumes once across two SQLite connections and replay after reopen", async () => {
		const f = setup();
		f.approve();
		const other = new XhsWriteStore(f.path, {
			providerGeneration: "generation-a",
		});
		let mutations = 0;
		const execute = (store: XhsWriteStore, requestId: string) => {
			const result = store.claim(
				{ ...f.request, executeRequestId: requestId },
				NOW + 3000,
			);
			if (result.kind === "claimed") mutations++;
			return result;
		};
		try {
			const claims = await Promise.all([
				Promise.resolve().then(() => execute(f.store, "a")),
				Promise.resolve().then(() => execute(other, "b")),
			]);
			expect(claims.map((result) => result.kind).sort()).toEqual([
				"claimed",
				"existing",
			]);
			expect(mutations).toBe(1);
			f.restart();
			expect(execute(f.store, "c").kind).toBe("existing");
			expect(mutations).toBe(1);
			const db = new Database(f.path, { readonly: true });
			try {
				expect(
					db.prepare("SELECT count(*) AS n FROM xhs_write_attempt").get(),
				).toEqual({ n: 1 });
				expect(
					db.prepare("SELECT consumed_at FROM xhs_write_decision").get(),
				).toEqual({ consumed_at: NOW + 3000 });
			} finally {
				db.close();
			}
		} finally {
			other.close();
		}
	});
	it.each([
		"projectId",
		"leadId",
		"requesterUid",
		"accountUserId",
		"accountEpoch",
		"providerGeneration",
		"providerInstanceId",
		"authorityPolicyVersion",
		"founderConfigVersion",
	])("denies changed trusted identity %s", (field) => {
		const f = setup();
		f.approve();
		const identity: any = { ...f.identity };
		identity[field] =
			typeof identity[field] === "number" ? identity[field] + 1 : "wrong";
		expect(f.store.claim({ ...f.request, identity }, NOW + 3000).kind).toBe(
			"denied",
		);
		expect(f.store.claim(f.request, NOW + 3001).kind).toBe("claimed");
	});
	it("denies digest substitution, including two equal forged client digests", () => {
		const f = setup();
		f.approve();
		expect(
			f.store.claim({ ...f.request, contentDigest: "f".repeat(64) }, NOW + 3000)
				.kind,
		).toBe("denied");
		const db = new Database(f.path);
		db.prepare("UPDATE xhs_write_proposal SET content_digest=?").run(
			"f".repeat(64),
		);
		db.prepare("UPDATE xhs_write_decision SET content_digest=?").run(
			"f".repeat(64),
		);
		db.close();
		expect(
			f.store.claim({ ...f.request, contentDigest: "f".repeat(64) }, NOW + 3000)
				.kind,
		).toBe("denied");
	});
	it("treats expiry equality, cancellation and supersession as final", () => {
		const expired = setup();
		expired.approve();
		expect(
			expired.store.claim(expired.request, expired.decision.expiresAt).kind,
		).toBe("denied");
		const revoked = setup();
		revoked.approve();
		expect(
			revoked.store.cancel(
				revoked.frozen.proposalId,
				revoked.identity,
				NOW + 3000,
			),
		).toBe("revoked");
		expect(revoked.store.claim(revoked.request, NOW + 3001).kind).toBe(
			"denied",
		);
		const consumed = setup();
		consumed.approve();
		consumed.store.claim(consumed.request, NOW + 3000);
		expect(
			consumed.store.cancel(
				consumed.frozen.proposalId,
				consumed.identity,
				NOW + 3001,
			),
		).toBe("already_started");
	});
	it("prepare retry returns the original proposal and conflicts on changed content", () => {
		const f = setup();
		const first = f.prepare();
		expect(f.prepare()).toEqual(first);
		expect(() =>
			f.store.prepare(
				{
					frozen: {
						...f.frozen,
						payload: { ...f.frozen.payload, unlike: true },
					},
					prepareRequestId: "prepare-a",
					expiresAt: NOW + 600000,
				},
				NOW,
			),
		).toThrow("prepare_conflict");
	});
	it("duplicate founder delivery cannot mint a second decision or audit event", () => {
		const f = setup();
		f.approve();
		expect(f.store.recordDecision(f.decision)).toEqual({
			receiptId: f.receiptId,
			existing: true,
		});
		expect(() =>
			f.store.recordDecision({ ...f.decision, receiptId: "another-receipt" }),
		).toThrow("decision_conflict");
	});
	it("unknown/failed outcomes never reopen a consumed approval", () => {
		const f = setup();
		f.approve();
		const result = f.store.claim(f.request, NOW + 3000);
		expect(result.kind).toBe("claimed");
		if (result.kind !== "claimed") throw Error("missing claim");
		f.store.finish(result.attemptId, "unknown", NOW + 4000);
		f.restart();
		expect(f.store.claim(f.request, NOW + 5000).kind).toBe("existing");
		expect(
			f.store.status(f.frozen.proposalId, f.identity)?.attempt?.state,
		).toBe("unknown");
		expect(
			f.store.status(f.frozen.proposalId, { ...f.identity, leadId: "other" }),
		).toBeNull();
	});
});

it("supersedes only an unconsumed proposal in the same scope, atomically", () => {
	const f = setup();
	f.approve();
	const replacement = {
		...f.frozen,
		proposalId: "10000000-0000-4000-8000-000000000001",
		payload: { ...f.frozen.payload, unlike: true },
	};
	f.store.prepare(
		{
			frozen: replacement,
			prepareRequestId: "replacement",
			expiresAt: NOW + 600000,
			supersedesProposalId: f.frozen.proposalId,
		},
		NOW + 3000,
	);
	expect(f.store.status(f.frozen.proposalId, f.identity)?.state).toBe(
		"superseded",
	);
	expect(f.store.claim(f.request, NOW + 3001).kind).toBe("denied");
	const other = setup();
	other.approve();
	other.store.claim(other.request, NOW + 3000);
	expect(() =>
		other.store.prepare(
			{
				frozen: replacement,
				prepareRequestId: "replacement",
				expiresAt: NOW + 600000,
				supersedesProposalId: other.frozen.proposalId,
			},
			NOW + 3001,
		),
	).toThrow("supersede_denied");
	expect(other.store.status(replacement.proposalId, other.identity)).toBeNull();
});
it("does not supersede a proposal belonging to a different lead", () => {
	const f = setup();
	f.approve();
	expect(() =>
		f.store.prepare(
			{
				frozen: {
					...f.frozen,
					leadId: "another-lead",
					proposalId: "10000000-0000-4000-8000-000000000002",
				},
				prepareRequestId: "replacement",
				expiresAt: NOW + 600000,
				supersedesProposalId: f.frozen.proposalId,
			},
			NOW + 3000,
		),
	).toThrow("supersede_denied");
	expect(f.store.claim(f.request, NOW + 3001).kind).toBe("claimed");
});

it("accepts the protocol's bounded future-message clock skew without extending the approval window", () => {
	const f = setup();
	f.prepare();
	f.store.delivered(
		f.frozen.proposalId,
		{
			previewDigest: "d".repeat(64),
			cardId: "card-a",
			challenge: "ABCDEFGH",
			guildId: "guild-a",
			channelId: "channel-a",
		},
		NOW,
	);
	const decision = {
		...f.decision,
		messageCreatedAt: NOW + 5000,
		observedAt: NOW + 2000,
	};
	expect(f.store.recordDecision(decision)).toEqual({
		receiptId: f.receiptId,
		existing: false,
	});
	expect(f.store.claim(f.request, NOW + 3000).kind).toBe("claimed");
});
