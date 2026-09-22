import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	compileLeadIdentityRows,
	type LeadIdentityError,
	resolveLeadIdentity,
} from "../lead-identity.js";

describe("FLY-1726 canonical Lead identity", () => {
	let dir: string;
	let projectsPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1726-identity-"));
		projectsPath = join(dir, "projects.json");
		mkdirSync(join(dir, ".flywheel"));
		writeFileSync(
			join(dir, ".flywheel", "summary-config.json"),
			JSON.stringify({
				granularity: "per-lead",
				setBy: "founder",
				setAt: "2026-08-28T00:00:00.000Z",
			}),
		);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function lead(agentId: string, overrides: Record<string, unknown> = {}) {
		return {
			agentId,
			summaryRole: "producer",
			backend: "claude-code",
			botTokenEnv: `${agentId.replaceAll("-", "_").toUpperCase()}_BOT_TOKEN`,
			botUserId: "12345678901234567",
			chatChannel: "11111111111111111",
			match: { labels: ["Engineering"] },
			...overrides,
		};
	}

	function write(projects: unknown): void {
		writeFileSync(projectsPath, JSON.stringify(projects));
	}

	it("keeps v1 identity bytes unchanged when capability flags change across a fleet", () => {
		const registry = [
			{
				projectName: "flywheel",
				projectRoot: dir,
				leads: [
					lead("product", {
						botUserId: "12345678901234567",
						backend: "codex-app-server",
						codexProfile: "full-access",
						canSpawnRunners: true,
					}),
					lead("infra", {
						botUserId: "22345678901234567",
						backend: "codex-app-server",
						codexProfile: "full-access",
						canSpawnRunners: false,
					}),
					lead("eng", { botUserId: "32345678901234567" }),
				],
			},
		];
		const before = compileLeadIdentityRows(registry, { homeDir: dir });
		for (const flag of [false, true]) {
			const changed = structuredClone(registry);
			Object.assign(changed[0]!.leads[0]!, { codexRunnerActions: flag });
			Object.assign(changed[0]!.leads[1]!, { codexRunnerActions: false });
			const after = compileLeadIdentityRows(changed, { homeDir: dir });
			const identityBytes = (row: (typeof before)[number]) => {
				const { projectsDigest: _registryBytes, ...identity } = row.identity;
				return JSON.stringify(identity);
			};
			expect(after.map(identityBytes)).toEqual(before.map(identityBytes));
		}
	});

	it("resolves every runtime identity face from one exact registry row", () => {
		write([
			{
				projectName: "flywheel",
				projectRoot: dir,
				generalChannel: "22222222222222222",
				leads: [lead("flywheel-eng-lead")],
			},
		]);

		const identity = resolveLeadIdentity({
			projectsPath,
			projectName: "flywheel",
			leadId: "flywheel-eng-lead",
			homeDir: dir,
		});

		expect(identity).toEqual({
			schemaVersion: 1,
			leadId: "flywheel-eng-lead",
			projectName: "flywheel",
			leadKey: "flywheel-flywheel-eng-lead",
			agentTeamName: "flywheel-eng-lead",
			botUserId: "12345678901234567",
			botTokenEnv: "FLYWHEEL_ENG_LEAD_BOT_TOKEN",
			discordStateDir: join(
				dir,
				".claude",
				"channels",
				"discord-flywheel-eng-lead",
			),
			backend: "claude-code",
			role: "dept",
			summaryRole: "producer",
			summaryGranularity: "per-lead",
			hasSummaryDuty: true,
			summaryAssignmentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
			projectsDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
			identityDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
	});

	it("binds the selected mode and projected duty into identityDigest", () => {
		write([
			{
				projectName: "flywheel",
				projectRoot: dir,
				leads: [lead("flywheel-eng-lead")],
			},
		]);
		const perLead = resolveLeadIdentity({
			projectsPath,
			projectName: "flywheel",
			leadId: "flywheel-eng-lead",
			homeDir: dir,
		});
		writeFileSync(
			join(dir, ".flywheel", "summary-config.json"),
			JSON.stringify({
				granularity: "per-project",
				setBy: "founder",
				setAt: "2026-08-28T01:00:00.000Z",
			}),
		);
		write([
			{
				projectName: "flywheel",
				projectRoot: dir,
				summaryAggregatorLeadId: "flywheel-eng-lead",
				leads: [lead("flywheel-eng-lead")],
			},
		]);
		const perProject = resolveLeadIdentity({
			projectsPath,
			projectName: "flywheel",
			leadId: "flywheel-eng-lead",
			homeDir: dir,
		});

		expect(perProject.summaryGranularity).toBe("per-project");
		expect(perProject.hasSummaryDuty).toBe(true);
		expect(perProject.summaryAssignmentDigest).not.toBe(
			perLead.summaryAssignmentDigest,
		);
		expect(perProject.identityDigest).not.toBe(perLead.identityDigest);
	});

	it("rejects a Lead row without an explicit summaryRole assignment", () => {
		write([
			{
				projectName: "flywheel",
				projectRoot: dir,
				leads: [lead("flywheel-eng-lead", { summaryRole: undefined })],
			},
		]);

		expect(() =>
			resolveLeadIdentity({
				projectsPath,
				projectName: "flywheel",
				leadId: "flywheel-eng-lead",
				homeDir: dir,
			}),
		).toThrowError(
			expect.objectContaining<Partial<LeadIdentityError>>({
				code: "identity_summary_role_invalid",
			}),
		);
	});

	it("keeps identityDigest stable when another Lead changes", () => {
		const projects = [
			{
				projectName: "flywheel",
				projectRoot: dir,
				leads: [
					lead("flywheel-eng-lead"),
					lead("flywheel-product-lead", {
						botUserId: "22345678901234567",
						chatChannel: "33333333333333333",
					}),
				],
			},
		];
		write(projects);
		const before = resolveLeadIdentity({
			projectsPath,
			projectName: "flywheel",
			leadId: "flywheel-eng-lead",
			homeDir: dir,
		});
		projects[0]!.leads[1]!.chatChannel = "44444444444444444";
		write(projects);
		const after = resolveLeadIdentity({
			projectsPath,
			projectName: "flywheel",
			leadId: "flywheel-eng-lead",
			homeDir: dir,
		});

		expect(after.identityDigest).toBe(before.identityDigest);
		expect(after.projectsDigest).not.toBe(before.projectsDigest);
	});

	it("keeps the v1 identityDigest stable when Codex runtime tuning is first projected", () => {
		write([
			{
				projectName: "flywheel",
				projectRoot: dir,
				leads: [
					lead("codex-infra-bot-lead", {
						backend: "codex-app-server",
					}),
				],
			},
		]);
		const before = resolveLeadIdentity({
			projectsPath,
			projectName: "flywheel",
			leadId: "codex-infra-bot-lead",
			homeDir: dir,
		});

		write([
			{
				projectName: "flywheel",
				projectRoot: dir,
				leads: [
					lead("codex-infra-bot-lead", {
						backend: "codex-app-server",
						model: "gpt-5.6-sol",
						effort: "xhigh",
						modelContextWindow: 1_000_000,
					}),
				],
			},
		]);
		const after = resolveLeadIdentity({
			projectsPath,
			projectName: "flywheel",
			leadId: "codex-infra-bot-lead",
			homeDir: dir,
		});

		expect(after).toMatchObject({
			model: "gpt-5.6-sol",
			effort: "xhigh",
			modelContextWindow: 1_000_000,
		});
		expect(after.identityDigest).toBe(before.identityDigest);
		expect(after.projectsDigest).not.toBe(before.projectsDigest);
	});

	it("keeps identityDigest stable when projectRepo and personaProjection are added", () => {
		const rayaLead = lead("raya", {
			backend: "codex-app-server",
			codexProfile: "full-access",
			canSpawnRunners: false,
		});
		const base = {
			projectName: "raya",
			projectRoot: dir,
			leads: [rayaLead],
		};
		const before = compileLeadIdentityRows([base], { homeDir: dir })[0]!
			.identity;
		const projection = {
			schemaVersion: 1,
			enabled: true,
			leadId: "raya",
			repo: "xrliAnnie/raya",
			path: ".lead/raya/identity.md",
			pin: {
				commit: "a".repeat(40),
				personaBlobDigest: "b".repeat(64),
				approval: {
					channelId: "12345678901234567",
					messageId: "22345678901234567",
					contentSha256: "c".repeat(64),
				},
			},
			lastKnownGood: {
				commit: "d".repeat(40),
				personaBlobDigest: "e".repeat(64),
				approval: {
					channelId: "12345678901234567",
					messageId: "32345678901234567",
					contentSha256: "f".repeat(64),
				},
			},
		};
		const after = compileLeadIdentityRows(
			[
				{
					...base,
					projectRepo: "xrliAnnie/raya",
					personaProjection: projection,
				},
			],
			{ homeDir: dir },
		)[0]!;
		expect(after.identity.identityDigest).toBe(before.identityDigest);
		expect(after.project.projectRepo).toBe("xrliAnnie/raya");
		expect(after.project.personaProjection).toEqual(projection);
	});

	it.each([
		[
			"identity_row_missing",
			[
				{
					projectName: "flywheel",
					projectRoot: "/tmp",
					leads: [lead("other-lead")],
				},
			],
			"flywheel",
			"missing-lead",
		],
		[
			"identity_bare_id_collision",
			[
				{
					projectName: "flywheel",
					projectRoot: "/tmp/a",
					leads: [lead("same-lead")],
				},
				{
					projectName: "sub",
					projectRoot: "/tmp/b",
					leads: [lead("same-lead")],
				},
			],
			"flywheel",
			"same-lead",
		],
		[
			"identity_bot_user_id_missing",
			[
				{
					projectName: "flywheel",
					projectRoot: "/tmp",
					leads: [lead("managed-lead", { botUserId: undefined })],
				},
			],
			"flywheel",
			"managed-lead",
		],
	] as const)("fails loud with %s", (code, projects, projectName, leadId) => {
		write(projects);

		expect(() =>
			resolveLeadIdentity({
				projectsPath,
				projectName,
				leadId,
				homeDir: dir,
			}),
		).toThrowError(
			expect.objectContaining<Partial<LeadIdentityError>>({ code }),
		);
	});

	it("rejects effective state-dir aliases even when one path uses a symlinked ancestor", () => {
		const channels = join(dir, "channels");
		const alias = join(dir, "channels-alias");
		mkdirSync(channels);
		symlinkSync(channels, alias);
		write([
			{
				projectName: "flywheel",
				projectRoot: dir,
				leads: [
					lead("eng-lead", {
						discordStateDir: join(channels, "discord-shared"),
					}),
					lead("product-lead", {
						botUserId: "22345678901234567",
						discordStateDir: join(alias, "discord-shared"),
					}),
				],
			},
		]);

		expect(() =>
			resolveLeadIdentity({
				projectsPath,
				projectName: "flywheel",
				leadId: "eng-lead",
				homeDir: dir,
			}),
		).toThrowError(
			expect.objectContaining<Partial<LeadIdentityError>>({
				code: "identity_state_dir_conflict",
			}),
		);
	});
});
