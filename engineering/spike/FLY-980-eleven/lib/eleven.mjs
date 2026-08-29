// FLY-980 — ElevenLabs API helper. Key comes from ~/.flywheel/.env
// (ELEVENLABS_API_KEY), never argv / never logged.
import { loadFlywheelEnv } from "./env.mjs";

export const API_BASE = "https://api.elevenlabs.io";

export function requireApiKey() {
	loadFlywheelEnv();
	const key = process.env.ELEVENLABS_API_KEY;
	if (!key) {
		console.error(
			"ELEVENLABS_API_KEY missing — put it in ~/.flywheel/.env (0600).",
		);
		process.exit(2);
	}
	return key;
}

export async function xi(path, { method = "GET", body, key } = {}) {
	const res = await fetch(`${API_BASE}${path}`, {
		method,
		headers: {
			"xi-api-key": key ?? requireApiKey(),
			...(body ? { "content-type": "application/json" } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = { raw: text };
	}
	if (!res.ok) {
		const err = new Error(
			`${method} ${path} → ${res.status}: ${text.slice(0, 400)}`,
		);
		err.status = res.status;
		err.body = json;
		throw err;
	}
	return json;
}

/** strip secrets from an agent config snapshot before it goes to evidence. */
export function redactAgentConfig(cfg) {
	const clone = JSON.parse(JSON.stringify(cfg));
	const llm = clone?.conversation_config?.agent?.prompt?.custom_llm;
	if (llm) {
		if (llm.request_headers) {
			for (const k of Object.keys(llm.request_headers)) {
				llm.request_headers[k] = "<redacted>";
			}
		}
		if (llm.api_key) llm.api_key = "<redacted>";
		if (llm.url) llm.url = "<tunnel-url-redacted>";
	}
	return clone;
}
