#!/usr/bin/env node

import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const packageRequire = createRequire(
	join(repoRoot, "packages/teamlead/package.json"),
);
const Database = packageRequire("better-sqlite3");

export const RETIRED_TEMPLATE_IDS = Object.freeze([
	"tpl_eng_heavy",
	"tpl_product_v1",
	"tpl_product_designer",
	"tpl_product_prototype",
	"tpl_generic",
	"tpl_eng",
	"tpl_eng_land_v1",
	"tpl_eng_heavy_land_v1",
	"tpl_eng_light",
	"tpl_eng_light_land_v1",
	"tpl_eng_trivial",
	"tpl_eng_trivial_land_v1",
]);

const RETIRED_TEMPLATE_SET = new Set(RETIRED_TEMPLATE_IDS);
const RETIREMENT_ACTOR = "system:FLY-1693-retirement";
const ROLLBACK_ACTOR = "system:FLY-1693-rollback";
const ROLLBACK_REASON = "FLY-1693 founder-approved retirement rollback";
const SYSTEM_BINDING_OWNERS = new Set([
	"system:bundled-default",
	"system:FLY-1434-land-migration",
	"system:FLY-1434-land-rollback",
]);

function usage() {
	return `Usage:
  node scripts/fly-1693-rollback-retirement.mjs [--apply] [--db PATH]
    (--after-audit-id N | --audit-ids ID[,ID...])

Dry-run is the default. It reads a temporary snapshot without opening or
changing the source database or its WAL/SHM sidecars.
--apply takes a BEGIN IMMEDIATE lock, validates every selected source audit and
binding, then atomically clears retired_at, restores absent bindings, and
records rollback rebind audits.`;
}

function parseNonNegativeInteger(value, name) {
	if (!/^(0|[1-9]\d*)$/.test(value ?? "")) {
		throw new Error(`${name}_must_be_non_negative_integer`);
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) {
		throw new Error(`${name}_must_be_safe_integer`);
	}
	return parsed;
}

function parsePositiveInteger(value, name) {
	const parsed = parseNonNegativeInteger(value, name);
	if (parsed === 0) throw new Error(`${name}_must_be_positive_integer`);
	return parsed;
}

function parseArgs(argv) {
	const parsed = {
		apply: false,
		dbPath: join(homedir(), ".flywheel", "teamlead.db"),
		afterAuditId: undefined,
		auditIds: undefined,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--apply") {
			parsed.apply = true;
		} else if (arg === "--db") {
			const value = argv[++index];
			if (!value) throw new Error("database_path_required");
			parsed.dbPath = resolve(value);
		} else if (arg === "--after-audit-id") {
			parsed.afterAuditId = parseNonNegativeInteger(
				argv[++index],
				"after_audit_id",
			);
		} else if (arg === "--audit-ids") {
			const value = argv[++index];
			if (!value) throw new Error("audit_ids_required");
			const ids = value
				.split(",")
				.map((item) => parsePositiveInteger(item, "audit_id"));
			if (new Set(ids).size !== ids.length) {
				throw new Error("duplicate_audit_id");
			}
			parsed.auditIds = ids;
		} else if (arg === "--help" || arg === "-h") {
			return { help: true };
		} else {
			throw new Error(`unknown_argument:${arg}`);
		}
	}
	if ((parsed.afterAuditId === undefined) === (parsed.auditIds === undefined)) {
		throw new Error("exactly_one_audit_selector_required");
	}
	return parsed;
}

function assertNonEmptyField(value, field, auditId) {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`invalid_${field}:audit_id=${auditId}`);
	}
	if (value !== value.trim()) {
		throw new Error(`noncanonical_${field}:audit_id=${auditId}`);
	}
	return value;
}

