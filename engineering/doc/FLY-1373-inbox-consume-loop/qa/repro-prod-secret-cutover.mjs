#!/usr/bin/env node
/**
 * 复现:生产 delivery-secret 潜伏损坏 × FLY-1373 新代码 = 消费循环每 tick 失败。
 *
 * 全程只读生产、只写隔离副本。绝不触碰 ~/.flywheel 下任何文件。
 * 用法: node repro-prod-secret-cutover.mjs
 */
import { copyFileSync, existsSync, mkdtempSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = "/Users/xiaorongli/Dev/flywheel-FLY-1373";
const HOME = homedir();
const PROD_TEAMLEAD = join(HOME, ".flywheel/teamlead.db");
const PROD_COMM = join(HOME, ".flywheel/comm/flywheel/comm.db");

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
	if (cond) {
		pass++;
		console.log(`  ✅ ${name}`);
	} else {
		fail++;
		console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

// ── 1. 把生产状态复制进隔离沙箱(含 -wal/-shm,否则读到的是陈旧快照) ──
const sandbox = mkdtempSync(join(tmpdir(), "fly1373-secret-repro-"));
const commDir = join(sandbox, "comm", "flywheel");
const { mkdirSync } = await import("node:fs");
mkdirSync(commDir, { recursive: true });

const teamleadCopy = join(sandbox, "teamlead.db");
const commCopy = join(commDir, "comm.db");
for (const [src, dst] of [
	[PROD_TEAMLEAD, teamleadCopy],
	[PROD_COMM, commCopy],
]) {
	copyFileSync(src, dst);
	for (const suffix of ["-wal", "-shm"]) {
		if (existsSync(src + suffix)) copyFileSync(src + suffix, dst + suffix);
	}
}
console.log(`[sandbox] ${sandbox}`);

// 复制 secret 目录的**当前形态**:只有 52127555,没有 marker 指向的 b9e0f329
const secretDir = join(sandbox, "secrets");
mkdirSync(secretDir, { recursive: true });
const prodSecretFiles = readdirSync(join(HOME, ".flywheel")).filter((f) =>
	f.startsWith("delivery-secret."),
);
for (const f of prodSecretFiles) {
	copyFileSync(join(HOME, ".flywheel", f), join(secretDir, f));
}
console.log(
	`[sandbox] 复制了 ${prodSecretFiles.length} 个 secret 版本文件: ${prodSecretFiles.join(", ")}`,
);

// ── 2. 用副本重建生产的触发前提,断言它们确实成立 ──
const { createRequire } = await import("node:module");
const requireFromTeamlead = createRequire(`${ROOT}/packages/teamlead/src/x.js`);
const Database = requireFromTeamlead("better-sqlite3");
const tl = new Database(teamleadCopy, { readonly: true });
const marker = tl.prepare("SELECT * FROM delivery_secret_state").get();
check(
	"副本里 marker 仍是 ACTIVE 且指向某个 secretId",
	marker?.state === "ACTIVE" && Boolean(marker.active_secret_id),
	JSON.stringify(marker),
);
const activeId = marker.active_secret_id;
check(
	`marker 指向的 ${activeId.slice(0, 8)}… 在 secret 目录里缺失(损坏前提)`,
	!existsSync(join(secretDir, `delivery-secret.${activeId}`)),
	"文件竟然存在 → 前提不成立",
);

const cm = new Database(commCopy, { readonly: true });
const pending = cm
	.prepare(
		`SELECT * FROM messages WHERE type='ack_receipt' AND read_at IS NULL
		 AND expires_at > datetime('now') ORDER BY created_at, id`,
	)
	.all();
check(
	`副本里有待处理 ack_receipt(实际 ${pending.length} 条)`,
	pending.length > 0,
);

let triggering = 0;
for (const r of pending) {
	let payload;
	try {
		payload = JSON.parse(r.content);
	} catch {
		continue;
	}
	if (typeof payload.event_seq !== "number") continue;
	const row = tl
		.prepare("SELECT * FROM lead_events WHERE seq = ?")
		.get(payload.event_seq);
	if (
		row?.ack_owner_lead_id &&
		!row.acked_at &&
		r.from_agent === row.ack_owner_lead_id
	) {
		triggering++;
	}
}
check(
	`其中 ${triggering} 条满足 getActive() 触发条件(owner 匹配 + 未 ack)`,
	triggering > 0,
	"零条满足 → 不会触发,推论被推翻",
);
tl.close();
cm.close();

// ── 3. 拿真代码跑:FileDeliverySecretProvider 指向沙箱 secret 目录 ──
const { FileDeliverySecretProvider } = await import(
	`${ROOT}/packages/teamlead/dist/bridge/delivery-secret.js`
);
const { StateStore } = await import(
	`${ROOT}/packages/teamlead/dist/StateStore.js`
);
const { LegacyAckDrain } = await import(
	`${ROOT}/packages/teamlead/dist/bridge/legacy-ack-drain.js`
);

const store = await StateStore.create(teamleadCopy);
const provider = new FileDeliverySecretProvider({
	store,
	secretPath: join(secretDir, "delivery-secret"),
});

// 先单独证明 getActive() 本身会抛(把机制钉死,不只看整体结果)
let getActiveError;
try {
	provider.getActive();
} catch (e) {
	getActiveError = e;
}
check(
	"getActive() 对缺失的 ACTIVE 版本抛错",
	Boolean(getActiveError) && /missing/i.test(getActiveError?.message ?? ""),
	getActiveError ? getActiveError.message : "竟然没抛 → 推论被推翻",
);

// 再跑 FLY-1373 真正会跑的那一步
let drainError;
try {
	new LegacyAckDrain({
		store,
		commDbPaths: [commCopy],
		secretProvider: provider,
	}).run();
} catch (e) {
	drainError = e;
}
check(
	"LegacyAckDrain.run() 在生产状态下抛错(= admit() 会失败)",
	Boolean(drainError),
	drainError ? drainError.message : "竟然跑通了 → 推论被推翻,故障不会发生",
);
if (drainError) console.log(`     抛出: ${drainError.message}`);

// ── 4a. 顺带证实:改文件名修不好 —— 密钥内容自带身份 ──
// (第一版对照就是这么写的,被代码识破;保留下来因为它对运维有意义)
const { chmodSync } = await import("node:fs");
const donor = prodSecretFiles[0];
const renamed = join(secretDir, `delivery-secret.${activeId}`);
copyFileSync(join(secretDir, donor), renamed);
chmodSync(renamed, 0o600);
let renameError;
try {
	new LegacyAckDrain({
		store,
		commDbPaths: [commCopy],
		secretProvider: provider,
	}).run();
} catch (e) {
	renameError = e;
}
check(
	"把别的密钥改名成缺失的 id —— 仍被拒(密钥内容自带身份,重命名修不好)",
	Boolean(renameError) &&
		/identity is corrupt/i.test(renameError?.message ?? ""),
	renameError ? renameError.message : "竟然被接受了 —— 那是个更严重的安全问题",
);
const { unlinkSync } = await import("node:fs");
unlinkSync(renamed);

// ── 4b. 真·阳性对照:把 marker 指回磁盘上确实存在的那个密钥 ──
// 跑通 ⇒ 根因被隔离为「marker 与磁盘文件不一致」,而非代码/数据其它问题。
const fixTl = new Database(teamleadCopy);
const existingId = donor.replace("delivery-secret.", "");
fixTl
	.prepare(
		"UPDATE delivery_secret_state SET active_secret_id = ? WHERE singleton = 1",
	)
	.run(existingId);
fixTl.close();

const store2 = await StateStore.create(teamleadCopy);
const provider2 = new FileDeliverySecretProvider({
	store: store2,
	secretPath: join(secretDir, "delivery-secret"),
});
let repairedError;
try {
	new LegacyAckDrain({
		store: store2,
		commDbPaths: [commCopy],
		secretProvider: provider2,
	}).run();
} catch (e) {
	repairedError = e;
}
check(
	"阳性对照:marker 指回磁盘上存在的密钥后,同一段代码跑通(根因隔离为 marker↔文件不一致)",
	!repairedError,
	repairedError ? repairedError.message : "",
);

console.log(`\n${"─".repeat(60)}`);
console.log(`生产 secret × FLY-1373 复现: ${pass} PASS / ${fail} FAIL`);
console.log(`沙箱保留供复核: ${sandbox}`);
console.log("（全程未写入 ~/.flywheel — 生产零触碰）");
process.exit(fail === 0 ? 0 : 1);
