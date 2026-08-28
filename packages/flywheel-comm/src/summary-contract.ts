import type { SummaryGranularity } from "./summary-config.js";

/** The single path prefix shared by the producer, verifier, and R1 exemption. */
export const SUMMARY_PREFIX = "summaries/";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ISO_ENDPOINT = /^\d{4}-\d{2}-\d{2}(?:T[^/\s]+)?$/;

export type SummaryContractErrorCode =
	| "summary_path_invalid"
	| "summary_mode_invalid"
	| "summary_mode_unsafe"
	| "summary_frontmatter_invalid"
	| "summary_metadata_mismatch"
	| "summary_period_invalid"
	| "summary_facts_missing"
	| "summary_judgment_missing";

export class SummaryContractError extends Error {
	constructor(
		readonly code: SummaryContractErrorCode,
		message: string,
	) {
		super(`${code}: ${message}`);
		this.name = "SummaryContractError";
	}
}

export interface SummaryPathInput {
	project: string;
	lead: string;
	period: string;
	sequence: number;
	granularity: SummaryGranularity;
}

export interface ValidateSummaryArtifactInput {
	path: string;
	content: string;
	granularity: SummaryGranularity;
	gitMode?: string;
	expectedProject?: string;
	expectedLead?: string;
	expectedPeriod?: string;
}

export interface ValidatedSummaryArtifact {
	path: string;
	project: string;
	lead: string;
	period: string;
	periodEndDate: string;
	sequence: number;
	granularity: SummaryGranularity;
}

function fail(code: SummaryContractErrorCode, message: string): never {
	throw new SummaryContractError(code, message);
}

function requireSafeId(value: string, field: string): void {
	if (!SAFE_ID.test(value)) {
		fail("summary_frontmatter_invalid", `${field} must match ${SAFE_ID}`);
	}
}

function parsePeriod(period: string): { endDate: string } {
	const parts = period.split("/");
	if (parts.length !== 2 || parts.some((part) => !ISO_ENDPOINT.test(part))) {
		fail(
			"summary_period_invalid",
			"period must be <ISO start>/<ISO end> with no whitespace",
		);
	}
	for (const endpoint of parts) {
		const date = endpoint.slice(0, 10);
		const calendarInstant = new Date(`${date}T00:00:00.000Z`);
		if (
			Number.isNaN(calendarInstant.getTime()) ||
			calendarInstant.toISOString().slice(0, 10) !== date ||
			Number.isNaN(
				Date.parse(endpoint.length === 10 ? `${endpoint}T00:00:00Z` : endpoint),
			)
		) {
			fail("summary_period_invalid", `invalid ISO endpoint: ${endpoint}`);
		}
	}
	return { endDate: parts[1]!.slice(0, 10) };
}

export function buildSummaryPath(input: SummaryPathInput): string {
	requireSafeId(input.project, "project");
	requireSafeId(input.lead, "lead");
	const { endDate } = parsePeriod(input.period);
	if (
		!Number.isInteger(input.sequence) ||
		input.sequence < 1 ||
		input.sequence > 99
	) {
		fail(
			"summary_path_invalid",
			"sequence must be an integer from 1 through 99",
		);
	}
	const sequence = String(input.sequence).padStart(2, "0");
	if (input.granularity === "per-lead") {
		return `${SUMMARY_PREFIX}${input.project}/${endDate}--${input.lead}--${sequence}.md`;
	}
	if (input.granularity === "per-project") {
		return `${SUMMARY_PREFIX}${input.project}/${endDate}--${sequence}.md`;
	}
	return fail("summary_path_invalid", "unknown summary granularity");
}

function parseFrontmatter(content: string): Record<string, string> {
	if (content.includes("\0")) {
		fail("summary_frontmatter_invalid", "NUL bytes are forbidden");
	}
	const normalized = content.replace(/\r\n/g, "\n");
	const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
	if (!match) {
		fail(
			"summary_frontmatter_invalid",
			"document must begin with YAML frontmatter",
		);
	}
	const metadata: Record<string, string> = {};
	for (const line of match[1]!.split("\n")) {
		const field = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
		if (!field || field[2]!.trim().length === 0) {
			fail("summary_frontmatter_invalid", `invalid frontmatter line: ${line}`);
		}
		if (field[1]! in metadata) {
			fail("summary_frontmatter_invalid", `duplicate field: ${field[1]}`);
		}
		metadata[field[1]!] = field[2]!.trim();
	}
	const keys = Object.keys(metadata).sort();
	if (keys.join(",") !== "lead,period,project") {
		fail(
			"summary_frontmatter_invalid",
			"frontmatter must contain exactly project, lead, and period",
		);
	}
	return metadata;
}

