import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isTransientThrottlePane } from "../pane-blocked-classifier.js";

const FIXTURES_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../__tests__/fixtures/lead-panes",
);
const loadFixture = (name: string): string =>
	readFileSync(join(FIXTURES_DIR, name), "utf8");
const STATUS_BAR =
	"\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ctx 31%";

describe("transient throttle pane recognizer", () => {
	it.each([
		"Server is temporarily limiting requests (not your usage limit)",
		"not your usage limit",
		'API Error: 529 {"type":"overloaded_error"}',
	])("recognizes live transient overload text: %s", (text) => {
		expect(isTransientThrottlePane(`${text}${STATUS_BAR}`)).toBe(true);
	});

	it.each(["usage limit reached", "claude code: usage limit exceeded."])(
		"does not suppress a real usage cap: %s",
		(text) => {
			expect(isTransientThrottlePane(`${text}${STATUS_BAR}`)).toBe(false);
		},
	);

	it("requires a live-TUI anchor", () => {
		expect(
			isTransientThrottlePane(
				"Server is temporarily limiting requests (not your usage limit)\n❯ ",
			),
		).toBe(false);
	});

	it.each(["", 'Try "fix the bug"\n? for shortcuts', "some random output"])(
		"ignores unrelated panes: %s",
		(text) => expect(isTransientThrottlePane(text)).toBe(false),
	);

	it("does not suppress stale overload text in scrollback", () => {
		const pane = loadFixture("throttle-529-stale-scrollback.txt");
		expect(/not your usage limit/i.test(pane)).toBe(true);
		expect(isTransientThrottlePane(pane)).toBe(false);
	});

	it("recognizes live and settled overload fixtures", () => {
		expect(isTransientThrottlePane(loadFixture("throttle-529-live.txt"))).toBe(
			true,
		);
		expect(
			isTransientThrottlePane(loadFixture("throttle-529-settled.txt")),
		).toBe(true);
	});

	it.each([
		"usage-limit-real.txt",
		"throttle-529-then-usage-cap.txt",
		"throttle-529-then-resume-menu.txt",
	])("does not mask a newer actionable state: %s", (fixture) => {
		expect(isTransientThrottlePane(loadFixture(fixture))).toBe(false);
	});

	it("does not mask compaction in the same live region", () => {
		const pane = loadFixture("throttle-529-then-compacting.txt");
		expect(isTransientThrottlePane(pane)).toBe(false);
		expect(
			isTransientThrottlePane(
				pane.replace(/✳ Compacting conversation[^\n]*/i, ""),
			),
		).toBe(true);
	});

	it("requires retry evidence for a live in-flight frame", () => {
		const pane = loadFixture("throttle-529-then-frozen-work.txt");
		expect(isTransientThrottlePane(pane)).toBe(false);
		expect(
			isTransientThrottlePane(
				pane.replace(
					/✻ Cooking… \(esc to interrupt\)/i,
					"✻ Cooking… (esc to interrupt · retrying)",
				),
			),
		).toBe(true);
	});
});
