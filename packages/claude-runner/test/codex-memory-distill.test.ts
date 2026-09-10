import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	readDistillCandidates,
	readDistillObservation,
	runMemoryDistillation,
	writeDistillReceipt,
} from "../src/codex-memory-distill.js";

const NOW = Date.parse("2026-09-09T08:00:00Z");
const HOUR = 3_600_000;
const homes: string[] = [];
function fixture() {
	const home = mkdtempSync(join(tmpdir(), "fly2460-"));
	homes.push(home);
	const state = new Database(join(home, "state_5.sqlite"));
	state.exec(
		`CREATE TABLE threads (id TEXT PRIMARY KEY, source TEXT, memory_mode TEXT, updated_at_ms INTEGER, archived INTEGER, preview TEXT, rollout_path TEXT, tokens_used INTEGER)`,
	);
	const memories = new Database(join(home, "memories_1.sqlite"));
	memories.exec(`CREATE TABLE jobs(kind TEXT, job_key TEXT, status TEXT, worker_id TEXT, input_watermark INTEGER, last_success_watermark INTEGER, last_error TEXT);
 CREATE TABLE stage1_outputs(thread_id TEXT PRIMARY KEY, source_updated_at INTEGER, raw_memory TEXT, rollout_summary TEXT, selected_for_phase2 INTEGER, selected_for_phase2_source_updated_at INTEGER);`);
	function thread(id: string, changes: Record<string, unknown> = {}) {
		const row = {
			id,
			source: "vscode",
			memory_mode: "enabled",
			updated_at_ms: NOW - 2 * HOUR,
			archived: 0,
			preview: "real task",
			rollout_path: join(home, "rollout.jsonl"),
			tokens_used: 42,
			...changes,
		};
		state
			.prepare(
				"INSERT INTO threads VALUES (@id,@source,@memory_mode,@updated_at_ms,@archived,@preview,@rollout_path,@tokens_used)",
			)
			.run(row);
	}
	writeFileSync(join(home, "rollout.jsonl"), "test rollout\n");
	return {
		home,
		state,
		memories,
		thread,
		close() {
			state.close();
			memories.close();
		},
	};
}
afterEach(() => {
	for (const home of homes.splice(0))
		rmSync(home, { recursive: true, force: true });
});

describe("distillation conservative candidate upper bound", () => {
	it.each(["cli", "vscode", "atlas", "chatgpt"])(
		"selects %s and excludes current outputs or success watermarks",
		(source) => {
			const f = fixture();
			try {
				f.thread(source, { source });
				f.thread("exec", { source: "exec" });
				f.thread("fresh", { updated_at_ms: NOW - HOUR + 1 });
				f.thread("old", { updated_at_ms: NOW - 240 * HOUR - 1 });
				f.thread("archived", { archived: 1 });
				f.thread("blank", { preview: "" });
				f.thread("disabled", { memory_mode: "disabled" });
				f.thread("output");
				f.thread("success");
				f.memories
					.prepare(
						"INSERT INTO stage1_outputs(thread_id,source_updated_at) VALUES (?,?)",
					)
					.run("output", (NOW - 2 * HOUR) / 1000);
				f.memories
					.prepare(
						"INSERT INTO jobs(kind,job_key,last_success_watermark) VALUES ('memory_stage1',?,?)",
					)
					.run("success", (NOW - 2 * HOUR) / 1000);
				const result = readDistillCandidates(f.home, NOW, 1000);
				expect(result.hints.map((h) => h.threadId).sort()).toEqual([source]);
				expect(result.hints[0].rolloutBytes).toBe(13);
				expect(result.stage1OutputsBefore).toBe(1);
			} finally {
				f.close();
			}
		},
	);
	it("treats missing databases as empty while surfacing corruption", () => {
		const f = fixture();
		f.close();
		rmSync(join(f.home, "state_5.sqlite"));
		expect(readDistillCandidates(f.home, NOW, 1000)).toEqual({
			hints: [],
			stage1OutputsBefore: 0,
		});
		const g = fixture();
		g.thread("eligible");
		g.close();
		rmSync(join(g.home, "memories_1.sqlite"));
		expect(
			readDistillCandidates(g.home, NOW, 1000).hints.map((h) => h.threadId),
		).toEqual(["eligible"]);
		writeFileSync(join(g.home, "memories_1.sqlite"), "corrupt database");
		expect(() => readDistillCandidates(g.home, NOW, 1000)).toThrow();
	});

	it("includes exact 1h/10d boundaries, caps at two newest and reads committed WAL rows", () => {
		const f = fixture();
		try {
			f.state.pragma("journal_mode = WAL");
			f.memories.pragma("journal_mode = WAL");
			f.thread("lower", { updated_at_ms: NOW - 240 * HOUR });
			f.thread("upper", { updated_at_ms: NOW - HOUR });
			expect(
				readDistillCandidates(f.home, NOW, 1000).hints.map((h) => h.threadId),
			).toEqual(["upper", "lower"]);
			for (let i = 0; i < 10; i++)
				f.thread(`item-${i}`, { updated_at_ms: NOW - (i + 2) * HOUR });
			expect(
				readDistillCandidates(f.home, NOW, 1000).hints.map((h) => h.threadId),
			).toEqual(["upper", "item-0"]);
			f.memories
				.prepare(
					"INSERT INTO jobs(kind,job_key,last_success_watermark) VALUES ('memory_stage1','upper',?)",
				)
				.run((NOW - HOUR) / 1000);
			expect(
				readDistillCandidates(f.home, NOW, 1000).hints.map((h) => h.threadId),
			).not.toContain("upper");
		} finally {
			f.close();
		}
	});
});

