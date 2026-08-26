const token = process.env.DISCORD_PROBE_TOKEN?.trim();
const channelId = process.env.FLYWHEEL_NOTIFY_CHANNEL?.trim();

if (!token || !channelId) {
	throw new Error(
		"DISCORD_PROBE_TOKEN and FLYWHEEL_NOTIFY_CHANNEL are required",
	);
}

const headers = { Authorization: `Bot ${token}` };
async function get(path) {
	const response = await fetch(`https://discord.com/api/v10${path}`, { headers });
	if (!response.ok) throw new Error(`${path} HTTP ${response.status}`);
	return response.json();
}

const channel = await get(`/channels/${channelId}`);
const me = await get("/users/@me");
const member = await get(`/guilds/${channel.guild_id}/members/${me.id}`);
const roles = await get(`/guilds/${channel.guild_id}/roles`);
const roleById = new Map(roles.map((role) => [role.id, role]));

let permissions = BigInt(roleById.get(channel.guild_id)?.permissions ?? "0");
for (const roleId of member.roles) {
	permissions |= BigInt(roleById.get(roleId)?.permissions ?? "0");
}

const ADMINISTRATOR = 1n << 3n;
if ((permissions & ADMINISTRATOR) !== 0n) {
	permissions = (1n << 63n) - 1n;
} else {
	const overwrites = channel.permission_overwrites ?? [];
	const apply = (overwrite) => {
		permissions &= ~BigInt(overwrite.deny);
		permissions |= BigInt(overwrite.allow);
	};
	const everyone = overwrites.find(
		(overwrite) =>
			overwrite.type === 0 && overwrite.id === channel.guild_id,
	);
	if (everyone) apply(everyone);

	let roleAllow = 0n;
	let roleDeny = 0n;
	for (const overwrite of overwrites) {
		if (overwrite.type === 0 && member.roles.includes(overwrite.id)) {
			roleAllow |= BigInt(overwrite.allow);
			roleDeny |= BigInt(overwrite.deny);
		}
	}
	permissions &= ~roleDeny;
	permissions |= roleAllow;

	const memberOverwrite = overwrites.find(
		(overwrite) => overwrite.type === 1 && overwrite.id === me.id,
	);
	if (memberOverwrite) apply(memberOverwrite);
}

const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;
const EMBED_LINKS = 1n << 14n;
const READ_MESSAGE_HISTORY = 1n << 16n;
const MANAGE_THREADS = 1n << 34n;
const CREATE_PUBLIC_THREADS = 1n << 35n;
const SEND_MESSAGES_IN_THREADS = 1n << 38n;
console.log(
	JSON.stringify({
		checkedAt: new Date().toISOString(),
		botId: me.id,
		guildId: channel.guild_id,
		channelId,
		channelName: channel.name,
		effectivePermissions: permissions.toString(),
		viewChannelBit: VIEW_CHANNEL.toString(),
		sendMessagesBit: SEND_MESSAGES.toString(),
		embedLinksBit: EMBED_LINKS.toString(),
		readMessageHistoryBit: READ_MESSAGE_HISTORY.toString(),
		manageThreadsBit: MANAGE_THREADS.toString(),
		createPublicThreadsBit: CREATE_PUBLIC_THREADS.toString(),
		sendMessagesInThreadsBit: SEND_MESSAGES_IN_THREADS.toString(),
		canViewChannel: (permissions & VIEW_CHANNEL) !== 0n,
		canSendMessages: (permissions & SEND_MESSAGES) !== 0n,
		canEmbedLinks: (permissions & EMBED_LINKS) !== 0n,
		canReadMessageHistory: (permissions & READ_MESSAGE_HISTORY) !== 0n,
		canManageThreads: (permissions & MANAGE_THREADS) !== 0n,
		canCreatePublicThreads: (permissions & CREATE_PUBLIC_THREADS) !== 0n,
		canSendMessagesInThreads:
			(permissions & SEND_MESSAGES_IN_THREADS) !== 0n,
	}),
);
