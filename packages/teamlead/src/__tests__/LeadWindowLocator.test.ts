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

		expect(result).toEqual({
			windowId: "@7",
			windowName: "geoforge3d-product-lead",
		});
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

		const result = await locateLeadWindow("geoforge3d", "product-lead", {
			execFn,
		});

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

		expect(result).toEqual({
			windowId: "@7",
			windowName: "geoforge3d-product-lead",
		});
	});

	it("tolerates trailing whitespace and empty lines", async () => {
		const execFn = vi.fn().mockResolvedValue({
			stdout: "\n@7 geoforge3d-product-lead   \n\n",
			stderr: "",
		});

		const result = await locateLeadWindow("geoforge3d", "product-lead", {
			execFn,
		});

		expect(result).toEqual({
			windowId: "@7",
			windowName: "geoforge3d-product-lead",
		});
	});

	it("v2 resolves the canonical private socket and immutable %0 body pane", async () => {
		const calls: string[][] = [];
		const socketPath =
			"/tmp/fw-state/sock/fw-geo-product-lead-1ac2981642a474b0.sock";
		const result = await locateLeadWindow("geo", "product-lead", {
			stateDir: "/tmp/fw-state",
			manifest: { projectName: "geo", leadId: "product-lead", socketPath },
			carrier: "v2",
			execFn: async (file, args) => {
				calls.push([...args]);
				if (file === "ps") {
					return {
						stdout:
							"/bin/bash /repo/packages/teamlead/scripts/lead-body.sh /manifest\n",
						stderr: "",
					};
				}
				return {
					stdout:
						"%0\tmain\tbash /repo/packages/teamlead/scripts/lead-body.sh /manifest\tclaude\t0\t4242\n",
					stderr: "",
				};
			},
		});

		expect(result).toEqual({
			windowId: "%0",
			windowName: "main",
			carrier: "v2",
			socketPath,
			sessionTarget: "=main",
			bodyPaneTarget: "%0",
		});
		expect(calls[0]).toEqual([
			"-S",
			socketPath,
			"list-panes",
			"-t",
			"%0",
			"-F",
			"#{pane_id}\t#{session_name}\t#{pane_start_command}\t#{pane_current_command}\t#{pane_dead}\t#{pane_pid}",
		]);
		expect(calls[1]).toEqual(["-p", "4242", "-o", "command="]);
	});

	it("v2 fails closed when manifest socket is not canonical", async () => {
		const result = await locateLeadWindow("geo", "product-lead", {
			stateDir: "/tmp/fw-state",
			manifest: {
				projectName: "geo",
				leadId: "product-lead",
				socketPath: "/tmp/attacker.sock",
			},
			carrier: "v2",
			execFn: async () => ({ stdout: "", stderr: "" }),
		});
		expect(result).toBeNull();
	});
});
