// FLY-980 S3 — create the spike agent (custom LLM → our shim through the
// tunnel), then GET it back and print a REDACTED config snapshot (fail-closed
// shape discovery, Codex R1#6: the accepted shape is what the readback shows,
// not what docs suggest).
//
// usage: node create-agent.mjs <tunnel-url> <bearer-token> [name]
// env: ELEVENLABS_API_KEY (~/.flywheel/.env), FLY980_VOICE_ID (optional)
import { mkdirSync, writeFileSync } from "node:fs";
import { redactAgentConfig, xi } from "./lib/eleven.mjs";

const [, , tunnelUrl, bearerToken, name = "fly980-eleven-spike"] = process.argv;
if (!tunnelUrl || !bearerToken) {
	console.error("usage: node create-agent.mjs <tunnel-url> <bearer-token>");
	process.exit(2);
}

const BASE_PROMPT = [
	"你是 Flywheel 的语音助手。用简短口语化的中文回答；",
	"如果对方说英文就用英文答。不要输出 markdown。",
].join("");

const body = {
	name,
	conversation_config: {
		agent: {
			language: "zh",
			first_message: "",
			prompt: {
				prompt: BASE_PROMPT,
				llm: "custom-llm",
				custom_llm: {
					url: `${tunnelUrl.replace(/\/$/, "")}/v1`,
					model_id: "flywheel-claude-brain",
					api_type: "chat_completions",
					request_headers: { Authorization: `Bearer ${bearerToken}` },
				},
			},
		},
		tts: {
			model_id: "eleven_flash_v2_5",
			...(process.env.FLY980_VOICE_ID
				? { voice_id: process.env.FLY980_VOICE_ID }
				: {}),
		},
		turn: { turn_timeout: 7, turn_model: "turn_v3" },
	},
	platform_settings: {
		overrides: {
			conversation_config_override: {
				agent: {
					prompt: { prompt: true },
					language: true,
					first_message: true,
				},
				tts: { voice_id: true },
			},
		},
	},
};

let created;
try {
	created = await xi("/v1/convai/agents/create", { method: "POST", body });
} catch (err) {
	console.error("create failed (recording exact rejection for evidence):");
	console.error(String(err.message));
	process.exit(1);
}
const agentId = created.agent_id;
console.log(`agent_id=${agentId}`);

// fail-closed: read back what the platform actually accepted
const readback = await xi(`/v1/convai/agents/${agentId}`);
mkdirSync("out", { recursive: true });
const snapshot = redactAgentConfig(readback);
writeFileSync("out/agent-readback.json", JSON.stringify(snapshot, null, 2));
const overrides =
	readback?.platform_settings?.overrides?.conversation_config_override;
console.log("accepted custom_llm shape (redacted):");
console.log(
	JSON.stringify(
		snapshot?.conversation_config?.agent?.prompt?.custom_llm,
		null,
		2,
	),
);
console.log(
	`override enablement (readback): ${JSON.stringify(overrides ?? null)}`,
);
if (!overrides?.tts?.voice_id || !overrides?.agent?.prompt?.prompt) {
	console.error(
		"⚠️ override security bits NOT confirmed enabled — V8 must not run until enabled (dashboard fallback, record in runbook).",
	);
}
console.log("full redacted readback → out/agent-readback.json");
