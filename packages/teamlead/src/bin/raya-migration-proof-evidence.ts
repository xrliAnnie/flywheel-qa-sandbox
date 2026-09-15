import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { installSqlTiming } from "flywheel-config";
import {
	discordJson,
	discordMessage,
	type MigrationIO,
} from "./raya-migration-io.js";

const ID = /^[0-9]{17,20}$/;
const snowflakeTime = (id: string) =>
	Number((BigInt(id) >> 22n) + 1420070400000n);

export async function readAlertEvidence(input: {
	io: MigrationIO;
	flywheelDir: string;
	migrationId: string;
	channelId: string;
	botId: string;
	token: string;
	activatedAt: string;
	wait?: (ms: number) => Promise<void>;
}): Promise<{ discord_message_id: string }> {
	const { io, channelId, botId, token, migrationId } = input;
	if (
		!ID.test(channelId) ||
		!ID.test(botId) ||
		!migrationId ||
		migrationId.length > 200
	)
		throw new Error("alert-evidence-input-invalid");
	let status: string;
	try {
		status = (
			await io.run("bash", [
				join(input.flywheelDir, "scripts/lead-alert.sh"),
				"--project",
				"raya",
				"--lead",
				"raya",
				"--kind",
				"activation_probe",
				"--severity",
				"info",
				"--title",
				"Raya activation probe",
				"--body",
				migrationId,
				"--signature",
				`raya-activation-probe-${migrationId}`,
				"--strict-delivery",
			])
		).trim();
	} catch (error) {
		status =
			typeof (error as { stdout?: unknown }).stdout === "string"
				? String((error as { stdout: string }).stdout).trim()
				: "";
		if (status !== "queued_transient")
			throw new Error("alert-delivery-unproven");
	}
	const direct = /^sent message_id=([0-9]{17,20})$/.exec(status)?.[1];
	if (!direct && status !== "sent" && status !== "queued_transient")
		throw new Error("alert-delivery-unproven");
	const matches = (raw: unknown) => {
		const message = discordMessage(raw);
		const embeds = (
			raw as { embeds?: Array<{ title?: string; description?: string }> }
		).embeds;
		const text = [
			message.content,
			...(Array.isArray(embeds)
				? embeds.flatMap((embed) => [
						embed.title ?? "",
						embed.description ?? "",
					])
				: []),
		].join("\n");
		return message.channel_id === channelId &&
			message.author.id === botId &&
			message.author.bot === true &&
			snowflakeTime(message.id) >= Date.parse(input.activatedAt) &&
			text.includes("Raya activation probe") &&
			text.includes(migrationId)
			? message.id
			: null;
	};
	if (direct) {
		const found = matches(
			await discordJson(io, `/channels/${channelId}/messages/${direct}`, token),
		);
		if (found !== direct) throw new Error("alert-delivery-unproven");
		return { discord_message_id: direct };
	}
	// Existing queued delivery drains asynchronously. A queue/claim alone is
	// never proof; bounded REST lookup must find the actual unique marker.
	for (let attempt = 0; attempt < 5; attempt++) {
		if (attempt) await (input.wait ?? delay)(2000);
		const raw = await discordJson(
			io,
			`/channels/${channelId}/messages?limit=100`,
			token,
		);
		if (!Array.isArray(raw)) throw new Error("alert-delivery-unproven");
		const ids = raw.map(matches).filter((id): id is string => id !== null);
		if (ids.length === 1) return { discord_message_id: ids[0]! };
		if (ids.length > 1) throw new Error("alert-delivery-ambiguous");
	}
	throw new Error("alert-delivery-unproven");
}

