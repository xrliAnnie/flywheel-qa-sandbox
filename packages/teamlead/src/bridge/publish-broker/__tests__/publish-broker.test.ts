/**
 * FLY-1062 broker PR · PublishBroker core semantics (plan §3):
 * approval tuple binding, single consumption, consume-after-success,
 * reaction-observation ingress, replay immunity, token fail-closed.
 */
import { describe, expect, it } from "vitest";
import { ApprovalRegistry } from "../approval-registry.js";
import {
	type ApprovalCardSurface,
	PublishBroker,
	type PublishBrokerOptions,
} from "../publish-broker.js";
import type { PublishTuple } from "../types.js";
import { validatePublishRequest } from "../types.js";

const FOUNDER = "founder-1";
const SHA = "a".repeat(64);
const TUPLE: PublishTuple = {
	action: "publish-release",
	releaseId: "rel-1",
	sha256: SHA,
};

function makeCard(overrides: Partial<ApprovalCardSurface> = {}) {
	const posts: string[] = [];
	let reacted = false;
	const card: ApprovalCardSurface = {
		post: async (text) => {
			posts.push(text);
			return { channelId: "chan-1", messageId: `msg-${posts.length}` };
		},
		fetcher: async () => ({
			status: 200,
			body: reacted ? [{ id: FOUNDER }] : [],
		}),
		founderId: FOUNDER,
		...overrides,
	};
	return {
		card,
		posts,
		react() {
			reacted = true;
		},
	};
}

function makeBroker(opts: Partial<PublishBrokerOptions> = {}) {
	const audit: Record<string, unknown>[] = [];
	const calls: { action: string; releaseId: string; token: string }[] = [];
	const broker = new PublishBroker({
		tokens: { customerRelease: "crt-token", npmGat: "gat-token" },
		executors: {
			publishRelease: async (req, token) => {
				calls.push({
					action: "publish-release",
					releaseId: req.releaseId,
					token,
				});
				return { ver: "1.2.3" };
			},
			publishShell: async (req, token) => {
				calls.push({
					action: "publish-shell",
					releaseId: req.releaseId,
					token,
				});
				return { name: "@flywheel/onboard", version: "0.1.0" };
			},
		},
		audit: (e) => audit.push(e),
		card: null,
		...opts,
	});
	return { broker, audit, calls };
}

describe("validatePublishRequest (untrusted boundary)", () => {
	it("rejects malformed shapes fail-closed", () => {
		for (const bad of [
			null,
			[],
			{ action: "rm-rf" },
			{ action: "publish-release", releaseId: "", sha256: SHA },
			{ action: "publish-release", releaseId: "ok", sha256: "not-hex" },
			{ action: "publish-shell", releaseId: "ok", sha256: SHA }, // no stagedPath
			{
				action: "publish-shell",
				releaseId: "ok",
				sha256: SHA,
				stagedPath: "relative/path.tgz",
			},
		]) {
			expect(validatePublishRequest(bad).ok).toBe(false);
		}
	});
});

describe("ApprovalRegistry", () => {
	it("registers, finds, consumes exactly once", () => {
		const reg = new ApprovalRegistry();
		expect(reg.register(TUPLE, "reaction:m1")).toBe(true);
		expect(reg.find(TUPLE)?.approverRef).toBe("reaction:m1");
		expect(reg.consume(TUPLE)).toBe(true);
		expect(reg.find(TUPLE)).toBeNull();
		expect(reg.consume(TUPLE)).toBe(false);
	});

	it("same tuple unconsumed → idempotent register keeps the first", () => {
		const reg = new ApprovalRegistry();
		reg.register(TUPLE, "reaction:m1");
		expect(reg.register(TUPLE, "reaction:m2")).toBe(false);
		expect(reg.find(TUPLE)?.approverRef).toBe("reaction:m1");
	});

	it("consumed replay with the SAME approverRef is a no-op (replay guard)", () => {
		const reg = new ApprovalRegistry();
		reg.register(TUPLE, "reaction:m1");
		reg.consume(TUPLE);
		expect(reg.register(TUPLE, "reaction:m1")).toBe(false);
		expect(reg.find(TUPLE)).toBeNull();
	});

	it("a genuinely NEW approval (new approverRef) after consumption is honored", () => {
		const reg = new ApprovalRegistry();
		reg.register(TUPLE, "reaction:m1");
		reg.consume(TUPLE);
		expect(reg.register(TUPLE, "reaction:m9")).toBe(true);
		expect(reg.find(TUPLE)?.approverRef).toBe("reaction:m9");
	});

	it("find requires the EXACT tuple", () => {
		const reg = new ApprovalRegistry();
		reg.register(TUPLE, "reaction:m1");
		expect(reg.find({ ...TUPLE, sha256: "b".repeat(64) })).toBeNull();
		expect(reg.find({ ...TUPLE, releaseId: "rel-2" })).toBeNull();
		expect(reg.find({ ...TUPLE, action: "publish-shell" })).toBeNull();
	});
});

