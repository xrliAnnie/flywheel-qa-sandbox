import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { readManifestMarkdown } from "./manifest-instructions.js";
export const NATIVE_CODEX_SKILL_NAMES = [
	"imagegen",
	"openai-docs",
	"plugin-creator",
	"review-agent",
	"skill-creator",
	"skill-installer",
] as const;
export interface NativeSkillBaseline {
	codexVersion: string;
	origin?: { root: string; files: readonly { path: string; sha256: string }[] };
	sources: readonly { name: string; sha256: string }[];
}
export function verifyNativeSkillBaseline(options: {
	root: string;
	baseline: NativeSkillBaseline;
	codexVersion: string;
	secrets: readonly string[];
}) {
	try {
		const { root, baseline, codexVersion } = options;
		if (
			!codexVersion ||
			baseline.codexVersion !== codexVersion ||
			realpathSync(root) !== root ||
			!lstatSync(root).isDirectory()
		)
			throw new Error();
		const names = baseline.sources.map((s) => s.name).sort();
		if (JSON.stringify(names) !== JSON.stringify(NATIVE_CODEX_SKILL_NAMES))
			throw new Error();
		const entries = readdirSync(root)
			.filter((name) => name !== ".codex-system-skills.marker")
			.sort();
		if (JSON.stringify(entries) !== JSON.stringify(names)) throw new Error();
		const sources = baseline.sources.map((source) => {
			const directory = join(root, source.name),
				path = join(directory, "SKILL.md");
			if (
				realpathSync(directory) !== directory ||
				lstatSync(path).isSymbolicLink()
			)
				throw new Error();
			return { ...source, path };
		});
		readManifestMarkdown(sources, options.secrets);
		return sources.map((source) => ({
			name: source.name,
			sourcePath: source.path,
			sha256: source.sha256,
			codexVersion,
			status: "selected" as const,
		}));
	} catch {
		throw Object.assign(new Error("baseline_drift"), {
			receipt: { status: "baseline_drift", codexVersion: options.codexVersion },
		});
	}
}
