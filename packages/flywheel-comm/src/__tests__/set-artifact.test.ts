/**
 * GEO-151 B8 — set-artifact command tests.
 *
 * Verifies argument validation, identity resolution, and the POST body shape
 * that Bridge's `last_artifact_set` handler will read.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setArtifact } from "../commands/set-artifact.js";

function makeFetchOk(): {
	fetch: typeof fetch;
	calls: Array<{ url: string; body: Record<string, unknown> }>;
} {
	const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
	const fetchFn = vi.fn(
		async (url: string | URL | Request, init?: RequestInit) => {
			const body =
				typeof init?.body === "string"
					? (JSON.parse(init.body) as Record<string, unknown>)
					: {};
			calls.push({ url: String(url), body });
			return new Response("", { status: 200 });
		},
	) as unknown as typeof fetch;
	return { fetch: fetchFn, calls };
}

describe("setArtifact (GEO-151 B8)", () => {
	let tmpDir: string;
	let modelPath: string;

	beforeEach(() => {
		tmpDir = join(tmpdir(), `sa-${Date.now()}-${Math.random()}`);
		mkdirSync(tmpDir, { recursive: true });
		modelPath = join(tmpDir, "model.glb");
		writeFileSync(modelPath, "GLB-CONTENT");
		process.env.FLYWHEEL_BRIDGE_URL = "http://127.0.0.1:8088";
		delete process.env.FLYWHEEL_EXEC_ID;
		delete process.env.FLYWHEEL_ISSUE_ID;
		delete process.env.FLYWHEEL_PROJECT_NAME;
	});

	afterEach(() => {
		delete process.env.FLYWHEEL_BRIDGE_URL;
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {}
	});

	describe("argument validation", () => {
		it("rejects relative model paths", async () => {
			await expect(
				setArtifact({
					modelPath: "./model.glb",
					execId: "e",
					issueId: "i",
					projectName: "p",
					fetchFn: makeFetchOk().fetch,
				}),
			).rejects.toThrow(/absolute/);
		});

		it("rejects missing files", async () => {
			await expect(
				setArtifact({
					modelPath: "/nonexistent/x.glb",
					execId: "e",
					issueId: "i",
					projectName: "p",
					fetchFn: makeFetchOk().fetch,
				}),
			).rejects.toThrow(/not found/);
		});

		it("rejects directories", async () => {
			await expect(
				setArtifact({
					modelPath: tmpDir,
					execId: "e",
					issueId: "i",
					projectName: "p",
					fetchFn: makeFetchOk().fetch,
				}),
			).rejects.toThrow(/regular file/);
		});

		it("rejects unsupported extensions", async () => {
			const badPath = join(tmpDir, "model.txt");
			writeFileSync(badPath, "x");
			await expect(
				setArtifact({
					modelPath: badPath,
					execId: "e",
					issueId: "i",
					projectName: "p",
					fetchFn: makeFetchOk().fetch,
				}),
			).rejects.toThrow(/unsupported model extension/);
		});

		it("accepts .glb / .gltf / .stl / .3mf / .obj", async () => {
			for (const ext of [".glb", ".gltf", ".stl", ".3mf", ".obj"]) {
				const p = join(tmpDir, `model${ext}`);
				writeFileSync(p, "x");
				const result = await setArtifact({
					modelPath: p,
					execId: "e",
					issueId: "i",
					projectName: "p",
					fetchFn: makeFetchOk().fetch,
				});
				expect(result.posted).toBe(true);
			}
		});
	});

	describe("identity resolution", () => {
		it("CLI flags take precedence", async () => {
			process.env.FLYWHEEL_EXEC_ID = "env-exec";
			const { fetch: fetchFn, calls } = makeFetchOk();
			await setArtifact({
				modelPath,
				execId: "cli-exec",
				issueId: "cli-issue",
				projectName: "cli-proj",
				fetchFn,
			});
			expect(calls[0]!.body.execution_id).toBe("cli-exec");
		});

		it("env fills in when CLI omitted", async () => {
			process.env.FLYWHEEL_EXEC_ID = "env-exec";
			process.env.FLYWHEEL_ISSUE_ID = "env-issue";
			process.env.FLYWHEEL_PROJECT_NAME = "env-proj";
			const { fetch: fetchFn, calls } = makeFetchOk();
			await setArtifact({ modelPath, fetchFn });
			expect(calls[0]!.body.execution_id).toBe("env-exec");
			expect(calls[0]!.body.issue_id).toBe("env-issue");
			expect(calls[0]!.body.project_name).toBe("env-proj");
		});

		it("fail-closed when execId missing", async () => {
			await expect(
				setArtifact({
					modelPath,
					issueId: "i",
					projectName: "p",
					fetchFn: makeFetchOk().fetch,
				}),
			).rejects.toThrow(/missing identity/);
		});

		it("fail-closed when bridgeUrl missing", async () => {
			delete process.env.FLYWHEEL_BRIDGE_URL;
			await expect(
				setArtifact({
					modelPath,
					execId: "e",
					issueId: "i",
					projectName: "p",
					fetchFn: makeFetchOk().fetch,
				}),
			).rejects.toThrow(/FLYWHEEL_BRIDGE_URL/);
		});
	});

	describe("wire shape", () => {
		it("POST body: event_type=last_artifact_set + payload.model_path", async () => {
			const { fetch: fetchFn, calls } = makeFetchOk();
			await setArtifact({
				modelPath,
				execId: "e",
				issueId: "i",
				projectName: "p",
				fetchFn,
			});
			expect(calls).toHaveLength(1);
			expect(calls[0]!.url).toBe("http://127.0.0.1:8088/events");
			expect(calls[0]!.body.event_type).toBe("last_artifact_set");
			expect(calls[0]!.body.source).toBe("flywheel-comm");
			const payload = calls[0]!.body.payload as Record<string, unknown>;
			expect(payload.model_path).toBe(modelPath);
		});

		it("POST returns 500 → exit 2", async () => {
			const fetchFn = vi.fn(
				async () => new Response("err", { status: 500 }),
			) as unknown as typeof fetch;
			const result = await setArtifact({
				modelPath,
				execId: "e",
				issueId: "i",
				projectName: "p",
				fetchFn,
			});
			expect(result.exitCode).toBe(2);
			expect(result.posted).toBe(false);
		});

		it("Authorization header included when FLYWHEEL_INGEST_TOKEN set", async () => {
			process.env.FLYWHEEL_INGEST_TOKEN = "secret-token";
			let capturedAuth: string | undefined;
			const fetchFn = vi.fn(
				async (_url: string | URL | Request, init?: RequestInit) => {
					const h = init?.headers as Record<string, string> | undefined;
					capturedAuth = h?.Authorization;
					return new Response("", { status: 200 });
				},
			) as unknown as typeof fetch;
			try {
				await setArtifact({
					modelPath,
					execId: "e",
					issueId: "i",
					projectName: "p",
					fetchFn,
				});
				expect(capturedAuth).toBe("Bearer secret-token");
			} finally {
				delete process.env.FLYWHEEL_INGEST_TOKEN;
			}
		});
	});
});
