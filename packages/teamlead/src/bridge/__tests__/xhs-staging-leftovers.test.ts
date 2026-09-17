import {
	closeSync,
	ftruncateSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	measureXhsStagingLeftovers,
	XhsStagingLeftoversError,
} from "../xhs-staging-leftovers.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function root() {
	const path = realpathSync(
		mkdtempSync(`${realpathSync(tmpdir())}/xhs-leftovers-`),
	);
	roots.push(path);
	return path;
}
function staged(parent: string) {
	return mkdtempSync(join(parent, ".flywheel-xhs-artifact-"));
}
it("counts actual leftover bytes and skips only an exact owned inode", () => {
	const project = root(),
		left = staged(project),
		owned = staged(project);
	writeFileSync(join(left, "bytes"), Buffer.alloc(27), { mode: 0o600 });
	writeFileSync(join(left, "manifest.json"), "{}", { mode: 0o600 });
	writeFileSync(join(owned, "live"), Buffer.alloc(100), { mode: 0o600 });
	const stat = lstatSync(owned);
	expect(
		measureXhsStagingLeftovers(project, [
			{ path: owned, dev: stat.dev, ino: stat.ino },
		]),
	).toEqual({ bytes: 29, paths: [left] });
	expect(
		measureXhsStagingLeftovers(project, [
			{ path: owned, dev: stat.dev, ino: stat.ino + 1 },
		]).bytes,
	).toBe(129);
});
it("fails closed at the 256MiB and eight-directory bounds without deleting bytes", () => {
	for (const kind of ["bytes", "directories"]) {
		const project = root(),
			left = staged(project);
		if (kind === "bytes") {
			const fd = openSync(join(left, "large"), "wx", 0o600);
			try {
				ftruncateSync(fd, 256 * 1024 * 1024);
			} finally {
				closeSync(fd);
			}
		} else for (let i = 1; i < 8; i++) staged(project);
		let caught: unknown;
		try {
			measureXhsStagingLeftovers(project, []);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(XhsStagingLeftoversError);
		expect(caught).toMatchObject({
			message: "staging_leftovers_exceeded",
			paths: expect.arrayContaining([left]),
		});
		expect(lstatSync(left).isDirectory()).toBe(true);
	}
});
it("never follows a leftover symlink or scans an unrelated project directory", () => {
	const project = root(),
		outside = root(),
		left = staged(project);
	mkdirSync(join(project, "ordinary"));
	writeFileSync(join(project, "ordinary", "ignored"), Buffer.alloc(1000));
	writeFileSync(join(outside, "keep"), "private-fixture");
	symlinkSync(outside, join(left, "link"));
	expect(() => measureXhsStagingLeftovers(project, [])).toThrow(
		"staging_leftovers_exceeded",
	);
	expect(lstatSync(join(outside, "keep")).size).toBe(15);
});
