#!/usr/bin/env node
/**
 * Verify every bundled workflow seed passes manifest validation.
 *
 * Why this exists: `loadBundledWorkflowSeeds()` validates all seeds at Bridge
 * boot with no try/catch around it (StateStore.importWorkflowTemplateSeed →
 * validateWorkflowManifest). A single failing seed means the Bridge cannot
 * start at all, so any change to node capabilities or manifest validation must
 * be checked against the real shipped seed files, not just against fixtures.
 *
 * Usage: node scripts/verify-workflow-seeds.mjs
 * Exit code 0 = every seed validated; 1 = at least one seed failed.
 */
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { readdirSync, readFileSync } = require("node:fs");
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const teamleadDist = join(repoRoot, "packages/teamlead/dist");
const { validateWorkflowManifest, loadBundledWorkflowSeeds } = require(
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
const { parse } = require(
	join(repoRoot, "packages/teamlead/node_modules/yaml"),
);

const seedDir = join(repoRoot, "packages/teamlead/src/workflow-seeds");
const files = readdirSync(seedDir)
	.filter((f) => f.endsWith(".yaml"))
	.sort();

console.log(`Validating ${files.length} bundled workflow seeds\n`);

let failed = 0;
const rows = [];
for (const file of files) {
	const doc = parse(readFileSync(join(seedDir, file), "utf8"));
	let status = "PASS";
	let detail = "";
	let types = "";
	try {
		const manifest = validateWorkflowManifest(doc.manifest);
		types = (manifest.nodes ?? []).map((n) => n.type).join(" → ");
	} catch (err) {
		status = "FAIL";
		failed += 1;
		detail = err instanceof Error ? err.message : String(err);
	}
	rows.push({ file: basename(file), status, types, detail });
}

const width = Math.max(...rows.map((r) => r.file.length));
for (const r of rows) {
	console.log(
		`${r.status === "PASS" ? "✅" : "❌"} ${r.file.padEnd(width)}  ${r.status}  ${r.types}` +
			(r.detail ? `\n     ↳ ${r.detail}` : ""),
	);
}

// The boot path itself: loadBundledWorkflowSeeds() validates the whole set and
// is what actually runs when the Bridge starts.
console.log("\nBoot path — loadBundledWorkflowSeeds():");
try {
	console.log(`✅ loaded ${loadBundledWorkflowSeeds().length} seeds`);
} catch (err) {
	failed += 1;
	console.log(`❌ ${err instanceof Error ? err.message : String(err)}`);
}

console.log("\nGate authority — bundled + compiled menu snapshots:");
for (const seed of [
	...loadBundledWorkflowSeeds(),
	...loadWorkflowMenuSeeds(),
]) {
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
	`\n${failed === 0 ? "ALL SEEDS PASS" : `${failed} FAILURE(S)`} — ${files.length} seed files`,
);
process.exit(failed === 0 ? 0 : 1);
