import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { copyRetentionModules } from "./fixtures/fly-2413-module-copy.mjs";

const probePath = fileURLToPath(
	new URL("./fixtures/fly-2413-retention-probe.mjs", import.meta.url),
);
function probe(root, scenario, action) {
	return spawnSync(
		process.execPath,
		[probePath, root, scenario, ...(action ? [action] : [])],
		{ encoding: "utf8", timeout: 30_000 },
	);
}
function runProbe(root, scenario) {
	if (["activation", "manifest"].includes(scenario)) {
		for (const action of ["prepare", "change"]) {
			const result = probe(root, scenario, action);
			assert.equal(result.status, 0, result.stderr);
		}
		return probe(
			root,
			scenario,
			scenario === "activation" ? "reject-registry" : "reject",
		);
	}
	return probe(root, scenario);
}
for (const scenario of ["unknown", "missing", "activation", "manifest"]) {
	test(`${scenario}: normal passes, disabled guard causes assertion failure, restored passes`, () => {
		for (const mutation of [false, true, false]) {
			const root = copyRetentionModules();
			try {
				if (mutation) {
					const filename = ["unknown", "missing"].includes(scenario)
						? "fly-2006-retention-registry.mjs"
						: "fly-2006-retention-engine.mjs";
					const path = join(root, "scripts/lib", filename);
					const original = readFileSync(path, "utf8");
					const changed =
						scenario === "unknown"
							? original.replace("if (unknown.length > 0)", "if (false)")
							: scenario === "missing"
								? original.replace("if (missing.length > 0)", "if (false)")
								: scenario === "activation"
									? original.replace(
											"registrySha256: retentionRegistryDigest()",
											'registrySha256: "fixture-fixed-digest"',
										)
									: original.replace(".concat(retentionRegistryDigest())", "");
					assert.notEqual(
						changed,
						original,
						"mutation must match the source seam",
					);
					writeFileSync(path, changed);
				}
				const result = runProbe(root, scenario);
				if (mutation) {
					assert.notEqual(result.status, 0);
					assert.match(
						result.stderr,
						/AssertionError \[ERR_ASSERTION\]: Missing expected (exception|rejection)/,
					);
					assert.match(
						result.stderr,
						new RegExp(
							scenario === "unknown"
								? "schema_unclassified"
								: scenario === "missing"
									? "schema_missing"
									: scenario === "activation"
										? "activation_receipt_invalid"
										: "engine_digest_mismatch",
						),
					);
				} else assert.equal(result.status, 0, result.stderr);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}
	});
}
