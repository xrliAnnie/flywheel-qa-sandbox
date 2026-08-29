import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	canonicalJsonString,
	canonicalSubmissionDigest,
} from "../canonical-json.js";

describe("canonical workflow payload encoding", () => {
	it("sorts object keys recursively while preserving array order", () => {
		expect(canonicalJsonString({ z: 1, a: { y: 2, x: 3 }, list: [2, 1] })).toBe(
			'{"a":{"x":3,"y":2},"list":[2,1],"z":1}',
		);
	});

	it("normalizes undefined array entries to JSON null", () => {
		expect(canonicalJsonString([1, undefined, 2])).toBe("[1,null,2]");
	});

	it("produces one sha256 digest independent of object insertion order", () => {
		const left = { schema_version: 1, payload: { b: true, a: "x" } };
		const right = { payload: { a: "x", b: true }, schema_version: 1 };
		const expected = createHash("sha256")
			.update(canonicalJsonString(left))
			.digest("hex");
		expect(canonicalSubmissionDigest(left)).toBe(expected);
		expect(canonicalSubmissionDigest(right)).toBe(expected);
	});
});
