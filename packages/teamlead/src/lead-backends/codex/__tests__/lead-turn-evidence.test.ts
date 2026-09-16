import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readLeadTurnEvidence } from "../lead-turn-evidence.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const home = mkdtempSync(join(tmpdir(), "turn-evidence-"));
	roots.push(home);
	mkdirSync(join(home, "sessions"));
	const path = join(home, "sessions", "rollout.jsonl");
	const meta = JSON.stringify({
		type: "session_meta",
		payload: { id: "thread" },
	});
	const context = (turn: string, effort: unknown = "high") =>
		JSON.stringify({
			timestamp: "2026-09-16T04:00:00Z",
			type: "turn_context",
			payload: { turn_id: turn, model: "gpt-6-astra", effort },
		});
	const write = (content: string) => writeFileSync(path, content);
	const read = () =>
		readLeadTurnEvidence({
			codexHome: home,
			path,
			threadId: "thread",
			turnId: "turn",
		});
	return { home, path, meta, context, write, read };
}
it("uses exact thread and turn context rather than current thread settings", () => {
	const f = fixture();
	f.write([f.meta, f.context("old", "low"), f.context("turn"), ""].join("\n"));
	expect(f.read()).toMatchObject({
		threadId: "thread",
		turnId: "turn",
		model: "gpt-6-astra",
		effort: "high",
		source: "rollout_turn_context",
	});
});
it("refuses another thread, a missing turn, missing effort and an incomplete trailing line", () => {
	const f = fixture();
	for (const text of [
		[f.meta.replace("thread", "other"), f.context("turn"), ""].join("\n"),
		[f.meta, f.context("old"), ""].join("\n"),
		[f.meta, f.context("turn", null), ""].join("\n"),
		[f.meta, f.context("turn")].join("\n"),
	]) {
		f.write(text);
		expect(f.read()).toBeUndefined();
	}
});
it("rejects conflicting contexts for the same turn and paths outside the session root", () => {
	const f = fixture();
	f.write([f.meta, f.context("turn"), f.context("turn", "low"), ""].join("\n"));
	expect(f.read()).toBeUndefined();
	const outside = join(f.home, "outside.jsonl");
	writeFileSync(outside, [f.meta, f.context("turn"), ""].join("\n"));
	expect(() =>
		readLeadTurnEvidence({
			codexHome: f.home,
			path: outside,
			threadId: "thread",
			turnId: "turn",
		}),
	).toThrow("rollout_path_invalid");
	const link = join(f.home, "sessions", "link.jsonl");
	symlinkSync(outside, link);
	expect(() =>
		readLeadTurnEvidence({
			codexHome: f.home,
			path: link,
			threadId: "thread",
			turnId: "turn",
		}),
	).toThrow("rollout_path_invalid");
});
it("reads a bounded tail and declines evidence that has fallen outside the bound", () => {
	const f = fixture();
	const large = JSON.stringify({
		type: "event_msg",
		payload: { text: "x".repeat(1100000) },
	});
	f.write([f.meta, large, f.context("turn"), ""].join("\n"));
	expect(f.read()?.effort).toBe("high");
	f.write([f.meta, f.context("turn"), large, ""].join("\n"));
	expect(f.read()).toBeUndefined();
});
