import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_LEAD_PROJECT,
	loadLeadProjectMap,
	resolveLeadProject,
} from "../lead-project.js";

describe("loadLeadProjectMap (config-derived, authoritative)", () => {
	it("derives agentId→projectName from projects.json; config overrides fallback", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-proj-"));
		const p = path.join(dir, "projects.json");
		fs.writeFileSync(
			p,
			JSON.stringify([
				{
					projectName: "geoforge3d",
					leads: [{ agentId: "cos-lead" }, { agentId: "product-lead" }],
				},
				{
					projectName: "personal-assistant",
					leads: [{ agentId: "belle-lead" }],
				},
				{ projectName: "joycon-typeless", leads: [{ agentId: "joycon-lead" }] },
			]),
		);
		try {
			const m = loadLeadProjectMap(p);
			expect(m["cos-lead"]).toBe("geoforge3d");
			expect(m["product-lead"]).toBe("geoforge3d");
			expect(m["belle-lead"]).toBe("personal-assistant");
			expect(m["joycon-lead"]).toBe("joycon-typeless");
			expect(resolveLeadProject("cos-lead", m)).toBe("geoforge3d");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("falls back to the hardcoded map when projects.json is missing", () => {
		const m = loadLeadProjectMap("/nonexistent/projects.json");
		expect(m["flywheel-eng-lead"]).toBe("flywheel");
	});

	it("falls back on malformed JSON / non-array", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-proj-"));
		const p = path.join(dir, "projects.json");
		fs.writeFileSync(p, "{ not an array }");
		try {
			expect(loadLeadProjectMap(p)["sub-lead"]).toBe("sub");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("DEFAULT_LEAD_PROJECT fallback corrected against real fleet config", () => {
	it("fixes the previously-wrong hardcoded edges", () => {
		// these were wrong before (flywheel / growth / joycon); real projects.json says:
		expect(DEFAULT_LEAD_PROJECT["cos-lead"]).toBe("geoforge3d");
		expect(DEFAULT_LEAD_PROJECT["belle-lead"]).toBe("personal-assistant");
		expect(DEFAULT_LEAD_PROJECT["joycon-lead"]).toBe("joycon-typeless");
	});
});
