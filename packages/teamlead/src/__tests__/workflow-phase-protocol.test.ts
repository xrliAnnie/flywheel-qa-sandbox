import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (original) => ({
	...(await original<typeof import("node:fs")>()),
}));
afterEach(() => vi.restoreAllMocks());

import {
	composeWorkflowPhaseAgent,
	loadWorkflowPhaseProtocols,
} from "../workflow-phase-protocol.js";

describe("workflow phase protocols", () => {
	it("loads the five executable types from the Bridge package", () => {
		const protocols = loadWorkflowPhaseProtocols([
			"design",
			"implement",
			"qa",
			"generic",
			"review",
			"gate",
			"land",
		]);
		expect([...protocols.keys()]).toEqual([
			"design",
			"implement",
			"qa",
			"generic",
			"review",
		]);
		for (const text of protocols.values())
			expect(text.trim().length).toBeGreaterThan(0);
		expect(protocols.get("qa")).toContain("qa-result");
	});
	it("prepends the full protocol and preserves domain bytes", () => {
		expect(
			composeWorkflowPhaseAgent({
				nodeId: "verify",
				nodeType: "qa",
				protocol: "Platform\n",
				source: "Domain\n",
			}).content,
		).toBe("Platform\n\n---\n\nDomain\n");
	});
	it("removes only an exact current managed block", () => {
		const block =
			"<!-- FLYWHEEL_PHASE_PROTOCOL:qa:BEGIN -->\nPlatform\n<!-- FLYWHEEL_PHASE_PROTOCOL:qa:END -->";
		const result = composeWorkflowPhaseAgent({
			nodeId: "verify",
			nodeType: "qa",
			protocol: "Platform\n",
			source: `Before\n${block}\nAfter`,
		});
		expect(result.content).toBe("Platform\n\n---\n\nBefore\n\nAfter");
		for (const source of [
			block.replace("Platform", "Stale"),
			block + block,
			block.replace(":END", ":BEGIN"),
			block.replaceAll(":qa:", ":implement:"),
		]) {
			expect(() =>
				composeWorkflowPhaseAgent({
					nodeId: "verify",
					nodeType: "qa",
					protocol: "Platform\n",
					source,
				}),
			).toThrow(
				"WORKFLOW_PHASE_PROTOCOL_UNAVAILABLE node=verify type=qa cause=invalid_block",
			);
		}
	});
	it("keeps complete UTF-16 content through the 40000 boundary and rejects overflow", () => {
		const prefix = "平台😀\n\n---\n\n";
		for (const length of [39999, 40000, 40001]) {
			const input = {
				nodeId: "verify",
				nodeType: "qa" as const,
				protocol: "平台😀",
				source: "文".repeat(length - prefix.length),
			};
			if (length <= 40000)
				expect(composeWorkflowPhaseAgent(input).content.length).toBe(length);
			else
				expect(() => composeWorkflowPhaseAgent(input)).toThrow(
					"cause=oversize total=40001 limit=40000",
				);
		}
	});
	it("rejects empty domain and protocol", () => {
		expect(() =>
			composeWorkflowPhaseAgent({
				nodeId: "verify",
				nodeType: "qa",
				protocol: "",
				source: "Domain",
			}),
		).toThrow("type=qa cause=empty");
		expect(() =>
			composeWorkflowPhaseAgent({
				nodeId: "verify",
				nodeType: "qa",
				protocol: "Platform",
				source: " \n",
			}),
		).toThrow("workflow agent content must be non-empty");
	});
});

describe("package asset failure boundary", () => {
	it.each(["missing", "empty", "unsafe_path"])(
		"rejects %s assets even after an earlier successful read",
		(cause) => {
			expect(loadWorkflowPhaseProtocols(["qa"]).get("qa")).toContain(
				"qa-result",
			);
			// No permanent process cache can hide a broken deployment on the next build.
			if (cause === "missing")
				vi.spyOn(fs, "readFileSync").mockImplementation(() => {
					throw new Error("ENOENT secret detail");
				});
			if (cause === "empty")
				vi.spyOn(fs, "readFileSync").mockReturnValue(Buffer.from(" \n"));
			if (cause === "unsafe_path")
				vi.spyOn(fs, "realpathSync")
					.mockReturnValueOnce("/package/protocols")
					.mockReturnValueOnce("/elsewhere/qa.md");
			expect(() => loadWorkflowPhaseProtocols(["qa"])).toThrow(
				`type=qa cause=${cause}`,
			);
			try {
				loadWorkflowPhaseProtocols(["qa"]);
			} catch (error) {
				expect(String(error)).not.toContain("secret detail");
			}
		},
	);
	it("does not read assets for structural gate/land nodes", () => {
		const read = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
			throw new Error("unexpected read");
		});
		expect(loadWorkflowPhaseProtocols(["gate", "land"]).size).toBe(0);
		expect(read).not.toHaveBeenCalled();
	});
});

it.each([Buffer.from([0xff]), Buffer.from("FLYWHEEL_PHASE_PROTOCOL:qa:BEGIN")])(
	"rejects corrupt canonical asset bytes",
	(bytes) => {
		vi.spyOn(fs, "readFileSync").mockReturnValue(bytes);
		expect(() => loadWorkflowPhaseProtocols(["qa"])).toThrow(
			"WORKFLOW_PHASE_PROTOCOL_UNAVAILABLE",
		);
	},
);
