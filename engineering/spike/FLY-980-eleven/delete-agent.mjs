// FLY-980 — delete the spike agent + its workspace secret (V10 cleanup
// discipline: agent/secret 用后即删).
// usage: node delete-agent.mjs <agent_id> [secret_id]
import { xi } from "./lib/eleven.mjs";

// agent_id 传 "-" 可跳过 agent 只删 secret(create 失败路径的手工回收)。
// agent 删除失败不挡 secret 清理 —— 两步各自 best-effort,任一失败退非零。
const [, , agentId, secretId] = process.argv;
if (!agentId) {
	console.error("usage: node delete-agent.mjs <agent_id|-> [secret_id]");
	process.exit(2);
}
let failed = false;
if (agentId !== "-") {
	try {
		await xi(`/v1/convai/agents/${agentId}`, { method: "DELETE" });
		console.log(`deleted ${agentId}`);
	} catch (err) {
		failed = true;
		console.error(
			`agent delete failed: ${String(err?.message ?? err).slice(0, 160)}`,
		);
	}
}
if (secretId) {
	try {
		await xi(`/v1/convai/secrets/${secretId}`, { method: "DELETE" });
		console.log(`deleted secret ${secretId}`);
	} catch (err) {
		failed = true;
		console.error(
			`secret delete failed: ${String(err?.message ?? err).slice(0, 160)}`,
		);
	}
}
if (failed) process.exit(1);
