import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { discoverLeadSkillSources } from "../skill-discovery.js";

it("keeps enabled methodology inventoried and admits it only when the persona names it", () => {
	const homeDir = mkdtempSync(join(tmpdir(), "skill-discovery-"));
	const workspaceDir = join(homeDir, "workspace"),
		personaPath = join(homeDir, "persona.md");
	const put = (path: string, text: string) => {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, text);
	};
	const installPath = join(homeDir, ".claude/plugins/cache/methodology/1");
	try {
		put(
			join(homeDir, ".claude/settings.json"),
			JSON.stringify({
				enabledPlugins: {
					"methodology@test": true,
					"minimalist-entrepreneur@test": false,
				},
				env: { SECRET: "PRIVATE_CONFIG" },
			}),
		);
		put(
			join(homeDir, ".claude/plugins/installed_plugins.json"),
			JSON.stringify({
				plugins: { "methodology@test": [{ scope: "user", installPath }] },
			}),
		);
		put(join(installPath, "skills/grilling/SKILL.md"), "PRIVATE_SKILL_TEXT");
		put(
			personaPath,
			"# Skill map\n`minimalist-entrepreneur` `last30days`\n# End\n",
		);
		let result = discoverLeadSkillSources({
			homeDir,
			workspaceDir,
			personaPath,
		});
		for (const [name, gapReason] of [
			["deep-research", "authenticated_research_not_available"],
			["last30days", "research_provider_not_admitted"],
		])
			expect(result.inventory.find((row) => row.name === name)).toMatchObject({
				reason: "in_persona_map",
				gapReason,
			});
		expect(
			result.inventory.find((row) => row.name === "plugin:methodology"),
		).toMatchObject({ enabled: true, reason: "not_in_persona_map" });
		expect(
			result.inventory.find((row) => row.name === "methodology:grilling"),
		).toMatchObject({ enabled: true, reason: "not_in_persona_map" });
		expect(
			result.skills.some((skill) => skill.name === "methodology:grilling"),
		).toBe(false);
		expect(result.skills.find((skill) => skill.name === "mvp")?.sha256).toMatch(
			/^[a-f0-9]{64}$/,
		);
		expect(result.inventory.find((row) => row.name === "mvp")).toMatchObject({
			enabled: false,
			reason: "in_persona_map",
		});
		put(personaPath, "# Skill map\n`methodology:grilling`\n# End\n");
		result = discoverLeadSkillSources({ homeDir, workspaceDir, personaPath });
		expect(
			result.skills.find((skill) => skill.name === "methodology:grilling")
				?.path,
		).toBe(join(installPath, "skills/grilling/SKILL.md"));
		const second = join(homeDir, ".claude/plugins/cache/other/1");
		put(join(second, "skills/grilling/SKILL.md"), "second source");
		put(
			join(homeDir, ".claude/plugins/installed_plugins.json"),
			JSON.stringify({
				plugins: {
					"methodology@test": [{ scope: "user", installPath }],
					"methodology@other": [{ scope: "user", installPath: second }],
				},
			}),
		);
		result = discoverLeadSkillSources({ homeDir, workspaceDir, personaPath });
		expect(
			result.inventory.filter(
				(row) => row.name === "methodology:grilling" && row.sha256 !== null,
			),
		).toHaveLength(2);
		expect(
			result.skills.find((skill) => skill.name === "methodology:grilling")
				?.path,
		).not.toBe(join(installPath, "skills/grilling/SKILL.md"));
		expect(
			result.skills.find((skill) => skill.name === "methodology:grilling")
				?.path,
		).not.toBe(join(second, "skills/grilling/SKILL.md"));
		expect(JSON.stringify(result)).not.toContain("PRIVATE_CONFIG");
		expect(JSON.stringify(result)).not.toContain("PRIVATE_SKILL_TEXT");
	} finally {
		rmSync(homeDir, { recursive: true, force: true });
	}
});
