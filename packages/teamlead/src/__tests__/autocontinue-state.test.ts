import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	autocontinueArmedMarkerPath,
	autocontinueGoalPath,
	isAutocontinueArmed,
	markAutocontinueArmed,
	resolveRunnerStateRoot,
	writeAutocontinueGoalFile,
} from "../bridge/autocontinue-state.js";

let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "fly818-state-"));
	env = { FLYWHEEL_RUNNER_STATE_ROOT: root } as NodeJS.ProcessEnv;
});
afterEach(() => {
	// tmp dirs are ephemeral; no explicit cleanup needed for the test's purpose.
});

describe("autocontinue-state (FLY-818) — durable goal file + armed marker", () => {
	it("honors an absolute FLYWHEEL_RUNNER_STATE_ROOT override (QA-room isolation)", () => {
		expect(resolveRunnerStateRoot(env)).toBe(root);
	});

	it("ignores a relative override and falls back to ~/.flywheel/runner-state", () => {
		const rel = {
			FLYWHEEL_RUNNER_STATE_ROOT: "some/relative",
		} as NodeJS.ProcessEnv;
		expect(resolveRunnerStateRoot(rel)).toBe(
			join(homedir(), ".flywheel", "runner-state"),
		);
		const none = {} as NodeJS.ProcessEnv;
		expect(resolveRunnerStateRoot(none)).toBe(
			join(homedir(), ".flywheel", "runner-state"),
		);
	});

	it("goal + armed paths are absolute, under the per-exec dir, and isolated to the override root", () => {
		const goal = autocontinueGoalPath("exec-1", env);
		const marker = autocontinueArmedMarkerPath("exec-1", env);
		expect(isAbsolute(goal)).toBe(true);
		expect(goal.startsWith(root)).toBe(true);
		expect(goal).toContain("exec-1");
		expect(goal.endsWith("autocontinue-goal.md")).toBe(true);
		expect(marker.startsWith(root)).toBe(true);
		// Isolation: the override root diverts away from the production default
		// root, so QA-room / multi-instance state never lands in the shared
		// `~/.flywheel/runner-state` (the exact-equality check is robust even if a
		// test tmpdir happens to nest under ~/.flywheel).
		expect(resolveRunnerStateRoot(env)).not.toBe(
			join(homedir(), ".flywheel", "runner-state"),
		);
	});

	it("writes the goal file (0600) under a 0700 dir and returns its absolute path", () => {
		const path = writeAutocontinueGoalFile("exec-2", "GOAL CONTRACT TEXT", env);
		expect(isAbsolute(path)).toBe(true);
		expect(existsSync(path)).toBe(true);
		expect(readFileSync(path, "utf-8")).toBe("GOAL CONTRACT TEXT");
		// permission bits (low 9): file 0600, dir 0700.
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(join(root, "exec-2")).mode & 0o777).toBe(0o700);
	});

	it("armed marker: not armed before, armed (durable) after markAutocontinueArmed", () => {
		expect(isAutocontinueArmed("exec-3", env)).toBe(false);
		expect(markAutocontinueArmed("exec-3", env)).toBe(true);
		expect(isAutocontinueArmed("exec-3", env)).toBe(true);
		// idempotent-safe: marking again stays armed.
		markAutocontinueArmed("exec-3", env);
		expect(isAutocontinueArmed("exec-3", env)).toBe(true);
	});
});
