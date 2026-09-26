/**
 * FLY-2882 (QA@2 claim 1599): the production Claude wiring against real tmux
 * servers, read from a launchd-shaped environment — no TMUX, no LANG, no LC_*.
 *
 * That is the real Bridge's environment. There, a tmux client is not UTF-8 and
 * sanitizes every tab and non-ASCII byte in its output to `_`, so the
 * tab-separated `list-panes -F` rows never parse and every Claude Lead read as
 * `unknown/lead_window_unavailable`. A runner shell (TMUX or LANG set) never
 * shows this, which is how the earlier smokes passed.
 *
 * Room layout (registry → plist → manifest → private socket) is the one
 * `readRegistryAuthority` accepts; the fake Claude is a compiled binary so
 * `ps` reports kernel name `claude` as it does for the real one.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveLeadSocketPath } from "../../../lead-address.js";
import type { ProjectEntry } from "../../../ProjectConfig.js";
import { createProductionLeadActivityService } from "../lead-activity-service.js";

const hasTools =
	spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0 &&
	spawnSync("cc", ["--version"], { stdio: "ignore" }).status === 0;

const PROJECT = "test-slot-2";
const IDLE_LEAD = "flywheel-test-3";
const BUSY_LEAD = "flywheel-test-4";

const SCREENS: Record<string, string> = {
	[IDLE_LEAD]: [
		"⏺ 好的，已经处理完了。",
		"",
		"✻ Worked for 3s · done 1:00 PM",
		"",
		`──────────────────────────────── @${IDLE_LEAD} ──`,
		"❯ ",
		"──────────────────────────────────────────────────────",
		"  ⏵⏵ bypass permissions on",
	].join("\n"),
	[BUSY_LEAD]: [
		'⏺ Bash(python3 -c "import time; time.sleep(75)")',
		"  ⎿  Running…",
		"",
		"✶ Thinking… (1m 5s · ↓ 12 tokens · esc to interrupt)",
		"",
		`──────────────────────────────── @${BUSY_LEAD} ──`,
		"❯ ",
		"──────────────────────────────────────────────────────",
		"  ⏵⏵ bypass permissions on",
	].join("\n"),
};

/** What launchd hands the Bridge: no terminal, no locale. */
function launchdLikeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(base)) {
		if (key === "TMUX" || key === "TMUX_PANE" || key === "LANG") continue;
		if (key.startsWith("LC_")) continue;
		env[key] = value;
	}
	return env;
}

