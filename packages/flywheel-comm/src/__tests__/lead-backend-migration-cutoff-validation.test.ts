import { describe, expect, it } from "vitest";
import { parseMigrationCutoffs } from "../lead-backend-migration-cutoff.js";

const channelId = "123456789012345678";
const botUserId = "123456789012345679";
function artifact() {
	return {
		version: 1,
		migrationId: "FLY-2459-honey-lemon",
		botUserId,
		writerStoppedAt: "2026-09-11T00:00:00.000Z",
		channels: [
			{
				channelId,
				observedAt: "2026-09-11T00:00:01.000Z",
				cutoffId: "123456789012345690",
				lastBotReplyId: null,
				unresolvedMessageIds: ["123456789012345680", "123456789012345690"],
				unresolvedBefore: "123456789012345680",
			},
		],
	};
}
const identity = { botUserId, channelIds: [channelId] };
describe("migration cutoff recovery validation", () => {
	it("preserves unresolved IDs and the exclusive older-history boundary", () => {
		const value = artifact();
		expect(parseMigrationCutoffs(value, identity)).toEqual(value);
	});
	it("accepts explicitly empty channels", () => {
		const value = artifact();
		Object.assign(value.channels[0], {
			cutoffId: null,
			unresolvedBefore: null,
			unresolvedMessageIds: [],
		});
		expect(parseMigrationCutoffs(value, identity)).toEqual(value);
	});
	it.each([
		(value: ReturnType<typeof artifact>) => {
			value.channels[0].unresolvedMessageIds.push("123456789012345691");
		},
		(value: ReturnType<typeof artifact>) => {
			value.channels[0].unresolvedMessageIds.reverse();
		},
		(value: ReturnType<typeof artifact>) => {
			value.channels[0].observedAt = "2026-09-10T00:00:00.000Z";
		},
		(value: ReturnType<typeof artifact>) => {
			value.channels.push(value.channels[0]);
		},
		(value: ReturnType<typeof artifact>) => {
			Object.assign(value.channels[0], { botToken: "secret" });
		},
		(value: ReturnType<typeof artifact>) => {
			Object.assign(value.channels[0], {
				lastBotReplyId: "123456789012345685",
			});
		},
		(value: ReturnType<typeof artifact>) => {
			value.channels[0].unresolvedBefore = "123456789012345681";
		},
	])("rejects corrupt recovery evidence", (mutate) => {
		const value = artifact();
		mutate(value);
		expect(() => parseMigrationCutoffs(value, identity)).toThrow(/cutoff/);
	});
	it("rejects another bot or subscribed-channel set", () => {
		expect(() =>
			parseMigrationCutoffs(artifact(), { ...identity, botUserId: channelId }),
		).toThrow(/cutoff/);
		expect(() =>
			parseMigrationCutoffs(artifact(), {
				...identity,
				channelIds: [botUserId],
			}),
		).toThrow(/cutoff/);
	});
});
