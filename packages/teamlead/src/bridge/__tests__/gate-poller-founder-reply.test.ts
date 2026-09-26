import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatePoller, type GatePollerConfig } from "../gate-poller.js";

const OWNER = "123456789012345678";

function makePoller(over: Partial<GatePollerConfig> = {}) {
	return new GatePoller({
		pollIntervalMs: 3_000,
		projects: [], // empty → poll() skips the relay loop; the Part B pass runs over nothing
		store: {} as unknown as GatePollerConfig["store"],
		runtimeRegistry: {} as unknown as GatePollerConfig["runtimeRegistry"],
		chatThreadsEnabled: true,
		discordOwnerUserId: OWNER,
		founderReplyDeliverEveryNTicks: 3,
		...over,
	});
}

type Priv = {
	poll(): Promise<void>;
	founderReplyDeliverPass(): Promise<void>;
	config: { projects: unknown };
};
async function tick(poller: GatePoller, n: number) {
	for (let i = 0; i < n; i++) await (poller as unknown as Priv).poll();
}

describe("FLY-605 GatePoller founder-reply deliver pass wiring (Part B)", () => {
	let envBak: string | undefined;
	beforeEach(() => {
		envBak = process.env.FLYWHEEL_FOUNDER_REPLY_DELIVER;
		delete process.env.FLYWHEEL_FOUNDER_REPLY_DELIVER;
	});
	afterEach(() => {
		if (envBak === undefined) delete process.env.FLYWHEEL_FOUNDER_REPLY_DELIVER;
		else process.env.FLYWHEEL_FOUNDER_REPLY_DELIVER = envBak;
		vi.restoreAllMocks();
	});

	it("slow sub-cadence: pass fires on tickCount % N === 1, not every 3s tick", async () => {
		const poller = makePoller();
		const spy = vi
			.spyOn(poller as unknown as Priv, "founderReplyDeliverPass")
			.mockResolvedValue(undefined);
		await tick(poller, 7); // fires at ticks 1, 4, 7
		expect(spy).toHaveBeenCalledTimes(3);
	});

	it("env FLYWHEEL_FOUNDER_REPLY_DELIVER=0 → pass never runs", async () => {
		process.env.FLYWHEEL_FOUNDER_REPLY_DELIVER = "0";
		const poller = makePoller();
		const spy = vi
			.spyOn(poller as unknown as Priv, "founderReplyDeliverPass")
			.mockResolvedValue(undefined);
		await tick(poller, 7);
		expect(spy).not.toHaveBeenCalled();
	});

	it("missing owner / chatThreadsEnabled=false → pass early-returns (no project iteration)", async () => {
		for (const over of [
			{ discordOwnerUserId: undefined },
			{ chatThreadsEnabled: false },
			{ discordOwnerUserId: "not-a-snowflake" },
		]) {
			const projects = vi.fn(() => []);
			const poller = makePoller(over);
			// founderReplyDeliverPass should bail before touching projects.
			Object.defineProperty(poller, "config", {
				value: {
					...(poller as unknown as Priv).config,
					get projects() {
						return projects();
					},
				},
			});
			await (poller as unknown as Priv).founderReplyDeliverPass();
			expect(projects).not.toHaveBeenCalled();
		}
	});

	it("isolation: a throwing pass never breaks the poll loop", async () => {
		const poller = makePoller();
		vi.spyOn(
			poller as unknown as Priv,
			"founderReplyDeliverPass",
		).mockRejectedValue(new Error("boom"));
		await expect(tick(poller, 4)).resolves.toBeUndefined();
	});
});

import { InMemoryInboundCursorStore } from "../../lead-backends/codex/InboundCursorStore.js";

type PrivHandoff = {
	defaultReplyCursor: unknown;
	makeAmbiguousHandoff(
		lead: unknown,
		projectName: string,
	): (eventId: string, payload: Record<string, unknown>) => Promise<boolean>;
};

