import { describe, expect, it } from "vitest";
import {
	readEnvFileSource,
	readEnvFileValue,
	readEnvValueFromContent,
} from "../env-file.js";

describe("shared env-file reader", () => {
	it("matches shell-source precedence: last uncommented plain/export assignment wins", () => {
		const content = [
			"# FLYWHEEL_FLAG=ignored",
			"FLYWHEEL_FLAG=0",
			"export FLYWHEEL_FLAG=1",
			"",
		].join("\n");
		expect(readEnvValueFromContent(content, "FLYWHEEL_FLAG")).toBe("1");
	});

	it("distinguishes a readable file with an absent key from an unavailable file", () => {
		const readable = readEnvFileSource("/tmp/.env", () => "OTHER=1\n");
		expect(readEnvFileValue(readable, "FLYWHEEL_FLAG")).toEqual({
			status: "readable",
			raw: undefined,
		});

		const unavailable = readEnvFileSource("/tmp/.env", () => {
			throw new Error("permission denied");
		});
		expect(readEnvFileValue(unavailable, "FLYWHEEL_FLAG")).toEqual({
			status: "unavailable",
		});
	});
});
