import { describe, expect, it } from "vitest";
import { computeAllLeadEntries } from "../core-room-gate-cli.js";

describe("computeAllLeadEntries (FLY-944)", () => {
	const projects = [
		{
			projectName: "flywheel",
			generalChannel: "core-1",
			leads: [
				{ agentId: "cos", chatChannel: "core-1" },
				{ agentId: "eng", chatChannel: "chat-eng" },
				{
					agentId: "mufasa",
					chatChannel: "chat-m",
					backend: "codex-app-server",
				},
			],
		},
		{
			// no core → no gate, still enumerated (roundtable sweep needs the lead)
			projectName: "coreless",
			leads: [{ agentId: "solo", chatChannel: "chat-s" }],
		},
	];

	it("emits one entry per lead with role flags", () => {
		expect(computeAllLeadEntries(projects as never)).toEqual([
			{
				projectName: "flywheel",
				leadId: "cos",
				coreChannelId: "core-1",
				isCoS: true,
				gateNonCoS: false,
				backend: "claude-code",
			},
			{
				projectName: "flywheel",
				leadId: "eng",
				coreChannelId: "core-1",
				isCoS: false,
				gateNonCoS: true,
				backend: "claude-code",
			},
			{
				projectName: "flywheel",
				leadId: "mufasa",
				coreChannelId: "core-1",
				isCoS: false,
				gateNonCoS: true,
				backend: "codex-app-server",
			},
			{
				projectName: "coreless",
				leadId: "solo",
				coreChannelId: undefined,
				isCoS: false,
				gateNonCoS: false,
				backend: "claude-code",
			},
		]);
	});
});
