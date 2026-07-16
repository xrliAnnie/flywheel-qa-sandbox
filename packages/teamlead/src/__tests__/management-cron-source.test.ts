import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	matchProjectRoot,
	normalizeWeeklySchedule,
	scanManagementCrons,
} from "../bridge/management-cron-source.js";
import type { ProjectEntry } from "../ProjectConfig.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(
	HERE,
	"fixtures",
	"fly1262",
	"com.xiaorongli.weee-weekly.plist",
);

const ARBITRARY_LABEL_PLIST = {
	Label: "com.xiaorongli.weee-weekly",
	ProgramArguments: [
		"/bin/bash",
		"/__FLY1262_PROJECT_ROOT__/personal-assistant/tasks/weee-grocery/scripts/run-weekly.sh",
	],
	StartCalendarInterval: { Weekday: 3, Hour: 9, Minute: 0 },
};

function project(name: string, root = `/projects/${name}`): ProjectEntry {
	return { projectName: name, projectRoot: root, leads: [] };
}

type FakeFile = {
	plist?: Record<string, unknown>;
	error?: string;
	kind?: "file" | "symlink" | "directory";
};

function scan(
	files: Record<string, FakeFile>,
	projects: ProjectEntry[] = [project("alpha")],
	opts: {
		disabled?: string[];
		loaded?: string[];
		failPrintDisabled?: boolean;
	} = {},
) {
	const directory = "/launch";
	return scanManagementCrons({
		launchAgentsDir: directory,
		projects,
		uid: 501,
		deps: {
			readdir: () => Object.keys(files),
			lstat: (path) => {
				const item = files[path.slice(directory.length + 1)]!;
				return {
					isFile: () => (item.kind ?? "file") === "file",
					isSymbolicLink: () => item.kind === "symlink",
				};
			},
			realpath: (path) => path,
			readFile: (path) =>
				Buffer.from(
					JSON.stringify(files[path.slice(directory.length + 1)]?.plist ?? {}),
				),
			execFile: (file, args) => {
				if (file === "plutil") {
					const item = files[String(args.at(-1)).slice(directory.length + 1)]!;
					if (item.error) throw new Error(item.error);
					return JSON.stringify(item.plist);
				}
				if (args[0] === "print-disabled") {
					if (opts.failPrintDisabled) {
						throw new Error("launchctl evidence unavailable");
					}
					return (opts.disabled ?? [])
						.map((label) => `\"${label}\" => true`)
						.join("\n");
				}
				const label = String(args[1]).split("/").at(-1)!;
				if (!(opts.loaded ?? []).includes(label)) throw new Error("not loaded");
				return "service = { state = running }";
			},
		},
	});
}

function scheduled(
	label: string,
	programArguments: string[],
	schedule: unknown = { Weekday: 1, Hour: 9, Minute: 0 },
) {
	return {
		Label: label,
		ProgramArguments: programArguments,
		StartCalendarInterval: schedule,
	};
}

