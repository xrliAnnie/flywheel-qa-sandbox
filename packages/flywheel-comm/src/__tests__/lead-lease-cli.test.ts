import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runLeadLeaseCommand } from "../commands/lead-lease.js";

describe("flywheel-comm lead-lease", () => {
	let dir: string;
	let env: Record<string, string>;
	let stdout: string[];
	let stderr: string[];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1309-cli-"));
		env = {
			FLYWHEEL_LEAD_LEASE_DB: join(dir, "lease.db"),
			FLYWHEEL_LEAD_EPISODE_DB: join(dir, "lease-episodes.db"),
			FLYWHEEL_LEAD_LEASE_MODE_FILE: join(dir, "mode.json"),
			FLYWHEEL_PROJECTS_FILE: join(dir, "projects.json"),
		};
		writeFileSync(
			env.FLYWHEEL_PROJECTS_FILE,
			JSON.stringify([
				{ projectName: "flywheel", leads: [{ agentId: "eng-lead" }] },
			]),
		);
		stdout = [];
		stderr = [];
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	async function run(args: string[]): Promise<number> {
		return runLeadLeaseCommand(args, {
			env,
			stdout: (line) => stdout.push(line),
			stderr: (line) => stderr.push(line),
		});
	}

	it("resolves a canonical identity as JSON", async () => {
		expect(await run(["resolve", "--lead", "eng-lead", "--json"])).toBe(0);
		expect(JSON.parse(stdout[0] ?? "")).toMatchObject({
			status: "ok",
			canonicalProject: "flywheel",
			leadKey: "flywheel-eng-lead",
		});
	});

	it("acquires, reports unbound status, binds, and reports bound status", async () => {
		expect(
			await run([
				"acquire",
				"--lead",
				"eng-lead",
				"--project",
				"flywheel",
				"--supervisor-pid",
				String(process.pid),
				"--supervisor-start",
				"supervisor-start",
				"--json",
			]),
		).toBe(0);
		expect(JSON.parse(stdout.pop() ?? "")).toMatchObject({
			status: "acquired",
			generation: 1,
			leadKey: "flywheel-eng-lead",
		});

		expect(
			await run(["status", "--lead-key", "flywheel-eng-lead", "--json"]),
		).toBe(0);
		expect(JSON.parse(stdout.pop() ?? "")).toMatchObject({
			mode: { mode: "audit_only", source: "default" },
			lease: { generation: 1, boundAt: null },
		});

		expect(
			await run([
				"bind",
				"--lead-key",
				"flywheel-eng-lead",
				"--generation",
				"1",
				"--supervisor-pid",
				String(process.pid),
				"--supervisor-start",
				"supervisor-start",
				"--pane-pid",
				String(process.pid + 1),
				"--pane-start",
				"pane-start",
				"--json",
			]),
		).toBe(0);
		expect(JSON.parse(stdout.pop() ?? "")).toMatchObject({
			status: "bound",
			generation: 1,
		});
	});

	it("sets mode in the independent control file", async () => {
		expect(
			await run(["set-mode", "enforce", "--updated-by", "test", "--json"]),
		).toBe(0);
		expect(JSON.parse(stdout.pop() ?? "")).toEqual({
			mode: "enforce",
			source: "file",
		});
	});

	it("has no release command", async () => {
		expect(await run(["release", "--lead-key", "flywheel-eng-lead"])).toBe(2);
		expect(stderr.join("\n")).toContain("unknown lead-lease subcommand");
	});
});
