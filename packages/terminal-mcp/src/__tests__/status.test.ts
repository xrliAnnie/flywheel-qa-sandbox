import { describe, expect, it } from "vitest";
import { detectTerminalStatus } from "../status.js";

describe("detectTerminalStatus", () => {
	it("should detect waiting state from Y/n prompt", () => {
		const output = `Building project...
Done.
Do you want to proceed? [Y/n]`;
		const result = detectTerminalStatus(output);
		expect(result.status).toBe("waiting");
		expect(result.reason).toContain("Do you want to proceed");
	});

	it("should detect waiting state from Claude Code permission prompt", () => {
		const output = `I'll edit the file now.
Do you want to allow this edit?
[Allow] [Deny]`;
		const result = detectTerminalStatus(output);
		expect(result.status).toBe("waiting");
	});

	it("should detect waiting state from Would you like prompt", () => {
		const output = `Found 3 issues.
Would you like to fix them?`;
		const result = detectTerminalStatus(output);
		expect(result.status).toBe("waiting");
		expect(result.reason).toContain("Would you like");
	});

	it("should detect waiting state from yes/no prompt", () => {
		const output = `Delete all files? (yes/no)`;
		const result = detectTerminalStatus(output);
		expect(result.status).toBe("waiting");
	});

	it("should detect idle state from bare shell prompt", () => {
		const output = `npm test
All tests passed.
❯ `;
		const result = detectTerminalStatus(output);
		expect(result.status).toBe("idle");
		expect(result.reason).toContain("shell prompt");
	});

	it("should detect idle state from user@host prompt", () => {
		const output = `exit
user@macbook:~/Dev $`;
		const result = detectTerminalStatus(output);
		expect(result.status).toBe("idle");
	});

	it("should detect executing state when no prompt detected", () => {
		const output = `Running tests...
  ✓ test 1 passed
  ✓ test 2 passed
  ● test 3 running...`;
		const result = detectTerminalStatus(output);
		expect(result.status).toBe("executing");
		expect(result.reason).toContain("no prompt");
	});

	it("should return idle for empty output", () => {
		const result = detectTerminalStatus("");
		expect(result.status).toBe("idle");
		expect(result.reason).toContain("empty");
	});

	it("should return idle for whitespace-only output", () => {
		const result = detectTerminalStatus("   \n  \n   ");
		expect(result.status).toBe("idle");
		expect(result.reason).toContain("empty");
	});

	it("should prioritize waiting over idle when both present", () => {
		// Edge case: prompt appears before a shell-like line
		const output = `Do you want to proceed? [Y/n]
$ `;
		const result = detectTerminalStatus(output);
		expect(result.status).toBe("waiting");
	});

	it("should detect Allow? prompt", () => {
		const output = `Claude wants to write to file.ts
Allow?`;
		const result = detectTerminalStatus(output);
		expect(result.status).toBe("waiting");
	});

	it("should detect Press Enter prompt", () => {
		const output = `Installation complete.
Press Enter to continue...`;
		const result = detectTerminalStatus(output);
		expect(result.status).toBe("waiting");
	});

	it("should detect Should I prompt", () => {
		const output = `Found conflicts in 2 files.
Should I resolve them automatically?`;
		const result = detectTerminalStatus(output);
		expect(result.status).toBe("waiting");
	});

	it("should handle long executing output", () => {
		const lines = Array.from(
			{ length: 50 },
			(_, i) => `  Building module ${i + 1}...`,
		);
		const output = lines.join("\n");
		const result = detectTerminalStatus(output);
		expect(result.status).toBe("executing");
	});
});
