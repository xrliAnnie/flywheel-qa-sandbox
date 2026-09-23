import { expect, test } from "vitest";
import { betaFallback, betaModel } from "../model.js";

test("beta primary", () => expect(betaModel).toBe("claude-opus-5"));
test("beta fallback", () => expect(betaFallback).toBe("claude-opus-5"));
test("beta primary is stable", () =>
	expect(betaModel).toEqual("claude-opus-5"));
test("beta fallback is stable", () =>
	expect(betaFallback).toEqual("claude-opus-5"));
test("beta primary serializes", () =>
	expect(`${betaModel}`).toBe("claude-opus-5"));
test("beta fallback serializes", () =>
	expect(`${betaFallback}`).toBe("claude-opus-5"));
