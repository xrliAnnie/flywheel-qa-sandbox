import { describe, expect, it } from "vitest";
import { describeUnexpectedClose } from "../backends/gemini/genaiConnector.js";

describe("describeUnexpectedClose", () => {
	it("appends model guidance when the close reason is a model-404", () => {
		const msg = describeUnexpectedClose(
			"models/gemini-live-2.5-flash-preview is not found for API version v1beta, or is not supported for bidiGenerateContent.",
			"gemini-live-2.5-flash-preview",
		);
		expect(msg).toContain("FLYWHEEL_VOICE_GEMINI_MODEL");
		expect(msg).toContain("models.list");
		expect(msg).toContain("gemini-live-2.5-flash-preview");
	});

	it("keeps plain unexpected closes unchanged", () => {
		expect(describeUnexpectedClose("going away", "m")).toBe(
			"Gemini Live connection closed unexpectedly: going away",
		);
		expect(describeUnexpectedClose(undefined, "m")).toBe(
			"Gemini Live connection closed unexpectedly",
		);
	});
});
