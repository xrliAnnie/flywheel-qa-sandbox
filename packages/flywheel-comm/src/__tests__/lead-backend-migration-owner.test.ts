import { execFileSync, spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { assertMigrationRestartOwner } from "../lead-backend-migration-owner.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const home = mkdtempSync(join(tmpdir(), "fly2459-owner-"));
	dirs.push(home);
	const lock = join(home, ".flywheel/restart.lock.d");
	mkdirSync(lock, { recursive: true });
	const stat = statSync(lock);
	const input = {
		home,
		restartPid: 20,
		restartStart: "Fri Sep 11 00:00:00 2026",
		lockDev: stat.dev,
		lockIno: stat.ino,
		restartScript: join(home, "scripts/restart-services.sh"),
		updaterScript: join(home, "scripts/update-flywheel.sh"),
	};
	const rows = new Map([
		[
			30,
			{ ppid: 20, start: input.restartStart, command: "/bin/bash subshell" },
		],
		[
			20,
			{
				ppid: 10,
				start: input.restartStart,
				command: `/bin/bash ${input.restartScript} --reason updater`,
			},
		],
		[
			10,
			{
				ppid: 1,
				start: input.restartStart,
				command: `/bin/bash ${input.updaterScript}`,
			},
		],
	]);
	return { input, rows, probe: (pid: number) => rows.get(pid) ?? null };
}
it("accepts an internal descendant of the exact restart process launched by updater", () => {
	const f = fixture();
	expect(
		assertMigrationRestartOwner(f.input, { parentPid: 30, process: f.probe }),
	).toMatch(/^[a-f0-9]{64}$/);
});
it.each([
	"pid_reused",
	"foreign_parent",
	"manual",
	"updater_missing",
	"lock_replaced",
])("refuses %s", (kind) => {
	const f = fixture();
	if (kind === "pid_reused") f.rows.get(20)!.start = "later";
	if (kind === "foreign_parent") f.rows.get(30)!.ppid = 1;
	if (kind === "manual")
		f.rows.get(20)!.command =
			`/bin/bash ${f.input.restartScript} --reason manual`;
	if (kind === "updater_missing") f.rows.delete(10);
	if (kind === "lock_replaced") f.input.lockIno++;
	expect(() =>
		assertMigrationRestartOwner(f.input, { parentPid: 30, process: f.probe }),
	).toThrow(/owner/);
});
it("rejects misleading script substrings and cyclic ancestry", () => {
	const f = fixture();
	f.rows.get(10)!.command = `/bin/bash ${f.input.updaterScript}.untrusted`;
	expect(() =>
		assertMigrationRestartOwner(f.input, { parentPid: 30, process: f.probe }),
	).toThrow(/owner/);
	f.rows.get(30)!.ppid = 30;
	expect(() =>
		assertMigrationRestartOwner(f.input, { parentPid: 30, process: f.probe }),
	).toThrow(/owner/);
});

it("verifies real env-bash updater ancestry through a restart command substitution", (context) => {
	const permission = spawnSync(
		"/bin/ps",
		["-p", String(process.pid), "-o", "ppid="],
		{ timeout: 1000 },
	);
	if (
		(permission.error as NodeJS.ErrnoException | undefined)?.code === "EPERM"
	) {
		context.skip(
			"sandbox denies process inspection; real ancestry remains unverified",
		);
	}
	const f = fixture();
	const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	mkdirSync(join(f.input.home, "scripts"));
	const probe = join(f.input.home, "probe.mjs");
	const compiled = new URL(
		"../../dist/lead-backend-migration-owner.js",
		import.meta.url,
	).href;
	writeFileSync(
		probe,
		`import { execFileSync } from 'node:child_process';
import { assertMigrationRestartOwner } from ${JSON.stringify(compiled)};
const input = ${JSON.stringify(f.input)};
input.restartPid = Number(process.argv[2]);
input.restartStart = execFileSync('/bin/ps', ['-p', String(input.restartPid), '-o', 'lstart='], { encoding: 'utf8', env: {...process.env, LC_ALL:'C'} }).trim();
console.log(assertMigrationRestartOwner(input));
`,
	);
	writeFileSync(
		f.input.restartScript,
		`#!/usr/bin/env bash
wave() { ${shellQuote(process.execPath)} ${shellQuote(probe)} "$$"; }
result="$(wave)" || exit "$?"
printf '%s\\n' "$result"
`,
		{ mode: 0o700 },
	);
	writeFileSync(
		f.input.updaterScript,
		`#!/usr/bin/env bash
${shellQuote(f.input.restartScript)} --reason updater
exit "$?"
`,
		{ mode: 0o700 },
	);
	const result = execFileSync("/bin/bash", [f.input.updaterScript], {
		encoding: "utf8",
		timeout: 10000,
	});
	expect(result.trim()).toMatch(/^[a-f0-9]{64}$/);
	const direct = spawnSync(
		"/bin/bash",
		[f.input.restartScript, "--reason", "updater"],
		{ encoding: "utf8", timeout: 10000 },
	);
	expect(direct.status).not.toBe(0);
	expect(direct.stderr).toContain("migration restart owner unproven");
});
