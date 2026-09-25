import { describe, expect, it } from "vitest";
import {
	type LeadWindowRef,
	locateLeadWindow,
	readV2LeadClaudePid,
} from "../LeadWindowLocator.js";
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

describe("readV2LeadClaudePid (FLY-2882 design-correction C2)", () => {
	const window: LeadWindowRef = {
		windowId: "%0",
		windowName: "main",
		carrier: "v2",
		socketPath: "/tmp/fw-test.sock",
		sessionTarget: "=main",
		bodyPaneTarget: "%0",
	};
	const PS = [
		"    1     0 launchd",
		"90680 90679 bash",
		"19966 90680 2.1.282",
		"20692 19966 node",
		"20800 90680 sleep",
		"30000     1 Google Chrome H",
	].join("\n");
	function runner(over: { pane?: string; ps?: string; throwOn?: string } = {}) {
		const calls: Array<[string, string[]]> = [];
		const fn = async (file: string, args: readonly string[]) => {
			calls.push([file, [...args]]);
			if (over.throwOn === file) throw new Error(`${file} failed`);
			if (file === "tmux")
				return { stdout: over.pane ?? "%0\t0\t90680\n", stderr: "" };
			return { stdout: `${over.ps ?? PS}\n`, stderr: "" };
		};
		return { fn, calls };
	}

	it("returns the single Claude child of the pane's lead-body shell (metadata only)", async () => {
		const r = runner();
		expect(await readV2LeadClaudePid(window, r.fn)).toEqual({
			state: "running",
			pid: "19966",
		});
		expect(r.calls).toEqual([
			[
				"tmux",
				[
					"-S",
					"/tmp/fw-test.sock",
					"list-panes",
					"-t",
					"%0",
					"-F",
					"#{pane_id}\t#{pane_dead}\t#{pane_pid}",
				],
			],
			["ps", ["-A", "-o", "pid=,ppid=,ucomm="]],
		]);
	});

	it("accepts a child named claude", async () => {
		const r = runner({ ps: "90680 1 bash\n555 90680 claude" });
		expect(await readV2LeadClaudePid(window, r.fn)).toEqual({
			state: "running",
			pid: "555",
		});
	});

	it("answers absent when the shell is alive but no Claude child exists (old screen left behind)", async () => {
		const r = runner({
			ps: "90680 1 bash\n20800 90680 sleep\n19966 42 2.1.282",
		});
		expect(await readV2LeadClaudePid(window, r.fn)).toEqual({
			state: "absent",
		});
	});

	it.each([
		[
			"two Claude children",
			{ ps: "90680 1 bash\n1 90680 2.1.282\n2 90680 claude" },
		],
		["a dead pane", { pane: "%0\t1\t90680\n" }],
		["a different pane id", { pane: "%3\t0\t90680\n" }],
		["two panes", { pane: "%0\t0\t90680\n%0\t0\t90681\n" }],
		["a non-numeric pane pid", { pane: "%0\t0\tabc\n" }],
		["a pane pid missing from ps", { ps: "1 0 launchd" }],
		["a pane pid that is not bash", { ps: "90680 1 zsh\n19966 90680 2.1.282" }],
		["a tmux failure", { throwOn: "tmux" }],
		["a ps failure", { throwOn: "ps" }],
	])("answers indeterminate for %s", async (_label, over) => {
		const r = runner(over);
		expect(await readV2LeadClaudePid(window, r.fn)).toEqual({
			state: "indeterminate",
		});
	});
});