describe("worker-bound output evidence", () => {
	it("requires nonempty output and exact phase2 selection, ignoring other workers", () => {
		const f = fixture();
		try {
			f.thread("t1");
			const hints = readDistillCandidates(f.home, NOW, 1000).hints;
			f.memories.exec(`INSERT INTO jobs VALUES ('memory_stage1','t1','done','worker',100,NULL,NULL);
    INSERT INTO jobs VALUES ('memory_consolidate_global','global','done','foreign',NULL,NULL,NULL);`);
			expect(readDistillObservation(f.home, "worker", hints, 1000).status).toBe(
				"partial",
			);
			f.memories.exec(
				`INSERT INTO stage1_outputs VALUES ('t1',100,'real lesson','real summary',1,100)`,
			);
			expect(readDistillObservation(f.home, "worker", hints, 1000).status).toBe(
				"stage1_done",
			);
			f.memories.exec(
				"UPDATE jobs SET worker_id='worker' WHERE kind='memory_consolidate_global'",
			);
			expect(readDistillObservation(f.home, "worker", hints, 1000).status).toBe(
				"readable_ready",
			);
		} finally {
			f.close();
		}
	});
});

describe("no false success from native jobs", () => {
	it.each([
		["DELETE FROM stage1_outputs", "partial", "done_no_output"],
		["UPDATE stage1_outputs SET raw_memory=''", "partial", "done_no_output"],
		[
			"UPDATE stage1_outputs SET rollout_summary=''",
			"partial",
			"done_no_output",
		],
		[
			"UPDATE stage1_outputs SET source_updated_at=99",
			"partial",
			"done_no_output",
		],
		[
			"UPDATE stage1_outputs SET selected_for_phase2=0",
			"stage1_done",
			"done_with_output",
		],
		[
			"UPDATE stage1_outputs SET selected_for_phase2_source_updated_at=99",
			"stage1_done",
			"done_with_output",
		],
		[
			"UPDATE jobs SET status='error' WHERE kind='memory_consolidate_global'",
			"partial",
			"done_with_output",
		],
		[
			"UPDATE jobs SET status='error' WHERE kind='memory_stage1'",
			"partial",
			"error",
		],
		[
			"UPDATE jobs SET status='pending' WHERE kind='memory_stage1'",
			"partial",
			"pending",
		],
	])("guards %s", (sql, status, after) => {
		const f = fixture();
		try {
			f.thread("t1");
			const hints = readDistillCandidates(f.home, NOW, 1000).hints;
			f.memories.exec(`INSERT INTO jobs VALUES ('memory_stage1','t1','done','worker',100,NULL,NULL);
    INSERT INTO jobs VALUES ('memory_consolidate_global','global','done','worker',NULL,NULL,NULL);
    INSERT INTO stage1_outputs VALUES ('t1',100,'lesson','summary',1,100);`);
			f.memories.exec(sql);
			const observation = readDistillObservation(f.home, "worker", hints, 1000);
			expect(observation.status).toBe(status);
			expect(observation.claimed[0].after).toBe(after);
		} finally {
			f.close();
		}
	});
	it("requires every hint while observing unexpected claims without promoting partial success", () => {
		const f = fixture();
		try {
			f.thread("t1");
			f.thread("t2");
			const hints = readDistillCandidates(f.home, NOW, 1000).hints;
			f.memories.exec(
				`INSERT INTO jobs VALUES ('memory_consolidate_global','global','done','worker',NULL,NULL,NULL)`,
			);
			expect(readDistillObservation(f.home, "worker", hints, 1000).status).toBe(
				"partial",
			);
			f.memories.exec(`INSERT INTO jobs VALUES ('memory_stage1','t1','done','worker',100,NULL,NULL);
    INSERT INTO jobs VALUES ('memory_stage1','unexpected','done','worker',100,NULL,NULL);
    INSERT INTO stage1_outputs VALUES ('t1',100,'lesson','summary',1,100);`);
			const observation = readDistillObservation(f.home, "worker", hints, 1000);
			expect(observation.status).toBe("partial");
			expect(observation.expectedButUnclaimed).toEqual(["t2"]);
			expect(observation.claimedUnexpected).toEqual(["unexpected"]);
			expect(JSON.stringify(observation)).not.toContain("lesson");
		} finally {
			f.close();
		}
	});
});

