import { execFile } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { HookEvent } from "../HookCallbackServer.js";
import { HookCallbackServer } from "../HookCallbackServer.js";

// FLY-2808 QA: the SessionStart identity hook must reach the real callback
// server. A curl stub that always succeeds hid a GET request that the server
// rejects with 405, so every Claude resume failed with callback_failed.
const REPO_ROOT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../..",
);
const HOOK = join(REPO_ROOT, "scripts/hooks/flywheel-session-identity.sh");
const TOKEN = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const SESSION = "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0";
const MODEL = "claude-opus-5-5";

function runHook(
	input: string,
	env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stderr: string }> {
	return new Promise((resolvePromise) => {
		const child = execFile(
			"bash",
			[HOOK],
			{ env, timeout: 20_000 },
			(error, _stdout, stderr) => {
				const code =
					error && typeof (error as { code?: unknown }).code === "number"
						? ((error as { code: number }).code as number)
						: error
							? null
							: 0;
				resolvePromise({ code, stderr: String(stderr) });
			},
		);
		child.stdin?.end(input);
	});
}

describe("flywheel-session-identity.sh against the real HookCallbackServer", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	it("delivers the SessionStart identity evidence and exits 0 once the ack lands", async () => {
		const root = realpathSync(
			mkdtempSync(join(tmpdir(), "fly2808-identity-hook-")),
		);
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const worktree = join(root, "worktree");
		mkdirSync(worktree);
		const ackPath = join(root, "identity.verified");
		const manifest = join(root, "manifest.json");
		writeFileSync(
			manifest,
			JSON.stringify({
				schemaVersion: 1,
				generation: 2,
				launchToken: TOKEN,
				expectedSessionId: SESSION,
				expectedModel: MODEL,
				expectedCwd: worktree,
				ackPath,
			}),
		);

		const server = new HookCallbackServer(0);
		const port = await server.start();
		cleanups.push(() => server.stop());
		const events: HookEvent[] = [];
		server.on("hook", (event: HookEvent) => {
			events.push(event);
			if (event.eventType === "SessionStart" && event.sessionId === SESSION) {
				writeFileSync(
					ackPath,
					JSON.stringify({
						schemaVersion: 1,
						generation: 2,
						launchToken: TOKEN,
						sessionId: SESSION,
					}),
				);
			}
		});

		const result = await runHook(
			JSON.stringify({
				hook_event_name: "SessionStart",
				session_id: SESSION,
				model: MODEL,
				cwd: worktree,
				source: "resume",
			}),
			{
				PATH: process.env.PATH,
				HOME: root,
				FLYWHEEL_RESUME_IDENTITY_MANIFEST: manifest,
				FLYWHEEL_CALLBACK_PORT: String(port),
				FLYWHEEL_CALLBACK_TOKEN: TOKEN,
				FLYWHEEL_ISSUE_ID: "FLY-2808",
			},
		);

		expect(result.stderr).not.toContain("FLYWHEEL_RESUME_IDENTITY_DENIED");
		expect(result.code).toBe(0);
		expect(events).toEqual([
			expect.objectContaining({
				token: TOKEN,
				sessionId: SESSION,
				issueId: "FLY-2808",
				eventType: "SessionStart",
				model: MODEL,
				cwd: worktree,
				source: "resume",
			}),
		]);
	}, 30_000);
});
