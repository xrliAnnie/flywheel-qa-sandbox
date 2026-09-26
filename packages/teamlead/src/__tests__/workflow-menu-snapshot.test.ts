import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getModelConfigSnapshot,
	type ModelConfigSnapshot,
} from "flywheel-config";
import { afterEach, describe, expect, it } from "vitest";
import {
	compileWorkflowMenuSeed,
	loadWorkflowMenuLibrary,
	loadWorkflowMenuSeeds,
} from "../workflow-menu.js";
import { parseWorkflowRunSnapshot } from "../workflow-run-snapshot.js";
import { createWorkflowPrefixFixture } from "./fixtures/workflow-prefix.js";

// An operation's captured generation may reject models accepted by ambient
// configuration. Every layer must honor that rejection, including YAML parsing.
function rejectingSnapshot(): ModelConfigSnapshot {
	return {
		...getModelConfigSnapshot(),
		getModelRegistryEntry() {
			throw new Error("captured generation rejects model");
		},
	};
}

describe("workflow seed publication model generation", () => {
	it("uses the captured generation while loading registry policies", () => {
		expect(() =>
			loadWorkflowMenuLibrary({ modelSnapshot: rejectingSnapshot() }),
		).toThrow("captured generation rejects model");
	});

	it("uses the captured generation while resolving compiled model aliases", () => {
		const menu = loadWorkflowMenuLibrary().find(
			(entry) => entry.shape === "simple_code",
		)!;
		expect(() => compileWorkflowMenuSeed(menu, rejectingSnapshot())).toThrow(
			"captured generation rejects model",
		);
	});

	it("propagates a publication generation from the seed entrypoint", () => {
		expect(() => loadWorkflowMenuSeeds(rejectingSnapshot())).toThrow(
			"captured generation rejects model",
		);
	});
});

describe("pinned manifest prefix profiles (FLY-2913 C1)", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true });
	});
	function fixture(
		version: 1 | 2 | 3,
		profiles?: Parameters<typeof createWorkflowPrefixFixture>[3],
	) {
		const root = mkdtempSync(join(tmpdir(), "fly2913-profile-snapshot-"));
		roots.push(root);
		return createWorkflowPrefixFixture(root, version, "tpl_code", profiles);
	}

	it.each([1, 2, 3] as const)(
		"schema %s seals profiles in the manifest only",
		(version) => {
			const profiles = {
				prefix_profile: "role-v1",
				review_prefix_profile: "legacy",
			} as const;
			const { snapshot, nodeId } = fixture(version, profiles);
			const parsed = parseWorkflowRunSnapshot(JSON.stringify(snapshot));
			expect(parsed).toEqual(snapshot);
			expect(
				parsed.manifest.nodes.find((node) => node.id === nodeId),
			).toMatchObject(profiles);
			for (const node of parsed.resolved.nodes) {
				expect(node).not.toHaveProperty("prefix_profile");
				expect(node).not.toHaveProperty("review_prefix_profile");
			}
			const altered = structuredClone(snapshot);
			Object.assign(
				altered.manifest.nodes.find((node) => node.id === nodeId)!,
				{ prefix_profile: "legacy" },
			);
			expect(() => parseWorkflowRunSnapshot(JSON.stringify(altered))).toThrow(
				/manifest digest mismatch/,
			);
		},
	);

	// Captured before C1. Omitted profile declarations must not insert default
	// bytes into either the manifest or the immutable run snapshot.
	it.each([
		[
			1,
			"e3dd3dccdbed3f565af4b4d27b8e879f49317d22c8c5f3b770834e56a1bc039e",
			"f4bdbb831a05853696cc7887c49ed8063551497f9f4c76ab375811ddddee3742",
		],
		[
			2,
			"2ed7ba4f7f0152b0e4a06a1a8dcb12d27172dcc962bdf129b44108bf00caec69",
			"ff813e5124a159e3d589126737c14cc02d5e29d1888f90dbe27b7f93921cc732",
		],
		[
			3,
			"9ba0184e7d02b52262144c5a671b7180b512fe172d19434a914cae78395b1ac7",
			"9eafe39c3b5aee37c352850f0828886c4c44cc16fc696ed99d278f88d4a37a78",
		],
	] as const)(
		"schema %s historical digests remain unchanged without declarations",
		(version, manifestDigest, snapshotDigest) => {
			const { snapshot } = fixture(version);
			expect(snapshot.manifest_digest).toBe(manifestDigest);
			expect(snapshot.snapshot_digest).toBe(snapshotDigest);
			const serialized = JSON.stringify(snapshot);
			expect(serialized).not.toContain("prefix_profile");
			expect(parseWorkflowRunSnapshot(serialized)).toEqual(snapshot);
		},
	);
});
