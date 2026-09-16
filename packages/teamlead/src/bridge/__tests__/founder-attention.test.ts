import { describe, expect, it } from "vitest";
import { founderAttentionLevel } from "../founder-attention.js";

describe("founder attention vocabulary", () => {
	it("lights only structured founder requests and gives ship precedence", () => {
		expect(founderAttentionLevel(["legacy_founder_gate"])).toBe("answer");
		expect(founderAttentionLevel(["founder_ask"])).toBe("answer");
		expect(founderAttentionLevel(["founder_ask", "ship"])).toBe("ship");
		expect(founderAttentionLevel(["founder_gate", "founder_ask"])).toBe("ship");
		expect(
			founderAttentionLevel(["lead_question", "founder_named", "question"]),
		).toBeNull();
		expect(founderAttentionLevel([])).toBeNull();
	});
});
