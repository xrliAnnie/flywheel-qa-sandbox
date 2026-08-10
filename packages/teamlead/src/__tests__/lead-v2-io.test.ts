import { describe, expect, it, vi } from "vitest";
import { defaultLeadPaneCapture } from "../bridge/lead-alert-helpers.js";
import { sendEnterToWindow } from "../bridge/tmux-lookup.js";
import type { LeadWindowRef } from "../LeadWindowLocator.js";

const v2Window: LeadWindowRef = {
	carrier: "v2",
	windowId: "%0",
	windowName: "main",
	socketPath: "/tmp/state/sock/fw-demo-0123456789abcdef.sock",
	sessionTarget: "=main",
	bodyPaneTarget: "%0",
};

describe("private Lead terminal I/O", () => {
	it("captures v2 only through its canonical private socket", async () => {
		const execFn = vi.fn(async (file: string, args: string[]) => {
			if (file === "ps") {
				return {
					stdout: "/bin/bash /bin/lead-body.sh /manifest\n",
					stderr: "",
				};
			}
			if (args.includes("list-panes")) {
				return {
					stdout: "%0\tmain\tbash /bin/lead-body.sh /manifest\tclaude\t0\t42\n",
					stderr: "",
				};
			}
			return { stdout: "pane\n", stderr: "" };
		});
		const capture = defaultLeadPaneCapture("flywheel", execFn);

		await expect(capture(v2Window, 200)).resolves.toBe("pane\n");
		expect(execFn).toHaveBeenLastCalledWith(
			"tmux",
			[
				"-S",
				v2Window.socketPath,
				"capture-pane",
				"-t",
				"%0",
				"-p",
				"-S",
				"-200",
			],
			{ encoding: "utf-8", timeout: 5000 },
		);
	});

	it("preserves the shared-server v1 capture contract", async () => {
		const execFn = vi.fn().mockResolvedValue({ stdout: "pane\n", stderr: "" });
		const capture = defaultLeadPaneCapture("flywheel", execFn);

		await capture({ windowId: "@7", windowName: "demo-ops" }, 20);
		expect(execFn).toHaveBeenCalledWith(
			"tmux",
			["capture-pane", "-t", "@7", "-p", "-S", "-20"],
			{ encoding: "utf-8", timeout: 5000 },
		);
	});

	it("sends Enter to v2 only through the private socket", async () => {
		const execFn = vi.fn(async (file: string, args: string[]) => {
			if (file === "ps") {
				return {
					stdout: "/bin/bash /bin/lead-body.sh /manifest\n",
					stderr: "",
				};
			}
			if (args.includes("list-panes")) {
				return {
					stdout: "%0\tmain\tbash /bin/lead-body.sh /manifest\tclaude\t0\t42\n",
					stderr: "",
				};
			}
			return { stdout: "", stderr: "" };
		});

		await expect(sendEnterToWindow(v2Window, execFn)).resolves.toEqual({
			sent: true,
		});
		expect(execFn).toHaveBeenLastCalledWith(
			"tmux",
			["-S", v2Window.socketPath, "send-keys", "-t", "%0", "Enter"],
			{ timeout: 5000 },
		);
	});

	it("refuses Enter while %0 is an assembly shell rather than Claude", async () => {
		const execFn = vi.fn(async (file: string, _args: string[]) => {
			if (file === "ps") {
				return {
					stdout: "/bin/bash /bin/lead-body.sh /manifest\n",
					stderr: "",
				};
			}
			return {
				stdout: "%0\tmain\tbash /bin/lead-body.sh /manifest\tzsh\t0\t42\n",
				stderr: "",
			};
		});
		await expect(sendEnterToWindow(v2Window, execFn)).resolves.toEqual({
			sent: false,
			error: "private Lead body pane is not a proven Claude foreground",
		});
		expect(
			execFn.mock.calls.some((call) => call[1].includes("send-keys")),
		).toBe(false);
	});
});
