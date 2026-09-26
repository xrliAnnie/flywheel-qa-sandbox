import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	materializeRunnerPrefixArtifacts,
	verifyRunnerPrefixArtifacts,
} from "../src/runner-prefix-artifacts.js";
import {
	planRunnerPrefixPlugin,
	type RunnerPrefixPluginInput,
} from "../src/runner-prefix-plugin.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const roots: string[] = [];
function fixture(): RunnerPrefixPluginInput {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "fly2913-plugin-")));
	roots.push(root);
	const manifestJson = JSON.stringify({
		name: "mixed",
		version: "1.2.3",
		skills: "./skills/",
		commands: "./commands/",
		agents: ["./agents/reviewer.md", "./agents/unrelated.md"],
		hooks: "./hooks/hooks.json",
		mcpServers: "./.mcp.json",
	});
	const contents: Record<string, string> = {
		".claude-plugin/plugin.json": manifestJson,
		"skills/security/SKILL.md": "Use scripts/check.sh",
		"skills/security/scripts/check.sh": "#!/bin/sh\necho checked\n",
		"skills/unrelated/SKILL.md": "Unrelated skill",
		"commands/review.md": "Review with reviewer",
		"commands/unused.md": "Unused command",
		"agents/reviewer.md": "Review task",
		"agents/unrelated.md": "Unrelated agent",
		"hooks/hooks.json": `{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"\${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh"}]}]}}`,
		"scripts/hook.sh": "#!/bin/sh\necho hooked\n",
		"scripts/lib/helper.js": "export const helper = true;",
		".mcp.json": '{"mcpServers":{}}',
		LICENSE: "original license",
		".in_use": "cache liveness marker",
	};
	const files = Object.entries(contents).map(([path, content]) => {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
		return { path, sha256: hash(content), executable: path.endsWith(".sh") };
	});
	return {
		sourceRoot: root,
		destination: "plugins/mixed",
		manifestJson,
		files,
		selected: {
			skills: ["skills/security"],
			commands: ["commands/review.md"],
			agents: ["agents/reviewer.md"],
		},
		required: {
			skills: ["skills/security"],
			commands: ["commands/review.md"],
			agents: ["agents/reviewer.md"],
		},
		dependencies: {
			"commands/review.md": ["agents/reviewer.md"],
			"hooks/hooks.json": ["scripts/hook.sh"],
			"scripts/hook.sh": ["scripts/lib/helper.js"],
		},
	};
}
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("selected-component plugin compiler", () => {
	it("materializes callable names, selected skill assets and intact runtime closure", () => {
		const input = fixture();
		const sources = planRunnerPrefixPlugin(input);
		const targetDirectory = join(input.sourceRoot, "private");
		const bundle = {
			trustedRoots: [input.sourceRoot],
			targetDirectory,
			identity: {
				version: 1 as const,
				executionId: "exec",
				sessionId: "session",
				role: "implement" as const,
				profileDigest: hash("profile"),
			},
			sources,
		};
		const result = materializeRunnerPrefixArtifacts(bundle);
		expect(verifyRunnerPrefixArtifacts(bundle)).toEqual(result);
		const copied = (path: string) =>
			readFileSync(join(result.directory, input.destination, path), "utf8");
		expect(JSON.parse(copied(".claude-plugin/plugin.json"))).toEqual({
			name: "mixed",
			version: "1.2.3",
			skills: ["./skills/security"],
			commands: ["./commands/review.md"],
			agents: ["./agents/reviewer.md"],
			hooks: "./hooks/hooks.json",
			mcpServers: "./.mcp.json",
		});
		for (const path of [
			"hooks/hooks.json",
			"scripts/hook.sh",
			"scripts/lib/helper.js",
			"LICENSE",
			".mcp.json",
			"skills/security/SKILL.md",
			"skills/security/scripts/check.sh",
		])
			expect(copied(path)).toBe(
				readFileSync(join(input.sourceRoot, path), "utf8"),
			);
		expect(
			sources.some((s) => /unrelated|unused|\.in_use/.test(s.destination)),
		).toBe(false);
	});
	it("has stable output independent of inventory and selection ordering", () => {
		const input = fixture();
		const before = planRunnerPrefixPlugin(input);
		input.files.reverse();
		expect(planRunnerPrefixPlugin(input)).toEqual(before);
	});
	it("supports default component directories when manifest fields are omitted", () => {
		const input = fixture();
		input.manifestJson = '{"name":"mixed"}';
		input.files.find((f) => f.path === ".claude-plugin/plugin.json")!.sha256 =
			hash(input.manifestJson);
		const manifest = planRunnerPrefixPlugin(input).find(
			(f) => f.pluginManifest,
		)!.pluginManifest!;
		expect(JSON.parse(manifest).skills).toEqual(["./skills/security"]);
	});
	it.each(["skills", "commands", "agents"] as const)(
		"refuses to remove required %s",
		(kind) => {
			const input = fixture();
			input.selected[kind] = [];
			expect(() => planRunnerPrefixPlugin(input)).toThrow(/required component/);
		},
	);
	it("refuses selected components absent from the pinned inventory", () => {
		const input = fixture();
		input.selected.skills.push("skills/missing");
		expect(() => planRunnerPrefixPlugin(input)).toThrow(/component missing/);
	});
	it("refuses removal of a transitive component dependency", () => {
		const input = fixture();
		input.dependencies["scripts/lib/helper.js"] = ["skills/unrelated/SKILL.md"];
		expect(() => planRunnerPrefixPlugin(input)).toThrow(/dependency removed/);
	});
	it("rejects incomplete retained runtime assets", () => {
		const input = fixture();
		input.files = input.files.filter((f) => f.path !== "scripts/lib/helper.js");
		expect(() => planRunnerPrefixPlugin(input)).toThrow(/dependency missing/);
	});
	it("does not accept changed manifest bytes or namespace", () => {
		const input = fixture();
		input.manifestJson = '{"name":"other"}';
		expect(() => planRunnerPrefixPlugin(input)).toThrow(/manifest hash/);
	});
	it.each([
		"../escape",
		"/absolute",
		"skills/../escape",
		"skills/*",
		"skills/a\\b",
	])("rejects invalid inventory path %s", (path) => {
		const input = fixture();
		input.files.push({ path, sha256: hash("bad"), executable: false });
		expect(() => planRunnerPrefixPlugin(input)).toThrow(/path/);
	});
	it("rejects duplicate inventory paths", () => {
		const input = fixture();
		input.files.push(input.files[0]!);
		expect(() => planRunnerPrefixPlugin(input)).toThrow(/duplicate/);
	});
	it("rejects unrecognized component layouts instead of silently broadening selection", () => {
		const input = fixture();
		input.manifestJson = '{"name":"mixed","skills":"./custom-skills"}';
		input.files[0]!.sha256 = hash(input.manifestJson);
		expect(() => planRunnerPrefixPlugin(input)).toThrow(
			/unsupported component layout/,
		);
	});
	it("keeps non-component manifest fields exactly, including inline hooks", () => {
		const input = fixture();
		input.manifestJson =
			'{"name":"mixed","hooks":{"hooks":{}},"description":"Original text","author":{"name":"Author"}}';
		input.files[0]!.sha256 = hash(input.manifestJson);
		const parsed = JSON.parse(
			planRunnerPrefixPlugin(input).find((f) => f.pluginManifest)!
				.pluginManifest!,
		);
		expect(parsed.hooks).toEqual({ hooks: {} });
		expect(parsed.author).toEqual({ name: "Author" });
		expect(parsed.description).toBe("Original text");
	});
});
