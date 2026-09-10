export const DISCORD_PERMISSIONS = {
	ADMINISTRATOR: 1n << 3n,
	VIEW_CHANNEL: 1n << 10n,
	SEND_MESSAGES: 1n << 11n,
	READ_MESSAGE_HISTORY: 1n << 16n,
	CONNECT: 1n << 20n,
	SPEAK: 1n << 21n,
	CREATE_PUBLIC_THREADS: 1n << 35n,
	SEND_MESSAGES_IN_THREADS: 1n << 38n,
} as const;

export interface DiscordPermissionRole {
	id: string;
	permissions: string;
}

export interface DiscordPermissionOverwrite {
	id: string;
	type: 0 | 1;
	allow: string;
	deny: string;
}

function bitfield(value: string): bigint {
	if (!/^[0-9]+$/.test(value))
		throw new Error("invalid Discord permission bitfield");
	return BigInt(value);
}

export function computeChannelPermissions(input: {
	guildId: string;
	memberId: string;
	memberRoleIds: string[];
	roles: DiscordPermissionRole[];
	overwrites: DiscordPermissionOverwrite[];
}): bigint {
	const everyone = input.roles.find(({ id }) => id === input.guildId);
	if (!everyone) throw new Error("Discord @everyone role is missing");
	let permissions = bitfield(everyone.permissions);
	for (const role of input.roles) {
		if (input.memberRoleIds.includes(role.id)) {
			permissions |= bitfield(role.permissions);
		}
	}
	if ((permissions & DISCORD_PERMISSIONS.ADMINISTRATOR) !== 0n) {
		return (1n << 63n) - 1n;
	}

	const apply = (overwrite: DiscordPermissionOverwrite | undefined) => {
		if (!overwrite) return;
		permissions &= ~bitfield(overwrite.deny);
		permissions |= bitfield(overwrite.allow);
	};
	apply(
		input.overwrites.find(({ id, type }) => type === 0 && id === input.guildId),
	);

	let roleAllow = 0n;
	let roleDeny = 0n;
	for (const overwrite of input.overwrites) {
		if (overwrite.type === 0 && input.memberRoleIds.includes(overwrite.id)) {
			roleAllow |= bitfield(overwrite.allow);
			roleDeny |= bitfield(overwrite.deny);
		}
	}
	permissions &= ~roleDeny;
	permissions |= roleAllow;
	apply(
		input.overwrites.find(
			({ id, type }) => type === 1 && id === input.memberId,
		),
	);
	return permissions;
}
