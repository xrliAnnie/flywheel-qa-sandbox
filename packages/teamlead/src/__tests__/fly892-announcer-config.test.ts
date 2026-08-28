/**
 * FLY-892 Step 7: the project-level "system announcer" bot token config
 * (announcerBotTokenEnv → announcerBotToken), mirroring the per-lead botTokenEnv
 * secret model. Default-off: unconfigured → no announcer → broadcasts use the
 * Lead bot (byte-compat).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProjects, resolveAnnouncerBotToken } from "../ProjectConfig.js";

const ENV = "FLY892_ANNOUNCER_TOKEN_TEST";

function minimalProject(extra: Record<string, unknown> = {}) {
	return {
		projectName: "proj",
		projectRoot: "/tmp/proj",
		leads: [
			{
				agentId: "eng-lead",
				summaryRole: "producer",
				chatChannel: "123",
				match: { labels: ["engineer"] },
			},
		],
		...extra,
	};
}

describe("FLY-892 Step 7: announcer bot token config", () => {
	const origProjects = process.env.FLYWHEEL_PROJECTS;
	const origToken = process.env[ENV];

	beforeEach(() => {
		process.env[ENV] = "announcer-secret";
	});
	afterEach(() => {
		if (origProjects === undefined) delete process.env.FLYWHEEL_PROJECTS;
		else process.env.FLYWHEEL_PROJECTS = origProjects;
		if (origToken === undefined) delete process.env[ENV];
		else process.env[ENV] = origToken;
	});

	it("hydrates announcerBotToken from announcerBotTokenEnv", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			minimalProject({ announcerBotTokenEnv: ENV }),
		]);
		const projects = loadProjects();
		expect(projects[0]!.announcerBotToken).toBe("announcer-secret");
		expect(resolveAnnouncerBotToken(projects, "proj")).toBe("announcer-secret");
	});

	it("unconfigured → no announcer token (byte-compat default-off)", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([minimalProject()]);
		const projects = loadProjects();
		expect(projects[0]!.announcerBotToken).toBeUndefined();
		expect(resolveAnnouncerBotToken(projects, "proj")).toBeUndefined();
	});

	it("missing env var → unset (warn, no throw) → falls back to Lead bot", () => {
		delete process.env[ENV];
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			minimalProject({ announcerBotTokenEnv: ENV }),
		]);
		const projects = loadProjects();
		expect(projects[0]!.announcerBotToken).toBeUndefined();
	});

	it("strips a raw announcerBotToken from JSON input (secrets come via env only)", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			minimalProject({ announcerBotToken: "SHOULD-BE-STRIPPED" }),
		]);
		const projects = loadProjects();
		expect(projects[0]!.announcerBotToken).toBeUndefined();
	});

	it("throws on an empty-string announcerBotTokenEnv", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			minimalProject({ announcerBotTokenEnv: "" }),
		]);
		expect(() => loadProjects()).toThrow(/announcerBotTokenEnv/);
	});
});
