import { afterEach, expect, it } from "vitest";
import { createPinnedDispatchScope } from "../dispatch-scope.js";
import { fixture, NOW } from "./store-fixture.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanup.splice(0)) close();
});
function setup() {
	const f = fixture();
	cleanup.push(() => f.close());
	const config = {
		enabled: true,
		modelUid: f.identity.requesterUid,
		policyVersion: f.identity.authorityPolicyVersion,
		founderConfigVersion: f.identity.founderConfigVersion,
		keyId: "key-a",
		registry: [
			{
				projectId: f.identity.projectId,
				leadId: f.identity.leadId,
				account: { ...f.frozen.account },
			},
		],
		provider: {
			providerBinary: { sha256: f.frozen.upstream.binarySha256 },
			toolSchemaDigest: f.frozen.upstream.toolSchemaDigest,
		},
	};
	const state = { current: true };
	const make = () =>
		createPinnedDispatchScope(config, f.store, () => {
			if (!state.current) throw Error("changed");
		});
	return { f, config, state, make };
}
it("requires a consumed claim and recovers only its persisted attribution", async () => {
	const s = setup();
	s.f.approve();
	expect(
		await s.make()(s.f.frozen.proposalId, new AbortController().signal),
	).toBeNull();
	expect(s.f.store.claim(s.f.request, NOW + 2000).kind).toBe("claimed");
	s.f.restart();
	const scope = await s.make()(
		s.f.frozen.proposalId,
		new AbortController().signal,
	);
	expect(scope).toEqual({
		identity: s.f.identity,
		activationId: s.f.request.activationId,
		keyId: "key-a",
	});
});
it("refuses root scope or provider pin drift, cancellation and closed policy", async () => {
	const s = setup();
	s.f.approve();
	s.f.store.claim(s.f.request, NOW + 2000);
	for (const mutate of [
		() => {
			s.config.enabled = false;
		},
		() => {
			s.config.registry[0]!.account.accountUserId = "other";
		},
		() => {
			s.config.provider.toolSchemaDigest = "f".repeat(64);
		},
		() => {
			s.config.registry[0]!.account.accountEpoch++;
		},
	]) {
		const original = structuredClone(s.config);
		mutate();
		expect(
			await s.make()(s.f.frozen.proposalId, new AbortController().signal),
		).toBeNull();
		Object.assign(s.config, original);
	}
	const resolver = s.make();
	s.state.current = false;
	expect(
		await resolver(s.f.frozen.proposalId, new AbortController().signal),
	).toBeNull();
	s.state.current = true;
	const abort = new AbortController();
	abort.abort();
	expect(await resolver(s.f.frozen.proposalId, abort.signal)).toBeNull();
});
