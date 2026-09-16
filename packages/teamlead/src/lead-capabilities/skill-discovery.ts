import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { PINNED_PERSONA_SKILL_SOURCES } from "./persona-skill-baseline.js";
import {
	type LeadRuleSourceOptions,
	type LeadSkillSource,
	personaSkillRequirements,
	selectLeadRuleSources,
} from "./rule-sources.js";
import {
	attachLeadSkillAdapters,
	RESEARCH_SKILL_GAPS,
} from "./skill-adapters.js";

/** Canonical persona and the same ordered rule selector used by the launcher. */
export function discoverLeadRuleSources(
	options: Omit<LeadRuleSourceOptions, "skills"> & {
		homeDir: string;
		workspaceDir: string;
	},
) {
	const personaPath =
		options.personaPath ??
		join(
			options.projectRoot,
			".lead",
			options.leadId,
			existsSync(
				join(options.projectRoot, ".lead", options.leadId, "identity.md"),
			)
				? "identity.md"
				: "agent.md",
		);
	const discovered = discoverLeadSkillSources({ ...options, personaPath });
	const selected = selectLeadRuleSources({
		...options,
		personaPath,
		skills: discovered.skills,
	});
	const records = attachLeadSkillAdapters(
		selected.sources,
		join(options.scriptsDir, "../lead-skill-adapters"),
	);
	return {
		records,
		sourceDigest: createHash("sha256")
			.update(JSON.stringify(records))
			.digest("hex"),
		skillInventory: discovered.inventory,
	};
}

