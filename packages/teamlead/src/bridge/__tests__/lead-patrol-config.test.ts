import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { createLeadPatrolConfiguration } from "../lead-patrol-config.js";
import { PATROL_HELPER_SOURCES } from "../lead-patrol-snapshot.js";

it("pins the deployed helpers and rules and creates a private reusable scratch parent", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "patrol-config-")));
	try {
		const config = createLeadPatrolConfiguration(root);
		expect(config.stateDir).toBe(root);
		expect(config.nodePath).toBe(realpathSync(process.execPath));
		expect(lstatSync(config.activationRoot).mode & 0o777).toBe(0o700);
		expect(Object.keys(config.helperPins)).toEqual([...PATROL_HELPER_SOURCES]);
		for (const path of PATROL_HELPER_SOURCES)
			expect(config.helperPins[path]).toBe(
				createHash("sha256")
					.update(readFileSync(join(config.deploymentRoot, path)))
					.digest("hex"),
			);
		expect(config.source.sha256).toBe(
			createHash("sha256")
				.update(readFileSync(config.source.path))
				.digest("hex"),
		);
		expect(createLeadPatrolConfiguration(root)).toEqual(config);
		rmSync(config.activationRoot, { recursive: true });
		symlinkSync(root, config.activationRoot);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(createLeadPatrolConfiguration(root)).toBeUndefined();
			expect(warn).toHaveBeenCalledWith(
				"[Bridge] patrol disabled: patrol_configuration_invalid",
			);
		} finally {
			warn.mockRestore();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("does not prevent startup when the state directory is absent", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "patrol-unavailable-")));
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		expect(
			createLeadPatrolConfiguration(join(root, "missing")),
		).toBeUndefined();
		expect(warn).toHaveBeenCalledWith("[Bridge] patrol disabled: ENOENT");
	} finally {
		warn.mockRestore();
		rmSync(root, { recursive: true, force: true });
	}
});

it("disables patrol when a packaged layout omits monorepo helper files", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "patrol-package-")));
	try {
		const bridge = join(root, "node_modules/flywheel-teamlead/dist/bridge"),
			stateDir = join(root, "state");
		mkdirSync(bridge, { recursive: true });
		mkdirSync(stateDir, { mode: 0o700 });
		writeFileSync(
			join(root, "node_modules/flywheel-teamlead/package.json"),
			JSON.stringify({ type: "module" }),
		);
		for (const name of ["lead-patrol-config", "lead-patrol-snapshot"]) {
			const source = readFileSync(
				new URL(`../${name}.ts`, import.meta.url),
				"utf8",
			);
			const output = ts.transpileModule(source, {
				compilerOptions: {
					target: ts.ScriptTarget.ES2022,
					module: ts.ModuleKind.ES2022,
				},
			}).outputText;
			writeFileSync(join(bridge, `${name}.js`), output);
		}
		const entry = pathToFileURL(join(bridge, "lead-patrol-config.js")).href;
		const result = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`import {createLeadPatrolConfiguration} from ${JSON.stringify(entry)}; process.stdout.write(JSON.stringify({available:createLeadPatrolConfiguration(${JSON.stringify(stateDir)})!==undefined}));`,
			],
			{
				encoding: "utf8",
				timeout: 5000,
				env: { PATH: "/usr/bin:/bin", HOME: root },
			},
		);
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({ available: false });
		expect(result.stderr.trim()).toBe("[Bridge] patrol disabled: ENOENT");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
