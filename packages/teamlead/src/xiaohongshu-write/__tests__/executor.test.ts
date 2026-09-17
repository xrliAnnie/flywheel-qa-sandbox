import { afterEach, expect, it } from "vitest";
import { XhsWriteExecutor } from "../executor.js";
import type { ProviderResult } from "../provider-client.js";
import { fixture, NOW } from "./store-fixture.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanup.splice(0)) close();
});
function setup() {
	const f = fixture();
	cleanup.push(() => f.close());
	const state = {
		prepares: 0,
		commits: 0,
		activation: "activation-a",
		now: NOW + 3000,
		duringPrepare: () => {},
		result: "succeeded" as ProviderResult,
		throwCommit: false,
	};
	const scope = () => ({
		identity: f.identity,
		activationId: state.activation,
		keyId: "key-1",
	});
	const executor = () =>
		new XhsWriteExecutor({
			store: f.store,
			now: () => state.now,
			scope: async () => scope(),
			key: Buffer.alloc(32, 1),
			media: () => {
				throw Error("no media");
			},
			provider: {
				async prepare(frozen) {
					state.prepares++;
					expect(frozen).toEqual(f.frozen);
					state.duringPrepare();
					return {
						leaseId: `lease-${state.prepares}`,
						accountUserId: f.identity.accountUserId,
						accountEpoch: 1,
						providerGeneration: f.identity.providerGeneration,
						contentDigest: f.digest,
						leaseExpiresAt: state.now + 60000,
					};
				},
				async commit(leaseId, signed) {
					state.commits++;
					const permit = JSON.parse(signed.permitJson);
					expect(permit.leaseId).toBe(leaseId);
					expect(f.store.status(f.frozen.proposalId, f.identity)?.state).toBe(
						"consumed",
					);
					if (state.throwCommit) throw Error("raw-token-must-not-leak");
					return state.result;
				},
			},
		});
	const request = {
		proposalId: f.frozen.proposalId,
		receiptId: f.receiptId,
		operationId: f.frozen.operationId,
		contentDigest: f.digest,
		executeRequestId: "execute-1",
	};
	return { f, state, executor, request };
}
it("prepares once, consumes before commit, and returns only attempt state", async () => {
	const s = setup();
	s.f.approve();
	const result = await s.executor().execute(s.request);
	expect(result).toMatchObject({ kind: "attempt", state: "succeeded" });
	expect(Object.keys(result).sort()).toEqual(["attemptId", "kind", "state"]);
	expect(s.state).toMatchObject({ prepares: 1, commits: 1 });
});
it("never prepares or commits without approval or with a mismatched digest", async () => {
	const s = setup();
	s.f.prepare();
	expect(await s.executor().execute(s.request)).toMatchObject({
		kind: "denied",
	});
	s.f.approve();
	expect(
		await s.executor().execute({ ...s.request, contentDigest: "f".repeat(64) }),
	).toMatchObject({ kind: "denied", code: "founder_content_digest_mismatch" });
	expect(s.state).toMatchObject({ prepares: 0, commits: 0 });
});
it.each(["activation", "revocation", "expiry"])(
	"rechecks %s after asynchronous provider preparation",
	async (change) => {
		const s = setup();
		s.f.approve();
		s.state.duringPrepare = () => {
			if (change === "activation") s.state.activation = "replacement";
			if (change === "revocation")
				s.f.store.cancel(s.request.proposalId, s.f.identity, s.state.now);
			if (change === "expiry") s.state.now = s.f.decision.expiresAt;
		};
		expect(await s.executor().execute(s.request)).toMatchObject({
			kind: "denied",
		});
		expect(s.state).toMatchObject({ prepares: 1, commits: 0 });
	},
);
it("replays from the real reopened ledger without a second provider prepare or commit", async () => {
	const s = setup();
	s.f.approve();
	s.state.throwCommit = true;
	const first = await s.executor().execute(s.request);
	expect(first).toMatchObject({ kind: "attempt", state: "unknown" });
	expect(
		await s.executor().execute({
			...s.request,
			receiptId: "00000000-0000-4000-8000-000000000001",
		}),
	).toMatchObject({ kind: "denied", code: "founder_receipt_invalid" });
	expect(
		await s
			.executor()
			.execute({ ...s.request, operationId: "xiaohongshu.favorite_feed" }),
	).toMatchObject({ kind: "denied", code: "founder_receipt_invalid" });
	s.f.restart();
	s.state.now = s.f.decision.expiresAt + 1;
	s.state.activation = "replacement";
	const replay = await s
		.executor()
		.execute({ ...s.request, executeRequestId: "new-request" });
	expect(replay).toEqual(first);
	expect(
		s.f.store.executionRecord(
			s.request.proposalId,
			s.request.contentDigest,
			s.f.identity,
			s.state.now,
		).attempt?.activationId,
	).toBe("activation-a");
	expect(s.state).toMatchObject({ prepares: 1, commits: 1 });
});
it("two concurrent callers share one consumed attempt and one commit", async () => {
	const s = setup();
	s.f.approve();
	const [a, b] = await Promise.all([
		s.executor().execute(s.request),
		s.executor().execute({ ...s.request, executeRequestId: "execute-2" }),
	]);
	expect(a).toMatchObject({ kind: "attempt" });
	expect(b).toMatchObject({ kind: "attempt" });
	if (a.kind === "attempt" && b.kind === "attempt")
		expect(a.attemptId).toBe(b.attemptId);
	expect(s.state.commits).toBe(1);
});
it("requires the caller's receipt and frozen operation before any provider preparation", async () => {
	const s = setup();
	s.f.approve();
	const base = {
		proposalId: s.request.proposalId,
		contentDigest: s.request.contentDigest,
		executeRequestId: "without-receipt",
	};
	for (const input of [
		base,
		{ ...base, receiptId: s.f.receiptId },
		{ ...base, operationId: s.f.frozen.operationId },
		{ ...s.request, receiptId: "00000000-0000-4000-8000-000000000001" },
		{ ...s.request, operationId: "xiaohongshu.favorite_feed" },
	]) {
		expect(await s.executor().execute(input)).toMatchObject({ kind: "denied" });
	}
	expect(s.state).toMatchObject({ prepares: 0, commits: 0 });
});
