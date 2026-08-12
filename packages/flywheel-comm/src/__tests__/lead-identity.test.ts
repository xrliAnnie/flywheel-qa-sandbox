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
	type LeadIdentityError,
	resolveLeadIdentity,
} from "../lead-identity.js";

describe("FLY-1726 canonical Lead identity", () => {
	let dir: string;
	let projectsPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1726-identity-"));
		projectsPath = join(dir, "projects.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function lead(agentId: string, overrides: Record<string, unknown> = {}) {
		return {
			agentId,
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
			projectsDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
			identityDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
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
