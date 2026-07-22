import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = "/private/tmp/fly1432-qa-pinned";
const ROOT = mkdtempSync(join(tmpdir(), "qa-fly1432-fresh-"));
process.env.HOME = ROOT;
process.env.FLYWHEEL_STATE_DIR = join(ROOT, "state");
mkdirSync(process.env.FLYWHEEL_STATE_DIR, { recursive: true });
const imp = (p) => import(pathToFileURL(p).href);
const t = await imp(join(REPO, "packages/teamlead/dist/StateStore.js"));
const tpl = await imp(
	join(REPO, "packages/teamlead/dist/workflow-template.js"),
);
const wk = await imp(join(REPO, "packages/teamlead/dist/work-kind.js"));
const store = await t.StateStore.create(join(ROOT, "state", "fresh.db"));
for (const s of tpl.loadBundledWorkflowSeeds())
	store.importWorkflowTemplateSeed(s, process.env);
// Brand-new project: no operator has ever bound anything here.
tpl.ensureDefaultWorkflowBindings(store, ["brand-new-project"]);
const rows = store.listWorkflowCategoryBindings("brand-new-project");
console.log("[fresh] default bindings on a virgin project:");
for (const r of rows) console.log(`  ${r.task_category} -> ${r.template_id}`);
const leaked = rows.filter((r) =>
	wk.WORK_KIND_CATEGORIES.includes(r.task_category),
);
const v2leak = rows.filter((r) =>
	[
		"tpl_eng",
		"tpl_eng_land_v1",
		"tpl_product_designer",
		"tpl_product_prototype",
		"tpl_generic",
	].includes(r.template_id),
);
console.log(
	`[fresh] ${leaked.length === 0 ? "PASS" : "FAIL"} no work-kind category bound (${leaked.length})`,
);
console.log(
	`[fresh] ${v2leak.length === 0 ? "PASS" : "FAIL"} no new v2 identity bound (${v2leak.length})`,
);
console.log(
	`[fresh] WORK_KIND_CATEGORIES = ${JSON.stringify(wk.WORK_KIND_CATEGORIES)}`,
);
store.close();
rmSync(ROOT, { recursive: true, force: true });
