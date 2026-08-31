import type {
	StateStore,
	WorkflowCatalogMigrationHooks,
	WorkflowCatalogMigrationInput,
	WorkflowCatalogMigrationPlan,
} from "./StateStore.js";
import type { LoadedWorkflowSeed } from "./workflow-template.js";

/**
 * FLY-2121 cleanup whitelist: the retired FLY-1693 catalog minus
 * tpl_eng_heavy, which has immutable historical run references in production.
 */
export const FLY2121_REMOVABLE_TEMPLATE_IDS = [
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
] as const;

function migrationInput(
	seeds: readonly LoadedWorkflowSeed[],
	resolvableRoleNames?: readonly string[],
): WorkflowCatalogMigrationInput {
	const seedRoleNames = [
		...new Set(
			seeds.flatMap((seed) =>
				seed.manifest.schema_version === 2
					? seed.manifest.nodes.flatMap((node) => {
							if (node.role) return [node.role];
							return node.type === "gate" || node.type === "land"
								? []
								: [node.id];
						})
					: [],
			),
		),
	];
	return {
		categoryRename: { from: "design", to: "product_design_flow" },
		removableTemplateIds: FLY2121_REMOVABLE_TEMPLATE_IDS,
		seeds,
		resolvableRoleNames: resolvableRoleNames ?? seedRoleNames,
	};
}

export function preflightWorkflowCatalogMigration(
	store: StateStore,
	seeds: readonly LoadedWorkflowSeed[],
	options: { resolvableRoleNames?: readonly string[] } = {},
): WorkflowCatalogMigrationPlan {
	return store.preflightWorkflowCatalogMigration(
		migrationInput(seeds, options.resolvableRoleNames),
	);
}

export async function migrateFly2121WorkflowCatalog(
	store: StateStore,
	seeds: readonly LoadedWorkflowSeed[],
	options: WorkflowCatalogMigrationHooks & {
		backupPath?: string;
		resolvableRoleNames?: readonly string[];
	} = {},
): Promise<{
	plan: WorkflowCatalogMigrationPlan;
	backupPath: string | null;
}> {
	const plan = preflightWorkflowCatalogMigration(store, seeds, options);
	if (!plan.requiresMutation) return { plan, backupPath: null };

	let backupPath: string | null = null;
	if (store.getDbPath() !== ":memory:") {
		if (!options.backupPath) {
			throw new Error("workflow_catalog_backup_path_required");
		}
		await store.createVerifiedOnlineBackup(
			options.backupPath,
			plan.foreignKeyBaseline,
		);
		backupPath = options.backupPath;
	}
	const applied = store.applyWorkflowCatalogMigration(
		migrationInput(seeds, options.resolvableRoleNames),
		{
			onStep: options.onStep,
			foreignKeyBaseline: plan.foreignKeyBaseline,
		},
	);
	return { plan: applied, backupPath };
}
