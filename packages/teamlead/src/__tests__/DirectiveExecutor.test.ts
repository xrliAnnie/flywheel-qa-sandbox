import type { AuditDirective, Directive } from "flywheel-core";
import { beforeEach, describe, expect, it } from "vitest";
import { DirectiveExecutor } from "../DirectiveExecutor.js";
import { StateStore } from "../StateStore.js";

describe("DirectiveExecutor", () => {
	let store: StateStore;
	let executor: DirectiveExecutor;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		executor = new DirectiveExecutor(store);
	});

	function makeAudit(overrides: Partial<AuditDirective> = {}): AuditDirective {
		return {
			type: "audit",
			executionId: "exec-1",
			issueId: "GEO-42",
			projectName: "geoforge3d",
			fromState: "running",
			toState: "completed",
			trigger: "session_completed",
			...overrides,
		};
	}

	it("writes audit directive to session_events", async () => {
		const results = await executor.drain([makeAudit()]);
		expect(results).toHaveLength(1);
		expect(results[0]!.type).toBe("audit");
		expect(results[0]!.success).toBe(true);

		const events = store.getEventsByExecution("exec-1");
		expect(events).toHaveLength(1);
		expect(events[0]!.event_type).toBe("state_transition");
		expect(events[0]!.source).toBe("fsm");
		const payload = events[0]!.payload as {
			from: string;
			to: string;
			trigger: string;
		};
		expect(payload.from).toBe("running");
		expect(payload.to).toBe("completed");
		expect(payload.trigger).toBe("session_completed");
	});

	it("drains multiple audit directives sequentially", async () => {
		const directives = [
			makeAudit({
				fromState: "pending",
				toState: "running",
				trigger: "session_started",
			}),
			makeAudit({
				fromState: "running",
				toState: "completed",
				trigger: "session_completed",
			}),
		];
		const results = await executor.drain(directives);
		expect(results).toHaveLength(2);
		expect(results.every((r) => r.success)).toBe(true);

		const events = store.getEventsByExecution("exec-1");
		expect(events).toHaveLength(2);
		// Order preserved
		expect((events[0]!.payload as { from: string }).from).toBe("pending");
		expect((events[1]!.payload as { from: string }).from).toBe("running");
	});

	it("returns empty array for empty directives", async () => {
		const results = await executor.drain([]);
		expect(results).toHaveLength(0);
	});

	it("returns error for unknown directive type", async () => {
		const unknown = { type: "notify" } as unknown as Directive;
		const results = await executor.drain([unknown]);
		expect(results).toHaveLength(1);
		expect(results[0]!.success).toBe(false);
		expect(results[0]!.error).toContain("Unknown directive type");
	});
});
