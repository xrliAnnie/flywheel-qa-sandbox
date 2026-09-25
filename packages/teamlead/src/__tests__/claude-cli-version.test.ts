import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readClaudeCliVersion } from "../account-heal/claude-cli-version.js";
import type { BoundedRunResult } from "../account-heal/opus-model-sync.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function run(partial: Partial<BoundedRunResult>) {
	return async (): Promise<BoundedRunResult> => ({
		code: 0,
		signal: null,
		stdout: "",
		stderr: "",
		timedOut: false,
		overflowed: false,
		...partial,
	});
}

describe("FLY-2864 — Claude Code CLI version reader", () => {
	it("extracts the semantic version from the real CLI output shape", async () => {
		await expect(
			readClaudeCliVersion({
				bin: "claude",
				run: run({ stdout: "2.1.282 (Claude Code)\n" }),
			}),
		).resolves.toBe("2.1.282");
	});

	it("returns null for empty, failed, timed-out, overflowed or missing runs", async () => {
		for (const partial of [
			{ stdout: "" },
			{ stdout: "Claude Code\n" },
			{ stdout: "2.1\n" },
			{ code: 1, stdout: "2.1.282 (Claude Code)\n" },
			{ timedOut: true, code: null, stdout: "2.1.282 (Claude Code)\n" },
			{ overflowed: true, stdout: "2.1.282 (Claude Code)\n" },
			{ spawnErrorCode: "ENOENT", code: null },
		]) {
			await expect(
				readClaudeCliVersion({ bin: "claude", run: run(partial) }),
			).resolves.toBeNull();
		}
	});

	it("asks only for --version with a bounded run", async () => {
		const calls: Array<{
			bin: string;
			args: readonly string[];
			opts: { timeoutMs: number; maxBytes?: number };
		}> = [];
		await readClaudeCliVersion({
			bin: "/opt/example/claude",
			run: async (bin, args, opts) => {
				calls.push({ bin, args, opts });
				return {
					code: 0,
					signal: null,
					stdout: "2.1.282 (Claude Code)",
					stderr: "",
					timedOut: false,
					overflowed: false,
				};
			},
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]!.args).toEqual(["--version"]);
		expect(calls[0]!.opts.timeoutMs).toBe(5_000);
		expect(calls[0]!.opts.maxBytes).toBe(4_096);
	});

	it("runs a real executable end to end and fails closed on a missing binary", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2864-cli-"));
		roots.push(root);
		const bin = join(root, "claude");
		writeFileSync(bin, "#!/bin/sh\necho '9.8.7 (Claude Code)'\n");
		chmodSync(bin, 0o755);
		await expect(readClaudeCliVersion({ bin })).resolves.toBe("9.8.7");
		await expect(
			readClaudeCliVersion({ bin: join(root, "absent-claude") }),
		).resolves.toBeNull();
	});
});