function validateSourceAudit(row) {
	const auditId = Number(row?.id);
	if (!Number.isSafeInteger(auditId) || auditId <= 0) {
		throw new Error("invalid_source_audit_id");
	}
	if (row.action !== "unbind") {
		throw new Error(`source_audit_action_not_unbind:audit_id=${auditId}`);
	}
	if (row.actor !== RETIREMENT_ACTOR) {
		throw new Error(`source_audit_actor_mismatch:audit_id=${auditId}`);
	}
	const templateId = assertNonEmptyField(
		row.template_id,
		"template_id",
		auditId,
	);
	if (!RETIRED_TEMPLATE_SET.has(templateId)) {
		throw new Error(`source_audit_template_not_retired:audit_id=${auditId}`);
	}
	let detail;
	try {
		detail =
			typeof row.detail === "string" ? JSON.parse(row.detail) : row.detail;
	} catch {
		throw new Error(`source_audit_detail_malformed:audit_id=${auditId}`);
	}
	if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
		throw new Error(`source_audit_detail_malformed:audit_id=${auditId}`);
	}
	const project = assertNonEmptyField(detail.project, "project", auditId);
	const taskCategory = assertNonEmptyField(
		detail.task_category,
		"task_category",
		auditId,
	);
	const removedTemplateId = assertNonEmptyField(
		detail.removed_template_id,
		"removed_template_id",
		auditId,
	);
	if (templateId !== removedTemplateId) {
		throw new Error(`source_audit_template_mismatch:audit_id=${auditId}`);
	}
	const previousOwner = assertNonEmptyField(
		detail.previous_owner,
		"previous_owner",
		auditId,
	);
	if (!SYSTEM_BINDING_OWNERS.has(previousOwner)) {
		throw new Error(`source_audit_owner_not_system:audit_id=${auditId}`);
	}
	return {
		auditId,
		project,
		taskCategory,
		templateId,
		previousOwner,
	};
}

function loadSourceAudits(db, selector) {
	let rows;
	if (selector.auditIds !== undefined) {
		const placeholders = selector.auditIds.map(() => "?").join(",");
		rows = db
			.prepare(
				`SELECT id, actor, action, template_id, detail
				 FROM workflow_template_audit
				 WHERE id IN (${placeholders})
				 ORDER BY id`,
			)
			.all(...selector.auditIds);
		const found = new Set(rows.map((row) => Number(row.id)));
		for (const auditId of selector.auditIds) {
			if (!found.has(auditId)) {
				throw new Error(`source_audit_missing:audit_id=${auditId}`);
			}
		}
	} else {
		rows = db
			.prepare(
				`SELECT id, actor, action, template_id, detail
				 FROM workflow_template_audit
				 WHERE id > ? AND action = 'unbind' AND actor = ?
				 ORDER BY id`,
			)
			.all(selector.afterAuditId, RETIREMENT_ACTOR);
	}
	return rows.map(validateSourceAudit);
}

function expectedBindings(sourceAudits) {
	const expected = new Map();
	for (const source of sourceAudits) {
		const key = JSON.stringify([source.project, source.taskCategory]);
		const current = expected.get(key);
		if (
			current &&
			(current.templateId !== source.templateId ||
				current.previousOwner !== source.previousOwner)
		) {
			throw new Error(
				`duplicate_binding_expectation_conflict:${source.project}:${source.taskCategory}`,
			);
		}
		if (!current || source.auditId > current.auditId) expected.set(key, source);
	}
	return [...expected.values()].sort(
		(left, right) =>
			left.project.localeCompare(right.project) ||
			left.taskCategory.localeCompare(right.taskCategory),
	);
}

function inspectBindings(db, expected) {
	const states = [];
	const select = db.prepare(
		`SELECT project, task_category, template_id, updated_by
		 FROM workflow_category_binding
		 WHERE project = ? AND task_category = ?`,
	);
	for (const item of expected) {
		const current = select.get(item.project, item.taskCategory);
		const state = !current
			? "absent"
			: current.template_id === item.templateId &&
					current.updated_by === item.previousOwner
				? "equal"
				: "different";
		states.push({ ...item, state, current: current ?? null });
	}
	return states;
}

function countRetired(db) {
	const placeholders = RETIRED_TEMPLATE_IDS.map(() => "?").join(",");
	return Number(
		db
			.prepare(
				`SELECT count(*) AS count FROM workflow_template
				 WHERE template_id IN (${placeholders}) AND retired_at IS NOT NULL`,
			)
			.get(...RETIRED_TEMPLATE_IDS).count,
	);
}

function buildReport(mode, db, sourceAudits, bindingStates) {
	const bindingCounts = { absent: 0, equal: 0, different: 0 };
	for (const item of bindingStates) bindingCounts[item.state] += 1;
	return {
		mode,
		retiredN: countRetired(db),
		sourceAudits,
		bindings: bindingCounts,
		bindingStates,
		statements: [
			`UPDATE workflow_template SET retired_at = NULL WHERE template_id IN (${RETIRED_TEMPLATE_IDS.map(() => "?").join(",")}) AND retired_at IS NOT NULL`,
			"INSERT INTO workflow_category_binding (project, task_category, template_id, updated_by) VALUES (?, ?, ?, ?)",
			"INSERT INTO workflow_template_audit (actor, action, template_id, detail) VALUES (?, 'rebind', ?, ?)",
		],
	};
}

function validateAndInspect(db, selector) {
	const sourceAudits = loadSourceAudits(db, selector);
	const expected = expectedBindings(sourceAudits);
	const bindingStates = inspectBindings(db, expected);
	return { sourceAudits, bindingStates };
}