describe("weekly launchd schedule normalization", () => {
	it("supports dict/array, Sunday 0/7, all-days defaults, and Cartesian times", () => {
		expect(
			normalizeWeeklySchedule({ Weekday: 0, Hour: 9, Minute: 5 }).schedule,
		).toMatchObject({ days: [7], label: "自定义" });
		expect(
			normalizeWeeklySchedule({ Weekday: 7, Hour: 9, Minute: 5 }).schedule,
		).toMatchObject({ days: [7] });
		const daily = normalizeWeeklySchedule([
			{ Hour: 9, Minute: 0 },
			{ Hour: 17, Minute: 30 },
		]);
		expect(daily).toMatchObject({
			writable: true,
			schedule: {
				days: [1, 2, 3, 4, 5, 6, 7],
				times: [
					{ hour: 9, minute: 0 },
					{ hour: 17, minute: 30 },
				],
				label: "每日",
			},
		});
	});

	it("derives workday, weekend, custom labels and warns on duplicates", () => {
		const table = (days: number[]) =>
			days.map((Weekday) => ({ Weekday, Hour: 9, Minute: 0 }));
		expect(
			normalizeWeeklySchedule(table([1, 2, 3, 4, 5])).schedule?.label,
		).toBe("工作日");
		expect(normalizeWeeklySchedule(table([6, 7])).schedule?.label).toBe("周末");
		expect(normalizeWeeklySchedule(table([2, 4])).schedule?.label).toBe(
			"自定义",
		);
		expect(
			normalizeWeeklySchedule([
				{ Weekday: 1, Hour: 9, Minute: 0 },
				{ Weekday: 1, Hour: 9, Minute: 0 },
			]).warnings.join(" "),
		).toMatch(/重复/);
	});

	it("keeps advanced, incomplete, and sparse tables read-only without inventing a schedule", () => {
		for (const value of [
			{ Month: 7, Day: 14, Hour: 9, Minute: 0 },
			{ Weekday: 1, Minute: 0 },
			[
				{ Weekday: 1, Hour: 9, Minute: 0 },
				{ Weekday: 2, Hour: 10, Minute: 0 },
			],
		]) {
			const result = normalizeWeeklySchedule(value);
			expect(result.writable).toBe(false);
			expect(result.schedule).toBeNull();
		}
	});

	it("reports range errors instead of substituting defaults", () => {
		for (const value of [
			{ Weekday: 8, Hour: 9, Minute: 0 },
			{ Weekday: 1, Hour: 24, Minute: 0 },
			{ Weekday: 1, Hour: 9, Minute: 60 },
		]) {
			const result = normalizeWeeklySchedule(value);
			expect(result.schedule).toBeNull();
			expect(result.error).toMatch(/range|范围/i);
		}
	});
});

