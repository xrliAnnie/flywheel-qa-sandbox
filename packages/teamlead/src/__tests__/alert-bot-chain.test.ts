/**
 * FLY-368 rework: owner-attributed bot-token chains.
 */
import { describe, expect, it } from "vitest";
import {
	allLeadsAlphaEnvs,
	buildRepairChain,
	buildSendChain,
	ownBotEnvCandidates,
	resolveFirstAvailableBotToken,
} from "../bridge/alert-bot-chain.js";
import type { ProjectEntry } from "../ProjectConfig.js";

const projects = [
	{
		projectName: "flywheel",
		projectRoot: "/x",
		leads: [
			{
				agentId: "flywheel-cos-lead",
				chatChannel: "c",
				match: { labels: ["cos"] },
				botTokenEnv: "CASS_BOT_TOKEN",
			},
			{
				agentId: "flywheel-eng-lead",
				chatChannel: "c",
				match: { labels: ["eng"] },
				botTokenEnv: "TADASHI_BOT_TOKEN",
			},
		],
	},
	{
		projectName: "growth",
		projectRoot: "/y",
		leads: [
			{
				agentId: "rafiki-lead",
				chatChannel: "c",
				match: { labels: ["x"] },
				botTokenEnv: "RAFIKI_BOT_TOKEN",
			},
		],
	},
] as unknown as ProjectEntry[];

describe("alert-bot-chain (FLY-368 rework)", () => {
	it("ownBotEnvCandidates: botTokenEnv first, then alertBotTokenEnv compat", () => {
		expect(ownBotEnvCandidates({ botTokenEnv: "A" })).toEqual(["A"]);
		expect(
			ownBotEnvCandidates({ botTokenEnv: "A", alertBotTokenEnv: "B" }),
		).toEqual(["A", "B"]);
		expect(ownBotEnvCandidates({ alertBotTokenEnv: "B" })).toEqual(["B"]);
		expect(
			ownBotEnvCandidates({ botTokenEnv: "A", alertBotTokenEnv: "A" }),
		).toEqual(["A"]);
	});

	it("allLeadsAlphaEnvs: sorted by agentId fleet-wide", () => {
		expect(allLeadsAlphaEnvs(projects)).toEqual([
			"CASS_BOT_TOKEN", // flywheel-cos-lead
			"TADASHI_BOT_TOKEN", // flywheel-eng-lead
			"RAFIKI_BOT_TOKEN", // rafiki-lead
		]);
	});

	it("buildSendChain: own → Cass → alpha, de-duped priority", () => {
		// rafiki stuck → own first, then Cass, then the rest alpha (rafiki de-duped out)
		expect(buildSendChain(projects, "rafiki-lead", "CASS_BOT_TOKEN")).toEqual([
			"RAFIKI_BOT_TOKEN",
			"CASS_BOT_TOKEN",
			"TADASHI_BOT_TOKEN",
		]);
	});

	it("buildSendChain: stuck lead == Cass → de-dup keeps one Cass first", () => {
		expect(
			buildSendChain(projects, "flywheel-cos-lead", "CASS_BOT_TOKEN"),
		).toEqual(["CASS_BOT_TOKEN", "TADASHI_BOT_TOKEN", "RAFIKI_BOT_TOKEN"]);
	});

	it("buildSendChain: unknown leadId → degrades to Cass → alpha", () => {
		expect(buildSendChain(projects, "ghost-lead", "CASS_BOT_TOKEN")).toEqual([
			"CASS_BOT_TOKEN",
			"TADASHI_BOT_TOKEN",
			"RAFIKI_BOT_TOKEN",
		]);
	});

	it("buildRepairChain: Cass → alpha", () => {
		expect(buildRepairChain(projects, "CASS_BOT_TOKEN")).toEqual([
			"CASS_BOT_TOKEN",
			"TADASHI_BOT_TOKEN",
			"RAFIKI_BOT_TOKEN",
		]);
	});

	it("resolveFirstAvailableBotToken: first non-empty env wins", () => {
		const env = { B: "tok-b", C: "tok-c" } as NodeJS.ProcessEnv;
		expect(resolveFirstAvailableBotToken(["A", "B", "C"], env)).toEqual({
			tokenEnv: "B",
			token: "tok-b",
		});
		expect(resolveFirstAvailableBotToken(["A"], env)).toBeNull();
		expect(resolveFirstAvailableBotToken([], env)).toBeNull();
	});
});
