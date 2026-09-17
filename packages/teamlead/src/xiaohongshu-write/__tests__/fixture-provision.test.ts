import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	persistFixtureObservations,
	persistFixtureSignature,
	provisionBoundaryFixture,
} from "../fixture-provision.js";

const state = vi.hoisted(() => ({
	base: "",
	uid: 0,
	ancestorWritable: false,
	failWrite: false,
	writes: 0,
	failAt: 0,
	owners: new Map<number, { uid: number; gid: number }>(),
}));
vi.mock("../trusted-files.js", () => ({
	readImmutableFile: () => Buffer.from("synthetic-helper"),
}));
vi.mock("node:fs", async (original) => {
	const real = await original<typeof import("node:fs")>();
	const map = (path: string) =>
		path.startsWith("/private/var/db/flywheel-xhs-qa")
			? path.replace("/private/var/db/flywheel-xhs-qa", state.base)
			: path.startsWith("/Library/Application Support/Flywheel/Xhs")
				? path.replace(
						"/Library/Application Support/Flywheel/Xhs",
						`${state.base}/install`,
					)
				: path;
	const owned = (stat: fs.Stats) =>
		Object.assign(stat, state.owners.get(stat.ino) ?? { uid: 0, gid: 0 });
	return {
		...real,
		lstatSync: (path: string) => {
			const stat = owned(
				real.lstatSync(
					[
						"/Library/Application Support/Flywheel",
						"/Library/Application Support",
						"/Library",
						"/private/var/db",
						"/private/var",
						"/private",
						"/",
					].includes(path)
						? state.base
						: map(path),
				),
			);
			if (state.ancestorWritable && path === "/private/var/db/flywheel-xhs-qa")
				stat.mode |= 0o020;
			return stat;
		},
		openSync: (path: string, flags: number, mode?: number) =>
			real.openSync(map(path), flags, mode),
		mkdirSync: (path: string, options: fs.MakeDirectoryOptions) =>
			real.mkdirSync(map(path), options),
		fstatSync: (fd: number) => owned(real.fstatSync(fd)),
		fchownSync: (fd: number, uid: number, gid: number) => {
			state.owners.set(real.fstatSync(fd).ino, { uid, gid });
		},
		writeSync: (fd: number, bytes: Buffer) => {
			state.writes++;
			if (state.failWrite || state.writes === state.failAt)
				throw Error("disk failure");
			return real.writeSync(fd, bytes);
		},
	};
});
const input = {
	serviceUid: 450,
	serviceGid: 450,
	modelUid: 501,
	modelGid: 20,
	nonce: "a".repeat(64),
	node: {
		path: "/Library/Application Support/Flywheel/Xhs/node",
		sha256: "b".repeat(64),
	},
	boundaryProbe: {
		path: "/Library/Application Support/Flywheel/Xhs/probe.js",
		sha256: "c".repeat(64),
	},
	peerHelper: {
		path: "/Library/Application Support/Flywheel/Xhs/peer",
		sha256: "d".repeat(64),
	},
};
beforeEach(() => {
	state.base = fs.mkdtempSync("/tmp/xhs-provision-");
	fs.mkdirSync(join(state.base, "install"));
	state.owners.clear();
	state.uid = 0;
	state.ancestorWritable = false;
	state.failWrite = false;
	state.writes = 0;
	state.failAt = 0;
	vi.spyOn(process, "getuid").mockImplementation(() => state.uid);
	vi.spyOn(process, "geteuid").mockImplementation(() => state.uid);
});
afterEach(() => {
	fs.rmSync(state.base, { recursive: true, force: true });
	vi.restoreAllMocks();
});
it("creates exact synthetic files and retains a one-shot policy with explicit ownership", () => {
	const result = provisionBoundaryFixture(input);
	const root = join(state.base, input.nonce);
	expect(fs.readFileSync(join(root, "fixture.json"), "utf8")).toContain(
		"flywheel-xhs-synthetic-boundary",
	);
	expect(fs.readFileSync(join(root, "state/permit.synthetic"), "utf8")).toBe(
		`flywheel:xhs:synthetic:permit.synthetic:${input.nonce}\n`,
	);
	expect(fs.readdirSync(join(root, "state")).sort()).toEqual([
		"artifacts",
		"cookie.synthetic",
		"ledger.synthetic",
		"permit.synthetic",
	]);
	expect(fs.readdirSync(join(root, "runtime"))).toEqual([]);
	expect(fs.readdirSync(join(root, "io"))).toEqual([]);
	expect(fs.lstatSync(join(root, "state")).uid).toBe(450);
	expect(fs.lstatSync(join(root, "state")).mode & 0o7777).toBe(0o700);
	expect(fs.lstatSync(join(root, "peer-helper")).mode & 0o7777).toBe(0o555);
	expect(result.root).toBe(`/private/var/db/flywheel-xhs-qa/${input.nonce}`);
	expect(result.markerSha256).toMatch(/^[a-f0-9]{64}$/);
	expect(() => provisionBoundaryFixture(input)).toThrow(
		"fixture_provision_unavailable",
	);
	expect(
		fs.readFileSync(join(root, "state/permit.synthetic"), "utf8"),
	).toContain(input.nonce);
});
it.each(["unprivileged", "writable-parent", "bad-policy"])(
	"refuses %s before creating any files",
	(mode) => {
		if (mode === "unprivileged") state.uid = 501;
		if (mode === "writable-parent") state.ancestorWritable = true;
		expect(() =>
			provisionBoundaryFixture({
				...input,
				modelUid: mode === "bad-policy" ? 450 : 501,
			}),
		).toThrow("fixture_provision_unavailable");
		expect(fs.readdirSync(join(state.base, "install"))).toEqual([]);
		expect(fs.readdirSync(state.base)).toEqual(["install"]);
	},
);
it("retains failed exclusive policy reservation and refuses retry", () => {
	state.failWrite = true;
	expect(() => provisionBoundaryFixture(input)).toThrow(
		"fixture_provision_unavailable",
	);
	state.failWrite = false;
	expect(fs.readdirSync(join(state.base, "install"))).toEqual([
		"fixture-runner.policy",
	]);
	expect(() => provisionBoundaryFixture(input)).toThrow(
		"fixture_provision_unavailable",
	);
});

