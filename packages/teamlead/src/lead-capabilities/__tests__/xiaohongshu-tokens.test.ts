import { expect, it } from "vitest";
import { XiaohongshuTokenHandles } from "../xiaohongshu-tokens.js";

it("projects provider note identifiers and strips empty tokens without granting handles", () => {
	const vault = new XiaohongshuTokenHandles(() => {});
	for (const key of ["noteId", "note_id"]) {
		const output = JSON.parse(
			vault.project(
				JSON.stringify({
					[key]: "note",
					xsecToken: "NOTE_TOKEN_CANARY",
				}),
			),
		);
		expect(vault.resolve(output.resourceHandle, "note")).toBe(
			"NOTE_TOKEN_CANARY",
		);
		expect(output).not.toHaveProperty("xsecToken");
	}
	expect(
		JSON.parse(
			vault.project(
				JSON.stringify({
					noteId: "note",
					xsecToken: "",
					xsec_token: "",
					user: { userId: "user", xsecToken: "" },
				}),
			),
		),
	).toEqual({ noteId: "note", user: { userId: "user" } });
});

it("rejects conflicting note identities, malformed tokens and injected handles", () => {
	const vault = new XiaohongshuTokenHandles(() => {});
	for (const value of [
		{ id: "one", noteId: "two", xsecToken: "NOTE_TOKEN_CANARY" },
		{ note_id: "one", noteId: "two", xsecToken: "NOTE_TOKEN_CANARY" },
		{ noteId: "note", xsecToken: "", xsec_token: "NOTE_TOKEN_CANARY" },
		{ noteId: "note", xsecToken: null },
		{ noteId: "note", xsecToken: "short" },
		{ noteId: "note", xsecToken: "", resourceHandle: "injected" },
	])
		expect(() => vault.project(JSON.stringify(value))).toThrow(
			"upstream_token_unverified",
		);
});

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
