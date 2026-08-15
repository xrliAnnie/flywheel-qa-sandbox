import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLiveMailboxQueueEnabled } from "../queue-mode.js";

describe("FLY-1773 inbox-mcp live queue ownership", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("observes OFF then ON from the same live dotenv without process restart", () => {
		const dir = join(tmpdir(), `fly1773-mode-${Date.now()}-${Math.random()}`);
		dirs.push(dir);
		mkdirSync(dir, { recursive: true });
		const dotenvPath = join(dir, ".env");

		writeFileSync(dotenvPath, "FLYWHEEL_MAILBOX_QUEUE=0\n");
		expect(resolveLiveMailboxQueueEnabled({ dotenvPath, processEnv: {} })).toBe(
			false,
		);
		writeFileSync(dotenvPath, "FLYWHEEL_MAILBOX_QUEUE=1\n");
		expect(resolveLiveMailboxQueueEnabled({ dotenvPath, processEnv: {} })).toBe(
			true,
		);
		writeFileSync(dotenvPath, "# default-on again\n");
		expect(resolveLiveMailboxQueueEnabled({ dotenvPath, processEnv: {} })).toBe(
			true,
		);
	});

	it("falls back to inherited env only when the dotenv is unreadable", () => {
		expect(
			resolveLiveMailboxQueueEnabled({
				dotenvPath: join(tmpdir(), `missing-${Math.random()}`),
				processEnv: { FLYWHEEL_MAILBOX_QUEUE: "0" },
			}),
		).toBe(false);
	});
});
