import { expect, it } from "vitest";
import { parseAndValidateProjects } from "../ProjectConfig.js";

const project = {
	projectName: "example",
	projectRoot: "/tmp/example",
	leads: [
		{
			agentId: "engineering-lead",
			summaryRole: "producer",
			chatChannel: "123",
			match: { labels: ["Engineering"] },
		},
	],
};

it("accepts absent and positive fractional lead-note fade policy", () => {
	expect(parseAndValidateProjects([project])[0]?.epicPage).toBeUndefined();
	expect(
		parseAndValidateProjects([
			{ ...project, epicPage: { leadNoteFadeDays: 2.5 } },
		])[0]?.epicPage,
	).toEqual({ leadNoteFadeDays: 2.5 });
});

it.each([
	null,
	[],
	"3",
	{ unknown: 3 },
	{ leadNoteFadeDays: 0 },
	{ leadNoteFadeDays: -1 },
	{ leadNoteFadeDays: "3" },
	{ leadNoteFadeDays: null },
	{ leadNoteFadeDays: Number.MAX_VALUE },
	{ leadNoteFadeDays: Infinity },
	{ leadNoteFadeDays: NaN },
])("rejects invalid explicit lead-note policy %j", (epicPage) => {
	expect(() => parseAndValidateProjects([{ ...project, epicPage }])).toThrow(
		"epicPage",
	);
});
