import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import {
	digest,
	discordSnowflake,
	type MigrationIO,
} from "./raya-migration-io.js";
import { collectMigrationProof } from "./raya-migration-proof.js";

const roots: string[] = [];
afterEach(() =>
	roots
		.splice(0)
		.forEach((root) => rmSync(root, { recursive: true, force: true })),
);
const repo = resolve(import.meta.dirname, "../../../.."),
	at = "2026-09-13T00:00:00Z",
	time = Date.parse(at);
const channel = "123456789012345678",
	bot = "223456789012345678",
	human = "323456789012345678",
	probeBot = "423456789012345678";
function fixture() {
	const home = mkdtempSync(join(tmpdir(), "raya-proof-"));
	roots.push(home);
	const root = join(home, ".flywheel"),
		folder = join(root, "raya/migrations/FLY-2445-standard-lead"),
		state = join(home, "state"),
		workspace = join(home, "workspace");
	const write = (path: string, value: string) => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, value, { mode: 0o600 });
	};
	mkdirSync(workspace);
	const canonical = JSON.stringify({
		projectName: "raya",
		leadId: "raya",
		projectDir: workspace,
		leadBackend: { backendId: "codex-app-server" },
	});
	const registry = JSON.stringify([
		{
			projectName: "raya",
			projectRoot: workspace,
			leads: [
				{
					agentId: "raya",
					botUserId: bot,
					botTokenEnv: "RAYA_BOT_TOKEN",
					chatChannel: channel,
					alertChannel: channel,
				},
			],
		},
	]);
	write(join(root, "manifests/raya-raya.json"), canonical);
	write(join(root, "projects.json"), registry);
	write(join(root, "state/summary-registry/migration-receipt.json"), "{}");
	write(join(root, "deployed-sha"), "2".repeat(40));
	write(join(root, ".env"), "RAYA_BOT_TOKEN=CANARY\n");
	write(join(state, "thread-id"), "thread-current");
	const cursor = `${JSON.stringify({ [channel]: discordSnowflake(time - 2000) })}\n`;
	write(join(state, "inbound-cursor.json"), cursor);
	write(
		join(folder, "seed-input.json"),
		JSON.stringify({
			schemaVersion: 1,
			migrationId: "fixture-migration",
			expectedBeforeSha256: null,
			writerStopped: true,
			unresolved: [],
			channels: [
				{
					channelId: channel,
					lastConfirmedMessageId: discordSnowflake(time - 2000),
				},
			],
		}),
	);
	const windowId = discordSnowflake(time - 1000),
		textId = discordSnowflake(time + 1000),
		alertId = discordSnowflake(time + 4000);
	const manifest = {
		schemaVersion: 1,
		migration_id: "fixture-migration",
		checkpoint: "P5",
		unresolved: [],
		raya_sha: "1".repeat(40),
		flywheel_deployed_sha: "2".repeat(40),
		registry_digest: digest(registry),
		summary_receipt_digest: digest("{}"),
		canonical_manifest_digest: digest(canonical),
		artifact: {
			digest: "a".repeat(64),
			persona_digest: "b".repeat(64),
			workspace,
			state_schema_version: 1,
		},
		cursor: {
			path: join(state, "inbound-cursor.json"),
			seed_input: join(folder, "seed-input.json"),
			sha256: digest(cursor),
			seeded_at: "2026-09-12T23:59:59Z",
			status: "seeded",
		},
		old_stopped_at: "2026-09-12T23:59:58Z",
		activated_at: at,
		cutover_probe: { message_id: windowId, intent: { nonce: "nonce" } },
		window_probe: { bot_user_id: probeBot, channel_id: channel },
		lead_bot_user_id: bot,
	};
	const file = join(folder, "manifest.json"),
		proof = join(folder, "proof.json");
	write(file, JSON.stringify(manifest));
	const comm = join(root, "comm/raya/comm.db");
	mkdirSync(dirname(comm), { recursive: true });
	const db = new Database(comm);
	db.exec(
		`CREATE TABLE mailbox (id TEXT, delivery_id TEXT, to_agent TEXT, recipient_kind TEXT, source_kind TEXT, type TEXT, state TEXT, created_at TEXT, delivered_at TEXT)`,
	);
	const delivery =
		"lead_event:raya:summary-absorption:2026-09-13T06:00:00.000Z";
	db.prepare("INSERT INTO mailbox VALUES (?,?,?,?,?,?,?,?,?)").run(
		delivery,
		delivery,
		"raya",
		"lead",
		"lead_event",
		"summary_absorption_round",
		"ACKED",
		"2026-09-13T06:00:00Z",
		"2026-09-13T06:00:01Z",
	);
	db.close();
	let oldOwner = false,
		disabled = "disabled",
		missingReply = false,
		drift = false,
		paneDrift = false,
		panePid = 123;
	const io: MigrationIO = {
		now: () => time + 7 * 3600_000,
		run: async (command, args) => {
			if (command === "python3")
				return execFileSync(command, args, { encoding: "utf8" });
			if (command === "launchctl") {
				if (args[0] === "print-disabled")
					return `disabled services = {\n"com.xrli.raya.brain" => ${disabled}\n"com.xrli.raya.voice" => ${disabled}\n}`;
				if (args.some((arg) => arg.includes("com.xrli.raya"))) {
					if (oldOwner) return "pid = 99";
					throw Object.assign(new Error("unloaded"), {
						stderr: "Could not find service",
					});
				}
				return "pid = 42";
			}
			if (command === "ps")
				return args.includes("lstart=")
					? args.at(-1) === "123"
						? "2026-09-13T00:00:02Z"
						: "2026-09-12T23:59:59Z"
					: "codex-lead-tui-runtime";
			if (command === "tmux")
				return `raya-raya|0|${panePid}|${JSON.stringify(`CODEX_HOME="${home}/.codex-raya" codex resume --remote "unix://${home}/.codex-raya/app-server-control/app-server-control.sock" -C "${workspace}" -s workspace-write thread-current`)}`;
			if (args.includes("--print-state-dir")) return state;
			if (args.includes("lead-identity"))
				return JSON.stringify({
					backend: "codex-app-server",
					leadKey: "raya-raya",
					projectName: "raya",
					leadId: "raya",
					botUserId: bot,
					identityDigest: "c".repeat(64),
				});
			if (args.includes("message-status")) {
				const id = args[args.indexOf("message-status") + 1]!;
				return JSON.stringify({
					location: "live",
					message_id: id,
					state: "ACKED",
					authorId: id.endsWith(textId) ? human : probeBot,
					stamps: { delivered_at: "2026-09-13T00:00:03Z" },
				});
			}
			if (args.some((arg) => arg.endsWith("inspect-lead-outbound.js"))) {
				if (missingReply) throw new Error("missing");
				const id = args[args.indexOf("--delivery-id") + 1]!;
				return JSON.stringify({
					ok: true,
					deliveryId: id,
					messageId: discordSnowflake(
						time + (id.endsWith(textId) ? 2000 : 3000),
					),
					journalState: "completed",
					outboxStatus: "sent",
					bridgeStatus: "sent",
				});
			}
			if (args.some((arg) => arg.endsWith("lead-alert.sh"))) {
				if (drift) write(join(root, "deployed-sha"), "3".repeat(40));
				if (paneDrift) panePid = 124;
				return `sent message_id=${alertId}`;
			}
			return "";
		},
		fetch: async (url) => {
			if (String(url).endsWith("/users/@me"))
				return Response.json({ id: bot, bot: true });
			const id = String(url).split("/").at(-1)!;
			return Response.json({
				id,
				channel_id: channel,
				author: {
					id: id === textId ? human : id === windowId ? probeBot : bot,
					bot: id !== textId,
				},
				content:
					id === windowId
						? "[FLY-2445 cutover window probe nonce] Raya，请回复一句确认收到。"
						: id === alertId
							? "Raya activation probe fixture-migration"
							: "fixture",
			});
		},
	};
	return {
		home,
		file,
		proof,
		manifest,
		io,
		textId,
		enableLegacy: (value = "enabled") => {
			disabled = value;
		},
		old: () => {
			oldOwner = true;
		},
		missing: () => {
			missingReply = true;
		},
		drift: () => {
			drift = true;
		},
		paneDrift: () => {
			paneDrift = true;
		},
		run: () =>
			collectMigrationProof({
				home,
				flywheelDir: repo,
				io,
				textMessageId: textId,
			}),
	};
}
it("collects a proof accepted by the real P6 shell validators with a stable activation anchor", async () => {
	const f = fixture();
	await f.run();
	const proof = JSON.parse(readFileSync(f.proof, "utf8"));
	expect(proof.lead.activation_id).toBe(`fixture-migration:${at}`);
	expect(proof.lead.pane_pid).toBe(123);
	expect(proof.checks.discord_message_id).toBeTruthy();
	execFileSync(
		"bash",
		[
			"-c",
			'source "$1/scripts/lib/updater-raya-deploy.sh"; RAYA_MIGRATION_MANIFEST="$2"; raya_validate_proof "$3" && jq --slurpfile p "$3" \' .checkpoint="P6" | .lead=$p[0].lead | .business=$p[0].business | .checks=$p[0].checks | .cutover=$p[0].cutover \' "$2" > "$4" && raya_p6_evidence_valid "$4"',
			"_",
			repo,
			f.file,
			f.proof,
			`${f.proof}.validate`,
		],
		{ env: { ...process.env, HOME: f.home, BASH_ENV: "" } },
	);
});
it.each(["old", "missing", "drift", "paneDrift"] as const)(
	"refuses %s evidence and never writes a proof",
	async (kind) => {
		const f = fixture();
		f[kind]();
		await expect(f.run()).rejects.toThrow();
		expect(existsSync(f.proof)).toBe(false);
	},
);
it("rejects a window message whose nonce differs from the frozen ledger", async () => {
	const f = fixture();
	f.manifest.cutover_probe.intent.nonce = "foreign";
	writeFileSync(f.file, JSON.stringify(f.manifest));
	await expect(f.run()).rejects.toThrow();
	expect(existsSync(f.proof)).toBe(false);
});
it("accepts an advanced live cursor while retaining the actual seed boundary", async () => {
	const f = fixture();
	writeFileSync(
		f.manifest.cursor.path,
		JSON.stringify({ [channel]: f.textId }),
	);
	await f.run();
	const proof = JSON.parse(readFileSync(f.proof, "utf8"));
	expect(proof.cutover.channels).toEqual([
		{ channel_id: channel, seeded_after: discordSnowflake(time - 2000) },
	]);
	expect(JSON.stringify(proof)).not.toContain("CANARY");
});
it("requires the original seed writer-stop and unresolved guards", async () => {
	const f = fixture(),
		path = f.manifest.cursor.seed_input,
		seed = JSON.parse(readFileSync(path, "utf8"));
	seed.writerStopped = false;
	writeFileSync(path, JSON.stringify(seed));
	await expect(f.run()).rejects.toThrow();
	expect(existsSync(f.proof)).toBe(false);
});
it("refuses the live shuttle lock", async () => {
	const f = fixture(),
		lock = join(f.home, ".flywheel/raya/deploy.lock.d");
	mkdirSync(lock);
	writeFileSync(join(lock, "pid"), String(process.pid));
	writeFileSync(join(lock, "start"), "2026-09-12T23:59:59Z");
	await expect(f.run()).rejects.toThrow("deploy-lock-held");
	expect(existsSync(f.proof)).toBe(false);
});
it("represents an empty seed channel as seeded_after zero", async () => {
	const f = fixture(),
		seedPath = f.manifest.cursor.seed_input;
	const seed = JSON.parse(readFileSync(seedPath, "utf8"));
	seed.channels = [];
	seed.emptyChannels = [channel];
	writeFileSync(seedPath, JSON.stringify(seed));
	const cursor = `${JSON.stringify({ [channel]: "0" })}\n`;
	writeFileSync(f.manifest.cursor.path, cursor);
	f.manifest.cursor.sha256 = digest(cursor);
	writeFileSync(f.file, JSON.stringify(f.manifest));
	await f.run();
	expect(JSON.parse(readFileSync(f.proof, "utf8")).cutover.channels).toEqual([
		{ channel_id: channel, seeded_after: "0" },
	]);
});

it.each(["enabled", "false", "unknown"])(
	"rejects legacy disabled-state %s",
	async (value) => {
		const f = fixture();
		f.enableLegacy(value);
		await expect(f.run()).rejects.toThrow("legacy-owner-not-disabled");
		expect(existsSync(f.proof)).toBe(false);
	},
);

it("accepts the older launchd true readback", async () => {
	const f = fixture();
	f.enableLegacy("true");
	await f.run();
	expect(existsSync(f.proof)).toBe(true);
});
