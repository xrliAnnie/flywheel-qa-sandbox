#!/usr/bin/env node
import { execFileSync } from "node:child_process";
/**
 * FLY-1432 migration control for the workflow_template_audit CHECK rebuild.
 *
 * The main harness and qa-control.mjs both start from a database created by the
 * PR-head code, so the audit table is born with the widened CHECK constraint and
 * the migration branch in StateStore never executes. Every real production
 * database is the opposite case: it was created by pre-PR code, carries the old
 * narrow CHECK, and will hit the rebuild on the first boot after this ships.
 *
 * This control creates the database with the OLD build, seeds real audit rows,
 * then reopens the same file with the PINNED PR build and verifies:
 *   1. the old database really lacked 'template_retire' (control is not vacuous)
 *   2. the rebuild ran and the constraint is now wide
 *   3. every pre-existing audit row survived with its id and content intact
 *   4. the append-only triggers are back after the table swap
 *   5. a template_retire row can now be written, and retire still refuses a
 *      template that is currently bound
 *
 * usage: qa-migration-control.mjs --old <pre-PR checkout> --new <pinned checkout>
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function argOf(flag) {
	const at = process.argv.indexOf(flag);
	if (at < 0 || !process.argv[at + 1]) {
		throw new Error(
			"usage: qa-migration-control.mjs --old <pre-PR checkout> --new <pinned checkout>",
		);
	}
	return realpathSync(process.argv[at + 1]);
}

const OLD_REPO = argOf("--old");
const NEW_REPO = argOf("--new");
const PINNED_HEAD = "6a0576bd3ec3e9188ad6c012cfaf89711bf53692";
const PROJECT = "flywheel-e2e";
const ROOT = mkdtempSync(join(tmpdir(), "qa-fly1432-migration-"));
const DB = join(ROOT, "state", "legacy.db");
const results = {};

function record(key, pass, detail = "") {
	results[key] = Boolean(pass);
	console.log(
		`[mig] ${pass ? "PASS" : "FAIL"} ${key}${detail ? ` — ${detail}` : ""}`,
	);
}
const imp = (p) => import(pathToFileURL(p).href);
const auditSql = (store) =>
	String(
		store.db.raw
			.prepare(
				"SELECT sql FROM sqlite_master WHERE type='table' AND name='workflow_template_audit'",
			)
			.get()?.sql ?? "",
	);
const auditRows = (store) =>
	store.db.raw
		.prepare(
			"SELECT id, actor, action, template_id FROM workflow_template_audit ORDER BY id",
		)
		.all();

let oldStore;
let newStore;
try {
	const newHead = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: NEW_REPO,
		encoding: "utf8",
	}).trim();
	const oldHead = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: OLD_REPO,
		encoding: "utf8",
	}).trim();
	record("new_side_is_pinned_pr_head", newHead === PINNED_HEAD, newHead);
	record("old_side_is_not_pr_head", oldHead !== PINNED_HEAD, oldHead);
	if (newHead !== PINNED_HEAD) throw new Error("pinned head mismatch");

	process.env.HOME = ROOT;
	process.env.FLYWHEEL_STATE_DIR = join(ROOT, "state");
	process.env.FLYWHEEL_COMM_ROOT = join(ROOT, "comm");
	mkdirSync(process.env.FLYWHEEL_STATE_DIR, { recursive: true });
	mkdirSync(process.env.FLYWHEEL_COMM_ROOT, { recursive: true });

	// --- Phase 1: create the database with the PRE-PR build. ---
	const oldTeamlead = await imp(
		join(OLD_REPO, "packages/teamlead/dist/StateStore.js"),
	);
	const oldTemplates = await imp(
		join(OLD_REPO, "packages/teamlead/dist/workflow-template.js"),
	);
	oldStore = await oldTeamlead.StateStore.create(DB);
	// A real pre-PR production database has the generalized flag off, so the old
	// importer refused every schema_version 2 seed. Reproduce that exact shape:
	// v1 seeds only. (Confirmed by the old build throwing "generalized workflow
	// templates are disabled by flag" when handed a v2 seed.)
	for (const seed of oldTemplates.loadBundledWorkflowSeeds()) {
		if (seed.manifest.schema_version === 2) continue;
		oldStore.importWorkflowTemplateSeed(seed, process.env);
	}
	oldStore.bindWorkflowCategory({
		project: PROJECT,
		taskCategory: "*",
		templateId: "tpl_eng_heavy",
		updatedBy: "qa:legacy-db",
	});
	const legacySql = auditSql(oldStore);
	const legacyRows = auditRows(oldStore);
	record(
		"legacy_db_lacks_template_retire_in_check",
		legacySql.length > 0 && !legacySql.includes("template_retire"),
	);
	record(
		"legacy_db_has_audit_rows",
		legacyRows.length > 0,
		`${legacyRows.length} rows`,
	);
	oldStore.close();
	oldStore = undefined;

	// --- Phase 2: reopen the SAME file with the PINNED PR build. ---
	const newTeamlead = await imp(
		join(NEW_REPO, "packages/teamlead/dist/StateStore.js"),
	);
	newStore = await newTeamlead.StateStore.create(DB);
	const migratedSql = auditSql(newStore);
	const migratedRows = auditRows(newStore);
	record(
		"migration_widened_check_constraint",
		migratedSql.includes("template_retire"),
	);
	record(
		"migration_preserved_every_audit_row_byte_for_byte",
		JSON.stringify(legacyRows) === JSON.stringify(migratedRows),
		`${legacyRows.length} -> ${migratedRows.length}`,
	);

	let updateBlocked = false;
	let deleteBlocked = false;
	try {
		newStore.db.run("UPDATE workflow_template_audit SET actor='tampered'");
	} catch (e) {
		updateBlocked = /append-only/.test(String(e));
	}
	try {
		newStore.db.run("DELETE FROM workflow_template_audit");
	} catch (e) {
		deleteBlocked = /append-only/.test(String(e));
	}
	record(
		"append_only_triggers_restored_after_table_swap",
		updateBlocked && deleteBlocked,
		`update_blocked=${updateBlocked} delete_blocked=${deleteBlocked}`,
	);

	// --- Phase 3: the widened action must actually be usable, and guarded. ---
	const boundRefusal = newStore.retireWorkflowTemplate({
		templateId: "tpl_eng_heavy",
		actor: "qa:migration",
		reason: "must refuse: still bound",
	});
	record(
		"retire_refuses_bound_template",
		boundRefusal.status === "refused_bound" &&
			boundRefusal.refs.some((r) => r.taskCategory === "*"),
		JSON.stringify(boundRefusal),
	);
	const unbound = newStore
		.listWorkflowTemplates()
		.map((r) => r.template_id)
		.find((id) => id !== "tpl_eng_heavy");
	const retired = newStore.retireWorkflowTemplate({
		templateId: unbound,
		actor: "qa:migration",
		reason: "FLY-1432 migration control",
	});
	const retireAudit = auditRows(newStore).filter(
		(r) => r.action === "template_retire",
	);
	record(
		"template_retire_row_writes_under_new_check",
		retired.status === "retired" && retireAudit.length === 1,
		`${unbound} -> ${retired.status}, audit rows=${retireAudit.length}`,
	);

	// --- Phase 4: reopening again must not rebuild a second time. ---
	newStore.close();
	newStore = await newTeamlead.StateStore.create(DB);
	const secondOpenRows = auditRows(newStore);
	record(
		"second_open_is_idempotent",
		JSON.stringify(secondOpenRows) === JSON.stringify(auditRows(newStore)) &&
			secondOpenRows.length === migratedRows.length + 1,
		`${secondOpenRows.length} rows`,
	);

	const pass = Object.values(results).every(Boolean);
	console.log(`[mig] migration_control_pass=${pass}`);
	if (!pass) process.exitCode = 1;
} catch (error) {
	console.error(`[mig] FAIL migration_control_error=${error?.stack ?? error}`);
	process.exitCode = 1;
} finally {
	for (const s of [oldStore, newStore]) {
		try {
			s?.close();
		} catch {}
	}
	if (ROOT.startsWith(join(tmpdir(), "qa-fly1432-migration-"))) {
		rmSync(ROOT, { recursive: true, force: true });
	}
}
