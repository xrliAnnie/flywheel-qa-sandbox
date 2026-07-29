import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempDatabase {
	dir: string;
	path: string;
	cleanup(): void;
}

export function makeTempDatabase(name = "flywheel-v2.db"): TempDatabase {
	const dir = mkdtempSync(join(tmpdir(), "flywheel-v2-kernel-"));
	const temp = {
		dir,
		path: join(dir, name),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
	return temp;
}

export const INSERT_BOUND_AGENT_SQL = `INSERT INTO agents
	(agent_id,kind,generation,instance_id,session_binding,last_poll_at,state)
	VALUES (@agentId,@kind,@generation,@instanceId,@sessionBinding,NULL,@state)`;

export function boundAgentParams(options: {
	agentId: string;
	kind: "lead" | "runner";
	generation?: number;
	instanceId?: string;
	state?: "online" | "offline";
	pid?: number;
}): Record<string, unknown> {
	const generation = options.generation ?? 1;
	const instanceId = options.instanceId ?? "session-a";
	const pid = options.pid ?? 4242;
	return {
		agentId: options.agentId,
		kind: options.kind,
		generation,
		instanceId,
		sessionBinding: JSON.stringify({
			v: 1,
			host_epoch: "test-host-epoch",
			session_id: instanceId,
			pid,
			pid_start: `test-pid-start-${pid}`,
		}),
		state: options.state ?? "online",
	};
}
