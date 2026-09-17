import * as fs from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readImmutableFile } from "../trusted-files.js";

const state = vi.hoisted(() => ({ base: "", owner: 0 }));
const path = "/Library/Application Support/Flywheel/Xhs/boundary-signing.key";
vi.mock("node:fs", async (original) => {
	const real = await original<typeof import("node:fs")>();
	const mapped = (path: string) =>
		path.endsWith("/boundary-signing.key") ? `${state.base}/key` : state.base;
	const owned = (stat: fs.Stats) =>
		Object.assign(stat, { uid: state.owner, gid: 0 });
	return {
		...real,
		lstatSync: (path: string) => owned(real.lstatSync(mapped(path))),
		openSync: (path: string, flags: number) =>
			real.openSync(mapped(path), flags),
		fstatSync: (fd: number) => owned(real.fstatSync(fd)),
	};
});
beforeEach(() => {
	state.base = fs.mkdtempSync("/tmp/xhs-root-key-");
	state.owner = 0;
	fs.writeFileSync(`${state.base}/key`, "synthetic-key", { mode: 0o600 });
});
afterEach(() => {
	fs.rmSync(state.base, { recursive: true, force: true });
});
it.each([0o600, 0o644, 0o640, 0o700])(
	"requires exact root private mode %s",
	(mode) => {
		fs.chmodSync(`${state.base}/key`, mode);
		const read = () =>
			readImmutableFile(path, { maxBytes: 4096, mode: 0o600 }).toString();
		if (mode === 0o600) expect(read()).toBe("synthetic-key");
		else expect(read).toThrow("trusted_file_unavailable");
	},
);
it("refuses a model-owned key despite private mode", () => {
	state.owner = 501;
	expect(() =>
		readImmutableFile(path, { maxBytes: 4096, mode: 0o600 }),
	).toThrow("trusted_file_unavailable");
});
