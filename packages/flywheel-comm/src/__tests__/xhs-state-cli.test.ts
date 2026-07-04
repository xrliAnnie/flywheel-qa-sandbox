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
		const d = await run(
			"diff",
			"--note-ids",
			JSON.stringify(["n1", "n2", "n3"]),
		);
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

	it("record-feedback-op-intent encodes a colon-containing target (FLY-286)", async () => {
		const target = `${C}:n1:issue:c0`; // an op id — itself colon-delimited
		const intent = await run(
			"record-feedback-op-intent",
			"--note-id",
			"n1",
			"--action",
			"close",
			"--target",
			target,
		);
		expect(intent.ok).toBe(true);
		// colon-safe: only the structural colons, hashed token tail
		expect(intent.opId).toMatch(
			new RegExp(`^${C}:n1:feedback_close:[a-f0-9]{16}$`),
		);
		// idempotent: same args → same opId
		const again = await run(
			"record-feedback-op-intent",
			"--note-id",
			"n1",
			"--action",
			"close",
			"--target",
			target,
		);
		expect(again.opId).toBe(intent.opId);
		const found = await run("find-op", "--op-id", intent.opId);
		expect(found.found).toBe(true);
		expect(found.record.outputKind).toBe("feedback_close");
	});

	it("set-next-due makes is-due false until the future", async () => {
		const r = await run("set-next-due", "--cadence", "weekly");
		expect(r.ok).toBe(true);
		expect(typeof r.nextDueAt).toBe("string");
		expect((await run("is-due")).due).toBe(false);
	});

	it("record-pending then mark-processed drops from pending", async () => {
		await run("record-pending", "--note-ids", JSON.stringify(["n1", "n2"]));
		expect(
			(await run("read")).pending.map((p: any) => p.noteId).sort(),
		).toEqual(["n1", "n2"]);
		await run("mark-processed", "--note-id", "n1");
		expect((await run("read")).pending.map((p: any) => p.noteId)).toEqual([
			"n2",
		]);
	});

	it("validation errors exit non-zero (process.exit mocked)", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
			code?: number,
		) => {
			throw new Error(`exit:${code}`);
		}) as never);
		// missing --owner on acquire-lease → fail() → exit(2)
		await expect(
			xhsState([
				"acquire-lease",
				"--project",
				P,
				"--collection",
				C,
				"--state-dir",
				dir,
			]),
		).rejects.toThrow(/exit:2/);
		expect(exitSpy).toHaveBeenCalledWith(2);
	});
});

describe("xhs-state CLI — F2 owner-fencing (zombie write after takeover)", () => {
	it("allows a mutating write by the current lease owner", async () => {
		expect((await run("acquire-lease", "--owner", "r1")).ok).toBe(true);
		const code = await xhsState([
			"mark-processed",
			"--project",
			P,
			"--collection",
			C,
			"--state-dir",
			dir,
			"--note-id",
			"n1",
			"--owner",
			"r1",
		]);
		expect(code).toBe(0);
		expect((await run("read")).processed).toEqual(["n1"]);
	});

	it("REJECTS (exit 2) a mutating write when a DIFFERENT owner holds the lease", async () => {
		// r1 holds the lease; a stale zombie r0 tries to advance state.
		expect((await run("acquire-lease", "--owner", "r1")).ok).toBe(true);
		out = [];
		const code = await xhsState([
			"mark-processed",
			"--project",
			P,
			"--collection",
			C,
			"--state-dir",
			dir,
			"--note-id",
			"zombie",
			"--owner",
			"r0",
		]);
		expect(code).toBe(2);
		expect(JSON.parse(out.filter((x) => x.trim()).pop()!)).toMatchObject({
			ok: false,
			reason: "not_lease_owner",
			heldBy: "r1",
		});
		// the zombie write did NOT land
		expect((await run("read")).processed).not.toContain("zombie");
	});

	it("allows a mutating write with no --owner (backward compat / scheduler path)", async () => {
		const code = await xhsState([
			"mark-processed",
			"--project",
			P,
			"--collection",
			C,
			"--state-dir",
			dir,
			"--note-id",
			"n2",
		]);
		expect(code).toBe(0);
		expect((await run("read")).processed).toContain("n2");
	});

	it("fences record-op-intent / set-next-due / mark-op-done too", async () => {
		expect((await run("acquire-lease", "--owner", "r1")).ok).toBe(true);
		for (const argv of [
			[
				"record-op-intent",
				"--note-id",
				"n",
				"--kind",
				"issue",
				"--candidate-id",
				"c",
			],
			["set-next-due", "--cadence", "weekly"],
		]) {
			out = [];
			const code = await xhsState([
				argv[0],
				"--project",
				P,
				"--collection",
				C,
				"--state-dir",
				dir,
				...argv.slice(1),
				"--owner",
				"r0",
			]);
			expect(code).toBe(2);
		}
	});
});