describe("private atomic receipts", () => {
	it("writes 0600 receipts and increments only identity-matched attempts", () => {
		const f = fixture();
		f.close();
		const receipt = {
			version: 1,
			executionId: "exec-1",
			home: f.home,
			status: "partial",
		};
		writeDistillReceipt(receipt);
		const path = join(f.home, ".flywheel-memory-distill", "exec-1.json");
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(path, "utf8")).attempt).toBe(1);
		writeDistillReceipt(receipt);
		expect(JSON.parse(readFileSync(path, "utf8")).attempt).toBe(2);
	});
});

describe("receipt input hardening", () => {
	it.each(["oversize", "identity", "symlink", "json", "attempt"])(
		"rejects a %s prior receipt without reading through links",
		(kind) => {
			const f = fixture();
			f.close();
			const receipt = {
				version: 1,
				executionId: "exec-1",
				home: f.home,
				status: "partial",
			};
			writeDistillReceipt(receipt);
			const path = join(f.home, ".flywheel-memory-distill", "exec-1.json");
			const outside = join(f.home, "outside");
			writeFileSync(outside, "untouched");
			if (kind === "symlink") {
				rmSync(path);
				symlinkSync(outside, path);
			} else
				writeFileSync(
					path,
					kind === "oversize"
						? "x".repeat(65537)
						: kind === "json"
							? "{"
							: JSON.stringify({
									...receipt,
									home: kind === "identity" ? "other" : f.home,
									attempt: kind === "attempt" ? -1 : 5,
								}),
				);
			const result = writeDistillReceipt(receipt);
			expect(result.attempt).toBe(1);
			expect(result.receiptPriorInvalid).toBe(true);
			expect(readFileSync(outside, "utf8")).toBe("untouched");
		},
	);
	it("rejects traversal and a symlink receipt directory", () => {
		const f = fixture();
		f.close();
		const receipt = {
			version: 1,
			executionId: "../outside",
			home: f.home,
			status: "partial",
		};
		expect(() => writeDistillReceipt(receipt)).toThrow("execution id");
		symlinkSync(f.home, join(f.home, ".flywheel-memory-distill"));
		expect(() =>
			writeDistillReceipt({ ...receipt, executionId: "exec-1" }),
		).toThrow("real directory");
	});
});

