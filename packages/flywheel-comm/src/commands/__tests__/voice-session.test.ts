import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runVoiceSessionCommand } from "../voice-session.js";

const cleanup: string[] = [];

afterEach(() => {
	for (const path of cleanup.splice(0)) rmSync(path, { recursive: true });
});

function meetingStateFixture(): { configPath: string; stateDir: string } {
	const root = mkdtempSync(join(tmpdir(), "flywheel-voice-session-"));
	cleanup.push(root);
	const lexicalStateDir = join(root, "state");
	mkdirSync(lexicalStateDir);
	const stateDir = realpathSync(lexicalStateDir);
	const configPath = join(root, "meeting-notes.yaml");
	writeFileSync(configPath, `meetingStateDir: ${stateDir}\n`);
	return { configPath, stateDir };
}

function response(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("voice-session", () => {
	it("starts a canonical meeting without sending the local state path", async () => {
		const { configPath, stateDir } = meetingStateFixture();
		const fetchImpl = vi.fn(async () =>
			response(201, { ok: true, sessionId: "session-1", state: "desired" }),
		);
		const stdout: string[] = [];
		const stderr: string[] = [];

		expect(
			await runVoiceSessionCommand(
				[
					"start",
					"--meeting-id",
					"019caa85-d0d4-7f66-9d2f-5e2ffefcf417",
					"--state-dir",
					stateDir,
					"--json",
				],
				{
					env: {
						FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9876/",
						FLYWHEEL_MEETING_NOTES_CONFIG: configPath,
						TEAMLEAD_API_TOKEN: "master-token",
						FLYWHEEL_INGEST_TOKEN: "ingest-token",
					},
					fetchImpl: fetchImpl as typeof fetch,
					stdout: (line) => stdout.push(line),
					stderr: (line) => stderr.push(line),
				},
			),
		).toBe(0);
		expect(fetchImpl).toHaveBeenCalledWith(
			"http://127.0.0.1:9876/api/voice/sessions",
			expect.objectContaining({
				method: "POST",
				headers: {
					Authorization: "Bearer master-token",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					meetingId: "019caa85-d0d4-7f66-9d2f-5e2ffefcf417",
				}),
			}),
		);
		expect(JSON.parse(stdout[0]!)).toMatchObject({
			ok: true,
			sessionId: "session-1",
			state: "desired",
		});
		expect(stderr).toEqual([]);
	});

	it("rejects local meeting state drift before contacting Bridge", async () => {
		const { configPath } = meetingStateFixture();
		const otherStateDir = join(configPath, "..", "other-state");
		mkdirSync(otherStateDir);
		const fetchImpl = vi.fn<typeof fetch>();
		const stderr: string[] = [];

		expect(
			await runVoiceSessionCommand(
				[
					"start",
					"--meeting-id",
					"019caa85-d0d4-7f66-9d2f-5e2ffefcf417",
					"--state-dir",
					otherStateDir,
				],
				{
					env: {
						FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9876",
						TEAMLEAD_API_TOKEN: "master-token",
						FLYWHEEL_MEETING_NOTES_CONFIG: configPath,
					},
					fetchImpl,
					stderr: (line) => stderr.push(line),
				},
			),
		).toBe(1);
		expect(stderr).toEqual(["voice-session: state_dir_drift"]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("starts an explicitly targeted RG session", async () => {
		const fetchImpl = vi.fn(async () =>
			response(201, { ok: true, sessionId: "session-rg" }),
		);
		const stdout: string[] = [];

		expect(
			await runVoiceSessionCommand(
				[
					"start",
					"--mode",
					"rg",
					"--project",
					"raya",
					"--lead",
					"raya",
					"--topic",
					"Morning walk",
				],
				{
					env: {
						BRIDGE_URL: "http://127.0.0.1:9876",
						FLYWHEEL_INGEST_TOKEN: "ingest-token",
					},
					fetchImpl: fetchImpl as typeof fetch,
					stdout: (line) => stdout.push(line),
				},
			),
		).toBe(0);
		expect(
			JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string),
		).toEqual({
			mode: "rg",
			projectName: "raya",
			leadId: "raya",
			topic: "Morning walk",
		});
		expect(JSON.parse(stdout[0]!)).toMatchObject({ sessionId: "session-rg" });
	});

	it("resolves a meeting before stopping its active session", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				response(200, { ok: true, sessionId: "session-meeting" }),
			)
			.mockResolvedValueOnce(
				response(200, {
					ok: true,
					sessionId: "session-meeting",
					state: "ending",
				}),
			);
		const stdout: string[] = [];

		expect(
			await runVoiceSessionCommand(
				["stop", "--meeting-id", "019caa85-d0d4-7f66-9d2f-5e2ffefcf417"],
				{
					env: {
						FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9876",
						TEAMLEAD_API_TOKEN: "master-token",
					},
					fetchImpl,
					stdout: (line) => stdout.push(line),
				},
			),
		).toBe(0);
		expect(
			fetchImpl.mock.calls.map(([url, init]) => [url, init?.method]),
		).toEqual([
			[
				"http://127.0.0.1:9876/api/voice/sessions/by-meeting/019caa85-d0d4-7f66-9d2f-5e2ffefcf417",
				"GET",
			],
			["http://127.0.0.1:9876/api/voice/sessions/session-meeting/stop", "POST"],
		]);
		expect(JSON.parse(stdout[0]!)).toMatchObject({ state: "ending" });
	});

	it("reads status directly by session id", async () => {
		const fetchImpl = vi.fn(async () =>
			response(200, { ok: true, sessionId: "session-1", state: "live" }),
		);
		const stdout: string[] = [];

		expect(
			await runVoiceSessionCommand(["status", "--session", "session-1"], {
				env: {
					FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9876",
					TEAMLEAD_API_TOKEN: "master-token",
				},
				fetchImpl: fetchImpl as typeof fetch,
				stdout: (line) => stdout.push(line),
			}),
		).toBe(0);
		expect(fetchImpl).toHaveBeenCalledWith(
			"http://127.0.0.1:9876/api/voice/sessions/session-1",
			expect.objectContaining({ method: "GET" }),
		);
		expect(JSON.parse(stdout[0]!)).toMatchObject({ state: "live" });
	});

	it("distinguishes Bridge transport failures from usage errors", async () => {
		const stderr: string[] = [];
		expect(
			await runVoiceSessionCommand(
				["start", "--meeting-id", "019caa85-d0d4-7f66-9d2f-5e2ffefcf417"],
				{
					env: {
						FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9876",
						TEAMLEAD_API_TOKEN: "master-token",
					},
					fetchImpl: vi.fn(async () => {
						throw new Error("offline");
					}) as typeof fetch,
					stderr: (line) => stderr.push(line),
				},
			),
		).toBe(2);
		expect(stderr).toEqual(["voice-session: request failed: offline"]);
	});

	it("rejects a relative meeting state path before contacting Bridge", async () => {
		const fetchImpl = vi.fn<typeof fetch>();
		const stderr: string[] = [];
		expect(
			await runVoiceSessionCommand(
				[
					"start",
					"--meeting-id",
					"019caa85-d0d4-7f66-9d2f-5e2ffefcf417",
					"--state-dir",
					"relative/meeting-state",
				],
				{
					env: {
						FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9876",
						TEAMLEAD_API_TOKEN: "master-token",
					},
					fetchImpl,
					stderr: (line) => stderr.push(line),
				},
			),
		).toBe(1);
		expect(stderr).toEqual(["voice-session: --state-dir must be absolute"]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
