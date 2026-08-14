import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("retired runtime removal", () => {
	it.each([
		new URL(
			`../lead-backends/codex/${["LeadHealth", "Probe.ts"].join("")}`,
			import.meta.url,
		),
		new URL(
			`../bridge/${["lead-event-ack", "policy.ts"].join("-")}`,
			import.meta.url,
		),
	])("removes %s", (path) => {
		expect(existsSync(path)).toBe(false);
	});

	it("removes the old loop-guard module name", () => {
		expect(
			existsSync(
				new URL(
					`../bridge/${["BridgeEventLoopWatch", "dog.ts"].join("")}`,
					import.meta.url,
				),
			),
		).toBe(false);
	});

	it("removes the old founder-reply reconcile module name", () => {
		expect(
			existsSync(
				new URL(
					`../bridge/${["founder-reply-watch", "dog.ts"].join("")}`,
					import.meta.url,
				),
			),
		).toBe(false);
	});

	it("removes the old liveness module names", () => {
		for (const stem of ["health", "minimum-set"]) {
			expect(
				existsSync(
					new URL(
						`../bridge/${["watch", `dog-${stem}.ts`].join("")}`,
						import.meta.url,
					),
				),
			).toBe(false);
		}
	});
});
