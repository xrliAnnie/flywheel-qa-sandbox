#!/usr/bin/env node
// FLY-2446: QA-owned execution over an already installed 529 slot. No bootstrap.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function check(value, reason) {
	if (!value) throw new Error(reason);
}
function contained(root, path) {
	check(typeof path === "string" && isAbsolute(path), "slot_path_required");
	const rel = relative(root, path);
	check(
		rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel),
		"path_outside_slot",
	);
}
function trusted(root, path) {
	contained(root, path);
	let current = root;
	for (const part of relative(root, path).split(sep).filter(Boolean)) {
		current = join(current, part);
		check(!lstatSync(current).isSymbolicLink(), "slot_symlink_rejected");
	}
	contained(root, realpathSync(path));
	return path;
}

export function validateTopology(t) {
	check(t.buildSha === t.expectedHead, "checkout_head_drift");
	check(
		/^\/((private\/)?tmp)\/flywheel-test-slot-[1-9][0-9]*$/.test(t.slotDir),
		"529_slot_directory_required",
	);
	const url = new URL(t.bridgeUrl);
	check(
		url.protocol === "http:" &&
			["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
			!url.username &&
			!url.password &&
			url.pathname === "/",
		"slot_loopback_bridge_required",
	);
	check(
		/^[a-f0-9]{40}$/.test(t.buildSha) &&
			/^[a-f0-9]{64}$/.test(t.voiceBinarySha),
		"exact_build_required",
	);
	for (const field of [
		"dbPath",
		"commDbPath",
		"meetingStateDir",
		"voiceRoot",
		"codexHome",
	])
		contained(t.slotDir, t[field]);
	check(
		t.qaVoiceChannelIds.includes(t.voiceChannelId),
		"529_voice_channel_not_allowlisted",
	);
	check(
		t.leads.length === 2 &&
			t.leads[0].agentId !== t.leads[1].agentId &&
			t.leads[0].backend === "claude-code" &&
			t.leads[1].backend === "codex-app-server",
		"two_distinct_harnesses_required",
	);
	check(t.recorders.length === 2, "two_recorder_env_names_required");
	for (const identity of [...t.leads, ...t.recorders, t.voiceBot]) {
		check(
			/^TEST_BOT_TOKEN_[1-9][0-9]*$/.test(identity.tokenEnv),
			"test_bot_token_env_required",
		);
		const slot = t.slots.find(
			(s) =>
				s.tokenEnvVar === identity.tokenEnv &&
				s.botAppId === identity.botUserId,
		);
		check(
			slot && /^[0-9]{17,20}$/.test(identity.botUserId),
			"529_bot_identity_not_registered",
		);
		if (identity.chatChannel)
			check(
				slot.channelId === identity.chatChannel,
				"529_text_channel_mismatch",
			);
	}
	check(
		new Set([...t.leads, ...t.recorders, t.voiceBot].map((i) => i.botUserId))
			.size === 5,
		"voice_lead_recorder_identities_must_be_distinct",
	);
	return t;
}

export async function runTwoLead(topology, options, deps) {
	validateTopology(topology);
	const result = {
		schemaVersion: 1,
		status: "NOT_RUN",
		trueRoomRun: false,
		qaVerdict: "NOT_EVALUATED",
		buildSha: topology.buildSha,
		voiceBinarySha: topology.voiceBinarySha,
		meetings: [],
		rg: {
			status: "NOT_RUN",
			reason: "requires QA-controlled configuration positive and negative runs",
		},
		usage: {
			status: "NOT_MEASURED",
			reason: "platform credit receipt required",
		},
		limitations: [
			"Dry-run and unit tests do not prove real-room acceptance.",
			"Raya merge does not deploy; updater receipt remains authoritative.",
		],
	};
	if (options.dryRun) return result;
	for (let index = 0; index < 2; index++)
		result.meetings.push(
			await deps.runMeeting(topology.leads[index], topology.recorders[index]),
		);
	result.status = "EVIDENCE_COLLECTED";
	result.trueRoomRun = true;
	return result;
}

export function waveStats(pcm, recordedAtMs, fromMs, toMs) {
	let peak = 0;
	for (let offset = 0; offset + 1 < pcm.length; offset += 2)
		peak = Math.max(peak, Math.abs(pcm.readInt16LE(offset)));
	const first = Math.max(0, Math.floor((fromMs - recordedAtMs) * 48) * 4);
	const last = Math.min(pcm.length, Math.ceil((toMs - recordedAtMs) * 48) * 4);
	let intervalPeak = 0;
	for (let offset = first; offset + 1 < last; offset += 2)
		intervalPeak = Math.max(intervalPeak, Math.abs(pcm.readInt16LE(offset)));
	return {
		sha256: sha(pcm),
		durationSeconds: pcm.length / (48_000 * 4),
		peak,
		intervalPeak,
		audible: peak > 0 && intervalPeak > peak / 10 ** (25 / 20),
	};
}

export function evaluateMeetingEvidence(p) {
	check(
		p.liveObserved && p.session?.state === "ended",
		"live_to_ended_unproven",
	);
	check(
		p.selection?.trusted && p.selection.transcripts?.length > 0,
		"actual_meeting_transcript_empty",
	);
	const delivered = p.mailbox.filter(
		(m) =>
			m.source_kind === "voice" &&
			m.state === "ACKED" &&
			m.delivery_id.startsWith(`chat:${p.session.lead_id}:`) &&
			p.journal.some(
				(j) => j.kind === "ingested" && j.deliveryId === m.delivery_id,
			),
	);
	check(delivered.length > 0, "mailbox_journal_ack_unproven");
	const confirmed = p.outbound.filter(
		(o) =>
			o.author_id === p.leadBotId && o.phase === "confirmed" && o.attempt_token,
	);
	check(
		confirmed.length > 0 &&
			p.audio.length === confirmed.length &&
			p.audio.every((a) => a.audible),
		"confirmed_tts_waveform_unproven",
	);
	return {
		status: "EVIDENCE_COLLECTED",
		sessionId: p.session.session_id,
		meetingId: p.session.meeting_id,
		mailbox: delivered,
		outbound: confirmed,
		transcriptCount: p.selection.transcripts.length,
		audio: p.audio,
	};
}

function parseArgs(argv) {
	const values = {};
	for (let i = 0; i < argv.length; i++) {
		const key = argv[i];
		check(
			[
				"--slot-dir",
				"--raya-cli",
				"--claude-lead",
				"--codex-lead",
				"--claude-recorder-env",
				"--codex-recorder-env",
				"--dry-run",
				"--run",
			].includes(key),
			"unknown_argument",
		);
		check(!Object.hasOwn(values, key), "duplicate_argument");
		values[key] = ["--dry-run", "--run"].includes(key) ? true : argv[++i];
	}
	check(!(values["--run"] && values["--dry-run"]), "choose_run_or_dry_run");
	for (const key of [
		"--slot-dir",
		"--raya-cli",
		"--claude-lead",
		"--codex-lead",
		"--claude-recorder-env",
		"--codex-recorder-env",
	])
		check(
			typeof values[key] === "string" && values[key].length > 0,
			`missing_${key}`,
		);
	return values;
}

async function loadTopology(args) {
	const slotDir = realpathSync(args["--slot-dir"]);
	check(
		/^\/((private\/)?tmp)\/flywheel-test-slot-[1-9][0-9]*$/.test(slotDir),
		"529_slot_directory_required",
	);
	const room = json(trusted(slotDir, join(slotDir, "room-info.json")));
	check(
		realpathSync(room.flywheelRepo) === realpathSync(repo),
		"slot_checkout_root_drift",
	);
	const launch = json(trusted(slotDir, join(slotDir, "bridge-launch.json")));
	const env = Object.fromEntries(
		launch.environment.map((value) => {
			const at = value.indexOf("=");
			return [value.slice(0, at), value.slice(at + 1)];
		}),
	);
	const projects = json(trusted(slotDir, room.flywheelProjectsFile));
	const slots = json(join(homedir(), ".flywheel", "test-slots.json")).slots;
	const rows = projects.flatMap((project) =>
		project.leads.map((lead) => ({ ...lead, project })),
	);
	const leads = [args["--claude-lead"], args["--codex-lead"]].map((id) => {
		const matches = rows.filter((l) => l.agentId === id);
		check(matches.length === 1, "slot_lead_not_unique");
		const l = matches[0];
		return {
			...l,
			backend: l.backend ?? "claude-code",
			tokenEnv: l.botTokenEnv,
		};
	});
	const huddle = leads[0].project.huddle;
	check(
		huddle && leads[1].project.huddle?.voiceChannelId === huddle.voiceChannelId,
		"existing_shared_voice_topology_required",
	);
	const host = json(trusted(slotDir, env.FLYWHEEL_VOICE_HOST_CONFIG));
	const built = (path) => pathToFileURL(join(repo, "packages", path)).href;
	const config = await import(built("teamlead/dist/meeting-notes-config.js"));
	const notes = config.loadMeetingNotesConfig(
		trusted(slotDir, env.FLYWHEEL_MEETING_NOTES_CONFIG),
	);
	const recorder = (tokenEnv) => {
		const slot = slots.find((s) => s.tokenEnvVar === tokenEnv);
		return { tokenEnv, botUserId: slot?.botAppId };
	};
	const topology = {
		slotDir,
		bridgeUrl: room.bridgeUrl,
		buildSha: room.buildSha,
		expectedHead: execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: repo,
			encoding: "utf8",
		}).trim(),
		voiceBinarySha: sha(
			readFileSync(join(repo, "packages/voice-codex/dist/cli.js")),
		),
		guildId: huddle.guildId,
		voiceChannelId: huddle.voiceChannelId,
		qaVoiceChannelIds: host.qaVoiceChannelIds,
		commDbPath: env.FLYWHEEL_COMM_DB,
		dbPath: room.dbPath,
		meetingStateDir: config.canonicalizeMeetingStateDir(notes),
		voiceRoot: env.FLYWHEEL_VOICE_STATE_DIR,
		codexHome: env.FLYWHEEL_VOICE_CODEX_HOME,
		voiceBot: {
			tokenEnv: huddle.orchestratorBotTokenEnv,
			botUserId: huddle.orchestratorBotUserId,
		},
		leads,
		recorders: [
			recorder(args["--claude-recorder-env"]),
			recorder(args["--codex-recorder-env"]),
		],
		slots,
	};
	validateTopology(topology);
	for (const field of [
		"commDbPath",
		"dbPath",
		"meetingStateDir",
		"voiceRoot",
		"codexHome",
	])
		trusted(slotDir, topology[field]);
	check(isAbsolute(args["--raya-cli"]), "raya_cli_absolute_path_required");
	return { topology, room, launch, env, built, rayaCli: args["--raya-cli"] };
}

