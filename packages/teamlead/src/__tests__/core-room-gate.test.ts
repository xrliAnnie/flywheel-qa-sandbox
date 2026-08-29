import { describe, expect, it } from "vitest";
import { resolveCoreRoomGate } from "../core-room-gate.js";

// FLY-898 — the single decision that drives BOTH backends' core-room mention
// gate. `gateNonCoS` is true iff: (1) the project has a core room
// (generalChannel set), AND (2) the project has a CoS (some lead's chatChannel
// equals the core), AND (3) THIS lead is not that CoS. Any other shape →
// fail-open (do NOT gate), which preserves current behavior byte-for-byte.

// Fleet snapshot (research.md §2.1) — the real projects, table-driven.
const geoforge3d = {
	generalChannel: "core-geo",
	leads: [
		{ agentId: "cos-lead", chatChannel: "core-geo" }, // Simba (CoS)
		{ agentId: "product-lead", chatChannel: "chat-peter" }, // Peter
		{ agentId: "ops-lead", chatChannel: "chat-oliver" }, // Oliver
	],
};
const growth = {
	generalChannel: "core-growth",
	leads: [
		{ agentId: "mufasa-lead", chatChannel: "core-growth" }, // Mufasa CoS (codex)
		{ agentId: "rafiki-lead", chatChannel: "chat-rafiki" },
		{ agentId: "reflection-lead", chatChannel: "chat-reflection" },
	],
};
const sub = {
	generalChannel: "core-sub",
	leads: [{ agentId: "sub-lead", chatChannel: "core-sub" }], // Asha, single CoS
};
const joycon = {
	// core-有-但-无-CoS: generalChannel set, but joycon-lead chat != core.
	generalChannel: "core-joycon",
	leads: [{ agentId: "joycon-lead", chatChannel: "chat-joycon" }],
};
const personalAssistant = {
	// no core room at all.
	leads: [{ agentId: "belle", chatChannel: "chat-belle" }],
};

describe("resolveCoreRoomGate (FLY-898 single decision)", () => {
	it("multi-lead core, non-CoS lead → GATE (Peter in geoforge3d)", () => {
		const g = resolveCoreRoomGate(geoforge3d, geoforge3d.leads[1]);
		expect(g).toEqual({
			coreChannelId: "core-geo",
			projectHasCoS: true,
			isCoS: false,
			gateNonCoS: true,
		});
	});

	it("multi-lead core, the OTHER non-CoS lead → GATE (Oliver)", () => {
		expect(
			resolveCoreRoomGate(geoforge3d, geoforge3d.leads[2]).gateNonCoS,
		).toBe(true);
	});

	it("CoS itself → NOT gated (Simba: chat==core)", () => {
		const g = resolveCoreRoomGate(geoforge3d, geoforge3d.leads[0]);
		expect(g.isCoS).toBe(true);
		expect(g.gateNonCoS).toBe(false);
		expect(g.coreChannelId).toBe("core-geo");
	});

	it("codex CoS itself → NOT gated (Mufasa: chat==core)", () => {
		expect(resolveCoreRoomGate(growth, growth.leads[0]).gateNonCoS).toBe(false);
	});

	it("codex non-CoS lead in a core-with-CoS project → GATE (rafiki)", () => {
		expect(resolveCoreRoomGate(growth, growth.leads[1]).gateNonCoS).toBe(true);
	});

	it("single-lead CoS project → NOT gated (sub/Asha)", () => {
		const g = resolveCoreRoomGate(sub, sub.leads[0]);
		expect(g.isCoS).toBe(true);
		expect(g.gateNonCoS).toBe(false);
	});

	it("core-有-但-无-CoS (joycon) → fail-open, NOT gated", () => {
		const g = resolveCoreRoomGate(joycon, joycon.leads[0]);
		expect(g).toEqual({
			coreChannelId: "core-joycon",
			projectHasCoS: false,
			isCoS: false,
			gateNonCoS: false,
		});
	});

	it("no generalChannel (personal-assistant) → not gated, no core", () => {
		const g = resolveCoreRoomGate(
			personalAssistant,
			personalAssistant.leads[0],
		);
		expect(g).toEqual({
			coreChannelId: undefined,
			projectHasCoS: false,
			isCoS: false,
			gateNonCoS: false,
		});
	});

	it("empty-string generalChannel is treated as absent (defensive)", () => {
		const g = resolveCoreRoomGate(
			{ generalChannel: "", leads: [{ agentId: "x", chatChannel: "y" }] },
			{ agentId: "x", chatChannel: "y" },
		);
		expect(g.coreChannelId).toBeUndefined();
		expect(g.gateNonCoS).toBe(false);
	});

	it("lead not in the project's roster is still classified structurally", () => {
		// A caller may pass a lead object that is not literally === a roster entry
		// (e.g. reconstructed from env). Classification is by chatChannel value.
		const stranger = { agentId: "product-lead", chatChannel: "chat-peter" };
		expect(resolveCoreRoomGate(geoforge3d, stranger).gateNonCoS).toBe(true);
	});
});
