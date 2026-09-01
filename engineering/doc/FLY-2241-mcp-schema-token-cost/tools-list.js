// FLY-2241 — dump tools/list from a stdio MCP server; print tool count + serialized schema bytes.
const { spawn } = require("node:child_process");
const cfg = JSON.parse(process.argv[2]);
const name = Object.keys(cfg.mcpServers)[0];
const s = cfg.mcpServers[name];
const p = spawn(s.command, s.args || [], { env: { ...process.env, ...(s.env || {}) }, stdio: ["pipe","pipe","pipe"] });
let buf = "";
const send = (o) => p.stdin.write(JSON.stringify(o) + "\n");
p.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === 1) { send({ jsonrpc:"2.0", method:"notifications/initialized" }); send({ jsonrpc:"2.0", id:2, method:"tools/list", params:{} }); }
    if (m.id === 2) {
      const tools = (m.result && m.result.tools) || [];
      const bytes = Buffer.byteLength(JSON.stringify(tools), "utf8");
      console.log(`${name}\t${tools.length}\t${bytes}\t${tools.map(t=>t.name).join(",")}`);
      p.kill(); process.exit(0);
    }
  }
});
p.stderr.on("data", (d) => process.stderr.write(d));
p.on("error", (e) => { console.log(`${name}\tERR\t0\t${e.message}`); process.exit(1); });
setTimeout(() => { console.log(`${name}\tTIMEOUT\t0\t`); p.kill(); process.exit(1); }, 45000);
send({ jsonrpc:"2.0", id:1, method:"initialize", params:{ protocolVersion:"2024-11-05", capabilities:{}, clientInfo:{ name:"fly2241", version:"1" } } });
