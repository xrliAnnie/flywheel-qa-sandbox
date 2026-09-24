import { createHash } from "node:crypto";
import type { SpeakKind, SpeakVerification } from "../types.js";

export function speakRequestDigest(input: {
	sessionId: string;
	generation: number;
	text: string;
	kind: SpeakKind;
	verification: SpeakVerification;
}): string {
	return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