describe("launchd cron SSOT discovery", () => {
	it("maps an arbitrary label and bash argv1 to its project on every platform", () => {
		const result = scan(
			{
				"com.xiaorongli.weee-weekly.plist": {
					plist: ARBITRARY_LABEL_PLIST,
				},
			},
			[
				project(
					"personal-assistant",
					"/__FLY1262_PROJECT_ROOT__/personal-assistant",
				),
			],
		);
		expect(result.projectCrons[0]).toMatchObject({
			projectName: "personal-assistant",
			crons: [{ label: "com.xiaorongli.weee-weekly" }],
		});
	});

	it.skipIf(process.platform !== "darwin")(
		"parses the real launchd XML fixture with the macOS system plutil",
		() => {
			const parsed = JSON.parse(
				execFileSync("plutil", ["-convert", "json", "-o", "-", FIXTURE], {
					encoding: "utf8",
				}),
			) as Record<string, unknown>;
			expect(parsed).toEqual(ARBITRARY_LABEL_PLIST);
		},
	);

	it("ignores label prefixes, keeps unmatched jobs, duplicate labels, and deterministic file order", () => {
		const result = scan({
			"z.plist": {
				plist: scheduled("same.label", ["relative-script.sh"]),
			},
			"a.plist": {
				plist: scheduled("same.label", ["/usr/bin/adobe-job"]),
			},
			"b.plist": {
				plist: scheduled("com.flywheel.looks-managed", ["relative.sh"]),
			},
			"not-cron.plist": {
				plist: { Label: "not.cron", Program: "/projects/alpha/job" },
			},
		});
		expect(result.projectCrons[0]!.crons).toEqual([]);
		expect(result.unassignedCrons.map((cron) => cron.sourceHint)).toEqual([
			"a.plist",
			"b.plist",
			"z.plist",
		]);
		const duplicateIds = result.unassignedCrons
			.filter((cron) => cron.label === "same.label")
			.map((cron) => cron.id);
		expect(new Set(duplicateIds).size).toBe(2);
	});

	it("considers Program and every absolute argv, with longest-root ownership", () => {
		const ownership = matchProjectRoot(
			[
				"/projects/tidal-echo/sub/content/job.sh",
				"/projects/tidal-echo/top.sh",
			],
			[
				{ projectName: "tidal-echo", projectRoot: "/projects/tidal-echo" },
				{
					projectName: "sub-content",
					projectRoot: "/projects/tidal-echo/sub/content",
				},
			],
		);
		expect(ownership).toEqual({ projectName: "sub-content" });
		const result = scan({
			"program.plist": {
				plist: {
					...scheduled("program", ["relative"]),
					Program: "/projects/alpha/from-program.sh",
				},
			},
			"argv.plist": {
				plist: scheduled("argv", ["/bin/bash", "/projects/alpha/from-argv.sh"]),
			},
		});
		expect(
			result.projectCrons[0]!.crons.map((cron) => cron.label).sort(),
		).toEqual(["argv", "program"]);
	});

	it("marks equal-root ambiguity, symlinks, and malformed plists as visible read-only errors", () => {
		const result = scan(
			{
				"ambiguous.plist": {
					plist: scheduled("ambiguous", ["/same/job.sh"]),
				},
				"linked.plist": { kind: "symlink" },
				"malformed.plist": { error: "bad plist" },
				"healthy.plist": {
					plist: scheduled("healthy", ["/projects/alpha/job.sh"]),
				},
			},
			[project("one", "/same"), project("two", "/same"), project("alpha")],
		);
		expect(
			result.projectCrons.find((item) => item.projectName === "alpha")?.crons,
		).toHaveLength(1);
		const errors = result.unassignedCrons.map((cron) => cron.error).join(" ");
		expect(errors).toMatch(/ambiguous|歧义/i);
		expect(errors).toMatch(/symlink|符号链接/i);
		expect(errors).toMatch(/bad plist/i);
	});

	it("separates disabled/loaded evidence and recognizes only direct model argv bindings", () => {
		const result = scan(
			{
				"model.plist": {
					plist: scheduled("model.job", [
						"/projects/alpha/job.sh",
						"--model",
						"gpt-5.6-sol",
					]),
				},
			},
			undefined,
			{ disabled: ["model.job"], loaded: ["model.job"] },
		);
		const cron = result.projectCrons[0]!.crons[0]!;
		expect(cron.enabled.current).toBe(false);
		expect(cron.loaded).toBe(true);
		expect(cron.model).toMatchObject({
			current: { provider: "openai", model: "gpt-5.6-sol" },
			writeCapability: { writable: true },
		});
	});

	it("fails closed when disabled-state evidence is unavailable", () => {
		const result = scan(
			{
				"disabled.plist": {
					plist: scheduled("disabled.job", [
						"/projects/alpha/job.sh",
						"--model",
						"gpt-5.6-sol",
					]),
				},
			},
			undefined,
			{ failPrintDisabled: true },
		);
		const cron = result.projectCrons[0]!.crons[0]!;
		expect(cron.enabled.current).toBeNull();
		expect(cron.loaded).toBeNull();
		expect(cron.enabled.writeCapability).toMatchObject({
			writable: false,
			reason: expect.stringMatching(/launchctl|运行状态/i),
		});
		expect(cron.schedule.writeCapability).toMatchObject({
			writable: false,
			reason: expect.stringMatching(/launchctl|运行状态/i),
		});
		expect(cron.model?.writeCapability).toMatchObject({
			writable: false,
			reason: expect.stringMatching(/launchctl|运行状态/i),
		});
		expect(cron.enabled.error).toMatch(/launchctl|运行状态/i);
	});

	it("keeps missing or non-canonical labels visible but read-only", () => {
		const result = scan({
			"missing.plist": {
				plist: {
					ProgramArguments: ["/projects/alpha/missing.sh"],
					StartCalendarInterval: { Weekday: 1, Hour: 9, Minute: 0 },
				},
			},
			"whitespace.plist": {
				plist: scheduled(" whitespace.job ", ["/projects/alpha/whitespace.sh"]),
			},
		});
		for (const cron of result.projectCrons[0]!.crons) {
			expect(cron.schedule.writeCapability).toMatchObject({ writable: false });
			expect(cron.enabled.writeCapability).toMatchObject({ writable: false });
			expect(cron.error).toMatch(/Label/i);
		}
	});

	it("redacts absolute filesystem paths from browser diagnostics", () => {
		const result = scan({
			"secret.plist": {
				error: "ENOENT: /Users/founder/private/secret.plist",
			},
		});
		const serialized = JSON.stringify(result.unassignedCrons);
		expect(serialized).not.toContain("/Users/founder");
		expect(serialized).not.toContain("private/secret.plist");
	});
});
