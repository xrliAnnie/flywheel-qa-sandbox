import { describe, expect, it } from "vitest";
import {
	computeChannelPermissions,
	DISCORD_PERMISSIONS,
} from "../channel-permissions.js";

const GUILD = "100000000000000000";
const MEMBER = "200000000000000000";
const ROLE = "300000000000000000";

function bits(...values: bigint[]): string {
	return values.reduce((sum, value) => sum | value, 0n).toString();
}

describe("computeChannelPermissions", () => {
	it("applies everyone, aggregate role, then member overwrites", () => {
		const permissions = computeChannelPermissions({
			guildId: GUILD,
			memberId: MEMBER,
			memberRoleIds: [ROLE],
			roles: [
				{ id: GUILD, permissions: bits(DISCORD_PERMISSIONS.VIEW_CHANNEL) },
				{ id: ROLE, permissions: bits(DISCORD_PERMISSIONS.CONNECT) },
			],
			overwrites: [
				{
					id: GUILD,
					type: 0,
					deny: bits(DISCORD_PERMISSIONS.VIEW_CHANNEL),
					allow: "0",
				},
				{
					id: ROLE,
					type: 0,
					deny: bits(DISCORD_PERMISSIONS.CONNECT),
					allow: bits(DISCORD_PERMISSIONS.SPEAK),
				},
				{
					id: MEMBER,
					type: 1,
					deny: bits(DISCORD_PERMISSIONS.SPEAK),
					allow: bits(DISCORD_PERMISSIONS.VIEW_CHANNEL),
				},
			],
		});
		expect(permissions & DISCORD_PERMISSIONS.VIEW_CHANNEL).not.toBe(0n);
		expect(permissions & DISCORD_PERMISSIONS.CONNECT).toBe(0n);
		expect(permissions & DISCORD_PERMISSIONS.SPEAK).toBe(0n);
	});

	it("aggregates role denies and allows before applying them", () => {
		const extraRole = "400000000000000000";
		const permissions = computeChannelPermissions({
			guildId: GUILD,
			memberId: MEMBER,
			memberRoleIds: [ROLE, extraRole],
			roles: [
				{ id: GUILD, permissions: "0" },
				{ id: ROLE, permissions: "0" },
				{ id: extraRole, permissions: "0" },
			],
			overwrites: [
				{
					id: ROLE,
					type: 0,
					deny: bits(DISCORD_PERMISSIONS.SEND_MESSAGES),
					allow: "0",
				},
				{
					id: extraRole,
					type: 0,
					deny: "0",
					allow: bits(DISCORD_PERMISSIONS.SEND_MESSAGES),
				},
			],
		});
		expect(permissions & DISCORD_PERMISSIONS.SEND_MESSAGES).not.toBe(0n);
	});

	it("lets administrator bypass channel overwrites and fails without @everyone", () => {
		const input = {
			guildId: GUILD,
			memberId: MEMBER,
			memberRoleIds: [] as string[],
			roles: [
				{ id: GUILD, permissions: bits(DISCORD_PERMISSIONS.ADMINISTRATOR) },
			],
			overwrites: [
				{
					id: GUILD,
					type: 0 as const,
					deny: bits(DISCORD_PERMISSIONS.CONNECT),
					allow: "0",
				},
			],
		};
		expect(
			computeChannelPermissions(input) & DISCORD_PERMISSIONS.CONNECT,
		).not.toBe(0n);
		expect(() => computeChannelPermissions({ ...input, roles: [] })).toThrow(
			/everyone/,
		);
	});
});
