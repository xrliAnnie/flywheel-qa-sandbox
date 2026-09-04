// FLY-2296 feasibility probe: a fake Codex app-server on a unix socket.
// Logs every JSON-RPC message the real `codex resume --remote` TUI sends and
// answers from a small table of canned results (generic `{}` otherwise).
const http = require("http");
const fs = require("fs");
const { WebSocketServer } = require("/Users/xiaorongli/Dev/flywheel/node_modules/.pnpm/ws@8.19.0/node_modules/ws");
const sock = process.argv[2];
const logf = process.argv[3];
const cannedPath = process.argv[4]; // optional JSON file: { "<method>": <result> }
const canned = cannedPath && fs.existsSync(cannedPath) ? JSON.parse(fs.readFileSync(cannedPath, "utf8")) : {};
const log = (s) => fs.appendFileSync(logf, new Date().toISOString().slice(11, 23) + " " + s + "\n");
const srv = http.createServer();
const wss = new WebSocketServer({ server: srv });
wss.on("connection", (ws, req) => {
  log("CONNECT url=" + req.url + " auth=" + (req.headers.authorization ? "yes" : "no"));
  ws.on("message", (buf) => {
    let m;
    try { m = JSON.parse(buf.toString()); } catch { log("RAW " + buf.toString().slice(0, 200)); return; }
    if (m.method && m.id !== undefined) {
      log("REQ id=" + m.id + " " + m.method + " " + JSON.stringify(m.params ?? null).slice(0, 300));
      const result = Object.prototype.hasOwnProperty.call(canned, m.method) ? canned[m.method] : {};
      ws.send(JSON.stringify({ id: m.id, result }));
      const after = canned["__after__" + m.method];
      if (after) for (const n of after) { ws.send(JSON.stringify(n)); log("SENT " + JSON.stringify(n).slice(0, 200)); }
    } else if (m.method) {
      log("NOTIFY " + m.method + " " + JSON.stringify(m.params ?? null).slice(0, 200));
    } else {
      log("RESP " + JSON.stringify(m).slice(0, 200));
    }
  });
  ws.on("close", () => log("CLOSE"));
});
srv.listen(sock, () => log("LISTEN " + sock));
