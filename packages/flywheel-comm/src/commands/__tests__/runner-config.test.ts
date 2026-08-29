import { describe, expect, it, vi } from "vitest";
import { runRunnerConfig } from "../runner-config.js";

// FLY-709 P4.3 — `flywheel-comm runner-config apply`. The CLI resolves the
// project's root from ~/.flywheel/projects.json and hands the change to the
// flywheel-config writer. It never fabricates configs and refuses without
// --yes (the pasted command carries founder authorization explicitly).

function makeDeps(
	overrides: Partial<Parameters<typeof runRunnerConfig>[1]> = {},
) {
	const logs: string[] = [];
	const errors: string[] = [];
	let exitCode: number | undefined;
	const deps = {
		readProjectsJson: vi.fn(() =>
			JSON.stringify([
				{ projectName: "sub", projectRoot: "/repos/sub", leads: [] },
				{ projectName: "flywheel", projectRoot: "/repos/flywheel", leads: [] },
			]),
		),
		applyRunnerDefaults: vi.fn(async () => ({
			changed: ["roles.runner.model"],
		})),
		applyCronModel: vi.fn(async () => ({
			changed: ['xiaohongshu_learning.collections["c1"].model'],
		})),
		log: (m: string) => logs.push(m),
		errorLog: (m: string) => errors.push(m),
		exit: ((code: number) => {
			exitCode = code;
			throw new Error(`exit ${code}`);
		}) as (code: number) => never,
		...overrides,
	};
	return { deps, logs, errors, exitCode: () => exitCode };
}

describe("runner-config apply", () => {
	it("applies a runner model change against the resolved project config path", async () => {
		const { deps, logs } = makeDeps();
		await runRunnerConfig(
			["apply", "--project", "sub", "--model", "claude-sonnet-5", "--yes"],
			deps,
		);
		expect(deps.applyRunnerDefaults).toHaveBeenCalledWith(
			"/repos/sub/.flywheel/config.yaml",
			{ model: "claude-sonnet-5" },
		);
		expect(logs.join("\n")).toContain("roles.runner.model");
		expect(logs.join("\n")).toContain("新 run 生效");
	});

	it("maps the literal 'default' to null (remove override)", async () => {
		const { deps } = makeDeps();
		await runRunnerConfig(
			["apply", "--project", "sub", "--effort", "default", "--yes"],
			deps,
		);
		expect(deps.applyRunnerDefaults).toHaveBeenCalledWith(
			"/repos/sub/.flywheel/config.yaml",
			{ effort: null },
		);
	});

	it("routes --cron to the cron-model writer", async () => {
		const { deps } = makeDeps();
		await runRunnerConfig(
			[
				"apply",
				"--project",
				"flywheel",
				"--cron",
				"c1",
				"--model",
				"haiku",
				"--yes",
			],
			deps,
		);
		expect(deps.applyCronModel).toHaveBeenCalledWith(
			"/repos/flywheel/.flywheel/config.yaml",
			{ collectionId: "c1", model: "haiku" },
		);
		expect(deps.applyRunnerDefaults).not.toHaveBeenCalled();
	});

	it("rejects --cron combined with --backend or --effort", async () => {
		const { deps, errors, exitCode } = makeDeps();
		await expect(
			runRunnerConfig(
				[
					"apply",
					"--project",
					"flywheel",
					"--cron",
					"c1",
					"--effort",
					"high",
					"--yes",
				],
				deps,
			),
		).rejects.toThrow(/exit 1/);
		expect(exitCode()).toBe(1);
		expect(errors.join("\n")).toMatch(/--cron/);
	});

	it("refuses without --yes and changes nothing", async () => {
		const { deps, exitCode } = makeDeps();
		await expect(
			runRunnerConfig(["apply", "--project", "sub", "--model", "sonnet"], deps),
		).rejects.toThrow(/exit 1/);
		expect(exitCode()).toBe(1);
		expect(deps.applyRunnerDefaults).not.toHaveBeenCalled();
	});

	it("fails loud on an unknown project", async () => {
		const { deps, errors, exitCode } = makeDeps();
		await expect(
			runRunnerConfig(
				["apply", "--project", "nope", "--model", "sonnet", "--yes"],
				deps,
			),
		).rejects.toThrow(/exit 1/);
		expect(exitCode()).toBe(1);
		expect(errors.join("\n")).toMatch(/nope/);
		expect(deps.applyRunnerDefaults).not.toHaveBeenCalled();
	});

	it("fails loud when no dimension flag is given", async () => {
		const { deps, exitCode } = makeDeps();
		await expect(
			runRunnerConfig(["apply", "--project", "sub", "--yes"], deps),
		).rejects.toThrow(/exit 1/);
		expect(exitCode()).toBe(1);
	});

	it("propagates writer failures as exit 1 with the message", async () => {
		const { deps, errors } = makeDeps({
			applyRunnerDefaults: vi.fn(async () => {
				throw new Error(
					"no project config at /repos/sub/.flywheel/config.yaml",
				);
			}),
		});
		await expect(
			runRunnerConfig(
				["apply", "--project", "sub", "--model", "sonnet", "--yes"],
				deps,
			),
		).rejects.toThrow(/exit 1/);
		expect(errors.join("\n")).toContain("no project config");
	});

	it("supports projects.json wrapped in a {projects: []} object", async () => {
		const { deps } = makeDeps({
			readProjectsJson: vi.fn(() =>
				JSON.stringify({
					projects: [
						{ projectName: "sub", projectRoot: "/repos/sub", leads: [] },
					],
				}),
			),
		});
		await runRunnerConfig(
			["apply", "--project", "sub", "--model", "sonnet", "--yes"],
			deps,
		);
		expect(deps.applyRunnerDefaults).toHaveBeenCalledWith(
			"/repos/sub/.flywheel/config.yaml",
			{ model: "sonnet" },
		);
	});
});
