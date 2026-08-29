/**
 * FLY-598: founder-facing UX gate CLI command tests.
 *
 * Focus: the credential-separation + fail-closed security behaviors (Codex
 * R2-#1 / R3-#1) and the canonical ux-hash contract (Codex R2-#2). The
 * security-critical paths (record requires TEAMLEAD_API_TOKEN; missing args)
 * fail closed BEFORE any network call, so they need no fetch mock.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	awaitFounderUxGate,
	computeUxHash,
	declareFounderUx,
	recordFounderUxSignoff,
} from "../commands/founder-ux.js";

describe("FLY-598 founder-ux CLI", () => {
	let tmpRoot: string;
	const savedEnv = { ...process.env };

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "founder-ux-"));
		// Mock process.exit to throw so fail-closed exits are observable as throws.
		vi.spyOn(process, "exit").mockImplementation((code?: number) => {
			throw new Error(`process.exit(${code})`);
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		// clean slate for the env vars these commands read
		for (const k of [
			"FLYWHEEL_EXEC_ID",
			"FLYWHEEL_ISSUE_ID",
			"FLYWHEEL_PROJECT_NAME",
			"FLYWHEEL_BRIDGE_URL",
			"FLYWHEEL_INGEST_TOKEN",
			"TEAMLEAD_API_TOKEN",
		]) {
			delete process.env[k];
		}
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
		process.env = { ...savedEnv };
		vi.restoreAllMocks();
	});

	const writeBrief = (content: string): string => {
		const p = join(tmpRoot, "ux-brief.md");
		writeFileSync(p, content);
		return p;
	};

	describe("computeUxHash", () => {
		it("is deterministic for identical content", () => {
			const a = writeBrief("# UX\nshow a toast, not an alert\n");
			const h1 = computeUxHash(a);
			const h2 = computeUxHash(a);
			expect(h1).toBe(h2);
			expect(h1).toMatch(/^[0-9a-f]{64}$/);
		});

		it("ignores CRLF vs LF and a leading BOM (trivial churn does not re-sign)", () => {
			const lf = writeBrief("line1\nline2\n");
			const hLf = computeUxHash(lf);
			const crlf = join(tmpRoot, "crlf.md");
			writeFileSync(crlf, "﻿line1\r\nline2\r\n");
			expect(computeUxHash(crlf)).toBe(hLf);
		});

		it("changes when UX content changes (material change re-signs)", () => {
			const v1 = writeBrief("show a toast\n");
			const h1 = computeUxHash(v1);
			writeFileSync(v1, "show a modal dialog\n");
			expect(computeUxHash(v1)).not.toBe(h1);
		});

		it("exits when the ux-file is missing", () => {
			expect(() => computeUxHash(join(tmpRoot, "nope.md"))).toThrow(
				/process\.exit\(1\)/,
			);
		});
	});

	describe("record-founder-ux-signoff (privileged write, fail-closed)", () => {
		it("FAILS CLOSED when TEAMLEAD_API_TOKEN is unset (never falls back to ingest token)", async () => {
			process.env.FLYWHEEL_BRIDGE_URL = "http://localhost:9999";
			process.env.FLYWHEEL_INGEST_TOKEN = "ingest-secret"; // present, must NOT be used
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(new Response("{}", { status: 200 }));
			const brief = writeBrief("ux\n");

			await expect(
				recordFounderUxSignoff({
					execId: "exec-1",
					uxFile: brief,
					annieMsgId: "msg-1",
				}),
			).rejects.toThrow(/process\.exit\(1\)/);
			// Critical: it must refuse BEFORE issuing any network write.
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it("requires --annie-msg-id", async () => {
			process.env.FLYWHEEL_BRIDGE_URL = "http://localhost:9999";
			process.env.TEAMLEAD_API_TOKEN = "lead-secret";
			const brief = writeBrief("ux\n");
			await expect(
				recordFounderUxSignoff({ execId: "e", uxFile: brief, annieMsgId: "" }),
			).rejects.toThrow(/process\.exit\(1\)/);
		});

		it("sends the privileged write with the API token (not the ingest token) when configured", async () => {
			process.env.FLYWHEEL_BRIDGE_URL = "http://localhost:9999";
			process.env.FLYWHEEL_INGEST_TOKEN = "ingest-secret";
			process.env.TEAMLEAD_API_TOKEN = "lead-secret";
			const brief = writeBrief("ux\n");
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(new Response("ok", { status: 200 }));

			await recordFounderUxSignoff({
				execId: "exec-9",
				uxFile: brief,
				annieMsgId: "msg-9",
			});
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
			expect(url).toContain("/api/founder-ux/signoff");
			const auth = (init.headers as Record<string, string>).Authorization;
			expect(auth).toBe("Bearer lead-secret");
			expect(auth).not.toContain("ingest-secret");
		});
	});

	describe("declare-founder-ux (runner backup trigger)", () => {
		it("requires a reason", async () => {
			process.env.FLYWHEEL_EXEC_ID = "e";
			process.env.FLYWHEEL_BRIDGE_URL = "http://localhost:9999";
			await expect(
				declareFounderUx({ execId: "e", reason: "  " }),
			).rejects.toThrow(/process\.exit\(1\)/);
		});

		it("uses the ingest token on the /events POST", async () => {
			process.env.FLYWHEEL_BRIDGE_URL = "http://localhost:9999";
			process.env.FLYWHEEL_INGEST_TOKEN = "ingest-secret";
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(new Response("ok", { status: 200 }));
			await declareFounderUx({ execId: "e", reason: "notification UX" });
			const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
			expect(url).toContain("/events");
			expect((init.headers as Record<string, string>).Authorization).toBe(
				"Bearer ingest-secret",
			);
		});
	});

	describe("await-founder-ux-gate (runner hard stop)", () => {
		it("requires --ux-file", async () => {
			process.env.FLYWHEEL_EXEC_ID = "e";
			process.env.FLYWHEEL_BRIDGE_URL = "http://localhost:9999";
			await expect(
				awaitFounderUxGate({ execId: "e", uxFile: "" }),
			).rejects.toThrow(/process\.exit\(1\)/);
		});

		it("fail-closes (exit 1) on timeout with no verified sign-off, sending uxHash in the query", async () => {
			process.env.FLYWHEEL_BRIDGE_URL = "http://localhost:9999";
			process.env.FLYWHEEL_INGEST_TOKEN = "ingest-secret";
			const brief = writeBrief("ux\n");
			const expectedHash = computeUxHash(brief);
			const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(JSON.stringify({ approved: false }), {
					status: 200,
				}),
			);

			await expect(
				awaitFounderUxGate({
					execId: "exec-t",
					uxFile: brief,
					timeoutMs: 30,
					pollIntervalMs: 5,
				}),
			).rejects.toThrow(/process\.exit\(1\)/);
			const [url] = fetchSpy.mock.calls[0] as [string];
			expect(url).toContain(`uxHash=${expectedHash}`);
			expect(url).toContain("execId=exec-t");
		});

		it("exits 0 when the Bridge reports approved for the current uxHash", async () => {
			process.env.FLYWHEEL_BRIDGE_URL = "http://localhost:9999";
			process.env.FLYWHEEL_INGEST_TOKEN = "ingest-secret";
			const brief = writeBrief("ux\n");
			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(JSON.stringify({ approved: true }), { status: 200 }),
			);
			await expect(
				awaitFounderUxGate({
					execId: "exec-ok",
					uxFile: brief,
					timeoutMs: 1000,
					pollIntervalMs: 5,
				}),
			).rejects.toThrow(/process\.exit\(0\)/);
		});
	});
});
