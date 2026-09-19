import { escapeHtml } from "../bridge/xhs-review-html.js";

const DISCORD_WEB_LINK =
	/^https:\/\/discord\.com\/channels\/(@me|[1-9][0-9]{0,19})\/([1-9][0-9]{0,19})(?:\/([1-9][0-9]{0,19}))?$/;

export interface DiscordLinkPair {
	app: string;
	web: string;
}

function discordFallbackLabel(context: string): string {
	const key = [...(context.trim().split(/\s+/, 1)[0] || "Discord")]
		.slice(0, 32)
		.join("");
	return `${key} Discord 网页版`;
}

/** Convert an exact Discord web channel/thread/message URL to the app scheme. */
export function discordLinkPair(url: string): DiscordLinkPair | null {
	const match = DISCORD_WEB_LINK.exec(url);
	if (!match) return null;
	const [, guild, channel, message] = match;
	return {
		app: `discord://-/channels/${guild}/${channel}${message ? `/${message}` : ""}`,
		web: url,
	};
}

/** Build the canonical FLY-2639 app/web pair from exact guild and thread ids. */
export function discordThreadLinkPair(
	guildId: string,
	threadId: string,
): DiscordLinkPair | null {
	return discordLinkPair(`https://discord.com/channels/${guildId}/${threadId}`);
}

/** HTTPS is always usable; the hosted page may enhance the primary on desktop. */
export function renderDiscordLinkPair(
	url: string,
	label: string,
	primaryClass?: string,
	fallbackContext = label,
): string | null {
	const links = discordLinkPair(url);
	if (!links) return null;
	const className = primaryClass ? ` class="${escapeHtml(primaryClass)}"` : "";
	return `<span class="discord-links"><a${className} data-discord-app href="${escapeHtml(links.web)}">${escapeHtml(label)}</a><a data-discord-fallback href="${escapeHtml(links.web)}" rel="noreferrer" aria-label="${escapeHtml(discordFallbackLabel(fallbackContext))}">网页版</a></span>`;
}
