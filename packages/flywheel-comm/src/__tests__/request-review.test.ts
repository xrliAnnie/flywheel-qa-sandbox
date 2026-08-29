import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestReview } from "../commands/request-review.js";

// ── FLY-1188 §7.1 — request-review CLI (runner side) ────────────────────
// Durable local intent FIRST → POST → bounded retry → durable-accepted ack
// or FAIL-CLOSE (marker + non-zero exit; the runner must not park on an
// unregistered gate).

class ExitSentinel extends Error {
	constructor(public code: number) {
		super(`exit ${code}`);
	}
}

describe("request-review", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1188-rr-"));
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new ExitSentinel(code ?? 0);
		}) as never);
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
	});

	const baseEnv = {
		FLYWHEEL_BRIDGE_URL: "http://bridge.test",
		FLYWHEEL_INGEST_TOKEN: "tok",
	} as NodeJS.ProcessEnv;

	function marker(requestId: string): Record<string, unknown> {
		return JSON.parse(
			readFileSync(join(dir, `${requestId}.json`), "utf8"),
		) as Record<string, unknown>;
	}

	async function run(opts: Parameters<typeof requestReview>[0]) {
		try {
			await requestReview({ stateDir: dir, env: baseEnv, ...opts });
			throw new Error("did not exit");
		} catch (err) {
			if (err instanceof ExitSentinel) return err.code;
			throw err;
		}
	}

	it("durable-accepted ack → exit 0, marker flips posting→accepted", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ accepted: true, requestId: "r1", skipped: false }),
					{ status: 200 },
				),
		);
		const code = await run({
			execId: "e1",
			type: "code",
			questionId: "q1",
			requestId: "r1",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(code).toBe(0);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe("http://bridge.test/review-requests");
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bearer tok",
		);
		expect(marker("r1").status).toBe("accepted");
	});

	it("bare 2xx WITHOUT accepted:true is NOT an ack (fail-close after retries)", async () => {
		const fetchImpl = vi.fn(
			async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
		);
		const code = await run({
			execId: "e1",
			type: "code",
			questionId: "q1",
			requestId: "r2",
			fetchImpl: fetchImpl as unknown as typeof fetch,
			attemptCount: 2,
			backoffMs: [0],
		});
		expect(code).toBe(2);
		expect(marker("r2").status).toBe("failed");
	});

	it("4xx validation rejection fails IMMEDIATELY (no useless retries)", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ accepted: false, reason: "gate missing" }),
					{ status: 409 },
				),
		);
		const code = await run({
			execId: "e1",
			type: "design",
			questionId: "q-none",
			planPath: "doc/plan.md",
			requestId: "r3",
			fetchImpl: fetchImpl as unknown as typeof fetch,
			attemptCount: 4,
			backoffMs: [0, 0, 0],
		});
		expect(code).toBe(2);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(marker("r3").status).toBe("failed");
		expect(String(marker("r3").error)).toContain("gate missing");
	});

	it("network failure exhausts bounded retries → fail-close marker + exit 2", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("ECONNREFUSED");
		});
		const code = await run({
			execId: "e1",
			type: "code",
			questionId: "q1",
			requestId: "r4",
			fetchImpl: fetchImpl as unknown as typeof fetch,
			attemptCount: 3,
			backoffMs: [0, 0],
		});
		expect(code).toBe(2);
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		const m = marker("r4");
		expect(m.status).toBe("failed");
		expect(m.questionId).toBe("q1");
	});

	it("SKIPPED ack surfaces to stdout + marker (codex-skip lane)", async () => {
		const logs: string[] = [];
		(console.log as unknown as ReturnType<typeof vi.fn>).mockImplementation(
			(m: string) => logs.push(m),
		);
		const fetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ accepted: true, requestId: "r5", skipped: true }),
					{ status: 200 },
				),
		);
		const code = await run({
			execId: "e1",
			type: "code",
			questionId: "q1",
			requestId: "r5",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(code).toBe(0);
		expect(JSON.parse(logs[0] ?? "{}").skipped).toBe(true);
		expect(marker("r5").skipped).toBe(true);
	});

	it("R12 HIGH: unpersistable INTENT marker aborts BEFORE any POST (exit 2)", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ accepted: true }), { status: 200 }),
		);
		const code = await run({
			execId: "e1",
			type: "code",
			questionId: "q1",
			requestId: "r6",
			stateDir: "/dev/null/impossible", // mkdir under a file → write fails
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(code).toBe(2);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("usage errors exit 1 before any marker/POST", async () => {
		expect(await run({ execId: "e1", type: "vibes", questionId: "q1" })).toBe(
			1,
		);
		expect(await run({ execId: "e1", type: "code", questionId: "" })).toBe(1);
		expect(await run({ execId: "e1", type: "design", questionId: "q1" })).toBe(
			1,
		); // design without --plan
		expect(existsSync(dir)).toBe(true); // dir exists but no marker files
	});
});
