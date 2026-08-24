/* FLY-1911 实验 A 可行性探针 —— 只测三件事,不碰她那个房(不连 Discord、不开语音) */
import { spawn } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";

const BIN = realpathSync(
	process.env.CODEX_BIN ||
		"/Users/xiaorongli/.codex-mufasa/packages/standalone/releases/0.148.0-aarch64-apple-darwin/bin/codex",
);
const ID =
	"/Users/xiaorongli/Dev/flywheel/.lead/flywheel-product-lead/identity.md";
const MEM = `${process.env.HOME}/.claude/agent-memory/flywheel-product-lead/MEMORY.md`;
const strip = (s) => s.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
let base = "";
const FILES = process.env.HL_FILES
	? process.env.HL_FILES.split(",")
	: [ID, MEM];
for (const f of FILES) {
	try {
		base += `${strip(readFileSync(f, "utf8")).trim()}\n\n`;
	} catch (_e) {
		console.log("读不到", f);
	}
}
console.log(
	`  baseInstructions 装了 ${base.length} 字符(identity.md + MEMORY.md 索引)`,
);

const cx = spawn(BIN, ["app-server"], {
	stdio: ["pipe", "pipe", "pipe"],
	env: {
		...process.env,
		PATH: `${process.env.HOME}/.fly1911/shim:${process.env.PATH}`,
		ZDOTDIR: `${process.env.HOME}/.fly1911/zdot`,
		// ⛔ 不回落到继承来的 CODEX_HOME —— 这台 shell 里它是 ~/.codex-infra-bot,
		//    上一版写成 `process.env.CODEX_HOME || 默认`,结果又落回别人的家。
		CODEX_HOME:
			process.env.HL_CODEX_HOME || `${process.env.HOME}/.codex-honeylemon`,
	},
});
let buf = "",
	rpcId = 0;
const waiters = new Map();
const events = [];
cx.stdout.on("data", (d) => {
	buf += d;
	let n;
	for (;;) {
		n = buf.indexOf("\n");
		if (n < 0) break;
		const l = buf.slice(0, n).trim();
		buf = buf.slice(n + 1);
		if (!l) continue;
		let m;
		try {
			m = JSON.parse(l);
		} catch {
			continue;
		}
		if (m.method) events.push(m);
		if (m.id !== undefined && waiters.has(m.id)) {
			waiters.get(m.id)(m);
			waiters.delete(m.id);
		}
	}
});
cx.stderr.on("data", (d) => {
	const s = String(d).trim();
	if (s) console.log("  [stderr]", s.slice(0, 200));
});
const rpc = (me, pa) => {
	const i = ++rpcId;
	cx.stdin.write(
		`${JSON.stringify({ jsonrpc: "2.0", id: i, method: me, params: pa })}\n`,
	);
	return new Promise((r) => {
		waiters.set(i, r);
		setTimeout(() => {
			if (waiters.has(i)) {
				waiters.delete(i);
				r({ __timeout: true });
			}
		}, 240000);
	});
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await rpc("initialize", {
	clientInfo: { name: "fly1911-probe", version: "0" },
});
cx.stdin.write(
	`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`,
);
let params;
if (process.env.SANDBOX_JSON)
	params = {
		approvalPolicy: "never",
		sandbox: JSON.parse(process.env.SANDBOX_JSON),
		baseInstructions: base,
	};
else if (process.env.DEFAULT_POSTURE === "1")
	params = { baseInstructions: base };
else
	params = {
		approvalPolicy: "never",
		sandbox: process.env.SANDBOX || "workspace-write",
		baseInstructions: base,
	};
if (process.env.CWD_PIN) params.cwd = process.env.CWD_PIN;
/* A/B 用:NO_BASE=1 ⇒ 完全不给 baseInstructions,身份只能来自 home 里的 AGENTS.md */
if (process.env.NO_BASE === "1") {
	params.baseInstructions = undefined;
	delete params.baseInstructions;
	console.log(
		"  ⚠️ 这一场【不注入】baseInstructions —— 身份只能来自 CODEX_HOME 里的 AGENTS.md",
	);
}
const th = await rpc("thread/start", params);
const threadId = th?.result?.thread?.id || th?.result?.threadId;
console.log("  thread:", threadId || JSON.stringify(th).slice(0, 200));
console.log(
	"  起回来的姿势:",
	JSON.stringify(
		th?.result?.thread?.sandbox ?? th?.result?.sandbox ?? "(没回 sandbox 字段)",
	),
	"cwd:",
	JSON.stringify(th?.result?.thread?.cwd ?? "(无)"),
);
if (!threadId) {
	cx.kill();
	process.exit(1);
}

const ASK = process.env.ASK_FILE
	? readFileSync(process.env.ASK_FILE, "utf8")
	: `请照做,不要省略,把每条命令的**原始输出**贴出来:
1) 你是谁?用一句话说明你的身份和你负责什么。
2) 跑:wc -c ~/.claude/agent-memory/flywheel-product-lead/MEMORY.md
3) 跑:ls ~/.claude/agent-memory/flywheel-product-lead/ | wc -l
4) 跑:sqlite3 ~/.flywheel/comm.db "select count(*) from mailbox"
5) 跑:curl -s -m 5 -o /dev/null -w '%{http_code}' http://localhost:9876/health
6) 跑:cd /Users/xiaorongli/Dev/flywheel && git log --oneline -1
每条命令若失败,原样贴出错误信息,**不要猜测、不要编造输出**。`;
await rpc("turn/start", { threadId, input: [{ type: "text", text: ASK }] });
const t0 = Date.now();
let done = false;
while (!done && Date.now() - t0 < 240000) {
	await sleep(1000);
	if (
		events.some((e) =>
			/turn.*[Cc]ompleted|turn\/completed/.test(e.method || ""),
		)
	)
		done = true;
}
const texts = events
	.filter((e) => /agentMessage|item|message/i.test(e.method || ""))
	.map((e) => JSON.stringify(e.params || {}))
	.join("\n");
writeFileSync("probe-identity.events.json", JSON.stringify(events, null, 1));
console.log("  ---- 事件种类 ----");
console.log(`  ${[...new Set(events.map((e) => e.method))].join("\n  ")}`);
console.log("  ---- 它说了什么(截断)----");
console.log(texts.slice(-6000));
cx.kill();
process.exit(0);
