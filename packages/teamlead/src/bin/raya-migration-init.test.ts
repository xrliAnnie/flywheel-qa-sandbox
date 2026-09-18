import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { initializeMigration } from "./raya-migration-init.js";
import type { MigrationIO } from "./raya-migration-io.js";
import { runMigrationManifest } from "./raya-migration-manifest.js";

const roots: string[] = [];
afterEach(() =>
	roots
		.splice(0)
		.forEach((root) => rmSync(root, { recursive: true, force: true })),
);
const founder = "123456789012345678",
	bot = "223456789012345678",
	probe = "323456789012345678";
const channel = "423456789012345678",
	authId = "523456789012345678";
const target = "9d63a2b2e6736bcdd5e699945b3bf8655c06c5e9";
function fixture() {
	const home = mkdtempSync(join(tmpdir(), "raya-init-"));
	roots.push(home);
	const root = join(home, ".flywheel"),
		workspace = join(home, "Dev/raya-lead-workspace"),
		state = join(home, "state");
	const put = (path: string, value: unknown) => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			typeof value === "string" ? value : JSON.stringify(value),
			{ mode: 0o600 },
		);
	};
	mkdirSync(workspace, { recursive: true });
	mkdirSync(state);
	put(join(root, "manifests/raya-raya.json"), {
		projectName: "raya",
		leadId: "raya",
		projectDir: workspace,
		leadBackend: { backendId: "codex-app-server" },
	});
	put(join(root, "projects.json"), [
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
	put(
		join(root, ".env"),
		`DISCORD_OWNER_USER_ID=${founder}\nRAYA_BOT_TOKEN=RAYA-CANARY\nPROBE_TOKEN=PROBE-CANARY\nFLYWHEEL_API_TOKEN=API-CANARY\n`,
	);
	put(join(root, "state/summary-registry/migration-receipt.json"), {
		schemaVersion: 1,
	});
	const executable = join(home, "node");
	writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	for (const app of ["brain", "voice"])
		put(join(home, `Library/LaunchAgents/com.xrli.raya.${app}.plist`), {
			Label: `com.xrli.raya.${app}`,
			ProgramArguments: [
				executable,
				join(root, `raya/code/apps/${app}/dist/cli.js`),
				"run",
			],
			WorkingDirectory: join(root, "raya/code"),
			EnvironmentVariables: { RAYA_ENV_FILE: join(root, "raya/raya.env") },
		});
	const commands: string[] = [];
	let posts = 0;
	let nudge = 202;
	let postStatus = 200;
	let losePost = false;
	let liveVerify = true;
	let liveVerifyError: Error | null = null;
	const legacyLaunchctl = new Map<string, string | Error>();
	const messages: unknown[] = [];
	const io: MigrationIO = {
		now: () => Date.parse("2026-09-13T00:00:00Z"),
		run: async (file, args) => {
			commands.push(`${file} ${args.join(" ")}`);
			if (file === "plutil") return readFileSync(args.at(-1)!, "utf8");
			if (file === "launchctl") {
				const label = args.at(-1)!.split("/").at(-1)!;
				const result = legacyLaunchctl.get(label);
				if (result instanceof Error) throw result;
				return result ?? "state = running\npid = 1234\n";
			}
			if (file === "ps") return "Sun Sep 13 00:00:00 2026";
			if (args.includes("--print-state-dir")) return state;
			if (file === "bash" && args.includes("verify")) {
				if (liveVerifyError) throw liveVerifyError;
				if (!liveVerify) throw new Error("standard Lead is not live");
				return "PASS #7 launchd running pid=67031";
			}
			throw new Error("unexpected command");
		},
		fetch: async (url, init) => {
			const path = String(url);
			if (path.endsWith("/nudge")) return new Response(null, { status: nudge });
			const token = new Headers(init?.headers).get("Authorization");
			if (path.endsWith("/users/@me"))
				return Response.json({
					id: token === "Bot RAYA-CANARY" ? bot : probe,
					bot: true,
				});
			if (path.endsWith(`/messages/${authId}`))
				return Response.json({
					id: authId,
					channel_id: channel,
					author: { id: founder },
					timestamp: "2026-09-13T00:00:00Z",
					content:
						"FLY-2496 AUTHORIZE register cutover=9d63a2b2 urgent-restart baseline=quiet15m",
				});
			if (init?.method === "POST") {
				posts++;
				const message = {
					id: "623456789012345678",
					channel_id: channel,
					author: { id: probe, bot: true },
					content: JSON.parse(String(init.body)).content,
				};
				if (postStatus === 200) messages.push(message);
				if (losePost) throw new Error("lost PROBE-CANARY");
				return Response.json(message, { status: postStatus });
			}
			return Response.json(messages);
		},
	};
	return {
		root,
		home,
		state,
		put,
		io,
		commands,
		posts: () => posts,
		setNudge: (value: number) => {
			nudge = value;
		},
		setPost: (value: number) => {
			postStatus = value;
		},
		lose: () => {
			losePost = true;
		},
		failLiveVerify: () => {
			liveVerify = false;
		},
		failLiveVerifyWith: (error: Error) => {
			liveVerifyError = error;
		},
		setLegacyLaunchctl: (app: "brain" | "voice", result: string | Error) => {
			legacyLaunchctl.set(`com.xrli.raya.${app}`, result);
		},
		input: {
			home,
			flywheelDir: join(home, "Dev/flywheel"),
			targetRayaSha: target,
			authorizationMessageId: authId,
			authorizationChannelId: channel,
			probeBotTokenEnv: "PROBE_TOKEN",
			io,
		},
		file: join(root, "raya/migrations/FLY-2445-standard-lead/manifest.json"),
	};
}

describe("H3 migration initialization", () => {
	it.each([
		"canonical",
		"registry-duplicate",
		"bot-mismatch",
		"founder-conflict",
		"probe-is-raya",
	])("rejects %s before any probe or ledger", async (failure) => {
		const f = fixture();
		if (failure === "canonical")
			f.put(join(f.root, "manifests/raya-raya.json"), { projectName: "other" });
		if (failure === "registry-duplicate") {
			const rows = JSON.parse(
				readFileSync(join(f.root, "projects.json"), "utf8"),
			);
			f.put(join(f.root, "projects.json"), [...rows, ...rows]);
		}
		if (failure === "bot-mismatch") {
			const rows = JSON.parse(
				readFileSync(join(f.root, "projects.json"), "utf8"),
			);
			rows[0].leads[0].botUserId = probe;
			f.put(join(f.root, "projects.json"), rows);
		}
		if (failure === "founder-conflict")
			f.put(
				join(f.root, ".env"),
				`${readFileSync(join(f.root, ".env"), "utf8")}FLYWHEEL_FOUNDER_USER_ID=${bot}\n`,
			);
		if (failure === "probe-is-raya")
			f.put(
				join(f.root, ".env"),
				readFileSync(join(f.root, ".env"), "utf8").replace(
					"PROBE-CANARY",
					"RAYA-CANARY",
				),
			);
		await expect(initializeMigration(f.input)).rejects.toThrow();
		expect(f.posts()).toBe(0);
		expect(existsSync(f.file)).toBe(false);
	});
	it("allows explicit P2 preparation retry only before either old owner has a stop intent", async () => {
		const f = fixture();
		await initializeMigration(f.input);
		await initializeMigration({ ...f.input, resumeFromFailed: true });
		expect(f.posts()).toBe(1);
		const ledger = JSON.parse(readFileSync(f.file, "utf8"));
		ledger.legacy_owner[0].stop_started_at_ms = 1;
		writeFileSync(f.file, JSON.stringify(ledger));
		const before = readFileSync(f.file, "utf8");
		await expect(
			initializeMigration({ ...f.input, resumeFromFailed: true }),
		).rejects.toThrow("migration-already-initialized");
		expect(readFileSync(f.file, "utf8")).toBe(before);
	});
	it("reuses a preexisting cursor only when the public standard Lead is live", async () => {
		const f = fixture();
		await initializeMigration(f.input);
		f.put(join(f.state, "inbound-cursor.json"), {
			[channel]: "623456789012345678",
		});
		await initializeMigration({ ...f.input, resumeFromFailed: true });
		const ledger = JSON.parse(readFileSync(f.file, "utf8"));
		expect(ledger.cursor).toMatchObject({
			path: join(f.state, "inbound-cursor.json"),
			status: "preexisting",
			sha256: null,
		});
		expect(f.commands).toContain(
			`bash ${join(f.root, "bin/flywheel-lead.sh")} verify --stage live ${join(f.root, "manifests/raya-raya.json")}`,
		);
	});
	it("rebuilds from a missing owner and a loaded but not running owner", async () => {
		const f = fixture();
		await initializeMigration(f.input);
		const missing = Object.assign(new Error("launchctl failed"), {
			stderr: "Could not find service com.xrli.raya.brain",
		});
		f.setLegacyLaunchctl("brain", missing);
		f.setLegacyLaunchctl("voice", "state = not running\n");
		f.put(join(f.state, "inbound-cursor.json"), {
			[channel]: "623456789012345678",
		});

		await initializeMigration({ ...f.input, resumeFromFailed: true });

		const ledger = JSON.parse(readFileSync(f.file, "utf8"));
		expect(ledger.cursor.status).toBe("preexisting");
		expect(ledger.legacy_owner).toEqual([
			expect.objectContaining({
				label: "com.xrli.raya.brain",
				loaded: false,
				pid: null,
				start: null,
			}),
			expect.objectContaining({
				label: "com.xrli.raya.voice",
				loaded: true,
				pid: null,
				start: null,
			}),
		]);
	});
	it("keeps a preexisting cursor exclusive to explicit failed-resume recovery", async () => {
		const f = fixture();
		f.put(join(f.state, "inbound-cursor.json"), {
			[channel]: "623456789012345678",
		});
		await expect(initializeMigration(f.input)).rejects.toThrow(
			"cursor-already-exists",
		);
		expect(existsSync(f.file)).toBe(false);
	});
	it("preserves the failed ledger when public live verification rejects cursor reuse", async () => {
		const f = fixture();
		await initializeMigration(f.input);
		const before = readFileSync(f.file, "utf8");
		f.put(join(f.state, "inbound-cursor.json"), {
			[channel]: "623456789012345678",
		});
		f.failLiveVerify();
		await expect(
			initializeMigration({ ...f.input, resumeFromFailed: true }),
		).rejects.toThrow();
		expect(readFileSync(f.file, "utf8")).toBe(before);
	});
	it("does not swallow an ENOENT from public live verification", async () => {
		const f = fixture();
		await initializeMigration(f.input);
		const before = readFileSync(f.file, "utf8");
		f.put(join(f.state, "inbound-cursor.json"), {
			[channel]: "623456789012345678",
		});
		const missingBash = Object.assign(new Error("spawn bash ENOENT"), {
			code: "ENOENT",
		});
		f.failLiveVerifyWith(missingBash);
		await expect(
			initializeMigration({ ...f.input, resumeFromFailed: true }),
		).rejects.toBe(missingBash);
		expect(readFileSync(f.file, "utf8")).toBe(before);
	});
	it("accepts the uncreated standard Lead state directory without creating it before install", async () => {
		const f = fixture();
		rmSync(f.state, { recursive: true });
		await initializeMigration(f.input);
		expect(existsSync(f.state)).toBe(false);
		expect(JSON.parse(readFileSync(f.file, "utf8")).cursor.path).toBe(
			join(f.state, "inbound-cursor.json"),
		);
	});
	it("writes a private ledger only after verifying identities and delivering the precheck", async () => {
		const f = fixture();
		await initializeMigration(f.input);
		const ledger = JSON.parse(readFileSync(f.file, "utf8"));
		expect(ledger).toMatchObject({
			schemaVersion: 1,
			checkpoint: "P2",
			target_raya_sha: target,
			unresolved: [],
			authorization: { granted_by: "founder", evidence_author_id: founder },
			window_probe: {
				bot_token_env: "PROBE_TOKEN",
				precheck_message_id: "623456789012345678",
			},
			bridge: { token_resolved: true, bot_user_id: bot },
			cursor: { path: join(f.state, "inbound-cursor.json"), sha256: null },
		});
		expect(ledger.legacy_owner).toHaveLength(2);
		expect(lstatSync(f.file).mode & 0o777).toBe(0o600);
		expect(readFileSync(f.file, "utf8")).not.toContain("CANARY");
		expect(f.commands.join("\n")).not.toMatch(/install|bootout|kickstart/);
		expect(f.posts()).toBe(1);
	});
	it("produces a P2 ledger accepted by the real shuttle guards before any cursor is seeded", async () => {
		const f = fixture();
		await initializeMigration(f.input);
		const library = fileURLToPath(
			new URL(
				"../../../../scripts/lib/updater-raya-deploy.sh",
				import.meta.url,
			),
		);
		expect(() =>
			execFileSync(
				"bash",
				[
					"-c",
					'source "$1"; RAYA_MIGRATION_MANIFEST="$2"; raya_manifest_base_valid && raya_bridge_token_ready && raya_standard_manifest_checkpoint "$2" P2',
					"_",
					library,
					f.file,
				],
				{
					encoding: "utf8",
					env: { ...process.env, HOME: f.home, BASH_ENV: "" },
				},
			),
		).not.toThrow();
	});
	it.each(["nudge", "voice-identity", "cursor", "probe-forbidden"])(
		"refuses %s failure without a manifest",
		async (failure) => {
			const f = fixture();
			if (failure === "nudge") f.setNudge(404);
			if (failure === "voice-identity")
				f.put(join(f.home, "Library/LaunchAgents/com.xrli.raya.voice.plist"), {
					Label: "foreign",
				});
			if (failure === "cursor") f.put(join(f.state, "inbound-cursor.json"), {});
			if (failure === "probe-forbidden") f.setPost(403);
			await expect(initializeMigration(f.input)).rejects.toThrow();
			expect(existsSync(f.file)).toBe(false);
			if (failure !== "probe-forbidden") expect(f.posts()).toBe(0);
		},
	);
	it("dry-run never writes a ledger or sends a Discord probe", async () => {
		const f = fixture();
		expect(
			await initializeMigration({ ...f.input, dryRun: true }),
		).toMatchObject({ status: "dry-run", probe_send: "not-run" });
		expect(existsSync(dirname(f.file))).toBe(false);
		expect(f.posts()).toBe(0);
	});
	it("runs the documented init CLI with injected host I/O", async () => {
		const f = fixture();
		const output = await runMigrationManifest(
			[
				"init",
				"--target-raya-sha",
				target,
				"--authorization-message-id",
				authId,
				"--authorization-channel-id",
				channel,
				"--probe-bot-token-env",
				"PROBE_TOKEN",
				"--dry-run",
			],
			f.input,
		);
		expect(output).toMatchObject({ status: "dry-run", probe_send: "not-run" });
		expect(existsSync(f.file)).toBe(false);
	});
	it("recovers a lost precheck response without posting twice, then refuses duplicate initialization", async () => {
		const f = fixture();
		f.lose();
		await expect(initializeMigration(f.input)).rejects.toThrow();
		await initializeMigration(f.input);
		expect(f.posts()).toBe(1);
		const before = readFileSync(f.file, "utf8");
		await expect(initializeMigration(f.input)).rejects.toThrow();
		expect(readFileSync(f.file, "utf8")).toBe(before);
	});
});
