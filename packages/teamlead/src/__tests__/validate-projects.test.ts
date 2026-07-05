import { describe, expect, it } from "vitest";
import {
	VALIDATE_PROJECTS_VERSION,
	validateProjectsText,
} from "../bin/validate-projects.js";

const validLead = {
	agentId: "product-lead",
	chatChannel: "1",
	match: { labels: ["Product"] },
};

describe("validate-projects CLI core (FLY-247 inc2a R2#5 / §2.6)", () => {
	it("code 0 for a valid projects.json", () => {
		const r = validateProjectsText(
			JSON.stringify([
				{ projectName: "geo", projectRoot: "/tmp", leads: [validLead] },
			]),
		);
		expect(r.code).toBe(0);
		expect(r.message).toContain(`v${VALIDATE_PROJECTS_VERSION}`);
	});

	it("code 3 for invalid JSON", () => {
		expect(validateProjectsText("{not json").code).toBe(3);
	});

	it("code 1 for a schema violation (missing leads)", () => {
		const r = validateProjectsText(
			JSON.stringify([{ projectName: "geo", projectRoot: "/tmp" }]),
		);
		expect(r.code).toBe(1);
		expect(r.message).toMatch(/INVALID/);
	});

	it("code 1 enforces the FLY-245 codex fail-close (cross-field, no jq bypass)", () => {
		const r = validateProjectsText(
			JSON.stringify([
				{
					projectName: "geo",
					projectRoot: "/tmp",
					leads: [{ ...validLead, backend: "codex-app-server" }],
				},
			]),
		);
		expect(r.code).toBe(1);
		// FLY-350: the cross-field invariant message changed (codexProfile tier
		// added) — match the stable FLY-245 marker rather than the exact prose.
		expect(r.message).toMatch(/FLY-245/);
	});

	it("code 1 rejects a non-array top-level", () => {
		expect(validateProjectsText(JSON.stringify({})).code).toBe(1);
	});
});
