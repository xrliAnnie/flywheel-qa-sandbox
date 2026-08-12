import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanReceiptResidue } from "../fly1645-receipt-residue-gate.mjs";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "fly1645-residue-"));
	const mainRoot = join(root, "main");
	const pluginRoot = join(root, "plugin");
	for (const repoRoot of [mainRoot, pluginRoot]) {
		mkdirSync(join(repoRoot, "src", "__tests__"), { recursive: true });
	}
	const config = {
		version: 1,
		repositories: {
			main: {
				includeRoots: ["src"],
				extensions: [".ts"],
				excludeFragments: ["/__tests__/", ".test."],
			},
			plugin: {
				includeRoots: ["src"],
				extensions: [".ts"],
				excludeFragments: ["/__tests__/", ".test."],
			},
		},
		deniedSymbols: [
			{
				id: "legacy-api",
				pattern: "settleLegacyDebt",
			},
			{
				id: "retired-table",
				pattern: "legacy_receipt_table",
				expectedAllowedMatches: 1,
				allows: [
					{
						repo: "main",
						path: "src/migration.ts",
						linePattern: "^DROP TABLE IF EXISTS legacy_receipt_table;$",
					},
				],
			},
		],
		relayStateAllowedFiles: ["src/questions.ts"],
	};
	return { mainRoot, pluginRoot, config };
}

test("allows only exact destructive migration residue and question relay state", () => {
	const { mainRoot, pluginRoot, config } = fixture();
	writeFileSync(
		join(mainRoot, "src", "migration.ts"),
		"DROP TABLE IF EXISTS legacy_receipt_table;\n",
	);
	writeFileSync(
		join(mainRoot, "src", "questions.ts"),
		"const field = 'relay_state';\n",
	);
	writeFileSync(
		join(pluginRoot, "src", "runtime.ts"),
		"export const ok = true;\n",
	);

	const result = scanReceiptResidue({ mainRoot, pluginRoot, config });
	assert.equal(result.ok, true);
	assert.equal(result.allowedMatches["retired-table"], 1);
});

test("fails on executable debt APIs, misplaced tombstones, and relay consumers", () => {
	const { mainRoot, pluginRoot, config } = fixture();
	writeFileSync(
		join(mainRoot, "src", "migration.ts"),
		"DROP TABLE IF EXISTS legacy_receipt_table;\n",
	);
	writeFileSync(
		join(mainRoot, "src", "runtime.ts"),
		"settleLegacyDebt();\nconst stale = 'legacy_receipt_table';\n",
	);
	writeFileSync(
		join(pluginRoot, "src", "runtime.ts"),
		"const state = row.relay_state;\n",
	);

	const result = scanReceiptResidue({ mainRoot, pluginRoot, config });
	assert.equal(result.ok, false);
	assert.deepEqual(
		result.violations.map((violation) => violation.kind).sort(),
		["denied_symbol", "denied_symbol", "relay_state_outside_question_domain"],
	);
});

test("excludes negative tests from the production residue scan", () => {
	const { mainRoot, pluginRoot, config } = fixture();
	writeFileSync(
		join(mainRoot, "src", "migration.ts"),
		"DROP TABLE IF EXISTS legacy_receipt_table;\n",
	);
	writeFileSync(
		join(mainRoot, "src", "__tests__", "negative.test.ts"),
		"settleLegacyDebt(); const field = 'relay_state';\n",
	);
	writeFileSync(
		join(pluginRoot, "src", "runtime.ts"),
		"export const ok = true;\n",
	);

	const result = scanReceiptResidue({ mainRoot, pluginRoot, config });
	assert.equal(result.ok, true);
});

test("supports a main-only CI scan without a sibling plugin checkout", () => {
	const { mainRoot, config } = fixture();
	writeFileSync(
		join(mainRoot, "src", "migration.ts"),
		"DROP TABLE IF EXISTS legacy_receipt_table;\n",
	);
	writeFileSync(
		join(mainRoot, "src", "questions.ts"),
		"const field = 'relay_state';\n",
	);

	const result = scanReceiptResidue({
		mainRoot,
		config,
		repos: ["main"],
	});
	assert.equal(result.ok, true);
	assert.deepEqual(result.scannedFiles, { main: 2 });
});
