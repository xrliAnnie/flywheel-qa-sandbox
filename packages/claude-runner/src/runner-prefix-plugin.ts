import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type { RunnerPrefixArtifactSource } from "./runner-prefix-artifacts.js";

export interface RunnerPrefixPluginInput {
	sourceRoot: string;
	destination: string;
	manifestJson: string;
	/** Complete, audited regular-file inventory; the materializer verifies actual bytes. */
	files: { path: string; sha256: string; executable?: boolean }[];
	selected: Record<"skills" | "commands" | "agents", string[]>;
	required: Record<"skills" | "commands" | "agents", string[]>;
	/** Reviewed asset references, including shell/script references; never inferred by executing text. */
	dependencies: Record<string, string[]>;
}

const kinds = ["skills", "commands", "agents"] as const;
const manifestPath = ".claude-plugin/plugin.json";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function fail(reason: string): never {
	throw new Error(`runner_prefix_plugin: ${reason}`);
}
function path(value: string): void {
	if (
		typeof value !== "string" ||
		!value ||
		isAbsolute(value) ||
		/[\0\\*?[\]{}:]/.test(value) ||
		value.split("/").some((p) => !p || p === "." || p === "..")
	)
		fail("invalid relative path");
}
function component(kind: (typeof kinds)[number], value: string): void {
	path(value);
	if (
		!(kind === "skills"
			? /^skills\/[^/]+$/.test(value)
			: new RegExp(`^${kind}/[^/]+\\.md$`).test(value))
	)
		fail("unsupported component layout");
}

/** Offline compiler for the audited standard skills/commands/agents layout.
 * No source reads or launch side effects: generated manifests and every original
 * source hash are bound by materializeRunnerPrefixArtifacts. Unknown layouts
 * require an explicit compiler extension and CLI control, never a broad fallback.
 * Keep all non-component assets, hooks, MCP configuration and licensing intact.
 */
export function planRunnerPrefixPlugin(
	input: RunnerPrefixPluginInput,
): RunnerPrefixArtifactSource[] {
	path(input.destination);
	if (
		!isAbsolute(input.sourceRoot) ||
		/[\0\\*?[\]{}]/.test(input.sourceRoot) ||
		input.sourceRoot.split("/").some((p) => p === "." || p === "..")
	)
		fail("invalid source root path");
	const files = new Map<string, RunnerPrefixPluginInput["files"][number]>();
	for (const file of input.files) {
		path(file.path);
		if (!/^[a-f0-9]{64}$/.test(file.sha256)) fail("invalid source hash");
		if (files.has(file.path)) fail("duplicate inventory path");
		files.set(file.path, file);
	}
	if (files.get(manifestPath)?.sha256 !== hash(input.manifestJson))
		fail("manifest hash mismatch");
	let manifest: Record<string, unknown>;
	try {
		manifest = JSON.parse(input.manifestJson);
	} catch {
		fail("invalid manifest JSON");
	}
	if (
		!manifest ||
		typeof manifest !== "object" ||
		Array.isArray(manifest) ||
		typeof manifest.name !== "string" ||
		!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(manifest.name)
	)
		fail("invalid plugin name");
	const selected = new Set<string>();
	for (const kind of kinds) {
		const declaration = manifest[kind];
		const declared =
			declaration === undefined
				? [kind]
				: (Array.isArray(declaration) ? declaration : [declaration]).map(
						(value) => {
							if (typeof value !== "string")
								fail("unsupported component layout");
							const normalized = value.replace(/^\.\//, "").replace(/\/$/, "");
							path(normalized);
							if (normalized !== kind) component(kind, normalized);
							return normalized;
						},
					);
		const values = input.selected[kind];
		if (new Set(values).size !== values.length)
			fail("duplicate selected component");
		for (const value of values) {
			component(kind, value);
			if (!declared.includes(kind) && !declared.includes(value))
				fail("component missing from manifest");
			if (!files.has(kind === "skills" ? `${value}/SKILL.md` : value))
				fail("component missing from inventory");
			selected.add(value);
		}
		for (const value of input.required[kind]) {
			component(kind, value);
			if (!selected.has(value)) fail("required component removed");
		}
	}
	const kept = new Set(
		[...files.keys()].filter((value) => {
			if (value === ".in_use") return false;
			const kind = kinds.find((kind) => value.startsWith(`${kind}/`));
			if (!kind) return true;
			return kind === "skills"
				? selected.has(value.split("/").slice(0, 2).join("/"))
				: selected.has(value);
		}),
	);
	for (const [source, dependencies] of Object.entries(input.dependencies)) {
		path(source);
		if (!files.has(source)) fail("dependency source missing");
		for (const dependency of dependencies) {
			path(dependency);
			if (!files.has(dependency)) fail("dependency missing");
			if (kept.has(source) && !kept.has(dependency)) fail("dependency removed");
		}
	}
	// Literal file/directory references in other manifest fields must survive.
	// Embedded commands are covered by the explicit reviewed dependencies above.
	function validateReferences(value: unknown): void {
		if (typeof value === "string" && value.startsWith("./")) {
			const referenced = value.slice(2).replace(/\/$/, "");
			path(referenced);
			if (
				![...kept].some(
					(file) => file === referenced || file.startsWith(`${referenced}/`),
				)
			)
				fail("manifest dependency missing or removed");
		} else if (Array.isArray(value)) value.forEach(validateReferences);
		else if (value && typeof value === "object")
			Object.values(value).forEach(validateReferences);
	}
	for (const [key, value] of Object.entries(manifest)) {
		if (!kinds.some((kind) => kind === key)) validateReferences(value);
	}
	const generated = { ...manifest };
	for (const kind of kinds)
		generated[kind] = [...input.selected[kind]]
			.sort()
			.map((value) => `./${value}`);
	const pluginManifest = `${JSON.stringify(generated, null, 2)}\n`;
	return [...kept].sort().map((value) => ({
		sourcePath: join(input.sourceRoot, value),
		destination: `${input.destination}/${value}`,
		sha256: files.get(value)!.sha256,
		executable: files.get(value)!.executable === true,
		...(value === manifestPath ? { pluginManifest } : {}),
	}));
}
