import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { qaResult } from "../commands/qa-result.js";
import { stage } from "../commands/stage.js";

vi.mock("../bridge-pressure-snapshot.js", () => ({
	printBridgePressure: vi.fn(),
}));
let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "fly1956-drill-"));
	for (const [key, value] of Object.entries({
		HOME: home,
		FLYWHEEL_COMM_DB: join(home, "comm.db"),
		FLYWHEEL_EXEC_ID: "drill-exec",
		FLYWHEEL_ISSUE_ID: "FLY-1956",
		FLYWHEEL_PROJECT_NAME: "flywheel",
		FLYWHEEL_BRIDGE_URL: "http://bridge.invalid",
		FLYWHEEL_INGEST_TOKEN: "test-token",
		FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL: "test-credential",
		FLYWHEEL_RUNNER_MEMORY_DIR: "",
		FLYWHEEL_RUNNER_MEMORY_SNAPSHOT: "",
	}))
		vi.stubEnv(key, value);
	vi.useFakeTimers();
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	rmSync(home, { recursive: true, force: true });
});

it("accepts an 8-second stage response on the first attempt and removes the queue file", async () => {
	const fetchMock = vi.fn<typeof fetch>(
		() =>
			new Promise((resolve) =>
				setTimeout(
					() =>
						resolve(new Response(JSON.stringify({ ok: true, applied: true }))),
					8000,
				),
			),
	);
	vi.stubGlobal("fetch", fetchMock);
	const pending = stage({ subcommand: "set", stageName: "implement" });
	await vi.advanceTimersByTimeAsync(7999);
	expect(fetchMock).toHaveBeenCalledTimes(1);
	const dir = join(home, ".flywheel", "state", "stage-queue", "drill-exec");
	expect(
		readdirSync(dir).filter((name) => name.endsWith(".json")),
	).toHaveLength(1);
	await vi.advanceTimersByTimeAsync(1);
	await pending;
	expect(fetchMock).toHaveBeenCalledTimes(1);
	expect(
		readdirSync(dir).filter((name) => name.endsWith(".json")),
	).toHaveLength(0);
});

it.each([
	{ delay: 25000, attempts: 2 },
	{ delay: 45000, attempts: 3 },
])(
	"lands QA at $delay ms in $attempts requests with one durable request id",
	async ({ delay, attempts }) => {
		// One simulated server operation survives abandoned client connections.
		// Router singleflight itself is tested with the real decision router separately.
		let finish!: (value: unknown) => void;
		const operation = new Promise((resolve) => {
			finish = resolve;
		});
		const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
			const receipt = await Promise.race([
				operation,
				new Promise<never>((_resolve, reject) =>
					init!.signal!.addEventListener(
						"abort",
						() => reject(new Error("connection aborted")),
						{ once: true },
					),
				),
			]);
			return new Response(JSON.stringify(receipt));
		});
		vi.stubGlobal("fetch", fetchMock);
		setTimeout(
			() =>
				finish({
					ok: true,
					claimId: 31,
					serverSeq: 47,
					idempotentReplay: true,
				}),
			delay,
		);
		const pending = qaResult({ status: "pass", targetExec: "implement-exec" });
		await vi.advanceTimersByTimeAsync(delay);
		const result = await pending;
		expect(result).toMatchObject({ exitCode: 0 });
		expect(fetchMock).toHaveBeenCalledTimes(attempts);
		const bodies = fetchMock.mock.calls.map((call) => String(call[1]!.body));
		expect(new Set(bodies).size).toBe(1);
		expect(JSON.parse(bodies[0]).client_request_id).toEqual(expect.any(String));
		expect(
			existsSync(
				join(home, ".flywheel", "state", "qa-result-failed", "drill-exec.json"),
			),
		).toBe(false);
		expect(console.log).toHaveBeenCalledWith(
			expect.stringContaining("RECEIPT landed="),
		);
	},
);
