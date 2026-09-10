#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const PACKAGE_ROOT = join(REPO_ROOT, "packages", "teamlead");
const SOURCE = join(PACKAGE_ROOT, "src", "auto-narrow", "eligibility.ts");
const WRITER_TEST = "src/__tests__/StateStore.auto-narrow-approval.test.ts";
const UNIT_TEST = "src/auto-narrow/__tests__/eligibility.test.ts";
const MUTANTS = Object.freeze([
	{
		name: "gate1_machine_docs_only",
		gate: "gate1",
		unitFailure: "blocks when machine fails",
	},
	{
		name: "gate2_lead_pure_docs",
		gate: "gate2",
		unitFailure: "blocks when declaration fails",
	},
	{
		name: "gate3_strength_two",
		gate: "gate3",
		unitFailure: "blocks when strength two fails",
	},
]);

function digest(value) {
	return createHash("sha256").update(value).digest("hex");
}

export function runNarrowGateMutations() {
	const original = readFileSync(SOURCE, "utf8");
	const originalDigest = digest(original);
	const scratch = mkdtempSync(join(tmpdir(), "fly2453-narrow-mutants-"));
	const root = join(scratch, "repo", "packages", "teamlead");
	try {
		mkdirSync(root, { recursive: true });
		cpSync(PACKAGE_ROOT, root, {
			recursive: true,
			filter: (path) =>
				path !== join(PACKAGE_ROOT, "node_modules") &&
				path !== join(PACKAGE_ROOT, "dist"),
		});
		cpSync(
			join(REPO_ROOT, "tsconfig.base.json"),
			join(scratch, "repo", "tsconfig.base.json"),
		);
		symlinkSync(
			join(REPO_ROOT, ".flywheel"),
			join(scratch, "repo", ".flywheel"),
			"dir",
		);
		symlinkSync(
			join(PACKAGE_ROOT, "node_modules"),
			join(root, "node_modules"),
			"dir",
		);
		// Fixtures bind repository-owned agent files; preserve that canonical root
		// while the imported writer and eligibility code come from the shadow copy.
		const writerCopy = join(root, WRITER_TEST);
		writeFileSync(
			writerCopy,
			readFileSync(writerCopy, "utf8").replace(
				/const REPO_ROOT = [^;]+;/,
				`const REPO_ROOT = ${JSON.stringify(REPO_ROOT)};`,
			),
		);
		const sourceCopy = join(root, "src", "auto-narrow", "eligibility.ts");
		function run() {
			const result = spawnSync(
				"pnpm",
				[
					"--dir",
					PACKAGE_ROOT,
					"exec",
					"vitest",
					"run",
					"--root",
					root,
					"--pool=forks",
					"--maxWorkers=1",
					"--minWorkers=1",
					WRITER_TEST,
					UNIT_TEST,
					"-t",
					"writer-level|blocks when",
				],
				{ encoding: "utf8", timeout: 120_000 },
			);
			if (result.error) throw result.error;
			return { result, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
		}
		const baseline = run();
		if (baseline.result.status !== 0)
			throw new Error(`baseline failed: ${baseline.output}`);
		process.stdout.write(`baseline=green\n${baseline.output}`);
		for (const mutant of MUTANTS) {
			const pattern = new RegExp(`const ${mutant.gate} =[^;]+;`, "g");
			if ([...original.matchAll(pattern)].length !== 1)
				throw new Error(`${mutant.name}: ambiguous mutation target`);
			const mutated = original.replace(pattern, `const ${mutant.gate} = true;`);
			writeFileSync(sourceCopy, mutated);
			const { result, output } = run();
			process.stdout.write(`\n${mutant.name} exit=${result.status}\n${output}`);
			const cleanOutput = stripVTControlCharacters(output);
			if (
				result.status === 0 ||
				!cleanOutput.includes(
					`FAIL  ${WRITER_TEST} > QA writer-level three-gate negatives > ${mutant.gate} negative:`,
				) ||
				!cleanOutput.includes(`FAIL  ${UNIT_TEST}`) ||
				!cleanOutput.includes(mutant.unitFailure)
			) {
				throw new Error(
					`${mutant.name}: missing writer and unit gate assertion failures`,
				);
			}
			process.stdout.write(
				`mutation_result=${JSON.stringify({ name: mutant.name, killed: true, wholeGate: true, writerKilled: true, exit: result.status })}\n`,
			);
		}
		if (digest(readFileSync(SOURCE, "utf8")) !== originalDigest)
			throw new Error("production source changed during mutations");
		return { killed: MUTANTS.length, total: MUTANTS.length };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

if (
	process.argv[1] &&
	realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		const result = runNarrowGateMutations();
		process.stdout.write(
			`\nFLY-2453 mutation gate: ${result.killed}/${result.total} killed\n`,
		);
	} catch (error) {
		process.stderr.write(
			`FLY-2453 mutation gate failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