function readSecret(slotDir, launch, name) {
	const record = launch.secretEnvironment.find((entry) => entry.name === name);
	check(record, "slot_secret_not_installed");
	const path = trusted(slotDir, record.path);
	check((lstatSync(path).mode & 0o777) === 0o600, "slot_secret_not_private");
	const value = readFileSync(path, "utf8").trim();
	check(value, "slot_secret_empty");
	return value;
}

async function recordVoice(deps, t, identity, token) {
	const client = deps.createClient();
	let connection;
	let stream;
	let decoder;
	const chunks = [];
	let recordedAtMs;
	try {
		const ready = new Promise((resolve, reject) => {
			client.once("clientReady", resolve);
			client.once("error", reject);
		});
		await client.login(token);
		await Promise.race([
			ready,
			sleep(15000).then(() => {
				throw new Error("recorder_ready_timeout");
			}),
		]);
		check(client.user?.id === identity.botUserId, "recorder_identity_mismatch");
		connection = await deps.joinVoice(client, {
			guildId: t.guildId,
			channelId: t.voiceChannelId,
			selfMute: true,
			selfDeaf: false,
		});
		recordedAtMs = Date.now();
		stream = deps.subscribeManual(connection)(t.voiceBot.botUserId);
		decoder = deps.createDecoder();
		stream.pipe(decoder);
		decoder.on("data", (data) =>
			chunks.push({ at: Date.now(), data: Buffer.from(data) }),
		);
		let failed;
		decoder.on("error", () => {
			failed = true;
		});
		stream.on("error", () => {
			failed = true;
		});
		return {
			stop: () => {
				stream.destroy();
				decoder.destroy();
				connection.destroy();
				client.destroy();
				check(!failed, "recorder_decode_failed");
				const length = Math.max(
					0,
					...chunks.map(
						(c) => Math.round((c.at - recordedAtMs) * 48) * 4 + c.data.length,
					),
				);
				const pcm = Buffer.alloc(length);
				for (const c of chunks)
					c.data.copy(pcm, Math.round((c.at - recordedAtMs) * 48) * 4);
				return { pcm, recordedAtMs };
			},
		};
	} catch (error) {
		stream?.destroy();
		decoder?.destroy();
		connection?.destroy();
		client.destroy();
		throw error;
	}
}

