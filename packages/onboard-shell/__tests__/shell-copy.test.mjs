import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("shell copy switches current only after full copy and repairs an incomplete existing version", async () => {
	const { refreshShellCopy } = await import("../lib/shell-copy.mjs");
	const stateDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "fly2392-copy-")),
	);
	try {
		const cfg = { stateDir };
		const root = refreshShellCopy(cfg);
		assert.equal(fs.realpathSync(path.join(stateDir, "shell/current")), root);
		assert.ok(fs.existsSync(path.join(root, "bin/flywheel-onboard.js")));
		assert.ok(fs.existsSync(path.join(root, "lib/update.mjs")));
		fs.unlinkSync(path.join(root, "lib/update.mjs"));
		refreshShellCopy(cfg);
		assert.ok(fs.existsSync(path.join(root, "lib/update.mjs")));
		assert.equal(
			fs
				.readdirSync(path.dirname(root))
				.some((name) => name.startsWith(".tmp-") || name.startsWith(".trash-")),
			false,
		);
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

for (const point of ["copied", "promoted"]) {
	test(`shell copy SIGKILL after ${point} keeps previous current and next invocation cleans residue`, async () => {
		const { spawnSync } = await import("node:child_process");
		const { refreshShellCopy } = await import("../lib/shell-copy.mjs");
		const stateDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "fly2392-copy-")),
		);
		try {
			const cfg = { stateDir };
			const previous = refreshShellCopy(cfg);
			const source = path.join(stateDir, "source");
			fs.cpSync(previous, source, { recursive: true });
			const pkgFile = path.join(source, "package.json");
			const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
			pkg.version = "0.1.1";
			fs.writeFileSync(pkgFile, JSON.stringify(pkg));
			const code = `import {refreshShellCopy} from ${JSON.stringify(new URL("../lib/shell-copy.mjs", import.meta.url).href)};refreshShellCopy({stateDir:process.argv[1]},{source:process.argv[2],checkpoint(name){if(name===process.argv[3])process.kill(process.pid,'SIGKILL')}});`;
			const child = spawnSync(
				process.execPath,
				["--input-type=module", "-e", code, stateDir, source, point],
				{ encoding: "utf8", timeout: 5000 },
			);
			assert.equal(child.signal, "SIGKILL", child.stderr);
			assert.equal(
				fs.realpathSync(path.join(stateDir, "shell/current")),
				previous,
			);
			const next = refreshShellCopy(cfg, { source });
			assert.equal(fs.realpathSync(path.join(stateDir, "shell/current")), next);
			assert.equal(
				fs.readdirSync(path.join(stateDir, "shell/versions")).length,
				2,
			);
		} finally {
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
	});
}
