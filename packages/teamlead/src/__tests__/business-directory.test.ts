import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileBusinessDirectory } from "../lead-directory.js";
import type { ProjectEntry } from "../ProjectConfig.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function fixture(): ProjectEntry {
	const root = mkdtempSync(join(tmpdir(), "business-directory-"));
	roots.push(root);
	mkdirSync(join(root, "team"));
	return {
		projectName: "project",
		projectRoot: root,
		leads: [
			{
				agentId: "lead",
				summaryRole: "producer",
				chatChannel: "123",
				match: { labels: [] },
				botUserId: "456",
				botToken: "SECRET",
				botTokenEnv: "SECRET_ENV",
				cosContext: {
					displayName: "Chief",
					aliases: ["Ｃｈｉｅｆ"],
					workingSubdirectory: "team",
					identityPath: "identity.md",
					memoryPaths: ["memory/MEMORY.md"],
					writableRoots: [root],
				},
			},
		],
	};
}
describe("business directory", () => {
	it("keeps every project and Lead, explicitly marking absent metadata and stripping secrets", () => {
		const p = fixture();
		p.leads.push({
			agentId: "external",
			summaryRole: "exempt",
			chatChannel: "789",
			match: { labels: [] },
			external: true,
			canSpawnRunners: false,
		} as ProjectEntry["leads"][number]);
		const d = compileBusinessDirectory(
			[p, { projectName: "empty", projectRoot: p.projectRoot, leads: [] }],
			"a".repeat(64),
		);
		expect(d.projects.map((x) => x.projectName)).toEqual(["project", "empty"]);
		expect(d.leads).toHaveLength(2);
		expect(d.leads[1]).toMatchObject({
			external: true,
			canSpawnRunners: false,
			missing: ["cosContext", "botUserId"],
		});
		expect(d.resolve(" c h i e f ")?.ref).toEqual({
			project: "project",
			leadId: "lead",
		});
		expect(JSON.stringify(d)).not.toMatch(/SECRET|botToken|writableRoots/);
	});
	it("returns all rows while rejecting ambiguous human names with stable candidates", () => {
		const a = fixture();
		const b = fixture();
		b.projectName = "second";
		const d = compileBusinessDirectory([a, b], "b".repeat(64));
		expect(d.leads).toHaveLength(2);
		expect(() => d.resolve("Chief")).toThrow(/project\/lead.*second\/lead/);
	});
	it("refuses a symlink escape and reports unreadable roots without dropping a project", () => {
		const p = fixture();
		const outside = fixture();
		rmSync(join(p.projectRoot, "team"), { recursive: true });
		symlinkSync(outside.projectRoot, join(p.projectRoot, "team"));
		const d = compileBusinessDirectory(
			[
				p,
				{
					projectName: "missing",
					projectRoot: join(p.projectRoot, "absent"),
					leads: [],
				},
			],
			"c".repeat(64),
		);
		expect(d.leads[0].projectRoot).toBeUndefined();
		expect(d.leads[0].missing).toContain("workingRoot");
		expect(d.projects[1]).toMatchObject({
			projectName: "missing",
			status: "unavailable",
		});
	});
});
