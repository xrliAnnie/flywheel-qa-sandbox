import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";

const repo = resolve(import.meta.dirname, "../..");
const roots = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function snapshot(path) {
	const info = lstatSync(path);
	return [
		info.mode,
		info.mtimeMs,
		info.isDirectory()
			? readdirSync(path)
					.sort()
					.map((name) => [name, snapshot(join(path, name))])
			: readFileSync(path).toString("base64"),
	];
}
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "install-voice-"));
	roots.push(root);
	const home = join(root, "home");
	const targetRepo = join(home, "Dev/flywheel");
	const bin = join(root, "bin");
	mkdirSync(join(targetRepo, "scripts/launchd"), { recursive: true });
	mkdirSync(bin);
	mkdirSync(join(home, ".flywheel"), { recursive: true });
	cpSync(join(repo, "scripts/lib"), join(targetRepo, "scripts/lib"), {
		recursive: true,
	});
	for (const name of [
		"flywheel-config-lock.sh",
		"flywheel-config-lock.py",
		"install-voice-launchd.sh",
	])
		if (existsSync(join(repo, "scripts", name)))
			cpSync(join(repo, "scripts", name), join(targetRepo, "scripts", name));
	const wrapper = join(targetRepo, "scripts/flywheel-voice-wrapper.sh");
	writeFileSync(wrapper, "#!/bin/bash\nexit 0\n", { mode: 0o755 });
	const source = join(targetRepo, "scripts/launchd/com.flywheel.voice.plist");
	writeFileSync(
		source,
		readFileSync(
			join(repo, "scripts/launchd/com.flywheel.voice.plist"),
			"utf8",
		).replaceAll("/Users/xiaorongli/Dev/flywheel", targetRepo),
	);
	writeFileSync(
		join(home, ".flywheel/.env"),
		"TEAMLEAD_API_TOKEN=fixture\nOPENAI_API_KEY=fixture\n",
		{ mode: 0o600 },
	);
	writeFileSync(
		join(home, ".flywheel/voice-host.json"),
		'{"schemaVersion":1}',
		{ mode: 0o600 },
	);
	mkdirSync(join(targetRepo, "packages/voice-codex/dist"), { recursive: true });
	writeFileSync(join(targetRepo, "packages/voice-codex/dist/cli.js"), "");
	const script = (name, code) =>
		writeFileSync(join(bin, name), code, { mode: 0o755 });
	script("uname", "#!/bin/sh\necho Darwin\n");
	script("id", "#!/bin/sh\necho 501\n");
	script(
		"sleep",
		'#!/bin/sh\nif [ "$1" = 5 ]; then exec /bin/sleep 5; fi\nexit 0\n',
	);
	script("node", "#!/bin/sh\nexit 0\n");
	script(
		"plutil",
		`#!/usr/bin/env python3
import plistlib,sys
try:
 v=plistlib.load(open(sys.argv[-1],'rb'))
 for k in sys.argv[2].split('.'): v=v[int(k)] if isinstance(v,list) else v[k]
 print(str(v).lower() if isinstance(v,bool) else '\\n'.join(v) if isinstance(v,dict) else v)
except Exception: sys.exit(1)
`,
	);
	const dest = join(home, "Library/LaunchAgents/com.flywheel.voice.plist");
	script(
		"launchctl",
		`#!/bin/bash
printf '%s\\n' "$*" >> "$FIXTURE_ROOT/calls"
case "$1" in
 print-disabled) echo 'disabled services = {'; [[ -e "$FIXTURE_ROOT/disabled" ]] && echo '"com.flywheel.voice" => disabled'; echo '}'; exit 0;;
 print)
  if [[ "$2" == gui/501 ]]; then echo 'gui/501 = {'; exit 0; fi
  label="\${2##*/}"
  if [[ "$label" != com.flywheel.voice || ! -e "$FIXTURE_ROOT/loaded" ]]; then echo "Could not find service \\\"$label\\\"" >&2; exit 113; fi
  echo "$2 = {"; if [[ -e "$FIXTURE_ROOT/foreign" ]]; then echo $'\\tpath = /foreign.plist'; else echo $'\\tpath = ${dest}'; fi; echo $'\\tprogram = /bin/bash'; echo $'\\targuments = {'; echo $'\\t\\t/bin/bash'; echo $'\\t\\t${wrapper}'; echo $'\\t}'
  if [[ -e "$FIXTURE_ROOT/refused" ]]; then echo $'\\tstate = not running'; echo $'\\tlast exit code = 0'; elif [[ -e "$FIXTURE_ROOT/nested-running" ]]; then echo $'\\tstate = spawn scheduled'; echo $'\\tpid = 777'; else echo $'\\tstate = running'; echo $'\\tpid = 777'; fi
  echo $'\\tresource coalition = {'; if [[ -e "$FIXTURE_ROOT/nested-running" ]]; then echo $'\\t\\tstate = running'; else echo $'\\t\\tstate = active'; fi; echo $'\\t}'
  echo $'\\tevent triggers = {'; echo $'\\t\\tcom.apple.launchd = {'; echo $'\\t\\t\\tstate = active'; echo $'\\t\\t}'; echo $'\\t}'
  echo '}'; exit 0;;
 bootstrap)
  touch "$FIXTURE_ROOT/loaded"
  if [[ -e "$FIXTURE_ROOT/replace" ]]; then cp '${dest}' '${dest}.replacement'; mv '${dest}.replacement' '${dest}'; fi
  /bin/sleep 0.1
  exit 0;;
 bootout) rm -f "$FIXTURE_ROOT/loaded"; exit 0;;
 *) exit 90;;
esac
`,
	);
	const run = (check = false) =>
		spawnSync(
			"/bin/bash",
			[
				join(targetRepo, "scripts/install-voice-launchd.sh"),
				...(check ? ["--check"] : []),
			],
			{
				encoding: "utf8",
				timeout: 60000,
				env: {
					HOME: home,
					PATH: `${bin}:${process.env.PATH}`,
					FIXTURE_ROOT: root,
				},
			},
		);
	const runAsync = () =>
		new Promise((resolveRun) => {
			const child = spawn(
				"/bin/bash",
				[join(targetRepo, "scripts/install-voice-launchd.sh")],
				{
					env: {
						HOME: home,
						PATH: `${bin}:${process.env.PATH}`,
						FIXTURE_ROOT: root,
					},
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let output = "";
			child.stdout.on("data", (data) => {
				output += data;
			});
			child.stderr.on("data", (data) => {
				output += data;
			});
			child.on("close", (status) => resolveRun({ status, output }));
		});
	return {
		root,
		home,
		source,
		dest,
		run,
		runAsync,
		calls: () =>
			existsSync(join(root, "calls"))
				? readFileSync(join(root, "calls"), "utf8")
				: "",
	};
}
test("check is read-only and install/repeat bootstrap exactly once", () => {
	const f = fixture();
	const before = snapshot(f.home);
	let r = f.run(true);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(snapshot(f.home), before);
	assert.equal(existsSync(join(f.home, "Library")), false);
	assert.doesNotMatch(f.calls(), /bootstrap|bootout/);
	r = f.run();
	assert.equal(r.status, 0, r.stderr);
	assert.equal(readFileSync(f.dest, "utf8"), readFileSync(f.source, "utf8"));
	r = f.run();
	assert.equal(r.status, 0, r.stderr);
	assert.equal(
		f
			.calls()
			.split("\n")
			.filter((x) => x.startsWith("bootstrap ")).length,
		1,
	);
	assert.doesNotMatch(f.calls(), /bootout|kickstart|enable/);
});
for (const conflict of ["disabled", "different", "symlink", "refused"])
	test(`fails safely for ${conflict}`, () => {
		const f = fixture();
		if (conflict === "disabled" || conflict === "refused")
			writeFileSync(join(f.root, conflict), "1");
		if (conflict === "different" || conflict === "symlink") {
			mkdirSync(resolve(f.dest, ".."), { recursive: true });
			if (conflict === "different") writeFileSync(f.dest, "original");
			else symlinkSync(f.source, f.dest);
		}
		const r = f.run();
		assert.notEqual(r.status, 0, r.stdout + r.stderr);
		if (conflict === "refused") {
			assert.match(f.calls(), /bootout/);
			assert.equal(existsSync(f.dest), false);
		} else assert.doesNotMatch(f.calls(), /bootstrap|bootout/);
		if (conflict === "different")
			assert.equal(readFileSync(f.dest, "utf8"), "original");
	});

test("retains an identical preexisting plist when this bootstrap is refused", () => {
	const f = fixture();
	mkdirSync(resolve(f.dest, ".."), { recursive: true });
	cpSync(f.source, f.dest);
	writeFileSync(join(f.root, "refused"), "1");
	const r = f.run();
	assert.notEqual(r.status, 0);
	assert.match(f.calls(), /bootout/);
	assert.equal(readFileSync(f.dest, "utf8"), readFileSync(f.source, "utf8"));
});
test("rejects nested running when the top-level state is not running", () => {
	const f = fixture();
	writeFileSync(join(f.root, "nested-running"), "1");
	const r = f.run();
	assert.notEqual(r.status, 0, r.stdout + r.stderr);
	assert.match(f.calls(), /bootout/);
	assert.equal(existsSync(f.dest), false);
});
test("does not boot out a preexisting service with unverified identity", () => {
	const f = fixture();
	mkdirSync(resolve(f.dest, ".."), { recursive: true });
	cpSync(f.source, f.dest);
	writeFileSync(join(f.root, "loaded"), "1");
	writeFileSync(join(f.root, "foreign"), "1");
	assert.notEqual(f.run().status, 0);
	assert.doesNotMatch(f.calls(), /bootstrap|bootout/);
});
test("does not remove or stop a replacement observed after bootstrap", () => {
	const f = fixture();
	writeFileSync(join(f.root, "replace"), "1");
	assert.notEqual(f.run().status, 0);
	assert.equal(existsSync(f.dest), true);
	assert.doesNotMatch(f.calls(), /bootout/);
});
test("concurrent installers serialize and bootstrap only once", async () => {
	const f = fixture();
	const results = await Promise.all([f.runAsync(), f.runAsync()]);
	for (const r of results) assert.ok([0, 75].includes(r.status), r.output);
	assert.ok(
		results.some((r) => r.status === 0),
		"one installer must complete",
	);
	// The loser may exhaust the bounded lock wait; retry must observe the same job.
	const retry = f.run();
	assert.equal(retry.status, 0, retry.stderr);
	assert.equal(
		f
			.calls()
			.split("\n")
			.filter((x) => x.startsWith("bootstrap ")).length,
		1,
	);
	assert.doesNotMatch(f.calls(), /bootout|kickstart/);
});
