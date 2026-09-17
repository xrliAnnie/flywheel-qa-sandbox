import { expect, it } from "vitest";
import { XhsAuthorityRegistry } from "../authority-registry.js";

function setup() {
	const account = {
		providerInstanceId: "provider-1",
		accountUserId: "account-1",
		accountEpoch: 1,
		providerGeneration: "generation-1",
	};
	const entry = {
		projectId: "flywheel",
		leadId: "lead-1",
		account,
		founderId: "12345678901234567",
		canonicalFounderId: "12345678901234567",
		botId: "12345678901234568",
		guildId: "12345678901234569",
		channelId: "12345678901234570",
		initialCursor: "12345678901234571",
	};
	const config = {
		modelUid: 501,
		policyVersion: 1,
		founderConfigVersion: 1,
		registry: [entry],
		provider: {
			providerBinary: { path: "/trusted/provider", sha256: "a".repeat(64) },
			toolSchemaDigest: "b".repeat(64),
		},
	};
	const state = {
		calls: 0,
		proof: {
			account: { ...account },
			upstream: {
				binarySha256: "a".repeat(64),
				toolSchemaDigest: "b".repeat(64),
				guardProtocol: 1 as const,
			},
			loggedIn: true,
		},
	};
	const registry = new XhsAuthorityRegistry(config, {
		account: async () => {
			state.calls++;
			return structuredClone(state.proof);
		},
	});
	return {
		registry,
		state,
		entry,
		select: { projectId: entry.projectId, leadId: entry.leadId },
	};
}
it("derives founder/thread/identity only from registry and live private account observation", async () => {
	const s = setup();
	s.state.proof.account.accountEpoch = 2;
	const result = await s.registry.proveAccount(501, s.select);
	expect(result).toMatchObject({
		requesterUid: 501,
		projectId: "flywheel",
		leadId: "lead-1",
		accountUserId: "account-1",
		accountEpoch: 2,
		founderId: s.entry.founderId,
		channelId: s.entry.channelId,
		authorityPolicyVersion: 1,
	});
	expect(s.state.calls).toBe(1);
});
it("rejects wrong peer, absent scope and model-supplied founder/account before provider IO", async () => {
	const s = setup();
	await expect(s.registry.proveAccount(502, s.select)).rejects.toThrow(
		"write_scope_unavailable",
	);
	await expect(
		s.registry.proveAccount(501, { ...s.select, projectId: "other" }),
	).rejects.toThrow("write_scope_unavailable");
	await expect(
		s.registry.proveAccount(501, { ...s.select, founderId: "forged" }),
	).rejects.toThrow("write_scope_unavailable");
	expect(s.state.calls).toBe(0);
});
it.each(["logout", "account", "instance", "generation", "binary", "schema"])(
	"rejects %s drift in actual provider observation",
	async (kind) => {
		const s = setup();
		if (kind === "logout") s.state.proof.loggedIn = false;
		if (kind === "account") s.state.proof.account.accountUserId = "other";
		if (kind === "instance") s.state.proof.account.providerInstanceId = "other";
		if (kind === "generation")
			s.state.proof.account.providerGeneration = "other";
		if (kind === "binary") s.state.proof.upstream.binarySha256 = "c".repeat(64);
		if (kind === "schema")
			s.state.proof.upstream.toolSchemaDigest = "c".repeat(64);
		await expect(s.registry.proveAccount(501, s.select)).rejects.toThrow(
			"write_scope_unavailable",
		);
	},
);
it("never accepts an epoch rollback after observing a newer account session", async () => {
	const s = setup();
	s.state.proof.account.accountEpoch = 3;
	await s.registry.proveAccount(501, s.select);
	s.state.proof.account.accountEpoch = 2;
	await expect(s.registry.proveAccount(501, s.select)).rejects.toThrow(
		"write_scope_unavailable",
	);
});

it("observes a logged-out registered account without making it a write proof", async () => {
	const s = setup();
	s.state.proof.loggedIn = false;
	expect(await s.registry.observeAccount(501, s.select)).toMatchObject({
		loggedIn: false,
		accountUserId: "account-1",
		accountEpoch: 1,
	});
	await expect(s.registry.proveAccount(501, s.select)).rejects.toThrow(
		"write_scope_unavailable",
	);
	s.state.proof.account.accountEpoch = 3;
	await s.registry.observeAccount(501, s.select);
	s.state.proof.account.accountEpoch = 2;
	await expect(s.registry.observeAccount(501, s.select)).rejects.toThrow(
		"write_scope_unavailable",
	);
	s.state.proof.account.accountEpoch = 3;
	s.state.proof.upstream.binarySha256 = "c".repeat(64);
	await expect(s.registry.observeAccount(501, s.select)).rejects.toThrow(
		"write_scope_unavailable",
	);
});

it("invalidates prior resource epochs as soon as a newer private observation is accepted", async () => {
	const s = setup();
	const old = await s.registry.observeAccount(501, s.select);
	expect(() => s.registry.assertAccountEpoch(old)).not.toThrow();
	s.state.proof.account.accountEpoch = 2;
	s.state.proof.loggedIn = false;
	const current = await s.registry.observeAccount(501, s.select);
	expect(() => s.registry.assertAccountEpoch(old)).toThrow(
		"write_scope_unavailable",
	);
	expect(() => s.registry.assertAccountEpoch(current)).not.toThrow();
	expect(() =>
		s.registry.assertAccountEpoch({ ...current, providerGeneration: "unseen" }),
	).toThrow("write_scope_unavailable");
});
