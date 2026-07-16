import { describe, expect, it, vi } from "vitest";
import { ManagementProjectSource } from "../bridge/management-project-source.js";
import type { ProjectEntry } from "../ProjectConfig.js";

function project(name: string): ProjectEntry {
	return { projectName: name, projectRoot: `/projects/${name}`, leads: [] };
}

describe("management projects last-good source", () => {
	it("keeps the last validated snapshot when a refresh is unreadable or malformed", async () => {
		let content = JSON.stringify([{ projectName: "alpha" }]);
		const warm = vi.fn(async () => {});
		const source = new ManagementProjectSource({
			path: "/home/flywheel/projects.json",
			readFile: () => content,
			parse: (value) =>
				(value as Array<{ projectName: string }>).map((item) =>
					project(item.projectName),
				),
			warm,
		});
		await source.initialize();
		const firstRevision = source.revision();
		expect(source.projects().map((item) => item.projectName)).toEqual([
			"alpha",
		]);

		content = "{not-json";
		expect(await source.refresh()).toBe(false);
		expect(source.projects().map((item) => item.projectName)).toEqual([
			"alpha",
		]);
		expect(source.revision()).toBe(firstRevision);
		expect(source.error()?.message).toMatch(/JSON|position|property/i);

		content = JSON.stringify([{ projectName: "beta" }]);
		expect(await source.refresh()).toBe(true);
		expect(source.projects().map((item) => item.projectName)).toEqual(["beta"]);
		expect(source.error()).toBeNull();
		expect(source.revision()).not.toBe(firstRevision);
		expect(warm).toHaveBeenCalledTimes(2);
	});

	it("starts with an empty, visible source when projects.json is absent", async () => {
		let missing = true;
		const source = new ManagementProjectSource({
			path: "/home/flywheel/projects.json",
			readFile: () => {
				if (missing)
					throw Object.assign(new Error("missing"), { code: "ENOENT" });
				return JSON.stringify([{ projectName: "alpha" }]);
			},
			parse: (value) =>
				(value as Array<{ projectName: string }>).map((item) =>
					project(item.projectName),
				),
			warm: async () => {},
		});
		await source.initialize();
		expect(source.projects()).toEqual([]);
		expect(source.revision()).toBe("file:missing");
		expect(source.error()).toBeNull();

		missing = false;
		expect(await source.refresh()).toBe(true);
		expect(source.projects().map((item) => item.projectName)).toEqual([
			"alpha",
		]);
	});

	it("does not publish new projects until dependent config warming succeeds", async () => {
		let content = JSON.stringify([{ projectName: "alpha" }]);
		let rejectWarm = false;
		const source = new ManagementProjectSource({
			path: "/home/flywheel/projects.json",
			readFile: () => content,
			parse: (value) =>
				(value as Array<{ projectName: string }>).map((item) =>
					project(item.projectName),
				),
			warm: async () => {
				if (rejectWarm) throw new Error("config warm failed");
			},
		});
		await source.initialize();
		content = JSON.stringify([{ projectName: "beta" }]);
		rejectWarm = true;
		expect(await source.refresh()).toBe(false);
		expect(source.projects().map((item) => item.projectName)).toEqual([
			"alpha",
		]);
		expect(source.error()?.message).toContain("config warm failed");
	});
});
