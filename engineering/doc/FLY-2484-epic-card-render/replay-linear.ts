import { buildFounderView, compareIdentifier } from "../../../packages/teamlead/src/epic-page/founder-view.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJsonString } from "../../../packages/config/src/canonical-json.js";
import type { LinearActiveScopeSnapshot } from "../../../packages/teamlead/src/bridge/linear-epic-query.js";
import { generateEpicPage } from "../../../packages/teamlead/src/epic-page/generate.js";
import { renderEpicPageBundle } from "../../../packages/teamlead/src/epic-page/render-html.js";
import { extractAcceptance } from "../../../packages/teamlead/src/epic-page/rules.js";
import type { EpicItemFacts } from "../../../packages/teamlead/src/StateStore.js";

type RawIssue = { id: string; identifier: string; title: string; url: string; updatedAt: string; priority: number; description: string | null; state: { name: string; type: string }; labels: string[]; parent: { id: string; identifier: string } | null; blocked_by: Array<{ id: string; identifier: string; state_type: string }> };
const sourceBytes = readFileSync(new URL("../FLY-2482-scope-v2-parent-counts/linear-snapshot.json", import.meta.url));
assert.equal(createHash("sha256").update(sourceBytes).digest("hex"), "16281a5788d09b465c350a9e6f953e699ba9a69414dde89128390399ad59c99d");
const source = JSON.parse(sourceBytes.toString()) as { observed_at: string; roots: RawIssue[]; items: RawIssue[] };
const all = new Map([...source.roots, ...source.items].map(item => [item.identifier, item]));
const ids = new Set(source.items.map(item => item.id));
const snapshot: LinearActiveScopeSnapshot = {
 fetchedAt: source.observed_at,
 boundary: { teamKey: "FLY", project: "Flywheel", label: "Flywheel" },
 descendantIds: source.items.map(item => item.id),
 roots: source.roots,
 items: source.items.map(item => ({ ...item, acceptance: extractAcceptance(item.description), blockedBy: item.blocked_by.map(blocker => {
  const original = all.get(blocker.identifier); assert.ok(original, `missing blocker title/url: ${blocker.identifier}`);
  return { id: blocker.id, identifier: blocker.identifier, title: original.title, url: original.url, stateType: blocker.state_type, inScope: ids.has(blocker.id) };
 }) })),
};
const missingFacts: EpicItemFacts = {
 session: { ok: false, table: "offline replay: sessions not read" },
 run: { ok: false, table: "offline replay: workflow_run not read" },
 attempt: { ok: false, table: "offline replay: workflow_run_node not read" },
 gates: { ok: false, table: "offline replay: workflow_gate_holder not read" },
 carriers: { ok: false, table: "offline replay: workflow_carrier_delivery not read" },
 land: { ok: false, table: "offline replay: land_operation not read" },
};
function generate(input: LinearActiveScopeSnapshot) {
 return generateEpicPage({ snapshot: input, itemFacts: input.items.map(() => missingFacts), itemSignals: input.items.map(item => ({ signals: [], signal_sources: {
 statestore: { value: null, observed_at: source.observed_at, provenance: { kind: "statestore", table: "sessions", key: { issue_id: item.id } }, missing: { reason: "statestore_error", detail: "offline replay: not read" } },
 commdb: { value: null, observed_at: source.observed_at, provenance: { kind: "commdb", table: "questions", key: { issue_identifier: item.identifier } }, missing: { reason: "commdb_error", detail: "offline replay: not read" } },
 } })), now: new Date(source.observed_at), projectName: "flywheel", trigger: "manual" });
}
const page = generate(snapshot);
assert.equal(page.items.length, source.items.length);
for (const [index, item] of page.items.entries()) {
 assert.ok(item.parent.value);
 assert.equal(item.parent.value, source.items[index]!.parent!.identifier);
}
const rootIds = new Set(source.roots.map(root => root.identifier));
const counts = new Map(source.roots.map(root => [root.identifier, { live: 0, waiting: 0, free: 0, idle: 0, done: 0, canceled: 0, total: 0 }]));
// Independent raw-Linear classification, without calling computeRootCounts.
for (const item of source.items) {
 let parent = item.parent?.identifier; const seen = new Set<string>();
 while (parent && !rootIds.has(parent)) { assert.ok(!seen.has(parent)); seen.add(parent); parent = all.get(parent)?.parent?.identifier; }
 assert.ok(parent); const count = counts.get(parent)!; assert.ok(count); count.total++;
 const type = item.state.type;
 if (type === "started") count.live++;
 else if (type === "completed") count.done++;
 else if (type === "canceled") count.canceled++;
 else {
  assert.ok(["backlog", "unstarted", "triage"].includes(type));
  if (!item.blocked_by.length) count.idle++;
  else if (item.blocked_by.every(blocker => blocker.state_type === "completed")) count.free++;
  else count.waiting++;
 }
}
for (const cell of page.header.root_counts) { assert.ok(cell.value); assert.deepEqual(cell.value.counts, counts.get(cell.value.root)); }
const previous = structuredClone(snapshot); previous.items = previous.items.filter(item => item.state.type !== "backlog");
const previousIds = new Set(previous.items.map(item => item.id));
for (const item of previous.items) for (const blocker of item.blockedBy) blocker.inScope = previousIds.has(blocker.id);
const before = generate(previous);
for (const key of ["ready_items", "dependency_review", "stuck_items"] as const) assert.equal(canonicalJsonString(page[key].value), canonicalJsonString(before[key].value));
const bundle = renderEpicPageBundle(page, new Date(source.observed_at));
const html = bundle.html;
assert.ok(Buffer.byteLength(html) <= 524288);
const view = buildFounderView(page);
const expectedRoots = [...counts].filter(([,c])=>c.live+c.waiting+c.free+c.idle>0).map(([id])=>id).sort(compareIdentifier);
assert.deepEqual(view.epics.map(e=>e.identifier),expectedRoots);
for (const epic of view.epics) {
 const rawChildren=source.items.filter(item=>{
  let parent=item.parent?.identifier;
  while(parent && !rootIds.has(parent)) parent=all.get(parent)?.parent?.identifier;
  return parent===epic.identifier && !["completed","canceled"].includes(item.state.type);
 }).map(item=>item.identifier).sort(compareIdentifier);
 assert.deepEqual(epic.children.map(c=>c.identifier).sort(compareIdentifier),rawChildren);
 const rawRoot=all.get(epic.identifier)!;
 assert.deepEqual(epic.state,rawRoot.state);
}
assert.deepEqual([...html.matchAll(/data-root="([^"]+)"/g)].map(m=>m[1]),expectedRoots);
assert.equal((html.match(/<details[^>]* open/g)||[]).length,0);
assert.equal(renderEpicPageBundle(page,new Date(source.observed_at)).html,html);
const e1=JSON.parse(readFileSync(new URL("../FLY-2482-scope-v2-parent-counts/linear-replay-result.json",import.meta.url),"utf8"));
assert.deepEqual([...counts].map(([root,value])=>({root,...value})),e1.counts);
const htmlPath = process.argv[2] ?? "/tmp/fly2484-linear/index.html";
const auditPath = join(dirname(htmlPath),bundle.audit.path);
mkdirSync(dirname(auditPath),{recursive:true});
writeFileSync(auditPath,bundle.audit.json);
writeFileSync(htmlPath,html);
const result = { visible_roots:expectedRoots, visible_children:view.epics.reduce((n,e)=>n+e.children.length,0), hidden_roots:view.hiddenDoneEpics?.count, html_byte_identical:true, initial_open_details:0, observed_at: source.observed_at, source_sha256: createHash("sha256").update(sourceBytes).digest("hex"), roots: source.roots.length, items: page.items.length, previous_items: before.items.length, parents_matched: page.items.length, counts: [...counts].map(([root, value]) => ({ root, ...value })), regression: "ready/dependency/stuck values equal for same frozen inputs", document_bytes: Buffer.byteLength(canonicalJsonString(page)), html_bytes: Buffer.byteLength(html), audit_bytes: bundle.audit.bytes, audit_sha256: bundle.audit.sha256, audit_entries: bundle.audit.entries, runtime_facts: "StateStore and CommDB explicitly missing; offline Linear replay, not fixed-page production acceptance" };
writeFileSync(fileURLToPath(new URL("./linear-replay-result.json", import.meta.url)), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
