/**
 * FLY-1048 Task A1: error-signature table + normalization (pure functions).
 *
 * Fixtures under fixtures/error-panes/ are SYNTHETIC reconstructions of the
 * incident panes (FLY-910 auth / FLY-910 ENOENT loop / FLY-546+975
 * error-then-idle) shaped after the committed real lead-pane fixtures —
 * follow-up: replace with real captures when the incidents recur (FLY-218
 * precedent, plan Task A8).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	normalizeErrorLine,
	scanErrorSignatures,
} from "../error-signatures.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const loadErrorPane = (name: string): string =>
	readFileSync(join(HERE, "fixtures", "error-panes", name), "utf-8");
const loadLeadPane = (name: string): string =>
	readFileSync(
		join(HERE, "..", "..", "__tests__", "fixtures", "lead-panes", name),
		"utf-8",
	);

describe("scanErrorSignatures — FN kinds (must-detect)", () => {
	it("FN0: 'Not logged in' pane hits not_logged_in", () => {
		const hits = scanErrorSignatures(loadErrorPane("fn0-not-logged-in.txt"));
		expect(hits.some((h) => h.kind === "not_logged_in")).toBe(true);
	});

	it("FN1: ENOENT loop pane hits enoent_loop", () => {
		const hits = scanErrorSignatures(
			loadErrorPane("fn1-enoent-loop-frame1.txt"),
		);
		expect(hits.some((h) => h.kind === "enoent_loop")).toBe(true);
	});

	it("FN1: same normalized signature across frames whose text differs", () => {
		// The two frames differ (attempt counters, surrounding chatter) but the
		// ENOENT line is the SAME failure — the normalized signature must match
		// so the cross-frame repeat detector (A2/A3) can key on it.
		const f1 = scanErrorSignatures(
			loadErrorPane("fn1-enoent-loop-frame1.txt"),
		).filter((h) => h.kind === "enoent_loop");
		const f2 = scanErrorSignatures(
			loadErrorPane("fn1-enoent-loop-frame2.txt"),
		).filter((h) => h.kind === "enoent_loop");
		expect(f1.length).toBeGreaterThan(0);
		expect(f2.length).toBeGreaterThan(0);
		expect(f1[0]!.signature).toBe(f2[0]!.signature);
	});

	it("FN2: 'Server error mid-response' pane hits server_error_mid_response", () => {
		const hits = scanErrorSignatures(
			loadErrorPane("fn2-server-error-then-idle.txt"),
		);
		expect(hits.some((h) => h.kind === "server_error_mid_response")).toBe(true);
	});

	it("existing stream-idle-timeout string joins the table (same strictness)", () => {
		const hits = scanErrorSignatures(
			"  ⎿  API Error: Stream idle timeout - partial response received\n",
		);
		expect(hits.some((h) => h.kind === "stream_idle_timeout")).toBe(true);
		// A bare "Stream idle timeout" WITHOUT "API Error:" on the same line must
		// NOT match (stuck-candidate detectStreamErrorSignature strictness).
		expect(
			scanErrorSignatures("we should tune the stream idle timeout setting"),
		).toEqual([]);
	});
});

describe("scanErrorSignatures — FP guards (must-not-match)", () => {
	it("healthy working pane produces zero hits", () => {
		expect(
			scanErrorSignatures(loadErrorPane("fp-healthy-working.txt")),
		).toEqual([]);
	});

	it("real idle lead panes produce zero hits", () => {
		for (const fixture of [
			"idle-cos-lead.txt",
			"idle-ops-lead.txt",
			"idle-product-lead.txt",
			"idle-product-lead-ctx100.txt",
		]) {
			expect(scanErrorSignatures(loadLeadPane(fixture))).toEqual([]);
		}
	});

	it("word boundaries: prose containing the phrases as prefixes does not match", () => {
		// "in" as a prefix of "inside" must not satisfy "not logged in".
		expect(
			scanErrorSignatures("the change was not logged inside the journal"),
		).toEqual([]);
		// "server error" without "mid-response" is not FN2.
		expect(
			scanErrorSignatures("a transient server error was retried and passed"),
		).toEqual([]);
	});

	it("skips ▏-quoted lines (A5 echo/quote immunity)", () => {
		// A suspicious report quotes the pane tail with a ▏ prefix; those lines
		// must never re-trigger the scanner when the Lead pane is re-captured.
		const quoted = [
			"▏  ⎿  Error: ENOENT: no such file or directory, open '/tmp/x.ts'",
			"  ▏  Not logged in. Please run /login to authenticate.",
		].join("\n");
		expect(scanErrorSignatures(quoted)).toEqual([]);
	});
});

describe("scanErrorSignatures — hit shape", () => {
	it("carries the raw line and its normalized signature", () => {
		const line =
			"  ⎿  Error: ENOENT: no such file or directory, open '/Users/a/b/f.ts'";
		const hits = scanErrorSignatures(line);
		expect(hits).toHaveLength(1);
		expect(hits[0]!.line).toBe(line);
		expect(hits[0]!.signature).toBe(normalizeErrorLine(line));
	});

	it("one hit per line — the most specific kind wins", () => {
		// "API Error: Server error mid-response" carries both the API-error shape
		// and the FN2 phrase; it must classify once, as server_error_mid_response.
		const hits = scanErrorSignatures(
			"  ⎿  API Error: Server error mid-response. Please try again.",
		);
		expect(hits).toHaveLength(1);
		expect(hits[0]!.kind).toBe("server_error_mid_response");
	});
});

describe("normalizeErrorLine", () => {
	it("strips paths and numbers into stable placeholders", () => {
		const a = normalizeErrorLine(
			"Error: ENOENT: no such file or directory, open '/Users/a/Dev/w-1/f.ts'",
		);
		const b = normalizeErrorLine(
			"Error: ENOENT: no such file or directory, open '/Users/a/Dev/w-22/other.md'",
		);
		expect(a).toBe(b);
	});

	it("is stable across retry counters and elapsed timers", () => {
		const a = normalizeErrorLine("✢ Retrying… (attempt 3/10 · 12s)");
		const b = normalizeErrorLine("✢ Retrying… (attempt 7/10 · 214s)");
		expect(a).toBe(b);
	});

	it("case-folds and collapses whitespace", () => {
		expect(normalizeErrorLine("  Not  Logged   In ")).toBe(
			normalizeErrorLine("not logged in"),
		);
	});
});
