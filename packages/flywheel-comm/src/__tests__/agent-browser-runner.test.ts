import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { execFileSyncMock } = vi.hoisted(() => ({
	execFileSyncMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:child_process")>();
	return { ...original, execFileSync: execFileSyncMock };
});

import {
	AGENT_BROWSER_CALL_TIMEOUT_MS,
	defaultRunAgentBrowser,
} from "../agent-browser-runner.js";

describe("defaultRunAgentBrowser", () => {
	beforeEach(() => {
		execFileSyncMock.mockReset();
	});

	it("returns JSON stdout and bounds the call while forwarding cwd/env", () => {
		const env = { PATH: "/test/bin", AGENT_BROWSER_SESSION: "shared" };
		execFileSyncMock.mockReturnValue('{"data":{"sessions":[]}}');

		expect(
			defaultRunAgentBrowser(["session", "list", "--json"], {
				cwd: "/tmp/capture",
				env,
			}),
		).toBe('{"data":{"sessions":[]}}');
		expect(execFileSyncMock).toHaveBeenCalledWith(
			"agent-browser",
			["session", "list", "--json"],
			{
				encoding: "utf8",
				stdio: ["pipe", "pipe", "inherit"],
				cwd: "/tmp/capture",
				env,
				timeout: AGENT_BROWSER_CALL_TIMEOUT_MS,
			},
		);
		expect(AGENT_BROWSER_CALL_TIMEOUT_MS).toBe(15_000);
	});

	it("returns undefined and applies the same bound to non-JSON calls", () => {
		const env = { PATH: "/test/bin" };

		expect(
			defaultRunAgentBrowser(["record", "stop"], {
				cwd: "/tmp/capture",
				env,
			}),
		).toBeUndefined();
		expect(execFileSyncMock).toHaveBeenCalledWith(
			"agent-browser",
			["record", "stop"],
			{
				stdio: ["pipe", "inherit", "inherit"],
				cwd: "/tmp/capture",
				env,
				timeout: AGENT_BROWSER_CALL_TIMEOUT_MS,
			},
		);
	});

	it(
		"times out a hanging process tree near the fixed bound",
		{ timeout: 40_000 },
		async () => {
			const childProcess =
				await vi.importActual<typeof import("node:child_process")>(
					"node:child_process",
				);
			execFileSyncMock.mockImplementation(childProcess.execFileSync);
			const fixtureDir = mkdtempSync(join(tmpdir(), "agent-browser-hang-"));
			const fixture = join(fixtureDir, "agent-browser");
			writeFileSync(fixture, "#!/bin/sh\n/bin/sh -c '/bin/sleep 60' &\nwait\n");
			chmodSync(fixture, 0o755);
			const startedAt = Date.now();
			try {
				expect(() =>
					defaultRunAgentBrowser(["record", "stop"], {
						env: { PATH: fixtureDir },
					}),
				).toThrow(expect.objectContaining({ code: "ETIMEDOUT" }));
				const elapsed = Date.now() - startedAt;
				expect(elapsed).toBeGreaterThanOrEqual(13_000);
				expect(elapsed).toBeLessThanOrEqual(25_000);
			} finally {
				rmSync(fixtureDir, { recursive: true, force: true });
			}
		},
	);
});