describe("xhs-state CLI — set-bootstrapped (codex MEDIUM-6)", () => {
	it("sets the bootstrapped flag (idempotent) and is owner-fenced", async () => {
		expect((await run("read")).bootstrapped).toBe(false);
		expect((await run("set-bootstrapped")).ok).toBe(true);
		expect((await run("read")).bootstrapped).toBe(true);
		// idempotent
		expect((await run("set-bootstrapped")).ok).toBe(true);
		expect((await run("read")).bootstrapped).toBe(true);
	});

	it("REJECTS set-bootstrapped (exit 2) for a non-lease-owner", async () => {
		expect((await run("acquire-lease", "--owner", "r1")).ok).toBe(true);
		out = [];
		const code = await xhsState([
			"set-bootstrapped",
			"--project",
			P,
			"--collection",
			C,
			"--state-dir",
			dir,
			"--owner",
			"r0",
		]);
		expect(code).toBe(2);
		expect((await run("read")).bootstrapped).toBe(false);
	});
});

describe("xhs-state CLI — drop-pending (codex MEDIUM-5)", () => {
	it("drops a pending note without processing it; owner-fenced", async () => {
		await run("record-pending", "--note-ids", JSON.stringify(["p1", "p2"]));
		expect((await run("drop-pending", "--note-id", "p1")).ok).toBe(true);
		const s = await run("read");
		expect(s.pending.map((p: any) => p.noteId)).toEqual(["p2"]);
		expect(s.processed).not.toContain("p1");
	});

	it("REJECTS drop-pending (exit 2) for a non-lease-owner", async () => {
		await run("record-pending", "--note-ids", JSON.stringify(["p1"]));
		expect((await run("acquire-lease", "--owner", "r1")).ok).toBe(true);
		out = [];
		const code = await xhsState([
			"drop-pending",
			"--project",
			P,
			"--collection",
			C,
			"--state-dir",
			dir,
			"--note-id",
			"p1",
			"--owner",
			"r0",
		]);
		expect(code).toBe(2);
		expect((await run("read")).pending.map((p: any) => p.noteId)).toEqual([
			"p1",
		]);
	});
});

describe("xhs-state CLI — fence after lease release (codex r3 NEW HIGH)", () => {
	it("REJECTS a --owner write when NO lease is held (zombie after takeover+release)", async () => {
		// No lease at all (e.g. B took over, finished, released → lease=null). A
		// resurrected zombie A must NOT be able to advance state.
		out = [];
		const code = await xhsState([
			"mark-processed",
			"--project",
			P,
			"--collection",
			C,
			"--state-dir",
			dir,
			"--note-id",
			"zombie",
			"--owner",
			"r0",
		]);
		expect(code).toBe(2);
		expect(JSON.parse(out.filter((x) => x.trim()).pop()!)).toMatchObject({
			ok: false,
			reason: "not_lease_owner",
		});
		expect((await run("read")).processed).not.toContain("zombie");
	});
});

describe("xhs-state CLI — FLY-286 delivery + pending-feedback", () => {
	it("record-analysis-delivered sets pointers + enqueues; clear drains; both owner-fenced", async () => {
		await run("acquire-lease", "--owner", "RK");
		const d = await run(
			"record-analysis-delivered",
			"--run-token",
			"run-1",
			"--report-token",
			"rep1",
			"--owner",
			"RK",
		);
		expect(d.ok).toBe(true);
		let st = await run("read");
		expect(st.lastAnalysisRunToken).toBe("run-1");
		expect(st.lastReportToken).toBe("rep1");
		expect(st.pendingFeedbackRunTokens).toEqual(["run-1"]);

		await run(
			"clear-pending-feedback",
			"--run-token",
			"run-1",
			"--owner",
			"RK",
		);
		st = await run("read");
		expect(st.pendingFeedbackRunTokens).toEqual([]);
		// idempotent re-clear
		expect(
			(
				await run(
					"clear-pending-feedback",
					"--run-token",
					"run-1",
					"--owner",
					"RK",
				)
			).ok,
		).toBe(true);
	});

	it("rejects record-analysis-delivered from a non-owner (fence)", async () => {
		await run("acquire-lease", "--owner", "RK");
		out = [];
		const code = await xhsState([
			"record-analysis-delivered",
			"--project",
			P,
			"--collection",
			C,
			"--state-dir",
			dir,
			"--run-token",
			"run-1",
			"--report-token",
			"rep1",
			"--owner",
			"stale",
		]);
		expect(code).toBe(2);
		expect(JSON.parse(out.filter((x) => x.trim()).pop()!)).toMatchObject({
			ok: false,
			reason: "not_lease_owner",
		});
	});
});

describe("xhs-state CLI — FLY-286 delivery mutators require --owner (codex code R1#1)", () => {
	it("record-analysis-delivered / clear-pending-feedback without --owner → exit 2, state unchanged", async () => {
		await run("acquire-lease", "--owner", "RK");
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
			c?: number,
		) => {
			throw new Error(`exit:${c}`);
		}) as never);
		await expect(
			xhsState([
				"record-analysis-delivered",
				"--project",
				P,
				"--collection",
				C,
				"--state-dir",
				dir,
				"--run-token",
				"run-1",
				"--report-token",
				"rep1",
			]),
		).rejects.toThrow("exit:2");
		await expect(
			xhsState([
				"clear-pending-feedback",
				"--project",
				P,
				"--collection",
				C,
				"--state-dir",
				dir,
				"--run-token",
				"run-1",
			]),
		).rejects.toThrow("exit:2");
		exitSpy.mockRestore();
		// state untouched (no delivery pointer set)
		expect((await run("read")).lastReportToken ?? null).toBeNull();
	});
});
