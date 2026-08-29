import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ProjectRootNotFoundError,
	resolveProjectPath,
} from "../lib/resolve-project.js";

describe("resolveProjectPath", () => {
	let root: string;

	beforeEach(() => {
		root = join(tmpdir(), `fly-cli-resolve-${Date.now()}-${Math.random()}`);
		mkdirSync(root, { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("returns explicit path when given (absolute)", () => {
		mkdirSync(join(root, ".flywheel"), { recursive: true });
		expect(resolveProjectPath({ explicit: root })).toBe(root);
	});

	it("rejects explicit path that doesn't exist", () => {
		expect(() =>
			resolveProjectPath({ explicit: join(root, "no-such") }),
		).toThrow(/does not exist/);
	});

	it("walks up from a nested cwd to find .flywheel/", () => {
		mkdirSync(join(root, ".flywheel"), { recursive: true });
		const nested = join(root, "packages", "foo", "src");
		mkdirSync(nested, { recursive: true });
		expect(resolveProjectPath({ cwd: nested })).toBe(root);
	});

	it("returns cwd directly when .flywheel/ is in cwd", () => {
		mkdirSync(join(root, ".flywheel"), { recursive: true });
		expect(resolveProjectPath({ cwd: root })).toBe(root);
	});

	it("throws ProjectRootNotFoundError when no .flywheel/ in any ancestor", () => {
		// `root` deliberately has no .flywheel/ dir.
		expect(() => resolveProjectPath({ cwd: root })).toThrow(
			ProjectRootNotFoundError,
		);
	});

	it("returns cwd without walking when expectExisting=false", () => {
		// Used by `init` — .flywheel/ doesn't exist yet but we still want
		// the cwd as the project path to scaffold under.
		expect(resolveProjectPath({ cwd: root, expectExisting: false })).toBe(root);
	});
});
