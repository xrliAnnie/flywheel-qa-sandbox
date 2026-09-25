/**
 * FLY-2877 T6 — teamlead tests never see the real Codex homes.
 *
 * Any test that boots the Bridge runs the FLY-2358 startup janitor with the
 * process environment. Before vitest.setup isolated the homes root, that
 * janitor compared the production `~/.flywheel/codex-homes` leases against the
 * test's empty StateStore and deleted every one of them — the lease loss that
 * left a live runner's home unreadable for the Codex readiness gate.
 */
import { readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import {
	admitCodexAgentHome,
	codexHomesRoot,
	scrubOrphanedCodexAgentHomes,
} from "flywheel-claude-runner";
import { describe, expect, it } from "vitest";

/** Throws unless the homes root is a per-test temp directory. */
function isolatedHomesRoot(): string {
	const root = process.env.FLYWHEEL_CODEX_HOMES_ROOT;
	const sessions = process.env.FLYWHEEL_CODEX_SESSION_DIR;
	if (!root || !sessions) throw new Error("codex homes root is not isolated");
	const tmp = `${realpathSync(tmpdir())}${sep}`;
	const parent = realpathSync(dirname(root));
	if (
		!parent.startsWith(tmp) ||
		!realpathSync(dirname(sessions)).startsWith(tmp)
	)
		throw new Error("codex homes root is not under the OS temp directory");
	return root;
}

let firstRoot: string | undefined;

describe("FLY-2877 teamlead tests never see the real Codex homes", () => {
	it("points the homes root and the session dir at the per-test temp root", () => {
		const root = isolatedHomesRoot();
		expect(dirname(root)).toBe(process.env.FLYWHEEL_COMM_DIR);
		expect(dirname(process.env.FLYWHEEL_CODEX_SESSION_DIR!)).toBe(
			process.env.FLYWHEEL_COMM_DIR,
		);
		expect(codexHomesRoot()).toBe(root);
		expect(codexHomesRoot()).not.toBe(
			join(homedir(), ".flywheel", "codex-homes"),
		);
		firstRoot = root;
	});

	it("gives every test a fresh root", () => {
		expect(firstRoot).toBeDefined();
		expect(isolatedHomesRoot()).not.toBe(firstRoot);
	});

	it("the startup janitor, called as run-infra calls it, scans only the isolated root", async () => {
		const root = isolatedHomesRoot();
		const admission = await admitCodexAgentHome({
			project: "flywheel",
			role: "implement",
			executionId: "exec-orphan",
			requestedAssemblyArm: "bare",
		});
		expect(admission.handle.home.startsWith(`${root}${sep}`)).toBe(true);
		await expect(
			scrubOrphanedCodexAgentHomes(new Map(), undefined, {
				probe: async () => ({ status: "ok", holders: [] }),
			}),
		).resolves.toBe(1);
	});

	it("run-infra's startup janitor takes its homes root from the environment", () => {
		const source = readFileSync(
			join(import.meta.dirname, "..", "run-infra.ts"),
			"utf8",
		);
		expect(source).toMatch(
			/await scrubOrphanedCodexAgentHomes\(\s*keyedCodexHomeSessionSnapshot\(store\),\s*\)/,
		);
	});
});
