import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { persistRunnerMemoryCloseout } from "../bridge/workflow-decision-routes.js";

const snapshot = {
	lines: 3,
	linesExact: true,
	bytes: 113,
	sha16: "0123456789abcdef",
	topicFiles: 0,
};
const receipt = {
	v: 1,
	state: "unchanged",
	dir: "/tmp/flywheel/qa",
	measuredAt: "2026-09-04T00:00:00.000Z",
	spawn: snapshot,
	closeout: { ...snapshot, overBudget: false, overHard: false },
	delta: { indexChanged: false, lines: 0, topicFiles: 0 },
};

afterEach(() => vi.restoreAllMocks());

describe("FLY-2148 workflow decision closeout persistence", () => {
	it("persists a valid receipt without changing the decision response path", () => {
		const patchSessionMetadata = vi.fn();
		persistRunnerMemoryCloseout(
			{ patchSessionMetadata },
			"qa-exec",
			receipt,
			"[workflow-decision]",
		);
		expect(patchSessionMetadata).toHaveBeenCalledWith("qa-exec", {
			runner_memory_closeout: "unchanged",
			runner_memory_receipt: JSON.stringify(receipt),
		});
	});

	it("rejects malformed input and contains storage failures", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const malformedPatch = vi.fn();
		persistRunnerMemoryCloseout(
			{ patchSessionMetadata: malformedPatch },
			"qa-exec",
			{ ...receipt, v: 2 },
			"[workflow-decision]",
		);
		expect(malformedPatch).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("receipt rejected exec=qa-exec"),
		);

		persistRunnerMemoryCloseout(
			{
				patchSessionMetadata: vi.fn(() => {
					throw new Error("disk unavailable");
				}),
			},
			"qa-exec",
			receipt,
			"[workflow-decision]",
		);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("persist failed exec=qa-exec: disk unavailable"),
		);
	});

	it("is silent for old clients and is called at both accepted decision exits", () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const patchSessionMetadata = vi.fn();
		persistRunnerMemoryCloseout(
			{ patchSessionMetadata },
			"qa-exec",
			undefined,
			"[workflow-decision]",
		);
		expect(patchSessionMetadata).not.toHaveBeenCalled();
		expect(info).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();

		const source = readFileSync(
			fileURLToPath(
				new URL("../bridge/workflow-decision-routes.ts", import.meta.url),
			),
			"utf8",
		);
		const handler = source.slice(
			source.indexOf('router.post("/decision"'),
			source.indexOf('router.post("/re-qa/stage"'),
		);
		expect(handler.match(/persistRunnerMemoryCloseout\(/g)).toHaveLength(2);
	});
});
