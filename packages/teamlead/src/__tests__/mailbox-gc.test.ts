/**
 * FLY-182 Track A — dead-team GC classifier safety tests (Codex R1#1 HIGH).
 *
 * The destructive path is heavily gated; these tests pin the SAFETY contract:
 * - Lead teams are never deletable.
 * - A team is only "dead" when ALL liveness signals say so.
 * - ANY probe failure → "unknown" (fail-closed), never "dead".
 *
 * Imports the self-contained ops script directly (no build needed) so the
 * classifier is covered by CI (`pnpm test:packages:run`).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error — .mjs ops script, no type declarations.
import {
	classifyTeam,
	isSafeTeamName,
	loadLeadTeamNames,
} from "../../../../scripts/mailbox-gc.mjs";

const NOW = Date.parse("2026-05-29T12:00:00Z");
const DAY = 86_400_000;

const okProbes = (over: Record<string, unknown> = {}) => ({
	mtime: { ok: true, value: NOW - 30 * DAY }, // stale
	process: { ok: true, value: false }, // no process
	tmux: { ok: true, value: false }, // no live pane
	config: { ok: true, value: false }, // no live members
	...over,
});

describe("classifyTeam (dead-team GC safety)", () => {
	it("never marks a configured Lead team as deletable", () => {
		const r = classifyTeam({
			teamName: "product-lead",
			isLeadTeam: true,
			staleDays: 7,
			now: NOW,
			probes: okProbes(),
		});
		expect(r.verdict).toBe("alive");
	});

	it("marks a team dead only when ALL signals say dead", () => {
		const r = classifyTeam({
			teamName: "flywheel-sprint-v26",
			isLeadTeam: false,
			staleDays: 7,
			now: NOW,
			probes: okProbes(),
		});
		expect(r.verdict).toBe("dead");
	});

	it("stays alive when mtime is recent", () => {
		const r = classifyTeam({
			teamName: "fly-177",
			isLeadTeam: false,
			staleDays: 7,
			now: NOW,
			probes: okProbes({ mtime: { ok: true, value: NOW - 1 * DAY } }),
		});
		expect(r.verdict).toBe("alive");
	});

	it("stays alive when a --team-name process is running", () => {
		const r = classifyTeam({
			teamName: "fly-177",
			isLeadTeam: false,
			staleDays: 7,
			now: NOW,
			probes: okProbes({ process: { ok: true, value: true } }),
		});
		expect(r.verdict).toBe("alive");
	});

	it("stays alive when config references a live tmux pane", () => {
		const r = classifyTeam({
			teamName: "x",
			isLeadTeam: false,
			staleDays: 7,
			now: NOW,
			probes: okProbes({ tmux: { ok: true, value: true } }),
		});
		expect(r.verdict).toBe("alive");
	});

	it("stays alive when config has live members", () => {
		const r = classifyTeam({
			teamName: "x",
			isLeadTeam: false,
			staleDays: 7,
			now: NOW,
			probes: okProbes({ config: { ok: true, value: true } }),
		});
		expect(r.verdict).toBe("alive");
	});

	it.each(["mtime", "process", "tmux", "config"])(
		"is UNKNOWN (fail-closed) when the %s probe fails",
		(probe) => {
			const r = classifyTeam({
				teamName: "x",
				isLeadTeam: false,
				staleDays: 7,
				now: NOW,
				probes: okProbes({ [probe]: { ok: false, error: "boom" } }),
			});
			expect(r.verdict).toBe("unknown");
		},
	);
});

describe("isSafeTeamName (destructive-path guard, Codex code review R1 HIGH)", () => {
	it("accepts normal team directory names", () => {
		for (const ok of [
			"flywheel-sprint-v26",
			"fly-177",
			"8d24262c-8aec-45a8-8a80-67feb038cc59",
			"cuddly_plotting.candle",
		]) {
			expect(isSafeTeamName(ok)).toBe(true);
		}
	});

	it("rejects path traversal, separators, dot names, and option-injection", () => {
		for (const bad of [
			"",
			".",
			"..",
			"../escape",
			"a/b",
			"a\\b",
			"-rf",
			"--apply",
			"x\0y",
		]) {
			expect(isSafeTeamName(bad)).toBe(false);
		}
	});

	it("rejects non-strings", () => {
		// @ts-expect-error intentional wrong type
		expect(isSafeTeamName(undefined)).toBe(false);
		// @ts-expect-error intentional wrong type
		expect(isSafeTeamName(null)).toBe(false);
	});
});

describe("loadLeadTeamNames", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "fly182-gc-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("collects lead agentIds from projects.json", async () => {
		const p = join(dir, "projects.json");
		await writeFile(
			p,
			JSON.stringify([
				{
					projectName: "geoforge3d",
					leads: [{ agentId: "product-lead" }, { agentId: "ops-lead" }],
				},
				{ projectName: "other", leads: [{ agentId: "cos-lead" }] },
			]),
			"utf-8",
		);
		const names = await loadLeadTeamNames(p);
		expect([...names].sort()).toEqual(["cos-lead", "ops-lead", "product-lead"]);
	});

	it("returns null when projects.json is unreadable (caller fails closed)", async () => {
		const names = await loadLeadTeamNames(join(dir, "nope.json"));
		expect(names).toBeNull();
	});
});
