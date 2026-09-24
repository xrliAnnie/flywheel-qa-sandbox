import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import {
	type DurableTranscriptEntry,
	durableTranscriptContentDigest,
	type VoiceHandoffRequest,
} from "flywheel-voice-core";

const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;

function isContained(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return (
		path !== "" && path !== ".." && !path.startsWith("../") && !isAbsolute(path)
	);
}

function durableEntry(value: unknown): value is DurableTranscriptEntry & {
	durability: {
		version: 1;
		durable: true;
		sessionId: string;
		transcriptId: string;
		contentDigest: string;
		persistedAt: string;
	};
} {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const row = value as Record<string, unknown>;
	const attribution = row.attribution as Record<string, unknown> | undefined;
	const durability = row.durability as Record<string, unknown> | undefined;
	return (
		typeof row.sessionId === "string" &&
		typeof row.transcriptId === "string" &&
		typeof row.utteranceId === "string" &&
		Number.isSafeInteger(row.generation) &&
		typeof row.text === "string" &&
		row.role === "user" &&
		row.final === true &&
		attribution?.kind === "known" &&
		typeof attribution.speakerUserId === "string" &&
		durability?.version === 1 &&
		durability.durable === true &&
		typeof durability.contentDigest === "string"
	);
}

export async function verifyVoiceHandoffTranscript(input: {
	voiceRoot: string;
	founderUserId: string;
	request: VoiceHandoffRequest;
}): Promise<boolean> {
	if (!/^[A-Za-z0-9._:-]+$/u.test(input.request.sessionId)) return false;
	const root = await realpath(input.voiceRoot).catch(() => undefined);
	if (!root) return false;
	const requested = join(
		root,
		"sessions",
		input.request.sessionId,
		"transcript.jsonl",
	);
	const file = await realpath(requested).catch(() => undefined);
	if (!file || !isContained(root, file)) return false;
	const info = await stat(file).catch(() => undefined);
	if (!info?.isFile() || info.size > MAX_TRANSCRIPT_BYTES) return false;
	const content = await readFile(file, "utf8").catch(() => undefined);
	if (content === undefined || (content && !content.endsWith("\n")))
		return false;
	for (const line of content.split("\n")) {
		if (!line) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			return false;
		}
		if (!durableEntry(value)) continue;
		if (
			value.sessionId !== input.request.sessionId ||
			value.transcriptId !== input.request.transcriptId
		)
			continue;
		const digest = durableTranscriptContentDigest(value);
		return (
			value.generation === input.request.generation &&
			value.utteranceId === input.request.utteranceId &&
			value.text === input.request.originalText &&
			value.attribution.kind === "known" &&
			value.attribution.speakerUserId === input.founderUserId &&
			value.durability.sessionId === input.request.sessionId &&
			value.durability.transcriptId === input.request.transcriptId &&
			value.durability.contentDigest === digest &&
			input.request.transcriptDurabilityReceipt.durable === true &&
			input.request.transcriptDurabilityReceipt.contentDigest === digest &&
			input.request.authorityBinding.transcriptDigest === digest
		);
	}
	return false;
}
