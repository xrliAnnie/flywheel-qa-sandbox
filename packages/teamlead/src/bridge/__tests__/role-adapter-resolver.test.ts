/**
 * FLY-123: RoleAdapterResolver precedence tests —
 * task(label) > project > global env > built-in default. Target: full
 * combination coverage (plan §6 row 1).
 */
import { describe, expect, it } from "vitest";
import {
	EXECUTOR_TO_TRANSPORT,
	resolveRoleAdapter,
} from "../role-adapter-resolver.js";

const EMPTY_ENV = {} as NodeJS.ProcessEnv;

describe("EXECUTOR_TO_TRANSPORT mapping (Codex R5 note #2)", () => {
	it("is the single typed mapping", () => {
		expect(EXECUTOR_TO_TRANSPORT["claude-tmux"]).toBe("claude-code");
		expect(EXECUTOR_TO_TRANSPORT["codex-tmux"]).toBe("codex");
	});
});

describe("resolveRoleAdapter — built-in default", () => {
	it("runner with nothing set → claude-tmux (byte-compat)", () => {
		expect(resolveRoleAdapter({ role: "runner", env: EMPTY_ENV })).toEqual({
			backend: "claude-tmux",
			vendor: "claude-code",
		});
	});

	it("lead with nothing set → claude-tmux", () => {
		expect(resolveRoleAdapter({ role: "lead", env: EMPTY_ENV })).toEqual({
			backend: "claude-tmux",
			vendor: "claude-code",
		});
	});
});

describe("resolveRoleAdapter — global env layer", () => {
	it("FLYWHEEL_RUNNER_BACKEND=codex-tmux selects codex for runner", () => {
		const env = { FLYWHEEL_RUNNER_BACKEND: "codex-tmux" } as NodeJS.ProcessEnv;
		expect(resolveRoleAdapter({ role: "runner", env })).toEqual({
			backend: "codex-tmux",
			vendor: "codex",
		});
	});

	it("FLYWHEEL_RUNNER_BACKEND does NOT affect lead (env isolation, R1 #8)", () => {
		const env = { FLYWHEEL_RUNNER_BACKEND: "codex-tmux" } as NodeJS.ProcessEnv;
		expect(resolveRoleAdapter({ role: "lead", env }).backend).toBe(
			"claude-tmux",
		);
	});

	it("FLYWHEEL_LEAD_BACKEND does NOT affect runner", () => {
		const env = { FLYWHEEL_LEAD_BACKEND: "codex-tmux" } as NodeJS.ProcessEnv;
		expect(resolveRoleAdapter({ role: "runner", env }).backend).toBe(
			"claude-tmux",
		);
	});

	it("invalid env value is ignored with fallback to default", () => {
		const env = { FLYWHEEL_RUNNER_BACKEND: "gemini-tmux" } as NodeJS.ProcessEnv;
		expect(resolveRoleAdapter({ role: "runner", env }).backend).toBe(
			"claude-tmux",
		);
	});

	// FLY-123 follow-up (qa-fly-123 finding): the env previously accepted ONLY
	// the executor form (codex-tmux), while labels accepted the vendor form
	// (codex). So `FLYWHEEL_RUNNER_BACKEND=codex` silently fell back to claude —
	// a wrong-vendor silent failure. The env now accepts vendor aliases too.
	it("FLYWHEEL_RUNNER_BACKEND=codex (vendor alias) selects codex-tmux for runner", () => {
		const env = { FLYWHEEL_RUNNER_BACKEND: "codex" } as NodeJS.ProcessEnv;
		expect(resolveRoleAdapter({ role: "runner", env }).backend).toBe(
			"codex-tmux",
		);
	});

	it("FLYWHEEL_RUNNER_BACKEND=claude (vendor alias) selects claude-tmux", () => {
		const env = { FLYWHEEL_RUNNER_BACKEND: "claude" } as NodeJS.ProcessEnv;
		expect(resolveRoleAdapter({ role: "runner", env }).backend).toBe(
			"claude-tmux",
		);
	});

	it("vendor alias is case-insensitive (CODEX → codex-tmux)", () => {
		const env = { FLYWHEEL_RUNNER_BACKEND: " CODEX " } as NodeJS.ProcessEnv;
		expect(resolveRoleAdapter({ role: "runner", env }).backend).toBe(
			"codex-tmux",
		);
	});

	it("a vendor with no Phase 1 executor (gemini) still falls back to default", () => {
		const env = { FLYWHEEL_RUNNER_BACKEND: "gemini" } as NodeJS.ProcessEnv;
		expect(resolveRoleAdapter({ role: "runner", env }).backend).toBe(
			"claude-tmux",
		);
	});

	// Codex review: the alias lookup indexes a plain object, so an env value
	// naming a prototype member must NOT resolve to a function/object backend —
	// it must warn + fall back like any other invalid value.
	it.each([
		"constructor",
		"__proto__",
		"toString",
		"hasOwnProperty",
		"valueOf",
	])(
		"prototype-chain key %s does NOT resolve — falls back to default",
		(key) => {
			const env = { FLYWHEEL_RUNNER_BACKEND: key } as NodeJS.ProcessEnv;
			const resolved = resolveRoleAdapter({ role: "runner", env });
			expect(resolved.backend).toBe("claude-tmux");
		},
	);
});

