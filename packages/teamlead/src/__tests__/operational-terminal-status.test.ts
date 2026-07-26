import { describe, expect, it } from "vitest";
import {
	isOperationalTerminalStatus,
	isWakeTerminalStatus,
} from "../operational-terminal-status.js";

describe("terminal status authority", () => {
	it.each([
		"completed",
		"terminated",
		"failed",
		"blocked",
		"timeout",
		"canceled",
		"cancelled",
	])("treats %s as both operational- and wake-terminal", (status) => {
		expect(isOperationalTerminalStatus(status)).toBe(true);
		expect(isWakeTerminalStatus(status)).toBe(true);
	});

	it.each(["rejected", "deferred", "shelved", "approved"])(
		"keeps %s operational-terminal without granting wake settlement authority",
		(status) => {
			expect(isOperationalTerminalStatus(status)).toBe(true);
			expect(isWakeTerminalStatus(status)).toBe(false);
		},
	);
});
