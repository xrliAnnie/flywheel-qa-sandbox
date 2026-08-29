/**
 * FLY-1048 PR-C (C3-w): the per-project `detection` block — PRD §4.3's
 * "~30min Lead grace is global + per-project 可配" knob. Follows the `qa`
 * block's contract: absent = no override (byte-compatible), and a malformed
 * block fails the WHOLE load loudly (a fat-fingered tuning knob must never
 * be silently reinterpreted).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigLoader } from "../ConfigLoader.js";

const BASE = `
project: test-project
linear:
  team_id: "TEAM-1"
runners:
  default: claude
  available:
    claude:
      type: claude
teams:
  - name: dev
    orchestrators:
      - type: code
        runner: claude
        budget_per_issue: 5.0
decision_layer:
  autonomy_level: observer
  escalation_channel: "#dev"
`;

describe("ConfigLoader — detection block (FLY-1048 C3-w)", () => {
	let readFile: ReturnType<typeof vi.fn>;
	let loader: ConfigLoader;

	beforeEach(() => {
		readFile = vi.fn();
		loader = new ConfigLoader(readFile);
	});

	it("absent detection block loads with detection undefined (byte-compat)", async () => {
		readFile.mockResolvedValue(BASE);
		const config = await loader.load("/p/.flywheel/config.yaml");
		expect(config.detection).toBeUndefined();
	});

	it("accepts a valid lead_grace_ms", async () => {
		readFile.mockResolvedValue(`${BASE}detection:\n  lead_grace_ms: 600000\n`);
		const config = await loader.load("/p/.flywheel/config.yaml");
		expect(config.detection?.lead_grace_ms).toBe(600_000);
	});

	it("accepts an empty detection block (lead_grace_ms optional)", async () => {
		readFile.mockResolvedValue(`${BASE}detection: {}\n`);
		const config = await loader.load("/p/.flywheel/config.yaml");
		expect(config.detection).toEqual({});
	});

	it("rejects a non-mapping detection block", async () => {
		readFile.mockResolvedValue(`${BASE}detection: 42\n`);
		await expect(loader.load("/p/.flywheel/config.yaml")).rejects.toThrow(
			/detection must be a YAML mapping/,
		);
	});

	it("rejects a non-integer lead_grace_ms", async () => {
		readFile.mockResolvedValue(`${BASE}detection:\n  lead_grace_ms: "30min"\n`);
		await expect(loader.load("/p/.flywheel/config.yaml")).rejects.toThrow(
			/detection\.lead_grace_ms must be a positive integer/,
		);
	});

	it("rejects a non-positive lead_grace_ms", async () => {
		readFile.mockResolvedValue(`${BASE}detection:\n  lead_grace_ms: 0\n`);
		await expect(loader.load("/p/.flywheel/config.yaml")).rejects.toThrow(
			/detection\.lead_grace_ms must be a positive integer/,
		);
	});
});
