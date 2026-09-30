import { expect, test } from "vitest";
import { alphaModel, betaModel, deltaModel, gammaModel } from "../index.js";

test("static imports expose the selected model", () => {
	expect([alphaModel, betaModel, gammaModel, deltaModel]).toEqual([
		"claude-opus-5",
		"claude-opus-5",
		"claude-opus-5",
		"claude-opus-5",
	]);
});
