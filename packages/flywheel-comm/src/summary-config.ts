import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SummaryGranularity = "per-lead" | "per-project";

export type SummaryConfigErrorCode =
	| "summary_config_source_error"
	| "summary_config_invalid";

export class SummaryConfigError extends Error {
	constructor(
		readonly code: SummaryConfigErrorCode,
		message: string,
	) {
		super(`${code}: ${message}`);
		this.name = "SummaryConfigError";
	}
}

export type SummaryGranularitySelection =
	| { state: "unselected" }
	| {
			state: "selected";
			granularity: SummaryGranularity;
			setBy: string;
			setAt: string;
	  };

export interface ReadSummaryGranularityOptions {
	homeDir?: string;
}

const ISO_TIMESTAMP =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function validIsoTimestamp(value: string): boolean {
	if (!ISO_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
		return false;
	}
	const date = value.slice(0, 10);
	const calendar = new Date(`${date}T00:00:00.000Z`);
	return (
		!Number.isNaN(calendar.getTime()) &&
		calendar.toISOString().slice(0, 10) === date
	);
}

export function readSummaryGranularity(
	options: ReadSummaryGranularityOptions = {},
): SummaryGranularitySelection {
	const path = join(
		options.homeDir ?? homedir(),
		".flywheel",
		"summary-config.json",
	);
	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { state: "unselected" };
		}
		throw new SummaryConfigError(
			"summary_config_source_error",
			`${path} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(contents);
	} catch (error) {
		throw new SummaryConfigError(
			"summary_config_invalid",
			`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new SummaryConfigError(
			"summary_config_invalid",
			`${path} must contain an object`,
		);
	}
	const value = parsed as Record<string, unknown>;
	if (value.granularity !== "per-lead" && value.granularity !== "per-project") {
		throw new SummaryConfigError(
			"summary_config_invalid",
			'granularity must be "per-lead" or "per-project"',
		);
	}
	if (typeof value.setBy !== "string" || value.setBy.trim().length === 0) {
		throw new SummaryConfigError(
			"summary_config_invalid",
			"setBy must be a non-empty string",
		);
	}
	if (typeof value.setAt !== "string" || !validIsoTimestamp(value.setAt)) {
		throw new SummaryConfigError(
			"summary_config_invalid",
			"setAt must be an ISO timestamp",
		);
	}
	return {
		state: "selected",
		granularity: value.granularity,
		setBy: value.setBy,
		setAt: value.setAt,
	};
}
