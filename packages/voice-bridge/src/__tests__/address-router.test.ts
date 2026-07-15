/**
 * FLY-545 PR-2 P10′ — AddressRouter sticky addressing.
 *
 * All-listen is dead (FLY-968: 8/10 rounds of over-answering), so the pointer
 * is sticky on the host and only moves on an explicit name hit in a FINAL
 * founder transcript. Last name mentioned wins; matching is case-insensitive
 * substring (Chinese transcripts carry no word boundaries).
 */
import { describe, expect, it } from "vitest";
import { AddressRouter } from "../huddle/AddressRouter.js";

const PARTICIPANTS = [
	{ leadId: "flywheel-eng-lead", aliases: ["Tadashi", "阿正"] },
	{ leadId: "joycon-lead", aliases: ["Hiro"] },
	{
		leadId: "flywheel-product-lead",
		aliases: ["Honey Lemon", "HL", "蜂蜜柠檬"],
	},
];

function router(host = "flywheel-eng-lead") {
	return new AddressRouter(PARTICIPANTS, host);
}

describe("sticky default", () => {
	it("starts addressed to the host and stays there without a name hit", () => {
		const r = router();
		expect(r.addressed).toBe("flywheel-eng-lead");
		const res = r.route("这个方案我觉得可以,你们觉得呢");
		expect(res).toEqual({ addressed: "flywheel-eng-lead", switched: false });
	});

	it("naming the CURRENT addressee is not a switch", () => {
		const r = router();
		const res = r.route("Tadashi 你继续说");
		expect(res.switched).toBe(false);
		expect(r.addressed).toBe("flywheel-eng-lead");
	});

	it("rejects a host that is not a participant", () => {
		expect(() => new AddressRouter(PARTICIPANTS, "ghost")).toThrow(
			/not among the participants/,
		);
	});
});

describe("explicit switch", () => {
	it("moves the pointer on a name hit and reports the handoff", () => {
		const r = router();
		const res = r.route("Hiro,内存这块你怎么看?");
		expect(res).toEqual({
			addressed: "joycon-lead",
			switched: true,
			switchedFrom: "flywheel-eng-lead",
		});
		expect(r.addressed).toBe("joycon-lead");
	});

	it("stays sticky after the switch", () => {
		const r = router();
		r.route("Hiro,内存这块你怎么看?");
		const res = r.route("那这样改的话成本高吗");
		expect(res).toEqual({ addressed: "joycon-lead", switched: false });
	});

	it("the LAST name mentioned wins", () => {
		const r = router();
		const res = r.route("Tadashi 说的对,Hiro 你觉得呢?");
		expect(res.addressed).toBe("joycon-lead");
	});

	it("matches case-insensitively and via Chinese aliases", () => {
		const r = router();
		expect(r.route("hiro 你说说").addressed).toBe("joycon-lead");
		expect(r.route("蜂蜜柠檬你怎么看").addressed).toBe("flywheel-product-lead");
	});

	it("multi-word alias matches as a substring", () => {
		const r = router();
		expect(r.route("honey lemon,产品侧呢").addressed).toBe(
			"flywheel-product-lead",
		);
	});
});

describe("alias hygiene", () => {
	it("ignores sub-2-char aliases (noise guard)", () => {
		const r = new AddressRouter(
			[
				{ leadId: "a", aliases: ["X"] }, // too short — never matches
				{ leadId: "b", aliases: ["Bob"] },
			],
			"b",
		);
		expect(r.route("x 这个不算点名").switched).toBe(false);
	});
});
