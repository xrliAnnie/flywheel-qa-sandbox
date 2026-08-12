import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runLeadIdentityCommand } from "../commands/lead-identity.js";

describe("flywheel-comm lead-identity resolve", () => {
	let dir: string;
	let projectsPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1726-cli-"));
		projectsPath = join(dir, "projects.json");
		writeFileSync(
			projectsPath,
			JSON.stringify([
				{
					projectName: "flywheel",
					projectRoot: dir,
					leads: [
						{
							agentId: "eng-lead",
							chatChannel: "11111111111111111",
							match: { labels: ["Engineering"] },
							botTokenEnv: "ENG_BOT_TOKEN",
							botUserId: "12345678901234567",
						},
					],
				},
			]),
		);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("emits the canonical JSON object", () => {
		const stdout: string[] = [];
		const rc = runLeadIdentityCommand(
			[
				"resolve",
				"--projects-file",
				projectsPath,
				"--project",
				"flywheel",
				"--lead",
				"eng-lead",
				"--format",
				"json",
			],
			{ stdout: (line) => stdout.push(line), homeDir: dir },
		);

		expect(rc).toBe(0);
		expect(JSON.parse(stdout[0]!)).toMatchObject({
			leadId: "eng-lead",
			projectName: "flywheel",
			botTokenEnv: "ENG_BOT_TOKEN",
			botUserId: "12345678901234567",
		});
	});

	it("emits a non-secret env projection", () => {
		const stdout: string[] = [];
		const rc = runLeadIdentityCommand(
			[
				"resolve",
				"--projects-file",
				projectsPath,
				"--project",
				"flywheel",
				"--lead",
				"eng-lead",
				"--format",
				"env",
			],
			{ stdout: (line) => stdout.push(line), homeDir: dir },
		);

		expect(rc).toBe(0);
		expect(stdout).toContain("FLYWHEEL_LEAD_ID=eng-lead");
		expect(stdout).toContain("DISCORD_EXPECTED_BOT_USER_ID=12345678901234567");
		expect(stdout).toContain("DISCORD_IDENTITY_MODE=managed");
		expect(stdout.join("\n")).not.toContain("ENG_BOT_TOKEN=");
		expect(stdout.join("\n")).not.toContain("DISCORD_BOT_TOKEN=");
	});

	it("returns a structured error without falling back", () => {
		const stderr: string[] = [];
		const rc = runLeadIdentityCommand(
			[
				"resolve",
				"--projects-file",
				projectsPath,
				"--project",
				"flywheel",
				"--lead",
				"missing-lead",
			],
			{ stderr: (line) => stderr.push(line), homeDir: dir },
		);

		expect(rc).toBe(1);
		expect(JSON.parse(stderr[0]!)).toMatchObject({
			ok: false,
			code: "identity_row_missing",
		});
	});

	it("atomically records a secret-free private failure marker keyed by selectorDigest", () => {
		const markerDir = join(dir, "markers");
		const stderr: string[] = [];
		const rc = runLeadIdentityCommand(
			[
				"resolve",
				"--projects-file",
				projectsPath,
				"--project",
				"flywheel",
				"--lead",
				"missing-lead",
			],
			{
				stderr: (line) => stderr.push(line),
				homeDir: dir,
				failureDir: markerDir,
				now: () => "2026-08-12T12:00:00.000Z",
			},
		);

		expect(rc).toBe(1);
		const files = readdirSync(markerDir);
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
		const path = join(markerDir, files[0]!);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		const raw = readFileSync(path, "utf8");
		expect(raw).not.toContain("ENG_BOT_TOKEN");
		expect(raw).not.toContain("secret-token");
		expect(JSON.parse(raw)).toMatchObject({
			schemaVersion: 1,
			selectorDigest: files[0]!.replace(/\.json$/, ""),
			projectName: "flywheel",
			leadId: "missing-lead",
			code: "identity_row_missing",
			failedAt: "2026-08-12T12:00:00.000Z",
		});
	});

	it("preserves the original failure when marker persistence also fails", () => {
		const impossibleDir = join(dir, "not-a-dir");
		writeFileSync(impossibleDir, "file");
		const stderr: string[] = [];
		const rc = runLeadIdentityCommand(
			[
				"resolve",
				"--projects-file",
				projectsPath,
				"--project",
				"flywheel",
				"--lead",
				"missing-lead",
			],
			{
				stderr: (line) => stderr.push(line),
				failureDir: impossibleDir,
			},
		);
		expect(rc).toBe(1);
		expect(JSON.parse(stderr.at(-1)!)).toMatchObject({
			code: "identity_row_missing",
		});
	});
});

