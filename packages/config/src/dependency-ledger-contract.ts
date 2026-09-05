export const DEPENDENCY_LEDGER_PREFIX = "[dependency-ledger]";
export const LEDGER_MACHINE_LINE_PREFIX = "dl1:";

export const OPERATION_ID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const LEDGER_KINDS = ["missed", "not_needed", "discovered"] as const;
export const LEDGER_ACTIONS = ["added", "removed"] as const;
export const KIND_ACTION_MATRIX = {
	missed: "added",
	not_needed: "removed",
	discovered: "added",
} as const;
export const LEDGER_EVIDENCE = ["mutation", "state", "lead_ack"] as const;

export const LEDGER_COMMENT_KEYS = [
	"v",
	"op",
	"parent_op",
	"relation_id",
	"evidence",
	"kind",
	"action",
	"blocker",
	"blocked",
	"claimed_actor",
	"at",
	"reason",
] as const;
