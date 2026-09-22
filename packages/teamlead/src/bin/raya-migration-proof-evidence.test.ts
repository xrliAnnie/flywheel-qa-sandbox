import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { discordSnowflake, type MigrationIO } from "./raya-migration-io.js";
import {
	readAlertEvidence,
	readChatEvidence,
	readSummaryEvidence,
	readTuiEvidence,
} from "./raya-migration-proof-evidence.js";

const roots: string[] = [];
afterEach(() =>
	roots
		.splice(0)
		.forEach((root) => rmSync(root, { recursive: true, force: true })),
);
const activated = "2026-09-13T00:00:00Z";

it("reads real tmux quoting and printable separators without locale on an isolated socket", async () => {
	const root = mkdtempSync(join(tmpdir(), "raya-tui-real-"));
	roots.push(root);
	const socket = join(root, "socket");
	const codex = join(root, "codex");
	writeFileSync(codex, "#!/bin/sh\nexec sleep 60\n", { mode: 0o700 });
	const home = join(root, "home with spaces");
	const workspace = join(root, "workspace with spaces | pipe");
	const environment = { ...process.env };
	for (const key of Object.keys(environment))
		if (key === "LANG" || key.startsWith("LC_")) delete environment[key];
	const command = `CODEX_HOME="${home}/.codex-raya" "${codex}" resume --remote "unix://${home}/.codex-raya/app-server-control/app-server-control.sock" -C "${workspace}" thread-current`;
	const tmux = (args: string[]) =>
		execFileSync("tmux", ["-S", socket, ...args], {
			encoding: "utf8",
			env: environment,
		});
	try {
		tmux([
			"-f",
			"/dev/null",
			"new-session",
			"-d",
			"-s",
			"flywheel",
			"-n",
			"raya-raya",
			command,
		]);
		const input = {
			io: {
				now: Date.now,
				fetch,
				run: async (file: string, args: string[]) =>
					file === "bash"
						? "PASS"
						: file === "tmux"
							? tmux(args)
							: file === "ps"
								? // This integration test proves tmux serialization; process
									// evidence remains independently checked below.
									"2026-09-13T00:00:02Z"
								: execFileSync(file, args, { encoding: "utf8" }),
			},
			home,
			workspace,
			flywheelDir: root,
			threadId: "thread-current",
			processStartedAt: activated,
		};
		expect((await readTuiEvidence(input)).panePid).toBeGreaterThan(0);
		// The printable delimiter works independently of tmux's UTF-8 switch.
		expect(
			(
				await readTuiEvidence({
					...input,
					io: {
						...input.io,
						run: (file, args) =>
							input.io.run(
								file,
								file === "tmux" ? args.filter((arg) => arg !== "-u") : args,
							),
					},
				})
			).panePid,
		).toBeGreaterThan(0);
		await expect(
			readTuiEvidence({ ...input, threadId: "thread-other" }),
		).rejects.toThrow("tui-thread-binding-invalid");
		await expect(
			readTuiEvidence({ ...input, workspace: `${workspace}-other` }),
		).rejects.toThrow("tui-thread-binding-invalid");
		await expect(
			readTuiEvidence({ ...input, home: `${home}-other` }),
		).rejects.toThrow("tui-thread-binding-invalid");
		await expect(
			readTuiEvidence({
				...input,
				processStartedAt: new Date(Date.now() + 60_000).toISOString(),
			}),
		).rejects.toThrow("tui-process-binding-invalid");
	} finally {
		tmux(["kill-server"]);
	}
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "raya-proof-evidence-"));
	roots.push(root);
	const path = join(root, "comm.db"),
		db = new Database(path);
	db.exec(`CREATE TABLE mailbox (id TEXT, delivery_id TEXT, to_agent TEXT, recipient_kind TEXT, source_kind TEXT,
    type TEXT, kind TEXT, state TEXT, created_at TEXT, delivered_at TEXT)`);
	const add = (overrides: Record<string, unknown> = {}) => {
		const row = {
			id: "lead_event:raya:summary-absorption:2026-09-13T06:00:00.000Z",
			delivery_id:
				"lead_event:raya:summary-absorption:2026-09-13T06:00:00.000Z",
			to_agent: "raya",
			recipient_kind: "lead",
			source_kind: "lead_event",
			type: "summary_absorption_round",
			kind: null,
			state: "ACKED",
			created_at: "2026-09-13T06:00:00Z",
			delivered_at: "2026-09-13T06:00:01Z",
			...overrides,
		};
		db.prepare(
			`INSERT INTO mailbox (${Object.keys(row).join(",")}) VALUES (${Object.keys(
				row,
			)
				.map((k) => `@${k}`)
				.join(",")})`,
		).run(row);
	};
	return { path, db, add };
}
it("reads the real mailbox producer type and exact delivery id without changing the database", () => {
	const f = fixture();
	f.add();
	const version = f.db.pragma("data_version", { simple: true });
	expect(readSummaryEvidence(f.path, activated)).toEqual({
		roundId: "summary-absorption:2026-09-13T06:00:00.000Z",
		deliveryId: "lead_event:raya:summary-absorption:2026-09-13T06:00:00.000Z",
	});
	expect(f.db.pragma("data_version", { simple: true })).toBe(version);
	f.db.close();
});
it.each([
	{ type: "event", kind: "summary_absorption_round" },
	{ to_agent: "another-lead" },
	{ state: "LEASED", delivered_at: null },
	{ created_at: "2026-09-12T23:00:00Z", delivered_at: "2026-09-12T23:00:01Z" },
	{ delivery_id: "lead_event:raya:foreign", id: "foreign" },
])("rejects absent or unrelated summary evidence: %j", (overrides) => {
	const f = fixture();
	f.add(overrides);
	expect(() => readSummaryEvidence(f.path, activated)).toThrow(
		"summary-evidence-missing",
	);
	f.db.close();
});

