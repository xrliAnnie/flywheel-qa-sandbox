import { fileURLToPath } from "node:url";
import {
	COMM_TABLE_CLASSIFICATION,
	RETENTION_MS,
	TEAMLEAD_TABLE_CLASSIFICATION,
} from "./fly-2006-retention-registry.mjs";

export const FLY2139_STANDING_POLICY_PATH = fileURLToPath(import.meta.url);

function deepFreeze(value) {
	if (!value || typeof value !== "object" || Object.isFrozen(value))
		return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export const FLY2139_STANDING_POLICY = deepFreeze({
	schemaVersion: 1,
	issue: "FLY-2139",
	retentionMs: RETENTION_MS,
	globalRowCap: 500_000,
	perTableRowCap: 300_000,
	deleteTargets: {
		teamlead: [...TEAMLEAD_TABLE_CLASSIFICATION.deleteTarget],
		comm: [...COMM_TABLE_CLASSIFICATION.deleteTarget],
	},
});

const EXPECTED_POLICY = canonical(FLY2139_STANDING_POLICY);

export function validateFly2139StandingPolicy(value) {
	if (canonical(value) !== EXPECTED_POLICY) {
		throw new Error("standing_policy_invalid");
	}
	return FLY2139_STANDING_POLICY;
}
