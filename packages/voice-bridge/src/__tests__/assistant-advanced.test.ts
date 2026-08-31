import { describe, expect, it } from "vitest";
import { buildAdvancedDelegateTool } from "../assistant/advanced.js";
import { resolveAssistantConfig } from "../assistant/config.js";

const rawProjects = (assistant: Record<string, unknown>) => [
	{ huddle: { assistant } },
];

describe("retired assistant.advanced mode", () => {
	it("keeps the plain assistant byte-compatible", () => {
		expect(
			resolveAssistantConfig(rawProjects({}), {})?.advanced,
		).toBeUndefined();
	});

	it("rejects the config block with removal guidance", () => {
		expect(() =>
			resolveAssistantConfig(
				rawProjects({ advanced: { leadId: "qa-lead" } }),
				{},
			),
		).toThrow(/advanced.*retired.*remove/i);
	});

	it("cannot build the retired delegate through a hand-constructed config", () => {
		expect(() =>
			buildAdvancedDelegateTool({
				advanced: { leadId: "qa-lead" },
				projectName: "flywheel",
				env: {},
				speak: () => {},
				log: () => {},
			}),
		).toThrow(/advanced.*retired.*remove/i);
	});
});