it("requires an ACK and exact journal-derived outbound with the registered Discord author", async () => {
	const inputId = discordSnowflake(Date.parse(activated) + 1000),
		outputId = discordSnowflake(Date.parse(activated) + 2000);
	const bot = "123456789012345678",
		channel = "223456789012345678",
		human = "323456789012345678";
	let wrongAuthor = false,
		staleAck = false;
	const io: MigrationIO = {
		now: Date.now,
		run: async (_file, args) =>
			JSON.stringify(
				args.includes("message-status")
					? {
							location: "live",
							message_id: `chat:raya:${inputId}`,
							state: "ACKED",
							stamps: {
								delivered_at: staleAck
									? "2026-09-12T00:00:00Z"
									: "2026-09-13T00:00:02Z",
							},
							authorId: human,
						}
					: {
							ok: true,
							deliveryId: `chat:raya:${inputId}`,
							messageId: outputId,
							journalState: "completed",
							outboxStatus: "sent",
							bridgeStatus: "sent",
						},
			),
		fetch: async (url) =>
			Response.json({
				id: String(url).endsWith(outputId) ? outputId : inputId,
				channel_id: channel,
				author: String(url).endsWith(outputId)
					? { id: wrongAuthor ? human : bot, bot: true }
					: { id: human, bot: false },
				content: "fixture",
			}),
	};
	const input = {
		io,
		home: "/fixture",
		flywheelDir: "/fixture/code",
		stateDir: "/fixture/state",
		messageId: inputId,
		channelId: channel,
		botId: bot,
		token: "CANARY",
		activatedAt: activated,
	};
	expect(await readChatEvidence(input)).toEqual({
		deliveryId: `chat:raya:${inputId}`,
		outboundMessageId: outputId,
	});
	wrongAuthor = true;
	await expect(readChatEvidence(input)).rejects.toThrow(
		"outbound-identity-mismatch",
	);
	wrongAuthor = false;
	staleAck = true;
	await expect(readChatEvidence(input)).rejects.toThrow(
		"mailbox-evidence-invalid",
	);
});

it("binds the exact live TUI pane to the current thread, home, workspace and process birth", async () => {
	let start = "2026-09-13T00:00:02Z",
		thread = "thread-current",
		window = "raya-raya",
		dead = "0",
		extra = "";
	const io: MigrationIO = {
		now: Date.now,
		fetch: fetch,
		run: async (file, args) =>
			file === "python3"
				? execFileSync(file, args, { encoding: "utf8" })
				: file === "ps"
					? start
					: file === "tmux"
						? `${window}|${dead}|123|${JSON.stringify(`CODEX_HOME="/fixture/.codex-raya" codex resume --remote "unix:///fixture/.codex-raya/app-server-control/app-server-control.sock" -C "/fixture/workspace" ${thread}`)}${extra}`
						: "PASS",
	};
	const input = {
		io,
		home: "/fixture",
		flywheelDir: "/fixture/code",
		workspace: "/fixture/workspace",
		threadId: thread,
		processStartedAt: activated,
	};
	expect(await readTuiEvidence(input)).toMatchObject({
		panePid: 123,
		paneStartedAt: "2026-09-13T00:00:02.000Z",
	});
	start = "2026-09-12T00:00:00Z";
	await expect(readTuiEvidence(input)).rejects.toThrow(
		"tui-process-binding-invalid",
	);
	start = "2026-09-13T00:00:02Z";
	thread = "thread-old";
	await expect(readTuiEvidence(input)).rejects.toThrow(
		"tui-thread-binding-invalid",
	);
	thread = "thread-current";
	window = "foreign";
	await expect(readTuiEvidence(input)).rejects.toThrow("tui-pane-invalid");
	window = "raya-raya";
	dead = "1";
	await expect(readTuiEvidence(input)).rejects.toThrow("tui-pane-invalid");
	dead = "0";
	extra = " additional-argument";
	await expect(readTuiEvidence(input)).rejects.toThrow(
		"tui-thread-binding-invalid",
	);
	extra = "\nother-pane|0|456|command";
	await expect(readTuiEvidence(input)).rejects.toThrow("tui-pane-invalid");
});

it("uses the real Discord id for both direct and drained activation alerts", async () => {
	const id = discordSnowflake(Date.parse(activated) + 1000),
		bot = "123456789012345678",
		channel = "223456789012345678";
	let queued = false,
		polls = 0,
		waits = 0;
	const message = {
		id,
		channel_id: channel,
		author: { id: bot, bot: true },
		content: "",
		embeds: [
			{ title: "Raya activation probe", description: "migration-fixture" },
		],
	};
	const io: MigrationIO = {
		now: Date.now,
		run: async () => (queued ? "queued_transient" : `sent message_id=${id}`),
		fetch: async () =>
			Response.json(queued ? (++polls === 1 ? [] : [message]) : message),
	};
	const input = {
		io,
		flywheelDir: "/fixture/code",
		migrationId: "migration-fixture",
		channelId: channel,
		botId: bot,
		token: "CANARY",
		activatedAt: activated,
		wait: async () => {
			waits++;
		},
	};
	expect(await readAlertEvidence(input)).toEqual({ discord_message_id: id });
	queued = true;
	expect(await readAlertEvidence(input)).toEqual({ discord_message_id: id });
	expect(waits).toBe(1);
	io.fetch = async () => Response.json([]);
	await expect(readAlertEvidence(input)).rejects.toThrow(
		"alert-delivery-unproven",
	);
});
