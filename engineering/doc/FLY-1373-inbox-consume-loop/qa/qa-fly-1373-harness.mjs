#!/usr/bin/env node
/**
 * FLY-1373 独立 QA harness — 不复用仓库自带测试。
 * 直接对「编译产物 + 真 SQLite comm.db」跑验收 ①②⑤ 的行为断言。
 *
 * 用法: node qa-fly-1373-harness.mjs [--mutation]
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = "/Users/xiaorongli/Dev/flywheel-FLY-1373";
const { LeadInboxQueue } = await import(
	`${ROOT}/packages/flywheel-comm/dist/lead-inbox-queue.js`
);
const { LeadInboxLoop } = await import(
	`${ROOT}/packages/teamlead/dist/bridge/lead-inbox-loop.js`
);

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail = "") {
	if (cond) {
		pass++;
		console.log(`  ✅ ${name}`);
	} else {
		fail++;
		failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
		console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

function freshQueue() {
	const dir = mkdtempSync(join(tmpdir(), "qa-fly1373-"));
	const dbPath = join(dir, "comm.db");
	return { queue: new LeadInboxQueue(dbPath), dbPath, dir };
}

const LEAD = "flywheel-eng-lead";
const EPOCH = "qa-epoch-1";

/** 记录型 adapter：默认成功回执，可注入失败 / 静默丢回执。 */
function makeAdapter(mode = "ok") {
	const seen = [];
	return {
		seen,
		mode,
		async deliverBatch(batch) {
			seen.push(batch);
			if (this.mode === "throw") throw new Error("transport exploded");
			if (this.mode === "lost-receipt") {
				// 交付到了对端，但回执丢失（崩溃窗口）
				throw new Error("receipt lost after handoff");
			}
			if (this.mode === "conflict") {
				return {
					status: "membership_conflict",
					batchId: batch.batchId,
					memberIds: [],
				};
			}
			return {
				status: "ok",
				batchId: batch.batchId,
				memberIds: batch.members.map((m) => m.deliveryId),
			};
		},
	};
}

function makeLoop(queue, adapter, overrides = {}) {
	return new LeadInboxLoop({
		queue,
		leadId: LEAD,
		ownerEpoch: EPOCH,
		adapter,
		hasLiveSession: () => false,
		handleProtocol: async () => ({ disposition: "handled" }),
		...overrides,
	});
}

