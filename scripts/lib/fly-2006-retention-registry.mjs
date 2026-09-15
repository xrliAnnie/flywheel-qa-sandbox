export { READINESS_WINDOW_MS as RETENTION_MS } from "../../packages/teamlead/dist/bridge/release-readiness/evaluate.js";

import { loadRetentionSnapshot } from "./fly-2006-retention-loader.mjs";

const RETENTION_ROOT = new URL("./fly-2006-retention-tables/", import.meta.url);
const SNAPSHOT = loadRetentionSnapshot(RETENTION_ROOT);
const REGISTRIES = SNAPSHOT.classifications;
export const TEAMLEAD_TABLE_CLASSIFICATION = REGISTRIES.teamlead;
export const COMM_TABLE_CLASSIFICATION = REGISTRIES.comm;

export function assertRetentionInputsUnchanged() {
	if (loadRetentionSnapshot(RETENTION_ROOT).digest !== SNAPSHOT.digest)
		throw new Error("registry_inputs_changed");
}

export function retentionRegistryDigest() {
	assertRetentionInputsUnchanged();
	return SNAPSHOT.digest;
}

export function createSchemaAssertions(registries) {
	function registryNames(database) {
		const registry = registries[database];
		if (!Object.hasOwn(registries, database))
			throw new Error(`unknown_retention_database:${database}`);
		const names = Object.values(registry).flat();
		const unique = new Set(names);
		if (unique.size !== names.length)
			throw new Error(`schema_registry_overlap:${database}`);
		return { registry, names, unique };
	}

	function assertClassifiedSchema(database, actualNames) {
		const { registry, names } = registryNames(database);
		const actual = new Set(actualNames);
		assertNoUnclassifiedSchema(database, actualNames);
		const retiredOptional = new Set(registry.retiredOptional ?? []);
		const missing = names
			.filter((name) => !retiredOptional.has(name) && !actual.has(name))
			.sort();
		if (missing.length > 0)
			throw new Error(`schema_missing:${database}:${missing.join(",")}`);
		return {
			database,
			total: actual.size,
			counts: Object.fromEntries(
				Object.entries(registry).map(([classification, values]) => [
					classification,
					values.length,
				]),
			),
		};
	}

	function assertNoUnclassifiedSchema(database, actualNames) {
		const { unique } = registryNames(database);
		const actual = new Set(actualNames);
		const unknown = [...actual].filter((name) => !unique.has(name)).sort();
		if (unknown.length > 0)
			throw new Error(`schema_unclassified:${database}:${unknown.join(",")}`);
		return { database, total: actual.size };
	}

	return Object.freeze({ assertClassifiedSchema, assertNoUnclassifiedSchema });
}

export const { assertClassifiedSchema, assertNoUnclassifiedSchema } =
	createSchemaAssertions(REGISTRIES);

function timestampMs(value) {
	if (value === null || value === undefined) return null;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return null;
		return Math.abs(value) > 100_000_000_000 ? value : value * 1_000;
	}
	if (typeof value !== "string" || value.trim() === "") return null;
	const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(
		value,
	)
		? `${value.replace(" ", "T")}Z`
		: value;
	const parsed = Date.parse(normalized);
	return Number.isFinite(parsed) ? parsed : null;
}

export function classifyRetentionTime(value, cutoff) {
	const cutoffMs = timestampMs(cutoff);
	if (cutoffMs === null) throw new Error("retention_cutoff_invalid");
	const valueMs = timestampMs(value);
	if (valueMs === null) return "invalidTime";
	return valueMs < cutoffMs ? "old" : "recent";
}

export const MAILBOX_LEAD_EXCEPTION = Object.freeze({
	fromAgent: "voice-honeylemon-fly1911",
	relayState: "terminal_disposed",
});

const MAILBOX_AUTHORITY_TYPES = new Set([
	"action_executed",
	"founder_reply",
	"instruction",
	"question",
	"response",
	"review_advisory_pass",
	"session_zombie_detected",
]);

const MAILBOX_NARRATIVE_TYPES = new Set([
	"ack_batch",
	"bridge_abnormal_exit",
	"bridge_boot_stale_checkout",
	"dead_letter_notice",
	"discord_chat",
	"external_delivery",
	"external_merge_suspect",
	"inbox_loop_stalled",
	"patrol_tick",
	"runner_idle_detected",
	"runner_login_expired",
	"session_monitoring_lost",
	"session_monitoring_reestablished",
	"session_orphaned",
	"session_stale_completed",
	"session_started",
	"stage_changed",
	"swap_pressure_high",
	"tui_window_lost",
	"workflow_engine_escalation",
	"zombie_session_backlog",
]);

export function classifyMailboxRow(row, cutoff14) {
	if (
		row.from_agent === MAILBOX_LEAD_EXCEPTION.fromAgent &&
		row.relay_state === MAILBOX_LEAD_EXCEPTION.relayState
	) {
		return "leadExactExceptionCandidate";
	}
	const terminalAt = row.state === "DEAD" ? row.dead_at : row.acked_at;
	const age = classifyRetentionTime(terminalAt, cutoff14);
	if (age !== "old") return age;
	if (
		row.checkpoint !== null &&
		row.checkpoint !== undefined &&
		row.checkpoint !== ""
	)
		return "oldProtectedAuthority";
	if (row.kind === "report" || MAILBOX_AUTHORITY_TYPES.has(row.type))
		return "oldProtectedAuthority";
	if (!MAILBOX_NARRATIVE_TYPES.has(row.type)) return "oldProtectedUnknown";
	if (
		!new Set(["ACKED", "DEAD"]).has(row.state) ||
		row.relay_state !== "terminal_disposed"
	)
		return "activeProtected";
	return "candidate";
}
