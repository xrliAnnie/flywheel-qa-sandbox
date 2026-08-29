/**
 * FLY-1018 M2 — result → Discord message chunks (plan §3).
 * Discord caps a message at 2000 chars; we split on line boundaries where
 * possible so code blocks / lists stay readable.
 */

export const DISCORD_MESSAGE_MAX = 2000;

export function chunkMessage(
	text: string,
	max = DISCORD_MESSAGE_MAX,
): string[] {
	if (text.length === 0) return [];
	if (text.length <= max) return [text];

	const chunks: string[] = [];
	let rest = text;
	while (rest.length > max) {
		// prefer the last newline inside the window; fall back to a hard cut
		let cut = rest.lastIndexOf("\n", max);
		if (cut <= 0) cut = max;
		chunks.push(rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^\n/, "");
	}
	if (rest.length > 0) chunks.push(rest);
	return chunks;
}
