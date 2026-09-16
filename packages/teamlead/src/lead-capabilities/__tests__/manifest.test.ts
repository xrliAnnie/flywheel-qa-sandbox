import { describe, expect, it } from "vitest";
import { validateLeadCapabilityManifest } from "../../lead-backends/codex/lead-capability-proxy.js";
import { getLeadCapability } from "../catalog.js";
import { createLeadCapabilityManifest } from "../manifest.js";
import { NATIVE_CODEX_SKILL_NAMES } from "../native-skills.js";

const base = {
	projectName: "flywheel",
	leadId: "flywheel-product-lead",
	identityDigest: "a".repeat(64),
	backend: "codex-app-server" as const,
	profile: "full-access" as const,
	activationId: "activation",
	sourceRevision: "b".repeat(40),
	operations: [
		getLeadCapability("discord.thread.read")!,
		getLeadCapability("bridge.ship")!,
	],
	ruleSources: [{ path: "rules/base.md", sha256: "c".repeat(64) }],
	skillSources: [],
	integrations: [],
};
describe("capability manifest", () => {
	it("hashes non-admitted configured skill inventory without advertising those skills", () => {
		const skillInventory = [
			{
				name: "superpowers:brainstorming",
				source: "/fixture/SKILL.md",
				sha256: "1".repeat(64),
				enabled: true,
				reason: "not_in_persona_map" as const,
			},
		];
		const manifest = createLeadCapabilityManifest({ ...base, skillInventory });
		expect(validateLeadCapabilityManifest(manifest).skillInventory).toEqual(
			skillInventory,
		);
		expect(manifest.skillSources).toEqual([]);
		expect(() =>
			validateLeadCapabilityManifest({
				...manifest,
				skillInventory: [{ ...skillInventory[0], enabled: false }],
			}),
		).toThrow();
	});
	it("preserves bounded persona skill gaps in the hashed public startup receipt", () => {
		const skillGaps = [
			{
				sourceId: "skill/research",
				reason: "missing_persona_skill_manual_fallback" as const,
			},
		];
		const manifest = createLeadCapabilityManifest({ ...base, skillGaps });
		expect(validateLeadCapabilityManifest(manifest).skillGaps).toEqual(
			skillGaps,
		);
		expect(manifest.manifestDigest).not.toBe(
			createLeadCapabilityManifest(base).manifestDigest,
		);
		expect(() =>
			validateLeadCapabilityManifest({ ...manifest, skillGaps: [] }),
		).toThrow();
		expect(() =>
			createLeadCapabilityManifest({
				...base,
				skillGaps: [...skillGaps, ...skillGaps],
			}),
		).toThrow();
	});
	it("binds the research gap in both inventory and startup receipt", () => {
		const reason = "authenticated_research_not_available" as const;
		const skillInventory = [
			{
				name: "deep-research",
				source: "/fixture/SKILL.md",
				sha256: "1".repeat(64),
				enabled: null,
				reason: "in_persona_map" as const,
				gapReason: reason,
			},
		];
		const manifest = createLeadCapabilityManifest({
			...base,
			skillInventory,
			skillGaps: [{ sourceId: "skill/deep-research", reason }],
		});
		expect(validateLeadCapabilityManifest(manifest).skillInventory).toEqual(
			skillInventory,
		);
		expect(() =>
			validateLeadCapabilityManifest({
				...manifest,
				skillInventory: [
					{ ...skillInventory[0], gapReason: "research_provider_not_admitted" },
				],
			}),
		).toThrow();
	});
	it("projects only explicit operations and excludes unexpected/secret fields", () => {
		const m = createLeadCapabilityManifest({
			...base,
			token: "SECRET",
		} as typeof base);
		expect(m.schemaVersion).toBe(1);
		expect(m.bundleVersion).toBe(2);
		expect(m.operationIds).toEqual(["discord.thread.read"]);
		expect(m.deniedOperationIds).toEqual(["bridge.ship"]);
		expect(JSON.stringify(m)).not.toContain("SECRET");
		expect(
			createLeadCapabilityManifest({ ...base, operations: [] }).operationIds,
		).toEqual([]);
	});
	it("hashes canonical configuration deterministically, with identity and source sensitivity", () => {
		expect(
			createLeadCapabilityManifest({
				...base,
				operations: [...base.operations].reverse(),
			}).manifestDigest,
		).toBe(createLeadCapabilityManifest(base).manifestDigest);
		expect(
			createLeadCapabilityManifest({ ...base, activationId: "other" })
				.manifestDigest,
		).not.toBe(createLeadCapabilityManifest(base).manifestDigest);
		expect(
			createLeadCapabilityManifest({
				...base,
				ruleSources: [{ path: "rules/base.md", sha256: "d".repeat(64) }],
			}).manifestDigest,
		).not.toBe(createLeadCapabilityManifest(base).manifestDigest);
	});
	it("rejects forged operations, duplicate sources, and invalid source digests", () => {
		expect(() =>
			createLeadCapabilityManifest({
				...base,
				operations: [
					{ ...getLeadCapability("bridge.ship")!, classification: "write" },
				],
			}),
		).toThrow();
		expect(() =>
			createLeadCapabilityManifest({
				...base,
				ruleSources: [...base.ruleSources, ...base.ruleSources],
			}),
		).toThrow();
		expect(() =>
			createLeadCapabilityManifest({
				...base,
				ruleSources: [{ path: "rules/base.md", sha256: "secret" }],
			}),
		).toThrow();
	});
});

it("preserves semantically ordered rule sources", () => {
	const sources = [
		{ path: "z.md", sha256: "a".repeat(64) },
		{ path: "a.md", sha256: "b".repeat(64) },
	];
	const m = createLeadCapabilityManifest({ ...base, ruleSources: sources });
	expect(m.ruleSources).toEqual(sources);
	expect(
		createLeadCapabilityManifest({
			...base,
			ruleSources: [...sources].reverse(),
		}).manifestDigest,
	).not.toBe(m.manifestDigest);
});

it("binds the live browser generation into public manifest evidence", () => {
	const generation = "aaaa0000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	const m = createLeadCapabilityManifest({
		...base,
		browserGeneration: generation,
	});
	expect(m.browserGeneration).toBe(generation);
	expect(m.manifestDigest).not.toBe(
		createLeadCapabilityManifest(base).manifestDigest,
	);
});

it("binds the explicit native baseline version and content into the manifest digest", () => {
	const nativeSkillBaseline = {
		codexVersion: "fixture-v1",
		sources: NATIVE_CODEX_SKILL_NAMES.map((name) => ({
			name,
			sha256: "a".repeat(64),
		})),
	};
	const manifest = createLeadCapabilityManifest({
		...base,
		nativeSkillBaseline,
	});
	expect(validateLeadCapabilityManifest(manifest).nativeSkillBaseline).toEqual(
		nativeSkillBaseline,
	);
	expect(() =>
		validateLeadCapabilityManifest({
			...manifest,
			nativeSkillBaseline: {
				...nativeSkillBaseline,
				codexVersion: "fixture-v2",
			},
		}),
	).toThrow("invalid_capability_manifest");
});
