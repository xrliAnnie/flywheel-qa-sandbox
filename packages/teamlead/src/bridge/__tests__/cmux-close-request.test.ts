import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requestCmuxPinClose } from "../cmux-close-request.js";

// FLY-685: requestCmuxPinClose appends runner window_names to a marker file the
// cmux-sync watcher drains to close the matching workspace pin.

describe("requestCmuxPinClose", () => {
	let dir: string;
	let file: string;
	const prevFile = process.env.FLYWHEEL_CMUX_CLOSE_REQUEST_FILE;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly685-"));
		file = join(dir, "close-requested");
		process.env.FLYWHEEL_CMUX_CLOSE_REQUEST_FILE = file;
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		if (prevFile === undefined)
			delete process.env.FLYWHEEL_CMUX_CLOSE_REQUEST_FILE;
		else process.env.FLYWHEEL_CMUX_CLOSE_REQUEST_FILE = prevFile;
	});

	it("writes the window_name as its own line", () => {
		requestCmuxPinClose("FLY-685-claude-close-runner-stale-pin");
		expect(readFileSync(file, "utf8")).toBe(
			"FLY-685-claude-close-runner-stale-pin\n",
		);
	});

	it("appends (does not overwrite) across calls", () => {
		requestCmuxPinClose("FLY-1-claude-a");
		requestCmuxPinClose("FLY-2-claude-b");
		expect(readFileSync(file, "utf8")).toBe("FLY-1-claude-a\nFLY-2-claude-b\n");
	});

	it("trims surrounding whitespace", () => {
		requestCmuxPinClose("  FLY-3-claude-c  ");
		expect(readFileSync(file, "utf8")).toBe("FLY-3-claude-c\n");
	});

	it.each([
		["empty", ""],
		["whitespace-only", "   "],
		["contains newline", "FLY-5-claude-e\nrm -rf"],
		["contains carriage return", "FLY-5-claude-e\rx"],
		["contains tab", "FLY-5-claude-e\tx"],
		["overlong", `FLY-6-claude-${"x".repeat(300)}`],
	])("rejects invalid window_name (%s) without writing", (_label, name) => {
		requestCmuxPinClose(name);
		expect(existsSync(file)).toBe(false);
	});

	it("never throws when the marker path is unwritable", () => {
		// point at a path whose parent does not exist → appendFileSync throws ENOENT
		process.env.FLYWHEEL_CMUX_CLOSE_REQUEST_FILE = join(
			dir,
			"no-such-dir",
			"marker",
		);
		expect(() => requestCmuxPinClose("FLY-7-claude-f")).not.toThrow();
	});
});
