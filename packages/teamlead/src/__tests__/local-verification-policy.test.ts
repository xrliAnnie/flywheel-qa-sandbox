import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const source = "scripts/lib/local-verification-policy.md";
const script = "scripts/sync-phase-protocols.mjs";
const roles = [
	".flywheel/agents/engineering/engineer-executor.md",
	".flywheel/agents/engineering/qa-executor.md",
	".flywheel/agents/general-executor.md",
];
const begin = "<!-- FLYWHEEL_LOCAL_VERIFICATION:BEGIN -->";
const end = "<!-- FLYWHEEL_LOCAL_VERIFICATION:END -->";
const required = [
	"pnpm lint",
	'pnpm --filter "<pkg>..." build',
	"available typechecks for affected packages",
	"typecheck affected dependents when exports, APIs, or types change",
	"owning package",
	"test files that directly depend",
	"git grep -lF",
	"full path, file name, and parent directory",
	"document every excluded match",
	"vitest related <files> --run",
	"deleted files, dynamic imports, and re-exports",
	"scripts/__tests__/*.test.sh",
	"no local full package suite",
	"full exact-head CI for the final commit",
	"scoped CI, ancestor results, and local targeted passes are not substitutes",
	"skill defaults",
	"Record selected tests, commands, results, final commit SHA, and CI run links",
];

function assertPolicy(text: string, role: string) {
	expect(text, role).not.toMatch(
		/pnpm test:packages:run|pnpm -r build|PACKAGE_GATE_RECEIPT/,
	);
	for (const value of required) expect(text, role).toContain(value);
	const action = role.includes("qa-executor")
		? "Any red current-HEAD CI job means FAIL; hand the failure to the author and verify the corrected head."
		: "Fix every red current-HEAD CI job before claiming verification complete.";
	expect(text, role).toContain(`${end}\n${action}`);
}

const temporary: string[] = [];
afterEach(() => {
	for (const dir of temporary.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function write(dir: string, path: string, text: string) {
	mkdirSync(dirname(join(dir, path)), { recursive: true });
	writeFileSync(join(dir, path), text);
}

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "fly2753-policy-"));
	temporary.push(dir);
	for (const path of [source, ...roles]) {
		write(dir, path, readFileSync(join(root, path), "utf8"));
	}
	copyFileSync(join(root, script), join(dir, script));
	mkdirSync(join(dir, "packages/teamlead"), { recursive: true });
	return dir;
}

function snapshot(dir: string) {
	return roles.map((path) =>
		existsSync(join(dir, path)) ? readFileSync(join(dir, path), "utf8") : null,
	);
}

function run(dir: string, args: string[] = [], cwd = dir) {
	const result = spawnSync(process.execPath, [join(dir, script), ...args], {
		cwd,
		encoding: "utf8",
		timeout: 5000,
	});
	expect(result.error).toBeUndefined();
	expect(result.signal).toBeNull();
	return result;
}

