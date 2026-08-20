/**
 * FLY-1436: the single category → compiled-template identity table.
 *
 * Model-facing schemas, work-kind validation, menu compilation, binding
 * projection, and API legal sets all import this table. Do not mirror these
 * identities elsewhere.
 */
export const WORKFLOW_MENU_BINDINGS = [
	{ taskCategory: "code", templateId: "tpl_code" },
	{ taskCategory: "simple_code", templateId: "tpl_simple_code" },
	{ taskCategory: "prd", templateId: "tpl_prd" },
	{ taskCategory: "design", templateId: "tpl_design" },
	{ taskCategory: "prototype", templateId: "tpl_prototype" },
	{ taskCategory: "generic", templateId: "tpl_generic_menu" },
] as const;

export type WorkflowMenuShapeId =
	(typeof WORKFLOW_MENU_BINDINGS)[number]["taskCategory"];

export const WORKFLOW_MENU_SHAPES = WORKFLOW_MENU_BINDINGS.map(
	(binding) => binding.taskCategory,
) as readonly WorkflowMenuShapeId[];

export function workflowMenuTemplateId(
	shape: WorkflowMenuShapeId,
): (typeof WORKFLOW_MENU_BINDINGS)[number]["templateId"] {
	return WORKFLOW_MENU_BINDINGS.find(
		(binding) => binding.taskCategory === shape,
	)!.templateId;
}
