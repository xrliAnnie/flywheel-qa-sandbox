import { expect, it, vi } from "vitest";
import { CustomerReleaseDecisionPump } from "../customer-release/pump.js";
import type { CustomerReleasePermit } from "../customer-release/types.js";

const permit = {
	cycleId: "cycle-1",
	attemptId: "attempt-1",
	decisionId: "decision-1",
	trigger: "silence_auto",
	activationEpoch: 1,
	claimedAt: 1000,
	notAfter: 31000,
	nonce: "nonce",
	baseEtag: "etag",
} as CustomerReleasePermit;
function fixture() {
	let unresolved: CustomerReleasePermit | null = null;
	const order: string[] = [];
	const store = {
		unresolvedDecision: vi.fn(() => unresolved),
		hasPostClaimIntervention: vi.fn(() => false),
		get: vi.fn(() => ({
			cycleId: "cycle-1",
			state: "awaiting_attempt",
			revision: 4,
		})),
		claimAuto: vi.fn(() => {
			order.push("claim");
			unresolved = permit;
			return permit;
		}),
		recordAttemptResult: vi.fn(),
	};
	const mailbox = {
		pending: vi.fn(async () => ({ attempts: [permit], cursor: null })),
		observe: vi.fn(async () => null),
		deliverPermit: vi.fn(async () => {
			order.push("deliver");
		}),
		requestFence: vi.fn(async () => {}),
	};
	const options = {
		store,
		mailbox,
		now: () => 1000,
		probe: vi.fn(async () => {
			order.push("probe");
			return { manifest: {}, receipt: {} };
		}),
		readActivation: vi.fn(() => ({
			enabled: true,
			mode: "canary",
			activationEpoch: 1,
			sourcesHealthy: true,
		})),
		evaluate: vi.fn(() => "verdict-1"),
	};
	const pump = new CustomerReleaseDecisionPump(options as never);
	return {
		store,
		mailbox,
		options,
		pump,
		order,
		unresolved: (value: CustomerReleasePermit | null) => {
			unresolved = value;
		},
	};
}
it("probes before synchronous claim and sends only the stored permit after the transaction", async () => {
	const f = fixture();
	expect(await f.pump.tick()).toBe("claimed");
	expect(f.order).toEqual(["probe", "claim", "deliver"]);
	expect(f.store.claimAuto).toHaveBeenCalledWith(
		"cycle-1",
		4,
		permit,
		{},
		{},
		1000,
		f.options.readActivation,
		expect.any(Function),
	);
});
it("lost delivery reconciles the same durable decision on the next tick without polling or minting", async () => {
	const f = fixture();
	f.mailbox.deliverPermit.mockRejectedValueOnce(new Error("lost reply"));
	expect(await f.pump.tick()).toBe("unavailable");
	expect(await f.pump.tick()).toBe("reconciling");
	expect(f.store.claimAuto).toHaveBeenCalledTimes(1);
	expect(f.mailbox.pending).toHaveBeenCalledTimes(1);
	expect(f.mailbox.deliverPermit.mock.calls).toEqual([[permit], [permit]]);
});
it("expired or intervened unknown asks for an exact fence and never mints a replacement", async () => {
	for (const expired of [false, true]) {
		const f = fixture();
		f.unresolved(permit);
		if (expired) f.options.now = () => 32000;
		else f.store.hasPostClaimIntervention.mockReturnValue(true);
		expect(await f.pump.tick()).toBe("fencing");
		expect(f.mailbox.requestFence).toHaveBeenCalledWith(
			permit,
			"release_intervention",
		);
		expect(f.mailbox.pending).not.toHaveBeenCalled();
		expect(f.mailbox.deliverPermit).not.toHaveBeenCalled();
	}
});
it("terminal observation is recorded before any attempt to fence or issue another permit", async () => {
	const f = fixture();
	f.unresolved(permit);
	const result = { kind: "published", attemptId: permit.attemptId };
	f.mailbox.observe.mockResolvedValue(result as never);
	expect(await f.pump.tick()).toBe("observed");
	expect(f.store.recordAttemptResult).toHaveBeenCalledWith(
		"cycle-1",
		result,
		1000,
	);
	expect(f.mailbox.requestFence).not.toHaveBeenCalled();
	expect(f.mailbox.deliverPermit).not.toHaveBeenCalled();
});
it("single flight skips overlapping ticks and failed probes never claim", async () => {
	const f = fixture();
	let finish!: () => void;
	f.options.probe.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = () => resolve({ manifest: {}, receipt: {} });
			}),
	);
	const first = f.pump.tick();
	await vi.waitFor(() => expect(finish).toBeDefined());
	expect(await f.pump.tick()).toBe("busy");
	finish();
	await first;
	const g = fixture();
	g.options.probe.mockRejectedValueOnce(new Error("remote unavailable"));
	expect(await g.pump.tick()).toBe("unavailable");
	expect(g.store.claimAuto).not.toHaveBeenCalled();
});

it("manual recovery ignores the auto switch but fences changed founder authority", async () => {
	const f = fixture();
	const manualPermit = {
		...permit,
		trigger: "founder_go" as const,
		actor: "founder",
		projectId: "flywheel",
		audience: "payload",
		manualRequestId: "request-1",
	};
	f.unresolved(manualPermit);
	Object.assign(f.store, {
		manual: { get: () => ({ card: { policyRevision: "policy" } }) },
	});
	let founderId = "founder";
	Object.assign(f.options, {
		manual: {
			readAuthority: () => ({
				founderId,
				projectId: "flywheel",
				audience: "payload",
				activationEpoch: 1,
				policyRevision: "policy",
				executionEnabled: true,
			}),
		},
	});
	f.options.readActivation.mockImplementation(() => {
		throw new Error("automatic release is disabled");
	});
	expect(await f.pump.tick()).toBe("reconciling");
	expect(f.mailbox.deliverPermit).toHaveBeenCalledWith(manualPermit);
	founderId = "new-founder";
	expect(await f.pump.tick()).toBe("fencing");
	expect(f.mailbox.requestFence).toHaveBeenCalledWith(
		manualPermit,
		"release_intervention",
	);
	expect(f.mailbox.deliverPermit).toHaveBeenCalledTimes(1);
});

it("lifecycle pause during a remote probe blocks a later claim but keeps unresolved recovery available", async () => {
	const f = fixture();
	f.options.probe.mockImplementationOnce(async () => {
		f.pump.pauseClaims();
		return { manifest: {}, receipt: {} };
	});
	expect(await f.pump.tick()).toBe("idle");
	expect(f.store.claimAuto).not.toHaveBeenCalled();
	const polls = f.mailbox.pending.mock.calls.length;
	expect(await f.pump.tick()).toBe("idle");
	expect(f.mailbox.pending).toHaveBeenCalledTimes(polls);
	f.unresolved(permit);
	expect(await f.pump.tick()).toBe("fencing");
	expect(f.mailbox.requestFence).toHaveBeenCalledWith(
		permit,
		"release_intervention",
	);
});
