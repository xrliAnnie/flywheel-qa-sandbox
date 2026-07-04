/**
 * FLY-696 M1/① — the SwitchDeps that drive the `flywheel-claude-profile` bash
 * script (the A-Keychain executor, landed last). applyProfile = `use <name>`
 * (throws on non-zero → fail-closed); readActiveProfile parses `status`. Exec is
 * injected so this is tested without the real script/Keychain.
 */
import { describe, expect, it, vi } from "vitest";
import { makeClaudeProfileSwitchDeps } from "../account-heal/claude-profile-cli.js";

const BIN = "/x/flywheel-claude-profile";

function deps(execFile: ReturnType<typeof vi.fn>) {
	return makeClaudeProfileSwitchDeps({
		binPath: BIN,
		execFile: execFile as never,
		withLock: async (_l, fn) => fn(),
	});
}

describe("makeClaudeProfileSwitchDeps", () => {
	it("applyProfile runs `<bin> use <name>` with the lock delegated to THIS pid", async () => {
		// FLY-852: switchAccount calls applyProfile INSIDE its withMkdirLock
		// critical section and the bash script takes the SAME lock — the child
		// must be told the parent already holds it (validated against the live
		// holder marker script-side) or it deadlocks until timeout.
		const execFile = vi.fn(async () => ({ stdout: "Switched", stderr: "" }));
		await deps(execFile).applyProfile("school");
		expect(execFile).toHaveBeenCalledWith(
			BIN,
			["use", "school"],
			expect.objectContaining({
				env: expect.objectContaining({
					FLYWHEEL_CLAUDE_LOCK_DELEGATED: String(process.pid),
				}),
			}),
		);
	});

	it("applyProfile throws when the script exits non-zero (fail-closed)", async () => {
		const execFile = vi.fn(async () => {
			throw new Error("verify failed");
		});
		await expect(deps(execFile).applyProfile("school")).rejects.toThrow(
			"verify failed",
		);
	});

	it("readActiveProfile parses `Active profile: X`", async () => {
		const execFile = vi.fn(async () => ({
			stdout: "Active profile: personal\n",
			stderr: "",
		}));
		expect(await deps(execFile).readActiveProfile()).toBe("personal");
	});

	it("readActiveProfile returns null when none is set", async () => {
		const execFile = vi.fn(async () => ({
			stdout: "No active profile set for this home.\n",
			stderr: "",
		}));
		expect(await deps(execFile).readActiveProfile()).toBeNull();
	});

	it("readActiveProfile returns null (not throw) when the script errors", async () => {
		const execFile = vi.fn(async () => {
			throw new Error("no such file");
		});
		expect(await deps(execFile).readActiveProfile()).toBeNull();
	});

	it("exposes withLock for the switch executor to serialize on", () => {
		const d = deps(vi.fn());
		expect(typeof d.withLock).toBe("function");
	});
});
