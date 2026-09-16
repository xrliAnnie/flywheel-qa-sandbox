import { expect, it } from "vitest";
import {
	releaseCard,
	releaseMessageDigest,
} from "../customer-release/cards.js";

const input = {
	kind: "veto" as const,
	nonce: "a".repeat(32),
	epoch: 1,
	timezone: "America/Los_Angeles",
	betaVersion: "1.2.3-beta.1",
	releaseVersion: "1.2.3",
	sourceCommit: "b".repeat(40),
	payloadSha256: "c".repeat(64),
	deadlineAt: Date.parse("2026-09-15T22:00:00Z"),
};
it("card names the exact artifact and one-click action without allowing mentions", () => {
	const card = releaseCard(input);
	expect(card.content).toContain("1.2.3");
	expect(card.content).toContain(input.sourceCommit);
	expect(card.content).toContain(input.payloadSha256);
	expect(card.components[0].components[0]).toMatchObject({
		type: 2,
		style: 4,
		label: "否决本次发布",
		custom_id: `fwrel:veto:1:${input.nonce}`,
	});
	expect(card.allowed_mentions).toEqual({ parse: [] });
});
it("wire digest tolerates Discord component ids and default disabled=false but binds all visible action data", () => {
	const card = releaseCard(input);
	const wire = structuredClone(card) as any;
	wire.components[0].id = 1;
	wire.components[0].components[0].id = 2;
	wire.components[0].components[0].disabled = false;
	expect(releaseMessageDigest(wire)).toBe(releaseMessageDigest(card));
	for (const mutate of [
		(v: any) => {
			v.content += " changed";
		},
		(v: any) => {
			v.components[0].components[0].label = "继续发布";
		},
		(v: any) => {
			v.components[0].components[0].custom_id = `fwrel:go:1:${input.nonce}`;
		},
		(v: any) => {
			v.components[0].components[0].disabled = true;
		},
	]) {
		const changed = structuredClone(card);
		mutate(changed);
		expect(releaseMessageDigest(changed)).not.toBe(releaseMessageDigest(card));
	}
});
it("unknown component fields, injected attachments and embeds are rejected", () => {
	const card = releaseCard(input);
	for (const patch of [
		{ embeds: [{ description: "spoof" }] },
		{ attachments: [{ id: "file" }] },
	])
		expect(() => releaseMessageDigest({ ...card, ...patch })).toThrow();
	const changed = structuredClone(card) as any;
	changed.components[0].components[0].url = "https://other.example";
	expect(() => releaseMessageDigest(changed)).toThrow();
});
it("malformed artifact/epoch values cannot be rendered into a release card", () => {
	for (const patch of [
		{ releaseVersion: "<@everyone>" },
		{ sourceCommit: "bad" },
		{ epoch: 0 },
		{ nonce: "../x" },
	])
		expect(() => releaseCard({ ...input, ...patch })).toThrow();
});
it("card includes the frozen beta and configured local deadline", () => {
	const card = releaseCard(input);
	expect(card.content).toContain(input.betaVersion);
	expect(card.content).toContain("America/Los_Angeles");
	expect(card.content).toContain("15:00");
	for (const patch of [
		{ timezone: "bogus" },
		{ betaVersion: "2.0.0-beta.1" },
		{ deadlineAt: NaN },
	])
		expect(() => releaseCard({ ...input, ...patch })).toThrow();
});
