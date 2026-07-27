import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as publicApi from "../index.js";

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SOURCE_ROOT = join(PACKAGE_ROOT, "src");

function productionTypeScriptFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "__tests__" || entry.name === "type-tests") {
			continue;
		}
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...productionTypeScriptFiles(path));
		} else if (entry.isFile() && entry.name.endsWith(".ts")) {
			files.push(path);
		}
	}
	return files;
}

describe("public package boundary", () => {
	it("exports exactly the approved runtime value set", () => {
		expect(Object.keys(publicApi).sort()).toEqual(
			[
				"CANDIDATE_SQL",
				"CasViolation",
				"DEFAULT_V2_DB_PATH",
				"DETECTOR_SQL",
				"FenceViolation",
				"Kernel",
				"NestedWriteViolation",
				"TxBudgetExceeded",
				"TxLifecycleViolation",
				"backupDatabase",
				"consumerRegistryKey",
				"leadRegistryKey",
				"migrateDatabase",
			].sort(),
		);
	});

	it("allows the built root package and denies every internal subpath", () => {
		const rootKeys = JSON.parse(
			execFileSync(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					"console.log(JSON.stringify(Object.keys(await import('flywheel-v2-kernel')).sort()))",
				],
				{ cwd: PACKAGE_ROOT, encoding: "utf8" },
			),
		) as string[];
		expect(rootKeys).toEqual(Object.keys(publicApi).sort());

		for (const subpath of [
			"migrator",
			"connection",
			"backup",
			"dist/index.js",
		]) {
			const code = `try { await import('flywheel-v2-kernel/${subpath}'); process.exit(2); } catch (error) { console.log(error.code); }`;
			expect(
				execFileSync(process.execPath, ["--input-type=module", "-e", code], {
					cwd: PACKAGE_ROOT,
					encoding: "utf8",
				}).trim(),
			).toBe("ERR_PACKAGE_PATH_NOT_EXPORTED");
		}
	});

	it("keeps database construction and transaction creation inside approved seams", () => {
		const files = productionTypeScriptFiles(SOURCE_ROOT);
		const databaseConstructors = files
			.filter((path) => readFileSync(path, "utf8").includes("new Database"))
			.map((path) => path.slice(SOURCE_ROOT.length + 1));
		const transactionCreators = files
			.filter((path) => readFileSync(path, "utf8").includes(".transaction("))
			.map((path) => path.slice(SOURCE_ROOT.length + 1))
			.sort();

		expect(databaseConstructors).toEqual(["connection.ts"]);
		expect(transactionCreators).toEqual(["kernel.ts", "migrator.ts"]);
	});
});
