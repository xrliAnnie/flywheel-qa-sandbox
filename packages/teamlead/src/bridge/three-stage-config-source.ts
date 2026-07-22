/**
 * FLY-793: load each project's `pipeline` config from its CANONICAL root.
 *
 * SECURITY: reads `<projectRoot>/.flywheel/config.yaml` — the mainline checkout,
 * NEVER an implementation PR's worktree (mirrors auto-qa-config-source.ts), so a
 * runner cannot flip its own three-stage enablement mid-pipeline.
 *
 * Unlike auto-QA (opt-out tri-state), three-stage is opt-IN / default-OFF, so a
 * missing file / missing `pipeline` block / malformed config all collapse to
 * `undefined` → `resolveThreeStagePolicy` returns disabled (fail-closed). A
 * malformed `pipeline` block already throws at `ConfigLoader.load` (same as
 * `doc_flow` / `qa`); we log + treat it as `undefined` here so one project's
 * broken config can never block Bridge boot or accidentally ENABLE the feature.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigLoader, type PipelineConfig } from "flywheel-config";
import { parse } from "yaml";
import type { ProjectEntry } from "../ProjectConfig.js";

export type WorkKindConfigCause =
	| "work_kind_not_boolean"
	| "work_kind_requires_dag";

export type WorkKindConfigResult =
	| { ok: true; workKind: boolean; dag: boolean }
	| { ok: false; cause: WorkKindConfigCause };

/**
 * FLY-1407 narrow strict reader for fresh master /api/runs/start dispatches.
 *
 * Only the new work_kind key and its dag:true dependency are fail-loud. Every
 * unrelated parse/config problem keeps today's behavior: work-kind is disabled
 * and the existing lenient pipeline loader decides the legacy/three-stage path.
 */
export function loadWorkKindConfigStrict(
	project: ProjectEntry,
	readFile: (p: string) => string = (p) => readFileSync(p, "utf-8"),
): WorkKindConfigResult {
	const configPath = join(project.projectRoot, ".flywheel", "config.yaml");
	let content: string;
	try {
		content = readFile(configPath);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			console.warn(
				`[work-kind] config read failed for ${project.projectName}: ${(err as Error).message} — work-kind OFF`,
			);
		}
		return { ok: true, workKind: false, dag: false };
	}

	let raw: unknown;
	try {
		raw = parse(content);
	} catch (err) {
		console.warn(
			`[work-kind] unrelated config parse failed for ${project.projectName}: ${(err as Error).message} — work-kind OFF`,
		);
		return { ok: true, workKind: false, dag: false };
	}
	if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: true, workKind: false, dag: false };
	}
	const pipeline = (raw as Record<string, unknown>).pipeline;
	if (
		pipeline == null ||
		typeof pipeline !== "object" ||
		Array.isArray(pipeline)
	) {
		return { ok: true, workKind: false, dag: false };
	}
	const values = pipeline as Record<string, unknown>;
	if (
		Object.hasOwn(values, "work_kind") &&
		typeof values.work_kind !== "boolean"
	) {
		return { ok: false, cause: "work_kind_not_boolean" };
	}
	const workKind = values.work_kind === true;
	const dag = values.dag === true;
	if (workKind && !dag) {
		return { ok: false, cause: "work_kind_requires_dag" };
	}
	return { ok: true, workKind, dag };
}

export async function loadPipelineConfigByProject(
	projects: ProjectEntry[],
	readFile: (p: string) => string = (p) => readFileSync(p, "utf-8"),
): Promise<Map<string, PipelineConfig | undefined>> {
	const map = new Map<string, PipelineConfig | undefined>();
	for (const project of projects) {
		const configPath = join(project.projectRoot, ".flywheel", "config.yaml");
		try {
			const loader = new ConfigLoader(async (p) => readFile(p));
			const cfg = await loader.load(configPath);
			map.set(project.projectName, cfg?.pipeline);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") {
				// Parse / validation error → treat as undefined (OFF, fail-closed).
				console.warn(
					`[three-stage] pipeline config load failed for ${project.projectName}: ${
						(err as Error).message
					} — three-stage OFF for it`,
				);
			}
			map.set(project.projectName, undefined);
		}
	}
	return map;
}