function openDryRunSnapshot(dbPath) {
	const sourcePath = resolve(dbPath);
	if (!existsSync(sourcePath)) {
		throw new Error(`database_missing:${sourcePath}`);
	}
	const snapshotRoot = mkdtempSync(join(tmpdir(), "fly1693-rollback-ro-"));
	const snapshotPath = join(snapshotRoot, "teamlead.db");
	try {
		copyFileSync(sourcePath, snapshotPath);
		for (const suffix of ["-wal", "-shm"]) {
			if (existsSync(`${sourcePath}${suffix}`)) {
				copyFileSync(`${sourcePath}${suffix}`, `${snapshotPath}${suffix}`);
			}
		}
		return {
			db: new Database(snapshotPath, { readonly: true, fileMustExist: true }),
			close() {
				rmSync(snapshotRoot, { recursive: true, force: true });
			},
		};
	} catch (error) {
		rmSync(snapshotRoot, { recursive: true, force: true });
		throw error;
	}
}

export function executeRollback(input) {
	if (
		!input ||
		typeof input.dbPath !== "string" ||
		input.dbPath.trim() === ""
	) {
		throw new Error("database_path_required");
	}
	if ((input.afterAuditId === undefined) === (input.auditIds === undefined)) {
		throw new Error("exactly_one_audit_selector_required");
	}
	const selector = {
		afterAuditId: input.afterAuditId,
		auditIds: input.auditIds,
	};
	const apply = input.apply === true;
	const dryRunSnapshot = apply ? undefined : openDryRunSnapshot(input.dbPath);
	const db =
		dryRunSnapshot?.db ??
		new Database(resolve(input.dbPath), { fileMustExist: true });
	try {
		if (!apply) {
			const { sourceAudits, bindingStates } = validateAndInspect(db, selector);
			return buildReport("dry-run", db, sourceAudits, bindingStates);
		}

		db.pragma(`busy_timeout = ${input.busyTimeoutMs ?? 5_000}`);
		db.pragma("foreign_keys = ON");
		db.exec("BEGIN IMMEDIATE");
		try {
			input.testHooks?.afterBegin?.();
			const { sourceAudits, bindingStates } = validateAndInspect(db, selector);
			const report = buildReport("apply", db, sourceAudits, bindingStates);
			const conflicts = bindingStates.filter(
				(item) => item.state === "different",
			);
			if (conflicts.length > 0) {
				throw new Error(
					`binding_conflict:${conflicts
						.map((item) => `${item.project}:${item.taskCategory}`)
						.join(",")}`,
				);
			}

			const templatePlaceholders = RETIRED_TEMPLATE_IDS.map(() => "?").join(
				",",
			);
			const cleared = db
				.prepare(
					`UPDATE workflow_template SET retired_at = NULL
					 WHERE template_id IN (${templatePlaceholders})
					   AND retired_at IS NOT NULL`,
				)
				.run(...RETIRED_TEMPLATE_IDS).changes;
			const insertBinding = db.prepare(
				`INSERT INTO workflow_category_binding
				 (project, task_category, template_id, updated_by)
				 VALUES (?, ?, ?, ?)`,
			);
			const insertAudit = db.prepare(
				`INSERT INTO workflow_template_audit
				 (actor, action, template_id, detail)
				 VALUES (?, 'rebind', ?, ?)`,
			);
			let restored = 0;
			for (const item of bindingStates.filter(
				(row) => row.state === "absent",
			)) {
				insertBinding.run(
					item.project,
					item.taskCategory,
					item.templateId,
					item.previousOwner,
				);
				insertAudit.run(
					ROLLBACK_ACTOR,
					item.templateId,
					JSON.stringify({
						project: item.project,
						task_category: item.taskCategory,
						source_unbind_audit_id: item.auditId,
						restored_owner: item.previousOwner,
						reason: ROLLBACK_REASON,
					}),
				);
				restored += 1;
			}
			db.exec("COMMIT");
			return { ...report, cleared, restored };
		} catch (error) {
			if (db.inTransaction) db.exec("ROLLBACK");
			throw error;
		}
	} finally {
		db.close();
		dryRunSnapshot?.close();
	}
}

function runCli() {
	try {
		const args = parseArgs(process.argv.slice(2));
		if (args.help) {
			process.stdout.write(`${usage()}\n`);
			return;
		}
		const report = executeRollback(args);
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	} catch (error) {
		process.stderr.write(
			`fly1693_rollback_error: ${
				error instanceof Error ? error.message : String(error)
			}\n`,
		);
		process.exitCode = 1;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) runCli();