export async function readTuiEvidence(input: {
	io: MigrationIO;
	home: string;
	flywheelDir: string;
	workspace: string;
	threadId: string;
	processStartedAt: string;
}): Promise<{ panePid: number; paneStartedAt: string }> {
	if (!/^[A-Za-z0-9-]+$/.test(input.threadId))
		throw new Error("tui-thread-invalid");
	const codexHome = join(input.home, ".codex-raya");
	await input.io.run("bash", [
		join(
			input.flywheelDir,
			"packages/teamlead/scripts/verify-windowed-lead.sh",
		),
		"raya",
		"raya",
		"--codex-home",
		codexHome,
		"--log",
		join(input.home, ".flywheel/logs/lead-raya-raya.log"),
	]);
	const paneOutput = (
		await input.io.run("tmux", [
			"-u",
			"list-panes",
			"-t",
			"=flywheel:=raya-raya",
			"-F",
			"#{window_name}|#{pane_dead}|#{pane_pid}|#{pane_start_command}",
		])
	).trim();
	// Printable separators survive tmux's locale-dependent output sanitizing.
	// Keep pipes inside the command, but refuse multiple pane rows.
	const pane =
		paneOutput.match(/^([^|]*)\|([^|]*)\|([^|]*)\|([^\r\n]*)$/)?.slice(1) ?? [];
	if (
		pane.length !== 4 ||
		pane[0] !== "raya-raya" ||
		pane[1] !== "0" ||
		!/^[1-9][0-9]*$/.test(pane[2]!) ||
		!Number.isSafeInteger(Number(pane[2]))
	)
		throw new Error("tui-pane-invalid");
	// tmux serializes the launch command as shell-quoted argv. Decode only;
	// never execute the command collected from the pane.
	const argv: unknown = JSON.parse(
		await input.io.run("python3", [
			"-c",
			"import json,shlex,sys; print(json.dumps(shlex.split(sys.argv[1])))",
			pane[3]!,
		]),
	);
	if (!Array.isArray(argv) || argv.length !== 1 || typeof argv[0] !== "string")
		throw new Error("tui-thread-binding-invalid");
	const command = argv[0];
	if (
		!command.startsWith(`CODEX_HOME="${codexHome}" `) ||
		!command.includes(
			` --remote "unix://${codexHome}/app-server-control/app-server-control.sock" `,
		) ||
		!command.includes(` -C "${input.workspace}" `) ||
		!command.endsWith(` ${input.threadId}`)
	)
		throw new Error("tui-thread-binding-invalid");
	const started = Date.parse(
		(await input.io.run("ps", ["-o", "lstart=", "-p", pane[2]!])).trim(),
	);
	if (!(started > Date.parse(input.processStartedAt)))
		throw new Error("tui-process-binding-invalid");
	return {
		panePid: Number(pane[2]),
		paneStartedAt: new Date(started).toISOString(),
	};
}

