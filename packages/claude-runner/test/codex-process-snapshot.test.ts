/**
 * FLY-2877 T0 — the lease guard's process authority.
 *
 * The first block mirrors FLY-2869's `host-process-snapshot` fixtures row by
 * row (copied, not re-derived): the guard must call a process "codex" exactly
 * when the readiness collector does, or a lease could be kept for a process the
 * collector never counts (or dropped for one it does). The second block covers
 * this package's thin holder layer on top of it.
 */
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
	type CodexProcessSnapshot,
	captureCodexProcessSnapshot,
	defaultCodexLeaseHolderProbe,
	holdersFromSnapshot,
	parseCodexProcessSnapshot,
} from "../src/codex-process-snapshot.js";

const LSTART = "Thu Sep 25 01:00:00 2026";
const argsLine = (pid: number, command: string, lstart = LSTART) =>
	`${String(pid).padStart(5)} ${lstart}     ${command}`;
const authLine = (
	pid: number,
	ucomm: string,
	command: string,
	lstart = LSTART,
	stat = "Ss",
) =>
	`${String(pid).padStart(5)} ${lstart} ${stat.padEnd(4)} ${ucomm.padEnd(16)} ${command}`;

function snapshot(
	rows: Array<{
		pid: number;
		ucomm: string;
		args: string;
		env?: string;
		argsAfter?: string;
		lstart?: string;
	}>,
): CodexProcessSnapshot {
	return {
		argsBefore: rows
			.map((row) => argsLine(row.pid, row.args, row.lstart))
			.join("\n"),
		authoritative: rows
			.map((row) =>
				authLine(
					row.pid,
					row.ucomm,
					row.env ? `${row.args} ${row.env}` : row.args,
					row.lstart,
				),
			)
			.join("\n"),
		argsAfter: rows
			.map((row) => argsLine(row.pid, row.argsAfter ?? row.args, row.lstart))
			.join("\n"),
	};
}

