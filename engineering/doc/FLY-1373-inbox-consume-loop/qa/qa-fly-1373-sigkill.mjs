#!/usr/bin/env node
/**
 * FLY-1373 验收① 字面版 — 真 SIGKILL(kill -9) 中途打死消费进程。
 * 子进程在 adapter 交付回调里挂起(消息已交出,回执未回) → 父进程 kill -9
 * → 父进程重开同一 comm.db → 断言零销账 + 全量重投。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = "/Users/xiaorongli/Dev/flywheel-FLY-1373";
const { LeadInboxQueue } = await import(
	`${ROOT}/packages/flywheel-comm/dist/lead-inbox-queue.js`
);

const LEAD = "flywheel-eng-lead";
const N = 12;
let pass = 0,
	fail = 0;
function check(name, cond, detail = "") {
	if (cond) {
		pass++;
		console.log(`  ✅ ${name}`);
	} else {
		fail++;
		console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const dir = mkdtempSync(join(tmpdir(), "qa1373-kill-"));
const dbPath = join(dir, "comm.db");

// 1. 预置 N 条待投递
const seed = new LeadInboxQueue(dbPath);
for (let i = 0; i < N; i++) {
	seed.enqueue({
		id: `k-${i}`,
		toLead: LEAD,
		source: "qa",
		type: "test",
		msgClass: "model",
		priority: i % 4,
		content: `kill-${i}`,
	});
}
check(
	`预置 ${N} 条 pending`,
	seed.countPending(LEAD) === N,
	`实际 ${seed.countPending(LEAD)}`,
);
seed.close();

// 2. 子进程：开始交付后卡死在回执前，打印 READY 供父进程精确定时 kill
const childSrc = `
const { LeadInboxQueue } = await import("${ROOT}/packages/flywheel-comm/dist/lead-inbox-queue.js");
const { LeadInboxLoop } = await import("${ROOT}/packages/teamlead/dist/bridge/lead-inbox-loop.js");
const queue = new LeadInboxQueue(${JSON.stringify(dbPath)});
const loop = new LeadInboxLoop({
  queue, leadId: ${JSON.stringify(LEAD)}, ownerEpoch: "child-epoch",
  hasLiveSession: () => true,
  handleProtocol: async () => ({ disposition: "handled" }),
  adapter: {
    async deliverBatch(batch) {
      // 消息已交到对端；回执尚未写回 —— 正是崩溃窗口
      console.log("DELIVERED " + batch.members.length);
      await new Promise(() => {});   // 永久挂起,等父进程 kill -9
    },
  },
});
await loop.tick();
`;
const childFile = join(dir, "child.mjs");
writeFileSync(childFile, childSrc);

console.log("\n[SIGKILL] 子进程交付中途 kill -9");
const child = spawn(process.execPath, [childFile], {
	stdio: ["ignore", "pipe", "pipe"],
});
let delivered = 0;
const killed = await new Promise((resolve) => {
	let done = false;
	child.stdout.on("data", (b) => {
		const s = b.toString();
		const m = s.match(/DELIVERED (\d+)/);
		if (m && !done) {
			done = true;
			delivered = Number(m[1]);
			// 消息已交出、回执未回 —— 此刻猝死
			child.kill("SIGKILL");
			resolve(true);
		}
	});
	child.stderr.on("data", (b) => process.stderr.write(`  [child stderr] ${b}`));
	child.on("exit", () => {
		if (!done) resolve(false);
	});
	setTimeout(() => {
		if (!done) {
			child.kill("SIGKILL");
			resolve(false);
		}
	}, 30_000);
});

check(
	"子进程确实进入了交付阶段后才被打死",
	killed === true && delivered === N,
	`killed=${killed} delivered=${delivered}`,
);

const code = await new Promise((r) =>
	child.on("exit", (c, sig) => r(sig ?? c)),
);
check("子进程死于 SIGKILL(非正常退出)", code === "SIGKILL", `退出信号=${code}`);

// 3. 父进程重开同一个 db —— 模拟 Bridge 重启
const after = new LeadInboxQueue(dbPath);
check(
	`SIGKILL 后【零丢】: pending 仍为 ${N}`,
	after.countPending(LEAD) === N,
	`实际 ${after.countPending(LEAD)}`,
);

// 4. 重启后重投,断言一条不少、顺序仍按优先级
const { LeadInboxLoop } = await import(
	`${ROOT}/packages/teamlead/dist/bridge/lead-inbox-loop.js`
);
const mkLoop = (epoch, seen, leaseTtlMs) =>
	new LeadInboxLoop({
		queue: after,
		leadId: LEAD,
		ownerEpoch: epoch,
		hasLiveSession: () => false,
		leaseTtlMs,
		handleProtocol: async () => ({ disposition: "handled" }),
		adapter: {
			async deliverBatch(batch) {
				seen.push(batch);
				return {
					status: "ok",
					batchId: batch.batchId,
					memberIds: batch.members.map((m) => m.deliveryId),
				};
			},
		},
	});

// 4a. fencing 语义:死 owner 的 lease 未过期前,新 epoch 不得接管(防双消费)
const tooEarly = [];
const early = await mkLoop("restart-epoch", tooEarly, 60_000).tick();
check(
	"fencing: 死 owner lease 未过期 → 新 epoch 被拒(防双投)",
	early.ok === false && /lease/i.test(early.error ?? ""),
	JSON.stringify(early),
);
check("被拒期间零投递", tooEarly.length === 0, `投了 ${tooEarly.length} 批`);
check(
	"被拒期间零销账",
	after.countPending(LEAD) === N,
	`pending=${after.countPending(LEAD)}`,
);

// 4b. 真实时钟下轮询重启后的 loop,测出「崩溃 → 真正重投」的实际耗时。
// 这里同时受 lease TTL(默认 10s) 和 row claim TTL(默认 15s) 两个闸门约束。
const seen = [];
const restarted = mkLoop("restart-epoch", seen, 60_000);
const t0 = Date.now();
let res = { ok: false };
while (Date.now() - t0 < 40_000) {
	res = await restarted.tick();
	if (seen.length > 0) break;
	await new Promise((r) => setTimeout(r, 1_000)); // 模拟 1s 活跃轮询
}
const recoverySec = ((Date.now() - t0) / 1000).toFixed(1);
check(
	"重启后的 loop 最终恢复投递（自愈,无需人工干预）",
	seen.length > 0,
	`40s 内未重投; 末次 tick=${JSON.stringify(res)}`,
);
console.log(
	`  ⏱  崩溃 → 真正重投耗时: ${recoverySec}s（受 lease TTL 10s + claim TTL 15s 约束）`,
);
check(
	"恢复耗时在 lease+claim TTL 量级内(<25s)",
	Number(recoverySec) < 25,
	`${recoverySec}s`,
);
check(
	`重投 ${N} 条一条不少`,
	seen[0]?.members.length === N,
	`实际 ${seen[0]?.members.length}`,
);
const ids = new Set(seen[0].members.map((m) => m.deliveryId));
check(
	"重投的 id 集合与原始完全一致",
	[...Array(N).keys()].every((i) => ids.has(`k-${i}`)) && ids.size === N,
);
const prios = seen[0].members.map((m) => m.priority);
check(
	"重投仍按 priority 升序（优先级语义跨崩溃保持）",
	prios.every((p, i) => i === 0 || prios[i - 1] <= p),
	JSON.stringify(prios),
);
check(
	"重投成功后全部销账",
	after.countPending(LEAD) === 0,
	`残留 ${after.countPending(LEAD)}`,
);
after.close();

console.log(`\n${"─".repeat(60)}`);
console.log(`验收① 真 SIGKILL: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
