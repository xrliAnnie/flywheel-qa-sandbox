import { beforeEach, expect, it, vi } from "vitest";
import { probeFileControl } from "../boundary-file-control.js";

const f = vi.hoisted(() => ({
	root: `/private/var/db/flywheel-xhs-qa/${"a".repeat(64)}`,
	nonce: "a".repeat(64),
	uid: 450,
	bad: "",
	extra: false,
	reads: 0,
	moved: false,
}));
vi.mock("../boundary-file-probe.js", () => ({
	loadBoundaryFixture: () => ({
		root: f.root,
		nonce: f.nonce,
		serviceUid: 450,
		modelUid: 501,
	}),
}));
vi.mock("../trusted-files.js", () => {
	const read = (path: string) => {
		f.reads++;
		const name = path.split("/").at(-1)!;
		if (f.bad === "missing") throw Error("trusted_file_unavailable");
		if (f.bad === "empty") return Buffer.alloc(0);
		if (f.bad === "real") return Buffer.from("not-synthetic");
		if (f.bad === "replace") f.moved = true;
		return Buffer.from(`flywheel:xhs:synthetic:${name}:${f.nonce}\n`);
	};
	return { readPrivateFile: read, readImmutableFile: read };
});
vi.mock("node:fs", async (original) => ({
	...(await original<typeof import("node:fs")>()),
	readdirSync: (path: string) =>
		path.endsWith("/artifacts")
			? []
			: [
					"permit.synthetic",
					"cookie.synthetic",
					"ledger.synthetic",
					"artifacts",
					...(f.extra ? ["artifacts-probe-link"] : []),
				],
	lstatSync: (path: string) => ({
		isDirectory: () => path.endsWith("/artifacts"),
		isFile: () => !path.endsWith("/artifacts"),
		dev: 1,
		ino: f.moved ? 2 : 1,
		uid: path.includes("/state/") ? 450 : 0,
		gid: 450,
		mode: path.endsWith("/artifacts") ? 0o40700 : 0o100600,
		nlink: 1,
		size: 100,
		mtimeMs: 1,
		ctimeMs: 1,
	}),
}));
beforeEach(() => {
	f.uid = 450;
	f.bad = "";
	f.extra = false;
	f.reads = 0;
	f.moved = false;
	vi.spyOn(process, "getuid").mockImplementation(() => f.uid);
});
it("reads all five nonempty synthetic files as the service and reports only measurements", () => {
	const result = probeFileControl(f.root);
	expect(f.reads).toBe(5);
	expect(result.files).toHaveLength(5);
	expect(result.probe).toBe("file-control");
	expect(JSON.stringify(result)).not.toContain("flywheel:xhs:synthetic:");
	expect(result.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(
		true,
	);
});
it("refuses root/model impersonation before reading any private fixture files", () => {
	for (const uid of [0, 501]) {
		f.uid = uid;
		expect(() => probeFileControl(f.root)).toThrow(
			"boundary_file_control_unavailable",
		);
	}
	expect(f.reads).toBe(0);
});
it.each(["missing", "empty", "real", "replace"])(
	"rejects %s fixture data instead of issuing positive control",
	(bad) => {
		f.bad = bad;
		expect(() => probeFileControl(f.root)).toThrow(
			"boundary_file_control_unavailable",
		);
	},
);
it("rejects residual rename/symlink probe mutations", () => {
	f.extra = true;
	expect(() => probeFileControl(f.root)).toThrow(
		"boundary_file_control_unavailable",
	);
});
