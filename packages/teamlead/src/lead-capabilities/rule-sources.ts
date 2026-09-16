import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import type { LeadCapabilityManifestInput } from "./manifest.js";
import { readManifestMarkdown } from "./manifest-instructions.js";
export interface LeadSkillSource {
	name: string;
	path: string;
	adapterPath?: string;
	/** Reviewed source pin, never computed from current content by the runtime. */
	sha256?: string;
	/** Discovery found multiple sources for this mapped name; none was selected. */
	ambiguous?: boolean;
}
export interface LeadRuleSourceOptions {
	/** Omitted preserves the canonical Claude selection. */
	backend?: "claude-code" | "codex-app-server";
	scriptsDir: string;
	projectRoot: string;
	leadId: string;
	role: "dept" | "cos" | "companion" | "external";
	commBackend: "mailbox" | "commdb";
	hasSummaryDuty: boolean;
	inboxEnabled: boolean;
	screencaptureEnabled: boolean;
	personaPath?: string;
	/** Actual installed/advertised skill sources, in discovery order; no implicit filename blacklist. */
	skills: readonly LeadSkillSource[];
	/** Additional real launcher sources, after its selected standard layers. */
	extraRulePaths?: readonly string[];
	/** Audited text-only backend adaptations, keyed by exact source ID. */
	adapters?: Readonly<Record<string, string>>;
}
export interface LeadRuleSourceRecord {
	sourceId: string;
	layer: "persona" | "launcher" | "base" | "project" | "skill";
	sourcePath: string | null;
	sourceSha256: string | null;
	realSourcePath: string | null;
	adapterPath: string | null;
	adapterSha256: string | null;
	status: "selected" | "missing" | "not_applicable";
	reason: string;
	required: boolean;
}

