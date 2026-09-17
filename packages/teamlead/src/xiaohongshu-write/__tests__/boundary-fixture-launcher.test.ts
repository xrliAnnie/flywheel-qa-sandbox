import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runBoundaryFixtureHarness } from "../boundary-fixture-launcher.js";

const state = vi.hoisted(() => ({
	root: "",
	serviceUid: 0,
	calls: 0,
	failAt: -1,
	pinBad: false,
	sockets: [] as Array<string | undefined>,
}));
vi.mock("../boundary-file-probe.js", () => ({
	loadBoundaryFixture: () => ({
		root: state.root,
		nonce: "a".repeat(64),
		serviceUid: state.serviceUid,
		modelUid: 999,
		markerSha256: "b".repeat(64),
		stateIdentity: { dev: 1, ino: 2 },
	}),
}));
vi.mock("../boundary-file-control.js", () => ({
	probeFileControl: () => ({
		probe: "file-control",
		nonce: "a".repeat(64),
		files: [],
	}),
}));
vi.mock("../trusted-files.js", () => ({
	readImmutableFile: () => {
		if (state.pinBad) throw Error("pin");
		return Buffer.from("fixed-helper");
	},
}));
vi.mock("../boundary-fixture-flow.js", () => ({
	runSyntheticAuthorityCase: async (
		_root: string,
		_pin: unknown,
		index: number,
		socketPath?: string,
	) => {
		state.calls++;
		state.sockets.push(socketPath);
		if (index === state.failAt) throw Error("scenario-failed");
		return {
			caseIndex: index,
			commits: 1,
			replayedCommits: 1,
			probeKind: "fixture_harness",
			uid: process.getuid!(),
		};
	},
}));
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function setup() {
	const root = realpathSync(mkdtempSync("/tmp/xhs-launcher-test-"));
	roots.push(root);
	mkdirSync(join(root, "runtime"), { mode: 0o700 });
	mkdirSync(join(root, "io"), { mode: 0o700 });
	Object.assign(state, {
		root,
		serviceUid: process.getuid!(),
		calls: 0,
		failAt: -1,
		pinBad: false,
		sockets: [],
	});
	return root;
}
it("runs exactly eight fixed scenarios once and retains their owned evidence directories", async () => {
	const root = setup();
	const result = await runBoundaryFixtureHarness(root);
	expect(result.scenarios).toHaveLength(8);
	expect(state.calls).toBe(8);
	expect(state.sockets).toEqual(Array(8).fill(join(root, "io", "i")));
	expect(
		readdirSync(join(root, "runtime", "run-once")).filter((n) =>
			n.startsWith("case-"),
		),
	).toHaveLength(8);
	await expect(runBoundaryFixtureHarness(root)).rejects.toThrow(
		"boundary_fixture_harness_unavailable",
	);
	expect(state.calls).toBe(8);
});
it("refuses wrong UID and unavailable immutable helper before creating a run", async () => {
	const root = setup();
	state.serviceUid++;
	await expect(runBoundaryFixtureHarness(root)).rejects.toThrow();
	expect(readdirSync(join(root, "runtime"))).toEqual([]);
	state.serviceUid = process.getuid!();
	state.pinBad = true;
	await expect(runBoundaryFixtureHarness(root)).rejects.toThrow();
	expect(readdirSync(join(root, "runtime"))).toEqual([]);
	expect(state.calls).toBe(0);
});
it("retains a partial failed run and cannot replay it", async () => {
	const root = setup();
	state.failAt = 2;
	await expect(runBoundaryFixtureHarness(root)).rejects.toThrow();
	expect(state.calls).toBe(3);
	await expect(runBoundaryFixtureHarness(root)).rejects.toThrow();
	expect(state.calls).toBe(3);
});
