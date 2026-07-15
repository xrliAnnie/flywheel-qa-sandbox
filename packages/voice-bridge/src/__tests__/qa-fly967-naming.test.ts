/**
 * QA · FLY-967 (Opus QA phase) — founder-facing naming regression.
 *
 * The command was renamed /live → /gemini (Annie final; commit 9a9fe476,
 * "founder-facing strings now say gemini"). The landing summary header —
 * which is posted as a COMMENT onto the kickoff issue Annie reads after every
 * meeting — must not still advertise the retired /live name, and must reflect
 * the shipped command name.
 *
 * This is the ONE founder-facing string the rename missed. Added by QA to pin
 * the invariant so the implement phase's fix is verifiable.
 */
import { describe, expect, it } from "vitest";
import { AssistantLanding } from "../assistant/AssistantLanding.js";

describe("QA·FLY-967 — landing summary founder-facing naming", () => {
	const summary = AssistantLanding.buildSummary({
		issueId: "FLY-967",
		sessionId: "sess-1",
		recapText: "今天聊清了三件事。",
		quotes: [{ ts: "2026-07-07T22:00:00.000Z", text: "就这样吧" }],
		confirmed: true,
	});

	it("does NOT advertise the retired /live command name", () => {
		// the rename retired /live → /gemini; a landed comment must not say /live.
		expect(summary).not.toContain("/live");
	});

	it("advertises the shipped /gemini command name in the header", () => {
		expect(summary).toContain("/gemini");
	});
});