function channel(f: ReturnType<typeof fixture>) {
	let now = NOW;
	let events: { onNotification?: (method: string, params: unknown) => void } =
		{};
	const client = {
		isClosed: vi.fn(() => false),
		setEvents: vi.fn((value: typeof events) => {
			events = value;
		}),
		startThread: vi.fn(async () => "worker"),
		startTurn: vi.fn(async () => {
			events.onNotification?.("turn/completed", {
				threadId: "worker",
				turn: { id: "turn-1", status: "completed" },
			});
			return "turn-1";
		}),
	};
	return {
		client,
		input: {
			executionId: "exec-1",
			codexHome: f.home,
			cwd: f.home,
			signal: new AbortController().signal,
			client,
		},
		deps: {
			now: () => now,
			sleep: async (ms: number) => {
				now += ms;
			},
		},
		notify: (method: string, params: unknown) =>
			events.onNotification?.(method, params),
	};
}
describe("admission channel", () => {
	it("skips an empty home with no RPC and persists a receipt", async () => {
		const f = fixture();
		try {
			const c = channel(f);
			const result = await runMemoryDistillation(c.input, c.deps);
			expect(result.status).toBe("skipped:no_candidates");
			expect(c.client.startThread).not.toHaveBeenCalled();
			expect(
				JSON.parse(
					readFileSync(
						join(f.home, ".flywheel-memory-distill/exec-1.json"),
						"utf8",
					),
				).status,
			).toBe(result.status);
		} finally {
			f.close();
		}
	});
});

it("triggers native stage1 and waits for its owned phase2 before reporting readable", async () => {
	const f = fixture();
	try {
		f.thread("t1");
		const c = channel(f);
		c.client.startTurn.mockImplementation(async () => {
			f.thread("worker", { memory_mode: "disabled", updated_at_ms: NOW });
			f.memories.exec(`INSERT INTO jobs VALUES ('memory_stage1','t1','done','worker',100,NULL,NULL);
    INSERT INTO jobs VALUES ('memory_consolidate_global','global','done','worker',NULL,NULL,NULL);
    INSERT INTO stage1_outputs VALUES ('t1',100,'lesson','summary',1,100);`);
			c.notify("turn/completed", {
				threadId: "worker",
				turn: { id: "turn-1", status: "completed" },
			});
			return "turn-1";
		});
		const result = await runMemoryDistillation(c.input, c.deps);
		expect(result.status).toBe("readable_ready");
		expect(c.client.startThread).toHaveBeenCalledWith({
			cwd: f.home,
			sandbox: "read-only",
			approvalPolicy: "never",
			timeoutMs: 300000,
			config: {
				"memories.min_rollout_idle_hours": 1,
				"memories.max_rollout_age_days": 10,
				"memories.max_rollouts_per_startup": 1,
				"memories.generate_memories": false,
			},
		});
		expect(result.cost.triggerThreadTotalTokens).toMatchObject({
			value: 42,
			availability: "exact",
		});
		expect(c.client.setEvents).toHaveBeenLastCalledWith({});
	} finally {
		f.close();
	}
});

it.each([
	"no_claim",
	"stage1_only",
	"timeout",
	"abort",
	"thread_error",
	"turn_error",
	"corrupt",
	"closed",
])("bounds admission on %s and clears listeners", async (scenario) => {
	const f = fixture();
	try {
		f.thread("t1");
		const c = channel(f);
		const controller = new AbortController();
		c.input.signal = controller.signal;
		if (scenario === "stage1_only" || scenario === "timeout")
			c.client.startTurn.mockImplementation(async () => {
				f.thread("worker", { memory_mode: "disabled", updated_at_ms: NOW });
				f.memories
					.prepare(
						"INSERT INTO jobs VALUES ('memory_stage1','t1',?,'worker',100,NULL,NULL)",
					)
					.run(scenario === "timeout" ? "running" : "done");
				f.memories.exec(
					"INSERT INTO stage1_outputs VALUES ('t1',100,'lesson','summary',0,NULL)",
				);
				c.notify("turn/completed", { threadId: "worker" });
				return "turn-1";
			});
		if (scenario === "thread_error")
			c.client.startThread.mockRejectedValue(new Error("thread failure"));
		if (scenario === "turn_error")
			c.client.startTurn.mockRejectedValue(new Error("turn failure"));
		if (scenario === "closed") c.client.isClosed.mockReturnValue(true);
		if (scenario === "corrupt") f.memories.exec("DROP TABLE stage1_outputs");
		if (scenario === "abort")
			c.deps.sleep = async () => {
				controller.abort();
			};
		const result = await runMemoryDistillation(
			{ ...c.input, waitBudgetMs: 60000 },
			c.deps,
		);
		const expected = {
			no_claim: "skipped:no_claim_observed_within_45s",
			stage1_only: "stage1_done",
			timeout: "skipped:timeout",
			abort: "skipped:runtime_stopped",
			thread_error: "skipped:thread_start_failed",
			turn_error: "skipped:turn_start_failed",
			corrupt: "skipped:db_unreadable",
			closed: "skipped:runtime_stopped",
		};
		expect(result.status).toBe(expected[scenario as keyof typeof expected]);
		expect(result.cost.wallMs).toBeLessThanOrEqual(60000);
		if (c.client.setEvents.mock.calls.length)
			expect(c.client.setEvents).toHaveBeenLastCalledWith({});
	} finally {
		f.close();
	}
});

