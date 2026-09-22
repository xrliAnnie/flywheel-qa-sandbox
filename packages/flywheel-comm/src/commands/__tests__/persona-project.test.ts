import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPersonaProject } from "../persona-project.js";

describe("persona-project command dormant path", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	it.each([
		["flywheel", "flywheel-eng-lead", "xrliAnnie/flywheel"],
		["raya", "raya", "xrliAnnie/raya"],
	])(
		"skips %s/%s without requiring state root, token, or writes",
		async (projectName, leadId, projectRepo) => {
			const home = mkdtempSync(join(tmpdir(), "fly2696-command-"));
			dirs.push(home);
			mkdirSync(join(home, ".flywheel"));
			const projectsFile = join(home, "projects.json");
			writeFileSync(
				projectsFile,
				JSON.stringify([
					{
						projectName,
						projectRoot: "/must/not/be/read",
						projectRepo,
						leads: [
							{
								agentId: leadId,
								summaryRole: "recipient",
								chatChannel: "12345678901234567",
								match: { labels: ["fixture"] },
								...(projectName === "raya"
									? {
											backend: "codex-app-server",
											codexProfile: "full-access",
											canSpawnRunners: false,
										}
									: {}),
							},
						],
					},
				]),
			);
			const stdout = vi.fn();
			await expect(
				runPersonaProject(
					[
						"--project",
						projectName,
						"--lead",
						leadId,
						"--projects-file",
						projectsFile,
					],
					{
						homeDir: home,
						env: { FLYWHEEL_STATE_DIR: join(home, ".flywheel") },
						stdout,
					},
				),
			).resolves.toBe(0);
			expect(JSON.parse(stdout.mock.calls[0]![0])).toMatchObject({
				status: "skipped",
			});
		},
	);
});
