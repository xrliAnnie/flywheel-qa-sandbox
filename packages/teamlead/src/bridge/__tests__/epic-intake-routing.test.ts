import { describe, expect, it } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { resolveEpicIntakeOwner } from "../epic-intake.js";

const project = (name = "test"): ProjectEntry => ({
	projectName: name,
	projectRoot: "/tmp/test",
	linear: { team: "TEST", project: "Sandbox" },
	leads: [
		{
			agentId: "lead",
			chatChannel: "test-channel",
			match: { labels: ["Engineering"] },
		},
		{
			agentId: "ops",
			chatChannel: "ops-channel",
			match: { labels: ["Operations"] },
		},
	],
});
const root = {
	team: { key: "TEST" },
	project: { name: "Sandbox" },
	labels: ["Engineering"],
	parent: null,
};
describe("strict intake routing", () => {
	it("selects the unique bound project and department", () => {
		expect(resolveEpicIntakeOwner([project()], root)).toMatchObject({
			ok: true,
			projectName: "test",
			leadId: "lead",
		});
	});
	it("rejects absent bindings and ambiguous project matches", () => {
		expect(
			resolveEpicIntakeOwner([{ ...project(), linear: null }], root),
		).toEqual({ ok: false, reason: "project_unmatched" });
		expect(resolveEpicIntakeOwner([project(), project("other")], root)).toEqual(
			{ ok: false, reason: "project_ambiguous" },
		);
	});
	it.each([
		{ ...root, labels: [] },
		{ ...root, labels: ["Engineering", "Operations"] },
		{ ...root, parent: { id: "parent" } },
		{ ...root, team: { key: "OTHER" } },
		{ ...root, project: { name: "Other" } },
	])("does not fall back to the first lead %#", (issue) => {
		expect(resolveEpicIntakeOwner([project()], issue).ok).toBe(false);
	});
	it("honors binding labels and non-dispatch leads", () => {
		const p = project();
		p.linear!.label = "ProjectLabel";
		expect(resolveEpicIntakeOwner([p], root).ok).toBe(false);
		p.leads[0].canSpawnRunners = false;
		expect(
			resolveEpicIntakeOwner([p], {
				...root,
				labels: ["Engineering", "ProjectLabel"],
			}).ok,
		).toBe(false);
	});
});
