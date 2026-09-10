import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const helper = join(root, "scripts/lib/qa-lead-diagnostics.py");

function runHelper(args, options = {}) {
	return spawnSync("python3", [helper, ...args], {
		cwd: root,
		encoding: "utf8",
		...options,
	});
}

function qaRuntime() {
	const slot = `${process.pid}${Math.floor(Math.random() * 100000)}`;
	const slotRoot = join("/tmp", `flywheel-test-slot-${slot}`);
	const runtime = join(slotRoot, "launchd", "ops-lead");
	mkdirSync(runtime, { mode: 0o700, recursive: true });
	chmodSync(runtime, 0o700);
	const manifest = join(runtime, "manifest.json");
	writeFileSync(
		manifest,
		JSON.stringify({ leadId: "ops-lead", projectName: `test-slot-${slot}` }),
		{ mode: 0o600 },
	);
	return { slotRoot, runtime, manifest };
}

function executable(path, body) {
	writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
	chmodSync(path, 0o700);
}

function fixture(
	dir,
	{
		manifestContent = JSON.stringify({
			leadId: "flywheel-test-2",
			projectName: "test-slot-2",
			pid: 4242,
			socketPath: "/tmp/private-qa.sock",
		}),
		plistLabel = "com.flywheel.qa.lead.slot-2.flywheel-test-2",
		plistArguments,
		launchctlBody = 'printf "state = running\\npid = 4242\\nlast exit code = 9\\n"',
		tmuxBody = 'test "$1" = "-V" && { echo "tmux 3.7c"; exit 0; }; exit 0',
	} = {},
) {
	const runtime = join(dir, "runtime");
	const manifest = join(runtime, "manifest.json");
	const plist = join(runtime, "lead.plist");
	const log = join(runtime, "lead.log");
	const wrapper = join(dir, "lead-wrapper.sh");
	const launchctl = join(dir, "launchctl");
	const tmux = join(dir, "tmux");
	mkdirSync(runtime, { mode: 0o700 });
	if (manifestContent !== null) writeFileSync(manifest, manifestContent);
	const args = plistArguments ?? [wrapper, manifest];
	writeFileSync(
		plist,
		`<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>${plistLabel}</string><key>ProgramArguments</key><array>${args.map((item) => `<string>${item}</string>`).join("")}</array></dict></plist>\n`,
	);
	writeFileSync(log, "FLY2455_LOG_SECRET_CANARY\n");
	executable(wrapper, "exit 0");
	executable(launchctl, launchctlBody);
	executable(tmux, tmuxBody);
	return { runtime, manifest, plist, log, wrapper, launchctl, tmux };
}

function runSnapshot(dir, overrides = {}) {
	const runtime = join(dir, "runtime");
	const manifest = overrides.manifest ?? join(runtime, "manifest.json");
	const plist = overrides.plist ?? join(runtime, "lead.plist");
	const log = overrides.log ?? join(runtime, "lead.log");
	const wrapper = overrides.wrapper ?? join(dir, "lead-wrapper.sh");
	const launchctl = overrides.launchctl ?? join(dir, "launchctl");
	const tmux = overrides.tmux ?? join(dir, "tmux");
	return spawnSync(
		"python3",
		[
			helper,
			"snapshot",
			"--phase",
			"topology",
			"--label",
			"com.flywheel.qa.lead.slot-2.flywheel-test-2",
			"--plist",
			plist,
			"--manifest",
			manifest,
			"--log",
			log,
			"--wrapper",
			wrapper,
			"--launchctl",
			launchctl,
			"--domain",
			"gui/501",
			"--tmux",
			tmux,
			"--last-launch-pid",
			"4242",
			"--last-manifest-pid",
			"4242",
			"--last-socket",
			"/tmp/private-qa.sock",
			"--last-probe-exit-code",
			"1",
			"--last-observed-at",
			"2026-09-09T04:00:00.000Z",
		],
		{ cwd: root, encoding: "utf8" },
	);
}