// ─────────────────────────────────────────────────────────────
// T1 (验收②) — 50 条 4 优先级并发 → 单批、按 priority,seq、一条不沉
// ─────────────────────────────────────────────────────────────
async function t1_priority_batch() {
	console.log("\n[T1] 验收② — 50 条并发按优先级批量,一条不沉");
	const { queue } = freshQueue();
	const adapter = makeAdapter("ok");

	// 打乱顺序 enqueue，模拟真实并发到达
	const inputs = [];
	for (let i = 0; i < 50; i++) {
		inputs.push({
			id: `m-${String(i).padStart(2, "0")}`,
			toLead: LEAD,
			source: "qa",
			type: "test",
			msgClass: "model",
			priority: /** @type {0|1|2|3} */ (i % 4),
			content: `msg-${i}`,
		});
	}
	// 洗牌（固定种子式：反序 + 交错）
	const shuffled = [];
	for (let i = 0; i < inputs.length; i += 2) shuffled.push(inputs[i]);
	for (let i = inputs.length - 1; i >= 0; i -= 2) shuffled.push(inputs[i]);
	const enqueueOrder = [];
	for (const inp of shuffled) {
		queue.enqueue(inp);
		enqueueOrder.push(inp.id);
	}

	check(
		"50 条全部入队 pending",
		queue.countPending(LEAD) === 50,
		`实际 ${queue.countPending(LEAD)}`,
	);

	const loop = makeLoop(queue, adapter);
	const res = await loop.tick();

	check("tick 成功", res.ok === true, res.error ?? "");
	check(
		"50 条一次交付（单批 = 单 turn）",
		adapter.seen.length === 1,
		`实际 ${adapter.seen.length} 批`,
	);

	const batch = adapter.seen[0];
	check(
		"批内成员数 = 50",
		batch?.members.length === 50,
		`实际 ${batch?.members.length}`,
	);

	// 排序断言：priority 升序；同 priority 内 seq 升序（= FIFO 入队序）
	const prios = batch.members.map((m) => m.priority);
	const sortedByPriority = prios.every((p, i) => i === 0 || prios[i - 1] <= p);
	check(
		"批内按 priority 升序（founder P0 最先）",
		sortedByPriority,
		JSON.stringify(prios.slice(0, 12)),
	);

	let fifoOk = true;
	let fifoDetail = "";
	for (let p = 0; p <= 3; p++) {
		const seqs = batch.members
			.filter((m) => m.priority === p)
			.map((m) => m.seq);
		for (let i = 1; i < seqs.length; i++) {
			if (seqs[i - 1] > seqs[i]) {
				fifoOk = false;
				fifoDetail = `priority=${p} seq 逆序 @${i}`;
			}
		}
	}
	check("同优先级内 seq FIFO", fifoOk, fifoDetail);

	// 同优先级 FIFO 必须等于「入队顺序」，而不仅是 seq 单调
	const p0Delivered = batch.members
		.filter((m) => m.priority === 0)
		.map((m) => m.deliveryId);
	const p0Enqueued = enqueueOrder.filter((id) => {
		const n = Number(id.slice(2));
		return n % 4 === 0;
	});
	check(
		"P0 交付顺序 == P0 入队顺序（真 FIFO 非仅单调）",
		JSON.stringify(p0Delivered) === JSON.stringify(p0Enqueued),
		`交付 ${JSON.stringify(p0Delivered.slice(0, 5))} vs 入队 ${JSON.stringify(p0Enqueued.slice(0, 5))}`,
	);

	check(
		"全部销账（零残留 pending）",
		queue.countPending(LEAD) === 0,
		`残留 ${queue.countPending(LEAD)}`,
	);
	check(
		"modelConsumed 报告 50",
		res.modelConsumed === 50,
		`实际 ${res.modelConsumed}`,
	);

	// 一条不沉：50 个 id 全部出现且不重复
	const ids = new Set(batch.members.map((m) => m.deliveryId));
	check("50 个 id 无重无漏", ids.size === 50, `去重后 ${ids.size}`);
	queue.close();
}

// ─────────────────────────────────────────────────────────────
// T2 (验收①) — 回执丢失 / 崩溃窗口 → 零丢 + 全重投 + 不重复销账
// ─────────────────────────────────────────────────────────────
async function t2_crash_zero_loss() {
	console.log("\n[T2] 验收① — 回执丢失（崩溃窗口）零丢全重投");
	const { queue, dbPath } = freshQueue();
	for (let i = 0; i < 10; i++) {
		queue.enqueue({
			id: `c-${i}`,
			toLead: LEAD,
			source: "qa",
			type: "test",
			msgClass: "model",
			priority: 1,
			content: `crash-${i}`,
		});
	}
	const adapter = makeAdapter("lost-receipt");
	const loop = makeLoop(queue, adapter);
	const res1 = await loop.tick();

	check(
		"回执丢失时 tick 判失败（不静默吞）",
		res1.ok === false,
		JSON.stringify(res1),
	);
	check(
		"回执丢失后【零销账】（灵魂断言）",
		queue.countPending(LEAD) === 10,
		`pending=${queue.countPending(LEAD)}，应为 10`,
	);

	// 模拟进程重启：重新打开同一个 db 文件
	queue.close();
	const queue2 = new LeadInboxQueue(dbPath);
	check(
		"重启后 pending 仍为 10（持久化，非内存态）",
		queue2.countPending(LEAD) === 10,
		`实际 ${queue2.countPending(LEAD)}`,
	);

	const adapter2 = makeAdapter("ok");
	const loop2 = makeLoop(queue2, adapter2);
	const res2 = await loop2.tick();
	check("重启后 tick 成功", res2.ok === true, res2.error ?? "");
	check(
		"重投 10 条一条不少",
		adapter2.seen[0]?.members.length === 10,
		`实际 ${adapter2.seen[0]?.members.length}`,
	);
	const redeliveredIds = new Set(
		adapter2.seen[0].members.map((m) => m.deliveryId),
	);
	check(
		"重投的正是原来那 10 条 id",
		[...Array(10).keys()].every((i) => redeliveredIds.has(`c-${i}`)),
		[...redeliveredIds].join(","),
	);
	check(
		"重投成功后全部销账",
		queue2.countPending(LEAD) === 0,
		`残留 ${queue2.countPending(LEAD)}`,
	);

	// 第三次 tick 不得重复投递（至少一次 + 幂等收口）
	const res3 = await loop2.tick();
	check(
		"已销账行不再重投（无重复交付）",
		adapter2.seen.length === 1,
		`adapter 收到 ${adapter2.seen.length} 批`,
	);
	check("空队列 tick 仍成功", res3.ok === true, res3.error ?? "");
	queue2.close();
}

