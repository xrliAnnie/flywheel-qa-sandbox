import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import {
	personaSkillRequirements,
	prepareLeadManifestSources,
	selectLeadRuleSources,
} from "../rule-sources.js";

it("expands the ruled collection and research aliases to real skills", () => {
	expect(
		personaSkillRequirements(
			"# Skill map\n`minimalist-entrepreneur`, `research`, `deep-research`\n# Other\n`ignored`",
		),
	).toEqual([
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
		"deep-research",
		"synthesize-research",
	]);
});

it("keeps changed pinned persona content visible without admitting it or blocking startup", () => {
	const { file } = fixture();
	const path = file("changed/SKILL.md", "changed content");
	const result = selectLeadRuleSources({
		scriptsDir,
		projectRoot,
		leadId: "flywheel-product-lead",
		role: "dept",
		commBackend: "commdb",
		hasSummaryDuty: false,
		inboxEnabled: false,
		screencaptureEnabled: false,
		skills: [{ name: "deep-research", path, sha256: "0".repeat(64) }],
	});
	expect(
		result.sources.find((source) => source.sourceId === "skill/deep-research"),
	).toMatchObject({
		status: "missing",
		required: false,
		reason: "pinned_persona_skill_changed",
	});
	expect(result.skillGaps).toContainEqual({
		sourceId: "skill/deep-research",
		reason: "pinned_persona_skill_changed",
	});
});

const scriptsDir = resolve("scripts"),
	projectRoot = resolve("../..");
it("verifies consumed source bytes, keeps persona drift as a gap, and rejects rule drift", () => {
	const { file } = fixture();
	const rule = file("rule.md", "governance");
	const skill = file("skill/SKILL.md", "skill text");
	const records = recordActualLeadRuleSources([
		{ sourceId: "persona", layer: "persona", sourcePath: rule },
		{ sourceId: "skill/research", layer: "skill", sourcePath: skill },
	]);
	expect(prepareLeadManifestSources(records, []).skillSources).toHaveLength(1);
	writeFileSync(skill, "changed");
	const changed = prepareLeadManifestSources(records, []);
	expect(changed.skillSources).toEqual([]);
	expect(changed.skillGaps).toEqual([
		{ sourceId: "skill/research", reason: "pinned_persona_skill_changed" },
	]);
	writeFileSync(rule, "changed rule");
	expect(() => prepareLeadManifestSources(records, [])).toThrow(
		"capability_rules_unverified",
	);
});
it("selects the current department source order including missing Codex policy contracts", () => {
	const result = selectLeadRuleSources({
		scriptsDir,
		projectRoot,
		leadId: "flywheel-product-lead",
		role: "dept",
		commBackend: "mailbox",
		hasSummaryDuty: true,
		inboxEnabled: true,
		screencaptureEnabled: true,
		skills: [],
	});
	const base = result.sources
		.filter((source) => source.layer === "base")
		.map((source) => source.sourceId);
	expect(base).toEqual([
		"base/department-lead-rules.md",
		"base/runner-messaging-rules.md",
		"base/executor-routing.md",
		"base/model-routing.md",
		"base/stuck-runner-remanage.md",
		"base/runner-reengage-rules.md",
		"base/doc-flow-rules.md",
		"base/default-enable-policy.md",
		"base/xiaohongshu-memory-rules.md",
		"base/summary-inflow.md",
		"base/runner-patrol-rules.md",
		"base/founder-local-time.md",
		"base/founder-only-authority.md",
		"base/founder-html-delivery.md",
		"base/cross-dept-channel-rules.md",
		"base/discord-reply-contract.md",
	]);
	const persona = result.sources.find((source) => source.layer === "persona")!;
	expect(persona.sourceSha256).toBe(
		createHash("sha256")
			.update(readFileSync(persona.sourcePath!))
			.digest("hex"),
	);
	expect(result.sources.map((source) => source.sourceId)).toContain(
		"skill/problem-definition",
	);
	expect(
		result.sources.find(
			(source) => source.sourceId === "skill/problem-definition",
		)?.status,
	).toBe("missing");
});

import { compareLeadRuleSources } from "../rule-sources.js";