describe("PublishBroker", () => {
	it("request without approval parks pending; card posted exactly once", async () => {
		const { card, posts } = makeCard();
		const { broker, calls } = makeBroker({ card });
		const r1 = await broker.handleRequest(TUPLE);
		expect(r1.status).toBe("pending_approval");
		expect(r1.reason).toBe("awaiting_founder_approval");
		const r2 = await broker.handleRequest(TUPLE);
		expect(r2.status).toBe("pending_approval");
		expect(posts.filter((p) => p.includes("发布审批请求")).length).toBe(1);
		expect(posts[0]).toContain("rel-1");
		expect(posts[0]).toContain(SHA);
		expect(calls.length).toBe(0);
	});

	it("no approval surface configured → pending with explicit reason", async () => {
		const { broker, calls } = makeBroker({ card: null });
		const r = await broker.handleRequest(TUPLE);
		expect(r.status).toBe("pending_approval");
		expect(r.reason).toBe("approval_surface_unconfigured");
		expect(calls.length).toBe(0);
	});

	it("founder ✅ on the card → register + execute + consume + pending cleared", async () => {
		const { card, posts, react } = makeCard();
		const { broker, calls, audit } = makeBroker({ card });
		await broker.handleRequest(TUPLE);
		await broker.pollApprovals(); // not yet reacted
		expect(calls.length).toBe(0);
		react();
		await broker.pollApprovals();
		expect(calls).toEqual([
			{ action: "publish-release", releaseId: "rel-1", token: "crt-token" },
		]);
		expect(broker.pendingCount()).toBe(0);
		// another poll must NOT re-execute (pending gone, approval consumed)
		await broker.pollApprovals();
		expect(calls.length).toBe(1);
		expect(posts.some((p) => p.includes("已执行"))).toBe(true);
		const outcomes = audit.map((a) => a.outcome);
		expect(outcomes).toContain("approval_registered");
		expect(outcomes).toContain("executed");
	});

	it("a replayed request AFTER consumption is refused (no_approval), never re-executed", async () => {
		const { card, react } = makeCard();
		const { broker, calls } = makeBroker({ card });
		await broker.handleRequest(TUPLE);
		react();
		await broker.pollApprovals();
		expect(calls.length).toBe(1);
		const replay = await broker.handleRequest(TUPLE);
		// no unconsumed approval → back to pending (a NEW approval is required)
		expect(replay.status).toBe("pending_approval");
		expect(calls.length).toBe(1);
	});

	it("consume-after-success: executor failure keeps the approval; retry succeeds", async () => {
		const { card, react } = makeCard();
		let failures = 1;
		const audit: Record<string, unknown>[] = [];
		const calls: string[] = [];
		const broker = new PublishBroker({
			tokens: { customerRelease: "crt-token" },
			executors: {
				publishRelease: async (req) => {
					calls.push(req.releaseId);
					if (failures-- > 0) throw new Error("endpoint down");
					return { ver: "1.2.3" };
				},
				publishShell: async () => ({}),
			},
			audit: (e) => audit.push(e),
			card,
		});
		await broker.handleRequest(TUPLE);
		react();
		await broker.pollApprovals(); // fails — approval must survive
		expect(calls.length).toBe(1);
		expect(broker.pendingCount()).toBe(1);
		await broker.pollApprovals(); // retry with the SAME approval → succeeds
		expect(calls.length).toBe(2);
		expect(broker.pendingCount()).toBe(0);
		expect(audit.map((a) => a.outcome)).toContain("execution_failed");
		expect(audit.map((a) => a.outcome)).toContain("executed");
		// the register audit fired ONCE (idempotent re-observation)
		expect(
			audit.filter((a) => a.outcome === "approval_registered").length,
		).toBe(1);
	});

	it("missing token → refused token_not_provisioned, approval NOT consumed", async () => {
		const { card, react } = makeCard();
		const { broker, calls } = makeBroker({
			card,
			tokens: {}, // nothing provisioned
		});
		await broker.handleRequest(TUPLE);
		react();
		await broker.pollApprovals();
		expect(calls.length).toBe(0);
		// approval registered but unconsumed → a direct request still refuses on token
		broker.registerFounderApproval(TUPLE, "reaction:manual"); // idempotent no-op
		const r = await broker.handleRequest(TUPLE);
		expect(r.status).toBe("refused");
		expect(r.reason).toBe("token_not_provisioned");
	});

	it("pre-registered approval lets a direct request execute (shell path + token routing)", async () => {
		const { broker, calls } = makeBroker();
		const shellTuple: PublishTuple = {
			action: "publish-shell",
			releaseId: "shell-0.1.0",
			sha256: SHA,
		};
		broker.registerFounderApproval(shellTuple, "reaction:m7");
		const r = await broker.handleRequest({
			...shellTuple,
			stagedPath: "/tmp/staged.tgz",
		});
		expect(r.status).toBe("executed");
		expect(calls).toEqual([
			{ action: "publish-shell", releaseId: "shell-0.1.0", token: "gat-token" },
		]);
	});

	it("CONCURRENT requests on one approval → exactly ONE execution (in-flight claim)", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const calls: string[] = [];
		const broker = new PublishBroker({
			tokens: { customerRelease: "crt-token" },
			executors: {
				publishRelease: async (req) => {
					calls.push(req.releaseId);
					await gate; // hold the first execution mid-flight
					return { ver: "1.2.3" };
				},
				publishShell: async () => ({}),
			},
			audit: () => {},
			card: null,
		});
		broker.registerFounderApproval(TUPLE, "reaction:m1");
		const p1 = broker.handleRequest(TUPLE);
		const p2 = broker.handleRequest(TUPLE); // races p1 before it consumes
		release?.();
		const [r1, r2] = await Promise.all([p1, p2]);
		expect(calls.length).toBe(1);
		expect([r1.status, r2.status].sort()).toEqual(["executed", "refused"]);
		const refused = [r1, r2].find((r) => r.status === "refused");
		expect(refused?.reason).toBe("execution_in_flight");
	});

	it("tokens never leak into responses or audit lines", async () => {
		const { card, react } = makeCard();
		const { broker, audit } = makeBroker({ card });
		await broker.handleRequest(TUPLE);
		react();
		await broker.pollApprovals();
		const everything = JSON.stringify({ audit });
		expect(everything).not.toContain("crt-token");
		expect(everything).not.toContain("gat-token");
	});
});
