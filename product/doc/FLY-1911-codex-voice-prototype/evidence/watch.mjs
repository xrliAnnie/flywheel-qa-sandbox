#!/usr/bin/env node
/*
 * FLY-1911 任务 1:把桥的事件日志变成一扇「她能看懂的窗」。
 *
 * 她的原话:「它慢的话我可以理解…唯一希望的是它可以给我一些 indicator」
 * ⇒ 这个窗口的唯一职责:让她随时知道**它现在在干嘛**,尤其是在它不说话的时候。
 *
 * 刻意的两条:
 *  1. 不做 UI。就是滚动的文字行,最土的办法。
 *  2. **看不懂的事件也照样打出来**(灰色 raw 行),绝不静默丢掉。
 *     上一轮踩过的坑:grep 出来是 0,而那个 0 的意思是「我没记」不是「没发生」。
 *     这个窗口不许再制造那种 0。
 *
 * 用法: node watch.mjs <bridge.jsonl 路径>
 */
import { existsSync, statSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const FILE = process.argv[2];
if (!FILE) { console.error("用法: node watch.mjs <bridge.jsonl>"); process.exit(1); }

const C = { dim:"\x1b[2m", r:"\x1b[0m", b:"\x1b[1m", cyan:"\x1b[36m", green:"\x1b[32m",
            yellow:"\x1b[33m", red:"\x1b[31m", mag:"\x1b[35m", grey:"\x1b[90m" };
const hhmmss = t => { const d = t ? new Date(t) : new Date();
  return String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0")+":"+String(d.getSeconds()).padStart(2,"0"); };

let sessionStart = null;          // 通话开始时刻
let lastItSpokeAt = null;         // 它上一次出声
let lastSheSpokeAt = null;        // 她上一次说完
let itIsWorking = false;          // 它是不是正在干活(问完还没答)
let workingSince = null;
let silenceTicker = null;

function line(icon, color, text, t) {
  console.log(`${C.grey}${hhmmss(t)}${C.r}  ${color}${icon} ${text}${C.r}`);
}
function raw(o, t) {   // 看不懂的照样露出来,只是压暗
  console.log(`${C.grey}${hhmmss(t)}  · ${JSON.stringify(o).slice(0,220)}${C.r}`);
}
const secs = ms => (ms/1000).toFixed(0);

/* 沉默计时:她最怕的就是这一段。每 5 秒报一次「它还在干」 */
function startSilenceTicker() {
  stopSilenceTicker();
  workingSince = Date.now(); itIsWorking = true;
  silenceTicker = setInterval(() => {
    const el = secs(Date.now() - workingSince);
    // 原地刷新只在真终端里做;被管道接走时改成正常换行,免得把行搅乱
    if (process.stdout.isTTY) process.stdout.write(`\r${C.yellow}   ⏳ 它还在干活…已经 ${el} 秒没出声${C.r}   `);
    else console.log(`${C.yellow}   ⏳ 它还在干活…已经 ${el} 秒没出声${C.r}`);
  }, 5000);
}
function stopSilenceTicker() {
  if (silenceTicker) { clearInterval(silenceTicker); silenceTicker = null;
    if (process.stdout.isTTY) process.stdout.write("\r" + " ".repeat(70) + "\r"); }
  itIsWorking = false;
}

function render(rec) {
  const t = rec.t, d = rec.dir, o = rec.obj;
  switch (d) {
    case "GATEWAY":  return line("🔌", C.dim,   `机器人已登录 Discord（${o?.bot ?? "?"}）`, t);
    case "JOINED":   return line("🚪", C.green, "已经进入语音房", t);
    case "READY":
      sessionStart = new Date(t).getTime();
      return line("●", C.b + C.green, "上线了 —— 现在可以在房里跟它说话", t);
    case "CODEX":
      if (o?.state?.includes("started")) return line("🧠", C.dim, `语音会话已建立（通道 ${o.version ?? "?"}）`, t);
      if (o?.state?.includes("closed"))  return line("🔚", C.yellow, `语音会话关闭：${o.reason ?? "未说明"}`, t);
      return raw(o, t);
    case "SPEAKING":
      lastSheSpokeAt = new Date(t).getTime();
      stopSilenceTicker();
      return line("🎤", C.cyan, "房里有人在说话", t);
    case "TX": {
      if (o?.role === "user") {
        lastSheSpokeAt = new Date(t).getTime();
        line("📝", C.b + C.cyan, `它把这句听成了：「${o.text}」`, t);
        startSilenceTicker();          // 她说完 → 开始等它
        return;
      }
      stopSilenceTicker();
      lastItSpokeAt = new Date(t).getTime();
      const waited = lastSheSpokeAt ? `（她说完后 ${secs(lastItSpokeAt - lastSheSpokeAt)} 秒）` : "";
      return line("💬", C.b + C.green, `它说：「${o.text}」${C.dim}${waited}`, t);
    }
    case "HANDOFF":
      return line("📤", C.mag, `它把活交出去了，交办时用的原话：「${o?.["交办时用的转写"] ?? "（没记到）"}」`, t);
    case "ITEM":
      return line("🔧", C.mag, `它在用工具：${o?.name ?? o?.type ?? "?"}`, t);
    case "APPROVE":
      return line("🔑", C.yellow, `它要跑一条命令，已自动放行：${o?.reason ?? ""}`, t);
    case "PLAYER":
      if (o?.to === "playing") return;   // 常开流,每秒都在 playing,不用报
      return;
    case "STREAM-END": return;
    case "CODEX-ERR":  return line("❌", C.red, `Codex 报错：${o?.msg ?? o}`, t);
    case "CODEX-STDERR": return;         // 噪音
    case "RESULT": {
      stopSilenceTicker();
      line("🏁", C.b, "这一场结束了", t);
      console.log(`${C.dim}   她说过的：${JSON.stringify(o?.userTranscripts ?? [])}`);
      console.log(`   它说过的：${JSON.stringify(o?.assistantTranscripts ?? [])}${C.r}`);
      return;
    }
    default:
      return raw({ [d]: o }, t);         // ← 不认识的一律露出来
  }
}

console.log(`${C.b}FLY-1911 语音实况${C.r}  ${C.dim}${FILE}${C.r}`);
console.log(`${C.dim}${"─".repeat(64)}${C.r}`);
console.log(`${C.dim}这扇窗只负责一件事：让你随时知道它在干嘛。灰色的 · 行是我还没翻成人话的事件，`);
console.log(`故意留着不藏 —— 藏了就会变成「看起来什么都没发生」。${C.r}\n`);

/* 最土的 tail -f:轮询文件长度,只读新增的那一段 */
let pos = 0, carry = "";
async function pump() {
  if (!existsSync(FILE)) return;
  const sz = statSync(FILE).size;
  if (sz < pos) { pos = 0; carry = ""; console.log(`${C.yellow}（日志被换掉了，从头开始读）${C.r}`); }
  if (sz === pos) return;
  await new Promise(res => {
    const rs = createReadStream(FILE, { start: pos, end: sz - 1, encoding: "utf8" });
    rs.on("data", c => { carry += c; });
    rs.on("end", () => {
      pos = sz;
      const lines = carry.split("\n"); carry = lines.pop() ?? "";
      for (const l of lines) { const s = l.trim(); if (!s) continue;
        let rec; try { rec = JSON.parse(s); } catch { console.log(`${C.grey}${s.slice(0,200)}${C.r}`); continue; }
        try { render(rec); } catch (e) { raw({ 渲染失败: String(e), 原始: rec }, rec?.t); } }
      res();
    });
    rs.on("error", () => res());
  });
}
setInterval(pump, 300);
setInterval(() => {                       // 顶部状态:通话时长
  if (!sessionStart) return;
  const m = Math.floor((Date.now()-sessionStart)/60000), s = Math.floor((Date.now()-sessionStart)%60000/1000);
  process.title = `FLY-1911 语音 ${m}分${s}秒`;
}, 1000);
