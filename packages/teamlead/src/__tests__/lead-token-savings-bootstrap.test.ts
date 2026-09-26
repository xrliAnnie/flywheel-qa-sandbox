import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { formatBootstrap } from "../bridge/bootstrap-format.js";
import type { LeadBootstrap } from "../bridge/lead-runtime.js";

const oracle = JSON.parse(
	readFileSync(
		new URL(
			"../../../../engineering/doc/FLY-2567-lead-token-savings/evidence/legacy-bootstrap-oracle.json",
			import.meta.url,
		),
		"utf8",
	),
) as {
	now: string;
	cases: { name: string; snapshot: LeadBootstrap }[];
	outputs: { backend: string; name: string; content: string }[];
};

afterEach(() => vi.useRealTimers());

for (const fixture of oracle.cases) {
	it(`OFF restores historical Bootstrap bytes: ${fixture.name}`, () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(oracle.now));
		const snapshot = {
			...structuredClone(fixture.snapshot),
			tokenSavingsEnabled: false,
		};
		for (const backend of ["mailbox", "commdb"]) {
			const expected = oracle.outputs.find(
				(row) => row.backend === backend && row.name === fixture.name,
			);
			expect(expected).toBeDefined();
			expect(formatBootstrap(snapshot)).toBe(expected!.content);
		}
	});
}

it("ON retains the bounded recovery payload", () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(oracle.now));
	const fixture = oracle.cases.find(
		(row) => row.name === "overflow-unicode-mixed",
	)!;
	const text = formatBootstrap({
		...structuredClone(fixture.snapshot),
		tokenSavingsEnabled: true,
	} as LeadBootstrap);
	expect([...text].length).toBeLessThanOrEqual(12000);
	expect(text).toContain("omittedCount=");
});

it.each([true, false])(
	"shows unknown target locks in recovery regardless of token savings (%s)",
	(tokenSavingsEnabled) => {
		const text = formatBootstrap({
			leadId: "eng",
			tokenSavingsEnabled,
			activeSessions: [],
			pendingDecisions: [],
			recentFailures: [],
			recentEvents: [],
			memoryRecall: null,
			targetLocks: [
				{
					targetKey: "flywheel:linear:fly-2886",
					requestId: "10000000-0000-4000-8000-000000000001",
					reason: "operation_timeout",
					blockedForMs: 40_000,
				},
			],
		});
		expect(text).toContain("受阻写入");
		expect(text).toContain("flywheel:linear:fly-2886");
		expect(text).toContain("10000000-0000-4000-8000-000000000001");
		expect(text).toContain("40 秒");
	},
);
