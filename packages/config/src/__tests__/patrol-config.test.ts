import {
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigLoader } from "../ConfigLoader.js";
import {
	DEFAULT_PATROL_INTERVAL_MINUTES,
	effectivePatrolIntervalMs,
	getGlobalPatrolConfigSnapshot,
	getProjectPatrolConfigSnapshot,
	resetPatrolConfigCachesForTests,
} from "../patrol-config.js";

const BASE_CONFIG = `
project: patrol-test
linear:
  team_id: team-1
runners:
  default: claude
  available:
    claude:
      command: claude
teams:
  - name: product
decision_layer:
  autonomy_level: observer
  escalation_channel: alerts
`;

describe("FLY-1687 patrol configuration", () => {
	let root: string;
	let globalPath: string;
	let projectRoot: string;
	let previousPath: string | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "fly1687-patrol-config-"));
		globalPath = join(root, "patrol.json");
		projectRoot = join(root, "mainline");
		previousPath = process.env.FLYWHEEL_PATROL_CONFIG;
		process.env.FLYWHEEL_PATROL_CONFIG = globalPath;
		resetPatrolConfigCachesForTests();
	});

	afterEach(() => {
		if (previousPath === undefined) delete process.env.FLYWHEEL_PATROL_CONFIG;
		else process.env.FLYWHEEL_PATROL_CONFIG = previousPath;
		resetPatrolConfigCachesForTests();
		rmSync(root, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("defaults to 60 minutes and applies project > global > default precedence", () => {
		expect(DEFAULT_PATROL_INTERVAL_MINUTES).toBe(60);
		expect(effectivePatrolIntervalMs(undefined, undefined)).toBe(60 * 60_000);
		expect(
			effectivePatrolIntervalMs(
				{ interval_minutes: 45 },
				{ interval_minutes: 30 },
			),
		).toBe(45 * 60_000);
	});

	it("hot-reloads an atomic global replacement and warns once per bad snapshot", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		writeFileSync(globalPath, JSON.stringify({ interval_minutes: 30 }));
		const first = getGlobalPatrolConfigSnapshot();
		expect(first.config.interval_minutes).toBe(30);

		const replacement = join(root, "patrol.next");
		writeFileSync(replacement, JSON.stringify({ interval_minutes: 5 }));
		renameSync(replacement, globalPath);
		const stat = statSync(globalPath);
		utimesSync(globalPath, stat.atime, new Date(stat.mtimeMs + 5));

		const clamped = getGlobalPatrolConfigSnapshot();
		expect(clamped.revision).not.toBe(first.revision);
		expect(clamped.config.interval_minutes).toBe(10);
		getGlobalPatrolConfigSnapshot();
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("falls back on malformed/non-finite global input and clamps the 24h cap", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		writeFileSync(globalPath, '{"interval_minutes":');
		expect(getGlobalPatrolConfigSnapshot().config).toEqual({});
		getGlobalPatrolConfigSnapshot();
		expect(warn).toHaveBeenCalledTimes(1);

		const replacement = join(root, "patrol.valid");
		writeFileSync(replacement, JSON.stringify({ interval_minutes: 10_000 }));
		renameSync(replacement, globalPath);
		expect(getGlobalPatrolConfigSnapshot().config.interval_minutes).toBe(1440);
		expect(warn).toHaveBeenCalledTimes(2);
	});

	it("reads only the supplied mainline project root and recovers after malformed YAML", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const configPath = join(projectRoot, ".flywheel", "config.yaml");
		const worktreeRoot = join(root, "session-worktree");
		mkdirSync(join(projectRoot, ".flywheel"), { recursive: true });
		mkdirSync(join(worktreeRoot, ".flywheel"), { recursive: true });
		writeFileSync(configPath, "patrol: [broken");
		writeFileSync(
			join(worktreeRoot, ".flywheel", "config.yaml"),
			"patrol:\n  interval_minutes: 11\n",
		);

		expect(getProjectPatrolConfigSnapshot(projectRoot).config).toEqual({});
		expect(getProjectPatrolConfigSnapshot(projectRoot).config).toEqual({});
		expect(warn).toHaveBeenCalledTimes(1);

		const next = join(projectRoot, ".flywheel", "config.next");
		writeFileSync(next, "patrol:\n  interval_minutes: 25\n");
		renameSync(next, configPath);
		expect(
			getProjectPatrolConfigSnapshot(projectRoot).config.interval_minutes,
		).toBe(25);
	});

	it("rejects non-object and non-positive/non-finite project patrol values", async () => {
		for (const patrol of [
			"null",
			"[]",
			"{ interval_minutes: null }",
			"{ interval_minutes: 0 }",
			"{ interval_minutes: .inf }",
		]) {
			const loader = new ConfigLoader(
				async () => `${BASE_CONFIG}\npatrol: ${patrol}\n`,
			);
			await expect(loader.load("config.yaml")).rejects.toThrow(/patrol/i);
		}
	});
});
