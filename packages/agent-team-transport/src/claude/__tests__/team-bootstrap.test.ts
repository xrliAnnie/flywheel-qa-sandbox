/**
 * team-bootstrap unit tests.
 *
 * Per plan v1.27.1 §A acceptance:
 * - Real schema fixture-locked (Codex r3 medium #3): all required fields
 *   per `teamHelpers.ts:64-90` are validated.
 * - Round-trip: write team file → read with our reader returns same fields
 *   (the integration test uses stock `readTeamFileAsync` for full round-trip).
 * - Concurrent add/remove → no corruption (proper-lockfile cooperation).
 * - Idempotent ensureTeam / addMember / removeMember.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addMember,
	ensureTeam,
	getTeamFilePath,
	readTeamFile,
	removeMember,
	sanitizeName,
	type TeamFile,
} from "../team-bootstrap.js";

let tempDir: string;
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "team-bootstrap-"));
	process.env.CLAUDE_CONFIG_DIR = tempDir;
});

afterEach(async () => {
	if (originalConfigDir === undefined) {
		delete process.env.CLAUDE_CONFIG_DIR;
	} else {
		process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
	}
	await rm(tempDir, { recursive: true, force: true });
});

// ============================================================================
// sanitizeName
// ============================================================================

describe("team-bootstrap — sanitizeName", () => {
	it("replaces non-alphanumeric with hyphens and lowercases", () => {
		expect(sanitizeName("Cos-Lead")).toBe("cos-lead");
		expect(sanitizeName("FLY 142")).toBe("fly-142");
		expect(sanitizeName("Team_$pecial#Chars")).toBe("team--pecial-chars");
	});

	it("matches stock claude-code teamHelpers.ts:100-102 exactly", () => {
		expect(sanitizeName("Annie's Team!")).toBe("annie-s-team-");
	});
});

// ============================================================================
// ensureTeam
// ============================================================================

describe("team-bootstrap — ensureTeam", () => {
	it("creates team with required schema fields (Codex r2 medium #5)", async () => {
		const team = await ensureTeam({
			teamName: "cos-lead",
			leadName: "cos-lead",
			leadSessionId: "session-123",
			description: "test team",
		});

		expect(team.name).toBe("cos-lead");
		expect(team.leadAgentId).toBe("cos-lead@cos-lead");
		expect(team.leadSessionId).toBe("session-123");
		expect(team.description).toBe("test team");
		expect(typeof team.createdAt).toBe("number");
		expect(team.createdAt).toBeGreaterThan(0);
		expect(team.members).toEqual([]);

		// File on disk should match.
		const path = getTeamFilePath("cos-lead");
		const content = await readFile(path, "utf-8");
		const parsed = JSON.parse(content) as TeamFile;
		expect(parsed.createdAt).toBe(team.createdAt);
	});

	it("is idempotent for same lead", async () => {
		const first = await ensureTeam({ teamName: "x", leadName: "x" });
		const second = await ensureTeam({ teamName: "x", leadName: "x" });
		expect(second.createdAt).toBe(first.createdAt);
	});

	it("refreshes leadSessionId on second call", async () => {
		await ensureTeam({ teamName: "x", leadName: "x", leadSessionId: "s1" });
		const refreshed = await ensureTeam({
			teamName: "x",
			leadName: "x",
			leadSessionId: "s2",
		});
		expect(refreshed.leadSessionId).toBe("s2");
	});

	it("rejects reassignment to a different lead", async () => {
		await ensureTeam({ teamName: "x", leadName: "lead-a" });
		await expect(
			ensureTeam({ teamName: "x", leadName: "lead-b" }),
		).rejects.toThrow(/already exists/);
	});
});

// ============================================================================
// addMember / removeMember
// ============================================================================

describe("team-bootstrap — addMember", () => {
	beforeEach(async () => {
		await ensureTeam({ teamName: "cos-lead", leadName: "cos-lead" });
	});

	it("populates all required member fields (Codex r3 medium #3)", async () => {
		const team = await addMember({
			teamName: "cos-lead",
			memberName: "runner-FLY-142-abc1",
		});

		const member = team.members[0]!;
		expect(member.name).toBe("runner-FLY-142-abc1");
		expect(member.agentId).toBe("runner-FLY-142-abc1@cos-lead");
		expect(typeof member.joinedAt).toBe("number");
		expect(member.joinedAt).toBeGreaterThan(0);
		expect(typeof member.tmuxPaneId).toBe("string");
		expect(typeof member.cwd).toBe("string");
		expect(Array.isArray(member.subscriptions)).toBe(true);
	});

	it("uses placeholder tmuxPaneId when caller doesn't provide one", async () => {
		const team = await addMember({
			teamName: "cos-lead",
			memberName: "no-pane-yet",
		});
		expect(team.members[0]?.tmuxPaneId).toBe("pending");
	});

	it("preserves caller-provided optional fields", async () => {
		const team = await addMember({
			teamName: "cos-lead",
			memberName: "runner-x",
			tmuxPaneId: "%5",
			cwd: "/tmp/work",
			subscriptions: ["foo", "bar"],
			color: "cyan",
			model: "sonnet",
			agentType: "engineer",
			worktreePath: "/repo/worktrees/x",
			sessionId: "sess-789",
			backendType: "tmux",
		});
		const member = team.members[0]!;
		expect(member.tmuxPaneId).toBe("%5");
		expect(member.cwd).toBe("/tmp/work");
		expect(member.subscriptions).toEqual(["foo", "bar"]);
		expect(member.color).toBe("cyan");
		expect(member.model).toBe("sonnet");
		expect(member.agentType).toBe("engineer");
		expect(member.worktreePath).toBe("/repo/worktrees/x");
		expect(member.sessionId).toBe("sess-789");
		expect(member.backendType).toBe("tmux");
	});

	it("re-add updates existing member (idempotent by name)", async () => {
		await addMember({
			teamName: "cos-lead",
			memberName: "x",
			color: "red",
		});
		const team = await addMember({
			teamName: "cos-lead",
			memberName: "x",
			color: "blue",
		});
		expect(team.members).toHaveLength(1);
		expect(team.members[0]?.color).toBe("blue");
	});

	it("rejects add to non-existent team", async () => {
		await expect(
			addMember({ teamName: "no-team", memberName: "x" }),
		).rejects.toThrow(/non-existent/);
	});
});

describe("team-bootstrap — removeMember", () => {
	beforeEach(async () => {
		await ensureTeam({ teamName: "cos-lead", leadName: "cos-lead" });
		await addMember({ teamName: "cos-lead", memberName: "x" });
		await addMember({ teamName: "cos-lead", memberName: "y" });
	});

	it("removes a member by name", async () => {
		const team = await removeMember({
			teamName: "cos-lead",
			memberName: "x",
		});
		expect(team.members.map((m) => m.name)).toEqual(["y"]);
	});

	it("is idempotent (no-op on missing member)", async () => {
		const team = await removeMember({
			teamName: "cos-lead",
			memberName: "missing",
		});
		expect(team.members).toHaveLength(2);
	});
});

// ============================================================================
// Concurrency
// ============================================================================

describe("team-bootstrap — concurrent mutations", () => {
	it("100 parallel addMember calls do not corrupt the team file", async () => {
		await ensureTeam({ teamName: "cos-lead", leadName: "cos-lead" });

		await Promise.all(
			Array.from({ length: 100 }, (_, i) =>
				addMember({
					teamName: "cos-lead",
					memberName: `runner-${i}`,
				}),
			),
		);

		const team = await readTeamFile("cos-lead");
		expect(team).toBeTruthy();
		expect(team!.members).toHaveLength(100);

		// All required fields present on every member.
		for (const m of team!.members) {
			expect(typeof m.joinedAt).toBe("number");
			expect(typeof m.tmuxPaneId).toBe("string");
			expect(typeof m.cwd).toBe("string");
			expect(Array.isArray(m.subscriptions)).toBe(true);
		}
	});

	it("interleaved add + remove preserves expected final set", async () => {
		await ensureTeam({ teamName: "cos-lead", leadName: "cos-lead" });

		// Add 30; remove half concurrently.
		const adds = Array.from({ length: 30 }, (_, i) =>
			addMember({ teamName: "cos-lead", memberName: `r-${i}` }),
		);
		await Promise.all(adds);

		const removes = Array.from({ length: 15 }, (_, i) =>
			removeMember({ teamName: "cos-lead", memberName: `r-${i}` }),
		);
		await Promise.all(removes);

		const team = await readTeamFile("cos-lead");
		expect(team!.members.map((m) => m.name).sort()).toEqual(
			Array.from({ length: 15 }, (_, i) => `r-${i + 15}`).sort(),
		);
	});
});

// ============================================================================
// Schema validation
// ============================================================================

describe("team-bootstrap — schema validation", () => {
	it("validates createdAt is a positive number", async () => {
		// We can't easily inject a bad team file via the public API, so we
		// indirectly assert that ensureTeam always produces valid output by
		// running it many times — schema validator runs on every write.
		for (let i = 0; i < 10; i++) {
			const team = await ensureTeam({
				teamName: `t${i}`,
				leadName: `l${i}`,
			});
			expect(team.createdAt).toBeGreaterThan(0);
		}
	});
});

// ============================================================================
// readTeamFile
// ============================================================================

describe("team-bootstrap — readTeamFile", () => {
	it("returns null when team doesn't exist", async () => {
		expect(await readTeamFile("nonexistent")).toBeNull();
	});

	it("returns parsed team when it exists", async () => {
		await ensureTeam({ teamName: "x", leadName: "x" });
		const team = await readTeamFile("x");
		expect(team?.name).toBe("x");
	});

	it("respects sanitizeName when reading", async () => {
		await ensureTeam({ teamName: "Cos-Lead", leadName: "cos-lead" });
		const team = await readTeamFile("Cos-Lead");
		expect(team?.name).toBe("cos-lead");
	});
});
