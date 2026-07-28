import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as publicApi from "../index.js";

describe("v2 actions public boundary", () => {
	it("exports exactly one runtime helper", () => {
		expect(Object.keys(publicApi)).toEqual(["runRecordedAction"]);
	});

	it("contains no action-kind branch or external-system registry", () => {
		const source = readFileSync(
			fileURLToPath(new URL("../index.ts", import.meta.url)),
			"utf8",
		);
		expect(source).not.toMatch(/\bswitch\s*\(/);
		expect(source).not.toMatch(/\b(?:github|discord|linear|process)\b/i);
		expect(source).not.toContain("action.kind");
	});
});
