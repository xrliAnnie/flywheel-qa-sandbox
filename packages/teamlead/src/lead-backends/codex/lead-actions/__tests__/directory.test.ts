import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parseAndValidateProjects } from "../../../../ProjectConfig.js";
import { readBusinessDirectory } from "../directory.js";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
it("hashes the exact parsed registry bytes and projects empty projects", async () => {
	const root = mkdtempSync(join(tmpdir(), "directory-tool-"));
	dirs.push(root);
	const path = join(root, "projects.json");
	const raw = JSON.stringify(
		[{ projectName: "empty", projectRoot: root, leads: [] }],
		null,
		2,
	);
	writeFileSync(path, raw);
	expect(() => parseAndValidateProjects(JSON.parse(raw))).toThrow(
		/missing "leads"/,
	);
	const result = await readBusinessDirectory(path);
	expect(result).toMatchObject({
		status: "available",
		projectsDigest: createHash("sha256").update(raw).digest("hex"),
		projects: [{ projectName: "empty" }],
	});
});
it("fails closed without exposing malformed registry bytes", async () => {
	const root = mkdtempSync(join(tmpdir(), "directory-tool-"));
	dirs.push(root);
	const path = join(root, "projects.json");
	writeFileSync(path, "SECRET broken JSON");
	expect(await readBusinessDirectory(path)).toEqual({
		status: "unavailable",
		reason: "registry_unavailable",
	});
	expect(await readBusinessDirectory(join(root, "absent"))).toEqual({
		status: "unavailable",
		reason: "registry_unavailable",
	});
});
