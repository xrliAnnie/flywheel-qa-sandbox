import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, migrateDatabase } from "flywheel-v2-kernel";
import { initializeEngineDb } from "../bootstrap.js";
import { enqueue, provisionAgentRecipient } from "../enqueue.js";
import type {
	EngineRuntime,
	RegisteredAgent,
	SessionBinding,
} from "../types.js";

export class TestClock {
	#nowMs: number;

	constructor(now = "2026-07-28T00:00:00.000Z") {
		this.#nowMs = Date.parse(now);
	}

	nowMs(): number {
		return this.#nowMs;
	}

	nowIso(): string {
		return new Date(this.#nowMs).toISOString();
	}

	advance(ms: number): void {
		this.#nowMs += ms;
	}
}

export function testSessionBinding(
	identity = "instance-1",
	pid = 10_001,
): SessionBinding {
	return {
		v: 1,
		hostEpoch: "test-host-epoch",
		sessionId: `session-${identity}`,
		pid,
		pidStart: `test-start-${identity}`,
	};
}

export interface EngineFixture {
	dir: string;
	path: string;
	kernel: Kernel;
	clock: TestClock;
	runtime: EngineRuntime;
	cleanup(): void;
}

export function makeEngineFixture(busyTimeoutMs?: number): EngineFixture {
	const dir = mkdtempSync(join(tmpdir(), "flywheel-v2-engine-"));
	const path = join(dir, "flywheel-v2.db");
	migrateDatabase({ path });
	const kernel = Kernel.open({ path, busyTimeoutMs });
	initializeEngineDb(kernel);
	const clock = new TestClock();
	return {
		dir,
		path,
		kernel,
		clock,
		runtime: { clock },
		cleanup: () => {
			kernel.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

export function enqueueMailbox(
	fixture: EngineFixture,
	args: {
		uid: string;
		agent: string;
		agentKind?: "lead" | "runner";
		sourceKind?: string;
		kind?: string;
		payload?: string;
		retentionClass?: "notice" | "business" | "dlq";
	},
): string {
	if (args.agentKind !== "runner") {
		provisionAgentRecipient(fixture.kernel, args.agent, "lead");
	}
	const result = enqueue(fixture.kernel, fixture.runtime, {
		sourceKind: args.sourceKind ?? "lead",
		sourceId: `source-${args.uid}`,
		payload: args.payload ?? "{}",
		toAgent: args.agent,
		kind: args.kind ?? "instruction",
		retentionClass: args.retentionClass ?? "business",
		expectedCutoverEpoch: 1,
	});
	if (result.status !== "enqueued") {
		throw new Error(`expected enqueued, got ${JSON.stringify(result)}`);
	}
	fixture.kernel.write("test.rename-message", (tx) => {
		tx.run(
			"UPDATE mailbox SET message_uid=@uid WHERE message_uid=@messageUid",
			{ uid: args.uid, messageUid: result.messageUid },
		);
	});
	return args.uid;
}

export function seedSessionRunner(
	fixture: EngineFixture,
	generation = 1,
): {
	agent: Extract<RegisteredAgent, { kind: "runner" }>;
	taskId: string;
	attemptId: string;
} {
	const taskId = `task-session-${generation}`;
	const attemptId = `attempt-session-${generation}`;
	const activationId = `activation-session-${generation}`;
	const sessionRef = `v2dag:11111111-1111-4111-8111-111111111111:${generation}:22222222-2222-4222-8222-222222222222`;
	fixture.kernel.write("test.seed-session-runner", (tx) => {
		tx.run(
			`INSERT INTO tasks
			 (id,project_id,kind,state,lineage_root_id,created_at)
			 VALUES (@taskId,'project-a','build','running',@taskId,@now)`,
			{ taskId, now: fixture.clock.nowIso() },
		);
		tx.run(
			`INSERT INTO attempts
			 (id,task_id,generation,desired_state,started_at)
			 VALUES (@attemptId,@taskId,@generation,'started',@now)`,
			{ attemptId, taskId, generation, now: fixture.clock.nowIso() },
		);
		tx.run(
			`INSERT INTO activations(id,attempt_id,session_ref,generation,state)
			 VALUES (@activationId,@attemptId,@sessionRef,@generation,'active')`,
			{ activationId, attemptId, sessionRef, generation },
		);
	});
	return {
		taskId,
		attemptId,
		agent: {
			kind: "runner",
			agentId: sessionRef,
			instanceId: sessionRef,
			generation,
			activationId,
		},
	};
}