describe("FLY-2869 contract (mirrored) — Codex process classification by kernel executable name", () => {
	it("reads CODEX_HOME, HOME and FLYWHEEL_EXEC_ID only from the environment suffix", () => {
		const parsed = parseCodexProcessSnapshot(
			snapshot([
				{
					pid: 12,
					ucomm: "codex",
					args: "/bin/codex app-server --listen",
					env: "CODEX_HOME=/homes/a HOME=/Users/u FLYWHEEL_EXEC_ID=exec-1",
				},
			]),
		);
		expect(parsed.unattributed).toEqual([]);
		expect(parsed.codex).toEqual([
			{
				pid: 12,
				startIdentity: LSTART,
				argv0: "/bin/codex",
				codexHome: "/homes/a",
				home: "/Users/u",
				executionId: "exec-1",
			},
		]);
	});

	it.each([
		{
			name: "a Claude runner whose XDG_CACHE_HOME ends in /codex",
			row: {
				pid: 20,
				ucomm: "2.1.282",
				args: "claude --agent-id runner",
				env: "XDG_CACHE_HOME=/Users/u/.cache/codex HOME=/Users/u",
			},
		},
		{
			name: "a zsh whose environment mentions codex",
			row: {
				pid: 21,
				ucomm: "zsh",
				args: "/bin/zsh -lc run",
				env: "SCRUBCMD=env -u X codex HOME=/Users/u",
			},
		},
		{
			name: "a node script with codex in its arguments",
			row: {
				pid: 22,
				ucomm: "node",
				args: "node /repo/scripts/run.mjs codex --review",
				env: "HOME=/Users/u",
			},
		},
	])("never classifies $name as codex", ({ row }) => {
		expect(parseCodexProcessSnapshot(snapshot([row]))).toEqual({
			codex: [],
			unattributed: [],
		});
	});

	it.each([
		{
			name: "codex that appears only in the authoritative snapshot",
			build: () => {
				const base = snapshot([
					{
						pid: 30,
						ucomm: "codex",
						args: "/bin/codex exec",
						env: "CODEX_HOME=/h",
					},
				]);
				return { ...base, argsBefore: argsLine(1, "/sbin/launchd") };
			},
		},
		{
			name: "argv that changed between the two args snapshots (exec, same pid)",
			build: () =>
				snapshot([
					{
						pid: 31,
						ucomm: "codex",
						args: "/bin/codex app-server",
						argsAfter: "/bin/codex app-server CODEX_HOME=/approved",
						env: "HOME=/Users/u",
					},
				]),
		},
		{
			name: "an authoritative command that does not start with the stable argv",
			build: () => {
				const base = snapshot([
					{
						pid: 32,
						ucomm: "codex",
						args: "/bin/codex exec",
						env: "CODEX_HOME=/h",
					},
				]);
				return {
					...base,
					authoritative: authLine(
						32,
						"codex",
						"/other/codex exec CODEX_HOME=/h",
					),
				};
			},
		},
		{
			name: "a duplicated CODEX_HOME in the environment",
			build: () =>
				snapshot([
					{
						pid: 33,
						ucomm: "codex",
						args: "/bin/codex exec",
						env: "CODEX_HOME=/a FAKE=x CODEX_HOME=/b",
					},
				]),
		},
		{
			name: "a duplicated HOME in the environment",
			build: () =>
				snapshot([
					{
						pid: 34,
						ucomm: "codex",
						args: "/bin/codex exec",
						env: "HOME=/Users/u X=y HOME=/tmp/evil",
					},
				]),
		},
		{
			name: "a duplicated FLYWHEEL_EXEC_ID in the environment",
			build: () =>
				snapshot([
					{
						pid: 35,
						ucomm: "codex",
						args: "/bin/codex exec",
						env: "CODEX_HOME=/h FLYWHEEL_EXEC_ID=a FLYWHEEL_EXEC_ID=b",
					},
				]),
		},
	])("fails closed on $name", ({ build }) => {
		const parsed = parseCodexProcessSnapshot(build());
		expect(parsed.codex).toEqual([]);
		expect(parsed.unattributed).toHaveLength(1);
		expect(parsed.unattributed[0]).toMatchObject({
			reason: "process_home_unknown",
		});
	});

	it("strips argv tokens that look like environment assignments", () => {
		const parsed = parseCodexProcessSnapshot(
			snapshot([
				{
					pid: 40,
					ucomm: "codex",
					args: "/bin/codex exec CODEX_HOME=/fake FLYWHEEL_EXEC_ID=fake",
					env: "HOME=/Users/u",
				},
			]),
		);
		expect(parsed.codex).toEqual([
			expect.objectContaining({
				codexHome: null,
				executionId: null,
				home: "/Users/u",
			}),
		]);
	});

	it("rejects unparsable, empty or oversized snapshots", () => {
		const ok = snapshot([{ pid: 1, ucomm: "launchd", args: "/sbin/launchd" }]);
		for (const broken of [
			{ ...ok, argsBefore: "" },
			{ ...ok, authoritative: "not a ps line" },
			{ ...ok, argsAfter: "x".repeat(16 * 1024 * 1024 + 1) },
		])
			expect(() => parseCodexProcessSnapshot(broken)).toThrow(
				"process_authority_invalid",
			);
	});

	it("ignores a zombie codex: it has exited and holds nothing", () => {
		const zombie = {
			argsBefore: argsLine(50, "<defunct>"),
			authoritative: authLine(50, "codex", "<defunct>", LSTART, "Z"),
			argsAfter: argsLine(50, "<defunct>"),
		};
		expect(parseCodexProcessSnapshot(zombie)).toEqual({
			codex: [],
			unattributed: [],
		});
	});

	it.runIf(process.platform === "darwin")(
		"captures the launch environment only in the authoritative snapshot (real ps)",
		async () => {
			const marker = `FLY2877_MARKER=${process.pid}x${Date.now()}`;
			// A non-platform binary: macOS does not expose system binaries' environment.
			const child = spawn(
				process.execPath,
				["-e", "setTimeout(() => {}, 5000)"],
				{
					env: {
						PATH: "/usr/bin:/bin",
						[marker.split("=")[0]!]: marker.split("=")[1]!,
					},
					stdio: "ignore",
				},
			);
			child.unref();
			const pid = child.pid!;
			const snapshot = await captureCodexProcessSnapshot();
			const line = (text: string) =>
				text.split("\n").find((row) => row.trim().startsWith(`${pid} `)) ?? "";
			expect(line(snapshot.authoritative)).toContain(marker);
			expect(line(snapshot.authoritative)).toContain(
				`${process.execPath} -e setTimeout(() => {}, 5000) `,
			);
			expect(line(snapshot.argsBefore)).not.toContain(marker);
			expect(line(snapshot.argsAfter)).not.toContain(marker);
		},
	);

	it.each([
		{
			name: "a duplicated authoritative row",
			build: () => {
				const base = snapshot([
					{
						pid: 60,
						ucomm: "codex",
						args: "/bin/codex exec",
						env: "CODEX_HOME=/h",
					},
				]);
				return {
					...base,
					authoritative: `${base.authoritative}\n${base.authoritative}`,
				};
			},
		},
		{
			name: "a duplicated args row attached to a Codex process",
			build: () => {
				const base = snapshot([
					{
						pid: 61,
						ucomm: "codex",
						args: "/bin/codex exec",
						env: "CODEX_HOME=/h",
					},
				]);
				return {
					...base,
					argsBefore: `${base.argsBefore}\n${base.argsBefore}`,
				};
			},
		},
		{
			name: "a duplicated args row of an unrelated process",
			build: () => {
				const base = snapshot([
					{ pid: 62, ucomm: "zsh", args: "/bin/zsh" },
					{
						pid: 63,
						ucomm: "codex",
						args: "/bin/codex exec",
						env: "CODEX_HOME=/h",
					},
				]);
				return {
					...base,
					argsAfter: `${base.argsAfter}\n${argsLine(62, "/bin/zsh")}`,
				};
			},
		},
	])("rejects the whole snapshot on $name", ({ build }) => {
		expect(() => parseCodexProcessSnapshot(build())).toThrow(
			"process_authority_invalid",
		);
	});

	// The FLY-2869 source rejects a malformed execution id; its suite has no
	// fixture for that branch, so this one is added rather than mirrored.
	it("fails closed on an execution id outside the safe alphabet", () => {
		const parsed = parseCodexProcessSnapshot(
			snapshot([
				{
					pid: 70,
					ucomm: "codex",
					args: "/bin/codex exec",
					env: "CODEX_HOME=/h FLYWHEEL_EXEC_ID=a/../b",
				},
			]),
		);
		expect(parsed.codex).toEqual([]);
		expect(parsed.unattributed).toEqual([
			expect.objectContaining({ pid: 70, reason: "process_home_unknown" }),
		]);
	});
});