it("records trigger tokens even when native guards leave no claim within 45s", async () => {
	const f = fixture();
	try {
		f.thread("t1");
		const c = channel(f);
		c.client.startThread.mockImplementation(async () => {
			f.thread("worker", { memory_mode: "disabled", updated_at_ms: NOW });
			return "worker";
		});
		const result = await runMemoryDistillation(c.input, c.deps);
		expect(result.status).toBe("skipped:no_claim_observed_within_45s");
		expect(result.cost.triggerThreadTotalTokens.value).toBe(42);
	} finally {
		f.close();
	}
});

it("charges candidate scanning to the same deadline before starting any RPC", async () => {
	const f = fixture();
	try {
		for (let i = 0; i < 8; i++) f.thread(`t${i}`);
		const c = channel(f);
		let clock = NOW;
		let stats = 0;
		const result = await runMemoryDistillation(
			{ ...c.input, waitBudgetMs: 100 },
			{
				...c.deps,
				now: () => clock,
				stat: ((path: Parameters<typeof statSync>[0]) => {
					stats++;
					clock += 50;
					return statSync(path);
				}) as typeof statSync,
			},
		);
		expect(result.status).toBe("skipped:timeout");
		expect(stats).toBe(2);
		expect(result.cost.wallMs).toBe(100);
		expect(c.client.startThread).not.toHaveBeenCalled();
	} finally {
		f.close();
	}
});

it.each([
	"late_stage1",
	"late_phase2",
	"delayed_tokens",
	"missing_tokens",
	"phase2_running",
])("keeps bounded evidence honest for %s", async (scenario) => {
	const f = fixture();
	try {
		f.thread("t1");
		const c = channel(f);
		if (scenario !== "late_stage1")
			c.client.startTurn.mockImplementation(async () => {
				f.memories.exec(`INSERT INTO jobs VALUES ('memory_stage1','t1','done','worker',100,NULL,NULL);
    INSERT INTO stage1_outputs VALUES ('t1',100,'lesson','summary',1,100)`);
				if (scenario === "phase2_running")
					f.memories.exec(
						"INSERT INTO jobs VALUES ('memory_consolidate_global','global','running','worker',NULL,NULL,NULL)",
					);
				c.notify("turn/completed", { threadId: "worker" });
				return "turn-1";
			});
		const sleep = c.deps.sleep;
		let written = false;
		c.deps.sleep = async (ms) => {
			await sleep(ms);
			const elapsed = c.deps.now() - NOW;
			if (!written && scenario === "late_stage1" && elapsed >= 46000) {
				written = true;
				f.memories.exec(
					"INSERT INTO jobs VALUES ('memory_stage1','t1','done','worker',100,NULL,NULL)",
				);
			}
			if (!written && scenario === "late_phase2" && elapsed >= 16000) {
				written = true;
				f.memories.exec(
					"INSERT INTO jobs VALUES ('memory_consolidate_global','global','done','worker',NULL,NULL,NULL)",
				);
			}
			if (!written && scenario === "delayed_tokens" && elapsed >= 16000) {
				written = true;
				f.thread("worker", { memory_mode: "disabled", updated_at_ms: NOW });
			}
			if (!written && scenario === "phase2_running" && elapsed >= 10000) {
				written = true;
				f.memories.exec(
					"UPDATE jobs SET status='done' WHERE kind='memory_consolidate_global'",
				);
				f.thread("worker", { memory_mode: "disabled", updated_at_ms: NOW });
			}
		};
		const result = await runMemoryDistillation(c.input, c.deps);
		expect(result.status).toBe(
			scenario === "late_stage1"
				? "skipped:no_claim_observed_within_45s"
				: scenario === "phase2_running"
					? "readable_ready"
					: "stage1_done",
		);
		if (scenario === "late_phase2")
			expect(result.phase2.observed).toBe("not_observed_within_15s");
		if (scenario === "delayed_tokens")
			expect(result.cost.triggerThreadTotalTokens.value).toBe(42);
		if (scenario === "missing_tokens")
			expect(result.cost.triggerThreadTotalTokens).toMatchObject({
				value: null,
				availability: "unavailable",
			});
	} finally {
		f.close();
	}
});

