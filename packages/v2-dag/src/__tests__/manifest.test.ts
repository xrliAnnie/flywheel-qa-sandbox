import { describe, expect, it } from "vitest";
import { DagContractError } from "../errors.js";
import { parseRawManifest } from "../manifest.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_ZERO = "0".repeat(40);
const SHA256_A = "c".repeat(64);
const SHA256_B = "d".repeat(64);

function record(header: string, ...paths: string[]): string {
	return `${[header, ...paths].join("\0")}\0`;
}

describe("FLY-1554 manifest sha contract", () => {
	it("parses full-sha records for every supported status letter", () => {
		const raw =
			record(`:000000 100644 ${SHA_ZERO} ${SHA_A} A`, "engineering/added.ts") +
			record(`:100644 100644 ${SHA_A} ${SHA_B} M`, "engineering/modified.ts") +
			record(
				`:100644 000000 ${SHA_A} ${SHA_ZERO} D`,
				"engineering/deleted.ts",
			) +
			record(
				`:100644 100644 ${SHA_A} ${SHA_A} R100`,
				"engineering/old-name.ts",
				"engineering/new-name.ts",
			);
		const entries = parseRawManifest(raw);
		expect(entries).toEqual([
			{
				status: "A",
				path: "engineering/added.ts",
				classification: "product",
			},
			{
				status: "M",
				path: "engineering/modified.ts",
				classification: "product",
			},
			{
				status: "D",
				path: "engineering/deleted.ts",
				classification: "product",
			},
			{
				status: "R",
				oldPath: "engineering/old-name.ts",
				path: "engineering/new-name.ts",
				classification: "product",
			},
		]);
	});

	it("parses 64-hex object names for sha256 repositories", () => {
		const entries = parseRawManifest(
			record(`:100644 100644 ${SHA256_A} ${SHA256_B} M`, "kept.md"),
		);
		expect(entries).toEqual([
			{ status: "M", path: "kept.md", classification: "docs" },
		]);
	});

	it("rejects abbreviated object names instead of guessing at uniqueness", () => {
		// This is the exact production record shape that stalled FLY-1548:
		// `git diff --raw` without --no-abbrev abbreviates object names.
		const abbreviated = record(
			":000000 100644 00000000 94b889e5 A",
			"engineering/doc/FLY-1548-manuals-titles/design-review/VERDICT.md",
		);
		expect(() => parseRawManifest(abbreviated)).toThrow(DagContractError);
		expect(() => parseRawManifest(abbreviated)).toThrow(
			"unsupported git manifest record",
		);
	});
});
