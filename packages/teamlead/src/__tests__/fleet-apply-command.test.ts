import { describe, expect, it } from "vitest";
import {
	APPLY_COMMAND_JS,
	buildLeadApplyCommands,
	buildRunnerApplyCommand,
} from "../bridge/fleet-apply-command.js";

// FLY-709 P4.2 (Path C): copyable apply commands. Every argv token must be
// single-quoted (model ids like `claude-opus-4-8[1m]` are zsh-glob-sensitive)
// and the script path is the Bridge-runtime one — never a hardcoded checkout.

const SCRIPT = "/repo/scripts/flywheel-fleet.sh";
const COMM = "/repo/packages/flywheel-comm/dist/index.js";

describe("buildLeadApplyCommands", () => {
	it("renders a model-only change as one quoted fleet apply line", () => {
		const out = buildLeadApplyCommands(SCRIPT, [
			{ key: "flywheel-flywheel-eng-lead", toModel: "claude-sonnet-4-6" },
		]);
		expect(out).toBe(
			"bash '/repo/scripts/flywheel-fleet.sh' apply --lead 'flywheel-flywheel-eng-lead' --model 'claude-sonnet-4-6' --yes",
		);
	});

	it("renders model+effort together on one line", () => {
		const out = buildLeadApplyCommands(SCRIPT, [
			{
				key: "sub-sub-lead",
				toModel: "claude-haiku-4-5-20251001",
				toEffort: "high",
			},
		]);
		expect(out).toBe(
			"bash '/repo/scripts/flywheel-fleet.sh' apply --lead 'sub-sub-lead' --model 'claude-haiku-4-5-20251001' --effort 'high' --yes",
		);
	});

	it("maps null (account default) to the literal 'default'", () => {
		const out = buildLeadApplyCommands(SCRIPT, [
			{ key: "sub-sub-lead", toModel: null, toEffort: null },
		]);
		expect(out).toBe(
			"bash '/repo/scripts/flywheel-fleet.sh' apply --lead 'sub-sub-lead' --model 'default' --effort 'default' --yes",
		);
	});

	it("quotes glob-sensitive model ids (claude-opus-4-8[1m])", () => {
		const out = buildLeadApplyCommands(SCRIPT, [
			{ key: "geoforge3d-product-lead", toModel: "claude-opus-4-8[1m]" },
		]);
		expect(out).toContain("--model 'claude-opus-4-8[1m]'");
	});

	it("escapes paths containing spaces and single quotes", () => {
		const out = buildLeadApplyCommands(
			"/tmp/staging worktree's/scripts/flywheel-fleet.sh",
			[{ key: "sub-sub-lead", toModel: "claude-sonnet-4-6" }],
		);
		expect(
			out.startsWith(
				"bash '/tmp/staging worktree'\\''s/scripts/flywheel-fleet.sh'",
			),
		).toBe(true);
	});

	it("renders a backend change as a manual-cutover comment, never a flag", () => {
		const out = buildLeadApplyCommands(SCRIPT, [
			{
				key: "growth-mufasa-lead",
				backendNote: { from: "codex-app-server", to: "claude-code" },
			},
		]);
		expect(out).toContain(
			"# growth-mufasa-lead: backend codex-app-server → claude-code",
		);
		expect(out).toContain("FLY-264");
		expect(out).not.toContain("--backend");
		expect(out).not.toContain("apply --lead 'growth-mufasa-lead'");
	});

	it("renders one line per change plus comment lines, newline-joined", () => {
		const out = buildLeadApplyCommands(SCRIPT, [
			{ key: "a-lead", toModel: "claude-sonnet-4-6" },
			{
				key: "b-lead",
				toEffort: "low",
				backendNote: { from: "claude-code", to: "codex-app-server" },
			},
		]);
		const lines = out.split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("--lead 'a-lead'");
		expect(lines[1].startsWith("#")).toBe(true);
		expect(lines[2]).toContain("--lead 'b-lead' --effort 'low' --yes");
	});

	it("returns an empty string when there is nothing to emit", () => {
		expect(buildLeadApplyCommands(SCRIPT, [])).toBe("");
	});
});