export interface LeadSkillInventoryEntry {
	name: string;
	source: string;
	sha256: string | null;
	enabled: boolean | null;
	reason: "in_persona_map" | "not_in_persona_map";
	gapReason?:
		| "authenticated_research_not_available"
		| "research_provider_not_admitted";
}
const bundleSkills = [
	"founder-html-delivery",
	"xiaohongshu-learning",
	"xiaohongshu-deep-learning",
	"proofshot",
	"deep-research",
	"synthesize-research",
];
const namePattern = /^[a-z][a-z0-9-]*$/;
function text(path: string): string | undefined {
	try {
		if (statSync(path).size > 4 * 1024 * 1024)
			throw new Error("skill_source_too_large");
		return readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
function json(path: string): Record<string, unknown> {
	const value = text(path);
	if (value === undefined) return {};
	const parsed: unknown = JSON.parse(value);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("skill_configuration_invalid");
	return parsed as Record<string, unknown>;
}
/** Read-only configured inventory, not proof that a Claude plugin process is active.
 * Admission follows persona + explicit rule-bundle ruling 34034413, never enabled state.
 */
export function discoverLeadSkillSources(options: {
	homeDir: string;
	workspaceDir: string;
	personaPath: string;
}) {
	if (
		![options.homeDir, options.workspaceDir, options.personaPath].every(
			isAbsolute,
		)
	)
		throw new Error("skill_source_path_invalid");
	const persona = text(options.personaPath);
	if (persona === undefined) throw new Error("capability_rules_unverified");
	const required = new Set([
		...personaSkillRequirements(persona),
		...bundleSkills,
	]);
	const enabled = new Map<string, boolean>();
	for (const path of [
		join(options.homeDir, ".claude/settings.json"),
		join(options.workspaceDir, ".claude/settings.json"),
		join(options.workspaceDir, ".claude/settings.local.json"),
	]) {
		const configured = json(path).enabledPlugins;
		if (configured === undefined) continue;
		if (
			!configured ||
			typeof configured !== "object" ||
			Array.isArray(configured)
		)
			throw new Error("skill_configuration_invalid");
		for (const [key, value] of Object.entries(configured)) {
			if (typeof value !== "boolean")
				throw new Error("skill_configuration_invalid");
			enabled.set(key, value);
		}
	}
	const inventory: LeadSkillInventoryEntry[] = [];
	const candidates = new Map<string, string | null>();
	const digest = (path: string) => {
		const value = text(path);
		return value === undefined
			? null
			: createHash("sha256").update(value).digest("hex");
	};
	const scan = (
		root: string,
		namespace: string | undefined,
		flag: boolean | null,
	) => {
		let names: string[];
		try {
			names = readdirSync(root).sort();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		if (names.length > 512) throw new Error("skill_inventory_too_large");
		for (const shortName of names.filter((name) => namePattern.test(name))) {
			const source = join(root, shortName, "SKILL.md"),
				sha256 = digest(source);
			if (sha256 === null) continue;
			const name = namespace ? `${namespace}:${shortName}` : shortName;
			inventory.push({
				name,
				source,
				sha256,
				enabled: flag,
				reason: required.has(name) ? "in_persona_map" : "not_in_persona_map",
			});
			// Project skill configuration overlays user skills; plugin names stay namespaced.
			if (candidates.has(name) && namespace && candidates.get(name) !== source)
				candidates.set(name, null);
			else candidates.set(name, source);
		}
	};
	scan(join(options.homeDir, ".claude/skills"), undefined, true);
	scan(join(options.workspaceDir, ".claude/skills"), undefined, true);
	const registry = json(
		join(options.homeDir, ".claude/plugins/installed_plugins.json"),
	).plugins;
	if (
		registry !== undefined &&
		(!registry || typeof registry !== "object" || Array.isArray(registry))
	)
		throw new Error("skill_configuration_invalid");
	for (const [plugin, rows] of Object.entries(registry ?? {}).sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		const namespace = plugin.split("@")[0]!;
		if (!namePattern.test(namespace) || !Array.isArray(rows))
			throw new Error("skill_configuration_invalid");
		for (const row of rows) {
			if (
				!row ||
				typeof row !== "object" ||
				typeof row.installPath !== "string" ||
				!isAbsolute(row.installPath)
			)
				throw new Error("skill_configuration_invalid");
			if (row.scope !== "user" && row.projectPath !== options.workspaceDir)
				continue;
			const pluginSource = join(row.installPath, ".claude-plugin/plugin.json");
			inventory.push({
				name: `plugin:${namespace}`,
				source: pluginSource,
				sha256: digest(pluginSource),
				enabled: enabled.get(plugin) ?? null,
				reason: "not_in_persona_map",
			});
			scan(
				join(row.installPath, "skills"),
				namespace,
				enabled.get(plugin) ?? null,
			);
		}
	}
	const skills: LeadSkillSource[] = [];
	for (const name of required) {
		const pin = PINNED_PERSONA_SKILL_SOURCES.find(
			(candidate) => candidate.name === name,
		);
		const path = pin
			? join(options.homeDir, pin.homePath)
			: (candidates.get(name) ??
				join(options.homeDir, ".claude/skills", name, "SKILL.md"));
		skills.push({
			name,
			path,
			...(pin ? { sha256: pin.sha256 } : {}),
			...(!pin && candidates.get(name) === null ? { ambiguous: true } : {}),
		});
		if (!inventory.some((row) => row.name === name && row.source === path)) {
			const flags = [...enabled]
				.filter(([key]) => key.startsWith("minimalist-entrepreneur@"))
				.map(([, value]) => value);
			inventory.push({
				name,
				source: path,
				sha256: digest(path),
				enabled: pin?.homePath.includes("minimalist-entrepreneur/")
					? flags.length
						? flags.some(Boolean)
						: null
					: null,
				reason: "in_persona_map",
			});
		}
	}
	if (inventory.length > 512 || skills.length > 128)
		throw new Error("skill_inventory_too_large");
	for (const row of inventory) {
		if (row.reason === "in_persona_map" && RESEARCH_SKILL_GAPS[row.name])
			row.gapReason = RESEARCH_SKILL_GAPS[row.name];
	}
	return { skills, inventory };
}