test("snapshot distinguishes an invalid manifest without leaking its bytes", () => {
	const dir = mkdtempSync(join(tmpdir(), "fly2455-diagnostics-"));
	try {
		const { runtime, manifest, tmux } = fixture(dir, {
			manifestContent: '{"secret":"FLY2455_SECRET_CANARY"',
			tmuxBody: 'test "$1" = "-V" && { echo "tmux 3.7c"; exit 0; }; exit 1',
		});

		const result = runSnapshot(dir);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, "");
		assert.doesNotMatch(result.stderr, /FLY2455_(SECRET|LOG_SECRET)_CANARY/);
		assert.match(
			result.stderr,
			/phase=topology reason=manifest_invalid label=com\.flywheel\.qa\.lead\.slot-2\.flywheel-test-2/,
		);

		const evidence = join(runtime, "topology-failure.json");
		assert.equal(statSync(evidence).mode & 0o777, 0o600);
		const snapshot = JSON.parse(readFileSync(evidence, "utf8"));
		assert.match(snapshot.observedAt, /^2026-/);
		delete snapshot.observedAt;
		assert.deepEqual(snapshot, {
			schemaVersion: 1,
			phase: "topology",
			reason: "manifest_invalid",
			label: "com.flywheel.qa.lead.slot-2.flywheel-test-2",
			manifest,
			manifestState: "invalid",
			launchd: { state: "running", pid: 4242, lastExitCode: 9 },
			runtime: { pid: null, socketPath: null },
			probe: {
				binary: tmux,
				realpath: realpathSync(tmux),
				version: "tmux 3.7c",
				exitCode: null,
				kind: "unknown",
				socketExists: null,
			},
			body: { state: "unknown", exitCode: null },
			checks: ["manifest_invalid"],
			observationKind: "post_failure_reprobe",
			lastLoopObservation: {
				launchPid: 4242,
				manifestPid: 4242,
				socketPath: "/tmp/private-qa.sock",
				probeExitCode: 1,
				observedAt: "2026-09-09T04:00:00.000Z",
			},
			generationChanged: false,
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("snapshot reports the earliest stable failure and classifies probe errors", () => {
	const cases = [
		{
			name: "manifest missing",
			fixture: { manifestContent: null },
			reason: "manifest_missing",
		},
		{
			name: "runtime unpublished",
			fixture: {
				manifestContent: JSON.stringify({
					leadId: "flywheel-test-2",
					projectName: "test-slot-2",
				}),
			},
			reason: "runtime_unpublished",
		},
		{
			name: "plist mismatch",
			fixture: { plistLabel: "com.flywheel.qa.lead.slot-2.wrong" },
			reason: "plist_mismatch",
		},
		{
			name: "job missing",
			fixture: {
				launchctlBody: 'echo "Could not find service" >&2; exit 113',
			},
			reason: "launchd_job_missing",
		},
		{
			name: "launchd probe unavailable",
			fixture: {
				launchctlBody: 'echo "Operation not permitted" >&2; exit 1',
			},
			reason: "probe_unavailable",
		},
		{
			name: "launchd pid missing",
			fixture: { launchctlBody: 'printf "state = waiting\\n"' },
			reason: "launchd_pid_missing",
		},
		{
			name: "pid mismatch",
			fixture: { launchctlBody: 'printf "state = running\\npid = 5555\\n"' },
			reason: "pid_mismatch",
		},
		{
			name: "protocol mismatch",
			fixture: {
				tmuxBody:
					'test "$1" = "-V" && { echo "tmux 3.7c"; exit 0; }; echo "protocol version mismatch (client 9, server 8)" >&2; exit 1',
			},
			reason: "session_probe_failed",
			probeKind: "protocol_mismatch",
		},
		{
			name: "socket unavailable",
			fixture: {
				tmuxBody:
					'test "$1" = "-V" && { echo "tmux 3.7c"; exit 0; }; echo "no server running on /tmp/redacted" >&2; exit 1',
			},
			reason: "session_probe_failed",
			probeKind: "socket_unavailable",
		},
		{
			name: "session missing",
			fixture: {
				tmuxBody:
					'test "$1" = "-V" && { echo "tmux 3.7c"; exit 0; }; echo "can\'t find session: main" >&2; exit 1',
			},
			reason: "session_probe_failed",
			probeKind: "session_missing",
		},
		{
			name: "tmux probe unavailable",
			fixture: { tmuxBody: 'echo "broken client" >&2; exit 70' },
			reason: "probe_unavailable",
			probeKind: "probe_unavailable",
		},
	];

	for (const item of cases) {
		const dir = mkdtempSync(join(tmpdir(), "fly2455-reason-"));
		try {
			const paths = fixture(dir, item.fixture);
			const result = runSnapshot(dir, paths);
			assert.equal(result.status, 0, `${item.name}: ${result.stderr}`);
			assert.equal(result.stdout, "", item.name);
			const snapshot = JSON.parse(
				readFileSync(join(paths.runtime, "topology-failure.json"), "utf8"),
			);
			assert.equal(snapshot.reason, item.reason, item.name);
			assert.ok(snapshot.checks.includes(item.reason), item.name);
			if (item.probeKind) {
				assert.equal(snapshot.probe.kind, item.probeKind, item.name);
			}
			assert.doesNotMatch(
				result.stderr,
				/Operation not permitted|broken client/,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

test("snapshot refuses control-character paths and an evidence-target symlink", () => {
	const dir = mkdtempSync(join(tmpdir(), "fly2455-path-"));
	try {
		const paths = fixture(dir);
		const newline = runSnapshot(dir, {
			...paths,
			manifest: `${paths.manifest}\nFLY2455_PATH_CANARY`,
		});
		assert.notEqual(newline.status, 0);
		assert.match(newline.stderr, /diagnostic_write_failed/);
		assert.doesNotMatch(newline.stderr, /FLY2455_PATH_CANARY/);

		const outside = join(dir, "outside-secret");
		writeFileSync(outside, "FLY2455_OUTSIDE_CANARY\n", { mode: 0o600 });
		symlinkSync(outside, join(paths.runtime, "topology-failure.json"));
		const symlink = runSnapshot(dir, paths);
		assert.notEqual(symlink.status, 0);
		assert.match(symlink.stderr, /diagnostic_write_failed/);
		assert.equal(readFileSync(outside, "utf8"), "FLY2455_OUTSIDE_CANARY\n");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("body evidence is path-bound, generation-bound, capped, merged, and safely discarded", () => {
	const { slotRoot, runtime, manifest } = qaRuntime();
	try {
		const tmux = join(slotRoot, "tmux");
		executable(
			tmux,
			'test "$1" = "-V" && { echo "tmux 3.7c"; exit 0; }; exit 64',
		);
		let result = runHelper([
			"validate-runtime",
			"--runtime",
			runtime,
			"--manifest",
			manifest,
			"--lead-id",
			"ops-lead",
		]);
		assert.equal(result.status, 0, result.stderr);

		result = runHelper([
			"body-status",
			"--runtime",
			runtime,
			"--event",
			"carrier",
			"--carrier-pid",
			"4242",
			"--tmux",
			tmux,
		]);
		assert.equal(result.status, 0, result.stderr);
		result = runHelper([
			"body-status",
			"--runtime",
			runtime,
			"--event",
			"started",
			"--carrier-pid",
			"4242",
			"--body-pid",
			"4343",
		]);
		assert.equal(result.status, 0, result.stderr);

		const input = `FLY2455_BODY_FAILURE_CANARY\n${"x".repeat(300 * 1024)}`;
		result = runHelper(
			["record", "--runtime", runtime, "--carrier-pid", "4242"],
			{ input },
		);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, "");
		const output = readFileSync(join(runtime, "body-output.log"), "utf8");
		assert.match(output, /FLY2455_BODY_FAILURE_CANARY/);
		assert.ok(Buffer.byteLength(output) <= 256 * 1024);
		assert.equal(
			statSync(join(runtime, "body-output.log")).mode & 0o777,
			0o600,
		);
		assert.equal(existsSync(join(runtime, "body-output.truncated")), true);

		result = runHelper([
			"body-status",
			"--runtime",
			runtime,
			"--event",
			"pre-server-stop",
			"--carrier-pid",
			"4242",
			"--exit-code",
			"42",
			"--claude-exit-code",
			"42",
		]);
		assert.equal(result.status, 0, result.stderr);
		result = runHelper([
			"body-status",
			"--runtime",
			runtime,
			"--event",
			"shell-exit",
			"--carrier-pid",
			"4242",
			"--exit-code",
			"42",
		]);
		assert.equal(result.status, 0, result.stderr);

		const status = JSON.parse(
			readFileSync(join(runtime, "body-status.json"), "utf8"),
		);
		assert.equal(status.schemaVersion, 1);
		assert.equal(status.carrierPid, 4242);
		assert.equal(status.bodyPid, 4343);
		assert.equal(status.carrierTmux.binary, tmux);
		assert.equal(status.carrierTmux.realpath, realpathSync(tmux));
		assert.equal(status.carrierTmux.version, "tmux 3.7c");
		assert.equal(typeof status.carrierTmux.architecture, "string");
		assert.match(status.startedAt, /^2026-/);
		assert.match(status.endedAt, /^2026-/);
		assert.equal(status.exitCode, 42);
		assert.equal(status.exitObservation, "pre_server_stop");
		assert.equal(status.claudeExitCode, 42);
		assert.equal(status.observedShellExitCode, 42);

		result = runHelper([
			"body-status",
			"--runtime",
			runtime,
			"--event",
			"shell-exit",
			"--carrier-pid",
			"9999",
			"--exit-code",
			"0",
		]);
		assert.notEqual(result.status, 0);
		assert.equal(
			JSON.parse(readFileSync(join(runtime, "body-status.json"), "utf8"))
				.exitCode,
			42,
		);

		result = runHelper(["discard", "--runtime", runtime]);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(existsSync(join(runtime, "body-output.log")), false);
		assert.equal(existsSync(join(runtime, "body-output.truncated")), false);
	} finally {
		rmSync(slotRoot, { recursive: true, force: true });
	}
});

test("failure snapshots reference body conclusions only for the current carrier generation", () => {
	const dir = mkdtempSync(join(tmpdir(), "fly2455-body-generation-"));
	try {
		const paths = fixture(dir);
		writeFileSync(
			join(paths.runtime, "body-status.json"),
			JSON.stringify({
				schemaVersion: 1,
				carrierPid: 4242,
				bodyPid: 4343,
				startedAt: "2026-09-09T05:00:00.000Z",
				endedAt: "2026-09-09T05:00:01.000Z",
				exitCode: 42,
				exitObservation: "pre_server_stop",
				claudeExitCode: 42,
				observedShellExitCode: 42,
			}),
			{ mode: 0o600 },
		);
		let result = runSnapshot(dir, paths);
		assert.equal(result.status, 0, result.stderr);
		let snapshot = JSON.parse(
			readFileSync(join(paths.runtime, "topology-failure.json"), "utf8"),
		);
		assert.deepEqual(snapshot.body, {
			state: "exited",
			carrierPid: 4242,
			bodyPid: 4343,
			exitCode: 42,
			exitObservation: "pre_server_stop",
			claudeExitCode: 42,
			observedShellExitCode: 42,
		});

		const stale = JSON.parse(
			readFileSync(join(paths.runtime, "body-status.json"), "utf8"),
		);
		stale.carrierPid = 9999;
		writeFileSync(
			join(paths.runtime, "body-status.json"),
			JSON.stringify(stale),
		);
		result = runSnapshot(dir, paths);
		assert.equal(result.status, 0, result.stderr);
		snapshot = JSON.parse(
			readFileSync(join(paths.runtime, "topology-failure.json"), "utf8"),
		);
		assert.deepEqual(snapshot.body, { state: "stale", exitCode: null });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runtime validation rejects unsafe ownership and discard refuses a live recorder", async () => {
	const { slotRoot, runtime, manifest } = qaRuntime();
	try {
		chmodSync(runtime, 0o755);
		let result = runHelper([
			"validate-runtime",
			"--runtime",
			runtime,
			"--manifest",
			manifest,
		]);
		assert.notEqual(result.status, 0);
		chmodSync(runtime, 0o700);

		writeFileSync(
			manifest,
			JSON.stringify({ leadId: "foreign-lead", projectName: "test-slot-1" }),
		);
		result = runHelper([
			"validate-runtime",
			"--runtime",
			runtime,
			"--manifest",
			manifest,
		]);
		assert.notEqual(result.status, 0);
		writeFileSync(
			manifest,
			JSON.stringify({ leadId: "ops-lead", projectName: "test-slot-1" }),
		);

		const recorder = spawn(
			"python3",
			[helper, "record", "--runtime", runtime, "--carrier-pid", "4242"],
			{ cwd: root, stdio: ["pipe", "pipe", "pipe"] },
		);
		recorder.stdin.write("FLY2455_LIVE_RECORDER_CANARY\n");
		for (let attempt = 0; attempt < 100; attempt += 1) {
			if (existsSync(join(runtime, "body-recorder.json"))) break;
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
		}
		result = runHelper(["discard", "--runtime", runtime]);
		assert.notEqual(result.status, 0);
		assert.equal(existsSync(join(runtime, "body-output.log")), true);
		recorder.stdin.end();
		const recorderStatus = await new Promise((resolvePromise) =>
			recorder.once("close", resolvePromise),
		);
		assert.equal(recorderStatus, 0);
		result = runHelper(["discard", "--runtime", runtime]);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(existsSync(join(runtime, "body-output.log")), false);
	} finally {
		rmSync(slotRoot, { recursive: true, force: true });
	}
});

test("discard fails closed when recorder completion cannot be verified", () => {
	const { slotRoot, runtime } = qaRuntime();
	try {
		writeFileSync(
			join(runtime, "body-output.log"),
			"FLY2455_UNVERIFIED_CANARY\n",
			{
				mode: 0o600,
			},
		);
		writeFileSync(
			join(runtime, "body-recorder.json"),
			JSON.stringify({ schemaVersion: 1, active: false }),
			{ mode: 0o600 },
		);

		const result = runHelper(["discard", "--runtime", runtime]);
		assert.notEqual(result.status, 0);
		assert.equal(
			readFileSync(join(runtime, "body-output.log"), "utf8"),
			"FLY2455_UNVERIFIED_CANARY\n",
		);
	} finally {
		rmSync(slotRoot, { recursive: true, force: true });
	}
});

test("snapshot bounds missing and timed-out tools as probe_unavailable", () => {
	for (const mode of ["missing", "timeout"]) {
		const dir = mkdtempSync(join(tmpdir(), "fly2455-tool-"));
		try {
			const paths = fixture(dir, {
				manifestContent: JSON.stringify({
					leadId: "flywheel-test-2",
					projectName: "test-slot-2",
					pid: 4242,
					socketPath: "/tmp/private-qa.sock",
					launchEnvironment: {
						DISCORD_BOT_TOKEN: "FLY2455_CREDENTIAL_CANARY",
					},
				}),
				launchctlBody:
					mode === "timeout"
						? "exec /bin/sleep 5"
						: 'printf "state = running\\npid = 4242\\n"',
			});
			if (mode === "missing") rmSync(paths.launchctl);
			const started = Date.now();
			const result = runSnapshot(dir, paths);
			const elapsed = Date.now() - started;
			assert.equal(result.status, 0, `${mode}: ${result.stderr}`);
			assert.ok(elapsed < 4_000, `${mode} probe took ${elapsed}ms`);
			const snapshot = JSON.parse(
				readFileSync(join(paths.runtime, "topology-failure.json"), "utf8"),
			);
			assert.equal(snapshot.reason, "probe_unavailable", mode);
			assert.equal(snapshot.launchd.state, "unknown", mode);
			assert.doesNotMatch(
				`${result.stdout}${result.stderr}${JSON.stringify(snapshot)}`,
				/FLY2455_CREDENTIAL_CANARY/,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

test("probe deadline includes inherited pipes after the direct child exits", () => {
	const result = spawnSync(
		"python3",
		[
			"-c",
			`import importlib.util, json, sys, time
spec = importlib.util.spec_from_file_location("diagnostics", sys.argv[1])
diagnostics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostics)
started = time.monotonic()
result = diagnostics.run_probe([
    sys.executable, "-c",
    "import subprocess,sys; subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(4)']); print('parent-exited')"
])
print(json.dumps({"elapsed": time.monotonic() - started, "unavailable": result is None}))
`,
			helper,
		],
		{ encoding: "utf8", timeout: 8_000 },
	);
	assert.equal(result.status, 0, result.stderr);
	const receipt = JSON.parse(result.stdout);
	assert.equal(receipt.unavailable, true);
	assert.ok(receipt.elapsed < 3, JSON.stringify(receipt));
});
