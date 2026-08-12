import { describe, expect, it } from "vitest";
import {
	buildNonLeadClaudeSettings,
	mergeNonLeadClaudeSettingsArgv,
	NON_LEAD_FORBIDDEN_PLUGINS,
} from "../non-lead-forbidden-plugins.js";

const FORK = "discord@flywheel-plugins";
const OFFICIAL = "discord@claude-plugins-official";

describe("non-Lead forbidden Claude plugins", () => {
	it("contains both Discord marketplace identities and marks both false", () => {
		expect(NON_LEAD_FORBIDDEN_PLUGINS).toEqual([FORK, OFFICIAL]);
		expect(buildNonLeadClaudeSettings()).toEqual({
			enabledPlugins: {
				[FORK]: false,
				[OFFICIAL]: false,
			},
		});
	});

	it("deep-merges caller settings but writes forbidden entries security-last", () => {
		expect(
			buildNonLeadClaudeSettings({
				alwaysThinkingEnabled: false,
				enabledPlugins: {
					[FORK]: true,
					"ponytail@ponytail": true,
				},
				permissions: { allow: ["Read"] },
			}),
		).toEqual({
			alwaysThinkingEnabled: false,
			enabledPlugins: {
				[FORK]: false,
				"ponytail@ponytail": true,
				[OFFICIAL]: false,
			},
			permissions: { allow: ["Read"] },
		});
	});

	it("parses both CLI settings forms and emits exactly one canonical flag", () => {
		const argv = mergeNonLeadClaudeSettingsArgv([
			"-p",
			"--settings",
			JSON.stringify({ enabledPlugins: { [FORK]: true } }),
			"--model",
			"sonnet",
			`--settings=${JSON.stringify({ effortLevel: "high" })}`,
		]);

		expect(argv.filter((arg) => arg === "--settings")).toHaveLength(1);
		expect(argv.some((arg) => arg.startsWith("--settings="))).toBe(false);
		expect(argv.slice(0, 3)).toEqual(["-p", "--model", "sonnet"]);
		expect(JSON.parse(argv.at(-1) as string)).toEqual({
			enabledPlugins: { [FORK]: false, [OFFICIAL]: false },
			effortLevel: "high",
		});
	});

	it("fails closed on malformed or value-less caller settings", () => {
		expect(() => buildNonLeadClaudeSettings("{bad json")).toThrow(
			/valid JSON object/i,
		);
		expect(() => mergeNonLeadClaudeSettingsArgv(["--settings"])).toThrow(
			/requires a JSON value/i,
		);
	});
});
