import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
	closeoutFounderChannels,
	type RestartContextIo,
} from "./restart-request.js";

const founderId = "10000000000000001";
const leadId = "flywheel-eng-lead";
const intentAt = "2026-09-20T20:00:00.000Z";

function envelope(input: {
	messageId: string;
	chatId: string;
	originChannelId: string;
	timestamp?: string;
}): string {
	return `[discord-chat-delivery v1] ${JSON.stringify({
		v: 1,
		deliveryId: `chat:${leadId}:${input.messageId}`,
		leadId,
		chatId: input.chatId,
		originChannelId: input.originChannelId,
		messageId: input.messageId,
		authorId: founderId,
		authorName: "Founder",
		ts: input.timestamp ?? "2026-09-20T20:01:00.000Z",
		priority: 1,
		msgKind: "dm",
		attachments: [],
		text: "context",
	})}\nFounder: context`;
}

describe("closeout founder context channel census", () => {
	let root = "";
	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it("unions configured channels, active issue threads, and durable mailbox routes", () => {
		root = mkdtempSync(join(tmpdir(), "fly2654-founder-context-"));
		const home = join(root, "home");
		const flywheelHome = join(home, ".flywheel");
		const commDir = join(flywheelHome, "comm", "flywheel");
		mkdirSync(commDir, { recursive: true });
		const projectsPath = join(flywheelHome, "projects.json");
		writeFileSync(
			projectsPath,
			JSON.stringify([
				{
					projectName: "flywheel",
					generalChannel: "10000000000000011",
					leads: [
						{
							agentId: leadId,
							chatChannel: "10000000000000012",
							alertChannel: "10000000000000013",
						},
					],
				},
			]),
			{ mode: 0o600 },
		);

		const state = new Database(join(flywheelHome, "teamlead.db"));
		state.exec(`
			CREATE TABLE sessions (
				execution_id TEXT, issue_id TEXT, project_name TEXT, terminal_at TEXT
			);
			CREATE TABLE chat_threads (
				thread_id TEXT, issue_id TEXT, archived_at TEXT, discord_missing_at TEXT
			);
			CREATE TABLE phase_chat_threads (
				thread_id TEXT, issue_id TEXT, archived_at TEXT, discord_missing_at TEXT
			);
			INSERT INTO sessions VALUES ('exec-1','issue-1','flywheel',NULL);
			INSERT INTO chat_threads VALUES ('10000000000000014','issue-1',NULL,NULL);
			INSERT INTO phase_chat_threads VALUES ('10000000000000015','issue-1',NULL,NULL);
		`);
		state.close();

		const commPath = join(commDir, "comm.db");
		const comm = new Database(commPath);
		comm.exec(`
			CREATE TABLE mailbox (
				content TEXT, source_kind TEXT, from_agent TEXT, to_agent TEXT, created_at TEXT
			);
			CREATE TABLE mailbox_terminal_archive (mailbox_json TEXT);
		`);
		comm.prepare("INSERT INTO mailbox VALUES (?,?,?,?,?)").run(
			envelope({
				messageId: "10000000000000021",
				chatId: "10000000000000016",
				originChannelId: "10000000000000017",
			}),
			"discord_chat",
			"founder",
			leadId,
			"2026-09-20T20:01:00.000Z",
		);
		comm.prepare("INSERT INTO mailbox_terminal_archive VALUES (?)").run(
			JSON.stringify({
				content: envelope({
					messageId: "10000000000000022",
					chatId: "10000000000000018",
					originChannelId: "10000000000000019",
				}),
				source_kind: "discord_chat",
				from_agent: "founder",
				to_agent: leadId,
				created_at: "2026-09-20T20:01:00.000Z",
			}),
		);
		comm.prepare("INSERT INTO mailbox VALUES (?,?,?,?,?)").run(
			envelope({
				messageId: "10000000000000023",
				chatId: "10000000000000020",
				originChannelId: "10000000000000020",
				timestamp: "2026-09-19T20:01:00.000Z",
			}),
			"discord_chat",
			"founder",
			leadId,
			"2026-09-19T20:01:00.000Z",
		);
		comm.close();

		const io: RestartContextIo = {
			fetch,
			readFile: (path) => readFileSync(path, "utf8"),
			lstat: lstatSync,
			processAlive: () => true,
			now: () => Date.parse("2026-09-20T20:02:00.000Z"),
		};
		const channels = closeoutFounderChannels({
			projectsPath,
			home,
			requestedBy: {
				projectName: "flywheel",
				leadId,
				instanceId: "current",
				botUserId: "10000000000000002",
			},
			boundChannels: ["10000000000000010"],
			founderId,
			intentAt,
			io,
		});
		expect(channels).toEqual(
			Array.from({ length: 11 }, (_, index) =>
				(10000000000000010n + BigInt(index)).toString(),
			),
		);

		const malformed = new Database(commPath);
		malformed
			.prepare("INSERT INTO mailbox VALUES (?,?,?,?,?)")
			.run("not-an-envelope", "discord_chat", "founder", leadId, intentAt);
		malformed.close();
		expect(() =>
			closeoutFounderChannels({
				projectsPath,
				home,
				requestedBy: {
					projectName: "flywheel",
					leadId,
					instanceId: "current",
					botUserId: "10000000000000002",
				},
				boundChannels: ["10000000000000010"],
				founderId,
				intentAt,
				io,
			}),
		).toThrow("restart-request-withdrawal-context-incomplete");
	});
});
