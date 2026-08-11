#!/usr/bin/env node
/**
 * Verify every compiled workflow-menu seed passes manifest validation.
 *
 * A malformed menu seed prevents the Bridge from starting, so any change to
 * node capabilities or manifest validation must be checked against the real
 * compiled menu definitions rather than only test fixtures.
 *
 * Usage: node scripts/verify-workflow-seeds.mjs
 * Exit code 0 = every seed validated; 1 = at least one seed failed.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const teamleadDist = join(repoRoot, "packages/teamlead/dist");
const { validateWorkflowManifest } = require(
	join(teamleadDist, "workflow-template.js"),
);
const { loadWorkflowMenuSeeds } = require(
	join(teamleadDist, "workflow-menu.js"),
);
const {
	buildWorkflowRunSnapshotV1,
	buildWorkflowRunSnapshotV2,
	resolveWorkflowGateAuthority,
} = require(join(teamleadDist, "workflow-run-snapshot.js"));
const seeds = loadWorkflowMenuSeeds();
console.log(`Validating ${seeds.length} compiled workflow-menu seeds\n`);

let failed = 0;
for (const seed of seeds) {
	try {
		const manifest = validateWorkflowManifest(seed.manifest);
		const types = (manifest.nodes ?? []).map((node) => node.type).join(" → ");
		console.log(`✅ ${seed.templateId}  PASS  ${types}`);
	} catch (err) {
		failed += 1;
		console.log(
			`❌ ${seed.templateId}  FAIL\n     ↳ ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

console.log("\nGate authority — compiled menu snapshots:");
for (const seed of seeds) {
	try {
		const template = { id: seed.templateId, revision: 1 };
		const snapshot =
			seed.manifest.schema_version === 1
				? buildWorkflowRunSnapshotV1({ template, manifest: seed.manifest })
				: buildWorkflowRunSnapshotV2({
						template,
						manifest: seed.manifest,
						canonicalRoot: repoRoot,
					});
		const authority = resolveWorkflowGateAuthority(snapshot);
		console.log(`✅ ${seed.templateId}: ${authority.mode}`);
	} catch (err) {
		failed += 1;
		console.log(
			`❌ ${seed.templateId}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

console.log(
	`\n${failed === 0 ? "ALL SEEDS PASS" : `${failed} FAILURE(S)`} — ${seeds.length} compiled menu seeds`,
);
process.exit(failed === 0 ? 0 : 1);
