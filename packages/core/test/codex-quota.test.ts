import { describe, expect, it } from "vitest";
import {
	parseCodexQuotaBindingV1,
	parseCodexQuotaSignalV1,
} from "../src/codex-quota.js";

const signal = {
	version: 1,
	vendor: "codex",
	source: "goal_ended",
	sourceEventId: "event-1",
	bindingId: "binding-1",
	evidence: "usageLimited",
	observedAt: "2026-09-09T17:16:00.000Z",
};
const binding = {
	bindingId: "binding-1",
	executionId: "exec-1",
	runId: null,
	accountKey: "account-1",
	profile: "school",
	generation: 1,
	credentialRootKey: "root-1",
	purpose: "runner",
};
describe("Codex quota contracts", () => {
	it("round-trips the complete signal and trusted binding", () => {
		expect(parseCodexQuotaSignalV1(signal)).toEqual(signal);
		expect(parseCodexQuotaBindingV1(binding)).toEqual(binding);
	});
	it.each([
		{ version: 2 },
		{ vendor: "claude" },
		{ evidence: "429" },
		{ source: "pane" },
		{ observedAt: "tomorrow" },
		{ observedAt: "2026-02-30T00:00:00Z" },
		{ bindingId: "" },
		{ target: "school" },
	])("rejects invalid signal %j", (patch) =>
		expect(parseCodexQuotaSignalV1({ ...signal, ...patch })).toBeUndefined(),
	);
	it.each([
		{ generation: -1 },
		{ generation: 1.1 },
		{ generation: Number.MAX_SAFE_INTEGER + 1 },
		{ purpose: "author" },
		{ runId: 7 },
		{ executionId: "" },
		{ authPath: "/tmp/auth" },
	])("rejects invalid binding %j", (patch) =>
		expect(parseCodexQuotaBindingV1({ ...binding, ...patch })).toBeUndefined(),
	);
});

it("rejects an unbounded fractional observation timestamp", () => {
	expect(
		parseCodexQuotaSignalV1({
			...signal,
			observedAt: `2026-09-09T17:16:00.${"1".repeat(100000)}Z`,
		}),
	).toBeUndefined();
});
