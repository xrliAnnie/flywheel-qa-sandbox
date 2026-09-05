import {
	canonicalJsonString,
	DEPENDENCY_LEDGER_PREFIX,
	KIND_ACTION_MATRIX,
	LEDGER_ACTIONS,
	LEDGER_COMMENT_KEYS,
	LEDGER_EVIDENCE,
	LEDGER_KINDS,
	LEDGER_MACHINE_LINE_PREFIX,
	OPERATION_ID_RE,
} from "flywheel-config";

export type DependencyLedgerKind = (typeof LEDGER_KINDS)[number];
export type DependencyLedgerAction = (typeof LEDGER_ACTIONS)[number];
export type DependencyLedgerEvidence = (typeof LEDGER_EVIDENCE)[number];

export interface DependencyLedgerEntry {
	v: 1;
	op: string;
	parent_op: string | null;
	relation_id: string | null;
	evidence: DependencyLedgerEvidence;
	kind: DependencyLedgerKind;
	action: DependencyLedgerAction;
	blocker: string;
	blocked: string;
	claimed_actor: string;
	at: string;
	reason: string;
}

export type ParsedDependencyLedgerComment =
	| DependencyLedgerEntry
	| { unparseable: true }
	| null;

const IDENTIFIER_RE = /^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,6}$/;
const ACTOR_RE = /^[a-z0-9-]{1,64}$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export function normalizeDependencyReason(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const reason = value.replace(/\r/g, "");
	const hasForbiddenControl = [...reason].some((character) => {
		const code = character.charCodeAt(0);
		return (code < 32 && code !== 9 && code !== 10) || code === 127;
	});
	return reason.trim().length > 0 &&
		[...reason].length <= 2000 &&
		!hasForbiddenControl
		? reason
		: null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isLedgerEntry(value: unknown): value is DependencyLedgerEntry {
	if (!isRecord(value)) return false;
	const keys = Object.keys(value);
	if (
		keys.length !== LEDGER_COMMENT_KEYS.length ||
		LEDGER_COMMENT_KEYS.some((key) => !(key in value))
	) {
		return false;
	}
	if (
		value.v !== 1 ||
		typeof value.op !== "string" ||
		!OPERATION_ID_RE.test(value.op) ||
		!(
			(typeof value.parent_op === "string" &&
				OPERATION_ID_RE.test(value.parent_op)) ||
			value.parent_op === null
		) ||
		!(
			(typeof value.relation_id === "string" && value.relation_id.length > 0) ||
			value.relation_id === null
		) ||
		!LEDGER_EVIDENCE.includes(value.evidence as DependencyLedgerEvidence) ||
		!LEDGER_KINDS.includes(value.kind as DependencyLedgerKind) ||
		!LEDGER_ACTIONS.includes(value.action as DependencyLedgerAction) ||
		typeof value.blocker !== "string" ||
		!IDENTIFIER_RE.test(value.blocker) ||
		typeof value.blocked !== "string" ||
		!IDENTIFIER_RE.test(value.blocked) ||
		typeof value.claimed_actor !== "string" ||
		!ACTOR_RE.test(value.claimed_actor) ||
		typeof value.at !== "string" ||
		!RFC3339_UTC.test(value.at) ||
		typeof value.reason !== "string" ||
		normalizeDependencyReason(value.reason) !== value.reason
	) {
		return false;
	}
	return (
		KIND_ACTION_MATRIX[value.kind as DependencyLedgerKind] === value.action
	);
}

export function buildLedgerComment(entry: DependencyLedgerEntry): string {
	const normalized = {
		...entry,
		reason: normalizeDependencyReason(entry.reason) ?? "",
	};
	if (!isLedgerEntry(normalized))
		throw new Error("invalid dependency ledger entry");
	const reason = [...normalized.reason.replace(/\s+/g, " ").trim()]
		.slice(0, 200)
		.join("");
	return `${DEPENDENCY_LEDGER_PREFIX} ${normalized.kind}: ${normalized.blocker} blocks ${normalized.blocked} — ${normalized.action} · ${reason}\n${LEDGER_MACHINE_LINE_PREFIX}${Buffer.from(canonicalJsonString(normalized)).toString("base64url")}`;
}

export function parseLedgerComment(
	body: string,
): ParsedDependencyLedgerComment {
	const machineLine = body
		.split(/\r?\n/)
		.find((line) => line.startsWith(LEDGER_MACHINE_LINE_PREFIX));
	if (!machineLine) {
		return body.startsWith(DEPENDENCY_LEDGER_PREFIX)
			? { unparseable: true }
			: null;
	}
	if (!/^dl1:[A-Za-z0-9_-]+$/.test(machineLine)) {
		return { unparseable: true };
	}
	try {
		const decoded: unknown = JSON.parse(
			Buffer.from(
				machineLine.slice(LEDGER_MACHINE_LINE_PREFIX.length),
				"base64url",
			).toString("utf8"),
		);
		return isLedgerEntry(decoded) ? decoded : { unparseable: true };
	} catch {
		return { unparseable: true };
	}
}
