import { expect, it } from "vitest";
import { XiaohongshuTokenHandles } from "../xiaohongshu-tokens.js";

it("keeps token handles scoped, atomic on overflow, and invalid after close", () => {
	const vault = new XiaohongshuTokenHandles(() => {});
	const original = {
		id: "feed",
		xsecToken: "TOKEN_CANARY",
		url: "https://example.test/?xsec_token=TOKEN_CANARY",
	};
	const output = JSON.parse(vault.project(JSON.stringify(original)));
	expect(JSON.stringify(output)).not.toContain("TOKEN_CANARY");
	expect(vault.resolve(output.resourceHandle, "feed")).toBe("TOKEN_CANARY");
	expect(() => vault.resolve(output.resourceHandle, "other")).toThrow();
	expect(
		JSON.parse(vault.project(JSON.stringify(original))).resourceHandle,
	).toBe(output.resourceHandle);
	expect(() =>
		vault.project(JSON.stringify({ xsecToken: "TOKEN_CANARY" })),
	).toThrow();
	expect(() => vault.project("xsec_token=UNKNOWN_CANARY")).toThrow();
	expect(() =>
		vault.project(
			JSON.stringify(
				Array.from({ length: 513 }, (_, i) => ({
					id: `feed-${i}`,
					xsecToken: `TOKEN_CANARY_${i}`,
				})),
			),
		),
	).toThrow();
	expect(vault.resolve(output.resourceHandle, "feed")).toBe("TOKEN_CANARY");
	vault.close();
	expect(() => vault.resolve(output.resourceHandle, "feed")).toThrow();
	expect(() => vault.project("{}")).toThrow();
});
