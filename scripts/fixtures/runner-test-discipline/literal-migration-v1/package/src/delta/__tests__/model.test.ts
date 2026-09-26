import { expect, test } from "vitest";
import { deltaFallback, deltaModel } from "../model.js";

test("delta primary", () => expect(deltaModel).toBe("claude-opus-5"));
test("delta fallback", () => expect(deltaFallback).toBe("claude-opus-5"));
test("delta primary is stable", () =>
	expect(deltaModel).toEqual("claude-opus-5"));
test("delta fallback is stable", () =>
	expect(deltaFallback).toEqual("claude-opus-5"));
test("delta primary serializes", () =>
	expect(`${deltaModel}`).toBe("claude-opus-5"));
test("delta fallback serializes", () =>
	expect(`${deltaFallback}`).toBe("claude-opus-5"));