describe("resolveRoleAdapter — project config layer", () => {
	it("project roles beat global env", () => {
		const env = { FLYWHEEL_RUNNER_BACKEND: "claude-tmux" } as NodeJS.ProcessEnv;
		const resolved = resolveRoleAdapter({
			role: "runner",
			projectRoles: { runner: { backend: "codex-tmux", model: "gpt-5.5" } },
			env,
		});
		expect(resolved).toEqual({
			backend: "codex-tmux",
			vendor: "codex",
			model: "gpt-5.5",
		});
	});

	it("project roles for OTHER role do not leak", () => {
		const resolved = resolveRoleAdapter({
			role: "runner",
			projectRoles: { lead: { backend: "codex-tmux" } },
			env: EMPTY_ENV,
		});
		expect(resolved.backend).toBe("claude-tmux");
	});
});

describe("resolveRoleAdapter — task (label) layer", () => {
	it("codex label beats project + env", () => {
		const env = { FLYWHEEL_RUNNER_BACKEND: "claude-tmux" } as NodeJS.ProcessEnv;
		const resolved = resolveRoleAdapter({
			role: "runner",
			issueLabels: ["codex"],
			projectRoles: { runner: { backend: "claude-tmux" } },
			env,
		});
		expect(resolved).toEqual({ backend: "codex-tmux", vendor: "codex" });
	});

	it("claude label beats project codex config (explicit pin-back)", () => {
		const resolved = resolveRoleAdapter({
			role: "runner",
			issueLabels: ["claude"],
			projectRoles: { runner: { backend: "codex-tmux" } },
			env: EMPTY_ENV,
		});
		expect(resolved.backend).toBe("claude-tmux");
	});

	it("model label rides along (gpt-5.5-codex → codex + model)", () => {
		const resolved = resolveRoleAdapter({
			role: "runner",
			issueLabels: ["gpt-5.5-codex"],
			env: EMPTY_ENV,
		});
		expect(resolved).toEqual({
			backend: "codex-tmux",
			vendor: "codex",
			model: "gpt-5.5-codex",
		});
	});

	it("unsupported vendor label (gemini) falls through to project layer", () => {
		const resolved = resolveRoleAdapter({
			role: "runner",
			issueLabels: ["gemini"],
			projectRoles: { runner: { backend: "codex-tmux" } },
			env: EMPTY_ENV,
		});
		expect(resolved.backend).toBe("codex-tmux");
	});

	it("labels do not re-bind the lead role", () => {
		const resolved = resolveRoleAdapter({
			role: "lead",
			issueLabels: ["codex"],
			env: EMPTY_ENV,
		});
		expect(resolved.backend).toBe("claude-tmux");
	});

	it("non-runner labels (bug/p1) resolve to default", () => {
		const resolved = resolveRoleAdapter({
			role: "runner",
			issueLabels: ["bug", "p1"],
			env: EMPTY_ENV,
		});
		expect(resolved.backend).toBe("claude-tmux");
	});
});
