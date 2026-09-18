import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import {
	findRegisteredCodexCredentialLeadTargets,
	resolveCodexCredentialHomeRoster,
} from "../credential-home-roster.js";
import { createRegisteredCodexQuotaHostCollectorOptions } from "../host-readiness.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function project(
	projectName: string,
	leads: Array<Record<string, unknown>>,
): ProjectEntry {
	return {
		projectName,
		projectRoot: `/fixture/${projectName}`,
		leads,
	} as unknown as ProjectEntry;
}

describe("Codex credential-home roster", () => {
	it("derives every registered Codex Lead without reusing patrol eligibility", () => {
		const projects = [
			project("flywheel", [
				{
					agentId: "codex-infra-bot-lead",
					backend: "codex-app-server",
					codexResidencyPatrol: true,
				},
			]),
			project("growth", [
				{ agentId: "mufasa-lead", backend: "codex-app-server" },
			]),
			project("raya", [
				{
					agentId: "raya",
					backend: "codex-app-server",
					codexResidencyPatrol: false,
				},
			]),
			project("ignored", [{ agentId: "claude-lead", backend: "claude-code" }]),
		];

		expect(findRegisteredCodexCredentialLeadTargets(projects)).toEqual([
			{ projectName: "flywheel", leadId: "codex-infra-bot-lead" },
			{ projectName: "growth", leadId: "mufasa-lead" },
			{ projectName: "raya", leadId: "raya" },
		]);
		const collector = createRegisteredCodexQuotaHostCollectorOptions(projects, {
			homesRoot: "/fixture/homes",
			canonicalHome: "/fixture/canonical",
			commRoot: "/fixture/comm",
			projectNames: projects.map((entry) => entry.projectName),
			approvedManifestPath: "/fixture/readiness.json",
			leadAuthorityScript: "/fixture/authority",
		});
		expect(collector.leadTargets).toEqual(
			findRegisteredCodexCredentialLeadTargets(projects),
		);
	});

	it("combines fixed runner homes and authoritative Lead homes", async () => {
		const homeDir = mkdtempSync(join(tmpdir(), "fly2523-roster-"));
		roots.push(homeDir);
		const runner = join(
			homeDir,
			".flywheel/codex-homes/agents/flywheel/implement",
		);
		const raya = join(homeDir, ".codex-raya");
		mkdirSync(runner, { recursive: true });
		mkdirSync(raya);
		writeFileSync(
			join(runner, ".flywheel-agent-home.json"),
			JSON.stringify({ project: "flywheel", role: "implement" }),
		);
		const projects = [
			project("raya", [{ agentId: "raya", backend: "codex-app-server" }]),
		];

		await expect(
			resolveCodexCredentialHomeRoster(projects, {
				homeDir,
				runnerHomes: [
					{
						id: "flywheel/implement",
						project: "flywheel",
						role: "implement",
						relativeHome: ".flywheel/codex-homes/agents/flywheel/implement",
					},
				],
				resolveLeadAuthority: async () => ({ codexHome: raya }),
			}),
		).resolves.toEqual([
			{
				id: "flywheel/implement",
				home: runner,
				ownership: "managed",
				project: "flywheel",
				role: "implement",
			},
			{
				id: "raya/raya",
				home: raya,
				ownership: "managed",
				leadTuple: "raya/raya",
			},
		]);
	});

	it("fails loud for a registered Lead whose authority is missing", async () => {
		const homeDir = mkdtempSync(join(tmpdir(), "fly2523-roster-"));
		roots.push(homeDir);
		const projects = [
			project("raya", [{ agentId: "raya", backend: "codex-app-server" }]),
		];
		await expect(
			resolveCodexCredentialHomeRoster(projects, {
				homeDir,
				runnerHomes: [],
				resolveLeadAuthority: async () => ({
					codexHome: join(homeDir, ".missing-raya"),
				}),
			}),
		).rejects.toThrow(/raya\/raya.*unavailable/);
	});

	it("rejects duplicate authoritative homes instead of silently collapsing them", async () => {
		const homeDir = mkdtempSync(join(tmpdir(), "fly2523-roster-"));
		roots.push(homeDir);
		const shared = join(homeDir, ".codex-shared");
		mkdirSync(shared);
		const projects = [
			project("one", [{ agentId: "lead-a", backend: "codex-app-server" }]),
			project("two", [{ agentId: "lead-b", backend: "codex-app-server" }]),
		];
		await expect(
			resolveCodexCredentialHomeRoster(projects, {
				homeDir,
				runnerHomes: [],
				resolveLeadAuthority: async () => ({ codexHome: shared }),
			}),
		).rejects.toThrow(/duplicate/);
	});
});
