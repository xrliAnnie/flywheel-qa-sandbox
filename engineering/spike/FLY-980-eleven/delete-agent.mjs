// FLY-980 — delete the spike agent (V10 cleanup discipline: agent 用后即删).
// usage: node delete-agent.mjs <agent_id>
import { xi } from "./lib/eleven.mjs";

const [, , agentId] = process.argv;
if (!agentId) {
	console.error("usage: node delete-agent.mjs <agent_id>");
	process.exit(2);
}
await xi(`/v1/convai/agents/${agentId}`, { method: "DELETE" });
console.log(`deleted ${agentId}`);
