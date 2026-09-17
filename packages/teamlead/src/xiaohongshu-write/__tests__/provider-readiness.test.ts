import { expect, it } from "vitest";
import { waitForGuardedProvider } from "../provider-readiness.js";

const account = {
	providerInstanceId: "provider-1",
	accountUserId: "account-1",
	accountEpoch: 1,
	providerGeneration: "generation-1",
};
const upstream = {
	binarySha256: "a".repeat(64),
	toolSchemaDigest: "b".repeat(64),
	guardProtocol: 1 as const,
};
const expected = {
	accountBase: account,
	providerBinary: { path: "/trusted/provider", sha256: upstream.binarySha256 },
	toolSchemaDigest: upstream.toolSchemaDigest,
};
const alive = new Promise<unknown>(() => {});
it("waits for the private projection with exact build/account bindings and allows logged-out read readiness", async () => {
	let calls = 0;
	const result = await waitForGuardedProvider({
		exited: alive,
		expected,
		client: {
			async account() {
				if (++calls === 1) throw Error("not listening yet");
				return { account, upstream, loggedIn: false };
			},
		},
	});
	expect(result.loggedIn).toBe(false);
	expect(calls).toBe(2);
});
it("fails closed on observed account or binary mismatch", async () => {
	for (const proof of [
		{
			account: { ...account, accountUserId: "other" },
			upstream,
			loggedIn: true,
		},
		{
			account,
			upstream: { ...upstream, binarySha256: "c".repeat(64) },
			loggedIn: true,
		},
	]) {
		await expect(
			waitForGuardedProvider({
				exited: alive,
				expected,
				client: {
					async account() {
						return proof;
					},
				},
			}),
		).rejects.toThrow("provider_ready_unavailable");
	}
});
it("stops waiting when the exact child exits or the owner cancels", async () => {
	const controller = new AbortController();
	controller.abort();
	for (const options of [
		{ exited: Promise.resolve({ code: 7 }) },
		{ exited: alive, signal: controller.signal },
	]) {
		await expect(
			waitForGuardedProvider({
				...options,
				expected,
				client: { account: async () => new Promise(() => {}) },
			}),
		).rejects.toThrow("provider_ready_unavailable");
	}
});
