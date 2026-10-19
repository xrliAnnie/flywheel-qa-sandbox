import { expect, test } from "vitest";
import { nearModel, unrelatedModel } from "../index.js";

test("near value 1", () => expect(nearModel).toBe("claude-opus-50"));
test("near value 2", () => expect(nearModel.endsWith("50")).toBe(true));
test("near value 3", () => expect(nearModel).not.toContain("5.5"));
test("near value 4", () => expect(nearModel.split("-")).toHaveLength(3));
test("unrelated value 1", () => expect(unrelatedModel).toBe("claude-sonnet-5"));
test("unrelated value 2", () =>
	expect(unrelatedModel.startsWith("claude")).toBe(true));
test("unrelated value 3", () => expect(unrelatedModel).not.toContain("opus"));
test("unrelated value 4", () =>
	expect(unrelatedModel.split("-")).toHaveLength(3));