it("keeps a partially provisioned fixture inaccessible and preserves prior bytes", () => {
	state.failAt = 3;
	expect(() => provisionBoundaryFixture(input)).toThrow(
		"fixture_provision_unavailable",
	);
	const root = join(state.base, input.nonce);
	expect(fs.lstatSync(root).mode & 0o7777).toBe(0o700);
	expect(
		fs.readFileSync(join(root, "state/permit.synthetic"), "utf8"),
	).toContain(input.nonce);
	expect(fs.existsSync(join(root, "fixture.json"))).toBe(false);
	state.failAt = 0;
	expect(() => provisionBoundaryFixture(input)).toThrow(
		"fixture_provision_unavailable",
	);
});

it("persists root-only unsigned observations once and refuses overwrite", () => {
	provisionBoundaryFixture(input);
	const raw = JSON.stringify({ schemaVersion: 1, hostAcceptance: false });
	expect(persistFixtureObservations(input.nonce, raw)).toMatch(
		/^[a-f0-9]{64}$/,
	);
	const path = join(state.base, input.nonce, "fixture-evidence.json");
	expect(fs.readFileSync(path, "utf8")).toBe(raw);
	expect(fs.lstatSync(path).mode & 0o7777).toBe(0o600);
	expect(() => persistFixtureObservations(input.nonce, "replacement")).toThrow(
		"fixture_evidence_persist_unavailable",
	);
	expect(fs.readFileSync(path, "utf8")).toBe(raw);
});
it("rejects unprivileged or out-of-root observation writes", () => {
	state.uid = 501;
	expect(() => persistFixtureObservations(input.nonce, "{}")).toThrow(
		"fixture_evidence_persist_unavailable",
	);
	state.uid = 0;
	expect(() => persistFixtureObservations("../state", "{}")).toThrow(
		"fixture_evidence_persist_unavailable",
	);
	expect(fs.readdirSync(state.base)).toEqual(["install"]);
});

it("publishes root-owned signatures exclusively and retains partial failures", () => {
	const target = "/Library/Application Support/Flywheel/Xhs/acceptance.json";
	const raw = '{"synthetic":"signature"}';
	expect(persistFixtureSignature(target, raw)).toMatch(/^[a-f0-9]{64}$/);
	const path = join(state.base, "install/acceptance.json");
	expect(fs.readFileSync(path, "utf8")).toBe(raw);
	expect(fs.lstatSync(path).mode & 0o7777).toBe(0o644);
	expect(fs.lstatSync(path).uid).toBe(0);
	expect(() => persistFixtureSignature(target, "replacement")).toThrow(
		"fixture_signature_persist_unavailable",
	);
	expect(fs.readFileSync(path, "utf8")).toBe(raw);
	state.failWrite = true;
	const second =
		"/Library/Application Support/Flywheel/Xhs/provider-acceptance.json";
	expect(() => persistFixtureSignature(second, raw)).toThrow(
		"fixture_signature_persist_unavailable",
	);
	state.failWrite = false;
	expect(() => persistFixtureSignature(second, raw)).toThrow(
		"fixture_signature_persist_unavailable",
	);
});
it("refuses signature publication outside fixed destinations and from a model UID", () => {
	state.uid = 501;
	expect(() =>
		persistFixtureSignature(
			"/Library/Application Support/Flywheel/Xhs/acceptance.json",
			"{}",
		),
	).toThrow("fixture_signature_persist_unavailable");
	state.uid = 0;
	for (const path of [
		"/tmp/acceptance.json",
		"/Library/Application Support/Flywheel/Xhs/runtime/acceptance.json",
	])
		expect(() => persistFixtureSignature(path, "{}")).toThrow(
			"fixture_signature_persist_unavailable",
		);
	expect(fs.readdirSync(join(state.base, "install"))).toEqual([]);
});
