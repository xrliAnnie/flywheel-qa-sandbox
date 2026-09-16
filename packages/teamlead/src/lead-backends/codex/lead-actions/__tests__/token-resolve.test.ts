import { describe, expect, it } from "vitest";
import {
	isReservedRayaSummaryEventId,
	resolveLeadActionEventId,
	resolveLeadActionsApiToken,
	resolveLeadActionsBotToken,
} from "../lead-actions-main.js";

describe("resolveLeadActionsApiToken (FLY-2445)", () => {
	it("returns TEAMLEAD_API_TOKEN from the MCP child env", () => {
		const tok = resolveLeadActionsApiToken({ TEAMLEAD_API_TOKEN: "env-tok" });
		expect(tok).toBe("env-tok");
	});

	it("fails closed when TEAMLEAD_API_TOKEN is absent", () => {
		expect(() => resolveLeadActionsApiToken({})).toThrow(
			/TEAMLEAD_API_TOKEN is absent/,
		);
	});

	it("trims whitespace-only token to fail closed", () => {
		expect(() =>
			resolveLeadActionsApiToken({ TEAMLEAD_API_TOKEN: "   " }),
		).toThrow(/absent/);
	});
});

describe("resolveLeadActionsBotToken (FLY-2445 review)", () => {
	it("returns DISCORD_BOT_TOKEN for a direct-mode MCP child", () => {
		expect(
			resolveLeadActionsBotToken({ DISCORD_BOT_TOKEN: "discord-tok" }),
		).toBe("discord-tok");
	});

	it("fails closed when the direct credential is absent", () => {
		expect(() => resolveLeadActionsBotToken({})).toThrow(
			/DISCORD_BOT_TOKEN is absent/,
		);
	});
});

describe("resolveLeadActionEventId (FLY-2445)", () => {
	it("uses an explicit business event id without allocating a replacement", () => {
		let allocations = 0;
		const eventId = resolveLeadActionEventId(
			"summary:round-7:report",
			"chat",
			"ready",
			() => {
				allocations += 1;
				return "allocated";
			},
		);
		expect(eventId).toBe("summary:round-7:report");
		expect(allocations).toBe(0);
	});

	it("requires the trusted server allocator when the model omits eventId", () => {
		const seen: Array<[string, string]> = [];
		const eventId = resolveLeadActionEventId(
			undefined,
			"roundtable",
			"invite",
			(target, text) => {
				seen.push([target, text]);
				return "durable-event-id";
			},
		);
		expect(eventId).toBe("durable-event-id");
		expect(seen).toEqual([["roundtable", "invite"]]);
	});
});

describe("reserved Raya summary event ids (FLY-2619)", () => {
	it.each([
		"summary-absorption:2026-09-16T06:00:00.000Z:report",
		"lead-action:raya:raya:summary-absorption:2026-09-16T06:00:00.000Z:report",
		"summary-presentation:7a5a46a0-5385-45ab-b652-9d2d1b6a066e",
		"lead-action:raya:raya:summary-presentation:7a5a46a0-5385-45ab-b652-9d2d1b6a066e",
	])("rejects %s", (eventId) => {
		expect(isReservedRayaSummaryEventId(eventId)).toBe(true);
	});

	it("does not block ordinary conversation event ids", () => {
		expect(isReservedRayaSummaryEventId("founder-question:42")).toBe(false);
	});
});