function rejectWithoutWrites(dir: string, message: string) {
	const before = snapshot(dir);
	for (const mode of ["--check", "--write"]) {
		const result = run(dir, [mode]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(message);
		expect(snapshot(dir)).toEqual(before);
	}
}

describe("FLY-2753 local verification policy", () => {
	it.each(roles)("enforces targeted verification in the real %s", (role) => {
		assertPolicy(readFileSync(join(root, role), "utf8"), role);
	});

	it("checks all actual projections without modifying them", () => {
		const before = snapshot(root);
		for (const args of [[], ["--check"]]) {
			expect(run(root, args).status).toBe(0);
			expect(snapshot(root)).toEqual(before);
		}
	});

	it("detects drift read-only, repairs only the block, and is idempotent", () => {
		const dir = fixture();
		const original = snapshot(dir);
		write(
			dir,
			roles[1],
			original[1]?.replace("pnpm lint", "pnpm broken") ?? "",
		);
		const drifted = snapshot(dir);
		const result = run(dir, ["--check"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(roles[1]);
		expect(snapshot(dir)).toEqual(drifted);
		expect(run(dir, ["--write"]).status).toBe(0);
		expect(snapshot(dir)).toEqual(original);
		expect(run(dir, ["--write"]).status).toBe(0);
		expect(snapshot(dir)).toEqual(original);
		expect(run(dir, ["--check"]).status).toBe(0);
	});

	const malformed = [
		["missing begin", `${end}\n`],
		["missing end", `${begin}\n`],
		["duplicate block", `${begin}\nx\n${end}\n${begin}\nx\n${end}\n`],
		["reversed markers", `${end}\nx\n${begin}\n`],
		["inline begin prefix", `prefix${begin}\nx\n${end}\n`],
		["inline begin suffix", `${begin}suffix\nx\n${end}\n`],
		["inline end prefix", `${begin}\nx${end}\n`],
		["inline end suffix", `${begin}\nx\n${end}suffix\n`],
	];
	it.each(malformed)("rejects %s before any write", (_name, text) => {
		const dir = fixture();
		write(dir, roles[0], snapshot(dir)[0]?.replace("pnpm lint", "drift") ?? "");
		write(dir, roles[2], text);
		rejectWithoutWrites(dir, "expected one paired standalone");
	});

	it.each([null, " \n", `${begin}\nx\n${end}\n`])(
		"rejects missing/empty/invalid source: %s",
		(text) => {
			const dir = fixture();
			if (text === null) rmSync(join(dir, source));
			else write(dir, source, text);
			rejectWithoutWrites(dir, text === null ? "ENOENT" : "invalid local");
		},
	);

	it.each(roles)("rejects missing target %s before any write", (role) => {
		const dir = fixture();
		write(dir, roles[0], snapshot(dir)[0]?.replace("pnpm lint", "drift") ?? "");
		rmSync(join(dir, role));
		rejectWithoutWrites(dir, "ENOENT");
	});

	it.each([["--unknown"], ["--check", "--write"]])(
		"rejects invalid arguments %j",
		(...args) => {
			const dir = fixture();
			const before = snapshot(dir);
			const result = run(dir, args);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("usage:");
			expect(snapshot(dir)).toEqual(before);
		},
	);

	it("resolves the root from the script regardless of cwd", () => {
		const dir = fixture();
		expect(run(dir, ["--check"], join(dir, "packages/teamlead")).status).toBe(
			0,
		);
	});

	it("runs the real prebuild gate and blocks a build on projection drift", () => {
		const dir = fixture();
		const pkg = JSON.parse(
			readFileSync(join(root, "packages/teamlead/package.json"), "utf8"),
		);
		expect(pkg.scripts.prebuild).toBe(`node ../../${script} --check`);
		write(
			dir,
			"packages/teamlead/package.json",
			JSON.stringify({
				scripts: {
					prebuild: pkg.scripts.prebuild,
					build: "node -e \"require('fs').writeFileSync('built', 'yes')\"",
				},
			}),
		);
		write(dir, roles[1], snapshot(dir)[1]?.replace("pnpm lint", "drift") ?? "");
		const result = spawnSync("pnpm", ["run", "build"], {
			cwd: join(dir, "packages/teamlead"),
			encoding: "utf8",
			timeout: 10000,
		});
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stdout + result.stderr).toContain("projection drift");
		expect(existsSync(join(dir, "packages/teamlead/built"))).toBe(false);
	});

	it.each(roles)("rejects weakened policy clauses in %s", (role) => {
		const original = readFileSync(join(root, role), "utf8");
		assertPolicy(original, role);
		for (const clause of required) {
			expect(() =>
				assertPolicy(original.replace(clause, "removed"), role),
			).toThrow();
		}
		for (const forbidden of [
			"pnpm test:packages:run",
			"pnpm -r build",
			"PACKAGE_GATE_RECEIPT",
		]) {
			expect(() => assertPolicy(`${original}\n${forbidden}`, role)).toThrow();
		}
		expect(() =>
			assertPolicy(original.replace(`${end}\n`, `${end}\nrelocated\n`), role),
		).toThrow();
	});
});
