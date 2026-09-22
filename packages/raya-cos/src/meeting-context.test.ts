import { describe, expect, it } from "vitest";
import { createLeadDirectory } from "./meeting-context.js";

describe("central Lead directory projection", () => {
	it("normalizes aliases but rejects an ambiguous display name", () => {
		const directory = createLeadDirectory("digest-1", [
			{
				ref: { project: "a", leadId: "one" },
				botUserId: "12345678901234567",
				displayName: "Tadashi",
				aliases: ["塔达西"],
				projectRoot: "/work/a",
				memoryPaths: [],
				writableRoots: [],
			},
			{
				ref: { project: "b", leadId: "two" },
				botUserId: "22345678901234567",
				displayName: "Tadashi",
				aliases: ["小田"],
				projectRoot: "/work/b",
				memoryPaths: [],
				writableRoots: [],
			},
		]);

		expect(directory.resolve("塔 达 西")).toMatchObject({
			status: "found",
			ref: { project: "a", leadId: "one" },
		});
		expect(directory.resolve("Ｔａｄａｓｈｉ")).toMatchObject({
			status: "ambiguous",
			candidates: [
				{ project: "a", leadId: "one" },
				{ project: "b", leadId: "two" },
			],
		});
		expect(directory.projectsDigest).toBe("digest-1");
	});
});
