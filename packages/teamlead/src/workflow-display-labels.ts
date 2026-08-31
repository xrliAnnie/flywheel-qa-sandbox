interface WorkflowDisplayNode {
	id: string;
	label?: string;
}

// FLY-2121-history: completed snapshots predate manifest labels. Keep this
// decoder keyed by template + node so overloaded ids never acquire one global
// meaning. Historical rows remain immutable.
const LEGACY_NODE_LABELS: Readonly<Record<string, string>> = {
	"tpl_code/design": "设计(工程)",
	"tpl_code/implement": "实现",
	"tpl_code/qa": "QA 验证",
	"tpl_design/produce": "产品设计",
	"tpl_prd/produce": "产品需求",
	"tpl_prototype/produce": "原型",
	"tpl_generic_menu/execute": "通用执行",
	...Object.fromEntries(
		[
			"tpl_eng_heavy",
			"tpl_eng_light",
			"tpl_eng_trivial",
			"tpl_eng_heavy_land_v1",
			"tpl_eng_light_land_v1",
			"tpl_eng_trivial_land_v1",
			"tpl_eng",
			"tpl_eng_land_v1",
		].flatMap((templateId) => [
			[`${templateId}/design`, "设计(工程)"],
			[`${templateId}/implement`, "实现"],
			[`${templateId}/qa`, "QA 验证"],
		]),
	),
};

/** Backend-owned node display label for current and immutable historical pins. */
export function workflowNodeDisplayLabel(
	templateId: string,
	node: WorkflowDisplayNode,
): string {
	return (
		node.label?.trim() ||
		LEGACY_NODE_LABELS[`${templateId}/${node.id}`] ||
		node.id
	);
}
