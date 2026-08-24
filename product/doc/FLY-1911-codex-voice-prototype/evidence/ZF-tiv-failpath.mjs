// 验「显示炸掉不许弄死会话」—— 不是读注释,是让三个注入函数全部抛异常,看有没有异常逃出来。
const { TivPresenter } = await import("/Users/xiaorongli/Dev/flywheel/packages/voice-bridge/dist/discord/TivPresenter.js");

const log = [];
// 模仿 bridge2.mjs 里那三个函数的写法:每个都吞掉自己的失败并记 TIV-ERR
const boom = () => { throw new Error("discord 挂了"); };
const deps = {
  async send()      { try { boom() } catch (e) { log.push("TIV-ERR send") } },
  async sendForId() { try { boom() } catch (e) { log.push("TIV-ERR sendForId"); return { messageId: "" } } },
  async edit()      { try { boom() } catch (e) { log.push("TIV-ERR edit") } },
};

let escaped = null;
process.on("uncaughtException", e => { escaped = "uncaughtException: " + e.message; });
process.on("unhandledRejection", e => { escaped = "unhandledRejection: " + (e?.message ?? e); });

const tiv = new TivPresenter({ deps, log: () => {} });

// 调用点也照 bridge2.mjs 那样包 try/catch
try { tiv.status("🎙 listening") } catch (e) { escaped = "status threw: " + e.message }
try { tiv.caption("user", "测试") } catch (e) { escaped = "caption threw: " + e.message }
try { tiv.error("语音会话错误:test") } catch (e) { escaped = "error threw: " + e.message }

await new Promise(r => setTimeout(r, 1500));

console.log("三个注入函数全部抛异常的情况下:");
console.log("  记下的 TIV-ERR:", JSON.stringify(log));
console.log("  有没有异常逃出来:", escaped ?? "没有");
console.log(escaped ? "❌ 显示失败会影响调用方" : "✅ 显示失败被完全吞住,不会影响语音会话");
process.exit(0);
