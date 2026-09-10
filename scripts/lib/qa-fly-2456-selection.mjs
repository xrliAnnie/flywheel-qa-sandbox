import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { openSnapshot } from "./qa-fly-2456-db.mjs";
/**
 * Preview the fresh master/main selection seam, not /runs/start admission.
 * Run in a fresh process with FLYWHEEL_MODELS_CONFIG already bound to the
 * explicit modelConfigPath: upstream model policy caches by file stat and ESM
 * caches the tested checkout's built helpers. Do not reuse across rebuilt files.
 * Human issue identifiers only; no Linear hydration, authorization, liveness,
 * or materialization is performed. Host menu/agent files must remain frozen.
 */
export async function previewStartSelection({
	dbPath,
	requestPath,
	checkout,
	hostRepo,
	modelConfigPath,
	now,
}) {
	let db;
	try {
		if (!isAbsolute(checkout) || !isAbsolute(hostRepo))
			throw new Error("explicit absolute checkout and hostRepo required");
		if (
			typeof modelConfigPath !== "string" ||
			!isAbsolute(modelConfigPath) ||
			process.env.FLYWHEEL_MODELS_CONFIG !== modelConfigPath
		)
			throw new Error("explicit model file must match FLYWHEEL_MODELS_CONFIG");
		const modelBytes = readFileSync(modelConfigPath),
			modelConfig = JSON.parse(modelBytes);
		if (modelConfig?.version !== 1)
			throw new Error("model config version invalid");
		const request = JSON.parse(readFileSync(requestPath, "utf8"));
		for (const key of ["issueId", "projectName", "leadId", "idempotencyKey"])
			if (typeof request[key] !== "string" || !request[key].trim())
				throw new Error(`missing request ${key}`);
		if (request.sessionRole !== undefined && request.sessionRole !== "main")
			throw new Error("only main start preview supported");
		if (
			!/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(request.issueId) ||
			(request.issueIdentifier !== undefined &&
				request.issueIdentifier !== request.issueId)
		)
			throw new Error("explicit human issue identifier required");
		const opened = openSnapshot(dbPath, { now, maxAgeMs: 600000 });
		db = opened.db;
		for (const [table, required] of Object.entries({
			workflow_template: [
				"template_id",
				"current_published_revision",
				"retired_at",
			],
			workflow_template_revision: [
				"template_id",
				"revision",
				"manifest",
				"manifest_digest",
				"schema_version",
			],
			workflow_category_binding: ["project", "task_category", "template_id"],
			workflow_run: ["run_id", "issue_id", "status"],
			workflow_run_issue_alias: ["run_id", "issue_alias"],
			workflow_start_reservation: ["idempotency_key", "run_id"],
			flag_values: ["flag_name", "scope", "has_override", "raw_value"],
		})) {
			if (
				!db
					.prepare("SELECT 1 FROM sqlite_master WHERE name=? AND type='table'")
					.get(table)
			)
				throw new Error("selection schema missing");
			const columns = db.prepare(`PRAGMA table_info(${table})`).all();
			if (!required.every((k) => columns.some((c) => c.name === k)))
				throw new Error("selection schema missing column");
			for (const c of columns.filter((c) => /TEXT|JSON/i.test(c.type)))
				if (
					db
						.prepare(
							`SELECT 1 FROM ${table} WHERE "${c.name}" IS NOT NULL AND (typeof("${c.name}")!='text' OR instr("${c.name}",char(0))>0) LIMIT 1`,
						)
						.get()
				)
					throw new Error("selection text storage invalid");
		}
		if (
			db
				.prepare(
					"SELECT 1 FROM workflow_start_reservation WHERE idempotency_key=?",
				)
				.get(request.idempotencyKey.trim()) ||
			db
				.prepare(
					"SELECT 1 FROM workflow_run r WHERE (r.issue_id=? OR EXISTS (SELECT 1 FROM workflow_run_issue_alias a WHERE a.run_id=r.run_id AND a.issue_alias=?)) AND (r.status='active' OR EXISTS (SELECT 1 FROM workflow_start_reservation s WHERE s.run_id=r.run_id))",
				)
				.get(request.issueId, request.issueId)
		)
			throw new Error("existing run or reservation requires adoption");
		const module = (name) =>
			import(
				pathToFileURL(join(checkout, "packages/teamlead/dist", name + ".js"))
					.href
			);
		const selection = await module("workflow-template-selection"),
			work = await module("work-kind"),
			pipeline = await module("bridge/pipeline-config-source");
		const store = {
			getWorkflowCategoryBinding: (project, category) =>
				db
					.prepare(
						"SELECT * FROM workflow_category_binding WHERE project=? AND task_category IN (?,'*') ORDER BY CASE WHEN task_category=? THEN 0 ELSE 1 END LIMIT 1",
					)
					.get(project, category, category),
			getWorkflowTemplate: (id) =>
				db
					.prepare("SELECT * FROM workflow_template WHERE template_id=?")
					.get(id),
			getWorkflowTemplateRevision: (id, revision) =>
				db
					.prepare(
						"SELECT * FROM workflow_template_revision WHERE template_id=? AND revision=?",
					)
					.get(id, revision),
			getWorkflowStartReservation: (key) =>
				db
					.prepare(
						"SELECT * FROM workflow_start_reservation WHERE idempotency_key=?",
					)
					.get(key),
			getActiveWorkflowRunForIssue: (issue) =>
				db
					.prepare(
						"SELECT * FROM workflow_run WHERE issue_id=? AND status='active' ORDER BY rowid DESC LIMIT 1",
					)
					.get(issue),
			getFlagValueRow: (name, scope = "*") => {
				const r = db
					.prepare("SELECT * FROM flag_values WHERE flag_name=? AND scope=?")
					.get(name, scope);
				return r
					? { hasOverride: r.has_override === 1, raw: r.raw_value }
					: undefined;
			},
		};
		const enrollment = pipeline.readPipelineEnrollment(
			{ mode: "ready", store },
			request.projectName,
		);
		if (!enrollment.ok || !enrollment.dag)
			throw new Error("DAG enrollment unavailable");
		const parsed = work.canonicalizeWorkKind(request.taskCategory),
			tier = work.canonicalizeEngTier(request.tier);
		if (parsed.status === "invalid" || tier.status === "invalid")
			throw new Error("category or tier invalid");
		const routing = work.canonicalizeRoutingOverrides(request.routingOverrides);
		if (routing.status === "invalid" || routing.overrides.length)
			throw new Error("routing override cannot preview generalized start");
		let override;
		const menu = await module("workflow-menu");
		if (enrollment.workKind && menu.hasProjectMenuConfig(hostRepo)) {
			if (request.templateId !== undefined || request.tier !== undefined)
				throw new Error("menu template and tier overrides unsupported");
			const adopted = menu
				.resolveLeadMenus({ projectRoot: hostRepo, leadId: request.leadId })
				.find((m) => m.shape === parsed.category);
			if (!adopted) throw new Error("menu not adopted");
			const binding = db
				.prepare(
					"SELECT * FROM workflow_category_binding WHERE project=? AND task_category=?",
				)
				.get(request.projectName, parsed.category);
			if (binding?.template_id !== adopted.templateId)
				throw new Error("menu binding mismatch");
			const resolved = menu.resolveMenuOverrides(adopted, request.overrides, {
				issueIdentifier: request.issueIdentifier ?? request.issueId,
			});
			if (
				Object.hasOwn(request, "overrides") ||
				Object.keys(resolved.assignments).length
			)
				override = resolved.templateOverride;
		} else {
			if (Object.hasOwn(request, "overrides"))
				throw new Error("menu override without menu enrollment");
			if (enrollment.workKind && !parsed.category && !request.templateId)
				throw new Error("generic fallback has no generalized selection");
		}
		let captured;
		const stop = {};
		store.materializeWorkflowRun = (value) => {
			captured = value;
			throw stop;
		};
		try {
			await selection.resolveWorkflowTemplateSelection(store, {
				project: request.projectName,
				issueId: request.issueId,
				issueIdentifier: request.issueIdentifier ?? request.issueId,
				taskCategory: enrollment.workKind
					? parsed.category
					: request.taskCategory,
				leadTemplateId: request.templateId,
				leadReason: request.selectionReason,
				selectedBy: request.leadId,
				actor: "master",
				authKind: "master",
				canonicalRoot: hostRepo,
				idempotencyKey: request.idempotencyKey,
				workKindEnforced: enrollment.workKind,
				categorySource: enrollment.workKind
					? request.templateId
						? "template_override"
						: "task_category"
					: undefined,
				tier: enrollment.workKind ? tier.tier : undefined,
				override,
				idFactory: () => "preview-only",
				entryKind: "workflow_v2",
			});
		} catch (error) {
			if (error !== stop) throw error;
		}
		if (
			!readFileSync(modelConfigPath).equals(modelBytes) ||
			process.env.FLYWHEEL_MODELS_CONFIG !== modelConfigPath
		)
			throw new Error("model config changed during selection");
		if (!captured) throw new Error("no generalized selection");
		return {
			status: "pass",
			selectionDigest: captured.startReservation.selectionDigest,
			nodeId: captured.startReservation.nodeId,
			templateId: captured.templateId,
			revision: captured.expectedSelection.revision,
			metadata: opened.metadata,
			modelConfig: {
				path: modelConfigPath,
				sha256: createHash("sha256").update(modelBytes).digest("hex"),
			},
		};
	} catch (error) {
		return { status: "fail", reason: error.message };
	} finally {
		db?.close();
	}
}
