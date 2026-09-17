import { constants } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import {
	loadBoundaryFixture,
	probeFileAuthority,
} from "../boundary-file-probe.js";

const fixture = vi.hoisted(() => ({
	root: `/private/var/db/flywheel-xhs-qa/${"a".repeat(64)}`,
	marker: "",
	uid: 0,
	stateUid: 450,
	errno: "EACCES",
	allow: false,
	statCalls: 0,
	replaceState: false,
}));
vi.mock("../trusted-files.js", () => ({
	readImmutableFile: vi.fn(() => {
		if (fixture.uid !== 0) throw Error("trusted_file_unavailable");
		return Buffer.from(fixture.marker);
	}),
}));
vi.mock("node:fs", async (original) => ({
	...(await original<typeof import("node:fs")>()),
	lstatSync: () => ({
		isDirectory: () => true,
		dev: 1,
		ino: fixture.replaceState && fixture.statCalls++ > 0 ? 2 : 1,
		uid: fixture.stateUid,
		mode: 0o40700,
	}),
	openSync: vi.fn(() => {
		if (fixture.allow) return 42;
		throw Object.assign(Error("denied"), { code: fixture.errno });
	}),
	closeSync: vi.fn(),
	renameSync: vi.fn(() => {
		throw Object.assign(Error("denied"), { code: fixture.errno });
	}),
	symlinkSync: vi.fn(() => {
		throw Object.assign(Error("denied"), { code: fixture.errno });
	}),
}));
const marker = () => ({
	schemaVersion: 1,
	purpose: "flywheel-xhs-synthetic-boundary",
	nonce: "a".repeat(64),
	serviceUid: 450,
	modelUid: process.getuid!(),
});
beforeEach(() => {
	fixture.marker = JSON.stringify(marker());
	fixture.uid = 0;
	fixture.stateUid = 450;
	fixture.errno = "EACCES";
	fixture.allow = false;
	fixture.statCalls = 0;
	fixture.replaceState = false;
	vi.clearAllMocks();
});
it("admits only fixed root-owned synthetic fixture layout", () => {
	expect(loadBoundaryFixture(fixture.root).serviceUid).toBe(450);
	for (const root of [
		"/var/db/flywheel-xhs",
		"/tmp/fixture",
		`${fixture.root}/`,
		`${fixture.root}/../${"b".repeat(64)}`,
	])
		expect(() => loadBoundaryFixture(root)).toThrow(
			"boundary_fixture_unavailable",
		);
});
it("rejects model-owned marker, wrong state owner, missing marker and extra real-account/endpoints", () => {
	fixture.uid = process.getuid!();
	expect(() => loadBoundaryFixture(fixture.root)).toThrow();
	fixture.uid = 0;
	fixture.stateUid = process.getuid!();
	expect(() => loadBoundaryFixture(fixture.root)).toThrow();
	fixture.stateUid = 450;
	for (const value of [
		{},
		{ ...marker(), nonce: "b".repeat(64) },
		{ ...marker(), account: "real-account" },
		{ ...marker(), endpoint: "https://www.xiaohongshu.com" },
		{ ...marker(), serviceUid: marker().modelUid },
	]) {
		fixture.marker = JSON.stringify(value);
		expect(() => loadBoundaryFixture(fixture.root)).toThrow();
	}
});
it("records each actual permission errno without treating missing paths as denial proof", () => {
	const result = probeFileAuthority(fixture.root);
	expect(result.probeKind).toBe("fixture_harness");
	expect(result.observations).toHaveLength(8);
	expect(
		result.observations.every((row) => row.denied && row.errno === "EACCES"),
	).toBe(true);
	fixture.errno = "ENOENT";
	expect(
		probeFileAuthority(fixture.root).observations.every((row) => !row.denied),
	).toBe(true);
});
it("fails successful unauthorized opens and never truncates or writes bytes", async () => {
	fixture.allow = true;
	const result = probeFileAuthority(fixture.root);
	expect(
		result.observations.some((row) => row.errno === null && !row.denied),
	).toBe(true);
	const fs = await import("node:fs");
	expect(fs.closeSync).toHaveBeenCalledWith(42);
	for (const call of vi.mocked(fs.openSync).mock.calls)
		expect(Number(call[1]) & (constants.O_TRUNC | constants.O_CREAT)).toBe(0);
});

it("rejects replacing the admitted state directory between probe operations", () => {
	fixture.replaceState = true;
	expect(() => probeFileAuthority(fixture.root)).toThrow(
		"boundary_fixture_changed",
	);
});
