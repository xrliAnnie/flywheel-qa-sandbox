import { execFileSync, spawnSync } from "node:child_process";
import {
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("uses the caller's measured addon bytes when assembling a pinned native runtime", () => {
	const temp = mkdtempSync(`${realpathSync(tmpdir())}/xhs-runtime-addon-`),
		output = join(temp, "runtime");
	try {
		const script = fileURLToPath(
			new URL("../../../../../scripts/xhs/build-runtime.mjs", import.meta.url),
		);
		execFileSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`import {buildRuntime} from ${JSON.stringify(script)}; await buildRuntime(${JSON.stringify(output)}, Buffer.from('measured-addon-fixture'));`,
			],
			{ timeout: 30000 },
		);
		expect(
			readFileSync(
				join(
					output,
					"node_modules/better-sqlite3/build/Release/better_sqlite3.node",
				),
			).equals(Buffer.from("measured-addon-fixture")),
		).toBe(true);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}, 40000);

it("builds isolated JS/SQLite runtime with no workspace links and refuses overwrite", () => {
	const temp = mkdtempSync(`${realpathSync(tmpdir())}/xhs-runtime-bundle-`),
		output = join(temp, "runtime");
	try {
		const script = fileURLToPath(
			new URL("../../../../../scripts/xhs/build-runtime.mjs", import.meta.url),
		);
		const receipt = JSON.parse(
			execFileSync(process.execPath, [script, "--output-dir", output], {
				encoding: "utf8",
				timeout: 30000,
			}),
		);
		expect(receipt.kind).toBe("offline_js_runtime");
		expect(receipt.esbuildVersion).toBe("0.25.10");
		expect(
			receipt.externalImports.filter((s: string) => !s.startsWith("node:")),
		).toEqual(["better-sqlite3"]);
		const walk = (path: string) => {
			for (const name of readdirSync(path)) {
				const next = join(path, name),
					stat = lstatSync(next);
				expect(stat.isSymbolicLink()).toBe(false);
				if (stat.isDirectory()) walk(next);
			}
		};
		walk(output);
		expect(
			lstatSync(
				join(
					output,
					"packages/teamlead/dist/xiaohongshu-write/boundary-probe-entry.js",
				),
			).mode & 0o7777,
		).toBe(0o755);
		expect(
			lstatSync(
				join(
					output,
					"packages/teamlead/dist/xiaohongshu-write/authority-main.js",
				),
			).mode & 0o7777,
		).toBe(0o644);
		const sqlite = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				"import Database from 'better-sqlite3'; const db=new Database(':memory:'); console.log(db.prepare('select 41+1 value').get().value); db.close();",
			],
			{ cwd: output, encoding: "utf8", timeout: 5000 },
		);
		expect(sqlite.status, sqlite.stderr).toBe(0);
		expect(sqlite.stdout.trim()).toBe("42");
		const module = join(
			output,
			"packages/teamlead/dist/xiaohongshu-write/installer-main.js",
		);
		const installer = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`import { runInstalledFixture } from ${JSON.stringify(module)}; try { await runInstalledFixture(); process.exitCode=2; } catch(e) { console.log(e.message); }`,
			],
			{ cwd: output, encoding: "utf8", timeout: 5000 },
		);
		expect(installer.status, installer.stderr).toBe(0);
		expect(installer.stdout.trim()).toBe("installed_fixture_unavailable");
		for (const [name, status, error] of [
			["authority-main.js", 2, "authority_arguments_invalid\n"],
			["boundary-probe-entry.js", 1, "boundary_probe_unavailable\n"],
		] as const) {
			const child = spawnSync(
				process.execPath,
				[join(output, "packages/teamlead/dist/xiaohongshu-write", name)],
				{ cwd: output, encoding: "utf8", timeout: 5000 },
			);
			expect(child.status).toBe(status);
			expect(child.stderr).toBe(error);
			expect(child.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
		}
		expect(
			spawnSync(process.execPath, [script, "--output-dir", output], {
				encoding: "utf8",
				timeout: 5000,
			}).status,
		).toBe(1);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}, 40000);
