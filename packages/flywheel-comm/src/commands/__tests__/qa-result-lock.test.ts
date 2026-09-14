vi.mock("../../bridge-pressure-snapshot.js", () => ({
	printBridgePressure: vi.fn(),
}));

import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { qaResult } from "../qa-result.js";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

it("holds the QA ownership lock during delivery and returns refusal only after release", async () => {
	const home = mkdtempSync(join(tmpdir(), "fly1956-qa-lock-"));
	for (const [key, value] of Object.entries({
		HOME: home,
		FLYWHEEL_COMM_DB: join(home, "comm.db"),
		FLYWHEEL_EXEC_ID: "qa-lock",
		FLYWHEEL_ISSUE_ID: "FLY-1956",
		FLYWHEEL_PROJECT_NAME: "flywheel",
		FLYWHEEL_BRIDGE_URL: "http://bridge.invalid",
		FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL: "test-credential",
		FLYWHEEL_RUNNER_MEMORY_DIR: "",
		FLYWHEEL_RUNNER_MEMORY_SNAPSHOT: "",
	}))
		vi.stubEnv(key, value);
	vi.spyOn(console, "error").mockImplementation(() => {});
	const exit = vi.spyOn(process, "exit").mockImplementation(() => {
		throw new Error("unexpected process.exit");
	});
	const lock = join(
		home,
		".flywheel",
		"state",
		"qa-result-failed",
		"qa-lock.lock",
	);
	let heldDuringPost = false;
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			heldDuringPost = existsSync(lock);
			return new Response(
				JSON.stringify({ ok: false, reason: "credential_revoked" }),
				{ status: 409 },
			);
		}),
	);
	try {
		await expect(
			qaResult({ status: "pass", targetExec: "impl" }),
		).resolves.toMatchObject({ exitCode: 1 });
		expect(heldDuringPost).toBe(true);
		expect(existsSync(lock)).toBe(false);
		expect(exit).not.toHaveBeenCalled();
		// A real process must unwind the ownership lock before setting its exit code.
		const script = join(home, "refusal.mts");
		const persistedId = JSON.parse(
			readFileSync(join(lock, "..", "qa-lock.json"), "utf8"),
		).client_request_id;
		writeFileSync(
			script,
			`
import { qaResult } from ${JSON.stringify(new URL("../qa-result.ts", import.meta.url).href)};
globalThis.fetch = async (_url, init) => {
  console.log("REPLAY_ID=" + JSON.parse(init.body).client_request_id);
  return new Response(JSON.stringify({ok: false, reason: "credential_revoked"}), {status: 409});
};
const result = await qaResult({status: "pass", targetExec: "impl"});
process.exitCode = result.exitCode;
`,
		);
		const child = spawnSync(process.execPath, ["--import", "tsx", script], {
			env: { ...process.env },
			encoding: "utf8",
			timeout: 10_000,
		});
		expect(child.error).toBeUndefined();
		expect(child.stderr).toContain("deterministic rejection");
		expect(child.status).toBe(1);
		expect(child.stdout.trim()).toBe(`REPLAY_ID=${persistedId}`);
		expect(existsSync(lock)).toBe(false);
		const crashScript = join(home, "crash.mts");
		writeFileSync(
			crashScript,
			`
import { qaResult } from ${JSON.stringify(new URL("../qa-result.ts", import.meta.url).href)};
globalThis.fetch = async (_url, init) => {
  console.log("POST=" + JSON.parse(init.body).client_request_id);
  return new Promise(() => {});
};
await qaResult({status: "pass", targetExec: "impl"});
`,
		);
		const crashed = spawn(process.execPath, ["--import", "tsx", crashScript], {
			env: { ...process.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let posted = "";
		let contentionError: unknown;
		let checkedOwner = false;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				crashed.kill("SIGKILL");
				reject(new Error("child did not reach POST"));
			}, 10_000);
			crashed.stdout.on("data", async (chunk) => {
				posted += chunk.toString();
				if (!posted.includes("\n") || checkedOwner) return;
				checkedOwner = true;
				let clock = Date.now();
				const now = vi.spyOn(Date, "now").mockImplementation(() => {
					clock += 60_001;
					return clock;
				});
				try {
					const fetchMock = vi.fn();
					vi.stubGlobal("fetch", fetchMock);
					await expect(
						qaResult({ status: "pass", targetExec: "impl" }),
					).resolves.toMatchObject({ exitCode: 2, label: "lock_owned" });
					expect(fetchMock).not.toHaveBeenCalled();
					expect(existsSync(lock)).toBe(true);
				} catch (error) {
					contentionError = error;
				} finally {
					now.mockRestore();
					crashed.kill("SIGKILL");
				}
			});
			crashed.on("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			crashed.on("exit", (_code, signal) => {
				clearTimeout(timer);
				if (contentionError) reject(contentionError);
				else if (signal === "SIGKILL") resolve();
				else reject(new Error(`unexpected child exit ${_code}/${signal}`));
			});
		});
		expect(posted.trim()).toBe(`POST=${persistedId}`);
		expect(existsSync(lock)).toBe(true);
		const recovery = spawnSync(process.execPath, ["--import", "tsx", script], {
			env: { ...process.env },
			encoding: "utf8",
			timeout: 10_000,
		});
		expect(recovery.status).toBe(1);
		expect(recovery.stdout.trim()).toBe(`REPLAY_ID=${persistedId}`);
		expect(existsSync(lock)).toBe(false);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