function wav(pcm) {
	const header = Buffer.alloc(44);
	header.write("RIFF");
	header.writeUInt32LE(pcm.length + 36, 4);
	header.write("WAVEfmt ", 8);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(2, 22);
	header.writeUInt32LE(48000, 24);
	header.writeUInt32LE(192000, 28);
	header.writeUInt16LE(4, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}

async function createRuntime(context, runDir) {
	const { topology: t, launch, built, room } = context;
	const token = readFileSync(
		trusted(t.slotDir, room.apiTokenPath),
		"utf8",
	).trim();
	check(
		(lstatSync(room.apiTokenPath).mode & 0o777) === 0o600 && token,
		"slot_master_token_required",
	);
	const health = await fetch(`${t.bridgeUrl}/health`, {
		signal: AbortSignal.timeout(5000),
	}).then((r) => r.json());
	check(
		health.ok &&
			health.buildMode === "built" &&
			health.buildSha === t.buildSha &&
			health.artifactBuildSha === t.buildSha,
		"slot_exact_head_not_ready",
	);
	const require = createRequire(join(repo, "packages/teamlead/package.json"));
	const Database = require("better-sqlite3");
	const state = new Database(t.dbPath, { readonly: true, fileMustExist: true });
	const comm = new Database(t.commDbPath, {
		readonly: true,
		fileMustExist: true,
	});
	const rayaPath = context.rayaCli;
	// Use the existing explicitly configured Raya checkout module; never probe HOME.
	check(rayaPath && isAbsolute(rayaPath), "raya_cli_module_not_installed");
	const raya = await import(pathToFileURL(rayaPath).href);
	const { selectMeetingTranscript } = await import(
		built("teamlead/dist/meeting-notes-scheduler.js")
	);
	const { createDiscordDeps } = await import(
		built("voice-bridge/dist/index.js")
	);
	const discord = await createDiscordDeps();
	const { scrubTranscript } = await import(built("voice-core/dist/index.js"));
	const voiceEnv = {
		RAYA_FLYWHEEL_VOICE_INTENT_MODULE: join(
			repo,
			"packages/teamlead/dist/cos-ports/voice-intent.js",
		),
		FLYWHEEL_BRIDGE_URL: t.bridgeUrl,
		TEAMLEAD_API_TOKEN: token,
	};
	async function intent(meetingId, action) {
		const lines = [];
		const code = await raya.runCoSCommand(
			["voice-intent", "--meeting-id", meetingId, "--action", action],
			{ write: (line) => lines.push(line) },
			voiceEnv,
		);
		check(code === 0, "raya_voice_intent_unavailable");
		return lines;
	}
	async function until(fn) {
		for (let n = 0; n < 180; n++) {
			const value = fn();
			if (value) return value;
			await sleep(1000);
		}
		throw new Error("voice_evidence_timeout");
	}
	return {
		close() {
			state.close();
			comm.close();
		},
		async runMeeting(lead, recorderIdentity) {
			const meetingId = randomUUID();
			const at = new Date().toISOString();
			const currentPath = join(t.meetingStateDir, "meeting.json");
			if (existsSync(currentPath))
				check(
					["ended", "cancelled", "missed"].includes(json(currentPath).status),
					"existing_meeting_active",
				);
			const meeting = {
				schemaVersion: 2,
				id: meetingId,
				leadId: lead.agentId,
				topic: "FLY-2446 529 voice acceptance",
				scheduledAt: at,
				durationMinutes: 5,
				requestedBy: "FLY-2446 QA",
				requestedAt: at,
				status: "starting",
			};
			writeFileSync(currentPath, JSON.stringify(meeting), { mode: 0o600 });
			const directory = join(runDir, lead.agentId);
			mkdirSync(directory, { mode: 0o700 });
			let recorder;
			let session;
			let stopped = false;
			let requested = false;
			try {
				recorder = await recordVoice(
					discord,
					t,
					recorderIdentity,
					readSecret(t.slotDir, launch, recorderIdentity.tokenEnv),
				);
				await intent(meetingId, "start");
				requested = true;
				session = await until(() =>
					state
						.prepare(
							"SELECT * FROM voice_sessions WHERE meeting_id=? AND state='live'",
						)
						.get(meetingId),
				);
				console.error(
					`529 QA: speak to ${lead.agentId} in the configured test voice room; wait for its mailbox reply and spoken response.`,
				);
				await until(() =>
					state
						.prepare(
							"SELECT seq FROM voice_outbound WHERE session_id=? AND phase='confirmed'",
						)
						.get(session.session_id),
				);
				await intent(meetingId, "stop");
				stopped = true;
				session = await until(() =>
					state
						.prepare(
							"SELECT * FROM voice_sessions WHERE session_id=? AND state='ended'",
						)
						.get(session.session_id),
				);
				const recorded = recorder.stop();
				recorder = undefined;
				const signal = json(
					trusted(
						t.slotDir,
						join(t.meetingStateDir, "meetings", meetingId, "voice-signal.json"),
					),
				);
				const evidenceText = readFileSync(
					trusted(
						t.slotDir,
						join(t.meetingStateDir, "voice-evidence", "events.jsonl"),
					),
					"utf8",
				);
				const ended = {
					...meeting,
					status: "ended",
					endedAt: signal.at,
					endReason: signal.reason,
				};
				const selection = selectMeetingTranscript({
					meeting: ended,
					signal,
					evidenceText,
				});
				const journal = readFileSync(
					trusted(
						t.slotDir,
						join(t.voiceRoot, "sessions", session.session_id, "journal.jsonl"),
					),
					"utf8",
				)
					.trim()
					.split("\n")
					.filter(Boolean)
					.map(JSON.parse);
				const deliveryIds = journal
					.filter((j) => j.kind === "ingested")
					.map((j) => j.deliveryId);
				const mailbox = deliveryIds.flatMap((id) =>
					comm
						.prepare(
							"SELECT delivery_id,source_kind,state FROM mailbox WHERE delivery_id=?",
						)
						.all(id),
				);
				const outbound = state
					.prepare(
						"SELECT seq,author_id,phase,attempt_token,claimed_at,finished_at FROM voice_outbound WHERE session_id=? AND phase='confirmed' ORDER BY seq",
					)
					.all(session.session_id);
				const audio = outbound.map((row) =>
					waveStats(
						recorded.pcm,
						recorded.recordedAtMs,
						Date.parse(row.claimed_at),
						Date.parse(row.finished_at),
					),
				);
				const proof = evaluateMeetingEvidence({
					session,
					liveObserved: true,
					mailbox,
					journal,
					outbound,
					leadBotId: lead.botUserId,
					selection,
					audio,
				});
				const recording = wav(recorded.pcm);
				writeFileSync(join(directory, "room.wav"), recording, { mode: 0o600 });
				writeFileSync(
					join(directory, "events.jsonl"),
					scrubTranscript(evidenceText),
					{ mode: 0o600 },
				);
				writeFileSync(join(directory, "meeting.json"), JSON.stringify(ended), {
					mode: 0o600,
				});
				writeFileSync(currentPath, JSON.stringify(ended), { mode: 0o600 });
				const report = {
					...proof,
					recording: {
						file: "room.wav",
						sha256: sha(recording),
						durationSeconds: recorded.pcm.length / 192000,
					},
					evidenceDirectory: directory,
					voiceBinarySha: t.voiceBinarySha,
				};
				writeFileSync(
					join(directory, "receipt.json"),
					JSON.stringify(report, null, 2),
					{ mode: 0o600 },
				);
				return report;
			} finally {
				recorder?.stop();
				if (requested && !stopped)
					await intent(meetingId, "stop").catch(() => {});
			}
		},
	};
}

export async function main(argv) {
	const args = parseArgs(argv);
	const context = await loadTopology(args);
	if (!args["--run"]) {
		console.log(
			JSON.stringify(
				await runTwoLead(context.topology, { dryRun: true }, {}),
				null,
				2,
			),
		);
		return;
	}
	const runDir = join(
		context.topology.slotDir,
		"e2e-evidence",
		`fly2446-${randomUUID()}`,
	);
	mkdirSync(runDir, { recursive: true, mode: 0o700 });
	let runtime;
	try {
		runtime = await createRuntime(context, runDir);
		const report = await runTwoLead(
			context.topology,
			{ dryRun: false },
			runtime,
		);
		writeFileSync(
			join(runDir, "report.json"),
			JSON.stringify(report, null, 2),
			{ mode: 0o600 },
		);
		console.log(JSON.stringify(report, null, 2));
	} catch (error) {
		writeFileSync(
			join(runDir, "report.json"),
			JSON.stringify({
				status: "INCOMPLETE",
				qaVerdict: "NOT_EVALUATED",
				reason: error.message,
			}),
			{ mode: 0o600 },
		);
		throw error;
	} finally {
		runtime?.close();
	}
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
	main(process.argv.slice(2)).catch((error) => {
		console.error(`FLY-2446 driver: ${error.message}`);
		process.exitCode = 1;
	});
