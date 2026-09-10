import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { StateStore } from "../../StateStore.js";
import type { VoiceHostConfig } from "../../voice-host-config.js";
import { voiceSessionAuthMiddleware } from "../voice-session-auth.js";
import { createVoiceSessionRouter } from "../voice-session-routes.js";
import {
	createVoiceStartResolver,
	type VoiceStartPreflightInput,
} from "../voice-session-start.js";

const MEETING_ID = "20000000-0000-4000-8000-000000000001";
const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const NOW = "2026-09-08T20:00:00.000Z";
const cleanup: string[] = [];

afterEach(() => {
	for (const root of cleanup.splice(0)) rmSync(root, { recursive: true });
});

function project(
	projectName: string,
	agentId: string,
	voiceModes: { meeting?: boolean; rg?: boolean } = {
		meeting: true,
		rg: false,
	},
): ProjectEntry {
	return {
		projectName,
		projectRoot: `/repo/${projectName}`,
		huddle: {
			guildId: "100000000000000001",
			voiceChannelId: "100000000000000002",
			orchestratorBotTokenEnv: "VOICE_BOT_TOKEN",
			orchestratorBotUserId: "100000000000000003",
			earsBotTokenEnv: "EARS_BOT_TOKEN",
		},
		leads: [
			{
				agentId,
				summaryRole: "producer",
				chatChannel: "100000000000000004",
				botUserId: "100000000000000005",
				botToken: "lead-token",
				voiceModes,
				realtimeVoice: "marin",
				match: { labels: [projectName] },
			},
		],
	};
}

function fixture(status = "live") {
	const root = mkdtempSync(join(tmpdir(), "flywheel-voice-start-"));
	cleanup.push(root);
	const stateDir = join(root, "meeting-state");
	mkdirSync(stateDir);
	writeFileSync(
		join(stateDir, "meeting.json"),
		JSON.stringify({
			schemaVersion: 2,
			id: MEETING_ID,
			leadId: "raya",
			topic: "Voice meeting",
			scheduledAt: NOW,
			durationMinutes: 30,
			requestedBy: "founder",
			requestedAt: NOW,
			status,
			...(new Set(["ended", "cancelled", "missed"]).has(status)
				? { endedAt: NOW }
				: {}),
		}),
	);
	const configPath = join(root, "meeting-notes.yaml");
	writeFileSync(
		configPath,
		`meetingStateDir: ${stateDir}\nlinear:\n  team: FLY\n  project: Flywheel\n  meetingLabel: meeting\n  departmentLabel: dept\ndispatch:\n  taskCategory: prd\n  leadId: raya\ntickIntervalSeconds: 30\n`,
	);
	const host: VoiceHostConfig = {
		schemaVersion: 1,
		qaVoiceChannelIds: [],
		qaAllowUserIds: [],
		evidenceRoots: [root],
	};
	return { root, stateDir: realpathSync(stateDir), configPath, host };
}

function resolver(input: {
	projects?: ProjectEntry[];
	status?: string;
	preflight?: (input: VoiceStartPreflightInput) => void | Promise<void>;
}) {
	const files = fixture(input.status);
	return {
		files,
		resolve: createVoiceStartResolver({
			projects: input.projects ?? [project("raya", "raya")],
			voiceHost: files.host,
			meetingConfigPath: files.configPath,
			env: {
				VOICE_BOT_TOKEN: "voice-token",
				EARS_BOT_TOKEN: "ears-token",
			},
			preflight: input.preflight ?? (() => {}),
			newSessionId: () => SESSION_ID,
			now: () => NOW,
		}),
	};
}

