import { describe, expect, it, vi } from "vitest";
import { locateLeadWindow } from "../LeadWindowLocator.js";

describe("LeadWindowLocator", () => {
	it("returns windowId + windowName for matching project-lead combo", async () => {
		const execFn = vi.fn().mockResolvedValue({
			stdout: [
				"@5 flywheel-home",
				"@7 geoforge3d-product-lead",
				"@9 geoforge3d-ops-lead",
				"",
			].join("\n"),
			stderr: "",
		});

		const result = await locateLeadWindow("geoforge3d", "product-lead", {
			execFn,
		});

		expect(result).toEqual({ windowId: "@7", windowName: "geoforge3d-product-lead" });
		expect(execFn).toHaveBeenCalledWith(
			"tmux",
			["list-windows", "-t", "flywheel", "-F", "#{window_id} #{window_name}"],
			expect.any(Object),
		);
	});

	it("returns null when no window matches", async () => {
		const execFn = vi.fn().mockResolvedValue({
			stdout: "@5 flywheel-home\n@7 geoforge3d-product-lead\n",
			stderr: "",
		});

		const result = await locateLeadWindow("geoforge3d", "cos-lead", { execFn });

		expect(result).toBeNull();
	});

	it("returns null when flywheel session is missing", async () => {
		const execFn = vi.fn().mockRejectedValue(
			Object.assign(new Error("can't find session: flywheel"), {
				code: 1,
				stderr: "can't find session: flywheel",
			}),
		);

		const result = await locateLeadWindow("geoforge3d", "product-lead", { execFn });

		expect(result).toBeNull();
	});

	it("matches exactly and ignores partial prefixes", async () => {
		const execFn = vi.fn().mockResolvedValue({
			stdout: [
				"@5 geoforge3d-product-lead-retired",
				"@7 geoforge3d-product-lead",
				"",
			].join("\n"),
			stderr: "",
		});

		const result = await locateLeadWindow("geoforge3d", "product-lead", {
			execFn,
		});

		expect(result).toEqual({ windowId: "@7", windowName: "geoforge3d-product-lead" });
	});

	it("tolerates trailing whitespace and empty lines", async () => {
		const execFn = vi.fn().mockResolvedValue({
			stdout: "\n@7 geoforge3d-product-lead   \n\n",
			stderr: "",
		});

		const result = await locateLeadWindow("geoforge3d", "product-lead", {
			execFn,
		});

		expect(result).toEqual({ windowId: "@7", windowName: "geoforge3d-product-lead" });
	});
});
