import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const docRoot = new URL(
	"../../../../../engineering/doc/FLY-1278-review-gate-convergence/",
	import.meta.url,
);
const artifactPaths = [
	"exploration.md",
	"research.md",
	"plan.md",
	"progress.md",
	"fixtures/README.md",
	"fixtures/fly-1251-rounds-6-9.json",
	"codex-design-review/codex-rescue-design-feedback-flywheel-FLY-1278-plan-round1.md",
	"codex-design-review/codex-rescue-design-feedback-flywheel-FLY-1278-plan-round2.md",
	"codex-design-review/codex-rescue-design-feedback-flywheel-FLY-1278-plan-round3.md",
];

describe("FLY-1278 evidence artifacts", () => {
	it("contain no literal control bytes other than text whitespace", () => {
		for (const relativePath of artifactPaths) {
			const bytes = readFileSync(fileURLToPath(new URL(relativePath, docRoot)));
			const forbidden = [...bytes].filter(
				(byte) =>
					(byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) ||
					byte === 0x7f,
			);
			expect(forbidden, relativePath).toEqual([]);
		}
	});

	it("pins the byte-exact FLY-1251 R6-R9 production export", () => {
		const bytes = readFileSync(
			fileURLToPath(new URL("fixtures/fly-1251-rounds-6-9.json", docRoot)),
		);
		expect(createHash("sha256").update(bytes).digest("hex")).toBe(
			"ccc985af7072d392aac34178ad544b2120ae43b6abc5207d8e903065a138447f",
		);
	});
});
