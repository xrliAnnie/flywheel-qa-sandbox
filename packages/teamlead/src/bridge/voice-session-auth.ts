import type { RequestHandler } from "express";
import { safeCompare } from "./auth-compare.js";

export type VoiceCredentialTier = "master" | "ingest";

export function voiceSessionAuthMiddleware(
	masterToken?: string,
	ingestToken?: string,
): RequestHandler {
	return (req, res, next) => {
		if (!masterToken) {
			res
				.status(503)
				.json({ error: "voice_unavailable", reason: "master_token_unset" });
			return;
		}
		const header = req.headers.authorization ?? "";
		if (safeCompare(header, `Bearer ${masterToken}`)) {
			res.locals.voiceCredentialTier = "master" satisfies VoiceCredentialTier;
			next();
			return;
		}
		if (ingestToken && safeCompare(header, `Bearer ${ingestToken}`)) {
			res.locals.voiceCredentialTier = "ingest" satisfies VoiceCredentialTier;
			next();
			return;
		}
		res.status(401).json({ error: "unauthorized" });
	};
}