describe("FLY-2877 lease holders on top of the process authority", () => {
	const HOME = "/Users/u/.flywheel/codex-homes/agents/flywheel/implement";
	const EXEC = "37624e3d-0000-4000-8000-000000000001";
	const daemonAndTui = (execId = EXEC, home = HOME) => [
		{
			pid: 86434,
			ucomm: "codex",
			args: "/opt/codex/bin/codex app-server --listen unix:///tmp/s.sock",
			env: `CODEX_HOME=${home} HOME=/Users/u FLYWHEEL_EXEC_ID=${execId}`,
		},
		{
			pid: 44535,
			ucomm: "codex",
			args: "/Users/u/.local/bin/codex resume --remote unix:///tmp/s.sock",
			env: `CODEX_HOME=${home} HOME=/Users/u FLYWHEEL_EXEC_ID=${execId}`,
		},
	];

	it("counts both the daemon and its TUI client as holders of one execution", () => {
		expect(holdersFromSnapshot(snapshot(daemonAndTui()), HOME, EXEC)).toEqual({
			status: "ok",
			holders: [44535, 86434],
		});
	});

	it("does not count a process of another execution or another home", () => {
		const rows = [
			...daemonAndTui("b6c738ca-0000-4000-8000-000000000002"),
			{
				pid: 90001,
				ucomm: "codex",
				args: "/bin/codex app-server",
				env: `CODEX_HOME=/Users/u/.flywheel/codex-homes/agents/flywheel/qa HOME=/Users/u FLYWHEEL_EXEC_ID=${EXEC}`,
			},
		];
		expect(holdersFromSnapshot(snapshot(rows), HOME, EXEC)).toEqual({
			status: "ok",
			holders: [],
		});
	});

	it("matches a holder whose CODEX_HOME differs from the home only lexically", () => {
		expect(
			holdersFromSnapshot(snapshot(daemonAndTui(EXEC, `${HOME}/`)), HOME, EXEC),
		).toEqual({ status: "ok", holders: [44535, 86434] });
	});

	it("does not count a non-codex process that carries the same markers", () => {
		const rows = [
			{
				pid: 27128,
				ucomm: "codex-code-mode-host",
				args: "/opt/codex/bin/codex-code-mode-host",
				env: `CODEX_HOME=${HOME} FLYWHEEL_EXEC_ID=${EXEC}`,
			},
			{
				pid: 3120,
				ucomm: "node",
				args: "node flywheel-comm",
				env: `CODEX_HOME=${HOME} FLYWHEEL_EXEC_ID=${EXEC}`,
			},
		];
		expect(holdersFromSnapshot(snapshot(rows), HOME, EXEC)).toEqual({
			status: "ok",
			holders: [],
		});
	});

	it("is unknown while any codex process is unattributed, even an unrelated one", () => {
		const rows = [
			...daemonAndTui(),
			{
				pid: 91,
				ucomm: "codex",
				args: "/bin/codex exec",
				env: "CODEX_HOME=/a CODEX_HOME=/b",
			},
		];
		expect(holdersFromSnapshot(snapshot(rows), HOME, EXEC)).toEqual({
			status: "unknown",
			reason: "unattributed_present",
		});
	});

	it("is unknown on an invalid snapshot and never echoes snapshot text", () => {
		const result = holdersFromSnapshot(
			{
				argsBefore: "",
				authoritative: "secret-token-in-command",
				argsAfter: "",
			},
			HOME,
			EXEC,
		);
		expect(result).toEqual({
			status: "unknown",
			reason: "process_authority_invalid",
		});
		expect(JSON.stringify(result)).not.toContain("secret");
	});

	it("reports probe_failed when capture cannot finish inside the deadline", async () => {
		await expect(
			defaultCodexLeaseHolderProbe(HOME, EXEC, { deadlineMs: 0 }),
		).resolves.toEqual({ status: "unknown", reason: "probe_failed" });
	});

	it("refuses to start a capture with no time left", async () => {
		await expect(captureCodexProcessSnapshot(0)).rejects.toThrow(
			"process_probe_deadline",
		);
	});
});
