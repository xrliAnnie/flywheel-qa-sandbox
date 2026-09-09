import { describe, expect, it } from "vitest";
import { compileLeadDirectory } from "../lead-directory.js";
import type { ProjectEntry } from "../ProjectConfig.js";

const project = (
	agentId: string,
	displayName: string,
	aliases: string[],
): ProjectEntry => ({
	projectName: agentId === "mufasa" ? "growth" : "flywheel",
	projectRoot: agentId === "mufasa" ? "/srv/growth" : "/srv/flywheel",
	leads: [
		{
			agentId,
			summaryRole: "producer",
			chatChannel: "10000000000000001",
			botUserId:
				agentId === "mufasa" ? "20000000000000001" : "20000000000000002",
			match: { labels: [agentId] },
			voice: "voice-id",
			cosContext: {
				displayName,
				aliases,
				workingSubdirectory: "team",
				identityPath: `/identities/${agentId}.md`,
				memoryPaths: [`/memory/${agentId}.md`],
				writableRoots: [`/srv/${agentId}`],
			},
		},
	],
});

describe("compileLeadDirectory", () => {
	it("projects central CoS metadata and resolves NFKC whitespace aliases", () => {
		const directory = compileLeadDirectory(
			[
				project("mufasa", "Mufasa", ["木 法 沙"]),
				project("tadashi", "Tadashi", ["Ｔａｄａｓｈｉ"]),
			],
			"a".repeat(64),
		);

		expect(directory.projectsDigest).toBe("a".repeat(64));
		expect(directory.leads[0]).toMatchObject({
			ref: { project: "growth", leadId: "mufasa" },
			displayName: "Mufasa",
			projectRoot: "/srv/growth/team",
			botUserId: "20000000000000001",
			voice: "voice-id",
		});
		expect(directory.resolve(" 木法沙 ")?.ref.leadId).toBe("mufasa");
		expect(directory.resolve("Tadashi")?.ref.leadId).toBe("tadashi");
	});

	it("fails closed when aliases normalize to more than one Lead", () => {
		expect(() =>
			compileLeadDirectory(
				[
					project("mufasa", "Mufasa", ["chief"]),
					project("tadashi", "Tadashi", [" c h i e f "]),
				],
				"b".repeat(64),
			),
		).toThrow(/ambiguous CoS Lead name.*chief/i);
	});
});
