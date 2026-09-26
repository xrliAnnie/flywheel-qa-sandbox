// FLY-2860: retired dist outputs are removed before each voice package build.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const SCRIPT = path.join(ROOT, "scripts/lib/remove-retired-dist.mjs");
const EXTS = [".js", ".d.ts", ".js.map", ".d.ts.map"];

function makePkg(manifest) {
	const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "fly2860-retired-"));
	if (manifest !== undefined) {
		fs.writeFileSync(
			path.join(pkg, "retired-outputs.json"),
			JSON.stringify(manifest),
		);
	}
	return pkg;
}
function touch(file) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "x");
}
function run(pkg) {
	return spawnSync(process.execPath, [SCRIPT, pkg], { encoding: "utf8" });
}
function listDist(pkg) {
	const out = [];
	const walk = (dir) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else out.push(path.relative(path.join(pkg, "dist"), p));
		}
	};
	walk(path.join(pkg, "dist"));
	return out.sort();
}

test("removes only the listed stems and dirs", () => {
	const pkg = makePkg({ stems: ["cli", "audio/resample"], dirs: ["huddle"] });
	for (const ext of EXTS) {
		touch(path.join(pkg, "dist", `cli${ext}`));
		touch(path.join(pkg, "dist", "audio", `resample${ext}`));
	}
	touch(path.join(pkg, "dist/huddle/GlawCommand.js"));
	touch(path.join(pkg, "dist/huddle/nested/x.d.ts"));
	touch(path.join(pkg, "dist/index.js"));
	touch(path.join(pkg, "dist/cli-extra.js"));
	touch(path.join(pkg, "dist/audio/LeadSpeaker.js"));
	touch(path.join(pkg, "dist/bots/cli.js"));
	const r = run(pkg);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /removed 9 retired output path\(s\)/);
	assert.deepEqual(listDist(pkg), [
		"audio/LeadSpeaker.js",
		"bots/cli.js",
		"cli-extra.js",
		"index.js",
	]);
});

test("rejects out-of-bounds entries and deletes nothing", () => {
	for (const bad of [
		"../escape",
		"/abs/path",
		"a/../../b",
		"a//b",
		"./cli",
		"a\\b",
		"",
	]) {
		const pkg = makePkg({ stems: ["cli", bad], dirs: [] });
		touch(path.join(pkg, "dist/cli.js"));
		const r = run(pkg);
		assert.equal(r.status, 1, `entry ${JSON.stringify(bad)} must be refused`);
		assert.match(r.stderr, /retired_outputs_invalid_entry/);
		assert.deepEqual(
			listDist(pkg),
			["cli.js"],
			"a refused manifest deletes nothing",
		);
	}
});

test("rejects a symlinked parent that escapes dist", () => {
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "fly2860-outside-"));
	touch(path.join(outside, "victim.js"));
	const pkg = makePkg({ stems: ["cli", "linked/victim"], dirs: [] });
	touch(path.join(pkg, "dist/cli.js"));
	fs.symlinkSync(outside, path.join(pkg, "dist/linked"));
	const r = run(pkg);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /retired_outputs_escape/);
	assert.ok(
		fs.existsSync(path.join(outside, "victim.js")),
		"outside file untouched",
	);
	assert.ok(
		fs.existsSync(path.join(pkg, "dist/cli.js")),
		"nothing deleted on refusal",
	);
});

test("a retired dir that is itself a symlink is unlinked, not followed", () => {
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "fly2860-outside-"));
	touch(path.join(outside, "keep.js"));
	const pkg = makePkg({ stems: [], dirs: ["huddle"] });
	fs.mkdirSync(path.join(pkg, "dist"));
	fs.symlinkSync(outside, path.join(pkg, "dist/huddle"));
	const r = run(pkg);
	assert.equal(r.status, 0, r.stderr);
	assert.ok(!fs.existsSync(path.join(pkg, "dist/huddle")));
	assert.ok(fs.existsSync(path.join(outside, "keep.js")));
});

test("is idempotent", () => {
	const pkg = makePkg({ stems: ["cli"], dirs: ["eleven"] });
	touch(path.join(pkg, "dist/cli.js"));
	touch(path.join(pkg, "dist/eleven/ElevenWs.js"));
	assert.equal(run(pkg).status, 0);
	const again = run(pkg);
	assert.equal(again.status, 0, again.stderr);
	assert.match(again.stdout, /removed 0 retired output path\(s\)/);
});

test("exits 0 when dist does not exist", () => {
	const pkg = makePkg({ stems: ["cli"], dirs: ["huddle"] });
	const r = run(pkg);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /removed 0 retired output path\(s\)/);
});

for (const name of ["voice-bridge", "voice-core"]) {
	test(`${name}: manifest is valid, wired into build, and never retires a live source`, () => {
		const pkgDir = path.join(ROOT, "packages", name);
		const manifest = JSON.parse(
			fs.readFileSync(path.join(pkgDir, "retired-outputs.json"), "utf8"),
		);
		assert.ok(manifest.stems.length + manifest.dirs.length > 0);
		const build = JSON.parse(
			fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"),
		).scripts.build;
		assert.equal(
			build,
			"node ../../scripts/lib/remove-retired-dist.mjs . && tsc",
		);
		for (const stem of manifest.stems) {
			assert.ok(
				!fs.existsSync(path.join(pkgDir, "src", `${stem}.ts`)),
				`live source ${stem}.ts`,
			);
		}
		for (const dir of manifest.dirs) {
			assert.ok(
				!fs.existsSync(path.join(pkgDir, "src", dir)),
				`live source dir ${dir}`,
			);
		}
	});
}