it("aborts an unresponsive RPC promptly instead of waiting for its response", async () => {
	const f = fixture();
	try {
		f.thread("t1");
		const c = channel(f);
		const controller = new AbortController();
		c.client.startThread.mockImplementation(() => {
			queueMicrotask(() => controller.abort());
			return new Promise<string>(() => {});
		});
		const result = await runMemoryDistillation(
			{ ...c.input, signal: controller.signal },
			c.deps,
		);
		expect(result.status).toBe("skipped:runtime_stopped");
		expect(c.client.startTurn).not.toHaveBeenCalled();
	} finally {
		f.close();
	}
});

it("subtracts RPC wall time and caps sleeps at the single absolute deadline", async () => {
	const f = fixture();
	try {
		f.thread("t1");
		const c = channel(f);
		c.client.startThread.mockImplementation(async () => {
			await c.deps.sleep(250000);
			return "worker";
		});
		c.client.startTurn.mockImplementation(async () => {
			await c.deps.sleep(30000);
			c.notify("turn/completed", { threadId: "worker" });
			return "turn-1";
		});
		const result = await runMemoryDistillation(c.input, c.deps);
		expect(c.client.startTurn).toHaveBeenCalledWith("worker", "ok", 50000);
		expect(result.status).toBe("skipped:timeout");
		expect(result.cost.wallMs).toBe(300000);
	} finally {
		f.close();
	}
});

it("matches Codex's whole-second success watermark for millisecond thread updates", () => {
	const f = fixture();
	try {
		f.thread("t1", { updated_at_ms: NOW - 2 * HOUR + 123 });
		f.memories
			.prepare(
				"INSERT INTO jobs(kind,job_key,last_success_watermark) VALUES ('memory_stage1','t1',?)",
			)
			.run((NOW - 2 * HOUR) / 1000);
		expect(readDistillCandidates(f.home, NOW, 1000).hints).toEqual([]);
		f.memories.exec("DELETE FROM jobs");
		f.memories
			.prepare(
				"INSERT INTO stage1_outputs(thread_id,source_updated_at) VALUES ('t1',?)",
			)
			.run((NOW - 2 * HOUR) / 1000);
		expect(readDistillCandidates(f.home, NOW, 1000).hints).toEqual([]);
	} finally {
		f.close();
	}
});

it("bounds a backlog larger than eight to two hints and two native claims", async () => {
	const f = fixture();
	try {
		for (let i = 0; i < 12; i++)
			f.thread(`backlog-${i}`, { updated_at_ms: NOW - (i + 2) * HOUR });
		const c = channel(f);
		const result = await runMemoryDistillation(c.input, c.deps);
		expect(result.hints.map((hint) => hint.threadId)).toEqual([
			"backlog-0",
			"backlog-1",
		]);
		expect(c.client.startThread).toHaveBeenCalledWith(
			expect.objectContaining({
				config: expect.objectContaining({
					"memories.max_rollouts_per_startup": 2,
				}),
			}),
		);
	} finally {
		f.close();
	}
});

