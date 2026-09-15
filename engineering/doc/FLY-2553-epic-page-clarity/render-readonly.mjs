// Run from the checkout root after pnpm -r build.
// v5 rework: requires the explicitly authorized readonly snapshot pair. Never opens live databases.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const out = resolve(process.argv[2] ?? "/tmp/fly2553-v5-snapshots");
assert(process.argv[3] && process.argv[4], "usage: render-readonly.mjs OUTPUT_DIR STATE_SNAPSHOT COMM_SNAPSHOT");
const statePath = realpathSync(process.argv[3]);
const commPath = realpathSync(process.argv[4]);
assert(statePath !== realpathSync(join(homedir(), ".flywheel/teamlead.db")), "live StateStore is forbidden");
assert(commPath !== realpathSync(join(homedir(), ".flywheel/comm/flywheel/comm.db")), "live CommDB is forbidden");
const snapshots = [statePath, commPath].map(path => ({path, sha256:createHash("sha256").update(readFileSync(path)).digest("hex")}));
mkdirSync(out, {recursive:true, mode:0o700});
const load = file => import(pathToFileURL(join(root,"packages/teamlead/dist",file)).href);
const {StateStore,readEpicItemFacts} = await load("StateStore.js");
const {materializeEpicPage} = await load("epic-page/materialize.js");
const {fetchLinearActiveScopeSnapshot} = await load("bridge/linear-epic-query.js");
const {readAttentionSources,readChildThreads} = await load("epic-page/attention-sources.js");
const {readSignals} = await load("epic-page/signals.js");
const {generateAttentionEpicPage} = await load("epic-page/generate.js");
const {buildEpicPageRenderReceipt} = await load("epic-page/receipt.js");
const {renderEpicPageBundle,renderEpicPageHtml} = await load("epic-page/render-html.js");
const {attentionAudience} = await load("epic-page/attention-presentation.js");
const {injectHeadMeta} = await load("bridge/report-registry.js");
const require = createRequire(join(root,"packages/flywheel-comm/package.json"));
const {CommDB} = require("./dist/db.js");
const Database = require("better-sqlite3");
const projects = JSON.parse(readFileSync(join(homedir(),".flywheel/projects.json"),"utf8"));
const project = projects.find(p => p.projectName === "flywheel");
assert(project?.linear && process.env.LINEAR_API_KEY, "project binding and Linear read credential required");
const store = await StateStore.openForMaintenance(statePath,{readonly:true});
const raw = new Database(commPath,{readonly:true,fileMustExist:true});
const stateRaw = new Database(statePath,{readonly:true,fileMustExist:true});
const started = new Date();
let read;
try {
 const counts = raw.prepare("SELECT q.kind,s.status,count(*) n FROM mailbox q LEFT JOIN sessions s ON s.execution_id=q.from_agent WHERE q.type='question' AND q.relay_state!='terminal_disposed' AND q.superseded_at IS NULL AND COALESCE(q.checkpoint,'') NOT IN ('review_design','review_code') AND NOT EXISTS(SELECT 1 FROM mailbox r WHERE r.ref_id=q.id AND r.type='response') GROUP BY q.kind,s.status").all();
 const generated = await materializeEpicPage({
 fetchSnapshot: fetchLinearActiveScopeSnapshot,
 readAttention: async (request,now,scopeSnapshot) => {
  read = await readAttentionSources({stateStore:store,openCommReadonly:()=>CommDB.openReadonly(commPath)},{...request,now,scopeSnapshot,channelIds:project.leads.map(l=>l.chatChannel)});
  return read;
 },
 readChildThreads:(name,items,now)=>readChildThreads(store,name,items,project.leads.map(l=>l.chatChannel),now),
 readItemFacts:(name,item)=>readEpicItemFacts(store,name,item),
 readSignals:(projectName,items,now)=>readSignals({stateStore:store,openCommReadonly:()=>CommDB.openReadonly(commPath)},{projectName,items,now}),
 readLeadNotes:(name,ids)=>store.getLeadNotes(name,ids),
 readFreshness:name=>{
  // Only the columns deployed on this host; optional digest columns are not
  // freshness inputs. Missing judgment tables remain explicit reader failures.
  const row = stateRaw.prepare("SELECT token,first_published_at,last_published_at,last_version FROM epic_page_publication WHERE project_name=?").get(name);
  return {history:store.getEpicPageFreshness(name),publication:row?{...row,published:row.first_published_at!==null}:undefined};
 },
 generatePage:generateAttentionEpicPage,
 buildReceipt:buildEpicPageRenderReceipt,
 now:()=>started,
 },{projectName:"flywheel",binding:project.linear,apiKey:process.env.LINEAR_API_KEY,trigger:"manual",version:1,reasons:["manual"]});
 const bundle = renderEpicPageBundle(generated.page,started);
 const html = injectHeadMeta(bundle.html);
 const standalone = injectHeadMeta(renderEpicPageHtml(generated.page,started));
 const founder=attentionAudience(generated.page,true),lead=attentionAudience(generated.page,false);
 const receipt={readStarted:started.toISOString(),readEnded:new Date().toISOString(),mode:"authorized-readonly-snapshot-pair",snapshots,schemaLimitations:["production ship_judgment_opinion absent: reader reports missing","publication optional digest columns absent: selected deployed freshness columns"],sourceCounts:counts,attentionReads:read.reads,roots:generated.page.header.roots.value?.length,items:generated.page.items.length,founderItems:founder.map(r=>({identifier:r.item.identifier.value,kinds:r.item.sources.map(s=>s.fact.value?.kind),olderQuestions:r.olderQuestions})),leadItems:lead.length,standaloneBytes:Buffer.byteLength(standalone),rawBytes:Buffer.byteLength(bundle.html),hardenedBytes:Buffer.byteLength(html),html:join(out,"index.html"),auditBytes:bundle.audit.bytes};
 mkdirSync(join(out,bundle.audit.sha256),{recursive:true});
 writeFileSync(join(out,bundle.audit.path),bundle.audit.json);
 writeFileSync(join(out,"index.html"),html);
 writeFileSync(join(out,"standalone.html"),standalone);
 assert(Buffer.byteLength(standalone) <= 512*1024,"standalone exceeds publication limit");
 writeFileSync(join(out,"document.json"),JSON.stringify(generated.page));
 writeFileSync(join(out,"receipt.json"),JSON.stringify(receipt,null,2));
 assert(html.includes('http-equiv="Content-Security-Policy"'));
 assert(/<script nonce="[^"]+">/.test(html));
 assert(!html.includes("__CSP_NONCE__"));
 assert(!/<(?:script|iframe|img)\b[^>]*\bsrc=/i.test(html));
 console.log(JSON.stringify(receipt));
 assert(bundle.html.length > 0);
 assert(receipt.rawBytes <= 80*1024, "production HTML exceeds 80KiB");
 assert(founder.length <= 5, "production founder items exceed expected C6 bound; inspect actual sources");
} finally {
 raw.close();
 stateRaw.close();
 store.close();
}
