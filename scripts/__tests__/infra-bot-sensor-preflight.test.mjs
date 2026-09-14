import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { preflight } from "../infra-bot-sensor-preflight.mjs";

test("refuses the observed KeepAlive crash-loop before waiting", async () => {
	await assert.rejects(
		preflight("com.flywheel.lead.flywheel-codex-infra-bot-lead", {
			probe: async () =>
				"gui/501/job = {\n\tstate = spawn scheduled\n\truns = 132\n\tlast exit code = 3\n}\n",
			wait: () => assert.fail("must refuse immediately"),
		}),
		/not running.*spawn scheduled.*last exit code=3/,
	);
});

const label = "com.flywheel.lead.flywheel-codex-infra-bot-lead";
const running = (pid = "120", runs = "8") =>
	`gui/501/job = {\n\tstate = running\n\tpid = ${pid}\n\truns = ${runs}\n\tlast exit code = 3\n}\n`;

test("admits a stable recovered job despite its historical nonzero exit", async () => {
	const calls = [];
	const result = await preflight(label, {
		probe: async (target) => {
			calls.push(target);
			return running();
		},
		wait: async (ms) => calls.push(ms),
	});
	const target = `gui/${process.getuid()}/${label}`;
	assert.deepEqual(calls, [target, 35_000, target]);
	assert.deepEqual(result, { target, pid: "120", runs: "8" });
});

for (const [name, after, reason] of [
	[
		"transient running then stopped",
		"\tstate = spawn scheduled\n",
		/not running/,
	],
	["new pid", running("121"), /restarted/],
	["pid reused but runs increased", running("120", "9"), /restarted/],
	["runs reset by job replacement", running("120", "1"), /restarted/],
]) {
	test(`refuses ${name}`, async () => {
		const samples = [running(), after];
		await assert.rejects(
			preflight(label, {
				probe: async () => samples.shift(),
				wait: async () => {},
			}),
			reason,
		);
	});
}

for (const sample of [
	"",
	"\tstate = spawn scheduled\n\tresource coalition = {\n\t\tstate = running\n\t}\n\tjob state = running\n",
	"\tstate = running\n\tstate = running\n\tpid = 120\n\truns = 8\n",
	"\tstate = running\n\tresource coalition = {\n\t\tpid = 120\n\t\truns = 8\n\t}\n",
	running("0"),
	running("-1"),
	running("120", "unknown"),
	running().replace("\truns = 8\n", ""),
]) {
	test(`refuses incomplete or ambiguous launchctl output ${JSON.stringify(sample)}`, async () => {
		await assert.rejects(
			preflight(label, {
				probe: async () => sample,
				wait: () => assert.fail("must refuse immediately"),
			}),
			/not running|missing\/invalid/,
		);
	});
}

for (const code of ["ENOENT", "EPERM", "ETIMEDOUT"]) {
	for (const failingSample of [0, 1]) {
		test(`refuses ${code} at sample ${failingSample + 1}`, async () => {
			let calls = 0;
			await assert.rejects(
				preflight(label, {
					probe: async () => {
						if (calls++ === failingSample) throw new Error(code);
						return running();
					},
					wait: async () => {},
				}),
				new RegExp(code),
			);
		});
	}
}

for (const invalid of [
	undefined,
	"",
	"-x",
	"gui/501/job",
	"job;echo x",
	"job\n",
	" job",
]) {
	test(`rejects invalid label ${JSON.stringify(invalid)} before probing`, async () => {
		await assert.rejects(
			preflight(invalid, {
				probe: () => assert.fail("must not launch command"),
			}),
			/expected one bare/,
		);
	});
}

test("CLI refuses bad arguments and never prints an enable recipe", () => {
	const script = new URL("../infra-bot-sensor-preflight.mjs", import.meta.url);
	for (const args of [[], ["gui/501/job"], [label, "extra"]]) {
		const result = spawnSync(process.execPath, [script.pathname, ...args], {
			encoding: "utf8",
		});
		assert.equal(result.status, 1);
		assert.match(result.stderr, /REFUSED:.*do not enable/);
		assert.equal(result.stdout, "");
	}
});
