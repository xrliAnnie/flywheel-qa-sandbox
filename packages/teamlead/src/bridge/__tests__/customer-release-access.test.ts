import { expect, it } from "vitest";
import { canAccessReleaseChannel } from "../customer-release/access.js";

const guildId = "123456789012345678",
	userId = "223456789012345678",
	roleId = "323456789012345678";
const now = Date.parse("2026-09-15T15:00:00Z");
function input() {
	return {
		guild: { id: guildId, owner_id: "423456789012345678" },
		channel: {
			id: "523456789012345678",
			guild_id: guildId,
			type: 0,
			permission_overwrites: [] as object[],
		},
		member: { user: { id: userId }, roles: [roleId], pending: false },
		roles: [
			{ id: guildId, permissions: "0" },
			{ id: roleId, permissions: String((1 << 10) | (1 << 16)) },
		],
		userId,
		guildId,
		channelId: "523456789012345678",
		now,
	};
}
it("requires membership and effective VIEW_CHANNEL plus READ_MESSAGE_HISTORY", () => {
	expect(canAccessReleaseChannel(input())).toBe(true);
	for (const permission of [0, 1 << 10, 1 << 16]) {
		const f = input();
		f.roles[1]!.permissions = String(permission);
		expect(canAccessReleaseChannel(f)).toBe(false);
	}
	const f = input();
	f.member.user.id = guildId;
	expect(canAccessReleaseChannel(f)).toBe(false);
});
it("applies everyone, aggregate roles, then member overwrites in Discord order", () => {
	const f = input();
	f.channel.permission_overwrites = [
		{ id: guildId, type: 0, allow: "0", deny: String(1 << 10) },
		{ id: roleId, type: 0, allow: String(1 << 10), deny: "0" },
	];
	expect(canAccessReleaseChannel(f)).toBe(true);
	f.channel.permission_overwrites.push({
		id: userId,
		type: 1,
		allow: "0",
		deny: String(1 << 16),
	});
	expect(canAccessReleaseChannel(f)).toBe(false);
	f.channel.permission_overwrites[2] = {
		id: userId,
		type: 1,
		allow: String(1 << 16),
		deny: "0",
	};
	expect(canAccessReleaseChannel(f)).toBe(true);
});
it("guild owner and administrator bypass channel overwrites", () => {
	for (const kind of ["owner", "admin"]) {
		const f = input();
		f.channel.permission_overwrites = [
			{ id: userId, type: 1, deny: String((1 << 10) | (1 << 16)), allow: "0" },
		];
		if (kind === "owner") f.guild.owner_id = userId;
		else f.roles[1]!.permissions = "8";
		expect(canAccessReleaseChannel(f)).toBe(true);
	}
});
it("bot sending additionally requires SEND_MESSAGES", () => {
	const f = input();
	expect(canAccessReleaseChannel(f, true)).toBe(false);
	f.roles[1]!.permissions = String((1 << 10) | (1 << 16) | (1 << 11));
	expect(canAccessReleaseChannel(f, true)).toBe(true);
});
it("missing role, duplicate overwrite, malformed permission, wrong guild and unsupported thread fail closed", () => {
	const cases = [
		(f: ReturnType<typeof input>) => {
			f.roles.pop();
		},
		(f: ReturnType<typeof input>) => {
			f.roles[1]!.permissions = "-1";
		},
		(f: ReturnType<typeof input>) => {
			f.channel.guild_id = userId;
		},
		(f: ReturnType<typeof input>) => {
			f.channel.type = 12;
		},
		(f: ReturnType<typeof input>) => {
			const o = { id: userId, type: 1, allow: "0", deny: "0" };
			f.channel.permission_overwrites = [o, o];
		},
	];
	for (const change of cases) {
		const f = input();
		change(f);
		expect(canAccessReleaseChannel(f)).toBe(false);
	}
});
it("pending membership or timed-out founder cannot satisfy the actionable-card probe", () => {
	const f = input();
	f.member.pending = true;
	expect(canAccessReleaseChannel(f)).toBe(false);
	const g = input();
	expect(
		canAccessReleaseChannel({
			...g,
			member: {
				...g.member,
				communication_disabled_until: new Date(now + 60000).toISOString(),
			},
		}),
	).toBe(false);
});
