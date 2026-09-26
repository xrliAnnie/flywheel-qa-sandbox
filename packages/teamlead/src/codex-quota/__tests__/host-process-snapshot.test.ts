import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
	type CodexProcessSnapshot,
	captureCodexProcessSnapshot,
	parseCodexProcessSnapshot,
} from "../host-process-snapshot.js";

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

describe("FLY-2869 — Codex process classification by kernel executable name", () => {
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
				argv: ["/bin/codex", "app-server", "--listen"],
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

	// The collector runs only on the macOS host and uses BSD ps flags
	// (-E = environment); Linux procps rejects them outright.
	it.skipIf(process.platform !== "darwin")(
		"captures the launch environment only in the authoritative snapshot (real ps)",
		async () => {
			const marker = `FLY2869_MARKER=${process.pid}x${Date.now()}`;
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
});
