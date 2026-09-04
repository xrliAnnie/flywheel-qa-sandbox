/**
 * FLY-1328 Chunk 2 — the day-scale forensic record of an ask disposal.
 *
 * The CommDB `resolved_via` stamp only survives the forensic TTL (hours). To
 * answer "who cleared this runner's asks, and when" a day later, the disposal
 * has to land in the StateStore audit log. `recordCommDbFinalizeOutcome` is the
 * one seam every finalize call site already goes through AND the one that holds
 * the issue/project context the audit needs.
 *
 * The event contract is an ASK-DISPOSITION record, not a per-finalize one: it
 * is written only when asks were actually disposed of. A finalize that retired
 * nothing must not manufacture an `owner_closed` disposition that never
 * happened, and must leave today's event set byte-identical.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

describe("FLY-1328 ask-disposal audit (StateStore.recordCommDbFinalizeOutcome)", () => {
	let store: StateStore;

	const audit = {
		retiredGateCount: 2,
		retiredAskCount: 3,
		source: "bridge.close-runner",
	};

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	afterEach(() => {
		store.close();
	});

	const disposalEvents = () => store.getEventsByType("commdb_ask_disposed");

	it("writes exactly one idempotent disposal event when asks were retired", () => {
		store.recordCommDbFinalizeOutcome({
			executionId: "exec-a",
			issueId: "FLY-1328",
			projectName: "flywheel",
			ok: true,
			runnerDeathProven: true,
			audit,
		});

		const events = disposalEvents();
		expect(events).toHaveLength(1);
		expect(events[0].event_id).toBe("commdb-ask-disposed-exec-a");
		expect(events[0].execution_id).toBe("exec-a");
		expect(events[0].issue_id).toBe("FLY-1328");
		expect(events[0].payload).toMatchObject({
			retiredGateCount: 2,
			retiredAskCount: 3,
			resolvedVia: "owner_closed",
			source: "bridge.close-runner",
		});

		// A retried finalize must not double-count the same disposal.
		store.recordCommDbFinalizeOutcome({
			executionId: "exec-a",
			issueId: "FLY-1328",
			projectName: "flywheel",
			ok: true,
			runnerDeathProven: true,
			audit,
		});
		expect(disposalEvents()).toHaveLength(1);
	});

	it("writes nothing when the finalize retired zero asks", () => {
		store.recordCommDbFinalizeOutcome({
			executionId: "exec-b",
			issueId: "FLY-1328",
			projectName: "flywheel",
			ok: true,
			runnerDeathProven: true,
			audit: {
				retiredGateCount: 1,
				retiredAskCount: 0,
				source: "bridge.close-runner",
			},
		});
		expect(disposalEvents()).toEqual([]);
	});

	it("writes nothing for a failed finalize (no disposal actually happened)", () => {
		store.recordCommDbFinalizeOutcome({
			executionId: "exec-c",
			issueId: "FLY-1328",
			projectName: "flywheel",
			ok: false,
			error: "database is locked",
			runnerDeathProven: true,
			audit: {
				retiredGateCount: 0,
				retiredAskCount: 0,
				source: "bridge.close-runner",
			},
		});
		expect(disposalEvents()).toEqual([]);
		// The pre-existing failure ledger must still record it.
		expect(store.getCommDbFinalizeFailure("exec-c")?.attempts).toBe(1);
	});

	it("writes nothing when a caller passes no audit context at all (byte-compat)", () => {
		store.recordCommDbFinalizeOutcome({
			executionId: "exec-d",
			issueId: "FLY-1328",
			projectName: "flywheel",
			ok: true,
			runnerDeathProven: true,
		});
		expect(disposalEvents()).toEqual([]);
	});
});
