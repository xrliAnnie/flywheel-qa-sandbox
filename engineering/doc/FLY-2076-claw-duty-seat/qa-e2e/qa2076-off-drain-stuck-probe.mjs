import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = "/Users/xiaorongli/Dev/flywheel-FLY-2076";
const tl = (p) => import(join(root, "packages/teamlead/dist", p));
const { StateStore } = await tl("StateStore.js");
const { LeadAlertNotifier } = await tl("LeadAlertNotifier.js");
const tmp = mkdtempSync(join(tmpdir(), "drainprobe-"));
const store = await StateStore.create(join(tmp, "s.db"));
let enabled = true;
const projects = [{ projectName:"p", projectRoot:"/tmp/p", generalChannel:"c1",
  leads:[{ agentId:"lead-a", chatChannel:"c1", match:{labels:["x"]}, alertChannel:"c1", alertBotTokenEnv:"FAKE_TOK", botUserId:"1" }] }];
process.env.FAKE_TOK = "fake";
const n = new LeadAlertNotifier({
  store, projects,
  deliveryEnabled: () => enabled,
  queueDir: join(tmp,"queue"), deadLetterDir: join(tmp,"dl"),
  fetchFn: async () => ({ ok:false, status:503, statusText:"Service Unavailable", text: async()=>"" }),
});
const r1 = await n.alert({ leadId:"lead-a", projectName:"p", eventId:"e1", eventType:"rate_limit", title:"t", body:"b", severity:"warning" });
console.log("alert while ON with 503 backend ->", JSON.stringify(r1));
enabled = false;
const d = await n.drainQueue();
console.log("drainQueue while OFF ->", JSON.stringify({sent:d.sent, remaining:d.remaining, deadLettered:d.deadLettered, staleSuppressed:d.staleSuppressed}));
console.log("plugin condition (sent===0 && remaining>0) ->", d.sent===0 && d.remaining>0);
store.close?.();
