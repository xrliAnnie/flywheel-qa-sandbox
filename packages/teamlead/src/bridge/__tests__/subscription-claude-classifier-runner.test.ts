/**
 * FLY-799 Part A-3 — SubscriptionClaudeClassifierRunner (RED first).
 *
 * The fail-closed process seam for the on-demand headless Haiku classifier
 * (Codex R7 #2). Runs `claude -p <prompt> --model <haiku> --output-format json`
 * via execFile (NO shell), parses the Claude Code result envelope, extracts the
 * model's verdict JSON, and returns it. EVERY failure mode — exec error /
 * timeout / CLI missing / is_error envelope / unparseable envelope /
 * unparseable verdict — returns { ok: false } (never throws, never fail-open),
 * so the caller degrades to "unclear" → WAKE-only.
 *
 * Real envelope shape (verified 2026-07-02):
 *   {"type":"result","subtype":"success","is_error":false,
 *    "result":"{\"approved\": true}", ...}
 */

import { describe, expect, it, vi } from "vitest";
import { runSubscriptionClassifier } from "../approval-signal/subscription-claude-classifier-runner.js";

function okEnvelope(resultText: string): { stdout: string; stderr: string } {
	return {
		stdout: JSON.stringify({
			type: "result",
			subtype: "success",
			is_error: false,
			result: resultText,
		}),
		stderr: "",
	};
}

describe("runSubscriptionClassifier — success", () => {
	it("extracts the verdict JSON from a success envelope", async () => {
		const execFileImpl = vi
			.fn()
			.mockResolvedValue(okEnvelope('{"approved": true}'));
		const res = await runSubscriptionClassifier("prompt", { execFileImpl });
		expect(res).toEqual({ ok: true, verdict: { approved: true } });
	});

	it("strips a ```json code fence around the verdict", async () => {
		const fenced = '```json\n{"approved": false}\n```';
		const execFileImpl = vi.fn().mockResolvedValue(okEnvelope(fenced));
		const res = await runSubscriptionClassifier("prompt", { execFileImpl });
		expect(res).toEqual({ ok: true, verdict: { approved: false } });
	});

	it("invokes claude headless with -p, --model, --output-format json, NO shell", async () => {
		const execFileImpl = vi
			.fn()
			.mockResolvedValue(okEnvelope('{"approved": true}'));
		await runSubscriptionClassifier("the-prompt", {
			execFileImpl,
			model: "claude-haiku-4-5-20251001",
		});
		const [, args] = execFileImpl.mock.calls[0] as [string, string[], object];
		expect(args).toContain("-p");
		expect(args).toContain("the-prompt");
		expect(args).toContain("--model");
		expect(args).toContain("claude-haiku-4-5-20251001");
		expect(args).toContain("--output-format");
		expect(args).toContain("json");
	});
});

describe("runSubscriptionClassifier — fail-closed", () => {
	it("exec error (timeout / CLI missing / nonzero) → ok:false", async () => {
		const execFileImpl = vi
			.fn()
			.mockRejectedValue(
				Object.assign(new Error("spawn claude ETIMEDOUT"), { killed: true }),
			);
		const res = await runSubscriptionClassifier("p", { execFileImpl });
		expect(res.ok).toBe(false);
	});

	it("is_error envelope → ok:false", async () => {
		const execFileImpl = vi.fn().mockResolvedValue({
			stdout: JSON.stringify({
				type: "result",
				subtype: "error",
				is_error: true,
				result: "",
			}),
			stderr: "",
		});
		const res = await runSubscriptionClassifier("p", { execFileImpl });
		expect(res.ok).toBe(false);
	});

	it("unparseable envelope stdout → ok:false", async () => {
		const execFileImpl = vi
			.fn()
			.mockResolvedValue({ stdout: "not json at all", stderr: "" });
		const res = await runSubscriptionClassifier("p", { execFileImpl });
		expect(res.ok).toBe(false);
	});

	it("unparseable verdict inside result → ok:false", async () => {
		const execFileImpl = vi
			.fn()
			.mockResolvedValue(okEnvelope("I think you should ship it, yes"));
		const res = await runSubscriptionClassifier("p", { execFileImpl });
		expect(res.ok).toBe(false);
	});

	it("never throws, even if execFileImpl throws synchronously", async () => {
		const execFileImpl = vi.fn(() => {
			throw new Error("boom");
		});
		const res = await runSubscriptionClassifier("p", {
			execFileImpl: execFileImpl as never,
		});
		expect(res.ok).toBe(false);
	});
});

describe("FLY-1099 §7.3: transient-failure retry", () => {
	const okEnvelope2 = (result: string) => ({
		stdout: JSON.stringify({
			type: "result",
			subtype: "success",
			is_error: false,
			result,
		}),
		stderr: "",
	});

	it("one transient exec failure → retried once → succeeds", async () => {
		const execFileImpl = vi
			.fn()
			.mockRejectedValueOnce(new Error("Command failed: claude (timeout)"))
			.mockResolvedValueOnce(okEnvelope2('{"decision":"unclear"}'));
		const res = await runSubscriptionClassifier("p", {
			execFileImpl,
			retryDelayMs: 0,
		});
		expect(execFileImpl).toHaveBeenCalledTimes(2);
		expect(res.ok).toBe(true);
	});

	it("both attempts fail → fail-closed exec_failed (still never throws)", async () => {
		const execFileImpl = vi
			.fn()
			.mockRejectedValue(new Error("Command failed: claude"));
		const res = await runSubscriptionClassifier("p", {
			execFileImpl,
			retryDelayMs: 0,
		});
		expect(execFileImpl).toHaveBeenCalledTimes(2);
		expect(res).toMatchObject({ ok: false });
	});

	it("ENOENT (CLI missing) is PERMANENT — no retry", async () => {
		const err = Object.assign(new Error("spawn claude ENOENT"), {
			code: "ENOENT",
		});
		const execFileImpl = vi.fn().mockRejectedValue(err);
		const res = await runSubscriptionClassifier("p", {
			execFileImpl,
			retryDelayMs: 0,
		});
		expect(execFileImpl).toHaveBeenCalledTimes(1);
		expect(res.ok).toBe(false);
	});
});
