import { expect, test } from "vitest";
import { gammaFallback, gammaModel } from "../model.js";

test("gamma primary", () => expect(gammaModel).toBe("claude-opus-5"));
test("gamma fallback", () => expect(gammaFallback).toBe("claude-opus-5"));
test("gamma primary is stable", () =>
	expect(gammaModel).toEqual("claude-opus-5"));
test("gamma fallback is stable", () =>
	expect(gammaFallback).toEqual("claude-opus-5"));
test("gamma primary serializes", () =>
	expect(`${gammaModel}`).toBe("claude-opus-5"));
test("gamma fallback serializes", () =>
	expect(`${gammaFallback}`).toBe("claude-opus-5"));
