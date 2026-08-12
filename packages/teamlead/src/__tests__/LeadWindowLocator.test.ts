import { describe, expect, it } from "vitest";
import { locateLeadWindow } from "../LeadWindowLocator.js";
import { deriveLeadSocketPath } from "../lead-address.js";

describe("LeadWindowLocator", () => {
	it("resolves the canonical private socket and immutable %0 body pane", async () => {
		const calls: string[][] = [];
		const socketPath = deriveLeadSocketPath(
			"geo/product-lead",
			"/tmp/fw-state",
		);
		const result = await locateLeadWindow("geo", "product-lead", {
			stateDir: "/tmp/fw-state",
			manifest: { projectName: "geo", leadId: "product-lead", socketPath },
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

	it("fails closed when manifest socket is not canonical", async () => {
		const result = await locateLeadWindow("geo", "product-lead", {
			stateDir: "/tmp/fw-state",
			manifest: {
				projectName: "geo",
				leadId: "product-lead",
				socketPath: "/tmp/attacker.sock",
			},
			execFn: async () => ({ stdout: "", stderr: "" }),
		});
		expect(result).toBeNull();
	});
});
