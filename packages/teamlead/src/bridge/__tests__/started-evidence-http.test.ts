import type { Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import type { ExecutionBodyLivenessReader } from "../execution-body-reader.js";
import { readStartedEvidenceFromBridge } from "../started-evidence.js";
import { createQueryRouter } from "../tools.js";

let store: StateStore;
let server: Server;
let baseUrl: string;
const readBodyLiveness = vi.fn<ExecutionBodyLivenessReader>();
beforeEach(async () => {
	store = await StateStore.create(":memory:");
	store.upsertSession({
		execution_id: "exec-1",
		issue_id: "issue-1",
		project_name: "test",
		status: "running",
	});
	readBodyLiveness.mockReset().mockReturnValue("unknown");
	const app = express();
	app.use("/api", createQueryRouter(store, [], { readBodyLiveness }));
	server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const addr = server.address();
	baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterEach(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	store.close();
});
describe("FLY-2919 shared started evidence across Bridge/gateway", () => {
	it.each(["alive", "dead", "unknown"] as const)(
		"session query exposes only the common %s verdict",
		async (verdict) => {
			readBodyLiveness.mockReturnValue(verdict);
			const body = await (await fetch(`${baseUrl}/api/sessions/exec-1`)).json();
			expect(body.body_verdict).toBe(verdict);
			expect(readBodyLiveness).toHaveBeenCalledWith("exec-1", "test");
			expect(body).not.toHaveProperty("binding");
			expect(body).not.toHaveProperty("observation");
		},
	);
	it("observer exceptions expose unknown, not status-derived liveness", async () => {
		readBodyLiveness.mockImplementation(() => {
			throw new Error("offline");
		});
		const body = await (await fetch(`${baseUrl}/api/sessions/exec-1`)).json();
		expect(body.body_verdict).toBe("unknown");
	});
	it.each(["alive", "dead", "unknown"] as const)(
		"gateway reads the existing authenticated session query for %s",
		async (verdict) => {
			readBodyLiveness.mockReturnValue(verdict);
			expect(
				await readStartedEvidenceFromBridge("exec-1", "test", {
					bridgeUrl: baseUrl,
					apiToken: "test-token",
				}),
			).toEqual(
				verdict === "alive"
					? { started: true }
					: {
							started: false,
							reason: verdict === "dead" ? "body_dead" : "lookup_error",
						},
			);
		},
	);
	it.each([
		{ execution_id: "other", project_name: "test", body_verdict: "dead" },
		{ execution_id: "exec-1", project_name: "other", body_verdict: "dead" },
		{ execution_id: "exec-1", project_name: "test", body_verdict: "failed" },
		{ execution_id: "exec-1", project_name: "test", status: "running" },
		null,
	])("gateway rejects wrong identity or invalid verdict %j", async (body) => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response(JSON.stringify(body)));
		expect(
			await readStartedEvidenceFromBridge("exec-1", "test", {
				bridgeUrl: baseUrl,
				apiToken: "test-token",
				fetchImpl,
			}),
		).toEqual({ started: false, reason: "lookup_error" });
	});
	it("gateway bounds bytes and refuses HTTP errors, missing session and transport errors", async () => {
		for (const response of [
			new Response("x".repeat(65_537)),
			new Response("{}", { status: 503 }),
		]) {
			expect(
				await readStartedEvidenceFromBridge("exec-1", "test", {
					bridgeUrl: baseUrl,
					apiToken: "test-token",
					fetchImpl: vi.fn().mockResolvedValue(response),
				}),
			).toEqual({ started: false, reason: "lookup_error" });
		}
		expect(
			await readStartedEvidenceFromBridge("missing", "test", {
				bridgeUrl: baseUrl,
				apiToken: "test-token",
			}),
		).toEqual({ started: false, reason: "lookup_error" });
		expect(
			await readStartedEvidenceFromBridge("exec-1", "test", {
				bridgeUrl: baseUrl,
				apiToken: "test-token",
				fetchImpl: vi.fn().mockRejectedValue(new Error("offline")),
			}),
		).toEqual({ started: false, reason: "lookup_error" });
	});
	it("gateway aborts an unresponsive Bridge at five seconds", async () => {
		vi.useFakeTimers();
		try {
			const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
				(_url, init) =>
					new Promise((_resolve, reject) => {
						init?.signal?.addEventListener(
							"abort",
							() => reject(new Error("aborted")),
							{ once: true },
						);
					}),
			);
			const pending = readStartedEvidenceFromBridge("exec-1", "test", {
				bridgeUrl: baseUrl,
				apiToken: "test-token",
				fetchImpl,
			});
			await vi.advanceTimersByTimeAsync(5_000);
			expect(await pending).toEqual({ started: false, reason: "lookup_error" });
			expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("gateway sends the token only to the configured Bridge with bounded deadline and no redirects", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					execution_id: "exec-1",
					project_name: "test",
					body_verdict: "alive",
				}),
			),
		);
		await readStartedEvidenceFromBridge("exec-1", "test", {
			bridgeUrl: baseUrl,
			apiToken: "test-token",
			fetchImpl,
		});
		expect(fetchImpl).toHaveBeenCalledWith(
			`${baseUrl}/api/sessions/exec-1`,
			expect.objectContaining({
				headers: { Authorization: "Bearer test-token" },
				redirect: "error",
				signal: expect.any(AbortSignal),
			}),
		);
	});
});
