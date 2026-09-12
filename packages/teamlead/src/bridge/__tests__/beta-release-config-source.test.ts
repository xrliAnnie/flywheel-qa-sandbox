import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readBetaReleaseProjects } from "../beta-release-config-source.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
async function project(name: string, config: string) {
	const root = await mkdtemp(join(tmpdir(), "beta-config-"));
	roots.push(root);
	await mkdir(join(root, ".flywheel"));
	await writeFile(join(root, ".flywheel/config.yaml"), config);
	return { projectName: name, projectRoot: root, projectRepo: `test/${name}` };
}
it("reads independent canonical project files on every refresh and isolates invalid configuration", async () => {
	const a = await project(
		"a",
		"beta_release: {interval_hours: 6, workflow_file: beta.yml, token_env: A_TOKEN}",
	);
	const b = await project(
		"b",
		"beta_release: {workflow_file: beta.yml, token_env: B_TOKEN}",
	);
	const env = {
		FLYWHEEL_BETA_ACTIONS_TOKEN_ENVS: "A_TOKEN,B_TOKEN",
		A_TOKEN: "token-a",
		B_TOKEN: "token-b",
	};
	const initial = await readBetaReleaseProjects([a, b], env);
	expect(
		initial.map((p) => [p.projectName, p.config?.interval_hours, p.reason]),
	).toEqual([
		["a", 6, null],
		["b", 24, null],
	]);
	await writeFile(
		join(a.projectRoot, ".flywheel/config.yaml"),
		"beta_release: {interval_hours: 0}",
	);
	const updated = await readBetaReleaseProjects([a, b], env);
	expect(updated[0].reason).toBe("config_invalid");
	expect(updated[0].config).toBeUndefined();
	expect(updated[1]).toEqual(initial[1]);
});

it("requires separate explicit credentials and safe repository bindings without token fallback", async () => {
	const a = await project(
		"a",
		"beta_release: {workflow_file: beta.yml, token_env: A_TOKEN}",
	);
	const b = await project(
		"b",
		"beta_release: {workflow_file: beta.yml, token_env: B_TOKEN}",
	);
	expect(
		(await readBetaReleaseProjects([a, b], { GH_TOKEN: "fallback" })).map(
			(p) => p.reason,
		),
	).toEqual(["credential_missing", "credential_missing"]);
	expect(
		(
			await readBetaReleaseProjects([a, b], {
				FLYWHEEL_BETA_ACTIONS_TOKEN_ENVS: "A_TOKEN,B_TOKEN",
				A_TOKEN: "same",
				B_TOKEN: "same",
			})
		).map((p) => p.reason),
	).toEqual(["credential_shared", "credential_shared"]);
	await writeFile(
		join(b.projectRoot, ".flywheel/config.yaml"),
		"beta_release: {workflow_file: beta.yml, token_env: A_TOKEN}",
	);
	expect(
		(
			await readBetaReleaseProjects([a, b], {
				FLYWHEEL_BETA_ACTIONS_TOKEN_ENVS: "A_TOKEN,B_TOKEN",
				A_TOKEN: "token",
			})
		).map((p) => p.reason),
	).toEqual(["credential_shared", "credential_shared"]);
	expect(
		(
			await readBetaReleaseProjects(
				[{ ...a, projectRepo: "https://evil/repo" }],
				{
					FLYWHEEL_BETA_ACTIONS_TOKEN_ENVS: "A_TOKEN,B_TOKEN",
					A_TOKEN: "token",
				},
			)
		)[0].reason,
	).toBe("binding_invalid");
});

it("treats missing configuration as unconfigured and rejects a config symlink outside its project", async () => {
	const { symlink } = await import("node:fs/promises");
	const a = await project("a", "{}");
	const b = await project(
		"b",
		"beta_release: {workflow_file: beta.yml, token_env: B_TOKEN}",
	);
	await rm(join(a.projectRoot, ".flywheel/config.yaml"));
	expect((await readBetaReleaseProjects([a], {}))[0].reason).toBe(
		"unconfigured",
	);
	await symlink(
		join(b.projectRoot, ".flywheel/config.yaml"),
		join(a.projectRoot, ".flywheel/config.yaml"),
	);
	expect(
		(
			await readBetaReleaseProjects([a], {
				FLYWHEEL_BETA_ACTIONS_TOKEN_ENVS: "A_TOKEN,B_TOKEN",
				B_TOKEN: "token",
			})
		)[0].reason,
	).toBe("binding_invalid");
});

it("requires an operator allowlist before inspecting a project's selected credential", async () => {
	const a = await project(
		"a",
		"beta_release: {workflow_file: beta.yml, token_env: UNRELATED_SECRET}",
	);
	const env = { FLYWHEEL_BETA_ACTIONS_TOKEN_ENVS: "A_TOKEN" };
	Object.defineProperty(env, "UNRELATED_SECRET", {
		get() {
			throw new Error("secret read");
		},
	});
	expect((await readBetaReleaseProjects([a], env))[0].reason).toBe(
		"credential_missing",
	);
	expect(
		(await readBetaReleaseProjects([a], { UNRELATED_SECRET: "value" }))[0]
			.reason,
	).toBe("credential_missing");
});
