/**
 * Path helper tests (Step 3 of Phase 0 PR 1.1).
 *
 * Validates env precedence + default fallbacks for `CLAUDE_CONFIG_DIR` and
 * `FLYWHEEL_STATE_DIR` — Codex r1 high #5 + r2 medium #6.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getClaudeConfigDir,
	getClaudeInboxPath,
	getClaudeSidecarPath,
	getClaudeTeamConfigPath,
	getClaudeTeamsDir,
	getStateDir,
	getStructuredRequestDir,
	getStructuredResponseDir,
} from "../path-helpers.js";

describe("path-helpers", () => {
	const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
	const originalFlywheelStateDir = process.env.FLYWHEEL_STATE_DIR;

	beforeEach(() => {
		delete process.env.CLAUDE_CONFIG_DIR;
		delete process.env.FLYWHEEL_STATE_DIR;
	});

	afterEach(() => {
		if (originalClaudeConfigDir === undefined) {
			delete process.env.CLAUDE_CONFIG_DIR;
		} else {
			process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
		}
		if (originalFlywheelStateDir === undefined) {
			delete process.env.FLYWHEEL_STATE_DIR;
		} else {
			process.env.FLYWHEEL_STATE_DIR = originalFlywheelStateDir;
		}
	});

	describe("getClaudeConfigDir", () => {
		it("defaults to ~/.claude when env not set", () => {
			expect(getClaudeConfigDir()).toBe(join(homedir(), ".claude"));
		});

		it("respects CLAUDE_CONFIG_DIR env when set", () => {
			process.env.CLAUDE_CONFIG_DIR = "/custom/claude/dir";
			expect(getClaudeConfigDir()).toBe("/custom/claude/dir");
		});

		it("treats empty CLAUDE_CONFIG_DIR as unset (falls back to default)", () => {
			process.env.CLAUDE_CONFIG_DIR = "";
			expect(getClaudeConfigDir()).toBe(join(homedir(), ".claude"));
		});

		it("preserves spaces and special chars in env path (Codex r2 high #4)", () => {
			process.env.CLAUDE_CONFIG_DIR = "/path with spaces/.claude";
			expect(getClaudeConfigDir()).toBe("/path with spaces/.claude");
		});

		it("normalizes Unicode to NFC (Codex r1 medium #4 — matches stock claude-code envUtils.ts:8-17)", () => {
			// "café" in NFD form: c + a + f + e + combining-acute-accent
			const nfd = "/test/café/.claude";
			// NFC form: c + a + f + é (precomposed)
			const nfc = "/test/café/.claude";
			process.env.CLAUDE_CONFIG_DIR = nfd;
			// Should normalize to NFC so paths align with stock claude-code's polling.
			expect(getClaudeConfigDir()).toBe(nfc);
		});
	});

	describe("getStateDir", () => {
		it("defaults to ~/.flywheel/state when env not set", () => {
			expect(getStateDir()).toBe(join(homedir(), ".flywheel/state"));
		});

		it("respects FLYWHEEL_STATE_DIR env when set", () => {
			process.env.FLYWHEEL_STATE_DIR = "/custom/state";
			expect(getStateDir()).toBe("/custom/state");
		});
	});

	describe("Claude inbox path resolvers", () => {
		it("composes teams dir from CLAUDE_CONFIG_DIR", () => {
			process.env.CLAUDE_CONFIG_DIR = "/test/claude";
			expect(getClaudeTeamsDir()).toBe("/test/claude/teams");
		});

		it("composes team config path with lead name", () => {
			process.env.CLAUDE_CONFIG_DIR = "/test/claude";
			expect(getClaudeTeamConfigPath("cos-lead")).toBe(
				"/test/claude/teams/cos-lead/config.json",
			);
		});

		it("composes inbox path with lead + agent names", () => {
			process.env.CLAUDE_CONFIG_DIR = "/test/claude";
			expect(getClaudeInboxPath("cos-lead", "runner-FLY-142-abc1")).toBe(
				"/test/claude/teams/cos-lead/inboxes/runner-FLY-142-abc1.json",
			);
		});

		it("composes sidecar path as <inbox>.flywheel.jsonl", () => {
			process.env.CLAUDE_CONFIG_DIR = "/test/claude";
			expect(getClaudeSidecarPath("cos-lead", "runner-FLY-142-abc1")).toBe(
				"/test/claude/teams/cos-lead/inboxes/runner-FLY-142-abc1.json.flywheel.jsonl",
			);
		});
	});

	describe("Structured-inbox paths (vendor-neutral)", () => {
		it("composes request dir under FLYWHEEL_STATE_DIR/inbox-structured/<lead>/requests", () => {
			process.env.FLYWHEEL_STATE_DIR = "/state";
			expect(getStructuredRequestDir("cos-lead")).toBe(
				"/state/inbox-structured/cos-lead/requests",
			);
		});

		it("composes response dir under FLYWHEEL_STATE_DIR/inbox-structured/<runner>/responses", () => {
			process.env.FLYWHEEL_STATE_DIR = "/state";
			expect(getStructuredResponseDir("runner-FLY-142-abc1")).toBe(
				"/state/inbox-structured/runner-FLY-142-abc1/responses",
			);
		});
	});

	describe("Adversarial inbox paths (Codex r1 high #1 — security/correctness)", () => {
		beforeEach(() => {
			process.env.CLAUDE_CONFIG_DIR = "/test/claude";
		});

		it("sanitizes spaces in lead/agent names", () => {
			expect(getClaudeInboxPath("lead with spaces", "agent name")).toBe(
				"/test/claude/teams/lead-with-spaces/inboxes/agent-name.json",
			);
		});

		it("blocks `..` path traversal escape", () => {
			const path = getClaudeInboxPath("../escape", "x");
			// `..` becomes `--`, so path is contained inside teams dir.
			expect(path).toBe("/test/claude/teams/---escape/inboxes/x.json");
			expect(path).not.toContain("/teams/..");
		});

		it("sanitizes `/` to prevent directory traversal in lead name", () => {
			expect(getClaudeInboxPath("a/b", "x")).toBe(
				"/test/claude/teams/a-b/inboxes/x.json",
			);
		});

		it("sanitizes `/` in agent name (would otherwise create subdirs)", () => {
			expect(getClaudeInboxPath("lead", "agent/with/slash")).toBe(
				"/test/claude/teams/lead/inboxes/agent-with-slash.json",
			);
		});

		it("sanitizes `@` (commonly used in agent IDs but not legal in path component)", () => {
			expect(getClaudeInboxPath("cos-lead", "runner@cos-lead")).toBe(
				"/test/claude/teams/cos-lead/inboxes/runner-cos-lead.json",
			);
		});

		it("sidecar path also gets sanitized lead/agent components", () => {
			expect(getClaudeSidecarPath("lead with spaces", "agent name")).toBe(
				"/test/claude/teams/lead-with-spaces/inboxes/agent-name.json.flywheel.jsonl",
			);
		});

		it("getClaudeTeamConfigPath sanitizes lead name", () => {
			expect(getClaudeTeamConfigPath("Cos Lead")).toBe(
				"/test/claude/teams/Cos-Lead/config.json",
			);
		});
	});
});
