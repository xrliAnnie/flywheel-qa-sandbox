import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_FILES = [
	"bootstrap.ts",
	"candidates.ts",
	"config.ts",
	"consume-loop.ts",
	"driver.ts",
	"enqueue.ts",
	"index.ts",
	"registration.ts",
	"settlement.ts",
	"sql.ts",
	"transitions.ts",
	"types.ts",
];

describe("deleted v1 delivery machinery stays deleted", () => {
	it.each([
		["ring call", /\bring\(/],
		["hint call", /\.hint\(/],
		["deliver call", /\.deliver\(/],
		["delivery timeout", /reportDeliveryTimeout/],
		["T-max hook", /onTMaxExceeded/],
		["injection marker", /pa\.injected/],
		["owner mirror", /ownerLeadId/],
		["consumer registry", /consumer_registry:/],
	])("has no %s", (_label, forbidden) => {
		const matches = SOURCE_FILES.filter((file) =>
			forbidden.test(readFileSync(join(SOURCE_ROOT, file), "utf8")),
		);
		expect(matches).toEqual([]);
	});

	it("does not retain disposal or timer source modules", () => {
		expect(() =>
			readFileSync(join(SOURCE_ROOT, "disposal.ts"), "utf8"),
		).toThrow();
		expect(() =>
			readFileSync(join(SOURCE_ROOT, "fairness-sla.ts"), "utf8"),
		).toThrow();
	});
});
