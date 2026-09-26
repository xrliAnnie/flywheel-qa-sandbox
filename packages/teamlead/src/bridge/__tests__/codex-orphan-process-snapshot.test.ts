import { execFile } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { defaultListCodexAppServerProcesses } from "../codex-runner-orphan-reaper.js";

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	execFile: vi.fn(),
}));
function output(value: string) {
	vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
		(args.at(-1) as (error: null, stdout: string) => void)(null, value);
		return undefined as never;
	});
}
describe("FLY-2920 complete process absence proof", () => {
	it("rejects a mixed valid and malformed snapshot instead of silently dropping a holder", async () => {
		output("4210 1 4210 03:00 /opt/codex app-server\n4211 truncated\n");
		expect(await defaultListCodexAppServerProcesses()).toMatchObject({
			status: "unknown",
		});
	});
	it("accepts complete snapshots including init and kernel process groups", async () => {
		output(
			"1 0 1 03:00 /sbin/launchd\n0 0 0 03:00 [kernel]\n4210 1 4210 03:00 other\n",
		);
		expect(await defaultListCodexAppServerProcesses()).toMatchObject({
			status: "ok",
			rows: [{ pid: 1 }, { pid: 0 }, { pid: 4210 }],
		});
	});
	it("accepts genuinely empty output", async () => {
		output("\n");
		expect(await defaultListCodexAppServerProcesses()).toEqual({
			status: "ok",
			rows: [],
		});
	});
});