export async function readChatEvidence(input: {
	io: MigrationIO;
	home: string;
	flywheelDir: string;
	stateDir: string;
	messageId: string;
	channelId: string;
	botId: string;
	token: string;
	activatedAt: string;
	windowProbeAuthorId?: string;
	windowProbeNonce?: string;
}): Promise<{ deliveryId: string; outboundMessageId: string }> {
	const { io, messageId, channelId, botId, token } = input,
		activated = Date.parse(input.activatedAt);
	if (
		![messageId, channelId, botId].every((id) => ID.test(id)) ||
		!Number.isFinite(activated)
	)
		throw new Error("chat-evidence-input-invalid");
	const deliveryId = `chat:raya:${messageId}`;
	const status = JSON.parse(
		await io.run(process.execPath, [
			join(input.flywheelDir, "packages/flywheel-comm/dist/index.js"),
			"message-status",
			deliveryId,
			"--db",
			join(input.home, ".flywheel/comm/raya/comm.db"),
			"--json",
			"--with-envelope",
		]),
	);
	if (
		!["live", "archived"].includes(status.location) ||
		status.message_id !== deliveryId ||
		status.state !== "ACKED" ||
		!(Date.parse(status.stamps?.delivered_at) >= activated)
	)
		throw new Error("mailbox-evidence-invalid");
	const original = discordMessage(
		await discordJson(
			io,
			`/channels/${channelId}/messages/${messageId}`,
			token,
		),
	);
	if (
		original.id !== messageId ||
		original.channel_id !== channelId ||
		status.authorId !== original.author.id ||
		(input.windowProbeAuthorId
			? original.author.id !== input.windowProbeAuthorId ||
				original.author.bot !== true ||
				!input.windowProbeNonce ||
				original.content !==
					`[FLY-2445 cutover window probe ${input.windowProbeNonce}] Raya，请回复一句确认收到。`
			: original.author.bot === true || snowflakeTime(messageId) < activated)
	)
		throw new Error("inbound-identity-mismatch");
	const outbound = JSON.parse(
		await io.run(process.execPath, [
			join(
				input.flywheelDir,
				"packages/teamlead/dist/bin/inspect-lead-outbound.js",
			),
			"--state-dir",
			input.stateDir,
			"--delivery-id",
			deliveryId,
			"--dedup-db",
			join(input.home, ".flywheel/codex-lead-outbound-dedup.db"),
		]),
	);
	if (
		outbound.ok !== true ||
		outbound.deliveryId !== deliveryId ||
		outbound.journalState !== "completed" ||
		outbound.outboxStatus !== "sent" ||
		outbound.bridgeStatus !== "sent" ||
		typeof outbound.messageId !== "string" ||
		!ID.test(outbound.messageId) ||
		snowflakeTime(outbound.messageId) < activated
	)
		throw new Error("outbound-evidence-invalid");
	const reply = discordMessage(
		await discordJson(
			io,
			`/channels/${channelId}/messages/${outbound.messageId}`,
			token,
		),
	);
	if (
		reply.id !== outbound.messageId ||
		reply.channel_id !== channelId ||
		reply.author.id !== botId ||
		reply.author.bot !== true
	)
		throw new Error("outbound-identity-mismatch");
	return { deliveryId, outboundMessageId: reply.id };
}

export function readSummaryEvidence(
	path: string,
	activatedAt: string,
): { roundId: string; deliveryId: string } {
	const activated = Date.parse(activatedAt);
	if (!Number.isFinite(activated)) throw new Error("activation-invalid");
	const db = installSqlTiming(
		new Database(path, { readonly: true, fileMustExist: true }),
		"teamlead",
	);
	try {
		db.pragma("query_only = ON");
		// enqueueLeadEvent persists the event type and derives this delivery id.
		// Its content is rendered prose, not the HTTP transport event envelope.
		const rows = db
			.prepare(`SELECT id, delivery_id, created_at, delivered_at FROM mailbox
      WHERE to_agent = ? AND recipient_kind = ? AND source_kind = ? AND type = ?
      AND state = ? AND delivered_at IS NOT NULL ORDER BY delivered_at DESC LIMIT 100`)
			.all(
				"raya",
				"lead",
				"lead_event",
				"summary_absorption_round",
				"ACKED",
			) as Array<{
			id: string;
			delivery_id: string;
			created_at: string;
			delivered_at: string;
		}>;
		for (const row of rows) {
			const prefix = "lead_event:raya:summary-absorption:";
			if (row.id !== row.delivery_id || !row.id.startsWith(prefix)) continue;
			const slot = row.id.slice(prefix.length),
				slotMs = Date.parse(slot);
			if (
				!Number.isFinite(slotMs) ||
				new Date(slotMs).toISOString() !== slot ||
				slotMs < activated ||
				!(Date.parse(row.created_at) >= activated) ||
				!(Date.parse(row.delivered_at) >= Date.parse(row.created_at))
			)
				continue;
			return {
				roundId: row.id.slice("lead_event:raya:".length),
				deliveryId: row.delivery_id,
			};
		}
		throw new Error("summary-evidence-missing");
	} finally {
		db.close();
	}
}
