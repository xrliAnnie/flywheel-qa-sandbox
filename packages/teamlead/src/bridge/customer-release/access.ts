import { isDiscordId } from "./notice.js";

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("invalid permission evidence");
	return value as Record<string, unknown>;
}
function bits(value: unknown): bigint {
	if (typeof value !== "string" || !/^(0|[1-9]\d{0,19})$/.test(value))
		throw new Error("invalid permissions");
	const result = BigInt(value);
	if (result > (1n << 64n) - 1n) throw new Error("invalid permissions");
	return result;
}
function assert(value: unknown): asserts value {
	if (!value) throw new Error("invalid permission evidence");
}
/** Discord's everyone -> combined roles -> member overwrite precedence.
 * The release app uses a dedicated text/announcement channel; threads need
 * separate membership evidence and cannot satisfy this probe. */
export function canAccessReleaseChannel(
	input: {
		guild: unknown;
		channel: unknown;
		member: unknown;
		roles: unknown;
		userId: string;
		guildId: string;
		channelId: string;
		now: number;
	},
	send = false,
): boolean {
	try {
		assert(
			[input.userId, input.guildId, input.channelId].every(isDiscordId) &&
				Number.isSafeInteger(input.now) &&
				input.now >= 0,
		);
		const guild = object(input.guild),
			channel = object(input.channel),
			member = object(input.member);
		assert(
			guild.id === input.guildId &&
				isDiscordId(guild.owner_id) &&
				channel.id === input.channelId &&
				channel.guild_id === input.guildId &&
				[0, 5].includes(channel.type as number),
		);
		assert(
			object(member.user).id === input.userId &&
				member.pending !== true &&
				Array.isArray(member.roles) &&
				member.roles.every(isDiscordId),
		);
		if (
			member.communication_disabled_until !== undefined &&
			member.communication_disabled_until !== null
		) {
			assert(typeof member.communication_disabled_until === "string");
			const until = Date.parse(member.communication_disabled_until);
			assert(Number.isFinite(until) && until <= input.now);
		}
		assert(Array.isArray(input.roles) && input.roles.length <= 1000);
		const roles = new Map<string, bigint>();
		for (const value of input.roles) {
			const role = object(value);
			assert(isDiscordId(role.id) && !roles.has(role.id));
			roles.set(role.id, bits(role.permissions));
		}
		assert(roles.has(input.guildId));
		let permissions = roles.get(input.guildId)!;
		for (const roleId of member.roles) {
			assert(roles.has(roleId));
			permissions |= roles.get(roleId)!;
		}
		assert(
			Array.isArray(channel.permission_overwrites) &&
				channel.permission_overwrites.length <= 1000,
		);
		const overwrites = new Map<string, { allow: bigint; deny: bigint }>();
		for (const value of channel.permission_overwrites) {
			const entry = object(value);
			assert(isDiscordId(entry.id) && (entry.type === 0 || entry.type === 1));
			const key = `${entry.type}:${entry.id}`;
			assert(!overwrites.has(key));
			overwrites.set(key, { allow: bits(entry.allow), deny: bits(entry.deny) });
		}
		if (guild.owner_id === input.userId || (permissions & 8n) !== 0n)
			return true;
		const everyone = overwrites.get(`0:${input.guildId}`);
		if (everyone) permissions = (permissions & ~everyone.deny) | everyone.allow;
		let allow = 0n,
			deny = 0n;
		for (const roleId of member.roles) {
			if (roleId === input.guildId) continue;
			const rule = overwrites.get(`0:${roleId}`);
			if (rule) {
				allow |= rule.allow;
				deny |= rule.deny;
			}
		}
		permissions = (permissions & ~deny) | allow;
		const own = overwrites.get(`1:${input.userId}`);
		if (own) permissions = (permissions & ~own.deny) | own.allow;
		const required = (1n << 10n) | (1n << 16n) | (send ? 1n << 11n : 0n);
		return (permissions & required) === required;
	} catch {
		return false;
	}
}
