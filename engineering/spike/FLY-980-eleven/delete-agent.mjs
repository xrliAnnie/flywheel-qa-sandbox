// FLY-980 — delete the spike agent + its workspace secret (V10 cleanup
// discipline: agent/secret 用后即删).
// usage: node delete-agent.mjs <agent_id> [secret_id]
import { xi } from "./lib/eleven.mjs";

const [, , agentId, secretId] = process.argv;
if (!agentId) {
	console.error("usage: node delete-agent.mjs <agent_id> [secret_id]");
	process.exit(2);
}
await xi(`/v1/convai/agents/${agentId}`, { method: "DELETE" });
console.log(`deleted ${agentId}`);
if (secretId) {
	await xi(`/v1/convai/secrets/${secretId}`, { method: "DELETE" });
	console.log(`deleted secret ${secretId}`);
}
