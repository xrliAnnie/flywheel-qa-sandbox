import { expect, it, vi } from "vitest";
import { createTerminalSessionCore } from "../terminal-observation.js";

function fixture(legacyContract = false) {
	const session = {
		executionId: "exec1",
		projectName: "flywheel",
		leadId: "eng",
		target: "runner:0",
		status: "running",
	};
	let id = "$1:%2",
		output = "Do you want to proceed? [Y/n]";
	const send = vi.fn(
		async (_target: string, _text: string, _guard: () => Promise<void>) => {},
	);
	const core = createTerminalSessionCore({
		legacyContract,
		projectName: "flywheel",
		leadId: "eng",
		getSession: async () => ({ ...session }),
		assertCurrent: async () => {},
		inspect: async () => ({ observedSessionId: id, alive: true }),
		capture: async () => output,
		send,
	});
	return {
		core,
		session,
		send,
		setId: (next: string) => {
			id = next;
		},
		setOutput: (next: string) => {
			output = next;
		},
	};
}
it("returns the real observed session and requires it before input", async () => {
	const f = fixture();
	expect(await f.core.status("exec1")).toMatchObject({
		status: "waiting",
		observedSessionId: "$1:%2",
	});
	await f.core.input("exec1", "$1:%2", "yes");
	expect(f.send).toHaveBeenCalledWith("%2", "yes", expect.any(Function));
	await expect(f.core.input("exec1", undefined, "yes")).rejects.toThrow(
		"terminal_input_invalid",
	);
	f.setId("$3:%4");
	await expect(f.core.input("exec1", "$1:%2", "yes")).rejects.toThrow(
		"terminal_session_changed",
	);
	expect(f.send).toHaveBeenCalledOnce();
});
it("rejects cross-scope, executing and unknown sessions before input", async () => {
	const f = fixture();
	f.session.leadId = "other";
	await expect(f.core.input("exec1", "$1:%2", "yes")).rejects.toThrow(
		"terminal_scope_denied",
	);
	f.session.leadId = "eng";
	f.setOutput("Building now...");
	await expect(f.core.input("exec1", "$1:%2", "yes")).rejects.toThrow(
		"terminal_not_waiting",
	);
	f.session.status = "completed";
	await expect(f.core.input("exec1", "$1:%2", "yes")).rejects.toThrow(
		"terminal_not_running",
	);
	expect(f.send).not.toHaveBeenCalled();
});
it("rejects target/owner changes at the actual send guard", async () => {
	const f = fixture();
	f.send.mockImplementation(
		async (_target: string, _text: string, guard: () => Promise<void>) => {
			f.session.target = "replacement:0";
			await guard();
		},
	);
	await expect(f.core.input("exec1", "$1:%2", "yes")).rejects.toThrow(
		"terminal_session_changed",
	);
});

it("rejects a cross-project binding and control bytes without probing or sending", async () => {
	const f = fixture();
	f.session.projectName = "foreign";
	await expect(f.core.status("exec1")).rejects.toThrow("terminal_scope_denied");
	f.session.projectName = "flywheel";
	await expect(
		f.core.input("exec1", "$1:%2", String.fromCharCode(0)),
	).rejects.toThrow("terminal_input_invalid");
	expect(f.send).not.toHaveBeenCalled();
});

it("does not treat a prior prompt in scrollback as a live waiting state", async () => {
	const f = fixture();
	f.setOutput("Do you want to proceed? [Y/n]\nContinuing build...");
	expect((await f.core.status("exec1")).status).toBe("executing");
	await expect(f.core.input("exec1", "$1:%2", "yes")).rejects.toThrow(
		"terminal_not_waiting",
	);
	expect(f.send).not.toHaveBeenCalled();
});

it.each([
	"Bash(ls -la)\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and don't ask again\n  3. No, and tell Claude what to do differently\n\n────────────────",
	"Do you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel",
	"Do you want to proceed?\n❯ 1. Yes\n  2. No\nEnter to confirm · Esc to cancel",
	"╭─ Do you want to proceed? ────────────────────────────────────────────────────╮\n│ Edit file src/index.ts                                                       │\n│                                                                              │\n│ ❯ 1. Yes                                                                     │\n│   2. Yes, and don't ask again                                                │\n│   3. No, and tell Claude what to do differently                              │\n╰──────────────────────────────────────────────────────────────────────────────╯",
	"Do you want to proceed?\n❯ 1. Yes\n  2. Yes, and don't ask again for commands\n     matching this pattern\n  3. No\nEnter to confirm · Esc to cancel",
])("recognizes a live permission menu: %s", async (menu) => {
	const f = fixture();
	f.setOutput(menu);
	expect((await f.core.status("exec1")).status).toBe("waiting");
	await f.core.input("exec1", "$1:%2", "1");
	expect(f.send).toHaveBeenCalledOnce();
	f.setOutput(`${menu}\nContinuing build...`);
	expect((await f.core.status("exec1")).status).toBe("executing");
	await expect(f.core.input("exec1", "$1:%2", "1")).rejects.toThrow(
		"terminal_not_waiting",
	);
	expect(f.send).toHaveBeenCalledOnce();
});

it.each([
	"Do you want to proceed?\nBuild completed\n❯ 1. Yes\n  2. No\nEsc to cancel",
	"Do you want to proceed?\n❯ 1. Yes\n  2. No\nEnter to confirm · Esc to cancel\n     Build completed",
	"Do you want to proceed?\n❯ 1. Yes\n  2. No\nBuild completed · Esc to cancel",
])("rejects intervening execution output: %s", async (output) => {
	const f = fixture();
	f.setOutput(output);
	expect((await f.core.status("exec1")).status).toBe("executing");
	await expect(f.core.input("exec1", "$1:%2", "1")).rejects.toThrow(
		"terminal_not_waiting",
	);
	expect(f.send).not.toHaveBeenCalled();
});

it.each([
	"/exit",
	" /quit ",
	"/EXIT",
	"1\r/exit",
	"1\r/quit",
	"y\n/quit",
	"y\rcommand\r",
	"first\nsecond",
])("denies reserved session termination input %s in v2", async (text) => {
	const f = fixture();
	await expect(f.core.input("exec1", "$1:%2", text)).rejects.toThrow(
		"terminal_input_invalid",
	);
	expect(f.send).not.toHaveBeenCalled();
});

it.each(["1\r/exit", "1\r/quit", "first\nsecond", "/exit", "/quit"])(
	"rejects reserved or multiple submissions in reachable legacy input: %s",
	async (text) => {
		const f = fixture(true);
		await expect(f.core.input("exec1", undefined, text)).rejects.toThrow(
			"terminal_input_invalid",
		);
		expect(f.send).not.toHaveBeenCalled();
	},
);