describe.skipIf(!hasTools)(
	"production Claude wiring from a launchd-like env (no TMUX, no LANG/LC_*)",
	() => {
		let room = "";
		let registry = "";
		const sockets: string[] = [];

		beforeAll(() => {
			// Short root: the canonical socket path must stay under 90 bytes.
			room = mkdtempSync("/tmp/fly2882-rt-");
			registry = join(room, "launchd-leads.json");
			const claude = join(room, "bin", "claude");
			mkdirSync(join(room, "bin"));
			execFileSync("cc", ["-x", "c", "-o", claude, "-"], {
				input: "#include <unistd.h>\nint main(void){for(;;)pause();}\n",
				timeout: 60_000,
			});
			const rows = [];
			for (const [slot, leadId] of [IDLE_LEAD, BUSY_LEAD].entries()) {
				const runtime = join(room, "launchd", leadId);
				const leadState = join(room, "q", String(slot));
				const socket = deriveLeadSocketPath(`${PROJECT}/${leadId}`, leadState);
				mkdirSync(runtime, { recursive: true });
				mkdirSync(join(leadState, "sock"), { recursive: true });
				const screen = join(runtime, "screen.txt");
				const body = join(runtime, "lead-body.sh");
				const manifest = join(runtime, "manifest.json");
				const plist = join(runtime, "lead.plist");
				const label = `com.flywheel.qa.lead.slot-3.${leadId}`;
				writeFileSync(screen, SCREENS[leadId]!);
				// Claude is a direct child of the pane's `bash lead-body.sh`.
				writeFileSync(body, `cat '${screen}'\n'${claude}'\nexit 0\n`);
				writeFileSync(
					manifest,
					JSON.stringify({ projectName: PROJECT, leadId, socketPath: socket }),
				);
				writeFileSync(
					plist,
					[
						'<?xml version="1.0" encoding="UTF-8"?>',
						'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
						'<plist version="1.0"><dict>',
						`<key>Label</key><string>${label}</string>`,
						`<key>ProgramArguments</key><array><string>/opt/flywheel/scripts/flywheel-lead-wrapper-v2.sh</string><string>${manifest}</string></array>`,
						`<key>EnvironmentVariables</key><dict><key>FLYWHEEL_STATE_DIR</key><string>${leadState}</string></dict>`,
						"</dict></plist>",
					].join("\n"),
				);
				rows.push({ label, plist, manifest });
				// Registered first: a client timeout can still leave a live server.
				sockets.push(socket);
				execFileSync(
					"tmux",
					[
						"-f",
						"/dev/null",
						"-S",
						socket,
						"new-session",
						"-d",
						"-s",
						"main",
						"-x",
						"80",
						"-y",
						"24",
						"bash",
						body,
					],
					{ env: launchdLikeEnv(process.env), timeout: 5000 },
				);
			}
			writeFileSync(registry, JSON.stringify(rows));
			// Ready once the pane's bash has its Claude child (screen printed).
			for (const socket of sockets) {
				const panePid = execFileSync(
					"tmux",
					["-S", socket, "display-message", "-p", "-t", "%0", "#{pane_pid}"],
					{ encoding: "utf8", timeout: 5000 },
				).trim();
				let ready = false;
				for (let i = 0; i < 100 && !ready; i++) {
					ready = execFileSync("ps", ["-A", "-o", "ppid=,ucomm="], {
						encoding: "utf8",
						timeout: 5000,
					})
						.split("\n")
						.some((row) => /^\s*(\d+)\s+claude\s*$/.exec(row)?.[1] === panePid);
					if (!ready) spawnSync("sleep", ["0.05"]);
				}
				expect(ready).toBe(true);
			}
		}, 90_000);

		afterAll(() => {
			for (const socket of sockets)
				spawnSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore" });
			if (room) rmSync(room, { recursive: true, force: true });
		});

		it("reads idle and busy (never lead_window_unavailable) with the Bridge's inherited env", async () => {
			const saved = { ...process.env };
			for (const key of Object.keys(process.env))
				if (!(key in launchdLikeEnv(saved))) delete process.env[key];
			try {
				expect(process.env.TMUX).toBeUndefined();
				expect(process.env.LANG).toBeUndefined();
				const svc = createProductionLeadActivityService({
					projects: [
						{
							projectName: PROJECT,
							projectRoot: room,
							leads: [IDLE_LEAD, BUSY_LEAD].map((agentId) => ({
								agentId,
								forumChannel: "1",
								chatChannel: "2",
								match: {},
							})),
						},
					] as unknown as ProjectEntry[],
					store: { getLeadEventSessionKeyBySeq: () => null },
					env: {
						FLYWHEEL_STATE_DIR: room,
						FLYWHEEL_LEAD_LAUNCHD_REGISTRY: registry,
					},
				});
				const idle = await svc.read(PROJECT, IDLE_LEAD);
				const busy = await svc.read(PROJECT, BUSY_LEAD);
				// An unknown answer shows its reason, e.g. lead_window_unavailable.
				expect(
					idle?.state === "unknown" ? idle.unknown.reason : idle?.state,
				).toBe("idle");
				expect(
					busy?.state === "unknown" ? busy.unknown.reason : busy?.state,
				).toBe("busy");
				expect(busy).toMatchObject({
					turn: { elapsedMs: 65_000, precision: "second" },
					trigger: { kind: "undetermined", reason: "causality_unproven" },
				});
			} finally {
				for (const key of Object.keys(process.env)) delete process.env[key];
				Object.assign(process.env, saved);
			}
		});
	},
);
