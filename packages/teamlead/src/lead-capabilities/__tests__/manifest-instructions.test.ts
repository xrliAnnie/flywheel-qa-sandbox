import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readManifestInstructions } from "../manifest-instructions.js";

it("reads the hashed ordered rule snapshot and rejects changed, missing or secret content", () => {
	const root = mkdtempSync(join(tmpdir(), "manifest-rules-"));
	const source = (name: string, text: string) => {
		const path = join(root, name);
		writeFileSync(path, text);
		return { path, sha256: createHash("sha256").update(text).digest("hex") };
	};
	try {
		const first = source("first.md", "---\nmodel: opus\n---\nFirst rule"),
			second = source("second.md", "Second rule");
		expect(readManifestInstructions([first, second], [])).toBe(
			"First rule\n\nSecond rule",
		);
		expect(() =>
			readManifestInstructions([first, second], ["Second rule"]),
		).toThrow("capability_rules_unverified");
		writeFileSync(second.path, "Changed rule");
		expect(() => readManifestInstructions([first, second], [])).toThrow(
			"capability_rules_unverified",
		);
		rmSync(second.path);
		expect(() => readManifestInstructions([first, second], [])).toThrow(
			"capability_rules_unverified",
		);
		expect(() => readManifestInstructions([], [])).toThrow(
			"capability_rules_unverified",
		);
		expect(() =>
			readManifestInstructions([source("empty.md", " \n")], []),
		).toThrow("capability_rules_unverified");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
