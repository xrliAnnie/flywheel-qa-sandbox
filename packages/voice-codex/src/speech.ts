export function stripForSpeech(value: string): string {
	return value
		.replace(/^```[^\n]*\n?/gmu, "")
		.replace(/^```$/gmu, "")
		.replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
		.replace(/[*_~`]+/gu, "")
		.replace(/^\s{0,3}(?:#{1,6}|[-+>])\s+/gmu, "")
		.trim();
}

export function chunkForSpeech(value: string, maxTokens = 600): string[] {
	if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
		throw new Error("speechChunkTokens must be a positive integer");
	}
	const chars = Array.from(stripForSpeech(value));
	const chunks: string[] = [];
	for (let index = 0; index < chars.length; index += maxTokens) {
		chunks.push(chars.slice(index, index + maxTokens).join(""));
	}
	return chunks;
}