describe("voice session start resolver", () => {
	it("derives the canonical meeting intent and preflights before reservation", async () => {
		const preflight = vi.fn();
		const { resolve, files } = resolver({ preflight });
		await expect(resolve({ meetingId: MEETING_ID }, "ingest")).resolves.toEqual(
			{
				sessionId: SESSION_ID,
				mode: "meeting",
				projectName: "raya",
				leadId: "raya",
				guildId: "100000000000000001",
				voiceChannelId: "100000000000000002",
				meetingId: MEETING_ID,
				evidenceDir: files.stateDir,
				topic: "Voice meeting",
				requestedBy: "ingest",
				credentialTier: "ingest",
				createdAt: NOW,
			},
		);
		expect(preflight).toHaveBeenCalledWith(
			expect.objectContaining({
				mode: "meeting",
				voiceBotToken: "voice-token",
				earsBotToken: "ears-token",
			}),
		);
	});

	it("fails closed for invalid current meeting state and ambiguous global lead", async () => {
		await expect(
			resolver({ status: "ended" }).resolve(
				{ meetingId: MEETING_ID },
				"master",
			),
		).rejects.toMatchObject({ status: 400, code: "meeting_invalid" });
		await expect(
			resolver({
				projects: [project("one", "raya"), project("two", "raya")],
			}).resolve({ meetingId: MEETING_ID }, "master"),
		).rejects.toMatchObject({ status: 400, code: "lead_ambiguous" });
	});

	it("keeps RG off unless the exact Lead opts in", async () => {
		const { resolve } = resolver({});
		await expect(
			resolve({ mode: "rg", projectName: "raya", leadId: "raya" }, "master"),
		).rejects.toMatchObject({ status: 403, code: "voice_mode_not_enabled" });
		const enabled = resolver({
			projects: [project("raya", "raya", { meeting: true, rg: true })],
		});
		await expect(
			enabled.resolve(
				{ mode: "rg", projectName: "raya", leadId: "raya", topic: "walk" },
				"master",
			),
		).resolves.toMatchObject({ mode: "rg", topic: "walk" });
	});

	it("rejects unknown fields, missing bot configuration, and escaped evidence", async () => {
		const { resolve } = resolver({});
		await expect(
			resolve({ meetingId: MEETING_ID, projectName: "raya" }, "master"),
		).rejects.toMatchObject({ status: 400, code: "voice_request_invalid" });
		const noHuddle = project("raya", "raya", { rg: true });
		noHuddle.huddle = null;
		await expect(
			resolver({ projects: [noHuddle] }).resolve(
				{ mode: "rg", projectName: "raya", leadId: "raya" },
				"master",
			),
		).rejects.toMatchObject({ status: 503, reason: "huddle_missing" });
		await expect(
			resolve(
				{
					mode: "meeting",
					projectName: "raya",
					leadId: "raya",
					evidenceDir: "/private/tmp/outside-evidence",
				},
				"master",
			),
		).rejects.toMatchObject({ status: 400, code: "evidence_dir_rejected" });
	});
});

it.each([
	{ label: "D", mode: "meeting", modes: undefined, status: 201 },
	{ label: "E", mode: "meeting", modes: { meeting: false }, status: 403 },
	{ label: "F", mode: "meeting", modes: { meeting: true }, status: 201 },
	{
		label: "missing meeting key",
		mode: "meeting",
		modes: { rg: false },
		status: 201,
	},
	{ label: "RG missing", mode: "rg", modes: undefined, status: 403 },
	{ label: "RG false", mode: "rg", modes: { rg: false }, status: 403 },
	{ label: "RG true", mode: "rg", modes: { rg: true }, status: 201 },
])("$label: HTTP $mode returns $status", async ({ mode, modes, status }) => {
	const entry = project("raya", "raya");
	if (modes === undefined) delete entry.leads[0].voiceModes;
	else entry.leads[0].voiceModes = modes;
	const { resolve, files } = resolver({ projects: [entry] });
	const store = await StateStore.create(join(files.root, "test.db"));
	const app = express();
	app.use(express.json());
	app.use(
		"/",
		voiceSessionAuthMiddleware("test-master", "test-ingest"),
		createVoiceSessionRouter({
			store,
			leaseTtlMs: 15_000,
			now: () => NOW,
			newSessionId: () => SESSION_ID,
			resolveStart: resolve,
			provisionSession: () => {},
			reportAbandoned: () => {},
			projectSession: () => ({}),
		}),
	);
	const server = createServer(app);
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	try {
		const response = await fetch(
			`http://127.0.0.1:${(server.address() as AddressInfo).port}`,
			{
				method: "POST",
				headers: {
					authorization: "Bearer test-master",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					mode,
					projectName: "raya",
					leadId: "raya",
					evidenceDir: files.stateDir,
				}),
			},
		);
		expect(await response.json()).toMatchObject(
			status === 201
				? { sessionId: SESSION_ID }
				: { error: "voice_mode_not_enabled" },
		);
		expect(response.status).toBe(status);
		expect(store.getVoiceSession(SESSION_ID)?.state).toBe(
			status === 201 ? "provisioning" : undefined,
		);
	} finally {
		await new Promise<void>((done) => server.close(() => done()));
		store.close();
	}
});

it("rejects disabled mode before an escaped ops evidence directory", async () => {
	const preflight = vi.fn();
	const { resolve, files } = resolver({
		projects: [project("raya", "raya", { meeting: false })],
		preflight,
	});
	await expect(
		resolve(
			{
				mode: "meeting",
				projectName: "raya",
				leadId: "raya",
				evidenceDir: join(files.root, "missing"),
			},
			"master",
		),
	).rejects.toMatchObject({ status: 403, code: "voice_mode_not_enabled" });
	expect(preflight).not.toHaveBeenCalled();
});

it.each(["huddle_missing", "bot_env_unset"])(
	"rejects %s before an escaped ops evidence directory",
	async (reason) => {
		const entry = project("raya", "raya");
		if (reason === "huddle_missing") entry.huddle = null;
		else entry.huddle!.orchestratorBotTokenEnv = "MISSING_TEST_TOKEN";
		const preflight = vi.fn();
		const { resolve, files } = resolver({ projects: [entry], preflight });
		await expect(
			resolve(
				{
					mode: "meeting",
					projectName: "raya",
					leadId: "raya",
					evidenceDir: join(files.root, "missing"),
				},
				"master",
			),
		).rejects.toMatchObject({ status: 503, code: "voice_unavailable", reason });
		expect(preflight).not.toHaveBeenCalled();
	},
);
