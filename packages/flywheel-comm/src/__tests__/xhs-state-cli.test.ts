/**
 * FLY-222: `flywheel-comm xhs-state` CLI integration tests (exercises the real
 * lib end-to-end through the CLI with a temp state dir).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { xhsState } from "../commands/xhs-state.js";

const P = "sub";
const C = "coll1";
let dir: string;
let out: string[];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "xhs-cli-"));
	out = [];
	vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
		out.push(String(chunk));
		return true;
	});
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

/** Run a subcommand; returns the last JSON object emitted to stdout. */
async function run(...extra: string[]): Promise<any> {
	out = [];
	const code = await xhsState([
		extra[0],
		"--project",
		P,
		"--collection",
		C,
		"--state-dir",
		dir,
		...extra.slice(1),
	]);
	expect(code).toBe(0);
	const last = out.filter((s) => s.trim()).pop() ?? "null";
	return JSON.parse(last);
}

describe("xhs-state CLI", () => {
	it("read returns a fresh empty state", async () => {
		const s = await run("read");
		expect(s.bootstrapped).toBe(false);
		expect(s.processed).toEqual([]);
		expect(s.lease).toBeNull();
	});

	it("lease lifecycle: acquire → reject other → release", async () => {
		expect((await run("acquire-lease", "--owner", "r1")).ok).toBe(true);
		const rej = await run("acquire-lease", "--owner", "r2");
		expect(rej.ok).toBe(false);
		expect(rej.reason).toBe("held_by_other");
		expect(rej.heldBy).toBe("r1");
		expect((await run("release-lease", "--owner", "r1")).ok).toBe(true);
		// after release a different owner can acquire
		expect((await run("acquire-lease", "--owner", "r2")).ok).toBe(true);
	});

	it("mark-processed persists and diff reflects it", async () => {
		expect((await run("mark-processed", "--note-id", "n1")).ok).toBe(true);
		expect((await run("read")).processed).toEqual(["n1"]);
		const d = await run("diff", "--note-ids", JSON.stringify(["n1", "n2", "n3"]));
		expect(d.new).toEqual(["n2", "n3"]);
	});

	it("operation idempotency round-trip", async () => {
		const intent = await run(
			"record-op-intent",
			"--note-id",
			"n1",
			"--kind",
			"issue",
			"--candidate-id",
			"c0",
		);
		expect(intent.ok).toBe(true);
		expect(intent.opId).toBe(`${C}:n1:issue:c0`);
		const before = await run("find-op", "--op-id", intent.opId);
		expect(before.found).toBe(true);
		expect(before.record.status).toBe("intent");
		expect(
			(await run("mark-op-done", "--op-id", intent.opId, "--issue-id", "FLY-1"))
				.ok,
		).toBe(true);
		const after = await run("find-op", "--op-id", intent.opId);
		expect(after.record.status).toBe("done");
		expect(after.record.issueId).toBe("FLY-1");
	});

	it("set-next-due makes is-due false until the future", async () => {
		const r = await run("set-next-due", "--cadence", "weekly");
		expect(r.ok).toBe(true);
		expect(typeof r.nextDueAt).toBe("string");
		expect((await run("is-due")).due).toBe(false);
	});

	it("record-pending then mark-processed drops from pending", async () => {
		await run("record-pending", "--note-ids", JSON.stringify(["n1", "n2"]));
		expect((await run("read")).pending.map((p: any) => p.noteId).sort()).toEqual([
			"n1",
			"n2",
		]);
		await run("mark-processed", "--note-id", "n1");
		expect((await run("read")).pending.map((p: any) => p.noteId)).toEqual(["n2"]);
	});

	it("validation errors exit non-zero (process.exit mocked)", async () => {
		const exitSpy = vi
			.spyOn(process, "exit")
			.mockImplementation(((code?: number) => {
				throw new Error(`exit:${code}`);
			}) as never);
		// missing --owner on acquire-lease → fail() → exit(2)
		await expect(
			xhsState(["acquire-lease", "--project", P, "--collection", C, "--state-dir", dir]),
		).rejects.toThrow(/exit:2/);
		expect(exitSpy).toHaveBeenCalledWith(2);
	});
});