// ─────────────────────────────────────────────────────────────
// T2b — transport 直接抛错（未交付）同样零丢
// ─────────────────────────────────────────────────────────────
async function t2b_transport_throw() {
	console.log("\n[T2b] 验收① — transport 抛错零丢");
	const { queue } = freshQueue();
	for (let i = 0; i < 5; i++) {
		queue.enqueue({
			id: `t-${i}`,
			toLead: LEAD,
			source: "qa",
			type: "test",
			msgClass: "model",
			priority: 2,
			content: `t-${i}`,
		});
	}
	const adapter = makeAdapter("throw");
	const loop = makeLoop(queue, adapter);
	const r = await loop.tick();
	check("transport 抛错 → tick 失败", r.ok === false);
	check(
		"transport 抛错 → 零销账",
		queue.countPending(LEAD) === 5,
		`pending=${queue.countPending(LEAD)}`,
	);

	adapter.mode = "ok";
	const r2 = await loop.tick();
	check(
		"恢复后全部投递并销账",
		r2.ok === true && queue.countPending(LEAD) === 0,
		`ok=${r2.ok} pending=${queue.countPending(LEAD)}`,
	);
	queue.close();
}

// ─────────────────────────────────────────────────────────────
// T3 (验收⑤) — 空闲退避 1s/30s + 门铃立即唤
// ─────────────────────────────────────────────────────────────
async function t3_idle_backoff() {
	console.log("\n[T3] 验收⑤ — 空闲退避真生效");
	const { queue } = freshQueue();
	const adapter = makeAdapter("ok");

	let live = false;
	const loop = makeLoop(queue, adapter, { hasLiveSession: () => live });

	check(
		"零 session + 空队列 → 30s 慢心跳",
		loop.nextDelayMs() === 30_000,
		`实际 ${loop.nextDelayMs()}ms`,
	);

	live = true;
	check(
		"有 live session → 1s 活跃轮询",
		loop.nextDelayMs() === 1_000,
		`实际 ${loop.nextDelayMs()}ms`,
	);

	live = false;
	queue.enqueue({
		id: "idle-1",
		toLead: LEAD,
		source: "qa",
		type: "test",
		msgClass: "model",
		priority: 3,
		content: "x",
	});
	check(
		"零 session 但 pending>0 → 回到 1s 活跃",
		loop.nextDelayMs() === 1_000,
		`实际 ${loop.nextDelayMs()}ms`,
	);

	// 门铃：用假定时器证明 nudge 不等待 30s
	const scheduled = [];
	let fired = 0;
	const nudgeLoop = makeLoop(queue, makeAdapter("ok"), {
		hasLiveSession: () => false,
		setTimer: (fn, ms) => {
			scheduled.push(ms);
			return { fn, ms };
		},
		clearTimer: () => {},
		adapter: {
			async deliverBatch(batch) {
				fired++;
				return {
					status: "ok",
					batchId: batch.batchId,
					memberIds: batch.members.map((m) => m.deliveryId),
				};
			},
		},
	});
	nudgeLoop.start();
	await new Promise((r) => setImmediate(r));
	await new Promise((r) => setImmediate(r));
	check(
		"挂载即首拉（mount-time first pull）",
		fired >= 1,
		`deliver 次数 ${fired}`,
	);
	const firedAfterMount = fired;

	queue.enqueue({
		id: "idle-2",
		toLead: LEAD,
		source: "qa",
		type: "test",
		msgClass: "model",
		priority: 0,
		content: "doorbell",
	});
	nudgeLoop.nudge();
	await new Promise((r) => setImmediate(r));
	await new Promise((r) => setImmediate(r));
	check(
		"门铃立即触发一次拉取（不等 30s）",
		fired > firedAfterMount,
		`${firedAfterMount} → ${fired}`,
	);
	nudgeLoop.stop();
	queue.close();
}

