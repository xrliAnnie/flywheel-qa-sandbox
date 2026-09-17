import { afterEach, expect, it, vi } from "vitest";
import { verifyPrivateAuthoritySocket } from "../launchd-private-path.js";

const state = vi.hoisted(() => ({ changes: new Map<string, object>() }));
const path = "/private/var/run/flywheel-xhs-private/authority.sock";
const parent = "/private/var/run/flywheel-xhs-private";
vi.mock("node:fs", () => ({
	lstatSync: (value: string) => ({
		isDirectory: () => value !== path,
		isSocket: () => value === path,
		uid: 0,
		gid: value === path || value === parent ? 450 : 0,
		mode: value === path ? 0o660 : value === parent ? 0o750 : 0o755,
		nlink: 1,
		...state.changes.get(value),
	}),
}));
afterEach(() => state.changes.clear());
it("accepts only the root-owned private policy socket and dedicated group layout", () => {
	expect(() =>
		verifyPrivateAuthoritySocket({ authoritySocket: path, serviceGid: 450 }),
	).not.toThrow();
	for (const change of [
		{ authoritySocket: "/private/var/run/other.sock" },
		{ serviceGid: 0 },
		{ serviceGid: 80 },
		{ serviceGid: 451 },
	]) {
		expect(() =>
			verifyPrivateAuthoritySocket({
				authoritySocket: path,
				serviceGid: 450,
				...change,
			}),
		).toThrow("authority_config_unavailable");
	}
});
it("rejects mutable, replaced, linked or incorrectly owned path components", () => {
	for (const [where, change] of [
		[path, { uid: 450 }],
		[path, { mode: 0o666 }],
		[path, { nlink: 2 }],
		[path, { isSocket: () => false }],
		[parent, { uid: 450 }],
		[parent, { gid: 451 }],
		[parent, { mode: 0o700 }],
		[parent, { isDirectory: () => false }],
		["/private/var", { uid: 501 }],
		["/private/var", { mode: 0o777 }],
	] as const) {
		state.changes.set(where, change);
		expect(() =>
			verifyPrivateAuthoritySocket({ authoritySocket: path, serviceGid: 450 }),
		).toThrow("authority_config_unavailable");
		state.changes.clear();
	}
});