function requiredSection(content: string, heading: "Facts" | "Judgment"): void {
	const normalized = content.replace(/\r\n/g, "\n");
	const match = new RegExp(
		`^## ${heading}[ \\t]*\\n([\\s\\S]*?)(?=^##[ \\t]|$(?![\\s\\S]))`,
		"m",
	).exec(normalized);
	if (!match || match[1]!.trim().length === 0) {
		fail(
			heading === "Facts"
				? "summary_facts_missing"
				: "summary_judgment_missing",
			`${heading} section must be present and non-empty`,
		);
	}
}

function parsePath(
	path: string,
	granularity: SummaryGranularity,
): { project: string; lead?: string; endDate: string; sequence: number } {
	if (
		!path.startsWith(SUMMARY_PREFIX) ||
		path.includes("\\") ||
		path.includes("..")
	) {
		fail("summary_path_invalid", `path must stay under ${SUMMARY_PREFIX}`);
	}
	const suffix = path.slice(SUMMARY_PREFIX.length);
	const match =
		granularity === "per-lead"
			? /^([A-Za-z0-9][A-Za-z0-9._-]*)\/(\d{4}-\d{2}-\d{2})--([A-Za-z0-9][A-Za-z0-9._-]*)--(\d{2})\.md$/.exec(
					suffix,
				)
			: /^([A-Za-z0-9][A-Za-z0-9._-]*)\/(\d{4}-\d{2}-\d{2})--(\d{2})\.md$/.exec(
					suffix,
				);
	if (!match) {
		fail(
			"summary_path_invalid",
			`path does not match ${granularity} naming contract`,
		);
	}
	return granularity === "per-lead"
		? {
				project: match[1]!,
				endDate: match[2]!,
				lead: match[3]!,
				sequence: Number(match[4]),
			}
		: {
				project: match[1]!,
				endDate: match[2]!,
				sequence: Number(match[3]),
			};
}

export function validateSummaryArtifact(
	input: ValidateSummaryArtifactInput,
): ValidatedSummaryArtifact {
	if (input.gitMode !== undefined && input.gitMode !== "100644") {
		fail(
			"summary_mode_unsafe",
			`Git mode must be regular non-executable blob 100644, got ${input.gitMode}`,
		);
	}
	const path = parsePath(input.path, input.granularity);
	const metadata = parseFrontmatter(input.content);
	const project = metadata.project!;
	const lead = metadata.lead!;
	const period = metadata.period!;
	requireSafeId(project, "project");
	requireSafeId(lead, "lead");
	const { endDate } = parsePeriod(period);
	const mismatches = [
		path.project !== project && `path project ${path.project} != ${project}`,
		path.lead !== undefined &&
			path.lead !== lead &&
			`path lead ${path.lead} != ${lead}`,
		path.endDate !== endDate && `path date ${path.endDate} != ${endDate}`,
		input.expectedProject !== undefined &&
			input.expectedProject !== project &&
			`project ${project} != expected ${input.expectedProject}`,
		input.expectedLead !== undefined &&
			input.expectedLead !== lead &&
			`lead ${lead} != expected ${input.expectedLead}`,
		input.expectedPeriod !== undefined &&
			input.expectedPeriod !== period &&
			`period ${period} != expected ${input.expectedPeriod}`,
	].filter((value): value is string => typeof value === "string");
	if (mismatches.length > 0) {
		fail("summary_metadata_mismatch", mismatches.join("; "));
	}
	requiredSection(input.content, "Facts");
	requiredSection(input.content, "Judgment");
	return {
		path: input.path,
		project,
		lead,
		period,
		periodEndDate: endDate,
		sequence: path.sequence,
		granularity: input.granularity,
	};
}
