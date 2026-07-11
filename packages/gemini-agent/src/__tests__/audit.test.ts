import { describe, expect, it } from "vitest";
import { type AuditFsLike, digest, JsonlAuditLog } from "../audit.js";
import type { SessionStats } from "../types.js";

/** In-memory fs recording every write in order — the ordering oracle. */
function fakeFs() {
	const writes: Array<{ op: string; path: string; data: string }> = [];
	const files = new Map<string, string>();
	const fs: AuditFsLike = {
		mkdirSync: (p: string) => {
			writes.push({ op: "mkdir", path: p, data: "" });
		},
		appendFileSync: (p: string, data: string) => {
			writes.push({ op: "append", path: p, data });
			files.set(p, (files.get(p) ?? "") + data);
		},
		writeFileSync: (p: string, data: string) => {
			writes.push({ op: "write", path: p, data });
			files.set(p, data);
		},
		readFileSync: (p: string) => {
			const v = files.get(p);
			if (v === undefined) throw new Error("ENOENT");
			return v;
		},
	};
	return { fs, writes, files };
}

const STATS: SessionStats = {
	sessionId: "sid-1234",
	steps: 2,
	toolCalls: 3,
	toolErrors: 1,
	hallucinatedToolCalls: 0,
	inputTokens: 100,
	outputTokens: 50,
	durationMs: 1234,
	model: "gemini-3.5-flash",
	surface: "interactions",
};

function makeLog(fake = fakeFs()) {
	const log = new JsonlAuditLog({
		dir: "/audit",
		sessionId: "sid-1234",
		fsLike: fake.fs,
		now: () => "2026-07-08T00:00:00.000Z",
	});
	return { log, ...fake };
}

describe("digest (脱敏纪律 — first 200 chars only, never tokens)", () => {
	it("passes short text through", () => {
		expect(digest("hello")).toBe("hello");
	});
	it("caps at 200 chars", () => {
		expect(digest("x".repeat(500))).toHaveLength(200);
	});
});

describe("JsonlAuditLog", () => {
	it("writes session_start BEFORE any model_call (audit-before-call, principle 6)", () => {
		const { log, writes } = makeLog();
		log.sessionStart({
			entry: "cli",
			model: "gemini-3.5-flash",
			surface: "interactions",
			projectName: "flywheel",
			userTextDigest: digest("do the thing"),
		});
		log.modelCall(1, "next_turn");
		const appends = writes.filter((w) => w.op === "append");
		expect(appends.length).toBeGreaterThanOrEqual(2);
		expect(JSON.parse(appends[0]?.data ?? "").type).toBe("session_start");
		expect(JSON.parse(appends[1]?.data ?? "").type).toBe("model_call");
	});

	it("every event line carries ts + sessionId + type", () => {
		const { log, files } = makeLog();
		log.sessionStart({
			entry: "discord",
			model: "m",
			surface: "interactions",
			projectName: "p",
			userTextDigest: "u",
		});
		log.modelCall(1, "next_turn");
		log.modelResponse(1, 2, 10, { inputTokens: 5, outputTokens: 3 });
		log.toolDispatch(1, "create_issue", "digest", "dispatch");
		log.toolResult(1, "create_issue", true, 200, 42, 100, false);
		log.retry("model", 1, 3, 2000, "unavailable");
		log.terminal("completed", STATS);
		const lines = (files.get("/audit/session-sid-1234.jsonl") ?? "")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(lines).toHaveLength(7);
		for (const line of lines) {
			expect(line.ts).toBe("2026-07-08T00:00:00.000Z");
			expect(line.sessionId).toBe("sid-1234");
			expect(typeof line.type).toBe("string");
		}
		expect(lines.map((l) => l.type)).toEqual([
			"session_start",
			"model_call",
			"model_response",
			"tool_dispatch",
			"tool_result",
			"retry",
			"terminal",
		]);
	});

	it("tool_dispatch records the gate decision", () => {
		const { log, files } = makeLog();
		log.toolDispatch(1, "bogus_tool", "d", "hallucinated");
		const line = JSON.parse(
			(files.get("/audit/session-sid-1234.jsonl") ?? "").trim(),
		);
		expect(line.decision).toBe("hallucinated");
		expect(line.tool).toBe("bogus_tool");
	});

	it("terminal appends a summary row to sessions.jsonl too", () => {
		const { log, files } = makeLog();
		log.terminal("max_steps_exceeded", STATS);
		const summary = JSON.parse(
			(files.get("/audit/sessions.jsonl") ?? "").trim(),
		);
		expect(summary.type).toBe("terminal");
		expect(summary.reason).toBe("max_steps_exceeded");
		expect(summary.stats.steps).toBe(2);
	});

	it("persists + restores lastInteractionId via the state file (resume)", () => {
		const fake = fakeFs();
		const { log } = makeLog(fake);
		log.saveInteractionId("interaction-abc");
		expect(JsonlAuditLog.loadInteractionId("/audit", "sid-1234", fake.fs)).toBe(
			"interaction-abc",
		);
	});

	it("loadInteractionId returns null when no state file exists", () => {
		const fake = fakeFs();
		expect(JsonlAuditLog.loadInteractionId("/audit", "nope", fake.fs)).toBe(
			null,
		);
	});

	it("warning lines are recorded (identity.md degradation path)", () => {
		const { log, files } = makeLog();
		log.warning(
			"identity file missing: /x/identity.md — persona segment skipped",
		);
		const line = JSON.parse(
			(files.get("/audit/session-sid-1234.jsonl") ?? "").trim(),
		);
		expect(line.type).toBe("warning");
		expect(line.message).toContain("identity file missing");
	});
});
