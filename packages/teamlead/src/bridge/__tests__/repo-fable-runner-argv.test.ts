import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TmuxAdapter } from "flywheel-claude-runner";
import { ConfigLoader, resetModelConfigCacheForTests } from "flywheel-config";
import type { AdapterExecutionContext } from "flywheel-core";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRoleAdapter } from "../role-adapter-resolver.js";

const REPO_CONFIG = fileURLToPath(
	new URL("../../../../../.flywheel/config.yaml", import.meta.url),
);
const priorModelsConfig = process.env.FLYWHEEL_MODELS_CONFIG;

class ClaudeArgProbe extends TmuxAdapter {
	constructor() {
		super("flywheel", (() => ({ stdout: "" })) as never);
	}

	args(model: string): string[] {
		return this.buildCliArgs(
			{
				executionId: "fly2238-repo-config",
				issueId: "FLY-2238",
				prompt: "",
				cwd: fileURLToPath(new URL("../../../../../", import.meta.url)),
				model,
			} satisfies AdapterExecutionContext,
			"10000000-0000-4000-8000-000000000001",
		).args;
	}
}

afterEach(() => {
	if (priorModelsConfig === undefined)
		delete process.env.FLYWHEEL_MODELS_CONFIG;
	else process.env.FLYWHEEL_MODELS_CONFIG = priorModelsConfig;
	resetModelConfigCacheForTests();
});

async function resolveRepoRunnerArgs(models: unknown): Promise<string[]> {
	const dir = mkdtempSync(join(tmpdir(), "fly2238-repo-argv-"));
	const modelsPath = join(dir, "models.json");
	writeFileSync(modelsPath, JSON.stringify(models));
	process.env.FLYWHEEL_MODELS_CONFIG = modelsPath;
	resetModelConfigCacheForTests();
	try {
		const config = await new ConfigLoader((path) =>
			readFile(path, "utf8"),
		).load(REPO_CONFIG);
		expect(config.roles?.runner?.model).toBe("fable");
		const resolved = resolveRoleAdapter({
			role: "runner",
			projectRoles: config.roles,
			env: {},
		});
		return new ClaudeArgProbe().args(resolved.model!);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("repo config → resolver → Claude argv", () => {
	it.each([
		["builtin authority", { version: 1 }],
		[
			"Founder same-id overlay",
			{
				version: 1,
				models: [
					{
						id: "claude-fable-5-1",
						label: "Fable 5.1",
						provider: "anthropic",
						runtimeVendor: "claude",
						aliases: ["fable-5-1"],
						dispatch: true,
					},
					{
						id: "claude-fable-5-1[1m]",
						label: "Fable 5.1 (1M)",
						provider: "anthropic",
						runtimeVendor: "claude",
						aliases: ["fable-5-1-1m"],
						dispatch: true,
					},
				],
				bindings: { fable: "claude-fable-5-1" },
			},
		],
	] as const)(
		"canonicalizes the repo's fable alias under %s",
		async (_name, models) => {
			const args = await resolveRepoRunnerArgs(models);
			const modelFlags = args.flatMap((arg, index) =>
				arg === "--model" ? [args[index + 1]] : [],
			);
			expect(modelFlags).toEqual(["claude-fable-5-1"]);
			expect(args).not.toContain("fable");
		},
	);

	it("rejects an unknown project alias in the resolver, before the launch seam", async () => {
		const yaml = (await readFile(REPO_CONFIG, "utf8")).replace(
			/^ {4}model: fable$/m,
			"    model: fable-does-not-exist",
		);
		const dir = mkdtempSync(join(tmpdir(), "fly2238-unknown-alias-"));
		const modelsPath = join(dir, "models.json");
		writeFileSync(modelsPath, JSON.stringify({ version: 1 }));
		process.env.FLYWHEEL_MODELS_CONFIG = modelsPath;
		resetModelConfigCacheForTests();
		try {
			const config = await new ConfigLoader(async () => yaml).load(REPO_CONFIG);
			expect(() =>
				resolveRoleAdapter({
					role: "runner",
					projectRoles: config.roles,
					env: {},
				}),
			).toThrow(/unknown model/i);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
