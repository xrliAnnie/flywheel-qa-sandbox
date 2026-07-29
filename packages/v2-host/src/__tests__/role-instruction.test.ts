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
	mkdirSync(join(root, ".flywheel", "agents"), { recursive: true });
	writeFileSync(
		join(root, ".flywheel", "config.yaml"),
		[
			"project: example",
			"agents:",
			"  engineer:",
			"    agent_file: .flywheel/agents/engineer.md",
			"",
		].join("\n"),
	);
	writeFileSync(
		join(root, ".flywheel", "agents", "engineer.md"),
		"# Engineer\n\nFollow the project contract.\n",
	);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("runtime role instruction resolution", () => {
	it("resolves the exact configured agent file and records immutable evidence", () => {
		const root = fixture();
		const canonicalRoot = realpathSync.native(root);
		expect(
			resolveRoleInstruction({
				projectRoot: root,
				logicalAgentId: "engineer",
			}),
		).toMatchObject({
			projectRoot: canonicalRoot,
			configPath: join(canonicalRoot, ".flywheel", "config.yaml"),
			sourcePath: join(canonicalRoot, ".flywheel", "agents", "engineer.md"),
			contentBytes: 41,
		});
		expect(
			resolveRoleInstruction({
				projectRoot: root,
				logicalAgentId: "engineer",
			}).contentDigest,
		).toMatch(/^[0-9a-f]{64}$/);
	});

	it("fails closed for unknown, escaping, or symlinked role sources", () => {
		const root = fixture();
		expect(() =>
			resolveRoleInstruction({
				projectRoot: root,
				logicalAgentId: "missing",
			}),
		).toThrow(/agent missing/);

		writeFileSync(
			join(root, ".flywheel", "config.yaml"),
			"agents:\n  engineer:\n    agent_file: ../outside.md\n",
		);
		expect(() =>
			resolveRoleInstruction({
				projectRoot: root,
				logicalAgentId: "engineer",
			}),
		).toThrow(/escapes/);

		writeFileSync(
			join(root, ".flywheel", "config.yaml"),
			"agents:\n  engineer:\n    agent_file: .flywheel/agents/link.md\n",
		);
		symlinkSync(
			join(root, ".flywheel", "agents", "engineer.md"),
			join(root, ".flywheel", "agents", "link.md"),
		);
		expect(() =>
			resolveRoleInstruction({
				projectRoot: root,
				logicalAgentId: "engineer",
			}),
		).toThrow(/symbolic link/);
	});
});
