// 不碰任何真实频道:用假的 deps 验 TivPresenter 的三个方法真的产出她要的那三样。
const { TivPresenter } = await import("/Users/xiaorongli/Dev/flywheel/packages/voice-bridge/dist/discord/TivPresenter.js");

const sent = [], edits = [];
let nextId = 1;
const deps = {
  async send(t) { sent.push(t); },
  async sendForId(t) { sent.push(t); return { messageId: "m" + nextId++ }; },
  async edit(id, t) { edits.push([id, t]); },
};

const tiv = new TivPresenter({ deps, founderName: "Annie", assistantName: "助理", log: () => {} });

tiv.status("🎙 listening");
tiv.caption("user", "今天有几个 PR 还没合并");
tiv.caption("assistant", "查到了,42 个。");
tiv.error("语音会话错误:error");

await new Promise(r => setTimeout(r, 1500));   // status 是节流+异步的,给它时间落地

console.log("=== 发出去的消息 ===");
for (const t of sent) console.log("  " + JSON.stringify(t));
console.log("=== 原地编辑 ===");
for (const [id, t] of edits) console.log("  " + id + " -> " + JSON.stringify(t));

const all = sent.join("\n");
const checks = {
  "listening 状态行": /listening/.test(all),
  "她的转写带 Annie": /Annie/.test(all) && /PR/.test(all),
  "它的转写带 助理": /助理/.test(all) && /42/.test(all),
  "断线那一行": /语音会话错误/.test(all),
};
console.log("=== 判据 ===");
for (const [k, v] of Object.entries(checks)) console.log("  " + (v ? "✅" : "❌") + " " + k);
console.log(Object.values(checks).every(Boolean) ? "ALL-PASS" : "HAS-FAIL");
process.exit(0);
