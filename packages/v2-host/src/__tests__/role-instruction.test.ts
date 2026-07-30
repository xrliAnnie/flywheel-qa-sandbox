import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRoleInstruction } from "../role-instruction.js";

const roots: string[] = [];

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "flywheel-v2-role-"));
	roots.push(root);
	mkdirSync(join(root, ".flywheel", "agents", "nodes"), { recursive: true });
	writeFileSync(
		join(root, ".flywheel", "agents", "nodes", "implement.md"),
		"# Implement\n\nFollow the project contract.\n",
	);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("runtime node instruction resolution (FLY-1544 ①)", () => {
	it("resolves the node instruction file by task kind", () => {
		const root = fixture();
		const canonicalRoot = realpathSync.native(root);
		expect(
			resolveRoleInstruction({
				projectRoot: root,
				taskKind: "implement",
			}),
		).toMatchObject({
			projectRoot: canonicalRoot,
			sourcePath: join(
				canonicalRoot,
				".flywheel",
				"agents",
				"nodes",
				"implement.md",
			),
			contentBytes: 42,
		});
		expect(
			resolveRoleInstruction({
				projectRoot: root,
				taskKind: "implement",
			}).contentDigest,
		).toMatch(/^[0-9a-f]{64}$/);
	});

	it("fails closed for missing, traversal-shaped, or symlinked node kinds", () => {
		const root = fixture();
		expect(() =>
			resolveRoleInstruction({
				projectRoot: root,
				taskKind: "missing",
			}),
		).toThrow(/node instruction for missing cannot be resolved/);

		// A kind is a path segment; anything outside the strict shape is refused
		// before filesystem access.
		for (const hostile of ["../outside", "a/b", "", ".hidden", "UPPER"]) {
			expect(() =>
				resolveRoleInstruction({
					projectRoot: root,
					taskKind: hostile,
				}),
			).toThrow(/not a valid node instruction name/);
		}

		symlinkSync(
			join(root, ".flywheel", "agents", "nodes", "implement.md"),
			join(root, ".flywheel", "agents", "nodes", "linked.md"),
		);
		expect(() =>
			resolveRoleInstruction({
				projectRoot: root,
				taskKind: "linked",
			}),
		).toThrow(/symbolic link/);
	});

	it("refuses an empty instruction file", () => {
		const root = fixture();
		writeFileSync(
			join(root, ".flywheel", "agents", "nodes", "empty.md"),
			"\n\n",
		);
		expect(() =>
			resolveRoleInstruction({
				projectRoot: root,
				taskKind: "empty",
			}),
		).toThrow(/must contain role instructions/);
	});
});
