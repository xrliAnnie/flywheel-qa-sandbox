import { expect, test } from "vitest";
import { alphaFallback, alphaModel } from "../model.js";

test("alpha primary", () => expect(alphaModel).toBe("claude-opus-5.5"));
test("alpha fallback", () => expect(alphaFallback).toBe("claude-opus-5.5"));
test("alpha primary is stable", () =>
	expect(alphaModel).toEqual("claude-opus-5.5"));
test("alpha fallback is stable", () =>
	expect(alphaFallback).toEqual("claude-opus-5.5"));
test("alpha primary serializes", () =>
	expect(`${alphaModel}`).toBe("claude-opus-5.5"));
test("alpha fallback serializes", () =>
	expect(`${alphaFallback}`).toBe("claude-opus-5.5"));
