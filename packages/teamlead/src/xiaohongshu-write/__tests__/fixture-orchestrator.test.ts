import { beforeEach, expect, it, vi } from "vitest";
import { runInstallerFixture } from "../fixture-orchestrator.js";

const f = vi.hoisted(() => ({
	uid: 0,
	failPin: false,
	failChild: false,
	stderr: "",
	stdout: "{}",
	failReadAt: 0,
	reads: [] as string[],
	calls: [] as unknown[][],
	provisions: 0,
}));
vi.mock("../trusted-files.js", () => ({
	readImmutableFile: (path: string) => {
		f.reads.push(path);
		if (f.failPin || f.reads.length === f.failReadAt) throw Error();
		return Buffer.from("pinned");
	},
}));
vi.mock("../fixture-provision.js", () => ({
	provisionBoundaryFixture: () => {
		f.provisions++;
		return {
			root: `/private/var/db/flywheel-xhs-qa/${"a".repeat(64)}`,
			markerSha256: "e".repeat(64),
			state: { dev: 1, ino: 2 },
		};
	},
}));
vi.mock("../fixture-evidence.js", () => ({
	collectFixtureEvidence: async (
		expected: unknown,
		run: (role: string, probe: string) => Promise<string>,
	) => {
		const outputs = [];
		for (const [role, probe] of [
			["service", "file-control"],
			["model", "file-authority"],
			["service", "file-control"],
			["service", "authority-flow"],
		])
			outputs.push(await run(role!, probe!));
		return { expected, outputs, hostAcceptance: false };
	},
}));
vi.mock("node:child_process", () => ({
	execFile: (
		path: string,
		args: string[],
		options: unknown,
		callback: (error: Error | null, stdout: string, stderr: string) => void,
	) => {
		f.calls.push([path, args, options]);
		callback(f.failChild ? Error("failed") : null, f.stdout, f.stderr);
	},
}));
const pin = (name: string) => ({
	path: `/Library/Application Support/Flywheel/Xhs/${name}`,
	sha256: "b".repeat(64),
});
const input = {
	serviceUid: 450,
	serviceGid: 450,
	modelUid: 501,
	modelGid: 20,
	nonce: "a".repeat(64),
	node: pin("node"),
	boundaryProbe: pin("probe.js"),
	peerHelper: pin("peer"),
	principalRunner: pin("runner"),
};
beforeEach(() => {
	f.uid = 0;
	f.failPin = false;
	f.failChild = false;
	f.stdout = "{}";
	f.stderr = "";
	f.failReadAt = 0;
	f.reads = [];
	f.calls = [];
	f.provisions = 0;
	vi.spyOn(process, "getuid").mockImplementation(() => f.uid);
	vi.spyOn(process, "geteuid").mockImplementation(() => f.uid);
});
it("runs measured children directly with only role/probe argv and reservation-bound expectations", async () => {
	const result = await runInstallerFixture(input);
	expect(result).toMatchObject({
		hostAcceptance: false,
		expected: {
			fixture: { markerSha256: "e".repeat(64), state: { dev: 1, ino: 2 } },
		},
	});
	expect(f.provisions).toBe(1);
	expect(f.calls).toHaveLength(4);
	for (const call of f.calls) {
		expect(call[0]).toBe(input.principalRunner.path);
		expect(call[1]).toHaveLength(2);
		expect(call[2]).toMatchObject({
			cwd: "/",
			shell: false,
			maxBuffer: 131072,
			timeout: 120000,
			env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
		});
	}
	expect(
		f.reads.filter((path) => path === input.principalRunner.path),
	).toHaveLength(5);
});
it.each(["unprivileged", "bad-pin", "invalid-runner"])(
	"rejects %s before provisioning or child execution",
	async (mode) => {
		if (mode === "unprivileged") f.uid = 501;
		if (mode === "bad-pin") f.failPin = true;
		await expect(
			runInstallerFixture({
				...input,
				principalRunner:
					mode === "invalid-runner" ? pin("../runner") : input.principalRunner,
			}),
		).rejects.toThrow("fixture_orchestration_unavailable");
		expect(f.provisions).toBe(0);
		expect(f.calls).toEqual([]);
	},
);
it("stops on child failure without retrying the reserved fixture", async () => {
	f.failChild = true;
	await expect(runInstallerFixture(input)).rejects.toThrow(
		"fixture_orchestration_unavailable",
	);
	expect(f.calls).toHaveLength(1);
	expect(f.provisions).toBe(1);
});

it("remeasures pins before the next child and retains the reservation on mismatch", async () => {
	f.failReadAt = 9;
	await expect(runInstallerFixture(input)).rejects.toThrow(
		"fixture_orchestration_unavailable",
	);
	expect(f.provisions).toBe(1);
	expect(f.calls).toHaveLength(1);
});
it.each(["stderr", "oversize"])("rejects %s child output", async (mode) => {
	if (mode === "stderr") f.stderr = "unexpected diagnostics";
	else f.stdout = "a".repeat(131073);
	await expect(runInstallerFixture(input)).rejects.toThrow(
		"fixture_orchestration_unavailable",
	);
	expect(f.calls).toHaveLength(1);
});
