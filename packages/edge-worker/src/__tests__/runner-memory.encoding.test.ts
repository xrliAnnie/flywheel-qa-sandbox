import fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SAFE_IDENTIFIER_RE } from "flywheel-core";
import { describe, expect, it } from "vitest";
import {
	decodeMemoryPathComponent,
	encodeMemoryPathComponent,
	RUNNER_MEMORY_ID_MAX_LENGTH,
} from "../runner-memory.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const PRODUCTION_LEAD_IDS = [
	"belle-lead",
	"claude-infra-bot-lead",
	"codex-infra-bot-lead",
	"cos-lead",
	"flywheel-cos-lead",
	"flywheel-eng-lead",
	"flywheel-product-lead",
	"joycon-lead",
	"mufasa-lead",
	"ops-lead",
	"product-lead",
	"rafiki-lead",
	"reflection-lead",
	"sub-lead",
	"tidal-echo-content-lead",
	"tidal-echo-cos-lead",
] as const;

function registryNodeIds(): string[] {
	const registry = fs.readFileSync(
		join(REPO_ROOT, ".flywheel", "agents", "registry.yaml"),
		"utf8",
	);
	const nodes = registry.match(/^nodes:\n([\s\S]*?)^structural:/m)?.[1] ?? "";
	return Array.from(nodes.matchAll(/^ {2}([A-Za-z0-9._-]+):$/gm), (match) =>
		String(match[1]),
	);
}

function repositoryLeadIds(): string[] {
	return fs
		.readdirSync(join(REPO_ROOT, ".lead"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);
}

function caseVariants(input: string): string[] {
	let variants = [""];
	for (const character of input) {
		if (/[a-z]/i.test(character)) {
			variants = variants.flatMap((prefix) => [
				`${prefix}${character.toLowerCase()}`,
				`${prefix}${character.toUpperCase()}`,
			]);
		} else {
			variants = variants.map((prefix) => `${prefix}${character}`);
		}
	}
	return variants;
}

function randomGrammarSamples(count: number): string[] {
	const first =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	const rest = `${first}._-`;
	let state = 0x2147f00d;
	const next = (): number => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state;
	};
	return Array.from({ length: count }, () => {
		const length = 1 + (next() % RUNNER_MEMORY_ID_MAX_LENGTH);
		let value = first[next() % first.length] as string;
		for (let index = 1; index < length; index += 1) {
			value += rest[next() % rest.length];
		}
		return value;
	});
}

describe("FLY-2147 case-insensitive path encoding proof", () => {
	it("is injective and reversible across real, adversarial, exhaustive, and seeded samples", () => {
		const realIds = [
			...registryNodeIds(),
			...repositoryLeadIds(),
			...PRODUCTION_LEAD_IDS,
		];
		const invalidRealIds = realIds.filter(
			(value) =>
				!SAFE_IDENTIFIER_RE.test(value) ||
				value.length > RUNNER_MEMORY_ID_MAX_LENGTH,
		);
		expect(invalidRealIds, "real role identifiers must stay mountable").toEqual(
			[],
		);

		const adversarial = [
			"sub",
			"Sub",
			"SUB",
			"sUb",
			"sub-21c1eb89",
			"sub--1",
			"sub--1--0",
			"qa",
			"QA",
			"qa--3",
			"GeoForge3D",
			"geoforge3d--209",
			"A",
			"a",
			"A".repeat(128),
			`${"Ab".repeat(64)}`,
			"a".repeat(128),
			"a..b",
		];
		const samples = new Set([
			...realIds,
			...adversarial,
			...caseVariants("sub"),
			...caseVariants("geoforge3d"),
			...caseVariants("ab-cd.e"),
			...randomGrammarSamples(5_000),
		]);

		const owners = new Map<string, string>();
		const collisions: Array<{
			encoded: string;
			first: string;
			second: string;
		}> = [];
		for (const sample of samples) {
			const encoded = encodeMemoryPathComponent(sample);
			const previous = owners.get(encoded);
			if (previous !== undefined && previous !== sample) {
				collisions.push({ encoded, first: previous, second: sample });
			}
			owners.set(encoded, sample);
			expect(
				Buffer.compare(
					Buffer.from(decodeMemoryPathComponent(encoded)),
					Buffer.from(sample),
				),
			).toBe(0);
			expect(SAFE_IDENTIFIER_RE.test(encoded)).toBe(true);
			expect(encoded.length).toBeLessThanOrEqual(162);
			expect(encoded.includes("--")).toBe(
				/[A-Z]/.test(sample) || sample.includes("--"),
			);
			expect(encoded.toLowerCase()).toBe(encoded);
		}
		expect(collisions).toEqual([]);
	});
});