describe("flywheel-comm lead-identity migrate-bot-user-ids", () => {
	let dir: string;
	let projectsPath: string;
	let rosterPath: string;
	let backupPath: string;
	let original: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1726-migration-"));
		projectsPath = join(dir, "projects.json");
		rosterPath = join(dir, "roster.json");
		backupPath = join(dir, "projects.before-fly1726.json");
		original = `${JSON.stringify(
			[
				{
					projectName: "flywheel",
					projectRoot: dir,
					leads: [
						{ agentId: "eng-lead", botTokenEnv: "ENG_BOT_TOKEN" },
						{ agentId: "cos-lead", botTokenEnv: "COS_BOT_TOKEN" },
					],
				},
			],
			null,
			2,
		)}\n`;
		writeFileSync(projectsPath, original, { mode: 0o600 });
		writeFileSync(
			rosterPath,
			JSON.stringify([
				{
					projectName: "flywheel",
					leadId: "eng-lead",
					botTokenEnv: "ENG_BOT_TOKEN",
					expectedBotUserId: "12345678901234567",
				},
				{
					projectName: "flywheel",
					leadId: "cos-lead",
					botTokenEnv: "COS_BOT_TOKEN",
					expectedBotUserId: "22345678901234567",
				},
			]),
		);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("verifies the independent roster before backing up and atomically migrating", async () => {
		const calls: Array<{ url: string; authorization: string }> = [];
		const stdout: string[] = [];
		const rc = await runLeadIdentityCommand(
			[
				"migrate-bot-user-ids",
				"--projects-file",
				projectsPath,
				"--roster-file",
				rosterPath,
				"--backup-file",
				backupPath,
			],
			{
				stdout: (line) => stdout.push(line),
				homeDir: dir,
				env: { ENG_BOT_TOKEN: "eng-secret", COS_BOT_TOKEN: "cos-secret" },
				fetch: async (url, init) => {
					const authorization = String(
						(init?.headers as Record<string, string>).Authorization,
					);
					calls.push({ url: String(url), authorization });
					return new Response(
						JSON.stringify({
							id: authorization.endsWith("eng-secret")
								? "12345678901234567"
								: "22345678901234567",
						}),
						{ status: 200 },
					);
				},
			},
		);

		expect(rc).toBe(0);
		expect(calls).toHaveLength(2);
		expect(calls.every((call) => call.url.endsWith("/users/@me"))).toBe(true);
		expect(readFileSync(backupPath, "utf8")).toBe(original);
		const migrated = JSON.parse(readFileSync(projectsPath, "utf8"));
		expect(
			migrated[0].leads.map((lead: { botUserId: string }) => lead.botUserId),
		).toEqual(["12345678901234567", "22345678901234567"]);
		expect(statSync(projectsPath).mode & 0o777).toBe(0o600);
		expect(JSON.parse(stdout[0]!)).toMatchObject({ migrated: 2 });
		expect(stdout.join("\n")).not.toContain("eng-secret");
	});

	it("aborts without writes when Discord disagrees with the roster", async () => {
		const stderr: string[] = [];
		const rc = await runLeadIdentityCommand(
			[
				"migrate-bot-user-ids",
				"--projects-file",
				projectsPath,
				"--roster-file",
				rosterPath,
				"--backup-file",
				backupPath,
			],
			{
				stderr: (line) => stderr.push(line),
				homeDir: dir,
				env: { ENG_BOT_TOKEN: "wrong", COS_BOT_TOKEN: "cos-secret" },
				fetch: async () =>
					new Response(JSON.stringify({ id: "99999999999999999" }), {
						status: 200,
					}),
			},
		);

		expect(rc).toBe(1);
		expect(readFileSync(projectsPath, "utf8")).toBe(original);
		expect(() => readFileSync(backupPath, "utf8")).toThrow();
		expect(JSON.parse(stderr.at(-1)!)).toMatchObject({
			code: "identity_migration_bot_mismatch",
		});
	});

	it("rejects inherited identity and unlisted bot tokens before Discord", async () => {
		let fetchCalls = 0;
		const stderr: string[] = [];
		const rc = await runLeadIdentityCommand(
			[
				"migrate-bot-user-ids",
				"--projects-file",
				projectsPath,
				"--roster-file",
				rosterPath,
				"--backup-file",
				backupPath,
			],
			{
				stderr: (line) => stderr.push(line),
				homeDir: dir,
				env: {
					ENG_BOT_TOKEN: "eng-secret",
					COS_BOT_TOKEN: "cos-secret",
					FOREIGN_BOT_TOKEN: "foreign-secret",
					LEAD_ID: "wrong-lead",
				},
				fetch: async () => {
					fetchCalls += 1;
					return new Response();
				},
			},
		);

		expect(rc).toBe(1);
		expect(fetchCalls).toBe(0);
		expect(readFileSync(projectsPath, "utf8")).toBe(original);
		expect(JSON.parse(stderr.at(-1)!)).toMatchObject({
			code: "identity_migration_dirty_environment",
		});
	});
});
