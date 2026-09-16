import { getModelConfigSnapshot } from "flywheel-config";
import {
	type StateStore,
	WorkflowCatalogMigrationIntegrityError,
} from "./StateStore.js";
import { preflightWorkflowCatalogMigration } from "./workflow-catalog-migration.js";

const TARGETS = ["tpl_code", "tpl_simple_code"] as const;
/** A skipped profile is safe to publish; a durable managed receipt then prevents future retries. */
export function isFly2602WorkflowEffortPending(
	store: StateStore,
	templateId: string,
): boolean {
	if (!TARGETS.some((id) => id === templateId)) return false;
	if (store.hasManagedWorkflowTemplatePublication(templateId)) return false;
	if (
		store
			.listWorkflowCatalogMigrationAudit()
			.some(
				(row) =>
					row.migration_id === "FLY-2602" &&
					row.item_id === templateId &&
					row.reason === "published",
			)
	)
		return false;
	const template = store.getWorkflowTemplate(templateId);
	if (!template || template.retired_at || !template.current_published_revision)
		return false;
	const revision = store.getWorkflowTemplateRevision(
		templateId,
		template.current_published_revision,
	);
	if (!revision) return true;
	try {
		return sourceImplement(JSON.parse(revision.manifest)) !== undefined;
	} catch {
		return true;
	}
}

function sourceImplement(manifest: {
	nodes: Array<{
		id: string;
		type: string;
		vendor?: string;
		model?: string;
		effort?: string;
	}>;
}) {
	const nodes = manifest.nodes.filter((node) => node.id === "implement");
	const node = nodes[0];
	return nodes.length === 1 &&
		node !== undefined &&
		node.type === "implement" &&
		node.vendor === "codex" &&
		["astra", "gpt-6-astra"].includes(node.model ?? "") &&
		node.effort === "medium"
		? node
		: undefined;
}

interface Result {
	templateId: string;
	status: "published" | "skipped" | "failed";
	reason?: string;
}

export async function migrateFly2602WorkflowEffort(
	store: StateStore,
	options: { warn?: (message: string) => void; backupPath?: string } = {},
): Promise<Result[]> {
	const results: Result[] = [];
	const warn = options.warn ?? console.warn;
	let backupReady = store.getDbPath() === ":memory:";
	let backupFailed = false;
	const fail = (templateId: string, error: unknown) => {
		if (error instanceof WorkflowCatalogMigrationIntegrityError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		warn(
			`[workflow-catalog] FLY-2602 ${templateId}: ${message}; continuing with prior publication`,
		);
		try {
			// Backup failure must not create even an audit write in the live DB.
			if (backupReady)
				store.recordFly2602EffortResult(templateId, "failed", { message });
		} catch (auditError) {
			if (auditError instanceof WorkflowCatalogMigrationIntegrityError)
				throw auditError;
			warn(`[workflow-catalog] FLY-2602 audit unavailable for ${templateId}`);
		}
		results.push({ templateId, status: "failed", reason: message });
	};
	for (const templateId of TARGETS) {
		try {
			if (backupFailed) {
				results.push({
					templateId,
					status: "skipped",
					reason: "backup_failed",
				});
				continue;
			}
			if (store.hasManagedWorkflowTemplatePublication(templateId)) {
				results.push({
					templateId,
					status: "skipped",
					reason: "managed_publication_preserved",
				});
				continue;
			}
			const template = store.getWorkflowTemplate(templateId);
			const applied = store
				.listWorkflowCatalogMigrationAudit()
				.some(
					(row) =>
						row.migration_id === "FLY-2602" &&
						row.item_id === templateId &&
						row.reason === "published",
				);
			if (
				applied ||
				!template ||
				template.retired_at ||
				!template.current_published_revision
			) {
				results.push({
					templateId,
					status: "skipped",
					reason: applied ? "already_applied" : "inactive",
				});
				continue;
			}
			const row = store.getWorkflowTemplateRevision(
				templateId,
				template.current_published_revision,
			);
			if (!row) throw new Error("fly2602_published_revision_missing");
			const manifest = JSON.parse(row.manifest);
			const node = sourceImplement(manifest);
			if (!node) {
				results.push({
					templateId,
					status: "skipped",
					reason: "source_profile_preserved",
				});
				continue;
			}
			const modelSnapshot = getModelConfigSnapshot();
			if (
				!modelSnapshot.isModelSelectionSupported({
					surface: "workflow",
					model: "gpt-5.6-sol",
					effort: "xhigh",
					runtimeVendor: "codex",
				})
			)
				throw new Error("fly2602_target_model_unsupported");
			Object.assign(node, { model: "gpt-5.6-sol", effort: "xhigh" });
			if (!backupReady) {
				try {
					if (!options.backupPath)
						throw new Error("fly2602_backup_path_required");
					const baseline = preflightWorkflowCatalogMigration(
						store,
						[],
					).foreignKeyBaseline;
					await store.createVerifiedOnlineBackup(options.backupPath, baseline);
					backupReady = true;
				} catch (error) {
					backupFailed = true;
					throw error;
				}
			}
			store.applyFly2602EffortPublication({
				templateId,
				manifest,
				expectedRevision: row.revision,
				modelSnapshot,
			});
			results.push({ templateId, status: "published" });
		} catch (error) {
			fail(templateId, error);
		}
	}
	return results;
}