it("preserves readable evidence when best-effort tokens reach the deadline", async () => {
	const f = fixture();
	try {
		f.thread("t1");
		const c = channel(f);
		c.client.startTurn.mockImplementation(async () => {
			f.memories.exec(`INSERT INTO jobs VALUES ('memory_stage1','t1','done','worker',100,NULL,NULL);
			INSERT INTO jobs VALUES ('memory_consolidate_global','global','done','worker',NULL,NULL,NULL);
			INSERT INTO stage1_outputs VALUES ('t1',100,'lesson','summary',1,100);`);
			c.notify("turn/completed", { threadId: "worker" });
			return "turn-1";
		});
		const result = await runMemoryDistillation(
			{ ...c.input, waitBudgetMs: 1000 },
			c.deps,
		);
		expect(result.status).toBe("readable_ready");
		expect(result.cost.triggerThreadTotalTokens.availability).toBe(
			"unavailable",
		);
	} finally {
		f.close();
	}
});

it.each(["ENOENT", "EACCES"])(
	"keeps candidates usable when a rollout byte stat returns %s",
	async (code) => {
		const f = fixture();
		try {
			f.thread("missing", { rollout_path: join(f.home, "missing.jsonl") });
			f.thread("present");
			const c = channel(f);
			const result = await runMemoryDistillation(c.input, {
				...c.deps,
				stat: ((path: Parameters<typeof statSync>[0]) => {
					if (String(path).endsWith("missing.jsonl"))
						throw Object.assign(new Error("unavailable"), { code });
					return statSync(path);
				}) as typeof statSync,
			});
			expect(result.status).toBe("skipped:no_claim_observed_within_45s");
			expect(c.client.startThread).toHaveBeenCalled();
			expect(result.hints.find((h) => h.threadId === "missing")).toMatchObject({
				rolloutBytes: 0,
				rolloutBytesAvailability: "unavailable",
			});
			expect(result.cost.hintRolloutBytesTotal.availability).toBe(
				"unavailable",
			);
		} finally {
			f.close();
		}
	},
);

it("caps synchronous SQLite waits while retaining the absolute admission deadline", async () => {
	const f = fixture();
	try {
		f.thread("t1");
		const c = channel(f);
		const budgets: number[] = [];
		const pragmas: number[] = [];
		await runMemoryDistillation(c.input, {
			...c.deps,
			openDb: (path, timeoutMs) => {
				budgets.push(timeoutMs);
				const db = new Database(path, {
					readonly: true,
					fileMustExist: true,
					timeout: timeoutMs,
				});
				const original = db.pragma.bind(db);
				vi.spyOn(db, "pragma").mockImplementation(((sql: string) => {
					if (sql.startsWith("busy_timeout = "))
						pragmas.push(Number(sql.split("=")[1]));
					return original(sql);
				}) as typeof db.pragma);
				return db;
			},
		});
		expect(budgets.length).toBeGreaterThan(0);
		expect(pragmas.length).toBeGreaterThan(0);
		expect(Math.max(...budgets, ...pragmas)).toBeLessThanOrEqual(5000);
	} finally {
		f.close();
	}
});

it.each([false, true])(
	"classifies home using the configured agent subtree (keyed=%s)",
	async (keyed) => {
		const f = fixture();
		const previousRoot = process.env.FLYWHEEL_CODEX_HOMES_ROOT;
		try {
			process.env.FLYWHEEL_CODEX_HOMES_ROOT = join(f.home, "managed");
			const home = join(
				f.home,
				keyed ? "managed" : "unrelated",
				"agents",
				"project",
				"implement",
			);
			mkdirSync(home, { recursive: true });
			const c = channel(f);
			const result = await runMemoryDistillation(
				{ ...c.input, codexHome: home },
				c.deps,
			);
			expect(result.homeKind).toBe(keyed ? "keyed" : "legacy");
		} finally {
			if (previousRoot === undefined)
				delete process.env.FLYWHEEL_CODEX_HOMES_ROOT;
			else process.env.FLYWHEEL_CODEX_HOMES_ROOT = previousRoot;
			f.close();
		}
	},
);