/** Verify actual consumed files; persona gaps are visible, never silently advertised. */
export function prepareLeadManifestSources(
	records: readonly LeadRuleSourceRecord[],
	secrets: readonly string[],
) {
	const ruleSources: LeadCapabilityManifestInput["ruleSources"][number][] = [];
	const skillSources: LeadCapabilityManifestInput["skillSources"][number][] =
		[];
	const skillGaps: NonNullable<
		LeadCapabilityManifestInput["skillGaps"]
	>[number][] = [];
	const seen = new Set<string>();
	for (const record of records) {
		if (seen.has(record.sourceId)) throw new Error("duplicate_rule_source");
		seen.add(record.sourceId);
		if (record.status === "not_applicable") continue;
		const skill = record.layer === "skill";
		if (record.status === "missing") {
			if (skill)
				skillGaps.push({
					sourceId: record.sourceId,
					reason:
						record.reason === "pinned_persona_skill_changed" ||
						record.reason === "runner_workflow_not_lead_capability" ||
						record.reason === "authenticated_research_not_available" ||
						record.reason === "research_provider_not_admitted"
							? record.reason
							: "missing_persona_skill_manual_fallback",
				});
			else if (record.required) throw new Error("capability_rules_unverified");
			continue;
		}
		try {
			if (!record.sourcePath || !record.sourceSha256) throw new Error();
			const original = { path: record.sourcePath, sha256: record.sourceSha256 };
			const consumed = record.adapterPath
				? { path: record.adapterPath, sha256: record.adapterSha256 ?? "" }
				: original;
			readManifestMarkdown(
				record.adapterPath ? [original, consumed] : [original],
				secrets,
			);
			if (skill)
				skillSources.push({
					name: record.sourceId.replace(/^skill\//, ""),
					...consumed,
				});
			else ruleSources.push(consumed);
		} catch {
			if (!skill) throw new Error("capability_rules_unverified");
			skillGaps.push({
				sourceId: record.sourceId,
				reason: "pinned_persona_skill_changed",
			});
		}
	}
	return { ruleSources, skillSources, skillGaps };
}
const hash = (content: string | Buffer) =>
	createHash("sha256").update(content).digest("hex");
/** Explicit source aliases, Lead ruling 4b1bfb67; these are not callable tool names. */
const skillAliases: Readonly<Record<string, readonly string[]>> = {
	"minimalist-entrepreneur": [
		"company-values",
		"find-community",
		"first-customers",
		"grow-sustainably",
		"marketing-plan",
		"minimalist-review",
		"mvp",
		"pricing",
		"processize",
		"validate-idea",
	],
	research: ["deep-research", "synthesize-research"],
};
function checkedPath(path: string): string {
	if (
		!isAbsolute(path) ||
		normalize(path) !== path ||
		[...path].some(
			(character) =>
				character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
		)
	)
		throw new Error("invalid_rule_source_path");
	return path;
}
function inspect(path: string) {
	checkedPath(path);
	if (!existsSync(path)) return null;
	const real = realpathSync(path),
		stat = statSync(real);
	if (!stat.isFile() || stat.size > 1024 * 1024 || !path.endsWith(".md"))
		throw new Error("invalid_rule_source_file");
	const content = readFileSync(real);
	return { real, sha: hash(content), content: content.toString("utf8") };
}
/** Extract the actual canonical persona's explicit skill map, including research/plugin extras. */
export function personaSkillRequirements(content: string): string[] {
	const section =
		content.match(/^# Skill map[^\n]*\n([\s\S]*?)(?=^# |$(?![\s\S]))/m)?.[1] ??
		"";
	return [
		...new Set(
			[
				...section.matchAll(/`([a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)?)`/g),
			].flatMap((match) => skillAliases[match[1]!] ?? [match[1]!]),
		),
	];
}
/** Shared ordered source selection. Selection is evidence, not permission to expose raw vendor instructions. */
export function selectLeadRuleSources(options: LeadRuleSourceOptions) {
	checkedPath(options.scriptsDir);
	checkedPath(options.projectRoot);
	if (
		!/^[A-Za-z0-9_-]+$/.test(options.leadId) ||
		!["dept", "cos", "companion", "external"].includes(options.role)
	)
		throw new Error("invalid_rule_source_identity");
	const sources: LeadRuleSourceRecord[] = [],
		adapters = { ...options.adapters };
	const codexDepartment =
		options.backend === "codex-app-server" && options.role === "dept";
	if (codexDepartment) {
		const id = "base/discord-reply-contract.md";
		const adapter = normalize(
			join(
				options.scriptsDir,
				"../lead-rules-base/codex-discord-reply-contract.md",
			),
		);
		if (adapters[id] && adapters[id] !== adapter)
			throw new Error("conflicting_codex_discord_adapter");
		adapters[id] = adapter;
		const memoryId = "base/xiaohongshu-memory-rules.md";
		const memoryAdapter = normalize(
			join(
				options.scriptsDir,
				"../lead-rules-base/codex-xiaohongshu-memory-rules.md",
			),
		);
		if (adapters[memoryId] && adapters[memoryId] !== memoryAdapter)
			throw new Error("conflicting_codex_memory_adapter");
		adapters[memoryId] = memoryAdapter;
	}
	function add(
		sourceId: string,
		layer: LeadRuleSourceRecord["layer"],
		path: string | null,
		required: boolean,
		reason: string,
		applicable = true,
	) {
		if (sources.some((source) => source.sourceId === sourceId))
			throw new Error("duplicate_rule_source");
		const source = applicable && path ? inspect(path) : null,
			adapterPath = adapters[sourceId] ?? null,
			adapter = applicable && adapterPath ? inspect(adapterPath) : null;
		sources.push({
			sourceId,
			layer,
			sourcePath: path,
			realSourcePath: source?.real ?? null,
			sourceSha256: source?.sha ?? null,
			adapterPath,
			adapterSha256: adapter?.sha ?? null,
			status: !applicable
				? "not_applicable"
				: source && (!adapterPath || adapter)
					? "selected"
					: "missing",
			reason,
			required,
		});
	}
	const persona =
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
	add("persona", "persona", persona, true, "canonical persona");
	if (options.inboxEnabled)
		add(
			"launcher/inbox-ack-rule.md",
			"launcher",
			join(options.scriptsDir, "inbox-ack-rule.md"),
			true,
			"enabled inbox contract",
		);
	const base = join(options.scriptsDir, "..", "lead-rules-base"),
		basePath = normalize(base);
	function rule(name: string, required = false) {
		add(
			`base/${name}`,
			"base",
			join(basePath, name),
			required,
			`${options.role} base contract`,
		);
	}
	if (options.role === "external") rule("external-agent-contract.md", true);
	else if (options.role === "companion")
		rule("companion-safety-contract.md", true);
	else if (options.role === "cos") rule("cos-lead-rules.md");
	else {
		rule("department-lead-rules.md");
		if (options.commBackend !== "commdb") rule("runner-messaging-rules.md");
		for (const name of [
			"executor-routing.md",
			"model-routing.md",
			"stuck-runner-remanage.md",
			"runner-reengage-rules.md",
			"doc-flow-rules.md",
			"default-enable-policy.md",
			"xiaohongshu-memory-rules.md",
		])
			rule(name);
	}
	if (options.hasSummaryDuty) rule("summary-inflow.md", true);
	if (options.role === "dept") rule("runner-patrol-rules.md");
	if (options.role !== "external") {
		rule("founder-local-time.md");
		if (options.role !== "companion") {
			rule("founder-only-authority.md", true);
			rule("founder-html-delivery.md");
		}
		rule("cross-dept-channel-rules.md");
		rule("discord-reply-contract.md", codexDepartment);
		const shared = join(options.projectRoot, ".lead/shared");
		if (existsSync(shared)) {
			add(
				"project/common-rules.md",
				"project",
				join(shared, "common-rules.md"),
				true,
				"project shared contract",
			);
			if (options.role === "dept")
				add(
					"project/department-lead-rules.md",
					"project",
					join(shared, "department-lead-rules.md"),
					true,
					"project department contract",
				);
		}
	}
	if (
		options.screencaptureEnabled &&
		(options.role === "dept" || options.role === "cos")
	)
		add(
			"launcher/screencapture-l3-skill.md",
			"launcher",
			join(options.scriptsDir, "screencapture-l3-skill.md"),
			false,
			"screenshot duty",
		);
	for (const path of options.extraRulePaths ?? [])
		add(
			`extra/${path}`,
			"launcher",
			path,
			true,
			"actual additional launcher source",
		);
	const available = new Map(options.skills.map((skill) => [skill.name, skill]));
	if (available.size !== options.skills.length)
		throw new Error("duplicate_skill_source");
	const applicable = options.role === "dept" || options.role === "cos";
	const requirements = applicable
		? personaSkillRequirements(inspect(persona)?.content ?? "")
		: [];
	if (applicable) requirements.push("founder-html-delivery");
	const skillNames = [...new Set([...requirements, ...available.keys()])];
	for (const name of skillNames) {
		if (
			name.length > 128 ||
			name.trim() !== name ||
			!/^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)?$/.test(name)
		)
			throw new Error("invalid_skill_source_name");
		const skill = available.get(name);
		if (skill?.adapterPath) {
			if (adapters[`skill/${name}`]) throw new Error("duplicate_skill_adapter");
		}
		add(
			`skill/${name}`,
			"skill",
			skill?.path ?? null,
			false,
			requirements.includes(name)
				? "canonical persona or delivery contract requirement"
				: "actual advertised skill",
			applicable,
		);
		if (skill?.adapterPath) {
			const record = sources.at(-1)!,
				adapter = applicable ? inspect(skill.adapterPath) : null;
			record.adapterPath = skill.adapterPath;
			record.adapterSha256 = adapter?.sha ?? null;
			if (applicable && !adapter) record.status = "missing";
		}
		if (applicable && skill?.sha256 !== undefined) {
			if (!/^[a-f0-9]{64}$/.test(skill.sha256))
				throw new Error("invalid_skill_source_pin");
			const record = sources.at(-1)!;
			if (
				record.sourceSha256 !== null &&
				record.sourceSha256 !== skill.sha256
			) {
				record.status = "missing";
				record.reason = "pinned_persona_skill_changed";
			}
		}
		if (applicable && skill?.ambiguous) {
			const record = sources.at(-1)!;
			record.status = "missing";
			record.reason = "ambiguous_persona_skill_source";
		}
	}
	for (const sourceId of Object.keys(adapters))
		if (!sources.some((source) => source.sourceId === sourceId))
			throw new Error("unmatched_rule_adapter");
	const skillGaps = sources
		.filter((source) => source.layer === "skill" && source.status === "missing")
		.map((source) => ({
			sourceId: source.sourceId,
			reason:
				source.reason === "pinned_persona_skill_changed"
					? source.reason
					: "missing_persona_skill_manual_fallback",
		}));
	return { sources, skillGaps, sourceDigest: hash(JSON.stringify(sources)) };
}

export interface LeadRuleParityFinding {
	kind: "missing" | "unavailable" | "source_changed" | "order_changed";
	sourceId: string;
	backend?: "claude-code" | "codex-app-server";
}
/** Compare evidence from both actual consumers, not a one-way expected-name subset. */
export function compareLeadRuleSources(
	claude: readonly LeadRuleSourceRecord[],
	codex: readonly LeadRuleSourceRecord[],
) {
	const findings: LeadRuleParityFinding[] = [];
	const maps = [
		new Map(claude.map((source) => [source.sourceId, source])),
		new Map(codex.map((source) => [source.sourceId, source])),
	] as const;
	if (maps[0].size !== claude.length || maps[1].size !== codex.length)
		throw new Error("duplicate_rule_source");
	for (const [index, records] of [claude, codex].entries()) {
		const backend = index === 0 ? "claude-code" : "codex-app-server";
		for (const source of records) {
			if (source.status === "missing")
				findings.push({
					kind: "unavailable",
					sourceId: source.sourceId,
					backend,
				});
			if (!maps[1 - index]!.has(source.sourceId))
				findings.push({
					kind: "missing",
					sourceId: source.sourceId,
					backend: index === 0 ? "codex-app-server" : "claude-code",
				});
		}
	}
	for (const source of claude) {
		const other = maps[1].get(source.sourceId);
		if (
			other &&
			(source.sourceSha256 !== other.sourceSha256 ||
				source.status !== other.status)
		)
			findings.push({ kind: "source_changed", sourceId: source.sourceId });
	}
	const commonClaude = claude
		.filter((source) => maps[1].has(source.sourceId))
		.map((source) => source.sourceId);
	const commonCodex = codex
		.filter((source) => maps[0].has(source.sourceId))
		.map((source) => source.sourceId);
	if (JSON.stringify(commonClaude) !== JSON.stringify(commonCodex))
		findings.push({ kind: "order_changed", sourceId: "*" });
	return { equivalent: findings.length === 0, findings };
}

/** The consumer supplies its complete ordered receipt, including unrecognized sources.
 * Staged paths are read directly; this never substitutes the selector's expected files.
 */
export function recordActualLeadRuleSources(
	actual: readonly {
		sourceId: string;
		layer: LeadRuleSourceRecord["layer"];
		sourcePath: string;
		adapterPath?: string;
	}[],
): LeadRuleSourceRecord[] {
	const ids = new Set<string>();
	return actual.map((record) => {
		if (!record.sourceId || ids.has(record.sourceId))
			throw new Error("duplicate_rule_source");
		ids.add(record.sourceId);
		const source = inspect(record.sourcePath),
			adapter = record.adapterPath ? inspect(record.adapterPath) : null;
		return {
			sourceId: record.sourceId,
			layer: record.layer,
			sourcePath: record.sourcePath,
			realSourcePath: source?.real ?? null,
			sourceSha256: source?.sha ?? null,
			adapterPath: record.adapterPath ?? null,
			adapterSha256: adapter?.sha ?? null,
			status:
				source && (!record.adapterPath || adapter) ? "selected" : "missing",
			reason: "actual consumer receipt",
			required: true,
		};
	});
}
