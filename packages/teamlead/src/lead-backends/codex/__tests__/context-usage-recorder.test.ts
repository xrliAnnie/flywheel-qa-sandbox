import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	parseContextUsage,
	recordContextUsage,
} from "../context-usage-recorder.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function notification(over: Record<string, unknown> = {}) {
	return {
		threadId: "raya-thread",
		turnId: "turn-1",
		tokenUsage: {
			total: { totalTokens: 42 },
			modelContextWindow: 1_000_000,
		},
		...over,
	};
}

describe("FLY-2131 Raya context usage recorder", () => {
	it("matches the existing Raya v1 context-usage row contract", () => {
		expect(
			parseContextUsage("2026-08-29T01:00:00.000Z", notification()),
		).toEqual({
			v: 1,
			ts: "2026-08-29T01:00:00.000Z",
			threadId: "raya-thread",
			turnId: "turn-1",
			totalTokens: 42,
			modelContextWindow: 1_000_000,
		});
	});

	it("appends only the active Raya thread", () => {
		const root = mkdtempSync(join(tmpdir(), "fly2131-context-"));
		roots.push(root);
		const usagePath = join(root, "context-usage.jsonl");
		const unavailablePath = join(root, "context-usage-unavailable.jsonl");
		expect(
			recordContextUsage({
				activeThreadId: "raya-thread",
				notification: notification(),
				usagePath,
				unavailablePath,
				now: () => "2026-08-29T01:00:00.000Z",
			}),
		).toBe("recorded");
		expect(
			recordContextUsage({
				activeThreadId: "raya-thread",
				notification: notification({ threadId: "other-thread" }),
				usagePath,
				unavailablePath,
			}),
		).toBe("ignored");
		expect(readFileSync(usagePath, "utf8").trim().split("\n")).toHaveLength(1);
	});

	it("writes explicit unavailable evidence when parsing fails", () => {
		const root = mkdtempSync(join(tmpdir(), "fly2131-context-"));
		roots.push(root);
		const unavailablePath = join(root, "context-usage-unavailable.jsonl");
		expect(
			recordContextUsage({
				activeThreadId: "raya-thread",
				notification: notification({ tokenUsage: { total: {} } }),
				usagePath: join(root, "context-usage.jsonl"),
				unavailablePath,
				now: () => "2026-08-29T01:00:00.000Z",
			}),
		).toBe("unavailable");
		expect(JSON.parse(readFileSync(unavailablePath, "utf8"))).toMatchObject({
			v: 1,
			activeThreadId: "raya-thread",
			reason: "parse_failed",
		});
	});

	it("records append failure through the separate unavailable ledger", () => {
		const unavailable: string[] = [];
		expect(
			recordContextUsage({
				activeThreadId: "raya-thread",
				notification: notification(),
				usagePath: "/metrics/context-usage.jsonl",
				unavailablePath: "/state/context-usage-unavailable.jsonl",
				appendLine: (path, line) => {
					if (path.includes("context-usage.jsonl"))
						throw new Error("disk full");
					unavailable.push(line);
				},
			}),
		).toBe("unavailable");
		expect(JSON.parse(unavailable[0]!)).toMatchObject({
			reason: "append_failed",
			detail: "disk full",
		});
	});
});
