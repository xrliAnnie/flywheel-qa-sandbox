import { describe, expect, it } from "vitest";
import {
	dayFromTimestamp,
	parseUsageLine,
	recordsFromLines,
} from "../scanner.js";

const HOME = "/Users/tester";

function line(o: Record<string, unknown>): string {
	return JSON.stringify(o);
}

function assistant(opts: {
	requestId?: string;
	uuid?: string;
	cwd: string;
	model?: string;
	ts: string;
	usage?: Record<string, unknown>;
	type?: string;
	isSidechain?: boolean;
	gitBranch?: string;
}): string {
	return line({
		type: opts.type ?? "assistant",
		requestId: opts.requestId,
		uuid: opts.uuid,
		cwd: opts.cwd,
		gitBranch: opts.gitBranch,
		timestamp: opts.ts,
		isSidechain: opts.isSidechain,
		message: {
			model: opts.model ?? "claude-opus-4-8",
			role: "assistant",
			usage: opts.usage ?? {
				input_tokens: 10,
				output_tokens: 20,
				cache_read_input_tokens: 1000,
				cache_creation_input_tokens: 30,
			},
		},
	});
}

describe("dayFromTimestamp", () => {
	it("shifts a UTC instant to the local (LA) civil date across midnight", () => {
		// 02:57 UTC = 19:57 previous day PDT (UTC-7)
		expect(
			dayFromTimestamp("2026-06-29T02:57:41.908Z", "America/Los_Angeles"),
		).toBe("2026-06-28");
		expect(
			dayFromTimestamp("2026-06-29T08:00:00.000Z", "America/Los_Angeles"),
		).toBe("2026-06-29");
	});

	it("uses UTC when asked", () => {
		expect(dayFromTimestamp("2026-06-29T02:57:41.908Z", "UTC")).toBe(
			"2026-06-29",
		);
	});
});

describe("parseUsageLine", () => {
	it("extracts tokens, model, classification from an assistant line", () => {
		const rec = parseUsageLine(
			assistant({
				requestId: "r1",
				cwd: "/Users/tester/Dev/flywheel-FLY-614",
				ts: "2026-06-29T20:00:00Z",
			}),
			{ timeZone: "UTC", homeDir: HOME },
		);
		expect(rec).toMatchObject({
			requestId: "r1",
			model: "claude-opus-4-8",
			project: "flywheel",
			issue: "FLY-614",
			kind: "runner",
			inputTokens: 10,
			outputTokens: 20,
			cacheReadTokens: 1000,
			cacheWriteTokens: 30,
			day: "2026-06-29",
		});
	});

	it("attributes a subagent sidechain line to its parent cwd", () => {
		const rec = parseUsageLine(
			assistant({
				requestId: "sub1",
				cwd: "/Users/tester/Dev/flywheel-FLY-362",
				ts: "2026-06-29T20:00:00Z",
				isSidechain: true,
				model: "claude-haiku-4-5-20251001",
			}),
			{ timeZone: "UTC", homeDir: HOME },
		);
		expect(rec?.project).toBe("flywheel");
		expect(rec?.issue).toBe("FLY-362");
	});

	it("ignores non-assistant lines and lines without usage", () => {
		expect(
			parseUsageLine(line({ type: "user", cwd: "/x", message: {} })),
		).toBeNull();
		expect(
			parseUsageLine(
				line({
					type: "assistant",
					cwd: "/x",
					message: { model: "m" },
					timestamp: "2026-06-29T00:00:00Z",
					requestId: "z",
				}),
			),
		).toBeNull();
		expect(parseUsageLine("not json")).toBeNull();
		expect(parseUsageLine("")).toBeNull();
	});

	it("falls back to uuid when requestId is absent", () => {
		const rec = parseUsageLine(
			assistant({
				uuid: "u1",
				cwd: "/Users/tester/Dev/flywheel",
				ts: "2026-06-29T20:00:00Z",
			}),
			{ timeZone: "UTC", homeDir: HOME },
		);
		expect(rec?.requestId).toBe("u1");
	});

	it("respects since/until day filters", () => {
		const l = assistant({
			requestId: "r",
			cwd: "/Users/tester/Dev/flywheel",
			ts: "2026-06-20T20:00:00Z",
		});
		expect(
			parseUsageLine(l, { timeZone: "UTC", since: "2026-06-21" }),
		).toBeNull();
		expect(
			parseUsageLine(l, { timeZone: "UTC", until: "2026-06-19" }),
		).toBeNull();
		expect(
			parseUsageLine(l, {
				timeZone: "UTC",
				since: "2026-06-01",
				until: "2026-06-30",
			}),
		).not.toBeNull();
	});
});

describe("recordsFromLines", () => {
	it("dedups by requestId across lines (multiple iterations of one turn)", () => {
		const lines = [
			assistant({
				requestId: "dup",
				cwd: "/Users/tester/Dev/flywheel-FLY-1",
				ts: "2026-06-29T20:00:00Z",
			}),
			assistant({
				requestId: "dup",
				cwd: "/Users/tester/Dev/flywheel-FLY-1",
				ts: "2026-06-29T20:01:00Z",
			}),
			assistant({
				requestId: "other",
				cwd: "/Users/tester/Dev/flywheel-FLY-1",
				ts: "2026-06-29T20:02:00Z",
			}),
		];
		const recs = recordsFromLines(lines, { timeZone: "UTC", homeDir: HOME });
		expect(recs).toHaveLength(2);
		expect(recs.map((r) => r.requestId).sort()).toEqual(["dup", "other"]);
	});
});