describe("FLY-605 ambiguous handoff durability + in-memory cursor (Codex code-review #2/#3)", () => {
	it("🔴 makeAmbiguousHandoff flushes lead_events to disk before returning true (Codex #2)", async () => {
		const flush = vi.fn();
		const store = {
			isLeadEventDelivered: vi.fn(() => false),
			appendLeadEvent: vi.fn(() => 42),
			markLeadEventDelivered: vi.fn(),
			recordDeliveryFailure: vi.fn(),
			flush,
		} as unknown as GatePollerConfig["store"];
		const runtimeRegistry = {
			getForLead: vi.fn(() => ({
				deliver: vi.fn(async () => ({ delivered: true })),
			})),
		} as unknown as GatePollerConfig["runtimeRegistry"];
		const poller = makePoller({ store, runtimeRegistry });
		const handoff = (poller as unknown as PrivHandoff).makeAmbiguousHandoff(
			{ agentId: "test-lead" },
			"flywheel",
		);
		const ok = await handoff("founder-reply-ambiguous-T1-m1", {
			issueId: "FLY-605",
			threadId: "T1",
			answer: "do X",
		});
		expect(ok).toBe(true);
		// flush MUST be called after markLeadEventDelivered, before the deliverer
		// advances + persists the thread cursor.
		expect(flush).toHaveBeenCalledTimes(1);
	});

	it("🔴 short-circuit (already delivered in memory) STILL flushes before returning true (Codex R2 #1)", async () => {
		// A prior pass may have set the in-memory delivered mark and then had
		// flush() throw — the cursor was NOT advanced that pass. The next pass hits
		// the isLeadEventDelivered() short-circuit, which must re-flush so the
		// cursor can never advance past a marker that never reached disk.
		const flush = vi.fn();
		const appendLeadEvent = vi.fn(() => 42);
		const store = {
			isLeadEventDelivered: vi.fn(() => true), // already delivered in memory
			appendLeadEvent,
			markLeadEventDelivered: vi.fn(),
			recordDeliveryFailure: vi.fn(),
			flush,
		} as unknown as GatePollerConfig["store"];
		const poller = makePoller({ store });
		const handoff = (poller as unknown as PrivHandoff).makeAmbiguousHandoff(
			{ agentId: "test-lead" },
			"flywheel",
		);
		const ok = await handoff("founder-reply-ambiguous-T1-m1", {
			issueId: "FLY-605",
			threadId: "T1",
			answer: "do X",
		});
		expect(ok).toBe(true);
		// re-flush on the short-circuit, and no duplicate append (we did NOT re-emit).
		expect(flush).toHaveBeenCalledTimes(1);
		expect(appendLeadEvent).not.toHaveBeenCalled();
	});

	it("🔴 short-circuit flush() failure propagates (cursor stays un-advanced) (Codex R2 #1)", async () => {
		const store = {
			isLeadEventDelivered: vi.fn(() => true),
			appendLeadEvent: vi.fn(() => 42),
			markLeadEventDelivered: vi.fn(),
			recordDeliveryFailure: vi.fn(),
			flush: vi.fn(() => {
				throw new Error("disk full");
			}),
		} as unknown as GatePollerConfig["store"];
		const poller = makePoller({ store });
		const handoff = (poller as unknown as PrivHandoff).makeAmbiguousHandoff(
			{ agentId: "test-lead" },
			"flywheel",
		);
		// flush throwing must propagate — the deliverer's per-thread catch then
		// leaves the cursor un-advanced so the message is retried.
		await expect(
			handoff("founder-reply-ambiguous-T1-m1", {
				issueId: "FLY-605",
				threadId: "T1",
				answer: "do X",
			}),
		).rejects.toThrow("disk full");
	});

	it("in-memory processed-through cursor exists when no file cursor is wired (Codex #3)", () => {
		const poller = makePoller(); // no cursorStore configured
		expect(
			(poller as unknown as PrivHandoff).defaultReplyCursor,
		).toBeInstanceOf(InMemoryInboundCursorStore);
	});
});
