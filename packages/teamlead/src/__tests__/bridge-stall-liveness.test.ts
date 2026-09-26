import { execFile, spawn } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { LOOP_GUARD_WORKER_SOURCE } from "../bridge/BridgeEventLoopGuard.js";

const execFileAsync = promisify(execFile);

it("pages once for real Bridge health timeouts and clears once after the same process recovers", async () => {
	const root = mkdtempSync(join(tmpdir(), "fly2920-health-stall-"));
	const source = join(root, "worker.cjs");
	const log = join(root, "loop.log");
	const stalled = join(root, "stalled");
	const resume = join(root, "resume");
	const posts = join(root, "posts");
	const curlCodes = join(root, "curl-codes");
	writeFileSync(source, LOOP_GUARD_WORKER_SOURCE);
	writeFileSync(posts, "");
	const child = spawn(
		process.execPath,
		[
			fileURLToPath(
				new URL(
					"./fixtures/loop-guard/health-stall-harness.mjs",
					import.meta.url,
				),
			),
			source,
			log,
			stalled,
			resume,
		],
		{ stdio: ["ignore", "ignore", "pipe", "ipc"] },
	);
	let stderr = "";
	child.stderr?.on("data", (chunk) => {
		stderr = (stderr + chunk).slice(-4096);
	});
	const exited = new Promise((resolve) =>
		child.once("exit", (code, signal) => resolve({ code, signal })),
	);
	try {
		const ready = await new Promise<{ port: number; pid: number }>(
			(resolve, reject) => {
				child.once("message", (message) =>
					resolve(message as { port: number; pid: number }),
				);
				child.once("error", reject);
				child.once("exit", () =>
					reject(new Error(`fixture exited before ready: ${stderr}`)),
				);
			},
		);
		const probeScript = fileURLToPath(
			new URL("../../../../scripts/bridge-liveness-probe.sh", import.meta.url),
		);
		async function probe(now: number) {
			await execFileAsync(
				"bash",
				[
					"-c",
					`
source "$1"
_probe_curl() {
  local rc=0
  curl -sf --max-time 0.1 "\${BRIDGE_URL}/health" 2>/dev/null || rc=$?
  printf '%s\\n' "$rc" >> "$PROBE_CURL_CODES"
  return "$rc"
}
_probe_now() { printf '%s' "$PROBE_NOW"; }
_probe_post() { printf '%s\\n' "$1" >> "$PROBE_POSTS"; }
probe_once
`,
					"probe-test",
					probeScript,
				],
				{
					env: {
						...process.env,
						BRIDGE_URL: `http://127.0.0.1:${ready.port}`,
						PROBE_NOW: String(now),
						PROBE_POSTS: posts,
						PROBE_CURL_CODES: curlCodes,
						FLYWHEEL_PROBE_STATE_FILE: join(root, "state.json"),
						FLYWHEEL_BRIDGE_LOG_ERROR_MARKER: join(root, "rotation.json"),
						FLYWHEEL_BRIDGE_DOWN_ESCALATE_MIN: "3",
						FLYWHEEL_LIVENESS_MANIFEST_DEGRADED_MIN: "999",
					},
					timeout: 5000,
				},
			);
		}
		await probe(1000);
		expect(readFileSync(posts, "utf8")).toBe("");
		child.send("stall");
		await vi.waitFor(() => expect(existsSync(stalled)).toBe(true));
		await probe(1060);
		await probe(1120);
		expect(readFileSync(posts, "utf8")).toBe("");
		await probe(1180);
		await probe(1240);
		expect(readFileSync(posts, "utf8").trim().split("\n")).toHaveLength(1);
		expect(readFileSync(posts, "utf8")).toContain("连续 down");
		expect(readFileSync(curlCodes, "utf8").trim().split("\n")).toEqual([
			"0",
			"28",
			"28",
			"28",
			"28",
		]);
		expect(readFileSync(log, "utf8")).not.toContain(
			"stall_recovered_after_freeze",
		);
		expect(child.exitCode).toBeNull();
		expect(child.signalCode).toBeNull();
		writeFileSync(resume, "resume");
		await vi.waitFor(() =>
			expect(readFileSync(log, "utf8")).toContain(
				"stall_recovered_after_freeze",
			),
		);
		await probe(1300);
		await probe(1360);
		const messages = readFileSync(posts, "utf8").trim().split("\n");
		expect(messages).toHaveLength(2);
		expect(messages[1]).toContain("恢复");
		expect(child.pid).toBe(ready.pid);
		expect(child.signalCode).toBeNull();
		const records = readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records.map((record) => record.event)).toEqual([
			"bridge_event_loop_stall",
			"stall_recovered_after_freeze",
		]);
	} finally {
		writeFileSync(resume, "resume");
		if (child.connected) child.send("close");
		await exited;
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);
