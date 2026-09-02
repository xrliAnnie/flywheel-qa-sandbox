/**
 * FLY-123: RoleAdapterResolver precedence tests —
 * task(label) > project > global env > built-in default. Target: full
 * combination coverage (plan §6 row 1).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetModelConfigCacheForTests } from "flywheel-config";
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
	// FLY-751: a claude-tmux runner with NO model from any layer no longer
	// inherits the account default (`~/.claude/settings.json` carries a 1M-
	// context model, ~0.35GB extra RAM per runner) — it gets the explicit
	// small-context fleet default instead.
	it("runner with nothing set → claude-tmux + small-context default model (FLY-751)", () => {
		expect(resolveRoleAdapter({ role: "runner", env: EMPTY_ENV })).toEqual({
			backend: "claude-tmux",
			transport: "claude-code",
			vendor: "claude-code",
			model: "claude-fable-5-1",
		});
	});

	it("lead with nothing set → claude-tmux (no model injection — lead untouched)", () => {
		expect(resolveRoleAdapter({ role: "lead", env: EMPTY_ENV })).toEqual({
			backend: "claude-tmux",
			transport: "claude-code",
			vendor: "claude-code",
		});
	});
});

describe("resolveRoleAdapter — FLY-751 runner default model", () => {
	it("follows a future Fable family binding instead of a pinned canonical", () => {
		const root = mkdtempSync(join(tmpdir(), "role-fable-binding-"));
		const path = join(root, "models.json");
		const previous = process.env.FLYWHEEL_MODELS_CONFIG;
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				models: [
					{
						id: "claude-fable-5-2",
						provider: "anthropic",
						runtimeVendor: "claude",
						label: "Fable 5.2",
						aliases: ["fable-5-2"],
						dispatch: true,
					},
					{
						id: "claude-fable-5-2[1m]",
						provider: "anthropic",
						runtimeVendor: "claude",
						label: "Fable 5.2 (1M)",
						aliases: ["fable-5-2-1m"],
						dispatch: true,
						contextWindowTokens: 1_000_000,
					},
				],
				bindings: { fable: "claude-fable-5-2" },
				tiers: { heavy: "fable" },
			}),
		);
		try {
			process.env.FLYWHEEL_MODELS_CONFIG = path;
			resetModelConfigCacheForTests();
			expect(resolveRoleAdapter({ role: "runner", env: EMPTY_ENV }).model).toBe(
				"claude-fable-5-2",
			);
		} finally {
			if (previous === undefined) delete process.env.FLYWHEEL_MODELS_CONFIG;
			else process.env.FLYWHEEL_MODELS_CONFIG = previous;
			resetModelConfigCacheForTests();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("FLYWHEEL_RUNNER_DEFAULT_MODEL overrides the built-in default", () => {
		const resolved = resolveRoleAdapter({
			role: "runner",
			env: { FLYWHEEL_RUNNER_DEFAULT_MODEL: "claude-sonnet-5" },
		});
		expect(resolved.model).toBe("claude-sonnet-5");
	});

	it("FLYWHEEL_RUNNER_DEFAULT_MODEL=off opts back out to the account default", () => {
		const resolved = resolveRoleAdapter({
			role: "runner",
			env: { FLYWHEEL_RUNNER_DEFAULT_MODEL: "OFF" },
		});
		expect(resolved.model).toBeUndefined();
	});

	it("a model label wins — no default injection", () => {
		const resolved = resolveRoleAdapter({
			role: "runner",
			issueLabels: ["opus"],
			env: EMPTY_ENV,
		});
		expect(resolved.model).toBe("claude-opus-5");
	});

	it("a 1m opt-in label wins — no default injection", () => {
		const resolved = resolveRoleAdapter({
			role: "runner",
			issueLabels: ["opus-1m"],
			env: EMPTY_ENV,
		});
		// FLY-1467: the opus-1m label binds to Opus 5 (1M).
		expect(resolved.model).toBe("claude-opus-5[1m]");
	});

	it("an unresolvable dispatch model fails before spawn", () => {
		expect(() =>
			resolveRoleAdapter({
				role: "runner",
				dispatchModel: "claude-not-a-model",
				env: EMPTY_ENV,
			}),
		).toThrow(/unknown model/i);
	});

	it("a legacy id named explicitly reaches argv canonicalized", () => {
		// No blocklist overrides the caller: what config asks for is what spawns.
		const resolved = resolveRoleAdapter({
			role: "runner",
			dispatchModel: "claude-opus-4-8",
			env: EMPTY_ENV,
		});
		expect(resolved.model).toBe("claude-opus-4-8");
	});

	it("project roles model wins — no default injection", () => {
		const resolved = resolveRoleAdapter({
			role: "runner",
			projectRoles: { runner: { backend: "claude-tmux", model: "sonnet" } },
			env: EMPTY_ENV,
		});
		expect(resolved.model).toBe("claude-sonnet-5");
	});

	it("project roles claude-tmux WITHOUT model still gets the default", () => {
		const resolved = resolveRoleAdapter({
			role: "runner",
			projectRoles: { runner: { backend: "claude-tmux" } },
			env: EMPTY_ENV,
		});
		expect(resolved.model).toBe("claude-fable-5-1");
	});

	it("non-claude backends never get the claude default model", () => {
		const codex = resolveRoleAdapter({
			role: "runner",
			env: { FLYWHEEL_RUNNER_BACKEND: "codex-tmux" },
		});
		expect(codex.backend).toBe("codex-tmux");
		expect(codex.model).toBeUndefined();

		const agy = resolveRoleAdapter({
			role: "runner",
			issueLabels: ["agy"],
			env: EMPTY_ENV,
		});
		expect(agy.backend).toBe("antigravity-tmux");
		expect(agy.model).toBeUndefined();
	});
});

describe("resolveRoleAdapter — global env layer", () => {
	it("FLYWHEEL_RUNNER_BACKEND=codex-tmux selects codex for runner", () => {
		const env = { FLYWHEEL_RUNNER_BACKEND: "codex-tmux" } as NodeJS.ProcessEnv;
		expect(resolveRoleAdapter({ role: "runner", env })).toEqual({
			backend: "codex-tmux",
			transport: "codex",
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
			transport: "codex",
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

	// FLY-671: effort resolves INDEPENDENTLY of the backend/model label gate
	// (Codex design review R2 HIGH-2) — a label must NOT drop roles.runner.effort.
	it("roles.runner.effort with no labels → resolved.effort", () => {
		const resolved = resolveRoleAdapter({
			role: "runner",
			projectRoles: { runner: { backend: "claude-tmux", effort: "high" } },
			env: EMPTY_ENV,
		});
		expect(resolved.effort).toBe("high");
	});

	it("a backend-selecting label does NOT drop roles.runner.effort", () => {
		const resolved = resolveRoleAdapter({
			role: "runner",
			issueLabels: ["claude"], // selects backend via label layer
			projectRoles: { runner: { backend: "claude-tmux", effort: "high" } },
			env: EMPTY_ENV,
		});
		// effort still applies even though the label set the backend.
		expect(resolved.effort).toBe("high");
		expect(resolved.backend).toBe("claude-tmux");
	});

	it("a model-selecting label still keeps roles.runner.effort", () => {
		const resolved = resolveRoleAdapter({
			role: "runner",
			issueLabels: ["opus"], // a model label (infers claude vendor)
			projectRoles: { runner: { backend: "claude-tmux", effort: "medium" } },
			env: EMPTY_ENV,
		});
		// Whatever the label does to backend/model, effort is resolved
		// independently from the project roles block.
		expect(resolved.effort).toBe("medium");
	});

	it("no effort anywhere → resolved.effort undefined (byte-compat)", () => {
		const resolved = resolveRoleAdapter({
			role: "runner",
			projectRoles: { runner: { backend: "claude-tmux" } },
			env: EMPTY_ENV,
		});
		expect(resolved.effort).toBeUndefined();
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
		expect(resolved).toEqual({
			backend: "codex-tmux",
			transport: "codex",
			vendor: "codex",
		});
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
			transport: "codex",
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

	// FLY-728: per-issue model routing — a `fable` label pins the Claude tmux
	// backend + the current Fable family model, overriding the project
	// default model (the label layer sets backend, so the project roles layer is
	// skipped entirely). This is the "heavy task → Fable" enabler.
	it("fable label → claude-tmux + current Fable, overriding project model", () => {
		const resolved = resolveRoleAdapter({
			role: "runner",
			issueLabels: ["fable"],
			projectRoles: { runner: { backend: "claude-tmux", model: "sonnet" } },
			env: EMPTY_ENV,
		});
		expect(resolved).toEqual({
			backend: "claude-tmux",
			transport: "claude-code",
			vendor: "claude-code",
			model: "claude-fable-5-1",
		});
	});

	it("fable label overrides a codex project default (Claude model → claude-tmux)", () => {
		const resolved = resolveRoleAdapter({
			role: "runner",
			issueLabels: ["fable"],
			projectRoles: { runner: { backend: "codex-tmux", model: "gpt-5.5" } },
			env: EMPTY_ENV,
		});
		expect(resolved.backend).toBe("claude-tmux");
		expect(resolved.model).toBe("claude-fable-5-1");
	});

	it("fable does not re-bind the lead role", () => {
		const resolved = resolveRoleAdapter({
			role: "lead",
			issueLabels: ["fable"],
			env: EMPTY_ENV,
		});
		expect(resolved.backend).toBe("claude-tmux");
		expect(resolved.model).toBeUndefined();
	});
});

// FLY-728 Part C: the dispatch `model` param — the sorter's output channel. The
// Lead judges difficulty and passes a model at dispatch. It sits BELOW a manual
// model/vendor label (founder's explicit choice wins) and ABOVE the project
// default (smart routing overrides a static project model).
describe("resolveRoleAdapter — dispatch model param (Part C)", () => {
	it("dispatchModel with no label → claude-tmux + that model", () => {
		const resolved = resolveRoleAdapter({
			role: "runner",
			dispatchModel: "claude-fable-5",
			env: EMPTY_ENV,
		});
		expect(resolved).toEqual({
			backend: "claude-tmux",
			transport: "claude-code",
			vendor: "claude-code",
			model: "claude-fable-5",
		});
	});

	it("dispatchModel overrides the project default model (smart routing > project)", () => {
		const resolved = resolveRoleAdapter({
			role: "runner",
			dispatchModel: "claude-fable-5",
			projectRoles: { runner: { backend: "claude-tmux", model: "sonnet" } },
			env: EMPTY_ENV,
		});
		expect(resolved.model).toBe("claude-fable-5");
		expect(resolved.backend).toBe("claude-tmux");
	});

	it("a manual MODEL label beats dispatchModel (founder's explicit choice wins)", () => {
		const resolved = resolveRoleAdapter({
			role: "runner",
			issueLabels: ["opus"],
			dispatchModel: "claude-fable-5",
			env: EMPTY_ENV,
		});
		expect(resolved.model).toBe("claude-opus-5");
	});

	it("a vendor label (codex) beats dispatchModel — no Claude model forced onto codex", () => {
		const resolved = resolveRoleAdapter({
			role: "runner",
			issueLabels: ["codex"],
			dispatchModel: "claude-fable-5",
			env: EMPTY_ENV,
		});
		expect(resolved.backend).toBe("codex-tmux");
		expect(resolved.model).toBeUndefined();
	});

	it("dispatchModel does not affect the lead role", () => {
		const resolved = resolveRoleAdapter({
			role: "lead",
			dispatchModel: "claude-fable-5",
			env: EMPTY_ENV,
		});
		expect(resolved.backend).toBe("claude-tmux");
		expect(resolved.model).toBeUndefined();
	});

	it("no dispatchModel → falls through to project/default (byte-compat)", () => {
		const resolved = resolveRoleAdapter({
			role: "runner",
			projectRoles: { runner: { backend: "claude-tmux", model: "sonnet" } },
			env: EMPTY_ENV,
		});
		expect(resolved.model).toBe("claude-sonnet-5");
	});
});

// FLY-493: Antigravity is a first-class executor backend with NO transport.
describe("resolveRoleAdapter — antigravity (transport=none, FLY-493)", () => {
	it("EXECUTOR_TO_TRANSPORT maps antigravity-tmux → none", () => {
		expect(EXECUTOR_TO_TRANSPORT["antigravity-tmux"]).toBe("none");
	});

	it("antigravity label → antigravity-tmux, transport none, NO vendor", () => {
		const resolved = resolveRoleAdapter({
			role: "runner",
			issueLabels: ["antigravity"],
			env: EMPTY_ENV,
		});
		expect(resolved).toEqual({
			backend: "antigravity-tmux",
			transport: "none",
		});
		expect(resolved.vendor).toBeUndefined();
	});

	it("agy label alias → antigravity-tmux", () => {
		const resolved = resolveRoleAdapter({
			role: "runner",
			issueLabels: ["agy"],
			env: EMPTY_ENV,
		});
		expect(resolved.backend).toBe("antigravity-tmux");
		expect(resolved.transport).toBe("none");
	});

	it("FLYWHEEL_RUNNER_BACKEND=antigravity-tmux selects antigravity", () => {
		const env = {
			FLYWHEEL_RUNNER_BACKEND: "antigravity-tmux",
		} as NodeJS.ProcessEnv;
		const resolved = resolveRoleAdapter({ role: "runner", env });
		expect(resolved.backend).toBe("antigravity-tmux");
		expect(resolved.transport).toBe("none");
	});

	it("FLYWHEEL_RUNNER_BACKEND=agy (vendor alias) selects antigravity-tmux", () => {
		const env = { FLYWHEEL_RUNNER_BACKEND: "agy" } as NodeJS.ProcessEnv;
		expect(resolveRoleAdapter({ role: "runner", env }).backend).toBe(
			"antigravity-tmux",
		);
	});

	it("FLYWHEEL_RUNNER_BACKEND=antigravity (vendor alias) selects antigravity-tmux", () => {
		const env = {
			FLYWHEEL_RUNNER_BACKEND: "antigravity",
		} as NodeJS.ProcessEnv;
		expect(resolveRoleAdapter({ role: "runner", env }).backend).toBe(
			"antigravity-tmux",
		);
	});

	it("project roles antigravity-tmux → transport none", () => {
		const resolved = resolveRoleAdapter({
			role: "runner",
			projectRoles: { runner: { backend: "antigravity-tmux" } },
			env: EMPTY_ENV,
		});
		expect(resolved.backend).toBe("antigravity-tmux");
		expect(resolved.transport).toBe("none");
		expect(resolved.vendor).toBeUndefined();
	});

	it("claude/codex keep an explicit transport (regression guard)", () => {
		expect(
			resolveRoleAdapter({ role: "runner", env: EMPTY_ENV }).transport,
		).toBe("claude-code");
		expect(
			resolveRoleAdapter({
				role: "runner",
				env: { FLYWHEEL_RUNNER_BACKEND: "codex-tmux" } as NodeJS.ProcessEnv,
			}).transport,
		).toBe("codex");
	});
});

// FLY-1224: per-phase vendor — the dispatch layer may carry an explicit vendor
// (phase table output). T1 (mutation α target): removing the 1b vendor
// passthrough MUST turn these red.
describe("resolveRoleAdapter — dispatch vendor (FLY-1224 T1)", () => {
	it("codex dispatch triple → codex-tmux + model + effort", () => {
		const resolved = resolveRoleAdapter({
			role: "runner",
			dispatchModel: "gpt-5.6-sol",
			dispatchVendor: "codex",
			dispatchEffort: "xhigh",
			env: EMPTY_ENV,
		});
		expect(resolved).toEqual({
			backend: "codex-tmux",
			transport: "codex",
			vendor: "codex",
			model: "gpt-5.6-sol",
			effort: "xhigh",
		});
	});

	it("claude dispatch vendor → claude-tmux (explicit form of the status quo)", () => {
		const resolved = resolveRoleAdapter({
			role: "runner",
			dispatchModel: "claude-fable-5",
			dispatchVendor: "claude",
			env: EMPTY_ENV,
		});
		expect(resolved).toEqual({
			backend: "claude-tmux",
			transport: "claude-code",
			vendor: "claude-code",
			model: "claude-fable-5",
		});
	});

	it("dispatchEffort outranks the project roles effort (dispatch > project)", () => {
		const resolved = resolveRoleAdapter({
			role: "runner",
			dispatchModel: "gpt-5.6-sol",
			dispatchVendor: "codex",
			dispatchEffort: "xhigh",
			projectRoles: { runner: { backend: "claude-tmux", effort: "low" } },
			env: EMPTY_ENV,
		});
		expect(resolved.effort).toBe("xhigh");
	});

	it("dispatchEffort applies without a vendor too (claude dispatch lane)", () => {
		const resolved = resolveRoleAdapter({
			role: "runner",
			dispatchModel: "claude-opus-5",
			dispatchEffort: "medium",
			env: EMPTY_ENV,
		});
		expect(resolved.backend).toBe("claude-tmux");
		expect(resolved.effort).toBe("medium");
	});

	it("a vendor label still beats the dispatch layer entirely (label > dispatch)", () => {
		const resolved = resolveRoleAdapter({
			role: "runner",
			issueLabels: ["claude"],
			dispatchModel: "gpt-5.6-sol",
			dispatchVendor: "codex",
			env: EMPTY_ENV,
		});
		// The label layer selected the backend, so 1b never ran; the codex
		// dispatch triple does not leak onto the label-pinned claude backend.
		expect(resolved.backend).toBe("claude-tmux");
		expect(resolved.model).not.toBe("gpt-5.6-sol");
	});

	// T2 (reverse-compat sentinel): the vendor-less dispatch lane is BYTE
	// UNCHANGED — dispatchModel-only resolves exactly the FLY-728 shape, incl.
	// the FLY-751 default-model injection with no dispatch at all.
	it("SENTINEL: dispatchModel WITHOUT vendor → the exact FLY-728 output", () => {
		expect(
			resolveRoleAdapter({
				role: "runner",
				dispatchModel: "claude-fable-5",
				env: EMPTY_ENV,
			}),
		).toEqual({
			backend: "claude-tmux",
			transport: "claude-code",
			vendor: "claude-code",
			model: "claude-fable-5",
		});
		expect(resolveRoleAdapter({ role: "runner", env: EMPTY_ENV })).toEqual({
			backend: "claude-tmux",
			transport: "claude-code",
			vendor: "claude-code",
			model: "claude-fable-5-1",
		});
	});
});

// FLY-494: Kimi Code is a first-class executor backend with NO transport.
describe("resolveRoleAdapter — kimi (transport=none, FLY-494)", () => {
	it("EXECUTOR_TO_TRANSPORT maps kimi-tmux → none", () => {
		expect(EXECUTOR_TO_TRANSPORT["kimi-tmux"]).toBe("none");
	});

	it("kimi label → kimi-tmux, transport none, NO vendor", () => {
		const resolved = resolveRoleAdapter({
			role: "runner",
			issueLabels: ["kimi"],
			env: EMPTY_ENV,
		});
		expect(resolved).toEqual({
			backend: "kimi-tmux",
			transport: "none",
		});
		expect(resolved.vendor).toBeUndefined();
	});

	it("kimi-code label alias → kimi-tmux", () => {
		const resolved = resolveRoleAdapter({
			role: "runner",
			issueLabels: ["kimi-code"],
			env: EMPTY_ENV,
		});
		expect(resolved.backend).toBe("kimi-tmux");
		expect(resolved.transport).toBe("none");
	});

	it("FLYWHEEL_RUNNER_BACKEND=kimi-tmux selects kimi", () => {
		const env = { FLYWHEEL_RUNNER_BACKEND: "kimi-tmux" } as NodeJS.ProcessEnv;
		const resolved = resolveRoleAdapter({ role: "runner", env });
		expect(resolved.backend).toBe("kimi-tmux");
		expect(resolved.transport).toBe("none");
	});

	it("FLYWHEEL_RUNNER_BACKEND=kimi (vendor alias) selects kimi-tmux", () => {
		const env = { FLYWHEEL_RUNNER_BACKEND: "kimi" } as NodeJS.ProcessEnv;
		expect(resolveRoleAdapter({ role: "runner", env }).backend).toBe(
			"kimi-tmux",
		);
	});

	it("project roles kimi-tmux → transport none", () => {
		const resolved = resolveRoleAdapter({
			role: "runner",
			projectRoles: { runner: { backend: "kimi-tmux" } },
			env: EMPTY_ENV,
		});
		expect(resolved.backend).toBe("kimi-tmux");
		expect(resolved.transport).toBe("none");
		expect(resolved.vendor).toBeUndefined();
	});
});
