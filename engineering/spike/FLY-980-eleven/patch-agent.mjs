// FLY-980 — generic agent PATCH + readback (turn_timeout / soft-timeout /
// security bits experiments, V5a/V5b). The readback is the evidence of what
// the platform actually accepted.
// usage: node patch-agent.mjs <agent_id> '<json>'
//   e.g. node patch-agent.mjs abc '{"conversation_config":{"turn":{"turn_timeout":15}}}'
import { redactAgentConfig, xi } from "./lib/eleven.mjs";

const [, , agentId, patchJson] = process.argv;
if (!agentId || !patchJson) {
	console.error("usage: node patch-agent.mjs <agent_id> '<json>'");
	process.exit(2);
}
const body = JSON.parse(patchJson);
await xi(`/v1/convai/agents/${agentId}`, { method: "PATCH", body });
const readback = await xi(`/v1/convai/agents/${agentId}`);
console.log(JSON.stringify(redactAgentConfig(readback), null, 2));
