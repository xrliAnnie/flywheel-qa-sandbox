import { getEncoding } from "js-tiktoken";

let encoder: ReturnType<typeof getEncoding> | undefined;

/**
 * FLY-2885 plan §12.2: the container's own o200k count of a context item —
 * the same js-tiktoken 1.0.21 the Bridge used to build it (see
 * VOICE_CONTEXT_TOKENIZER). The rank table ships inside the package; nothing
 * is fetched. Throws when the encoder cannot load or encode.
 */
export function countVoiceContextTokens(value: string): number {
	encoder ??= getEncoding("o200k_base");
	return encoder.encode(value).length;
}
