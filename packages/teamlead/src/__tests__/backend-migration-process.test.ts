import { beforeEach, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

import { execFile } from "node:child_process";
import {
	MigrationCarrierAbsentError,
	observeMigrationCarrier,
} from "../bin/backend-migration-process.js";

type Callback = (error: Error | null, stdout: string, stderr: string) => void;
const mock = vi.mocked(execFile);
const output = {
	launch: "state = running\npid = 123\n",
	start: "Fri Sep 11 01:00:00 2026",
	command:
		"node /root/packages/teamlead/dist/lead-backends/codex/codex-lead-tui-runtime.js",
};
beforeEach(() => {
	vi.resetAllMocks();
	output.launch = "state = running\npid = 123\n";
	mock.mockImplementation(((
		file: string,
		args: string[],
		_opts: unknown,
		callback: Callback,
	) => {
		callback(
			null,
			file === "/bin/launchctl"
				? output.launch
				: args.includes("lstart=")
					? output.start
					: output.command,
			"",
		);
		return {};
	}) as never);
});
it("reads the fixed label twice and returns the observed process tuple", async () => {
	expect(await observeMigrationCarrier(501)).toEqual({
		pid: 123,
		start: output.start,
		command: output.command,
	});
	expect(
		mock.mock.calls.filter((c) => c[0] === "/bin/launchctl").map((c) => c[1]),
	).toEqual(
		Array(2).fill([
			"print",
			"gui/501/com.flywheel.lead.flywheel-flywheel-product-lead",
		]),
	);
});
it.each([
	"pid = 123\n",
	"state = running\npid = 0\n",
	"state = running\npid = 123\npid = 456\n",
])("rejects ambiguous launchd evidence", async (launch) => {
	output.launch = launch;
	await expect(observeMigrationCarrier(501)).rejects.toThrow(
		"migration carrier unproven",
	);
});
it("rejects a launchd replacement between process probes", async () => {
	let reads = 0;
	mock.mockImplementation(((
		file: string,
		args: string[],
		_opts: unknown,
		callback: Callback,
	) => {
		callback(
			null,
			file === "/bin/launchctl"
				? `state = running\npid = ${++reads === 1 ? 123 : 456}\n`
				: args.includes("lstart=")
					? output.start
					: output.command,
			"",
		);
		return {};
	}) as never);
	await expect(observeMigrationCarrier(501)).rejects.toThrow(
		"migration carrier changed",
	);
});
it("fails closed on sensor failure without returning diagnostic output", async () => {
	mock.mockImplementation(((
		_f: unknown,
		_a: unknown,
		_o: unknown,
		cb: Callback,
	) => {
		cb(Error("secret diagnostic"), "", "");
		return {};
	}) as never);
	await expect(observeMigrationCarrier(501)).rejects.toThrow(
		/^migration carrier probe failed$/,
	);
});
it.each(["lstart=", "command="])(
	"rejects changed %s even when launchd keeps the same pid",
	async (field) => {
		let reads = 0;
		mock.mockImplementation(((
			file: string,
			args: string[],
			_opts: unknown,
			callback: Callback,
		) => {
			const normal =
				file === "/bin/launchctl"
					? output.launch
					: args.includes("lstart=")
						? output.start
						: output.command;
			callback(
				null,
				args.includes(field) && ++reads === 2 ? "replacement" : normal,
				"",
			);
			return {};
		}) as never);
		await expect(observeMigrationCarrier(501)).rejects.toThrow(
			"migration carrier changed",
		);
	},
);
it("distinguishes a confirmed missing job from a failed process sensor", async () => {
	mock.mockImplementation(((
		_f: unknown,
		_a: unknown,
		_o: unknown,
		cb: Callback,
	) => {
		cb(
			Object.assign(Error("launchctl exit"), { code: 113 }),
			"",
			"Could not find service",
		);
		return {};
	}) as never);
	await expect(observeMigrationCarrier(501)).rejects.toBeInstanceOf(
		MigrationCarrierAbsentError,
	);
});