describe("buildRunnerApplyCommand", () => {
	it("renders a project runner-default model change", () => {
		const out = buildRunnerApplyCommand(COMM, "sub", {
			model: "claude-sonnet-4-6",
		});
		expect(out).toBe(
			"node '/repo/packages/flywheel-comm/dist/index.js' runner-config apply --project 'sub' --model 'claude-sonnet-4-6' --yes",
		);
	});

	it("renders backend and effort dimensions when given", () => {
		const out = buildRunnerApplyCommand(COMM, "joycon-typeless", {
			backend: "kimi-tmux",
			effort: null,
		});
		expect(out).toBe(
			"node '/repo/packages/flywheel-comm/dist/index.js' runner-config apply --project 'joycon-typeless' --backend 'kimi-tmux' --effort 'default' --yes",
		);
	});

	it("targets a cron collection when cronId is given", () => {
		const out = buildRunnerApplyCommand(
			COMM,
			"flywheel",
			{ model: "claude-haiku-4-5-20251001" },
			"my-collection.1",
		);
		expect(out).toBe(
			"node '/repo/packages/flywheel-comm/dist/index.js' runner-config apply --project 'flywheel' --cron 'my-collection.1' --model 'claude-haiku-4-5-20251001' --yes",
		);
	});

	it("returns an empty string when no dimension is touched", () => {
		expect(buildRunnerApplyCommand(COMM, "sub", {})).toBe("");
	});
});

// Parity: the embeddable browser JS must produce byte-identical output to the
// TS builders (it is the version the console + hosted page actually run).
describe("APPLY_COMMAND_JS parity", () => {
	function jsBuilders(): {
		leadCommands: (p: string, c: unknown[]) => string;
		runnerCommand: (p: string, n: string, c: unknown, cron?: string) => string;
	} {
		return new Function(`${APPLY_COMMAND_JS}; return FleetCmd;`)();
	}

	it("leadCommands matches buildLeadApplyCommands on every case shape", () => {
		const js = jsBuilders();
		const cases = [
			[{ key: "flywheel-flywheel-eng-lead", toModel: "claude-sonnet-4-6" }],
			[
				{
					key: "sub-sub-lead",
					toModel: "claude-haiku-4-5-20251001",
					toEffort: "high",
				},
			],
			[{ key: "sub-sub-lead", toModel: null, toEffort: null }],
			[{ key: "geoforge3d-product-lead", toModel: "claude-opus-4-8[1m]" }],
			[
				{
					key: "growth-mufasa-lead",
					backendNote: { from: "codex-app-server", to: "claude-code" },
				},
			],
			[
				{ key: "a-lead", toModel: "claude-sonnet-4-6" },
				{
					key: "b-lead",
					toEffort: "low",
					backendNote: { from: "claude-code", to: "codex-app-server" },
				},
			],
		];
		for (const changes of cases) {
			expect(js.leadCommands("/tmp/staging worktree's/f.sh", changes)).toBe(
				buildLeadApplyCommands(
					"/tmp/staging worktree's/f.sh",
					changes as Parameters<typeof buildLeadApplyCommands>[1],
				),
			);
		}
	});

	it("runnerCommand matches buildRunnerApplyCommand incl. cron + defaults", () => {
		const js = jsBuilders();
		const cases: Array<[string, Record<string, unknown>, string | undefined]> =
			[
				["sub", { model: "claude-sonnet-4-6" }, undefined],
				["joycon-typeless", { backend: "kimi-tmux", effort: null }, undefined],
				["flywheel", { model: "claude-haiku-4-5-20251001" }, "my-collection.1"],
				["sub", {}, undefined],
			];
		for (const [proj, change, cron] of cases) {
			expect(js.runnerCommand("/repo cli's/index.js", proj, change, cron)).toBe(
				buildRunnerApplyCommand(
					"/repo cli's/index.js",
					proj,
					change as Parameters<typeof buildRunnerApplyCommand>[2],
					cron,
				),
			);
		}
	});
});