it.each([
	["refusal", 1, 1],
	["exhaustion", 1, 4],
	["unrecorded", 3, 0],
	["conflict", 1, 0],
] as const)(
	"releases the ownership lock before real process exit: %s",
	(mode, exitCode, requests) => {
		const home = mkdtempSync(join(tmpdir(), "fly1956-qa-exit-"));
		const script = join(home, "exit.mts");
		writeFileSync(
			script,
			`
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { qaResult } from ${JSON.stringify(new URL("../qa-result.ts", import.meta.url).href)};
const mode = ${JSON.stringify(mode)};
const dir = join(process.env.HOME, ".flywheel/state/qa-result-failed");
fs.mkdirSync(dir, { recursive: true });
if (mode === "conflict") fs.writeFileSync(join(dir, "qa-exit.json"), JSON.stringify({
  execution_id: "qa-exit", client_request_id: "original", phase: "in_flight",
  recoverable_verdict: { executionId: "qa-exit", targetExecutionId: "impl", status: "fail", clientRequestId: "original" }
}));
if (mode === "unrecorded") {
  const open = fs.openSync;
  fs.openSync = (path, ...args) => {
    if (String(path).endsWith(".tmp")) throw new Error("injected marker disk failure");
    return open(path, ...args);
  };
  syncBuiltinESMExports();
}
let requests = 0;
globalThis.fetch = async (_url, init) => {
  if (init?.method !== "POST") return new Response("{}", { status: 503 });
  requests++;
  if (!fs.existsSync(join(dir, "qa-exit.lock"))) throw new Error("lock missing during POST");
  return new Response(JSON.stringify({ok: false, reason: "credential_revoked"}), {status: mode === "exhaustion" ? 503 : 409});
};
const outcome = await qaResult({ status: "pass", targetExec: "impl" });
console.log(JSON.stringify({ outcome, requests, lockPresent: fs.existsSync(join(dir, "qa-exit.lock")) }));
process.exitCode = outcome.exitCode;
`,
		);
		try {
			const child = spawnSync(process.execPath, ["--import", "tsx", script], {
				env: {
					...process.env,
					HOME: home,
					FLYWHEEL_COMM_DB: join(home, "comm.db"),
					FLYWHEEL_EXEC_ID: "qa-exit",
					FLYWHEEL_ISSUE_ID: "FLY-1956",
					FLYWHEEL_PROJECT_NAME: "flywheel",
					FLYWHEEL_BRIDGE_URL: "http://bridge.invalid",
					FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL: "test-credential",
					FLYWHEEL_RUNNER_MEMORY_DIR: "",
					FLYWHEEL_RUNNER_MEMORY_SNAPSHOT: "",
				},
				encoding: "utf8",
				timeout: 15_000,
			});
			expect(child.error).toBeUndefined();
			expect(child.status, child.stderr).toBe(exitCode);
			expect(JSON.parse(child.stdout.trim())).toMatchObject({
				outcome: { exitCode },
				requests,
				lockPresent: false,
			});
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	},
	20_000,
);
