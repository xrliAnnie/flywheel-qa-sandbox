/**
 * FLY-137 Phase 5: await-codex-gate tests.
 *
 * Validates fail-closed semantics of the Runner-side Codex review gate:
 * the polling loop, schema validation, skip-marker bypass, malformed
 * JSON handling, and timeout.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitCodexGate } from "../commands/await-codex-gate.js";

/** git-init `dir` with one empty commit; return its 40-hex HEAD. */
function gitInitHead(dir: string): string {
	const opts = { cwd: dir, stdio: "ignore" as const };
	execFileSync("git", ["init", "-q"], opts);
	execFileSync("git", ["config", "user.email", "t@t.dev"], opts);
	execFileSync("git", ["config", "user.name", "t"], opts);
	execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], opts);
	return execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: dir,
		encoding: "utf8",
	})
		.trim()
		.toLowerCase();
}

describe("awaitCodexGate", () => {
	let tmpRoot: string;
	let codexDir: string;
	let exitSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;
	let logSpy: ReturnType<typeof vi.spyOn>;
	const execId = "exec-await-1";

	beforeEach(() => {
		tmpRoot = join(tmpdir(), `await-gate-${Date.now()}-${Math.random()}`);
		codexDir = join(tmpRoot, ".flywheel", "runs", execId, "codex");
		mkdirSync(codexDir, { recursive: true });

		exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number) => {
			throw new Error(`process.exit(${code})`);
		});
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("exits 0 on a valid APPROVED design-review.json", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ allowed: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		writeFileSync(
			join(codexDir, "design-review.json"),
			JSON.stringify({
				executionId: execId,
				reviewType: "design",
				status: "APPROVED",
				reviewedTarget: "doc/engineer/plan/draft/foo.md",
				timestamp: new Date().toISOString(),
				rounds: 2,
				codexThreadId: "thread-abc",
				requestId: "request-abc",
				reviewedPlanBlobSha: "a".repeat(40),
			}),
		);

		await expect(
			awaitCodexGate({
				reviewType: "design",
				execId,
				worktreePath: tmpRoot,
				timeoutMs: 5_000,
				pollIntervalMs: 50,
				env: {
					FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9999/",
					FLYWHEEL_INGEST_TOKEN: "ingest-token",
				},
				fetchImpl,
			}),
		).rejects.toThrow("process.exit(0)");

		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining("design review APPROVED"),
		);
		expect(fetchImpl).toHaveBeenCalledOnce();
		const [url, init] = fetchImpl.mock.calls[0]!;
		expect(url).toBe("http://127.0.0.1:9999/design-review-validation");
		expect(JSON.parse(String(init?.body))).toEqual({
			executionId: execId,
			reviewType: "design",
			status: "APPROVED",
			reviewedTarget: "doc/engineer/plan/draft/foo.md",
			requestId: "request-abc",
			reviewedPlanBlobSha: "a".repeat(40),
		});
	});

	it("fails closed on the legacy design result schema while binding is enabled", async () => {
		writeFileSync(
			join(codexDir, "design-review.json"),
			JSON.stringify({
				executionId: execId,
				reviewType: "design",
				status: "APPROVED",
				reviewedTarget: "doc/plan.md",
				timestamp: new Date().toISOString(),
			}),
		);
		await expect(
			awaitCodexGate({
				reviewType: "design",
				execId,
				worktreePath: tmpRoot,
				timeoutMs: 1_000,
				pollIntervalMs: 50,
				env: {},
				fetchImpl: vi.fn(),
			}),
		).rejects.toThrow("process.exit(1)");
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("requestId"));
	});

	it("fails closed when Bridge credentials are missing or Bridge is unreachable", async () => {
		writeFileSync(
			join(codexDir, "design-review.json"),
			JSON.stringify({
				executionId: execId,
				reviewType: "design",
				status: "APPROVED",
				reviewedTarget: "doc/plan.md",
				requestId: "request-1",
				reviewedPlanBlobSha: "b".repeat(40),
				timestamp: new Date().toISOString(),
			}),
		);
		await expect(
			awaitCodexGate({
				reviewType: "design",
				execId,
				worktreePath: tmpRoot,
				timeoutMs: 1_000,
				env: {},
			}),
		).rejects.toThrow("process.exit(1)");
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("FLYWHEEL_BRIDGE_URL"),
		);

		errorSpy.mockClear();
		await expect(
			awaitCodexGate({
				reviewType: "design",
				execId,
				worktreePath: tmpRoot,
				timeoutMs: 1_000,
				env: {
					FLYWHEEL_BRIDGE_URL: "http://bridge.invalid",
					FLYWHEEL_INGEST_TOKEN: "token",
				},
				fetchImpl: vi.fn(async () => {
					throw new Error("connection refused");
				}),
			}),
		).rejects.toThrow("process.exit(1)");
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("connection refused"),
		);
	});

	it("fails closed on a Bridge denial without accepting returned authority", async () => {
		writeFileSync(
			join(codexDir, "design-review.json"),
			JSON.stringify({
				executionId: execId,
				reviewType: "design",
				status: "APPROVED",
				reviewedTarget: "doc/plan.md",
				requestId: "request-1",
				reviewedPlanBlobSha: "c".repeat(40),
				timestamp: new Date().toISOString(),
			}),
		);
		await expect(
			awaitCodexGate({
				reviewType: "design",
				execId,
				worktreePath: tmpRoot,
				timeoutMs: 1_000,
				env: {
					FLYWHEEL_BRIDGE_URL: "http://bridge.invalid",
					FLYWHEEL_INGEST_TOKEN: "token",
					FLYWHEEL_INSTRUCTION_PATH_CHECK: "0",
				},
				fetchImpl: vi.fn(
					async () =>
						new Response(
							JSON.stringify({
								allowed: false,
								reason: "current request changed",
								expectedPlanBlobSha: "do-not-trust",
							}),
							{ status: 409, headers: { "Content-Type": "application/json" } },
						),
				),
			}),
		).rejects.toThrow("process.exit(1)");
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("current request changed"),
		);
	});

	it("FLY-1981 rejects the legacy local design result when the retired env is 0", async () => {
		const fetchImpl = vi.fn();
		writeFileSync(
			join(codexDir, "design-review.json"),
			JSON.stringify({
				executionId: execId,
				reviewType: "design",
				status: "APPROVED",
				reviewedTarget: "doc/legacy-plan.md",
				timestamp: new Date().toISOString(),
			}),
		);
		await expect(
			awaitCodexGate({
				reviewType: "design",
				execId,
				worktreePath: tmpRoot,
				timeoutMs: 1_000,
				env: { FLYWHEEL_INSTRUCTION_PATH_CHECK: "0" },
				fetchImpl,
			}),
		).rejects.toThrow("process.exit(1)");
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("requestId"));
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("exits 0 on a valid skip.json marker without needing a result file", async () => {
		writeFileSync(
			join(codexDir, "skip.json"),
			JSON.stringify({
				executionId: execId,
				reviewType: "design",
				reason: "codex-skip-label",
				timestamp: new Date().toISOString(),
			}),
		);

		await expect(
			awaitCodexGate({
				reviewType: "design",
				execId,
				worktreePath: tmpRoot,
				timeoutMs: 5_000,
				pollIntervalMs: 50,
			}),
		).rejects.toThrow("process.exit(0)");

		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining("codex-skip-bypass"),
		);
	});

	it("ignores skip.json with mismatching reviewType (must match exec + type)", async () => {
		// Marker is for `code` review but we're awaiting `design` → not a bypass.
		writeFileSync(
			join(codexDir, "skip.json"),
			JSON.stringify({
				executionId: execId,
				reviewType: "code",
				reason: "codex-skip-label",
				timestamp: new Date().toISOString(),
			}),
		);

		// No result file → should time out.
		await expect(
			awaitCodexGate({
				reviewType: "design",
				execId,
				worktreePath: tmpRoot,
				timeoutMs: 500,
				pollIntervalMs: 50,
			}),
		).rejects.toThrow("process.exit(1)");

		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("timeout"));
	});

	it("exits 1 (fail-closed) on malformed result JSON", async () => {
		writeFileSync(join(codexDir, "design-review.json"), "{ not valid json");

		await expect(
			awaitCodexGate({
				reviewType: "design",
				execId,
				worktreePath: tmpRoot,
				timeoutMs: 5_000,
				pollIntervalMs: 50,
			}),
		).rejects.toThrow("process.exit(1)");

		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("failed to parse"),
		);
	});

	it("exits 1 (fail-closed) on schema mismatch — wrong executionId", async () => {
		writeFileSync(
			join(codexDir, "design-review.json"),
			JSON.stringify({
				executionId: "wrong-exec",
				reviewType: "design",
				status: "APPROVED",
				reviewedTarget: "doc/foo.md",
				timestamp: new Date().toISOString(),
			}),
		);

		await expect(
			awaitCodexGate({
				reviewType: "design",
				execId,
				worktreePath: tmpRoot,
				timeoutMs: 5_000,
				pollIntervalMs: 50,
			}),
		).rejects.toThrow("process.exit(1)");

		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("executionId mismatch"),
		);
	});

	it("exits 1 (fail-closed) when status != APPROVED", async () => {
		writeFileSync(
			join(codexDir, "design-review.json"),
			JSON.stringify({
				executionId: execId,
				reviewType: "design",
				status: "REJECTED",
				reviewedTarget: "doc/foo.md",
				timestamp: new Date().toISOString(),
			}),
		);

		await expect(
			awaitCodexGate({
				reviewType: "design",
				execId,
				worktreePath: tmpRoot,
				timeoutMs: 5_000,
				pollIntervalMs: 50,
			}),
		).rejects.toThrow("process.exit(1)");

		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("status not APPROVED"),
		);
	});

	it("exits 1 (fail-closed) when timestamp is older than 24h", async () => {
		const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
		writeFileSync(
			join(codexDir, "design-review.json"),
			JSON.stringify({
				executionId: execId,
				reviewType: "design",
				status: "APPROVED",
				reviewedTarget: "doc/foo.md",
				timestamp: stale,
			}),
		);

		await expect(
			awaitCodexGate({
				reviewType: "design",
				execId,
				worktreePath: tmpRoot,
				timeoutMs: 5_000,
				pollIntervalMs: 50,
			}),
		).rejects.toThrow("process.exit(1)");

		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("older than 24h"),
		);
	});

	it("polls until result appears, then exits 0 (code review, reviewedHeadSha === HEAD)", async () => {
		// FLY-827: a code review must bind to the reviewed commit == current HEAD.
		const head = gitInitHead(tmpRoot);
		// Spawn a "writer" that drops the result file after ~150ms.
		const writer = setTimeout(() => {
			writeFileSync(
				join(codexDir, "code-review.json"),
				JSON.stringify({
					executionId: execId,
					reviewType: "code",
					status: "APPROVED",
					reviewedTarget: "https://github.com/org/repo/pull/123",
					reviewedHeadSha: head,
					timestamp: new Date().toISOString(),
				}),
			);
		}, 150);

		try {
			await expect(
				awaitCodexGate({
					reviewType: "code",
					execId,
					worktreePath: tmpRoot,
					timeoutMs: 5_000,
					pollIntervalMs: 50,
				}),
			).rejects.toThrow("process.exit(0)");

			expect(logSpy).toHaveBeenCalledWith(
				expect.stringContaining("code review APPROVED"),
			);
		} finally {
			clearTimeout(writer);
		}
	});

	it("FLY-827 HIGH-2: code review with a STALE reviewedHeadSha (!= HEAD) → fatal exit 1 (no false approval on new head)", async () => {
		gitInitHead(tmpRoot);
		writeFileSync(
			join(codexDir, "code-review.json"),
			JSON.stringify({
				executionId: execId,
				reviewType: "code",
				status: "APPROVED",
				reviewedTarget: "https://github.com/org/repo/pull/123",
				reviewedHeadSha: "a".repeat(40), // reviewed an OLD head, HEAD has moved
				timestamp: new Date().toISOString(),
			}),
		);
		await expect(
			awaitCodexGate({
				reviewType: "code",
				execId,
				worktreePath: tmpRoot,
				timeoutMs: 1_000,
				pollIntervalMs: 50,
			}),
		).rejects.toThrow("process.exit(1)");
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("reviewedHeadSha"),
		);
	});

	it("FLY-827 HIGH-2: code review MISSING reviewedHeadSha → fatal exit 1 (fail-closed)", async () => {
		gitInitHead(tmpRoot);
		writeFileSync(
			join(codexDir, "code-review.json"),
			JSON.stringify({
				executionId: execId,
				reviewType: "code",
				status: "APPROVED",
				reviewedTarget: "https://github.com/org/repo/pull/123",
				timestamp: new Date().toISOString(),
			}),
		);
		await expect(
			awaitCodexGate({
				reviewType: "code",
				execId,
				worktreePath: tmpRoot,
				timeoutMs: 1_000,
				pollIntervalMs: 50,
			}),
		).rejects.toThrow("process.exit(1)");
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("reviewedHeadSha"),
		);
	});

	it("exits 1 (fail-closed) on timeout when no result and no skip ever appears", async () => {
		await expect(
			awaitCodexGate({
				reviewType: "design",
				execId,
				worktreePath: tmpRoot,
				timeoutMs: 250,
				pollIntervalMs: 50,
			}),
		).rejects.toThrow("process.exit(1)");

		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("timeout"));
	});

	it("rejects an invalid review type up front", async () => {
		await expect(
			awaitCodexGate({
				reviewType: "bogus",
				execId,
				worktreePath: tmpRoot,
				timeoutMs: 5_000,
				pollIntervalMs: 50,
			}),
		).rejects.toThrow("process.exit(1)");

		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Invalid review type"),
		);
	});

	it("requires execId", async () => {
		await expect(
			awaitCodexGate({
				reviewType: "design",
				execId: "",
				worktreePath: tmpRoot,
				timeoutMs: 5_000,
				pollIntervalMs: 50,
			}),
		).rejects.toThrow("process.exit(1)");

		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("--exec-id is required"),
		);
	});

	void exitSpy; // referenced via spyOn lifetime
});