it("compares complete actual assembled sources in both directions and preserves order", () => {
	const actual = selectLeadRuleSources({
		scriptsDir,
		projectRoot,
		leadId: "flywheel-product-lead",
		role: "dept",
		commBackend: "mailbox",
		hasSummaryDuty: true,
		inboxEnabled: true,
		screencaptureEnabled: true,
		skills: [],
	}).sources.filter((source) => source.status === "selected");
	expect(compareLeadRuleSources(actual, actual).equivalent).toBe(true);
	expect(
		compareLeadRuleSources(actual, actual.slice(1)).findings,
	).toContainEqual({
		kind: "missing",
		sourceId: "persona",
		backend: "codex-app-server",
	});
	expect(
		compareLeadRuleSources(actual, [
			...actual,
			{ ...actual[0]!, sourceId: "new-Claude-source" },
		]).equivalent,
	).toBe(false);
	expect(
		compareLeadRuleSources(actual, [
			actual[1]!,
			actual[0]!,
			...actual.slice(2),
		]).findings.some((finding) => finding.kind === "order_changed"),
	).toBe(true);
	expect(
		compareLeadRuleSources(
			actual,
			actual.map((source, i) =>
				i ? source : { ...source, sourceSha256: "0".repeat(64) },
			),
		).equivalent,
	).toBe(false);
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

const temps: string[] = [];
afterEach(() => {
	for (const path of temps.splice(0))
		rmSync(path, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "lead-rules-"));
	temps.push(root);
	const file = (name: string, content: string) => {
		const path = join(root, name);
		mkdirSync(resolve(path, ".."), { recursive: true });
		writeFileSync(path, content);
		return path;
	};
	return { root, file };
}
it("records all thirteen canonical PM skills plus every advertised skill without filename exclusions", () => {
	const { file } = fixture();
	const names = [
		"problem-definition",
		"product-brainstorming",
		"defining-product-vision",
		"working-backwards",
		"writing-prds",
		"scoping-cutting",
		"prioritizing-roadmap",
		"writing-north-star-metrics",
		"product-taste-intuition",
		"analyzing-user-feedback",
		"synthesize-research",
		"competitive-analysis",
		"dogfooding",
	];
	const skills = [...names, "founder-html-delivery", "browser-research"].map(
		(name) => ({ name, path: file(`${name}/SKILL.md`, `# ${name}`) }),
	);
	const result = selectLeadRuleSources({
		scriptsDir,
		projectRoot,
		leadId: "flywheel-product-lead",
		role: "dept",
		commBackend: "commdb",
		hasSummaryDuty: false,
		inboxEnabled: false,
		screencaptureEnabled: false,
		skills,
	});
	for (const name of names)
		expect(
			result.sources.find((source) => source.sourceId === `skill/${name}`),
		).toMatchObject({
			status: "selected",
			required: false,
			sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
	expect(
		result.sources.find(
			(source) => source.sourceId === "skill/browser-research",
		),
	).toMatchObject({ status: "selected", required: false });
	expect(
		result.sources.find((source) => source.sourceId === "skill/company-values"),
	).toMatchObject({ status: "missing", required: false });
	expect(result.skillGaps).toContainEqual({
		sourceId: "skill/company-values",
		reason: "missing_persona_skill_manual_fallback",
	});
	expect(
		compareLeadRuleSources(result.sources, result.sources).equivalent,
	).toBe(false);
	expect(
		result.sources.some(
			(source) => source.sourceId === "base/runner-messaging-rules.md",
		),
	).toBe(false);
});
it("preserves project shared order, extra source order and original versus adapter SHA evidence", () => {
	const { root, file } = fixture();
	file(".lead/demo/identity.md", "# Demo");
	file(".lead/shared/common-rules.md", "common");
	file(".lead/shared/department-lead-rules.md", "department");
	const skill = file("skill/SKILL.md", "vendor text"),
		adapter = file("adapter.md", "backend neutral"),
		a = file("a.md", "A"),
		b = file("b.md", "B");
	const options = {
		scriptsDir,
		projectRoot: root,
		leadId: "demo",
		role: "dept" as const,
		commBackend: "mailbox" as const,
		hasSummaryDuty: false,
		inboxEnabled: false,
		screencaptureEnabled: false,
		skills: [{ name: "custom-skill", path: skill, adapterPath: adapter }],
		extraRulePaths: [a, b],
	};
	const result = selectLeadRuleSources(options);
	expect(
		result.sources
			.filter((source) => source.layer === "project")
			.map((source) => source.sourceId),
	).toEqual(["project/common-rules.md", "project/department-lead-rules.md"]);
	expect(
		result.sources.find((source) => source.sourceId === "skill/custom-skill"),
	).toMatchObject({
		sourceSha256: createHash("sha256").update("vendor text").digest("hex"),
		adapterSha256: createHash("sha256").update("backend neutral").digest("hex"),
	});
	expect(
		selectLeadRuleSources({ ...options, extraRulePaths: [b, a] }).sourceDigest,
	).not.toBe(result.sourceDigest);
	writeFileSync(adapter, "changed adapter");
	expect(selectLeadRuleSources(options).sourceDigest).not.toBe(
		result.sourceDigest,
	);
});
it("does not read advertised skills or their adapters for excluded companion and external roles", () => {
	const { root, file } = fixture();
	file(".lead/demo/identity.md", "# Demo");
	const invalid = file("not-markdown.json", "not a rule");
	for (const role of ["companion", "external"] as const) {
		const result = selectLeadRuleSources({
			scriptsDir,
			projectRoot: root,
			leadId: "demo",
			role,
			commBackend: "mailbox",
			hasSummaryDuty: false,
			inboxEnabled: false,
			screencaptureEnabled: true,
			skills: [{ name: "custom-skill", path: invalid, adapterPath: invalid }],
		});
		expect(
			result.sources.find((source) => source.sourceId === "skill/custom-skill"),
		).toMatchObject({
			status: "not_applicable",
			sourceSha256: null,
			adapterSha256: null,
		});
		expect(
			result.sources.some(
				(source) => source.sourceId === "base/founder-only-authority.md",
			),
		).toBe(false);
		expect(
			result.sources.some(
				(source) => source.sourceId === "launcher/screencapture-l3-skill.md",
			),
		).toBe(false);
	}
});

it("fails closed on invalid file evidence and records missing required project or adapter sources", () => {
	const { root, file } = fixture();
	file(".lead/demo/identity.md", "# Demo");
	file(".lead/shared/common-rules.md", "common");
	const options = {
		scriptsDir,
		projectRoot: root,
		leadId: "demo",
		role: "dept" as const,
		commBackend: "mailbox" as const,
		hasSummaryDuty: false,
		inboxEnabled: false,
		screencaptureEnabled: false,
		skills: [],
	};
	const result = selectLeadRuleSources({
		...options,
		adapters: { persona: join(root, "missing.md") },
	});
	expect(
		result.sources.find(
			(source) => source.sourceId === "project/department-lead-rules.md",
		),
	).toMatchObject({ status: "missing", required: true });
	expect(
		result.sources.find((source) => source.sourceId === "persona"),
	).toMatchObject({ status: "missing", adapterSha256: null });
	expect(() =>
		selectLeadRuleSources({ ...options, personaPath: "relative.md" }),
	).toThrow("invalid_rule_source_path");
	expect(() =>
		selectLeadRuleSources({
			...options,
			personaPath: join(root, "bad\nname.md"),
		}),
	).toThrow("invalid_rule_source_path");
	expect(() =>
		selectLeadRuleSources({
			...options,
			personaPath: file("large.md", "x".repeat(1024 * 1024 + 1)),
		}),
	).toThrow("invalid_rule_source_file");
	expect(() =>
		selectLeadRuleSources({
			...options,
			adapters: { "unknown/source": join(root, "missing.md") },
		}),
	).toThrow("unmatched_rule_adapter");
});

import { recordActualLeadRuleSources } from "../rule-sources.js";

it("hashes complete actual consumer paths independently and exposes extra actual Claude sources", () => {
	const { file } = fixture();
	const common = file("common.md", "business contract"),
		extra = file("new-contract.md", "new actual Claude source");
	const claude = recordActualLeadRuleSources([
		{ sourceId: "shared", layer: "project", sourcePath: common },
		{ sourceId: "new-contract", layer: "base", sourcePath: extra },
	]);
	const codex = recordActualLeadRuleSources([
		{ sourceId: "shared", layer: "project", sourcePath: common },
	]);
	expect(compareLeadRuleSources(claude, codex).findings).toEqual([
		{ kind: "missing", sourceId: "new-contract", backend: "codex-app-server" },
	]);
	writeFileSync(common, "changed business contract");
	expect(
		compareLeadRuleSources(
			codex,
			recordActualLeadRuleSources([
				{ sourceId: "shared", layer: "project", sourcePath: common },
			]),
		).findings,
	).toEqual([{ kind: "source_changed", sourceId: "shared" }]);
});

it("retains namespaced advertised skills from real files while rejecting unsafe names and duplicates", () => {
	const { root, file } = fixture();
	file(".lead/demo/identity.md", "# Demo");
	const names = ["deep-research-work:deep-research", "matt-skills:code-review"];
	const skills = names.map((name, index) => ({
		name,
		path: file(
			`installed-${index}/SKILL.md`,
			`# ${name}\nActual installed instructions`,
		),
	}));
	const options = {
		scriptsDir,
		projectRoot: root,
		leadId: "demo",
		role: "dept" as const,
		commBackend: "mailbox" as const,
		hasSummaryDuty: false,
		inboxEnabled: false,
		screencaptureEnabled: false,
		skills,
	};
	const result = selectLeadRuleSources(options);
	for (const skill of skills)
		expect(
			result.sources.find(
				(source) => source.sourceId === `skill/${skill.name}`,
			),
		).toMatchObject({
			status: "selected",
			sourcePath: skill.path,
			sourceSha256: createHash("sha256")
				.update(readFileSync(skill.path))
				.digest("hex"),
		});
	for (const name of [
		"../escape",
		"namespace:../escape",
		"namespace/skill",
		"namespace\\skill",
		"namespace:\u0000skill",
		"namespace:\nskill",
		":skill",
		"namespace:",
		"namespace::skill",
		"namespace:skill\n",
		"a".repeat(129),
	]) {
		expect(() =>
			selectLeadRuleSources({ ...options, skills: [{ ...skills[0]!, name }] }),
		).toThrow("invalid_skill_source_name");
	}
	expect(() =>
		selectLeadRuleSources({ ...options, skills: [skills[0]!, skills[0]!] }),
	).toThrow("duplicate_skill_source");
});

it("binds the Codex department Discord adapter to its canonical source", () => {
	const options = {
		scriptsDir,
		projectRoot,
		leadId: "flywheel-product-lead",
		role: "dept" as const,
		commBackend: "mailbox" as const,
		hasSummaryDuty: false,
		inboxEnabled: false,
		screencaptureEnabled: false,
		skills: [],
	};
	const canonical = selectLeadRuleSources(options).sources.find(
		(source) => source.sourceId === "base/discord-reply-contract.md",
	)!;
	const codex = selectLeadRuleSources({
		...options,
		backend: "codex-app-server",
	}).sources.find((source) => source.sourceId === canonical.sourceId)!;
	const adapterPath = resolve(
		scriptsDir,
		"../lead-rules-base/codex-discord-reply-contract.md",
	);
	expect(codex).toMatchObject({
		sourcePath: canonical.sourcePath,
		sourceSha256: canonical.sourceSha256,
		adapterPath,
		adapterSha256: createHash("sha256")
			.update(readFileSync(adapterPath))
			.digest("hex"),
		required: true,
		status: "selected",
	});
	expect(canonical.adapterPath).toBeNull();
});

it("keeps a missing Codex Discord adapter unavailable and rejects substitution", () => {
	const { root, file } = fixture();
	file("lead-rules-base/discord-reply-contract.md", "Canonical Discord rules");
	const options = {
		scriptsDir: join(root, "scripts"),
		projectRoot: root,
		leadId: "demo",
		role: "dept" as const,
		backend: "codex-app-server" as const,
		commBackend: "mailbox" as const,
		hasSummaryDuty: false,
		inboxEnabled: false,
		screencaptureEnabled: false,
		skills: [],
	};
	expect(
		selectLeadRuleSources(options).sources.find(
			(source) => source.sourceId === "base/discord-reply-contract.md",
		),
	).toMatchObject({ status: "missing", required: true, adapterSha256: null });
	expect(() =>
		selectLeadRuleSources({
			...options,
			adapters: {
				"base/discord-reply-contract.md": file(
					"replacement.md",
					"Different rules",
				),
			},
		}),
	).toThrow("conflicting_codex_discord_adapter");
});