// ─────────────────────────────────────────────────────────────
// T4 — 类型分流：protocol 走代码，不进模型批
// ─────────────────────────────────────────────────────────────
async function t4_type_routing() {
	console.log("\n[T4] 照抄件⑤ — 类型分流 protocol vs model");
	const { queue } = freshQueue();
	const handled = [];
	queue.enqueue({
		id: "p-1",
		toLead: LEAD,
		source: "qa",
		type: "gate_response",
		msgClass: "protocol",
		priority: 0,
		content: "proto",
	});
	queue.enqueue({
		id: "m-1",
		toLead: LEAD,
		source: "qa",
		type: "runner_question",
		msgClass: "model",
		priority: 1,
		content: "model",
	});

	const adapter = makeAdapter("ok");
	const loop = makeLoop(queue, adapter, {
		handleProtocol: async (row) => {
			handled.push(row.id);
			return { disposition: "handled" };
		},
	});
	const r = await loop.tick();
	check("tick 成功", r.ok === true, r.error ?? "");
	check(
		"protocol 行走代码状态机",
		handled.length === 1 && handled[0] === "p-1",
		JSON.stringify(handled),
	);
	check(
		"protocol 行【不】进模型批",
		!adapter.seen.some((b) => b.members.some((m) => m.deliveryId === "p-1")),
	);
	check(
		"只有 model 行进模型批",
		adapter.seen[0]?.members.length === 1 &&
			adapter.seen[0].members[0].deliveryId === "m-1",
	);
	check(
		"两类都销账",
		queue.countPending(LEAD) === 0,
		`残留 ${queue.countPending(LEAD)}`,
	);
	queue.close();
}

// ─────────────────────────────────────────────────────────────
// T5 — 双消费者 owner fence：非当前 epoch 不得销账
// ─────────────────────────────────────────────────────────────
async function t5_owner_fence() {
	console.log("\n[T5] 双 Bridge owner fence — 旧 epoch 不得投递销账");
	const { queue } = freshQueue();
	queue.enqueue({
		id: "f-1",
		toLead: LEAD,
		source: "qa",
		type: "test",
		msgClass: "model",
		priority: 1,
		content: "fence",
	});

	// 新 Bridge 抢走 owner lease
	const now = new Date().toISOString();
	const acquired = queue.acquireOrRenewOwner({
		ownerEpoch: "epoch-NEW",
		now,
		leaseTtlMs: 60_000,
	});
	check("新 Bridge 取得 owner lease", acquired === true);

	// 旧 epoch 的 loop 试图消费
	const staleAdapter = makeAdapter("ok");
	const staleLoop = makeLoop(queue, staleAdapter, { ownerEpoch: "epoch-OLD" });
	const r = await staleLoop.tick();
	check("旧 epoch tick 失败（fence 生效）", r.ok === false, JSON.stringify(r));
	check(
		"旧 epoch 未投递",
		staleAdapter.seen.length === 0,
		`投了 ${staleAdapter.seen.length} 批`,
	);
	check(
		"旧 epoch 未销账",
		queue.countPending(LEAD) === 1,
		`pending=${queue.countPending(LEAD)}`,
	);
	queue.close();
}

const suites = [
	t1_priority_batch,
	t2_crash_zero_loss,
	t2b_transport_throw,
	t3_idle_backoff,
	t4_type_routing,
	t5_owner_fence,
];
for (const s of suites) {
	try {
		await s();
	} catch (e) {
		fail++;
		failures.push(`${s.name} 抛异常: ${e.message}`);
		console.log(`  ❌ ${s.name} 抛异常: ${e.message}\n${e.stack}`);
	}
}

console.log(`\n${"─".repeat(60)}`);
console.log(`FLY-1373 独立 harness: ${pass} PASS / ${fail} FAIL`);
if (failures.length) {
	console.log("失败项:");
	for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
