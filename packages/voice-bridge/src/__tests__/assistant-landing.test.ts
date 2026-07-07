/**
 * FLY-967 P6a — AssistantLanding: recap → summary(verbatim quotes) →
 * comment → close, with 545-style landing failure semantics (order is law:
 * any earlier failure leaves the issue OPEN and re-runnable) and re-run
 * idempotency via a local receipt (comment success is recorded; a re-run
 * skips the comment and goes straight to close — Codex R1 #5).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantLanding } from "../assistant/AssistantLanding.js";

describe("AssistantLanding (FLY-967 P6a)", () => {
	let dir: string;
	let comment: ReturnType<typeof vi.fn>;
	let closeIssue: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly967-landing-"));
		comment = vi.fn(async () => ({ url: "https://linear.app/c/1" }));
		closeIssue = vi.fn(async () => {});
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function makeLanding() {
		return new AssistantLanding({
			linear: { comment, closeIssue },
			receiptPath: join(dir, "landing-receipt.json"),
			transcriptPath: join(dir, "session.jsonl"),
		});
	}

	const input = {
		issueId: "FLY-1234",
		sessionId: "sess-abc",
		recapText: "今天聊清了两件事:声线用 Kore;简报预算 8k。",
		quotes: [
			{ ts: "2026-07-07T15:03:00.000Z", text: "声线就用那个稳一点的" },
			{ ts: "2026-07-07T15:09:00.000Z", text: "简报别太长" },
		],
		confirmed: true,
	};

	it("summary carries the marker, recap, and per-point verbatim quotes", () => {
		const s = AssistantLanding.buildSummary(input);
		expect(s).toContain("assistant-summary sess-abc");
		expect(s).toContain("今天聊清了两件事");
		expect(s).toContain("声线就用那个稳一点的");
		expect(s).toContain("2026-07-07T15:03:00.000Z");
		expect(s).not.toContain("未经口头确认");
	});

	it("an unconfirmed (she left) summary is loudly labeled", () => {
		const s = AssistantLanding.buildSummary({ ...input, confirmed: false });
		expect(s).toContain("未经口头确认");
	});

	it("happy path: comment → receipt → close, in that order", async () => {
		const landing = makeLanding();
		const r = await landing.run(input);
		expect(r).toMatchObject({ ok: true, commentUrl: "https://linear.app/c/1" });
		expect(comment).toHaveBeenCalledWith(
			"FLY-1234",
			expect.stringContaining("assistant-summary sess-abc"),
		);
		expect(closeIssue).toHaveBeenCalledWith("FLY-1234");
		const receipt = JSON.parse(
			readFileSync(join(dir, "landing-receipt.json"), "utf8"),
		);
		expect(receipt).toMatchObject({
			issueId: "FLY-1234",
			sessionId: "sess-abc",
		});
	});

	it("comment failure: no close, no receipt, transcript fallback named", async () => {
		comment.mockRejectedValue(new Error("bridge 502"));
		const landing = makeLanding();
		const r = await landing.run(input);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.stage).toBe("comment");
			expect(r.message).toContain("session.jsonl");
		}
		expect(closeIssue).not.toHaveBeenCalled();
		expect(existsSync(join(dir, "landing-receipt.json"))).toBe(false);
	});

	it("close failure after a good comment: receipt kept, manual close flagged", async () => {
		closeIssue.mockRejectedValue(new Error("state flip failed"));
		const landing = makeLanding();
		const r = await landing.run(input);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.stage).toBe("close");
		expect(existsSync(join(dir, "landing-receipt.json"))).toBe(true);
	});

	it("re-run after a close failure skips the comment (receipt) and only closes", async () => {
		closeIssue.mockRejectedValueOnce(new Error("flaky"));
		const landing = makeLanding();
		await landing.run(input); // comment ok, close failed, receipt written
		closeIssue.mockResolvedValue(undefined);
		const r2 = await landing.run(input);
		expect(r2.ok).toBe(true);
		expect(comment).toHaveBeenCalledTimes(1); // NOT re-sent
		expect(closeIssue).toHaveBeenCalledTimes(2);
	});

	it("a receipt for a DIFFERENT session does not suppress the comment", async () => {
		const landing = makeLanding();
		await landing.run(input);
		comment.mockClear();
		closeIssue.mockClear();
		const r = await landing.run({ ...input, sessionId: "sess-new" });
		expect(r.ok).toBe(true);
		expect(comment).toHaveBeenCalledTimes(1); // fresh session → fresh comment
	});
});
